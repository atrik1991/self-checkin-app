# じぶんチェックイン

1日に数回、ランダムなタイミングで質問の通知が届き、タップして答えるだけの個人用PWA。
回答は Supabase に貯まっていく。

## 構成

- `index.html` / `app.js` / `sw.js` / `manifest.json` / `icons/` — フロントエンド(GitHub Pagesで配信)
- `scripts/send_notification.py` — 通知送信スクリプト(GitHub Actionsから定期実行)
- `scripts/generate_report.py` — 回答をClaude APIでまとめて「じぶんレポート」を生成
- `.github/workflows/send-checkin.yml` — 20分おきに送信スクリプトを実行するcron
- `.github/workflows/generate-report.yml` — 毎月1日にレポートを生成するcron(手動実行も可)
- Supabase (project `eabpkpfshikhhpowljan`) — テーブル: `checkin_questions` / `push_subscriptions` / `checkin_responses` / `notification_schedule` / `notification_log`

## 質問の種類(全100問)

| qtype | 数 | UI | 保存内容 |
|---|---|---|---|
| `text` | 50 | 自由記述のテキストエリア | `answer` に本文 |
| `choice` | 25 | 選択肢のボタン(21問は複数選択可) | 単一選択: `answer` にラベル、`answer_value` に選択番号<br>複数選択: `answer` にラベルを `、` 区切りで連結、`answer_value` は `null` |
| `scale` | 25 | 1〜5の5段階ボタン | `answer` に数値、`answer_value` に同じ数値 |

`choice` の選択肢は `options` カラム(jsonb)に `{"choices":[...]}`、`scale` の両端ラベルは `{"min":"...","max":"..."}` で入れる。
`checkin_responses` にも `qtype` と `question_text` をスナップショットとして保存しているので、後から質問を編集・削除しても過去の記録は壊れない。

## セットアップ手順

### 1. GitHub Pages を有効化

リポジトリの Settings → Pages → Source を「Deploy from a branch」、Branch を `main` / `/(root)` に設定。
数分後に `https://<your-username>.github.io/self-checkin-app/` でアクセスできるようになる。

### 2. GitHub Secrets を設定

Settings → Secrets and variables → Actions → New repository secret で以下を登録:

| Name | 値 |
|---|---|
| `SUPABASE_URL` | `https://eabpkpfshikhhpowljan.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Supabase ダッシュボード → **Settings → API Keys** で取得(**絶対に公開しない**)。新しい `sb_secret_...` キー、旧 `service_role` キーのどちらでも動く |
| `VAPID_PRIVATE_KEY` | `vapid_private.pem` の中身をそのまま(ローカルに生成済み、Gitには含まれていない) |
| `VAPID_SUBJECT` | `mailto:自分のメールアドレス` |
| `ANTHROPIC_API_KEY` | じぶんレポート用。https://console.anthropic.com で発行(レポートを使わないなら不要) |

Variables タブ(任意)に `APP_URL` として Pages の URL を追加しておくと通知ログに残しやすい。

### 3. iPhoneで開く

1. Safari で Pages の URL を開く
2. 共有ボタン → 「ホーム画面に追加」
3. 追加したホーム画面アイコンから開く(**Safariのタブからではなく、必ずこのアイコンから**。iOSはインストール済みPWAでないと通知を許可できない)
4. アプリ内の「通知を有効にする」をタップ → 通知を許可

### 4. 動作確認

- Actions タブ → send-checkin.yml → Run workflow で手動実行し、通知が届くか確認できる
- 質問をタップすると該当の質問が開く。何もない状態で開くとランダムな質問が表示される

## 通知の頻度を変える

`.github/workflows/send-checkin.yml` の env と `scripts/send_notification.py` の `DAILY_TARGET_MIN` / `DAILY_TARGET_MAX` (デフォルト3〜5) / `ACTIVE_START_HOUR` / `ACTIVE_END_HOUR` (デフォルト8-23時, JST) で調整可能。

## 質問を追加する

Supabase の `checkin_questions` テーブルに `insert` するだけ。`active = false` で出題を止められる。

```sql
-- 自由記述
insert into checkin_questions (text, category, qtype)
values ('最近うまくいってることは?', 'mood', 'text');

-- 選択式(単一選択)
insert into checkin_questions (text, category, qtype, options)
values ('今の集中を邪魔してるのは?', 'work', 'choice',
        '{"choices":["通知","疲れ","迷い","人の予定"]}');

-- 選択式(複数選択可): options に "multi": true を足すだけ
insert into checkin_questions (text, category, qtype, options)
values ('今週うまくいったことは?', 'general', 'choice',
        '{"choices":["仕事","健康","家族","学び"],"multi":true}');

-- 5段階
insert into checkin_questions (text, category, qtype, options)
values ('今週の満足度は?', 'general', 'scale',
        '{"min":"不満","max":"大満足"}');
```

## じぶんレポート

アプリ上部の「じぶんレポート」タブで読める、回答のふりかえり。

### 生成する方法は2つ

**1. アプリのボタン(主)** — Supabase Edge Function `generate-report` を呼ぶ。
APIキーをブラウザに置けないため、生成はサーバー側で実行する。
期間(30日/90日/全期間)とモデル(標準=Sonnet 5 / じっくり=Opus 5 / 軽め=Haiku 4.5)を選べる。
既定は **Sonnet 5**(1回あたり約4円)。

- キーは Supabase の **Edge Functions → Secrets** に `ANTHROPIC_API_KEY` として置く
- モデル名はフロントから来た値をそのまま使わず、関数側の許可リストで検証する
- **5分のクールダウン**あり。連打や第三者の呼び出しでAPI費用が膨らむのを防ぐための最低限の歯止め
- この関数は `verify_jwt = false` で公開状態。URLを知られると誰でも叩けるので、
  歯止めはクールダウンのみ。気になる場合は関数側に合言葉チェックを足すこと

**2. GitHub Actions(自動)** — 毎月1日 JST 9:00 の cron。手動実行も可(`days` で日数指定)。
`ANTHROPIC_API_KEY` を GitHub Secrets にも登録しておく必要がある。

- 対象: 既定は直近30日の回答。5件未満のときはスキップする
- 中身: いまのあなた / 大事にしているもの / 気づいていないかもしれないこと / 数字の傾向 / 次の1ヶ月の問い
- 保存先: `self_reports` テーブル。RLSで閲覧のみ anon に開放、生成は service_role のみ
- モデル: 既定は `claude-sonnet-5`(`REPORT_MODEL` 環境変数で変更可)

プロンプトは `scripts/generate_report.py` の `SYSTEM_PROMPT`。褒めるためではなく、
記録どうしを突き合わせて初めて見えることを返す方針にしてある。

## 履歴の見え方

「これまでの記録」は日別で、右のプルダウンから直近5日分を切り替えられる(`app.js` の `HISTORY_DAYS` で変更可)。
5段階はドットバー、選択式はチップ、自由記述はそのまま本文で表示される。
