# Production Admin Phase A

この文書は、SiteManagerをCloudflare Accessで保護された管理者用Webアプリとしてproductionへ置くための、Phase A時点の構成を説明します。

## このPhaseで実装すること

- 一般公開用`PUBLIC_HOST`と管理用`ADMIN_HOST`の完全分離
- `ADMIN_HOST`全体に対するCloudflare AccessとWorker側JWT検証
- PUBLICから管理asset・`/api/*`へ到達できないルーティング
- PUBLIC/ADMIN双方から、同じproduction R2の`/media/*`を相対URLで読み出す構成
- SiteManagerと一般公開用`index.html`のbuild時分離
- productionのmutation初期値を`false`に固定

## このPhaseでは実装しないこと

- D1
- 編集DATAのサーバー保存
- 複数ブラウザ間の共有編集
- Owner / Editorなどの権限
- 編集履歴、競合解決、自動保存API
- 独自のメールアドレス・パスワード認証

管理者をCloudflare Accessへ複数追加することはできますが、現在の編集DATAは各ブラウザの`localStorage`に保存されます。管理者Aと管理者BのDATAは共有されません。

## production route matrix

| host | 認証 | 許可する経路 |
|---|---|---|
| `PUBLIC_HOST` | 不要 | `GET/HEAD /`、`GET/HEAD /index.html`、`GET/HEAD /media/*` |
| `ADMIN_HOST` | Cloudflare Access + Worker JWT | `GET/HEAD /admin/*`、`/api/*`、`GET/HEAD /media/*` |
| その他 | — | すべてfail closed |

PUBLICでは`/api/*`、`/admin/*`、`/eruremo_SiteManager.html`、その他のassetを返しません。ADMINではAccess認証をredirect・asset・API・R2より先に確認します。

## Static Assetsの組み立て

ソースの役割を次のように固定します。

```text
<project-root>/eruremo_SiteManager.html   SiteManagerの唯一のソース
worker/public-site/index.html             SiteManagerが生成した一般公開サイト（Git管理外）
```

`worker`ディレクトリで次を実行します。

```powershell
npm run build:production-assets
```

このコマンドはCloudflareへ接続せず、次の生成物だけを作ります。

```text
worker/production-assets/
├─ index.html          一般公開サイト
└─ admin/
   └─ index.html       SiteManagerの生成コピー
```

`worker/production-assets/`はGit管理外です。buildはディレクトリ全体をコピーせず、上記2つのHTMLだけをコピーします。一般公開用indexにSiteManagerの識別要素が混ざっている場合や、一般公開用indexが無い場合は失敗します。

## production設定

`worker/wrangler.jsonc`の`env.production`は公開用exampleです。実値をGitへ書かず、次を利用環境に合わせて設定します。

- `PUBLIC_HOST`
- `ADMIN_HOST`
- production Worker名
- production R2 bucket binding
- `ACCESS_TEAM_DOMAIN`
- Worker Secretsの`ACCESS_AUD`と`ALLOWED_EMAILS`（カンマ区切りの管理者メール一覧）

`ALLOWED_EMAILS`を設定した場合はその一覧だけが有効です。旧構成との互換のため、`ALLOWED_EMAILS`が無い場合のみ単一値の`ALLOWED_EMAIL`も利用できます。

`PUBLIC_HOST`と`ADMIN_HOST`にはhostnameだけを設定します。scheme、port、path、wildcardは使えません。同じ値や不正な値ならWorkerは全hostをfail closedにします。

`MEDIA_MUTATIONS_ENABLED`のexample初期値は`false`です。明示的に`true`へ変更するまで、uploadとdeleteはR2へ触れません。

## 認証ユーザーと将来のD1

既存のAccess JWT検証結果には、署名・issuer・audience・有効期限・許可emailを検証した後の正規化済みemailがあります。production ADMIN経路ではこの結果をserver-sideの`identity`として保持しますが、現在は保存・ログ出力・レスポンス返却を行いません。

次Phaseでは、書き込みAPIへこの識別情報をactorとして渡し、D1の次のような構造へ接続できます。

```text
sites
users
site_members
site_versions
audit_log
```

Phase Aではテーブル、migration、ユーザーDBを作成しません。JWT全文、token、emailをconsoleへ出力しません。

## Cloudflare側で将来必要になる設定

このリポジトリは以下を自動作成・変更しません。

- production Worker
- production R2 bucket
- custom domain / DNS
- `ADMIN_HOST`全体を保護するCloudflare Access applicationとpolicy
- Worker Secrets

Cloudflare設定とdeployは、ローカルテスト・セキュリティレビュー・生成済みpublic indexの監査後に別工程で行います。
