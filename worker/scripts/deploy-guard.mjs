/* ================================================================
   `npm run deploy` を止めるための門番

   なぜこれがあるのか：
     デプロイ先を指定し忘れると、意図しない環境へ出てしまいます。
     このプロジェクトでは **必ず `--env` を付ける**決まりなので、
     素の `deploy` は用意せず、この案内を出して止めます。

   （設定ファイル側でも二重に守っています。トップレベルには
     workers_dev: false / preview_urls: false を書き、route も
     custom domain も書いていないため、仮に `wrangler deploy` を
     直接打っても、インターネットからアクセスできる住所は生まれません。）
   ================================================================ */
const lines = [
  "",
  "  ✋ `npm run deploy` は使いません。デプロイ先を必ず指定してください。",
  "",
  "     ステージングへ:  npm run deploy:staging",
  "",
  "  ── デプロイ前チェックリスト（ステージング）──────────────",
  "   1. 全テストが通っているか",
  "      　node --test \"test/**/*.test.mjs\"（worker）",
  "      　node --test \"test/*.test.mjs\"（リポジトリの根）",
  "   2. wrangler.jsonc の env.staging を確認したか",
  "      　workers_dev: true / preview_urls: false",
  "      　assets.run_worker_first: true",
  "      　vars.ENVIRONMENT: \"staging\"",
  "   3. 初回は STAGING_LOCKED が \"true\" になっているか",
  "      　（Access の設定が終わるまで蓋を開けない）",
  "   4. 蓋を開けるのは、次がすべて終わってから",
  "      　・Access アプリを作り、許可メールを1件だけにした",
  "      　・ACCESS_TEAM_DOMAIN / ACCESS_AUD を入れた",
  "      　・ALLOWED_EMAIL を secret で入れた",
  "   5. R2 はまだ有効化しない（利用者の明示承認が必要）",
  "  ──────────────────────────────────────────────",
  ""
];
console.error(lines.join("\n"));
process.exit(1);
