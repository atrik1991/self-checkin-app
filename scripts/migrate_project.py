"""
古いSupabaseプロジェクトから新しいプロジェクトへ、中身を丸ごとコピーする。

新プロジェクト側で supabase/schema.sql を先に実行しておくこと(テーブルが空の状態)。

使い方:
  export SRC_URL=https://xxxx.supabase.co
  export SRC_KEY=<コピー元の service_role / sb_secret キー>
  export DST_URL=https://yyyy.supabase.co
  export DST_KEY=<コピー先の service_role / sb_secret キー>
  python3 scripts/migrate_project.py

キーは環境変数だけで渡すこと。ファイルに書いたりコミットしたりしない。
"""

import os
import sys

import requests

SRC_URL = os.environ["SRC_URL"].rstrip("/")
SRC_KEY = os.environ["SRC_KEY"].strip()
DST_URL = os.environ["DST_URL"].rstrip("/")
DST_KEY = os.environ["DST_KEY"].strip()


def headers(key: str, extra: dict | None = None) -> dict:
    # 新しい sb_secret_... はJWTではないので Authorization には載せない
    h = {"apikey": key, "Content-Type": "application/json"}
    if key.startswith("eyJ"):
        h["Authorization"] = f"Bearer {key}"
    if extra:
        h.update(extra)
    return h


def fetch_all(table: str, select: str) -> list:
    """PostgRESTの上限に当たらないようページングして全件取る。"""
    rows, step, offset = [], 1000, 0
    while True:
        res = requests.get(
            f"{SRC_URL}/rest/v1/{table}",
            headers=headers(SRC_KEY, {"Range": f"{offset}-{offset + step - 1}"}),
            params={"select": select, "order": "id.asc"},
            timeout=60,
        )
        res.raise_for_status()
        page = res.json()
        rows.extend(page)
        if len(page) < step:
            return rows
        offset += step


def insert(table: str, rows: list) -> list:
    """挿入して、採番された行を返す(id を作り直すので戻り値で対応表を作る)。"""
    if not rows:
        return []
    out = []
    for i in range(0, len(rows), 200):  # 1リクエストが大きくなりすぎないよう分割
        chunk = rows[i : i + 200]
        res = requests.post(
            f"{DST_URL}/rest/v1/{table}",
            headers=headers(DST_KEY, {"Prefer": "return=representation"}),
            json=chunk,
            timeout=60,
        )
        if not res.ok:
            raise SystemExit(f"{table} の挿入に失敗: {res.status_code} {res.text[:500]}")
        out.extend(res.json())
    return out


def main() -> None:
    if SRC_URL == DST_URL:
        raise SystemExit("コピー元とコピー先が同じプロジェクトです。中止します。")

    # 空でない場合は二重コピーになるので止める
    existing = requests.get(
        f"{DST_URL}/rest/v1/checkin_responses",
        headers=headers(DST_KEY, {"Prefer": "count=exact", "Range": "0-0"}),
        params={"select": "id"},
        timeout=30,
    )
    if existing.headers.get("content-range", "").split("/")[-1] not in ("0", "*"):
        raise SystemExit("コピー先に既にデータがあります。空のプロジェクトに対して実行してください。")

    # 1) 質問マスタ
    questions = fetch_all(
        "checkin_questions", "id,text,category,qtype,options,active,ask_count"
    )
    new_questions = insert(
        "checkin_questions",
        [
            {
                "text": q["text"],
                "category": q["category"],
                "qtype": q["qtype"],
                "options": q["options"],
                "active": q["active"],
            }
            for q in questions
        ],
    )
    print(f"質問: {len(new_questions)}問をコピー")

    # idは新しく採番されるので、質問文をキーに旧id→新idの対応表を作る
    text_to_new_id = {q["text"]: q["id"] for q in new_questions}
    old_id_to_text = {q["id"]: q["text"] for q in questions}

    # 2) 回答ログ
    responses = fetch_all(
        "checkin_responses",
        "id,question_id,question_text,qtype,answer,answer_value,answered_at",
    )
    payload = []
    for r in responses:
        qtext = old_id_to_text.get(r["question_id"])
        payload.append(
            {
                # 質問が見つからなければ null。question_text は残るので記録は欠けない
                "question_id": text_to_new_id.get(qtext),
                "question_text": r["question_text"],
                "qtype": r["qtype"],
                "answer": r["answer"],
                "answer_value": r["answer_value"],
                "answered_at": r["answered_at"],
            }
        )
    insert("checkin_responses", payload)
    print(f"回答: {len(payload)}件をコピー")

    # 3) じぶんレポート
    reports = fetch_all(
        "self_reports",
        "id,period_start,period_end,response_count,content,model,created_at",
    )
    insert(
        "self_reports",
        [
            {
                "period_start": r["period_start"],
                "period_end": r["period_end"],
                "response_count": r["response_count"],
                "content": r["content"],
                "model": r["model"],
                "created_at": r["created_at"],
            }
            for r in reports
        ],
    )
    print(f"レポート: {len(reports)}件をコピー")

    print("\n完了しました。通知スケジュールは次回送信時に自動で初期化されます。")
    print("push_subscriptions は端末ごとの登録なので移行しません。新しい設定のあと、端末で通知をONにし直してください。")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
