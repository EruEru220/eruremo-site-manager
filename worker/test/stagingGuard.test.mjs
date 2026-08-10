/* ================================================================
   Phase 4.5 ― ステージングの門番のテスト

   確かめること：
   - 門番が外れるのは ENVIRONMENT が**ちょうど "local"** のときだけ
     （未設定・打ちまちがい・知らない値は、すべて守られる側）
   - ロック中は **すべての経路**（管理画面・静的ファイル・API・画像）が拒否される
   - ロックの判定は「"false" 以外はすべてロック」（未設定もロック）
   - ロックを外しても、通行証（JWT）が無ければ通らない
   - 断る理由によって**返事が変わらない**（外から状態を推し量れない）
   - **ローカル開発はこれまでどおり、認証なしで使える**

   本物の R2 にも Cloudflare にも接続しません。
   ================================================================ */
import test from "node:test";
import assert from "node:assert/strict";
import worker, { isLocalEnv, isGuardedEnv, isStagingLocked } from "../src/index.js";
import { createMockR2, createTestEnv } from "./helpers/mockR2.mjs";

const ORIGIN = "http://localhost:8787";

/* ステージングの env を作る（R2 バインディングは無い＝4.5 の実際の姿） */
function stagingEnv(overrides = {}){
  return {
    ENVIRONMENT: "staging",
    STAGING_LOCKED: "true",
    PUBLIC_MEDIA_BASE_URL: "",
    ACCESS_TEAM_DOMAIN: "",
    ACCESS_AUD: "",
    ASSETS: { fetch: async () => new Response("static asset", { status: 200 }) },
    ...overrides
  };
}

/* 管理画面・静的ファイル・API・画像 のすべての入口 */
const ALL_PATHS = [
  "/",
  "/index.html",
  "/eruremo_SiteManager.html",
  "/favicon.ico",
  "/api",
  "/api/health",
  "/api/media",
  "/api/media/upload",
  "/api/media/item",
  "/media/gallery/2026/08/0123456789abcdef.png",
  "/なにか/知らない/場所"
];

const get = (env, path, init) => worker.fetch(new Request(ORIGIN + path, init), env, {});

/* ================================================================
   1. ロックの判定
   ================================================================ */

test("門番が外れるのは、ちょうど \"local\" のときだけ", () => {
  assert.equal(isLocalEnv({ ENVIRONMENT: "local" }), true);
  assert.equal(isGuardedEnv({ ENVIRONMENT: "local" }), false);

  /* それ以外は全部守られる側（打ちまちがい・未設定を含む） */
  for (const v of ["staging", "stagin", "Staging", "STAGING", "production", "prod",
                   "Local", " local ", "", undefined, null, 0, 123, "本番"]) {
    assert.equal(isGuardedEnv({ ENVIRONMENT: v }), true, JSON.stringify(v));
  }
  assert.equal(isGuardedEnv({}), true, "未設定は守られる側にしてください");
  assert.equal(isGuardedEnv(null), true);
});

test("STAGING_LOCKED は「false 以外はすべてロック」", () => {
  /* 開くのは、ちょうど "false" のときだけ */
  for (const v of ["false", "FALSE", " false ", "False"]) {
    assert.equal(isStagingLocked({ STAGING_LOCKED: v }), false, JSON.stringify(v));
  }
  /* それ以外は全部ロック（未設定・空・打ちまちがいを含む） */
  for (const v of [undefined, null, "", " ", "true", "TRUE", "0", "no", "off", "yes", "1", "ロック"]) {
    assert.equal(isStagingLocked({ STAGING_LOCKED: v }), true, JSON.stringify(v));
  }
  assert.equal(isStagingLocked({}), true, "未設定はロック扱いにしてください");
  assert.equal(isStagingLocked(null), true);
});

/* ================================================================
   2. ロック中は全経路を拒否する
   ================================================================ */

test("ロック中は、管理画面も静的ファイルも API も画像も 403", async () => {
  const env = stagingEnv();
  for (const path of ALL_PATHS) {
    const res = await get(env, path);
    assert.equal(res.status, 403, `拒否されていません: ${path}`);
    assert.equal((await res.json()).error.code, "FORBIDDEN", path);
  }
});

test("ロック中は静的ファイルを一切返さない", async () => {
  let called = 0;
  const env = stagingEnv({ ASSETS: { fetch: async () => { called++; return new Response("static asset"); } } });
  for (const path of ["/", "/index.html", "/eruremo_SiteManager.html"]) {
    const res = await get(env, path);
    assert.equal(await res.text() === "static asset", false, `静的ファイルが漏れています: ${path}`);
  }
  assert.equal(called, 0, "ロック中なのに静的ファイルを取りに行っています");
});

test("ロック中はメソッドを変えても通らない", async () => {
  const env = stagingEnv();
  for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
    const init = method === "GET" || method === "HEAD" ? { method } : { method, body: "x" };
    const res = await get(env, "/api/health", init);
    assert.equal(res.status, 403, method);
  }
});

test("ロック中は R2 にも一切触らない", async () => {
  const bucket = createMockR2();
  const env = stagingEnv({ MEDIA_BUCKET: bucket });
  for (const path of ALL_PATHS) await get(env, path);
  assert.equal(bucket._calls.get.length, 0);
  assert.equal(bucket._calls.put.length, 0);
  assert.equal(bucket._calls.list.length, 0);
  assert.equal(bucket._calls.delete.length, 0);
});

test("ロック中の応答に内部情報が入らない", async () => {
  const res = await get(stagingEnv(), "/api/health");
  const dump = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n") + "\n" + await res.text();
  for (const leak of ["your-media", "MEDIA_BUCKET", "wrangler", "miniflare", "staging",
                      "LOCKED", "ロック", "準備中"]) {
    assert.equal(dump.includes(leak), false, `内部情報が漏れています: ${leak}`);
  }
  assert.equal(/[A-Za-z]:\\/.test(dump), false, "Windows の絶対パスが漏れています");
});

test("断る理由がちがっても、返事はまったく同じ（状態を推し量れない）", async () => {
  const cases = {
    "ロック中": stagingEnv(),
    "ロックは外れたが設定が無い": stagingEnv({ STAGING_LOCKED: "false" }),
    "設定はあるが通行証が無い": stagingEnv({
      STAGING_LOCKED: "false",
      ACCESS_TEAM_DOMAIN: "example-team.cloudflareaccess.com",
      ACCESS_AUD: "0123456789abcdef",
      ALLOWED_EMAIL: "someone@example.invalid"
    }),
    "ENVIRONMENT の打ちまちがい": stagingEnv({ ENVIRONMENT: "stagin" }),
    "ENVIRONMENT が未設定": stagingEnv({ ENVIRONMENT: undefined })
  };
  const seen = [];
  for (const [label, env] of Object.entries(cases)) {
    const res = await get(env, "/");
    const headers = [...res.headers].map(([k, v]) => `${k}: ${v}`).sort().join("\n");
    seen.push({ label, sig: `${res.status}\n${headers}\n${await res.text()}` });
  }
  const first = seen[0].sig;
  for (const s of seen) {
    assert.equal(s.sig, first, `返事が他と違います: ${s.label}`);
  }
  assert.ok(first.startsWith("403"), "403 で断ってください");
});

/* ================================================================
   3. ロックを外しても、通行証が無ければ通らない
   ================================================================ */

test("ロックを外しても、Access の設定が無ければ全経路 403", async () => {
  const env = stagingEnv({ STAGING_LOCKED: "false" });
  for (const path of ALL_PATHS) {
    const res = await get(env, path);
    assert.equal(res.status, 403, `通ってしまいました: ${path}`);
    assert.equal((await res.json()).error.code, "FORBIDDEN", path);
  }
});

test("設定が1つでも欠けていれば通さない", async () => {
  const full = {
    STAGING_LOCKED: "false",
    ACCESS_TEAM_DOMAIN: "example-team.cloudflareaccess.com",
    ACCESS_AUD: "0123456789abcdef",
    ALLOWED_EMAIL: "someone@example.invalid"
  };
  for (const missing of ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "ALLOWED_EMAIL"]) {
    const vars = { ...full };
    delete vars[missing];
    const res = await get(stagingEnv(vars), "/");
    assert.equal(res.status, 403, `${missing} が無いのに通りました`);
    assert.equal((await res.json()).error.code, "FORBIDDEN");
  }
});

test("通行証が無ければ、設定がそろっていても通らない", async () => {
  const env = stagingEnv({
    STAGING_LOCKED: "false",
    ACCESS_TEAM_DOMAIN: "example-team.cloudflareaccess.com",
    ACCESS_AUD: "0123456789abcdef",
    ALLOWED_EMAIL: "someone@example.invalid"
  });
  for (const path of ALL_PATHS) {
    const res = await get(env, path);
    assert.equal(res.status, 403, path);
  }
});

test("でたらめな通行証も通らない", async () => {
  const env = stagingEnv({
    STAGING_LOCKED: "false",
    ACCESS_TEAM_DOMAIN: "example-team.cloudflareaccess.com",
    ACCESS_AUD: "0123456789abcdef",
    ALLOWED_EMAIL: "someone@example.invalid"
  });
  for (const token of ["", "abc", "a.b.c", "..", "eyJhbGciOiJub25lIn0..", "Bearer x"]) {
    const res = await worker.fetch(
      new Request(ORIGIN + "/", { headers: { "cf-access-jwt-assertion": token } }), env, {});
    assert.equal(res.status, 403, JSON.stringify(token));
  }
});

/* ================================================================
   4. ローカル開発は今までどおり（ここが崩れると日々の作業が止まる）
   ================================================================ */

test("ローカルでは STAGING_LOCKED があっても無視される", async () => {
  const env = createTestEnv(createMockR2(), { ENVIRONMENT: "local", STAGING_LOCKED: "true" });
  const res = await get(env, "/api/health");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.environment, "local");
});

test("ローカルでは通行証が無くても静的ファイルが返る", async () => {
  const env = createTestEnv(createMockR2(), { ENVIRONMENT: "local" });
  const res = await get(env, "/");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "static asset");
});

test("ローカルでは画像の読み出しがこれまでどおり動く", async () => {
  const bucket = createMockR2();
  const env = createTestEnv(bucket, { ENVIRONMENT: "local" });
  const key = "media/gallery/2026/08/0123456789abcdef.png";
  await bucket.put(key, new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), {});
  const res = await get(env, "/" + key);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
});

test("ENVIRONMENT が未設定なら、門番が働く（安全側に倒す）", async () => {
  const env = createTestEnv(createMockR2(), { ENVIRONMENT: undefined });
  for (const path of ALL_PATHS) {
    const res = await get(env, path);
    assert.equal(res.status, 403, `未設定なのに通りました: ${path}`);
  }
});

test("ENVIRONMENT の打ちまちがいでも、門番が働く", async () => {
  for (const typo of ["stagin", "Local", "LOCAL", " local", "local ", "ローカル", "dev"]) {
    const env = createTestEnv(createMockR2(), { ENVIRONMENT: typo });
    const res = await get(env, "/api/health");
    assert.equal(res.status, 403, `打ちまちがい "${typo}" で通ってしまいました`);
  }
});

test("打ちまちがいの環境でも R2 には触らない", async () => {
  const bucket = createMockR2();
  const env = createTestEnv(bucket, { ENVIRONMENT: "stagin" });
  for (const path of ALL_PATHS) await get(env, path);
  assert.equal(bucket._calls.get.length, 0);
  assert.equal(bucket._calls.put.length, 0);
  assert.equal(bucket._calls.list.length, 0);
  assert.equal(bucket._calls.delete.length, 0);
});
