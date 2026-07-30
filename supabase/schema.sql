-- じぶんチェックイン: スキーマ一式
-- 新しい Supabase プロジェクトの SQL Editor にこのまま貼って実行する。
-- 質問203問の中身は seed_questions.sql にある(このファイルの次に実行する)。

-- ── 質問マスタ ───────────────────────────────
create table if not exists checkin_questions (
  id bigint generated always as identity primary key,
  text text not null,
  category text not null default 'general',
  qtype text not null default 'text',
  options jsonb,
  active boolean not null default true,
  last_asked_at timestamptz,
  ask_count int not null default 0,
  created_at timestamptz not null default now(),
  constraint checkin_questions_qtype_check
    check (qtype in ('text', 'choice', 'scale'))
);

-- ── プッシュ通知の購読情報 ──────────────────
create table if not exists push_subscriptions (
  id bigint generated always as identity primary key,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- ── 回答ログ ─────────────────────────────────
-- question_text と qtype はスナップショット。あとで質問を編集しても過去の記録が壊れない。
create table if not exists checkin_responses (
  id bigint generated always as identity primary key,
  question_id bigint references checkin_questions(id),
  question_text text not null,
  qtype text not null default 'text',
  answer text not null,
  answer_value int,
  answered_at timestamptz not null default now()
);

create index if not exists checkin_responses_answered_at_idx
  on checkin_responses (answered_at desc);

-- ── 通知スケジュール(1行だけ) ──────────────
create table if not exists notification_schedule (
  id int primary key default 1,
  day_date date not null default (now() at time zone 'Asia/Tokyo')::date,
  daily_target int not null default 4,
  sends_today int not null default 0,
  next_send_at timestamptz not null default now(),
  constraint single_row check (id = 1)
);

insert into notification_schedule (id) values (1) on conflict (id) do nothing;

-- ── 送信履歴 ─────────────────────────────────
create table if not exists notification_log (
  id bigint generated always as identity primary key,
  question_id bigint references checkin_questions(id),
  sent_at timestamptz not null default now(),
  subscriptions_count int not null default 0,
  success_count int not null default 0,
  error text
);

-- ── じぶんレポート ───────────────────────────
create table if not exists self_reports (
  id bigint generated always as identity primary key,
  period_start date not null,
  period_end date not null,
  response_count int not null,
  content text not null,
  model text,
  created_at timestamptz not null default now()
);

create index if not exists self_reports_created_at_idx
  on self_reports (created_at desc);

-- ── RLS ──────────────────────────────────────
-- ブラウザ(anon)には必要最小限だけ開ける。
-- スケジュール・送信履歴はサーバー側(service_role / Edge Function)専用。
alter table checkin_questions    enable row level security;
alter table push_subscriptions   enable row level security;
alter table checkin_responses    enable row level security;
alter table notification_schedule enable row level security;
alter table notification_log     enable row level security;
alter table self_reports         enable row level security;

create policy "anon can read active questions" on checkin_questions
  for select to anon using (active = true);

create policy "anon can upsert own subscription" on push_subscriptions
  for insert to anon with check (true);
create policy "anon can update own subscription" on push_subscriptions
  for update to anon using (true);

create policy "anon can insert responses" on checkin_responses
  for insert to anon with check (true);
create policy "anon can read own responses" on checkin_responses
  for select to anon using (true);

create policy "anon can read reports" on self_reports
  for select to anon using (true);
