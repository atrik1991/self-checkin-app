// アプリの「レポートを作る」ボタンから呼ばれる。
// APIキーをブラウザに置けないので、生成はここ(サーバー側)で行う。
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

// 連打・第三者による無駄な生成でAPI費用が膨らまないよう、最短間隔を設ける
const COOLDOWN_MINUTES = 5;

// フロントから渡されたモデル名をそのまま信用しない。ここで許可制にする。
// effort は Opus 5 / Sonnet 5 のみ対応(Haiku 4.5 に渡すとエラーになる)
const MODELS: Record<string, { effort?: string }> = {
  "claude-opus-5": { effort: "high" },
  "claude-sonnet-5": { effort: "high" },
  "claude-haiku-4-5": {},
};
const DEFAULT_MODEL = "claude-sonnet-5";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `あなたは、ある人が日々の「チェックイン」に答えた記録を読み解いて、
その人自身に向けたふりかえりレポートを書く役割です。

書く相手は本人です。本人が読んで「たしかに」と思えるものを書いてください。

## 大前提
- 記録に書かれていることだけを根拠にする。書かれていないことを推測で断定しない。
- 一般論やありがちなアドバイスを書かない。この人の記録からしか出てこない話を書く。
- 褒めるためのレポートではない。かといって批判でもない。見えている事実を、正確に、あたたかく返す。
- 本人が書いた言葉を引用して使う。引用は「」でくくり、記録にある通りの表記で書く。
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
本人が自分で考えるための問いを2〜3個。答えは書かない。`;

function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  // 新方式では名前付きのJSONで入ってくる
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    const parsed = JSON.parse(raw);
    return parsed["default"] ?? Object.values(parsed)[0] as string;
  }
  throw new Error("サービスキーが見つかりません");
}

function dbHeaders() {
  const key = serviceKey();
  const h: Record<string, string> = {
    apikey: key,
    "Content-Type": "application/json",
  };
  // 新しい sb_secret_... はJWTではないので Authorization には載せない
  if (key.startsWith("eyJ")) h["Authorization"] = `Bearer ${key}`;
  return h;
}

async function db(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...dbHeaders(), ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`DB ${path}: ${res.status} ${await res.text()}`);
  return res;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    if (!ANTHROPIC_API_KEY) {
      return json(
        { error: "ANTHROPIC_API_KEY が未設定です。Supabase の Edge Functions → Secrets で登録してください。" },
        500,
      );
    }

    const body = await req.json().catch(() => ({}));
    const days = Math.min(Math.max(Number(body.days) || 30, 1), 365);
    const model = MODELS[body.model] ? body.model : DEFAULT_MODEL;

    // クールダウン確認
    const recent = await (await db("self_reports?select=created_at&order=created_at.desc&limit=1")).json();
    if (recent.length > 0) {
      const elapsedMin = (Date.now() - new Date(recent[0].created_at).getTime()) / 60000;
      if (elapsedMin < COOLDOWN_MINUTES) {
        const wait = Math.ceil(COOLDOWN_MINUTES - elapsedMin);
        return json({ error: `さっき作ったばかりです。あと${wait}分ほど待ってください。` }, 429);
      }
    }

    // 対象期間の回答を取得
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = await (await db(
      "checkin_responses?select=question_text,answer,qtype,answered_at" +
        `&answered_at=gte.${since}&order=answered_at.asc&limit=2000`,
    )).json();

    if (rows.length < 5) {
      return json({ error: `対象期間の記録が${rows.length}件しかありません(5件以上で生成できます)。` }, 400);
    }

    const transcript = rows
      .map((r: any) => {
        const date = r.answered_at.slice(0, 10);
        const a = r.qtype === "scale" ? `${r.answer}/5(1が低い・5が高い)` : r.answer;
        return `[${date}] ${r.question_text}\n→ ${a}`;
      })
      .join("\n\n");

    const periodStart = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const periodEnd = new Date().toISOString().slice(0, 10);

    const payload: Record<string, unknown> = {
      model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            `対象期間: ${periodStart} 〜 ${periodEnd}\n回答数: ${rows.length}件\n\n` +
            `以下がこの人のチェックイン記録です。\n\n---\n${transcript}\n---\n\n` +
            `この記録を読んで、レポートを書いてください。`,
        },
      ],
    };
    const effort = MODELS[model].effort;
    if (effort) payload.output_config = { effort };

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });

    if (!aiRes.ok) {
      const detail = await aiRes.text();
      console.error("anthropic error", aiRes.status, detail);
      return json({ error: `AIの呼び出しに失敗しました (${aiRes.status})` }, 502);
    }

    const msg = await aiRes.json();
    if (msg.stop_reason === "refusal") {
      return json({ error: "AIが応答を拒否しました。" }, 502);
    }

    const content = (msg.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();
    if (!content) return json({ error: "空のレポートが返ってきました。" }, 502);

    await db("self_reports", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        period_start: periodStart,
        period_end: periodEnd,
        response_count: rows.length,
        content,
        model: msg.model ?? model,
      }),
    });

    return json({
      ok: true,
      response_count: rows.length,
      model: msg.model ?? model,
      input_tokens: msg.usage?.input_tokens,
      output_tokens: msg.usage?.output_tokens,
    });
  } catch (e) {
    console.error(e);
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
