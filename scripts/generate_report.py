"""
チェックインの回答をまとめて「じぶんレポート」を生成し、Supabase に保存する。

GitHub Actions から月1回(と手動実行)で走る。

必要な環境変数:
  SUPABASE_URL
  SUPABASE_SERVICE_KEY
  ANTHROPIC_API_KEY
  REPORT_DAYS   (省略時 30。直近何日分を対象にするか)
"""

import datetime
import os
import sys

import anthropic
import requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"].strip()
REPORT_DAYS = int(os.environ.get("REPORT_DAYS", 30))
MODEL = os.environ.get("REPORT_MODEL", "claude-opus-5")

JST = datetime.timezone(datetime.timedelta(hours=9))

HEADERS = {"apikey": SERVICE_KEY, "Content-Type": "application/json"}
if SERVICE_KEY.startswith("eyJ"):
    HEADERS["Authorization"] = f"Bearer {SERVICE_KEY}"


SYSTEM_PROMPT = """\
あなたは、ある人が日々の「チェックイン」に答えた記録を読み解いて、
その人自身に向けたふりかえりレポートを書く役割です。

書く相手は本人です。本人が読んで「たしかに」と思えるものを書いてください。

## 大前提
- 記録に書かれていることだけを根拠にする。書かれていないことを推測で断定しない。
- 一般論やありがちなアドバイスを書かない。この人の記録からしか出てこない話を書く。
- 褒めるためのレポートではない。かといって批判でもない。見えている事実を、正確に、あたたかく返す。
- 本人が書いた言葉を引用して使う。引用は「」でくくる。
- 記録が少ない項目について無理に語らない。わからないことは書かない。

## 書き方
- 日本語。丁寧すぎない、友人が話すくらいの距離感。
- 断定しすぎない。「〜のように見えます」「〜かもしれません」を適度に使う。
- 説教しない。指示もしない。問いを置くだけにする。
- 全体で1200〜2000字程度。

## 出力フォーマット(この見出しのまま、Markdownで)
## いまのあなた
3〜5行。この期間の全体像。

## 大事にしているもの
記録から繰り返し現れた価値観を2〜3個。それぞれ、根拠になった回答を引用して示す。

## 気づいていないかもしれないこと
このレポートの核心。本人が自覚していなさそうなパターン・矛盾・偏りを1〜2個。
たとえば「Aと答えているのに、Bでは逆のことを書いている」のような、
記録どうしを突き合わせて初めて見えることを書く。指摘ではなく発見として書く。

## 数字の傾向
5段階評価の回答から読み取れることを簡潔に。データが少なければ「まだ判断できません」と書く。

## 次の1ヶ月、置いておきたい問い
本人が自分で考えるための問いを2〜3個。答えは書かない。
"""


def rest_get(path):
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{path}", headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()


def rest_post(path, body):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers={**HEADERS, "Prefer": "return=minimal"},
        json=body,
        timeout=30,
    )
    r.raise_for_status()


def fetch_responses(since):
    rows = rest_get(
        "checkin_responses"
        "?select=question_text,answer,answer_value,qtype,answered_at"
        f"&answered_at=gte.{since.isoformat()}"
        "&order=answered_at.asc&limit=2000"
    )
    return rows


def build_transcript(rows):
    """回答をAIに渡せる形に整える。5段階は数値の意味がわかるよう注記する。"""
    lines = []
    for row in rows:
        date = row["answered_at"][:10]
        q = row["question_text"]
        a = row["answer"]
        if row["qtype"] == "scale":
            a = f"{a}/5(1が低い・5が高い)"
        lines.append(f"[{date}] {q}\n→ {a}")
    return "\n\n".join(lines)


def generate(transcript, rows, period_start, period_end):
    client = anthropic.Anthropic()

    user_content = (
        f"対象期間: {period_start} 〜 {period_end}\n"
        f"回答数: {len(rows)}件\n\n"
        "以下がこの人のチェックイン記録です。\n\n"
        "---\n"
        f"{transcript}\n"
        "---\n\n"
        "この記録を読んで、レポートを書いてください。"
    )

    request = {
        "model": MODEL,
        "max_tokens": 16000,
        "system": SYSTEM_PROMPT,
        "output_config": {"effort": "high"},
        "messages": [{"role": "user", "content": user_content}],
    }

    # 安全性判定で断られた場合に別モデルへ自動で切り替える(Claude API のみ対応)。
    # ベータ未対応の環境では 400 になるので、その時は素の呼び出しに落とす。
    try:
        response = client.beta.messages.create(
            **request,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except anthropic.BadRequestError as e:
        print(f"fallbacks が使えなかったため通常呼び出しにします: {e}", file=sys.stderr)
        response = client.messages.create(**request)

    if response.stop_reason == "refusal":
        raise RuntimeError(f"モデルが応答を拒否しました: {response.stop_details}")

    text = "".join(b.text for b in response.content if b.type == "text").strip()
    if not text:
        raise RuntimeError("空のレポートが返ってきました")

    usage = response.usage
    print(
        f"生成完了: model={response.model} "
        f"in={usage.input_tokens} out={usage.output_tokens} tokens"
    )
    return text, response.model


def main():
    today = datetime.datetime.now(JST).date()
    period_start = today - datetime.timedelta(days=REPORT_DAYS)
    since = datetime.datetime.combine(
        period_start, datetime.time.min, tzinfo=JST
    )

    rows = fetch_responses(since)
    if len(rows) < 5:
        print(f"回答が{len(rows)}件しかないためスキップします(5件以上で生成)。")
        return

    transcript = build_transcript(rows)
    content, model = generate(transcript, rows, period_start, today)

    rest_post(
        "self_reports",
        {
            "period_start": period_start.isoformat(),
            "period_end": today.isoformat(),
            "response_count": len(rows),
            "content": content,
            "model": model,
        },
    )
    print(f"保存しました: {period_start} 〜 {today} / {len(rows)}件をもとに生成")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
