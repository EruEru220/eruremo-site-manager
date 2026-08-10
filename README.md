# ERUREMO SiteManager

ERUREMO SiteManager は、サイトの内容をブラウザで編集し、公開用 HTML を書き出すためのツールです。編集画面・スタイル・主要ロジックは `eruremo_SiteManager.html` にまとまっており、基本的な編集はビルドなしで始められます。

画像を多く扱う場合は、同梱の Cloudflare Worker と R2 対応メディア API を利用できます。Worker はローカル実行にも対応し、公開用設定はプレースホルダーのまま収録しています。

## 主な機能

- 単一 HTML の編集ツール
- ページ、キャスト、履歴、ショップ、FAQ などのコンテンツ編集
- 画像のアップロード、一覧、参照、削除を行うメディア管理
- 単一 HTML への Base64 埋め込みと、Worker/R2 上のメディア URL の両方に対応
- プロジェクト JSON の読み書きとローカル保存
- 公開用 HTML の生成
- gift URL を合言葉で保護する gift lock

新しく生成する gift lock は v2 形式です。鍵導出には PBKDF2-HMAC-SHA256（600,000 iterations）、暗号化には AES-GCM（256-bit key）を使用します。旧形式の legacy lock も復号できるため、既存データとの互換性があります。

## 構成

| パス | 内容 |
|---|---|
| `eruremo_SiteManager.html` | 編集ツール本体 |
| `legacy/` | 旧版の参照用スナップショット |
| `test/` | 編集ツールのテスト |
| `worker/` | Cloudflare Worker、R2 メディア API、テスト |
| `docs/` | 利用・設計・テストに関する補足資料 |

## 編集ツールを起動する

`eruremo_SiteManager.html` を PC 版 Chrome などの対応ブラウザで開きます。単一 HTML 内に画像を埋め込む使い方では、Worker は不要です。

R2 対応のメディア管理をローカルで試す場合は、Node.js とロックファイルに記録された開発依存関係を使用します。

```powershell
cd worker
npm ci
npm run dev
```

起動後に `http://127.0.0.1:8787/eruremo_SiteManager.html` を開きます。`npm run dev` は編集ツールを `worker/public/` にコピーし、Wrangler を `--local` で起動します。ローカルの R2 データは `worker/.wrangler/` 以下に置かれ、Git の対象外です。

> このリポジトリの公開準備では依存関係の新規取得を行っていません。`npm ci` は利用者が初回セットアップ時に lockfile どおりの依存関係を用意するための手順です。

## Worker と R2 の設定

`worker/wrangler.jsonc` は安全弁を含む公開用 example config です。次のプレースホルダーを、自分が管理する Cloudflare リソースの値へ置き換えてください。

| 種類 | プレースホルダー |
|---|---|
| Worker 名 | `your-worker-name` |
| Cloudflare Access team domain | `your-team.cloudflareaccess.com` |
| ローカル用 R2 bucket | `your-media-local` |
| staging 用 R2 bucket | `your-media-staging` |
| production 用 R2 bucket | `your-media-production` |

staging 設定は初期状態で `STAGING_LOCKED="true"`、`MEDIA_MUTATIONS_ENABLED="false"` です。Cloudflare Access、Worker Secrets、R2 binding を自分の環境で確認するまでは解除しないでください。

`ACCESS_AUD` と `ALLOWED_EMAILS`（カンマ区切りの管理者メール一覧）は `wrangler.jsonc` の `vars` に書かず、Worker Secrets として登録します。旧設定との互換用に、`ALLOWED_EMAILS` が無い場合だけ単一値の `ALLOWED_EMAIL` も受け付けます。ローカルで値が必要な場合は `worker/.dev.vars.example` を `worker/.dev.vars` にコピーし、Git 管理外のファイルだけに設定してください。

デプロイ前には少なくとも次を確認してください。

- Worker 名、team domain、bucket 名が自分の環境を指している
- R2 の公開アクセス方針と lifecycle rule が意図どおりである
- Cloudflare Access の application と policy が有効である
- `ACCESS_AUD` と `ALLOWED_EMAILS` が Secrets として登録されている
- `STAGING_LOCKED` と各 mutation switch を開く必要性を個別に確認した

`npm run deploy` は誤操作防止のガードで停止します。staging 用スクリプトも、実行前に設定と差分を確認してください。

## Production Admin Phase A

productionでは、一般公開サイトと管理用SiteManagerを同じWorker上の別hostnameとして扱います。

| host | 用途 | 認証 | 許可する主な経路 |
|---|---|---|---|
| `PUBLIC_HOST` | 一般閲覧者向け | 不要 | `/`、`/index.html`、`/media/*`のGET/HEAD |
| `ADMIN_HOST` | SiteManagerと管理API | Cloudflare Access + Worker JWT | `/admin/*`、`/api/*`、`/media/*`のGET/HEAD |

PUBLICから`/api/*`、`/admin/*`、SiteManager本体へは到達できません。ADMINはredirect、static asset、API、R2読み出しより先にAccess JWTを検証します。設定にないhostnameはfail closedです。

SiteManager本体はリポジトリ直下の`eruremo_SiteManager.html`だけを編集します。production用コピーをソースとしてGit管理しません。一般公開用HTMLと合わせるときは、SiteManagerが生成した`index.html`を`worker/public-site/index.html`へ置き、次を実行します。

```powershell
cd worker
npm run build:production-assets
```

生成先はGit管理外の`worker/production-assets/`です。

```text
production-assets/
├─ index.html          一般公開サイト
└─ admin/index.html    Access保護下のSiteManager
```

このbuildはファイルコピーだけを行い、deployや外部通信は行いません。`worker/public-site/index.html`が無い場合や、一般公開用HTMLにSiteManagerが混入している場合は失敗します。

> Phase Aでは複数管理者をCloudflare Accessで許可できますが、編集DATAはまだ各ブラウザの`localStorage`に保存されます。ブラウザ間の共有編集、D1保存、権限管理、履歴、競合解決は未対応です。

詳細は[Production Admin Phase A](docs/PRODUCTION_ADMIN_PHASE_A_JA.md)を参照してください。

## テスト

テストは Node.js の組み込み test runner を使い、外部サービスへ接続せずに実行します。

```powershell
# リポジトリのルート
node --test "test/*.test.mjs"

# Worker
cd worker
node --test "test/**/*.test.mjs"
```

現在確認済みの内訳は、編集ツール 298 tests、Worker 498 tests（481 pass、既存の実データ依存17件はskip）、合計 796 tests、fail 0です。

## セキュリティ上の注意

- gift lock は平文 URL の露出を避けるための機能ですが、短い・推測しやすい合言葉まで強くするものではありません。十分に長く、再利用していない合言葉を選んでください。
- PBKDF2 の反復回数は総当たり攻撃のコストを上げますが、暗号化されたデータを無条件に安全にする保証ではありません。
- legacy lock の復号互換は既存データを開くためのものです。新規作成には v2 lock を使用してください。
- API token、Access ID、メールアドレス、秘密鍵などの実値を HTML、JSON、`wrangler.jsonc`、Git 履歴へ入れないでください。
- `.dev.vars`、`.wrangler/`、`node_modules/`、バックアップ JSON は公開しないでください。
- staging や本番では HTTPS、Cloudflare Access、最小権限の Secrets、R2 の非公開設定を組み合わせ、設定変更後に再テストしてください。
- ブラウザの localStorage や書き出したプロジェクト JSON はバックアップとして扱い、必要に応じて安全な場所へ保管してください。

## 補足資料

- [初心者向けガイド](docs/BEGINNER_GUIDE_JA.md)
- [現在の構成](docs/CURRENT_ARCHITECTURE_JA.md)
- [旧将来構成（Phase 1時点の履歴）](docs/FUTURE_ARCHITECTURE_JA.md)
- [Production Admin Phase A](docs/PRODUCTION_ADMIN_PHASE_A_JA.md)
- [R2 仕様](docs/PHASE2_R2_SPEC_JA.md)
- [テスト計画](docs/TEST_PLAN_JA.md)
