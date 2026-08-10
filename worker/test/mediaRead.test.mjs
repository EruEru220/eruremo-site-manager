/* ================================================================
   GET /media/… （保存した画像の読み出し）のテスト

   本物の R2 にも Cloudflare にも接続しません。
   偽バケット（メモリ上の Map）だけを使います。
   ================================================================ */
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createMockR2, createTestEnv } from "./helpers/mockR2.mjs";
import { makeUploadRequest, PNG_BYTES, JPEG_BYTES, WEBP_BYTES } from "./helpers/fixtures.mjs";

const ORIGIN = "http://localhost:8787";

/* 実際にアップロードしてから、その画像を読み出す（本物の流れをなぞる） */
async function uploadThenRead(opts = {}){
  const bucket = createMockR2();
  const env = createTestEnv(bucket, { PUBLIC_MEDIA_BASE_URL: ORIGIN });
  const up = await worker.fetch(makeUploadRequest(opts), env, {});
  const body = await up.json();
  assert.equal(body.ok, true, "前提となるアップロードに失敗しました");
  const res = await worker.fetch(new Request(body.url), env, {});
  return { bucket, env, key: body.key, url: body.url, res };
}

test("アップロードした画像を、返された URL でそのまま読み出せる", async () => {
  const { res, url } = await uploadThenRead({ fileBytes: PNG_BYTES, fileType: "image/png" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.ok(url.startsWith(ORIGIN + "/media/"), `URL の形が想定と違います: ${url}`);
  const got = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual(got, PNG_BYTES, "保存した中身と読み出した中身が一致しません");
});

test("JPEG・WebP も正しい Content-Type で返る", async () => {
  const jpeg = await uploadThenRead({ fileBytes: JPEG_BYTES, fileType: "image/jpeg" });
  assert.equal(jpeg.res.headers.get("content-type"), "image/jpeg");
  const webp = await uploadThenRead({ fileBytes: WEBP_BYTES, fileType: "image/webp" });
  assert.equal(webp.res.headers.get("content-type"), "image/webp");
});

test("画像には長期キャッシュと nosniff が付く", async () => {
  const { res } = await uploadThenRead();
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("HEAD は中身を読まずにヘッダだけ返す", async () => {
  const bucket = createMockR2();
  const env = createTestEnv(bucket, { PUBLIC_MEDIA_BASE_URL: ORIGIN });
  const up = await worker.fetch(makeUploadRequest(), env, {});
  const { url } = await up.json();

  const before = bucket._calls.get.length;
  const res = await worker.fetch(new Request(url, { method: "HEAD" }), env, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.equal(await res.text(), "");
  assert.equal(bucket._calls.get.length, before, "HEAD なのに中身を読み出しています");
});

test("Content-Type は保存時の申告ではなく、キーの拡張子から決める", async () => {
  /* R2 に text/html という申告が入っていても、返るのは image/png */
  const bucket = createMockR2();
  const env = createTestEnv(bucket, { PUBLIC_MEDIA_BASE_URL: ORIGIN });
  const key = "media/gallery/2026/08/0123456789abcdef.png";
  await bucket.put(key, PNG_BYTES, { httpMetadata: { contentType: "text/html" } });

  const res = await worker.fetch(new Request(`${ORIGIN}/${key}`), env, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
});

test("存在しないキーは 404", async () => {
  const env = createTestEnv(createMockR2());
  const res = await worker.fetch(
    new Request(`${ORIGIN}/media/gallery/2026/08/0123456789abcdef.png`), env, {});
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, "NOT_FOUND");
});

test("形が正しくないキーは、R2 に触れる前に 404 で拒否する", async () => {
  const bucket = createMockR2();
  const env = createTestEnv(bucket);
  const bad = [
    "/media",                                            /* キーが無い */
    "/media/",                                           /* 同上 */
    "/media/gallery/2026/08/",                           /* ファイル名が無い */
    "/media/unknown/2026/08/0123456789abcdef.png",       /* 許可されていない category */
    "/media/gallery/2026/08/0123456789abcdef.gif",       /* 許可されていない拡張子 */
    "/media/gallery/2026/08/0123456789abcdef.svg",       /* SVG は読み出しでも拒否 */
    "/media/gallery/2026/08/0123456789ABCDEF.png",       /* 大文字のハッシュ */
    "/media/gallery/2026/08/0123456789abcde.png",        /* ハッシュが15桁 */
    "/media/gallery/2026/08/0123456789abcdef0.png",      /* ハッシュが17桁 */
    "/media/gallery/26/08/0123456789abcdef.png",         /* 年が2桁 */
    "/media/gallery/2026/8/0123456789abcdef.png",        /* 月が1桁 */
    "/media/gallery/2026/08/sub/0123456789abcdef.png",   /* 階層が多い */
    "/media/0123456789abcdef.png",                       /* 階層が足りない */
    "/media/gallery/2026/08/%2e%2e%2f0123456789abcdef.png", /* パーセント符号化 */
    "/media/gallery/2026/08/0123456789abcdef.png%00.txt"    /* ヌル文字の細工 */
  ];
  for (const path of bad) {
    const res = await worker.fetch(new Request(ORIGIN + path), env, {});
    assert.equal(res.status, 404, `拒否されていません: ${path}`);
    assert.equal((await res.json()).error.code, "NOT_FOUND", path);
  }
  assert.equal(bucket._calls.get.length, 0, "不正なキーで R2 を読みに行っています");
  assert.equal(bucket._calls.head.length, 0, "不正なキーで R2 を見に行っています");
});

test("../ を含む住所で、他の場所のファイルを取り出せない", async () => {
  const bucket = createMockR2();
  const env = createTestEnv(bucket);
  await bucket.put("secret.txt", new TextEncoder().encode("ひみつ"), {});

  for (const path of [
    "/media/../secret.txt",
    "/media/gallery/../../secret.txt",
    "/media/gallery/2026/08/../../../../secret.txt"
  ]) {
    const res = await worker.fetch(new Request(ORIGIN + path), env, {});
    const text = await res.text();
    assert.equal(text.includes("ひみつ"), false, `別の場所が読めています: ${path}`);
  }
  assert.equal(bucket._calls.get.length, 0);
});

test("読み出しでは、書き込みも削除も起きない", async () => {
  const { bucket } = await uploadThenRead();
  const putsAfterUpload = bucket._calls.put.length;
  await worker.fetch(new Request(`${ORIGIN}/media/gallery/2026/08/0123456789abcdef.png`),
    createTestEnv(bucket), {});
  assert.equal(bucket._calls.put.length, putsAfterUpload);
  assert.equal(bucket._calls.delete.length, 0);
});

test("GET / HEAD 以外のメソッドは 405", async () => {
  const bucket = createMockR2();
  const env = createTestEnv(bucket);
  const url = `${ORIGIN}/media/gallery/2026/08/0123456789abcdef.png`;
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const res = await worker.fetch(new Request(url, { method }), env, {});
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get("allow"), "GET, HEAD");
    assert.equal((await res.json()).error.code, "METHOD_NOT_ALLOWED");
  }
  assert.equal(bucket._calls.delete.length, 0, "DELETE が R2 に届いています");
});

test("R2 の読み出しが失敗したら 500（内部情報は出さない）", async () => {
  const bucket = createMockR2();
  bucket.get = async () => { throw new Error("mock failure: bucket=secret-bucket-name"); };
  const res = await worker.fetch(
    new Request(`${ORIGIN}/media/gallery/2026/08/0123456789abcdef.png`),
    createTestEnv(bucket), {});
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.equal(JSON.parse(text).error.code, "R2_ERROR");
  for (const leak of ["secret-bucket-name", "your-media-local", "mock failure", "Error", "at "]) {
    assert.equal(text.includes(leak), false, `内部情報が漏れています: ${leak}`);
  }
});

test("R2 のバインディングが無ければ 500（黙って別のものを返さない）", async () => {
  const res = await worker.fetch(
    new Request(`${ORIGIN}/media/gallery/2026/08/0123456789abcdef.png`),
    { ENVIRONMENT: "local" }, {});
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error.code, "R2_ERROR");
});

test("/media で始まらない似た名前のパスは、静的ファイル扱いのまま", async () => {
  const env = createTestEnv(createMockR2());
  for (const path of ["/mediation", "/media-list", "/public/media/x.png"]) {
    const res = await worker.fetch(new Request(ORIGIN + path), env, {});
    assert.equal(await res.text(), "static asset", path);
  }
});

test("読み出しの応答に内部情報が入らない", async () => {
  const { res } = await uploadThenRead();
  const joined = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
  for (const leak of ["your-media-local", "MEDIA_BUCKET", "wrangler", "miniflare"]) {
    assert.equal(joined.includes(leak), false, `ヘッダに内部情報が漏れています: ${leak}`);
  }
  assert.equal(/[A-Za-z]:\\/.test(joined), false, "Windows の絶対パスが漏れています");
});
