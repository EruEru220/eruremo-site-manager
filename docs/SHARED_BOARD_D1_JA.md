# D1共有掲示板

生成サイトの「らくがきボード」は、Cloudflare WorkerとD1を利用する共有掲示板です。旧Firebase SDK、`elremo_board_v1`、`elremo_board_v1_last`は使用しません。

## 経路

| host | method / path | 用途 |
|---|---|---|
| PUBLIC | `GET /api/board/posts` | active投稿を新しい順に最大30件（指定時最大50件）取得 |
| PUBLIC | `POST /api/board/posts` | Turnstile検証後に投稿 |
| ADMIN | `DELETE /api/admin/board/posts/:id` | Access認証済み管理者によるsoft delete |

その他のPUBLIC APIとPUBLICの管理経路は404です。D1 bindingや必須Secretが無い場合は503でfail closedになります。

## 保存と制限

- IDはWorkerの`crypto.randomUUID()`、時刻はUTC epoch milliseconds
- 表示時だけ`Asia/Tokyo`として整形
- active投稿は最大5,000件。DB triggerと単一INSERT条件で同時投稿時も上限を越えない
- 同一利用者は30秒に1件、10分に5件、同一本文は10分間拒否
- IPアドレスは保存せず、日付を含めてHMAC化した識別子だけを最長48時間保持
- 削除は`status=deleted`と`deleted_at`を記録するsoft delete
- SQL値はすべてD1 binding parameterで渡す

## 必要な設定

- D1 binding: `BOARD_DB`
- Worker Secret: `TURNSTILE_SECRET_KEY`
- Worker Secret: `BOARD_RATE_LIMIT_SECRET`
- SiteManagerのproject設定: 公開値のTurnstile Site Key

`worker/wrangler.jsonc`のdatabase名とIDは例示プレースホルダーです。本番値やSecretをGitへ追加しないでください。

## migrationとローカルテスト

schemaは`worker/migrations/0001_shared_board.sql`にあります。`CREATE ... IF NOT EXISTS`と`INSERT OR IGNORE`を使用し、再適用可能です。自動テストはMiniflareのローカルD1だけを使い、Cloudflareへ接続しません。

```powershell
cd worker
node --test "test/board.test.mjs"
```

本番D1作成、remote migration、Turnstile widget作成、Secret登録、deployはこのローカル実装工程には含まれません。
