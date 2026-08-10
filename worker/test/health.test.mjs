/* GET /api/health と、ルーティングのテスト */
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createMockR2, createTestEnv } from "./helpers/mockR2.mjs";

const call = (url, init) => worker.fetch(new Request(url, init), createTestEnv(createMockR2()), {});

test("GET /api/health は 200 と決められた JSON を返す", async () => {
  const res = await call("http://localhost:8787/api/health");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await res.json(), {
    ok: true,
    service: "eruremo-media-api",
    environment: "local"
  });
});

test("GET /api/health は R2 に一切触らない", async () => {
  const bucket = createMockR2();
  const res = await worker.fetch(new Request("http://localhost:8787/api/health"),
    createTestEnv(bucket), {});
  assert.equal(res.status, 200);
  assert.equal(bucket._calls.head.length, 0);
  assert.equal(bucket._calls.put.length, 0);
  assert.equal(bucket._calls.get.length, 0);
});

test("末尾のスラッシュがあっても同じ", async () => {
  const res = await call("http://localhost:8787/api/health/");
  assert.equal(res.status, 200);
});

/* Phase 4.5 で仕様を変えました。
   以前は「ENVIRONMENT が無ければ unknown を返す」でしたが、
   いまは **ローカルと明示されていない環境はすべて門番が守る**ため、
   そもそも /api/health まで届きません（403）。
   書き忘れたときに素通りするより、入れなくなる方が安全だからです。 */
test("環境変数が無ければ、答える前に断る（本番値を推測して埋めない）", async () => {
  const res = await worker.fetch(new Request("http://localhost:8787/api/health"),
    { MEDIA_BUCKET: createMockR2() }, {});
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "FORBIDDEN");
  assert.equal("environment" in body, false, "環境の名前を漏らしています");
});

test("/api/health への POST は 405", async () => {
  const res = await call("http://localhost:8787/api/health", { method: "POST" });
  assert.equal(res.status, 405);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "METHOD_NOT_ALLOWED");
  assert.equal(res.headers.get("allow"), "GET, HEAD");
});

test("API のレスポンスはキャッシュされない設定になっている", async () => {
  const res = await call("http://localhost:8787/api/health");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("知らない /api/ のパスは 404", async () => {
  /* /api/media と /api/media/item は Phase 4 で使い始めたので、ここでは扱わない */
  for (const p of ["/api/", "/api", "/api/unknown", "/api/media/delete", "/api/media/items"]) {
    const res = await call("http://localhost:8787" + p);
    assert.equal(res.status, 404, p);
    assert.equal((await res.json()).error.code, "NOT_FOUND", p);
  }
});

test("/api/ 以外は静的アセットへ渡される", async () => {
  const res = await call("http://localhost:8787/");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "static asset");
});

test("静的アセットのバインディングが無ければ 404（黙って別のものを返さない）", async () => {
  /* ENVIRONMENT: "local" を明示しないと、Phase 4.5 の門番が先に断ります */
  const res = await worker.fetch(new Request("http://localhost:8787/whatever"),
    { ENVIRONMENT: "local", MEDIA_BUCKET: createMockR2() }, {});
  assert.equal(res.status, 404);
});

test("/apiary のように似た名前のパスを API 扱いしない", async () => {
  const res = await call("http://localhost:8787/apiary");
  assert.equal(await res.text(), "static asset");
});

test("エラー応答に内部情報が入らない", async () => {
  const res = await call("http://localhost:8787/api/unknown");
  const text = await res.text();
  for (const leak of ["your-media-local", "MEDIA_BUCKET", "src/", "Error", "at "]) {
    assert.equal(text.includes(leak), false, `内部情報が漏れています: ${leak}`);
  }
  assert.equal(/[A-Za-z]:\\/.test(text), false, "Windows の絶対パスが漏れています");
});
