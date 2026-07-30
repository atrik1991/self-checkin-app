# 別のSupabaseアカウントへの移行手順

データを使う本人のアカウントに、プロジェクトごと移すための手順。
記録は本人のものなので、本人名義のアカウントに置くのが本来の形。

所要時間は30〜40分ほど。**移行中も今のアプリは動き続ける**ので、慌てなくてよい。

---

## 全体像

| 移すもの | 方法 |
|---|---|
| テーブル構造・RLS | `supabase/schema.sql` を新プロジェクトで実行 |
| 質問203問・回答・レポート | `scripts/migrate_project.py` で直接コピー |
| レポート生成機能 | Edge Function を新プロジェクトへ再デプロイ |
| 通知の購読 | **移行しない**。端末で登録し直す(現在0件なので実質なし) |
| VAPIDキー・アプリURL | **変更なし**。GitHub側はそのまま使える |

---

## Step 1: 新しいアカウントとプロジェクトを作る(本人の操作)

1. https://supabase.com にアクセスし、**本人のメールアドレス**でサインアップ
2. 「New project」でプロジェクトを作成
   - Name: 何でもよい(例 `jibun-checkin`)
   - Database Password: **必ず控えておく**(あとで再表示できない)
   - Region: **Northeast Asia (Tokyo)** を選ぶ
3. 作成完了まで2〜3分待つ

> 無料プランで足りる。1アカウントあたり2プロジェクトまで無料。

---

## Step 2: テーブルを作る

新プロジェクトの **SQL Editor** を開き、このリポジトリの
[`supabase/schema.sql`](supabase/schema.sql) の中身を全部貼り付けて実行する。

「Success. No rows returned」と出れば成功。左メニューの Table Editor に
6つのテーブルが並ぶ。この時点では全部空。

---

## Step 3: データをコピーする

両方のプロジェクトの**シークレットキー**を用意する。
各プロジェクトの **Settings → API Keys** で確認できる
(`sb_secret_...`、または Legacy タブの `service_role`)。

ターミナルで実行:

```bash
cd ~/Documents/self-checkin-app
source venv/bin/activate
pip install -q requests

export SRC_URL=https://eabpkpfshikhhpowljan.supabase.co
export SRC_KEY=<今のプロジェクトのシークレットキー>
export DST_URL=<新プロジェクトのURL>
export DST_KEY=<新プロジェクトのシークレットキー>

python3 scripts/migrate_project.py
```

```
質問: 203問をコピー
回答: 60件をコピー
レポート: 3件をコピー
完了しました。
```

コピー先に既にデータがあると、二重コピーを防ぐため途中で止まる。

> キーは環境変数で渡すだけにして、ファイルに書いたりコミットしたりしない。
> 終わったらターミナルを閉じれば消える。

---

## Step 4: レポート生成機能を移す

1. 新プロジェクトの **Edge Functions → Create function**、名前は `generate-report`
2. [`supabase/functions/generate-report/index.ts`](supabase/functions/generate-report/index.ts)
   の中身を貼り付けてデプロイ
3. **Settings → Edge Functions → Secrets** で `ANTHROPIC_API_KEY` を登録
   (今と同じキーでよい。請求は引き続きキーの持ち主に来る)
4. 関数の設定で **Verify JWT を OFF** にする(ブラウザから直接叩くため)

---

## Step 5: アプリの接続先を変える

[`app.js`](app.js) の冒頭2行を新プロジェクトの値に差し替える。
値は **Settings → API Keys** の URL と **publishable / anon** キー
(シークレットキーではない方)。

```js
const SUPABASE_URL = "https://<新プロジェクト>.supabase.co";
const SUPABASE_ANON_KEY = "<新プロジェクトの publishable または anon キー>";
```

変更したらコミットして push。GitHub Pages に自動で反映される。

---

## Step 6: 通知の送信先を変える

GitHub Actions が使う接続先も差し替える:

```bash
gh secret set SUPABASE_URL --repo atrik1991/self-checkin-app --body "https://<新プロジェクト>.supabase.co"
gh secret set SUPABASE_SERVICE_KEY --repo atrik1991/self-checkin-app
```

VAPIDキーとアプリのURLは変わらないので、`VAPID_PRIVATE_KEY` と
`VAPID_SUBJECT` はそのままでよい。

---

## Step 7: 動作確認

1. アプリを開いて、これまでの記録が全部見えるか
2. 「じぶんレポート」タブで過去のレポートが読めるか
3. 新しく1問答えて、履歴に増えるか
4. レポートを1本生成してみる
5. iPhoneで **ホーム画面のアイコンから開いて**「通知をON」を押し直す
   (購読は移行していないため、ここは必須)
6. Actions から `Send check-in notification` を手動実行し、通知が届くか

---

## Step 8: 後片付け

全部動くのを数日確認してから、元のプロジェクトのテーブルを削除する。
急がなくてよい。消す前に、新プロジェクト側で件数が一致しているか確認すること。

---

## 補足: リポジトリをどうするか

現状、GitHub Actions のシークレットにデータベースのキーが入っているため、
**リポジトリの持ち主は新プロジェクトのキーを持つことになる**。
運用を引き続き担当するならこのままでよい。

完全に分けたい場合は、本人のGitHubアカウントでリポジトリを作り直し、
GitHub Pages とシークレットをそちらに移す。その場合はアプリのURLが変わるので、
ホーム画面のアイコンを追加し直し、通知も登録し直しになる。
