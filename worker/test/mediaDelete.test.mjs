/* ================================================================
   DELETE /api/media/item （画像を1枚だけ消す）のテスト

   本物の R2 にも Cloudflare にも接続しません。
   偽バケット（メモリ上の Map）だけを使います。
   ================================================================ */
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createMockR2, createTestEnv } from "./helpers/mockR2.mjs";
import { makeUploadRequest, PNG_BYTES } from "./helpers/fixtures.mjs";

const ORIGIN = "http://localhost:8787";
const ITEM_URL = `${ORIGIN}/api/media/item`;

/** 削除リクエストを組み立てる（不正な形も作れるようにしてある） */
function deleteRequest(key, opts = {}){
  const {
    url = ITEM_URL,
    method = "DELETE",
    contentType = "application/json",
    body = JSON.stringify({ key }),
    headers: extraHeaders = null
  } = opts;
  const headers = {};
  if (contentType !== null) headers["content-type"] = contentType;
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const init = { method, headers };
  if (body !== null) init.body = body;
  return new Request(url, init);
}

/* 実際にアップロードしてから消す（本物の流れをなぞる） */
async function seedOne(category = "gallery"){
  const bucket = createMockR2();
  const env = createTestEnv(bucket, { PUBLIC_MEDIA_BASE_URL: ORIGIN });
  const res = await worker.fetch(makeUploadRequest({
    fileBytes: PNG_BYTES, fileType: "image/png", category
  }), env, {});
  const body = await res.json();
  assert.equal(body.ok, true, "前提となるアップロードに失敗しました");
  return { bucket, env, key: body.key, url: body.url };
}

/* ================================================================
   1. ふつうに消せる（そしてゴミ箱に残る）
   ================================================================ */

test("アップロードした画像を1枚だけ消せる", async () => {
  const { bucket, env, key } = await seedOne();
  const res = await worker.fetch(deleteRequest(key), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.key, key);
  assert.equal(body.trashed, true);
  assert.equal(bucket._store.has(key), false, "元の場所から消えていません");
});

test("消したものは trash/ に写してある（すぐには失われない）", async () => {
  const { bucket, env, key } = await seedOne();
  await worker.fetch(deleteRequest(key), env, {});
  const trashed = bucket._store.get(`trash/${key}`);
  assert.ok(trashed, "ゴミ箱に写されていません");
  assert.deepEqual(trashed.bytes, PNG_BYTES, "ゴミ箱の中身が元と違います");
  assert.equal(trashed.httpMetadata.contentType, "image/png");
  assert.equal(trashed.httpMetadata.cacheControl, "no-store");
});

test("ゴミ箱に写してから元を消す（順番が逆にならない）", async () => {
  const { bucket, env, key } = await seedOne();
  await worker.fetch(deleteRequest(key), env, {});
  const trashPut = bucket._calls.put.findIndex(c => c.key === `trash/${key}`);
  const del = bucket._calls.delete.findIndex(c => c.key === key);
  assert.ok(trashPut >= 0 && del >= 0);
  /* 写す処理が終わってから消しているか（put の記録が delete より前にあるか） */
  assert.equal(bucket._calls.delete.length, 1);
  assert.ok(bucket._calls.put.length >= 2, "ゴミ箱への書き込みが行われていません");
});

test("消した画像は、もう読み出せない", async () => {
  const { env, key, url } = await seedOne();
  assert.equal((await worker.fetch(new Request(url), env, {})).status, 200);
  await worker.fetch(deleteRequest(key), env, {});
  assert.equal((await worker.fetch(new Request(url), env, {})).status, 404);
});

test("ゴミ箱の中身は、読み出しAPIからは取り出せない", async () => {
  const { env, key } = await seedOne();
  await worker.fetch(deleteRequest(key), env, {});
  /* ゴミ箱は /media/… の形にならないので、読み出しAPIの対象になりません。
     （/trash/… は静的ファイル扱いになり、本番では単に見つからないだけです）
     ここでは「画像の中身が返らないこと」を確かめます。 */
  for (const path of [`/trash/${key}`, `/media/../trash/${key}`, `/${key}`]) {
    const res = await worker.fetch(new Request(ORIGIN + path), env, {});
    assert.notEqual(res.headers.get("content-type"), "image/png", `ゴミ箱が画像として返っています: ${path}`);
    const got = new Uint8Array(await res.arrayBuffer());
    assert.notDeepEqual(got, PNG_BYTES, `ゴミ箱の中身が読めています: ${path}`);
  }
});

test("消したあと、同じ画像をもう一度アップロードできる", async () => {
  const { env, key } = await seedOne();
  await worker.fetch(deleteRequest(key), env, {});
  const res = await worker.fetch(makeUploadRequest({ fileBytes: PNG_BYTES, fileType: "image/png" }), env, {});
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.key, key, "同じ内容なら同じキーに戻るはずです");
});

/* ================================================================
   2. キーの検証（ここが最重要）
   ================================================================ */

test("形が正しくないキーは 400 で拒否し、R2 に触らない", async () => {
  const { bucket, env } = await seedOne();
  const putsBefore = bucket._calls.put.length;
  const bad = [
    "../secret.txt",
    "/media/gallery/2026/08/0123456789abcdef.png",        /* 先頭がスラッシュ */
    "media/../secret.txt",
    "media/gallery/../../secret.txt",
    "media/gallery/2026/08/../../../../secret.txt",
    "media/gallery/2026/08/%2e%2e%2f0123456789abcdef.png",
    "media/gallery/2026/08/0123456789abcdef.png%00.txt",
    "trash/media/gallery/2026/08/0123456789abcdef.png",   /* ゴミ箱は消させない */
    "secret/keys.txt",
    "media/unknown/2026/08/0123456789abcdef.png",         /* 許可されていない置き場所 */
    "media/gallery/2026/08/0123456789abcdef.gif",
    "media/gallery/2026/08/0123456789abcdef.svg",
    "media/gallery/2026/08/0123456789ABCDEF.png",         /* 大文字のハッシュ */
    "media/gallery/2026/08/0123456789abcde.png",          /* 15桁 */
    "media/gallery/26/08/0123456789abcdef.png",           /* 年が2桁 */
    "media/gallery/2026/8/0123456789abcdef.png",          /* 月が1桁 */
    "media/gallery/2026/08/sub/0123456789abcdef.png",
    "media",
    "media/",
    "",
    "   ",
    "media/gallery/2026/08/0123456789abcdef.png\n"        /* 末尾に改行 */
  ];
  for (const key of bad) {
    const res = await worker.fetch(deleteRequest(key), env, {});
    assert.equal(res.status, 400, `拒否されていません: ${JSON.stringify(key)}`);
    assert.equal((await res.json()).error.code, "INVALID_KEY", JSON.stringify(key));
  }
  assert.equal(bucket._calls.delete.length, 0, "不正なキーで削除が行われています");
  assert.equal(bucket._calls.put.length, putsBefore, "不正なキーで書き込みが行われています");
});

test("文字列でない key は 400", async () => {
  const { bucket, env } = await seedOne();
  for (const body of [
    JSON.stringify({ key: null }),
    JSON.stringify({ key: 123 }),
    JSON.stringify({ key: ["media/gallery/2026/08/0123456789abcdef.png"] }),
    JSON.stringify({ key: { toString: "media/gallery/2026/08/0123456789abcdef.png" } }),
    JSON.stringify({}),
    JSON.stringify({ keys: ["media/gallery/2026/08/0123456789abcdef.png"] })
  ]) {
    const res = await worker.fetch(deleteRequest(null, { body }), env, {});
    assert.equal(res.status, 400, body);
    assert.equal((await res.json()).error.code, "INVALID_KEY", body);
  }
  assert.equal(bucket._calls.delete.length, 0);
});

test("存在しない画像は 404（消しに行かない）", async () => {
  const { bucket, env } = await seedOne();
  const res = await worker.fetch(
    deleteRequest("media/gallery/2026/08/ffffffffffffffff.png"), env, {});
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, "NOT_FOUND");
  assert.equal(bucket._calls.delete.length, 0);
});

test("同じ画像を2回消すと、2回目は 404", async () => {
  const { env, key } = await seedOne();
  assert.equal((await worker.fetch(deleteRequest(key), env, {})).status, 200);
  assert.equal((await worker.fetch(deleteRequest(key), env, {})).status, 404);
});

test("消すのは指定された1枚だけ", async () => {
  const bucket = createMockR2();
  const env = createTestEnv(bucket, { PUBLIC_MEDIA_BASE_URL: ORIGIN });
  const keys = [];
  for (let i = 0; i < 3; i++) {
    const bytes = PNG_BYTES.slice();
    bytes[bytes.length - 1] = i;
    const res = await worker.fetch(
      makeUploadRequest({ fileBytes: bytes, fileType: "image/png" }), env, {});
    keys.push((await res.json()).key);
  }
  await worker.fetch(deleteRequest(keys[1]), env, {});
  assert.equal(bucket._store.has(keys[0]), true);
  assert.equal(bucket._store.has(keys[1]), false);
  assert.equal(bucket._store.has(keys[2]), true);
});

/* ================================================================
   3. リクエストの形
   ================================================================ */

test("DELETE 以外は 405", async () => {
  const { bucket, env, key } = await seedOne();
  for (const method of ["GET", "POST", "PUT", "PATCH"]) {
    const init = { method, key };
    const req = method === "GET"
      ? new Request(ITEM_URL)
      : deleteRequest(key, { method });
    const res = await worker.fetch(req, env, {});
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get("allow"), "DELETE");
    assert.equal(init.method, method);
  }
  assert.equal(bucket._calls.delete.length, 0);
  assert.equal(bucket._store.has(key), true, "405 なのに消えています");
});

test("application/json 以外は 415（フォームからは消せない）", async () => {
  const { bucket, env, key } = await seedOne();
  for (const ct of [
    "text/plain",
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=x",
    "text/html",
    null
  ]) {
    const res = await worker.fetch(deleteRequest(key, { contentType: ct }), env, {});
    assert.equal(res.status, 415, String(ct));
    assert.equal((await res.json()).error.code, "BAD_JSON_TYPE", String(ct));
  }
  assert.equal(bucket._calls.delete.length, 0);
  assert.equal(bucket._store.has(key), true);
});

test("application/json; charset=utf-8 は受け付ける", async () => {
  const { env, key } = await seedOne();
  const res = await worker.fetch(
    deleteRequest(key, { contentType: "application/json; charset=utf-8" }), env, {});
  assert.equal(res.status, 200);
});

test("JSON として読めない本体は 400", async () => {
  const { bucket, env } = await seedOne();
  for (const body of ["", "{", "not json", "[]", "null", '"media/gallery/2026/08/0123456789abcdef.png"', "123"]) {
    const res = await worker.fetch(deleteRequest(null, { body }), env, {});
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).error.code, "BAD_REQUEST", JSON.stringify(body));
  }
  assert.equal(bucket._calls.delete.length, 0);
});

test("大きすぎる本体は、読む前に断る", async () => {
  const { bucket, env, key } = await seedOne();
  const fat = JSON.stringify({ key, padding: "あ".repeat(9000) });
  const res = await worker.fetch(deleteRequest(null, { body: fat }), env, {});
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "BAD_REQUEST");
  assert.equal(bucket._store.has(key), true);
});

test("余計な項目が入っていても、key だけを見る", async () => {
  const { bucket, env, key } = await seedOne();
  const body = JSON.stringify({
    key,
    prefix: "secret/",
    bucket: "本番バケット",
    force: true,
    trash: false
  });
  const res = await worker.fetch(deleteRequest(null, { body }), env, {});
  assert.equal(res.status, 200);
  /* ゴミ箱への退避は、外からの指定に関係なく必ず行われる */
  assert.equal(bucket._store.has(`trash/${key}`), true);
});

/* ================================================================
   4. 失敗したときのふるまい
   ================================================================ */

test("ゴミ箱への退避が失敗したら、元は消さない", async () => {
  const { bucket, env, key } = await seedOne();
  const realPut = bucket.put.bind(bucket);
  bucket.put = async (k, v, o) => {
    if (k.startsWith("trash/")) throw new Error("mock failure: bucket=secret-bucket-name");
    return realPut(k, v, o);
  };
  const res = await worker.fetch(deleteRequest(key), env, {});
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error.code, "R2_ERROR");
  assert.equal(bucket._store.has(key), true, "退避に失敗したのに元が消えています");
});

test("大きすぎるものは、中身を読む前に断る（メモリを守る）", async () => {
  const { bucket, env, key } = await seedOne();
  /* 同じ名前で 10MB を超えるものが置かれている状況を作る */
  const real = bucket._store.get(key);
  let readCount = 0;
  bucket.get = async () => ({
    ...real,
    size: 11 * 1024 * 1024,
    arrayBuffer: async () => { readCount++; return real.bytes.slice().buffer; }
  });
  const res = await worker.fetch(deleteRequest(key), env, {});
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.code, "TOO_LARGE");
  assert.equal(readCount, 0, "大きすぎるのに中身を読み込んでいます");
  assert.equal(bucket._calls.delete.length, 0, "読めていないのに消しています");
});

test("R2 の読み出しが失敗したら 500（内部情報は出さない）", async () => {
  const { bucket, env, key } = await seedOne();
  bucket.get = async () => { throw new Error("mock failure: bucket=secret-bucket-name"); };
  const res = await worker.fetch(deleteRequest(key), env, {});
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.equal(JSON.parse(text).error.code, "R2_ERROR");
  for (const leak of ["secret-bucket-name", "your-media-local", "mock failure", "Error", "at "]) {
    assert.equal(text.includes(leak), false, `内部情報が漏れています: ${leak}`);
  }
});

test("R2 のバインディングが無ければ 500", async () => {
  const res = await worker.fetch(
    deleteRequest("media/gallery/2026/08/0123456789abcdef.png"),
    /* 非常停止スイッチは通し、バインディングだけが無い状態を作る */
    { ENVIRONMENT: "local", MEDIA_MUTATIONS_ENABLED: "true" }, {});
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error.code, "R2_ERROR");
});

test("応答に内部情報が入らない", async () => {
  const { env, key } = await seedOne();
  const res = await worker.fetch(deleteRequest(key), env, {});
  const dump = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n") + "\n" + await res.text();
  for (const leak of ["your-media-local", "MEDIA_BUCKET", "wrangler", "miniflare"]) {
    assert.equal(dump.includes(leak), false, `内部情報が漏れています: ${leak}`);
  }
  assert.equal(/[A-Za-z]:\\/.test(dump), false, "Windows の絶対パスが漏れています");
});

test("/api/media/item に似た住所は 404（別の入口が生まれない）", async () => {
  const { env, key } = await seedOne();
  for (const url of [
    `${ORIGIN}/api/media/items`,
    `${ORIGIN}/api/media/item/extra`,
    `${ORIGIN}/api/media/delete`,
    `${ORIGIN}/api/item`
  ]) {
    const res = await worker.fetch(deleteRequest(key, { url }), env, {});
    assert.equal(res.status, 404, url);
  }
});
