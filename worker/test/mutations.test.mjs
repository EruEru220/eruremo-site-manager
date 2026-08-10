/* ================================================================
   Phase 4.5 ― 画像を変える操作の非常停止スイッチのテスト

   確かめること：
   - **"true" と完全に一致したときだけ**書き込みを許す
   - 未設定・""・"false"・"TRUE"・"False"・"tru" など、**それ以外はすべて禁止**
   - 止まっているとき、R2 に **get/head/put/list/delete が1回も**行かない
   - 読み出し（一覧・画像・疎通確認）は止まらない
   - 認証の門番が先に働き、認証前に停止スイッチや R2 へ進まない

   本物の R2 にも Cloudflare にも接続しません。
   ================================================================ */
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { mutationsEnabled } from "../src/lib/mutations.js";
import { createMockR2, createTestEnv } from "./helpers/mockR2.mjs";
import { makeUploadRequest, PNG_BYTES } from "./helpers/fixtures.mjs";

const ORIGIN = "http://localhost:8787";
const KEY = "media/gallery/2026/08/0123456789abcdef.png";

/* 許可されない値。ここに1つでも通るものがあってはいけない。 */
const DISABLED_VALUES = [
  undefined, null, "", " ", "false", "FALSE", "False",
  "TRUE", "True", "tRuE", " true", "true ", " true ", "\ttrue",
  "tru", "truee", "yes", "on", "1", "0", "有効", "enabled",
  0, 1, true, {}, []
];

/* value が undefined のときは、**変数そのものを消します**
   （createTestEnv の既定は "true" のため、上書きでは「未設定」を作れません）。 */
function envWith(value, bucket){
  const env = createTestEnv(bucket, { ENVIRONMENT: "local" });
  if (value === undefined) delete env.MEDIA_MUTATIONS_ENABLED;
  else env.MEDIA_MUTATIONS_ENABLED = value;
  return env;
}

const deleteRequest = key => new Request(`${ORIGIN}/api/media/item`, {
  method: "DELETE",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ key })
});

const totalCalls = b =>
  b._calls.get.length + b._calls.head.length + b._calls.put.length +
  b._calls.list.length + b._calls.delete.length;

/* ================================================================
   1. 判定そのもの
   ================================================================ */

test("許可されるのは \"true\" の完全一致だけ", () => {
  assert.equal(mutationsEnabled({ MEDIA_MUTATIONS_ENABLED: "true" }), true);
  for (const v of DISABLED_VALUES) {
    assert.equal(mutationsEnabled({ MEDIA_MUTATIONS_ENABLED: v }), false, JSON.stringify(v));
  }
  assert.equal(mutationsEnabled({}), false, "未設定は禁止にしてください");
  assert.equal(mutationsEnabled(null), false);
  assert.equal(mutationsEnabled(undefined), false);
});

test("大文字小文字も空白も吸収しない（うっかり許可されないため）", () => {
  for (const v of ["TRUE", "True", " true ", "true\n"]) {
    assert.equal(mutationsEnabled({ MEDIA_MUTATIONS_ENABLED: v }), false, JSON.stringify(v));
  }
});

/* ================================================================
   2. 止まっているとき ― アップロード
   ================================================================ */

test("止まっているとき、アップロードは 503 で断られる", async () => {
  for (const v of DISABLED_VALUES) {
    const bucket = createMockR2();
    const res = await worker.fetch(makeUploadRequest(), envWith(v, bucket), {});
    assert.equal(res.status, 503, JSON.stringify(v));
    assert.equal((await res.json()).error.code, "MUTATIONS_DISABLED", JSON.stringify(v));
  }
});

test("止まっているとき、アップロードで R2 に1回も触らない", async () => {
  for (const v of DISABLED_VALUES) {
    const bucket = createMockR2();
    await worker.fetch(makeUploadRequest(), envWith(v, bucket), {});
    assert.equal(totalCalls(bucket), 0, `R2 に触れています: ${JSON.stringify(v)}`);
  }
});

test("止まっているときは、R2 のバインディングが無くても同じ返事", async () => {
  /* 判定はバインディングを見るより前。設定の有無で応答が変わらない。 */
  const res = await worker.fetch(makeUploadRequest(),
    { ENVIRONMENT: "local", MEDIA_MUTATIONS_ENABLED: "false" }, {});
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "MUTATIONS_DISABLED");
});

test("止まっていても、メソッドの判定は先に効く", async () => {
  const bucket = createMockR2();
  const res = await worker.fetch(
    new Request(`${ORIGIN}/api/media/upload`), envWith("false", bucket), {});
  assert.equal(res.status, 405, "メソッドの判定より先に止めています");
  assert.equal(res.headers.get("allow"), "POST");
  assert.equal(totalCalls(bucket), 0);
});

/* ================================================================
   3. 止まっているとき ― 削除
   ================================================================ */

test("止まっているとき、削除は 503 で断られる", async () => {
  for (const v of DISABLED_VALUES) {
    const bucket = createMockR2();
    const res = await worker.fetch(deleteRequest(KEY), envWith(v, bucket), {});
    assert.equal(res.status, 503, JSON.stringify(v));
    assert.equal((await res.json()).error.code, "MUTATIONS_DISABLED", JSON.stringify(v));
  }
});

test("止まっているとき、削除で R2 に1回も触らない", async () => {
  for (const v of DISABLED_VALUES) {
    const bucket = createMockR2();
    await bucket.put(KEY, PNG_BYTES, {});          /* 事前に置いておく */
    const before = totalCalls(bucket);
    await worker.fetch(deleteRequest(KEY), envWith(v, bucket), {});
    assert.equal(totalCalls(bucket), before, `R2 に触れています: ${JSON.stringify(v)}`);
    assert.equal(bucket._store.has(KEY), true, "消えています");
  }
});

test("止まっているとき、ゴミ箱にも書き込まれない", async () => {
  const bucket = createMockR2();
  await bucket.put(KEY, PNG_BYTES, {});
  await worker.fetch(deleteRequest(KEY), envWith("false", bucket), {});
  assert.equal(bucket._store.has(`trash/${KEY}`), false, "ゴミ箱に書き込んでいます");
});

/* ================================================================
   3-2. ★ バケットが「実在しても」書けないこと（いちばん大事）

   「バケットが無いから書けない」のではなく、
   「バケットがあってもスイッチが false なら絶対に書けない」ことを固定します。
   R2 をつないだあとに効いてくる保証です。
   ================================================================ */

/* 中身の入った、ちゃんと使えるバケットを用意する */
async function bucketWithContents(){
  const bucket = createMockR2();
  const env = createTestEnv(bucket, { ENVIRONMENT: "local" });  /* 既定は "true" */
  const up = await worker.fetch(makeUploadRequest(), env, {});
  const { key, ok } = await up.json();
  assert.equal(ok, true, "前提となるアップロードに失敗しました");
  return { bucket, key };
}

test("バケットが実在しても、スイッチが false ならアップロードできない", async () => {
  for (const v of DISABLED_VALUES) {
    const { bucket } = await bucketWithContents();
    const before = { ...{}, put: bucket._calls.put.length, head: bucket._calls.head.length,
                     get: bucket._calls.get.length, list: bucket._calls.list.length,
                     del: bucket._calls.delete.length };
    const size = bucket.size;

    const res = await worker.fetch(makeUploadRequest({ fileBytes: PNG_BYTES, fileType: "image/png" }),
      envWith(v, bucket), {});

    assert.equal(res.status, 503, JSON.stringify(v));
    assert.equal((await res.json()).error.code, "MUTATIONS_DISABLED", JSON.stringify(v));
    /* R2 の呼び出しが1つも増えていないこと */
    assert.equal(bucket._calls.put.length, before.put, `put が増えています: ${JSON.stringify(v)}`);
    assert.equal(bucket._calls.head.length, before.head, `head が増えています: ${JSON.stringify(v)}`);
    assert.equal(bucket._calls.get.length, before.get, `get が増えています: ${JSON.stringify(v)}`);
    assert.equal(bucket._calls.list.length, before.list, `list が増えています: ${JSON.stringify(v)}`);
    assert.equal(bucket._calls.delete.length, before.del, `delete が増えています: ${JSON.stringify(v)}`);
    assert.equal(bucket.size, size, `保管庫の中身が変わっています: ${JSON.stringify(v)}`);
  }
});

test("バケットが実在しても、スイッチが false なら削除できない", async () => {
  for (const v of DISABLED_VALUES) {
    const { bucket, key } = await bucketWithContents();
    const before = { put: bucket._calls.put.length, head: bucket._calls.head.length,
                     get: bucket._calls.get.length, list: bucket._calls.list.length,
                     del: bucket._calls.delete.length };

    const res = await worker.fetch(deleteRequest(key), envWith(v, bucket), {});

    assert.equal(res.status, 503, JSON.stringify(v));
    assert.equal((await res.json()).error.code, "MUTATIONS_DISABLED", JSON.stringify(v));
    assert.equal(bucket._calls.put.length, before.put, `put が増えています: ${JSON.stringify(v)}`);
    assert.equal(bucket._calls.head.length, before.head, `head が増えています: ${JSON.stringify(v)}`);
    assert.equal(bucket._calls.get.length, before.get, `get が増えています: ${JSON.stringify(v)}`);
    assert.equal(bucket._calls.list.length, before.list, `list が増えています: ${JSON.stringify(v)}`);
    assert.equal(bucket._calls.delete.length, before.del, `delete が増えています: ${JSON.stringify(v)}`);
    /* 消えていないこと・ゴミ箱にも入っていないこと */
    assert.equal(bucket._store.has(key), true, `消えています: ${JSON.stringify(v)}`);
    assert.equal(bucket._store.has(`trash/${key}`), false, `ゴミ箱に入っています: ${JSON.stringify(v)}`);
  }
});

test("バケットが実在しても、スイッチが false なら中身は1バイトも増えない", async () => {
  const { bucket } = await bucketWithContents();
  const sizeBefore = bucket.size;
  /* 別の画像を10回送ってみる */
  for (let i = 0; i < 10; i++) {
    const bytes = PNG_BYTES.slice();
    bytes[bytes.length - 1] = i;
    const res = await worker.fetch(
      makeUploadRequest({ fileBytes: bytes, fileType: "image/png" }),
      envWith("false", bucket), {});
    assert.equal(res.status, 503);
  }
  assert.equal(bucket.size, sizeBefore, "保管庫の中身が増えています");
});

/* ================================================================
   4. 止まっていても読み出しは使える
   ================================================================ */

test("止まっていても、一覧は使える", async () => {
  const bucket = createMockR2();
  await bucket.put(KEY, PNG_BYTES, {});
  const res = await worker.fetch(new Request(`${ORIGIN}/api/media`), envWith("false", bucket), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.items.length, 1);
});

test("止まっていても、画像の読み出しは使える", async () => {
  const bucket = createMockR2();
  await bucket.put(KEY, PNG_BYTES, {});
  const res = await worker.fetch(new Request(`${ORIGIN}/${KEY}`), envWith("false", bucket), {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
});

test("止まっていても、疎通確認は使える", async () => {
  const res = await worker.fetch(
    new Request(`${ORIGIN}/api/health`), envWith("false", createMockR2()), {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test("実データの入ったバケットでも、読み出しは止まらない", async () => {
  const { bucket, key } = await bucketWithContents();
  const env = envWith("false", bucket);

  /* 一覧 */
  const list = await worker.fetch(new Request(`${ORIGIN}/api/media`), env, {});
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.equal(body.items.some(i => i.key === key), true, "一覧に出ません");

  /* 画像そのもの */
  const img = await worker.fetch(new Request(`${ORIGIN}/${key}`), env, {});
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/jpeg");

  /* HEAD */
  const head = await worker.fetch(new Request(`${ORIGIN}/${key}`, { method: "HEAD" }), env, {});
  assert.equal(head.status, 200);

  /* 読み出しでは書き込みも削除も起きない */
  const putsBefore = bucket._calls.put.length;
  assert.equal(bucket._calls.delete.length, 0);
  assert.equal(bucket._calls.put.length, putsBefore);
});

/* ================================================================
   5. 許可されているときは、これまでどおり動く
   ================================================================ */

test("\"true\" のときはアップロードできる", async () => {
  const bucket = createMockR2();
  const res = await worker.fetch(makeUploadRequest(), envWith("true", bucket), {});
  assert.equal(res.status, 201);
  assert.equal((await res.json()).ok, true);
  assert.equal(bucket._calls.put.length, 1);
});

test("\"true\" のときは削除できる（ゴミ箱にも入る）", async () => {
  const bucket = createMockR2();
  const env = envWith("true", bucket);
  const up = await worker.fetch(makeUploadRequest(), env, {});
  const { key } = await up.json();

  const res = await worker.fetch(deleteRequest(key), env, {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).trashed, true);
  assert.equal(bucket._store.has(key), false);
  assert.equal(bucket._store.has(`trash/${key}`), true);
});

/* ================================================================
   6. 認証の門番が先（認証前に停止スイッチや R2 へ進まない）
   ================================================================ */

test("認証されていなければ、停止スイッチの状態に関わらず 403", async () => {
  /* ステージング相当（門番が働く）＋ 通行証なし */
  for (const v of ["true", "false", undefined]) {
    const bucket = createMockR2();
    const extra = v === undefined ? {} : { MEDIA_MUTATIONS_ENABLED: v };
    const env = {
      ENVIRONMENT: "staging", STAGING_LOCKED: "false",
      ACCESS_TEAM_DOMAIN: "example-team.cloudflareaccess.com",
      ACCESS_AUD: "0123456789abcdef",
      ALLOWED_EMAIL: "someone@example.invalid",
      MEDIA_BUCKET: bucket,
      ASSETS: { fetch: async () => new Response("static asset") },
      ...extra
    };
    const res = await worker.fetch(makeUploadRequest(), env, {});
    assert.equal(res.status, 403, JSON.stringify(v));
    assert.equal((await res.json()).error.code, "FORBIDDEN", JSON.stringify(v));
    assert.equal(totalCalls(bucket), 0, "認証前に R2 へ触れています");
  }
});

test("ロック中は、停止スイッチが \"true\" でも通らない", async () => {
  const bucket = createMockR2();
  const env = {
    ENVIRONMENT: "staging", STAGING_LOCKED: "true",
    MEDIA_MUTATIONS_ENABLED: "true",
    MEDIA_BUCKET: bucket,
    ASSETS: { fetch: async () => new Response("static asset") }
  };
  const res = await worker.fetch(makeUploadRequest(), env, {});
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, "FORBIDDEN");
  assert.equal(totalCalls(bucket), 0);
});

test("断り方で、停止スイッチの状態が分からない", async () => {
  /* 認証されていないときは、スイッチが on でも off でも同じ返事 */
  const mk = v => ({
    ENVIRONMENT: "staging", STAGING_LOCKED: "false",
    ACCESS_TEAM_DOMAIN: "example-team.cloudflareaccess.com",
    ACCESS_AUD: "0123456789abcdef",
    ALLOWED_EMAIL: "someone@example.invalid",
    MEDIA_MUTATIONS_ENABLED: v,
    MEDIA_BUCKET: createMockR2(),
    ASSETS: { fetch: async () => new Response("static asset") }
  });
  const a = await worker.fetch(makeUploadRequest(), mk("true"), {});
  const b = await worker.fetch(makeUploadRequest(), mk("false"), {});
  assert.equal(a.status, b.status);
  assert.equal(await a.text(), await b.text());
});
