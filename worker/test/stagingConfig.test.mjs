/* ================================================================
   Phase 4.5 ― wrangler.jsonc の設定そのものを確かめる

   設定の書きまちがい1つで「誰でも見られる住所」が生まれます。
   コードのテストとは別に、**設定ファイルの中身**を機械的に確かめます。

   Cloudflare にも本物の R2 にも接続しません（ファイルを読むだけ）。
   ================================================================ */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readWranglerConfig, stripJsonc } from "./helpers/wranglerConfig.mjs";

const cfg = readWranglerConfig();
const stg = cfg.env && cfg.env.staging;

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const scripts = pkg.scripts || {};

/* ================================================================
   1. JSONC の読み取り（この道具自体が正しいこと）
   ================================================================ */

test("コメントを外しても、文字列の中の // や /* は残る", () => {
  const src = `{
    // 行コメント
    "a": "http://example.com/x", /* ブロック */
    "b": "/* これは文字列 */",
    "c": "エスケープ \\" の入った // 文字列",
  }`;
  const parsed = JSON.parse(stripJsonc(src));
  assert.equal(parsed.a, "http://example.com/x");
  assert.equal(parsed.b, "/* これは文字列 */");
  assert.equal(parsed.c, 'エスケープ " の入った // 文字列');
});

/* ================================================================
   2. トップレベル ― 公開URLを一切作らない
   ================================================================ */

test("Worker 名は your-worker-name（環境名は名前に二重で書かない）", () => {
  assert.equal(cfg.name, "your-worker-name");
  assert.equal(String(cfg.name).includes("staging"), false);
});

test("トップレベルは workers.dev もプレビューURLも作らない", () => {
  assert.equal(cfg.workers_dev, false, "workers_dev を false と明記してください");
  assert.equal(cfg.preview_urls, false, "preview_urls を false と明記してください");
});

test("トップレベルに route も custom domain も書かれていない", () => {
  for (const key of ["route", "routes", "custom_domain", "custom_domains"]) {
    assert.equal(key in cfg, false, `トップレベルに ${key} があります`);
  }
});

test("トップレベルのローカル設定は公開用プレースホルダーで固定されている", () => {
  assert.equal(cfg.vars.ENVIRONMENT, "local");
  assert.equal(cfg.vars.PUBLIC_MEDIA_BASE_URL, "http://127.0.0.1:8787");
  assert.deepEqual(cfg.assets.run_worker_first, ["/api/*", "/media/*"]);
  assert.equal(cfg.r2_buckets.length, 1, "ローカルのバケットは1件のままです");
  assert.equal(cfg.r2_buckets[0].binding, "MEDIA_BUCKET");
  assert.equal(cfg.r2_buckets[0].bucket_name, "your-media-local",
    "ローカルのバケット名を変えないでください（.wrangler/state/ の中だけを使います）");
});

/* ================================================================
   3. ステージング環境
   ================================================================ */

test("staging という名前の環境がある（Worker 名は your-worker-name-staging になる）", () => {
  assert.ok(stg, "env.staging がありません");
  assert.equal("name" in stg, false, "env.staging に name を書くと名前が二重になります");
});

test("ステージングだけ workers.dev を有効にする", () => {
  assert.equal(stg.workers_dev, true);
  assert.equal(stg.preview_urls, false, "プレビューURLは Access の外に出る恐れがあります");
});

test("ステージングに route も custom domain も書かれていない", () => {
  for (const key of ["route", "routes", "custom_domain", "custom_domains"]) {
    assert.equal(key in stg, false, `env.staging に ${key} があります`);
  }
});

test("ステージングの assets は省略せず全部書かれている", () => {
  assert.ok(stg.assets, "env.staging に assets がありません");
  assert.equal(stg.assets.directory, "./public/");
  assert.equal(stg.assets.binding, "ASSETS");
  assert.equal(stg.assets.run_worker_first, true,
    "true にしないと管理画面そのものが門番を素通りします");
});

test("ステージング専用の R2 バケットが1件だけつながっている", () => {
  assert.ok(Array.isArray(stg.r2_buckets), "env.staging に r2_buckets がありません");
  assert.equal(stg.r2_buckets.length, 1, "バケットは1件だけにしてください");
  assert.equal(stg.r2_buckets[0].binding, "MEDIA_BUCKET");
  assert.equal(stg.r2_buckets[0].bucket_name, "your-media-staging");
});

test("ステージングのバケットは、本番ともローカルとも別物", () => {
  const stgName = stg.r2_buckets[0].bucket_name;
  assert.notEqual(stgName, cfg.r2_buckets[0].bucket_name,
    "ローカルと同じバケットを見ています");
  assert.match(stgName, /staging/, "ステージング用と分かる名前にしてください");
});

test("バケット名を省略していない（省略すると自動で作られてしまう）", () => {
  for (const b of stg.r2_buckets) {
    assert.equal(typeof b.bucket_name, "string");
    assert.ok(b.bucket_name.length > 0, "bucket_name を必ず書いてください");
  }
});

test("R2 の危ない設定を書いていない", () => {
  for (const b of [...(stg.r2_buckets || []), ...(cfg.r2_buckets || [])]) {
    /* remote: true はローカル実行から本物の R2 につないでしまう */
    assert.equal("remote" in b, false, "remote は使いません");
    assert.equal("preview_bucket_name" in b, false, "preview_bucket_name は使いません");
    assert.equal("jurisdiction" in b, false, "jurisdiction は使いません");
  }
});

test("公開URL（r2.dev・カスタムドメイン）を有効にする設定が無い", () => {
  /* これらは Cloudflare 側の設定であり、ここに現れてはいけない。
     画像は Worker の /media/… から出し、Access の内側に置く。 */
  const raw = JSON.stringify(cfg);
  for (const word of ["r2.dev", "public_bucket", "publicAccess", "public_access",
                      "custom_domain", "customDomain"]) {
    assert.equal(raw.includes(word), false, `公開の設定が書かれています: ${word}`);
  }
});

test("ステージングの変数がそろっている", () => {
  assert.equal(stg.vars.ENVIRONMENT, "staging");
  assert.equal(stg.vars.PUBLIC_MEDIA_BASE_URL, "", "相対パスにするため空にします");
});

test("画像を変える操作の非常停止スイッチが、両方の環境に書いてある", () => {
  /* 書き忘れた環境は自動的に「禁止」になるが、
     意図を明示するため、どちらの環境にも必ず書いておく。 */
  assert.equal(cfg.vars.MEDIA_MUTATIONS_ENABLED, "true",
    "ローカルは従来どおり使えるようにします");
  assert.equal(stg.vars.MEDIA_MUTATIONS_ENABLED, "false",
    "R2 を有効化するまで、ステージングでは書き込みを止めておきます");
});

test("公開用 example config はステージングの蓋を閉じている", () => {
  assert.equal(stg.vars.STAGING_LOCKED, "true",
    "公開用設定は、Access と Secrets の確認前に必ず fail closed にします");
});

test("チームの住所が正しいかたちで書かれている", () => {
  /* Access のログイン画面の住所そのもの。秘密ではないので vars に書いてよい。
     ただし cloudflareaccess.com 以外を指していないことは確かめる
     （書きまちがえると、別のサーバへ公開鍵を取りに行くことになるため）。 */
  assert.match(stg.vars.ACCESS_TEAM_DOMAIN, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/,
    "〇〇.cloudflareaccess.com のかたちで書いてください");
  assert.equal(stg.vars.ACCESS_TEAM_DOMAIN, "your-team.cloudflareaccess.com");
});

test("ACCESS_AUD と ALLOWED_EMAIL は vars に書かない（Secret で登録する）", () => {
  /* vars に同じ名前があると、デプロイのたびに vars 側の値で上書きされ、
     Secret が効かなくなります。値そのものを Git に残さないためでもあります。 */
  assert.equal("ACCESS_AUD" in stg.vars, false,
    "ACCESS_AUD は wrangler secret put で登録してください");
  assert.equal("ALLOWED_EMAIL" in stg.vars, false,
    "ALLOWED_EMAIL は wrangler secret put で登録してください");
});

/* ================================================================
   4. ステージングをローカルで模擬するスクリプト（npm run dev:staging）

   このスクリプトは「Cloudflare につながずにステージング設定を試す」ための
   ものです。書きまちがえると本物の Cloudflare につないでしまうため、
   中身を1つずつ確かめます。
   ================================================================ */

test("dev:staging がある", () => {
  assert.equal(typeof scripts["dev:staging"], "string", "dev:staging スクリプトがありません");
  assert.ok(scripts["dev:staging"].length > 0);
});

test("dev:staging は wrangler dev を使う（deploy ではない）", () => {
  const s = scripts["dev:staging"];
  assert.match(s, /\bwrangler dev\b/, "wrangler dev を使ってください");
  assert.equal(/\bdeploy\b/.test(s), false, "dev のスクリプトに deploy が入っています");
  assert.equal(/\bpublish\b/.test(s), false, "dev のスクリプトに publish が入っています");
});

test("dev:staging は --local を明示している", () => {
  assert.match(scripts["dev:staging"], /--local(\s|$)/, "--local を明示してください");
});

test("dev:staging は --env staging を明示している", () => {
  assert.match(scripts["dev:staging"], /--env\s+staging(\s|$)/, "--env staging を明示してください");
});

test("dev:staging は --port 8788 を明示している", () => {
  assert.match(scripts["dev:staging"], /--port\s+8788(\s|$)/, "--port 8788 を明示してください");
});

test("dev:staging は --remote を含まない（本物の Cloudflare につながない）", () => {
  assert.equal(/--remote/.test(scripts["dev:staging"]), false,
    "--remote が入っています。本物の Cloudflare につながってしまいます");
});

test("dev:staging は npx を使わない（入っている wrangler だけを使う）", () => {
  assert.equal(/\bnpx\b/.test(scripts["dev:staging"]), false, "npx が入っています");
});

test("どのスクリプトにも --remote が入っていない", () => {
  for (const [name, body] of Object.entries(scripts)) {
    assert.equal(/--remote/.test(body), false, `${name} に --remote が入っています`);
  }
});

test("素の deploy は門番のスクリプトで止まる（--env の付け忘れ対策）", () => {
  assert.match(scripts.deploy || "", /deploy-guard\.mjs/,
    "npm run deploy は deploy-guard.mjs で止めてください");
  assert.equal(/\bwrangler\b/.test(scripts.deploy || ""), false,
    "素の deploy から wrangler を呼ばないでください");
});

test("デプロイ用のスクリプトは --env staging 付きのものだけ", () => {
  const deployers = Object.entries(scripts).filter(([, body]) => /wrangler\s+deploy/.test(body));
  assert.equal(deployers.length, 1, "wrangler deploy を呼ぶスクリプトが1つではありません");
  const [name, body] = deployers[0];
  assert.equal(name, "deploy:staging");
  assert.match(body, /--env\s+staging(\s|$)/, "--env staging が付いていません");
  assert.equal(/--remote/.test(body), false);
});

test("外部パッケージを増やしていない（ゼロ依存の維持）", () => {
  assert.equal("dependencies" in pkg, false, "本番に載る依存が増えています");
  assert.deepEqual(Object.keys(pkg.devDependencies || {}), ["wrangler"]);
});

/* ================================================================
   5. 秘密情報の混入
   ================================================================ */

test("設定ファイルに秘密情報・個人情報が書かれていない", () => {
  const raw = JSON.stringify(cfg);
  /* メールアドレスらしきもの */
  assert.equal(/[\w.+-]+@[\w-]+\.[\w.-]+/.test(raw), false, "メールアドレスが書かれています");
  /* トークンらしき長い英数字列。**設定の「値」だけ**を見る
     （項目の名前は長くなることがあるため） */
  const values = [];
  (function collect(o){
    if (Array.isArray(o)) { o.forEach(collect); return; }
    if (o && typeof o === "object") { Object.values(o).forEach(collect); return; }
    if (typeof o === "string") values.push(o);
  })(cfg);
  for (const v of values) {
    assert.equal(/^[A-Za-z0-9_-]{32,}$/.test(v), false, `トークンらしき値があります: ${v}`);
  }
  /* Secret で入れる約束のものが、vars に現れてはいけない */
  for (const key of ["ALLOWED_EMAIL", "ACCESS_AUD", "GITHUB_TOKEN", "API_TOKEN"]) {
    assert.equal(key in stg.vars, false, `${key} は wrangler secret put で入れてください`);
    assert.equal(key in (cfg.vars || {}), false, `${key} は wrangler secret put で入れてください`);
  }
});
