# Phase 2-1 実装計画 ― Worker と ローカルR2 の土台づくり

作成日：2026-08-05
作業ブランチ：`feature/r2-media-upload`
前提：Phase 1 完了（`phase-1` タグ）

---

## 0. この文書の位置づけ

`docs/PHASE2_R2_SPEC_JA.md`（Phase 2 全体の仕様書）のうち、
**今回（Phase 2-1）で実際に作る部分だけ**を切り出した作業計画です。

Phase 2 は大きすぎるので、2つに割ります。

| | 範囲 | 状態 |
|---|---|---|
| **Phase 2-1** | C-1 修正 ＋ Worker と ローカルR2 の土台 ＋ アップロードAPI | **今回** |
| Phase 2-2 | 管理画面（`handleFile()`）から実際にアップロードする | 次回 |

---

## 1. Phase 2-1 の目的

1. **既知のセキュリティ不具合 C-1 を直す**
   あいことばの暗号化に失敗したとき、配布URLが平文で `index.html` に出てしまう問題。
2. **Cloudflare Worker の開発土台を、自分のパソコンの中だけで作る**
   Cloudflare にログインもせず、本物の R2 バケットも作らずに、動くところまで持っていく。
3. **画像アップロードAPI を実装し、テストする**
   不正なファイルを弾けることを、自動テストで確かめる。

### 今回やらないこと（はっきり線を引く）

- ❌ 管理画面（`eruremo_SiteManager.html`）の画像UIに R2 を組み込むこと → **Phase 2-2**
- ❌ Cloudflare へのログイン・R2バケット作成・DNS変更・本番デプロイ
- ❌ GitHub の remote 登録・push
- ❌ 既存の Base64 画像の移行 → Phase 3
- ❌ 画像一覧・削除API → Phase 4

---

## 2. 変更するファイル

| ファイル | 変更内容 | コミット |
|---|---|---|
| `eruremo_SiteManager.html` | C-1 修正（30行追加 / 10行削除）**それ以外は触らない** | 1 |
| `test/lockurl_export.test.mjs` | 新規。C-1 の回帰テスト | 1 |
| `docs/PHASE2_1_IMPLEMENTATION_PLAN_JA.md` | 新規。この文書 | 2 |
| `worker/**` | 新規。Worker 一式 | 3 |
| `worker/test/**` | 新規。API のテスト | 4 |
| `.gitignore` | `worker/public/index.html` を除外対象から外す追記 | 3 |
| `README.md` | 新規。開発の始め方を短く | 3 |
| `CHANGELOG.md` | 新規。変更履歴 | 5 |
| `非公開の旧 Phase 2-1 実施記録` | 新規。実施結果と未検証項目 | 5 |

**変更しないもの**：`legacy/` 以下、既存の画像UI・Base64処理・URL手入力欄、
localStorage キー、JSON形式、`buildHtml()` / `migrate()` / `History` / `SCHEMA` / `TEMPLATE` の構造。

---

## 3. 追加するディレクトリ

```
<project-root>\
├─ test/                          ← 編集ツール本体のテスト（今回追加）
│   └─ lockurl_export.test.mjs
└─ worker/                        ← Cloudflare Worker 一式（今回追加）
    ├─ wrangler.jsonc             ← Worker の設定ファイル（秘密情報なし）
    ├─ .dev.vars.example          ← 環境変数の「キー名だけ」の見本
    ├─ public/
    │   └─ index.html             ← 管理画面の置き場（今は案内だけの仮ページ）
    ├─ src/
    │   ├─ index.js               ← 入口。URLを見て振り分けるだけ
    │   └─ lib/
    │       ├─ http.js            ← JSONレスポンスとエラーコード
    │       ├─ imageType.js       ← マジックバイトで画像の種類を判定
    │       ├─ mediaKey.js        ← R2キーの生成と検証
    │       └─ upload.js          ← アップロード処理の本体
    └─ test/
        ├─ helpers/
        │   ├─ mockR2.mjs         ← 本物のR2の代わり（メモリ上の偽バケット）
        │   └─ fixtures.mjs       ← テスト用の最小画像データ
        ├─ health.test.mjs
        ├─ imageType.test.mjs
        ├─ mediaKey.test.mjs
        └─ upload.test.mjs
```

---

## 4. Worker の構成

### 4-1. なぜ「1つの Worker」で管理画面とAPIを両方出すのか

**同一オリジン**（＝ブラウザから見て「同じ住所」）にするためです。
別々の住所にすると **CORS**（コルス／別ドメインへのアクセス制限の仕組み）の設定が必要になり、
設定を1文字間違えるだけで穴があきます。同じ住所なら、そもそも書く必要がありません。

```
http://localhost:8787/                    → public/index.html（管理画面）
http://localhost:8787/api/health          → Worker のコード
http://localhost:8787/api/media/upload    → Worker のコード
```

### 4-2. 2026年時点の Cloudflare 公式推奨構成

「静的アセット（Static Assets）を持つ Worker」が現在の推奨です。
`wrangler.jsonc` に次のように書くと、`/api/*` だけコードが動き、
それ以外は `public/` の中のファイルがそのまま返ります。

```jsonc
{
  "name": "eruremo-media-api",
  "main": "src/index.js",
  "compatibility_date": "2026-08-01",
  "assets": {
    "directory": "./public/",
    "binding": "ASSETS",
    "run_worker_first": ["/api/*"]
  },
  "r2_buckets": [
    { "binding": "MEDIA_BUCKET", "bucket_name": "eruremo-media" }
  ],
  "vars": {
    "ENVIRONMENT": "local",
    "PUBLIC_MEDIA_BASE_URL": "https://example.invalid"
  }
}
```

- `run_worker_first: ["/api/*"]` … `/api/` で始まる時だけコードを動かす
- `binding: "MEDIA_BUCKET"` … コードから `env.MEDIA_BUCKET` で R2 を触るための名札
- `vars` … **秘密ではない**設定値。秘密情報はここに書かない

> 参考：<https://developers.cloudflare.com/workers/static-assets/routing/worker-script/>

### 4-3. 秘密情報の扱い

- `wrangler.jsonc` に入るのは **秘密ではない値だけ**（環境名・公開URLの土台）
- 本番の秘密情報は **Cloudflare Worker Secrets**（Phase 5以降）
- ローカルで秘密情報が必要になったら `.dev.vars`（`.gitignore` 済み）
- `.dev.vars.example` には **キー名だけ**書き、値は空にする
- ログ・エラー本文に、バケット名・内部パス・スタックトレースを出さない

---

## 5. ローカル R2 の構成

**本物の Cloudflare には一切つなぎません。** 方法は2段構えです。

### 5-1. 今回のテストで使う方法：偽バケット（モック）

`worker/test/helpers/mockR2.mjs` に、メモリ上で動く「R2のふりをするオブジェクト」を作ります。
本物と同じ `put()` / `head()` / `get()` を持つだけの、数十行のコードです。

```js
const bucket = createMockR2();          // ただの Map
await handler.fetch(request, { MEDIA_BUCKET: bucket, ... });
```

- **利点**：外部パッケージが1つも要らない。Node.js だけで動く。ネットワークに出ない。
- **今回の自動テストはすべてこの方法で行います。**

### 5-2. ブラウザで触るときの方法：`wrangler dev`（**要承認**）

`http://localhost:8787/` を実際にブラウザで開くには、Cloudflare 公式の開発ツール
**wrangler** が必要です。これは npm の外部パッケージなので、
**インストール前に利用者の承認を得ます**（§10）。

`wrangler dev` は既定でローカル実行（内部の Miniflare）で、
R2 は `.wrangler/state/` 以下のパソコン内のフォルダに保存されます。
**Cloudflare アカウントにもログインせず、本物の R2 にも書き込みません。**

---

## 6. API 設計

### 6-1. `GET /api/health`

疎通確認用。R2 には触りません。

```json
{ "ok": true, "service": "eruremo-media-api", "environment": "local" }
```

### 6-2. `POST /api/media/upload`

`multipart/form-data` で次の2つを受け取ります。

| フィールド | 必須 | 内容 |
|---|---|---|
| `file` | ✅ | 画像1枚 |
| `category` | ✅ | 下の固定リストのどれか |

**category の固定リスト**（これ以外は拒否）

```
logo  favicon  og  about  cast  staff  history  shop  present  gallery  other
```

#### 成功

```json
{
  "ok": true,
  "key": "media/gallery/2026/08/3f2a9c1b7e4d8a05.webp",
  "url": "https://example.invalid/media/gallery/2026/08/3f2a9c1b7e4d8a05.webp",
  "size": 123456,
  "contentType": "image/webp"
}
```

- 新規保存 … `201 Created`
- 同じ内容が既にある … `200 OK`（`deduped: true` を追加）

#### 失敗

```json
{ "ok": false, "error": { "code": "INVALID_FILE_TYPE", "message": "この画像形式には対応していません。" } }
```

| HTTP | code | 利用者向けメッセージ |
|---|---|---|
| 404 | `NOT_FOUND` | このURLはありません。 |
| 405 | `METHOD_NOT_ALLOWED` | この操作には対応していません。 |
| 415 | `BAD_CONTENT_TYPE` | 画像は multipart/form-data で送ってください。 |
| 400 | `NO_FILE` | 画像が送られてきませんでした。 |
| 400 | `EMPTY_FILE` | ファイルが空です。 |
| 413 | `TOO_LARGE` | 画像が大きすぎます（最大10MB）。 |
| 400 | `INVALID_FILE_TYPE` | この画像形式には対応していません。 |
| 400 | `MIME_MISMATCH` | ファイルの中身と種類が一致しません。 |
| 400 | `INVALID_CATEGORY` | 画像の置き場所の指定が正しくありません。 |
| 500 | `R2_ERROR` | 画像の保存に失敗しました。 |

**エラー本文に、内部パス・バケット名・スタックトレース・秘密情報を含めません。**

### 6-3. R2 キーの形式

```
media/{category}/{YYYY}/{MM}/{内容のSHA-256の先頭16桁}.{jpg|png|webp}
```

- `media/` … Worker 内で固定（旧内部開発ルール §5 の取り決めを維持）
- `{category}` … **固定リストと完全一致したものだけ**
- `{YYYY}/{MM}` … Worker 側の現在時刻（UTC）
- ハッシュ … ファイルの中身から計算。同じ画像なら同じキー＝自動で重複排除
- 拡張子 … **マジックバイト判定の結果**から決める（申告を信用しない）

**利用者から受け取った文字列は、キーに一切入りません。**
ファイル名も使いません。したがって `../` によるパストラバーサル（意図しない場所への書き込み）は
構造的に起こりえません。

検証用の正規表現：

```js
/^media\/(logo|favicon|og|about|cast|staff|history|shop|present|gallery|other)\/\d{4}\/\d{2}\/[a-f0-9]{16}\.(jpg|png|webp)$/
```

> 📌 **旧内部開発ルール §5 との差分**：旧内部開発ルール には `media/{YYYY}/{MM}/{hash}.{ext}` と書かれています。
> 今回の依頼で `category` を含める指定があったため、`media/` の接頭辞は残したまま
> `category` を1階層追加しました。まだ本物の R2 には1件も保存していないので、
> 形式変更による影響はありません。**この形式で確定してよいか、承認時にご判断ください。**

---

## 7. セキュリティ検証（クライアントを信用しない）

| # | 検証 | やり方 |
|---|---|---|
| 1 | メソッド | `POST` 以外は 405 |
| 2 | Content-Type | `multipart/form-data` 以外は 415 |
| 3 | file の有無 | なければ 400 |
| 4 | 空ファイル | 0バイトは 400 |
| 5 | サイズ | `Content-Length` で事前判定 ＋ 実バイト数で再判定（10MB） |
| 6 | **マジックバイト** | 先頭バイト列で JPEG / PNG / WebP を判定 |
| 7 | **SVG 拒否** | `<svg` `<?xml` で始まるものは画像として認めない |
| 8 | **HTML / JS 偽装の拒否** | `<html` `<script` `<!DOC` などは認めない |
| 9 | 申告MIMEとの一致 | 食い違えば 400（保存には**判定結果**を使う） |
| 10 | ファイル名 | **一切使わない**（拡張子も無視） |
| 11 | category | 固定リストと完全一致のみ |
| 12 | キー | Worker が生成。生成後に正規表現で自己検証してから保存 |
| 13 | Content-Type | 判定結果を `httpMetadata.contentType` に設定 |
| 14 | Cache-Control | `public, max-age=31536000, immutable`（内容ハッシュ入りなので安全） |
| 15 | レスポンスヘッダ | `X-Content-Type-Options: nosniff`、`Cache-Control: no-store` |
| 16 | エラー | 内部情報を出さない。コードと日本語文だけ |

### マジックバイト（ファイル先頭の目印）

| 形式 | 先頭バイト |
|---|---|
| JPEG | `FF D8 FF` |
| PNG | `89 50 4E 47 0D 0A 1A 0A` |
| WebP | `52 49 46 46`（RIFF）＋ 8バイト目から `57 45 42 50`（WEBP） |

「拡張子が `.jpg` だから JPEG」とは**絶対に判断しません**。
中身が HTML なのに `.jpg` という名前のファイルを弾くためです。

---

## 8. テスト方法

**本物の Cloudflare / R2 には接続しません。**
Node.js 標準の `node:test` と、メモリ上の偽 R2 だけを使います。

```
node --test test/ worker/test/
```

| 分類 | 項目 |
|---|---|
| health | 200 が返る／`ok:true`／`service`／`environment`／R2に触らない |
| 正常系 | JPEG・PNG・WebP がそれぞれ保存でき、キー・URL・サイズ・Content-Type が正しい |
| 重複 | 同じ画像を2回送ると2回目は `200 deduped:true`、R2 は1件のまま |
| 拒否 | GET/PUT/DELETE、JSON本文、file なし、空ファイル、10MB超 |
| 拒否 | SVG、HTML偽装、JS偽装、GIF、AVIF、中身が空の RIFF |
| 拒否 | 不正 category、`../`、`media/`、大文字、空文字 |
| キー | 利用者の入力がキーに混ざらない／正規表現に一致する |
| R2失敗 | `put()` が例外を投げたとき 500 になり、内部情報が漏れない |
| 情報漏れ | どのエラー応答にも、バケット名・スタックトレース・ファイル名が入らない |

---

## 9. 使用予定パッケージ

### 今回の実装とテスト：**ゼロ**

Node.js 標準機能（`node:test`, `crypto.subtle`, `FormData`, `Blob`, `Request`）だけで完結します。
このプロジェクトの「外部パッケージゼロ」という強みを維持します。

### ブラウザで動かす段階：**wrangler（要承認）**

| 項目 | 内容 |
|---|---|
| パッケージ名 | `wrangler` |
| 用途 | `wrangler dev` で `http://localhost:8787` を立ち上げ、ローカルR2で動作確認する |
| 公式か | ✅ Cloudflare 公式（`cloudflare/workers-sdk`） |
| 標準機能で足りない理由 | R2バインディングと静的アセット配信は Cloudflare 独自ランタイムの機能で、素の Node.js では再現できない |
| 追加されるファイル | `worker/node_modules/`（`.gitignore` 済み）、`worker/package.json`、`worker/package-lock.json`、実行時に `worker/.wrangler/`（`.gitignore` 済み） |
| リスク | 依存パッケージが多い（数百）。ただし **開発時のみ**使用し、生成物には一切含まれない。`wrangler dev` は既定でローカル実行なので、**ログインもデプロイもしない** |

**承認をいただくまで `npm install` を実行しません。**

---

## 10. ロールバック方法

| 戻したいもの | 手順 |
|---|---|
| C-1 修正だけ | `git revert db360de` |
| Phase 2-1 すべて | `git checkout main`（`feature/r2-media-upload` は残る） |
| 完全に Phase 1 の状態へ | `git checkout phase-1` |
| 編集ツール本体だけ原本に戻す | `legacy/eruremo_SiteManager_original.html` をコピーして上書き |
| Worker を消す | `worker/` フォルダは本体と独立。消しても編集ツールに影響なし |

`legacy/eruremo_SiteManager_original.html`（SHA-256 `42FD31BB…4BF9DF51`）は**一切変更しません**。

---

## 11. 想定コミット単位

| # | メッセージ | 内容 |
|---|---|---|
| 1 | `fix: prevent plaintext gift URL on encryption failure` | C-1 修正＋回帰テスト（✅ 完了 `db360de`） |
| 2 | `docs: add Phase 2-1 implementation plan` | この文書 |
| 3 | `feat: add local R2 upload Worker foundation` | `worker/` 一式・`.gitignore`・`README.md` |
| 4 | `test: add media upload API tests` | `worker/test/` |
| 5 | `docs: record Phase 2-1 result` | 実施結果・`CHANGELOG.md` |

**GitHub へ push しません。タグも作りません。**

---

## 12. Phase 2-2 へ引き継ぐ内容

Phase 2-1 が終わった時点で、次の材料がそろっています。

| 引き継ぐもの | 使いどころ |
|---|---|
| `POST /api/media/upload` の仕様と実装 | エディタから叩く相手 |
| `GET /api/health` | 起動時に「R2モードが使えるか」を判定する |
| category の固定リスト | エディタ側の各フィールドを、どの category に対応させるか決める |
| エラーコード表 | エディタ側のトースト文言に対応づける |
| キー形式 | Phase 3（一括移行）・Phase 4（削除API）でそのまま使う |

### Phase 2-2 でやること（今回はやらない）

1. `handleFile()`（862–871行）に**保存先の分岐だけ**を足す
2. `dataUrlToBlob()` を追加（既存 `dataUrlToBytes()` を利用）
3. アップロード中のスピナー表示
4. 失敗時は **Base64 のまま続行**（フォールバック）。作業を止めない
5. URL手入力欄（`.urlin`）は**変更しない**
6. `wrangler dev` を立ち上げて、ブラウザから実際にアップロードして確認する

### Phase 2-2 の前に決めておくこと

- キー形式に `category` を含めてよいか（§6-3 の 📌）
- `PUBLIC_MEDIA_BASE_URL` のローカル値をどうするか（現状は `https://example.invalid`）
- どのフィールドをどの category に割り当てるか
