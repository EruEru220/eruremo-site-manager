/* ================================================================
   GET /api/media （保管庫の画像一覧）のテスト

   本物の R2 にも Cloudflare にも接続しません。
   偽バケット（メモリ上の Map）だけを使います。
   ================================================================ */
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createMockR2, createTestEnv } from "./helpers/mockR2.mjs";
import { makeUploadRequest, PNG_BYTES, JPEG_BYTES, WEBP_BYTES } from "./helpers/fixtures.mjs";
import { CURSOR_MAX_LENGTH } from "../src/lib/mediaList.js";

const ORIGIN = "http://localhost:8787";

const listUrl = (query = "") => `${ORIGIN}/api/media${query}`;

/* 中身の違う画像を作る（同じ内容だと同じキーになって1件にまとまるため） */
function variant(base, n){
  const out = base.slice();
  out[out.length - 1] = n & 0xFF;
  out[out.length - 2] = (n >> 8) & 0xFF;
  return out;
}

/* 実際にアップロードしてから一覧を引く（本物の流れをなぞる） */
async function seed(count = 3, category = "gallery"){
  const bucket = createMockR2();
  const env = createTestEnv(bucket, { PUBLIC_MEDIA_BASE_URL: ORIGIN });
  const keys = [];
  for (let i = 0; i < count; i++) {
    const res = await worker.fetch(makeUploadRequest({
      fileBytes: variant(PNG_BYTES, i), fileType: "image/png", category
    }), env, {});
    const body = await res.json();
    assert.equal(body.ok, true, "前提となるアップロードに失敗しました");
    keys.push(body.key);
  }
  return { bucket, env, keys };
}

async function getList(env, query = ""){
  const res = await worker.fetch(new Request(listUrl(query)), env, {});
  return { res, body: await res.json() };
}

/* ================================================================
   1. ふつうに一覧が取れる
   ================================================================ */

test("アップロードした画像が一覧に出る", async () => {
  const { env, keys } = await seed(3);
  const { res, body } = await getList(env);
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.items.length, 3);
  assert.deepEqual(body.items.map(i => i.key).sort(), [...keys].sort());
});

test("1件ずつの中身は、キー・URL・置き場所・大きさ・日時", async () => {
  const { env } = await seed(1, "cast");
  const { body } = await getList(env);
  const item = body.items[0];
  assert.match(item.key, /^media\/cast\/\d{4}\/\d{2}\/[a-f0-9]{16}\.png$/);
  assert.equal(item.url, `${ORIGIN}/${item.key}`);
  assert.equal(item.category, "cast");
  assert.equal(item.size, PNG_BYTES.byteLength);
  assert.match(item.uploaded, /^\d{4}-\d{2}-\d{2}T/);
});

test("返された URL で、その画像をそのまま読み出せる", async () => {
  const { env } = await seed(1);
  const { body } = await getList(env);
  const res = await worker.fetch(new Request(body.items[0].url), env, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
});

test("保管庫が空なら、空の一覧を返す（エラーにしない）", async () => {
  const { body, res } = await getList(createTestEnv(createMockR2()));
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.items, []);
  assert.equal(body.truncated, false);
});

test("画像そのもの（バイト列）は一覧に含めない", async () => {
  const { env } = await seed(2);
  const res = await worker.fetch(new Request(listUrl()), env, {});
  const text = await res.text();
  assert.equal(text.includes("bytes"), false, "画像の中身が一覧に混ざっています");
  assert.equal(text.includes("\uFFFD"), false);
});

/* ================================================================
   2. 見に行く範囲（prefix）は Worker が固定する
   ================================================================ */

test("見に行くのは media/ の中だけ", async () => {
  const { bucket, env } = await seed(1);
  await getList(env);
  assert.equal(bucket._calls.list.length, 1);
  assert.equal(bucket._calls.list[0].options.prefix, "media/");
});

test("prefix を外から指定しても無視される", async () => {
  const { bucket, env } = await seed(1);
  await bucket.put("secret/keys.txt", new TextEncoder().encode("ひみつ"), {});
  const { body } = await getList(env, "?prefix=secret/");
  assert.equal(bucket._calls.list[0].options.prefix, "media/");
  assert.equal(JSON.stringify(body).includes("secret"), false);
});

test("ゴミ箱（trash/）の中身は一覧に出ない", async () => {
  const { bucket, env, keys } = await seed(2);
  /* 1枚を削除して trash/ へ移す */
  await worker.fetch(deleteRequest(keys[0]), env, {});
  const { body } = await getList(env);
  assert.equal(body.items.length, 1);
  assert.equal(JSON.stringify(body).includes("trash/"), false);
  assert.equal(bucket._store.has(`trash/${keys[0]}`), true, "ゴミ箱に残っていません");
});

test("形が正しくないキーは、一覧から取り除く", async () => {
  const bucket = createMockR2();
  const env = createTestEnv(bucket, { PUBLIC_MEDIA_BASE_URL: ORIGIN });
  const good = "media/gallery/2026/08/0123456789abcdef.png";
  await bucket.put(good, PNG_BYTES, {});
  for (const bad of [
    "media/unknown/2026/08/0123456789abcdef.png",  /* 許可されていない置き場所 */
    "media/gallery/2026/08/0123456789abcdef.gif",  /* 許可されていない拡張子 */
    "media/gallery/2026/08/0123456789abcdef.svg",  /* SVG */
    "media/gallery/2026/08/ABCDEF0123456789.png",  /* 大文字のハッシュ */
    "media/gallery/2026/08/sub/0123456789abcdef.png",
    "media/0123456789abcdef.png",
    "media/gallery/2026/08/index.html"
  ]) {
    await bucket.put(bad, PNG_BYTES, {});
  }
  const { body } = await getList(env);
  assert.deepEqual(body.items.map(i => i.key), [good]);
});

/* ================================================================
   3. 続きの読み込み（ページング）
   ================================================================ */

test("limit で件数を絞れて、続きがあることが分かる", async () => {
  const { env } = await seed(5);
  const { body } = await getList(env, "?limit=2");
  assert.equal(body.items.length, 2);
  assert.equal(body.truncated, true);
  assert.equal(typeof body.cursor, "string");
});

test("cursor で続きを読むと、全部を重複なく取り切れる", async () => {
  const { env, keys } = await seed(5);
  const seen = [];
  let cursor = null, guard = 0;
  do {
    const q = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : "?limit=2";
    const { body } = await getList(env, q);
    body.items.forEach(i => seen.push(i.key));
    cursor = body.truncated ? body.cursor : null;
  } while (cursor && ++guard < 10);
  assert.deepEqual(seen.sort(), [...keys].sort());
  assert.equal(new Set(seen).size, 5, "同じ画像が二重に出ています");
});

test("最後のページには続きの目印を付けない", async () => {
  const { env } = await seed(2);
  const { body } = await getList(env, "?limit=50");
  assert.equal(body.truncated, false);
  assert.equal("cursor" in body, false);
});

test("おかしな limit は 400 で断る（勝手に直さない）", async () => {
  const { bucket, env } = await seed(1);
  const before = bucket._calls.list.length;
  for (const q of ["?limit=0", "?limit=101", "?limit=-1", "?limit=abc", "?limit=1.5", "?limit=9999"]) {
    const { res, body } = await getList(env, q);
    assert.equal(res.status, 400, `断られていません: ${q}`);
    assert.equal(body.error.code, "BAD_LIST_OPTION", q);
  }
  assert.equal(bucket._calls.list.length, before, "おかしな指定で R2 を見に行っています");
});

test("長すぎる cursor・制御文字入りの cursor は 400 で断る", async () => {
  const { bucket, env } = await seed(1);
  const before = bucket._calls.list.length;
  for (const q of [
    "?cursor=" + "x".repeat(CURSOR_MAX_LENGTH + 1),
    "?cursor=a b",
    "?cursor=%00",
    "?cursor=%0A",
    "?cursor=" + encodeURIComponent("a\tb")
  ]) {
    const { res, body } = await getList(env, q);
    assert.equal(res.status, 400, `断られていません: ${q}`);
    assert.equal(body.error.code, "BAD_LIST_OPTION", q);
  }
  assert.equal(bucket._calls.list.length, before, "おかしな cursor で R2 を見に行っています");
});

test("cursor の中身の形は決めつけない（R2 が返した文字列をそのまま通す）", async () => {
  /* R2 の cursor は「不透明な文字列」。base64 以外の形でも、そのまま渡せること。 */
  const bucket = createMockR2();
  const env = createTestEnv(bucket, { PUBLIC_MEDIA_BASE_URL: ORIGIN });
  const odd = "v2:eyJrIjoi~abc!*()._";
  bucket.list = async (options) => {
    assert.equal(options.cursor, odd, "cursor が書き換えられています");
    return { objects: [], truncated: false };
  };
  const { res } = await getList(env, "?cursor=" + encodeURIComponent(odd));
  assert.equal(res.status, 200);
});

test("R2 が返した cursor は、そのまま次の要求に使える", async () => {
  const bucket = createMockR2();
  const env = createTestEnv(bucket, { PUBLIC_MEDIA_BASE_URL: ORIGIN });
  const odd = "v2:eyJrIjoi~abc!*()._";
  let seen = null;
  bucket.list = async (options) => {
    seen = options.cursor || null;
    return seen ? { objects: [], truncated: false }
                : { objects: [], truncated: true, cursor: odd };
  };
  const first = await getList(env);
  assert.equal(first.body.cursor, odd, "R2 の cursor が返されていません");
  const second = await getList(env, "?cursor=" + encodeURIComponent(first.body.cursor));
  assert.equal(second.res.status, 200, "自分が返した cursor を自分で拒否しています");
  assert.equal(seen, odd);
});

test("R2 が受け取れない形の cursor を返してきたら、続きの目印は返さない", async () => {
  const bucket = createMockR2();
  const env = createTestEnv(bucket, { PUBLIC_MEDIA_BASE_URL: ORIGIN });
  bucket.list = async () => ({ objects: [], truncated: true, cursor: "a b\nc" });
  const { res, body } = await getList(env);
  assert.equal(res.status, 200);
  assert.equal(body.truncated, true);
  assert.equal("cursor" in body, false, "使えない cursor を返しています");
});

/* ================================================================
   4. メソッドと失敗時のふるまい
   ================================================================ */

test("GET 以外は 405", async () => {
  const { bucket, env } = await seed(1);
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const res = await worker.fetch(new Request(listUrl(), { method }), env, {});
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get("allow"), "GET");
  }
  assert.equal(bucket._calls.delete.length, 0);
  assert.equal(bucket._calls.put.length, 1, "一覧のURLへの POST で何かが書き込まれています");
});

test("一覧では、書き込みも削除も起きない", async () => {
  const { bucket, env } = await seed(2);
  const putsBefore = bucket._calls.put.length;
  await getList(env);
  assert.equal(bucket._calls.put.length, putsBefore);
  assert.equal(bucket._calls.delete.length, 0);
});

test("R2 の一覧取得が失敗したら 500（内部情報は出さない）", async () => {
  const bucket = createMockR2({ failOn: "list" });
  const res = await worker.fetch(new Request(listUrl()), createTestEnv(bucket), {});
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.equal(JSON.parse(text).error.code, "R2_ERROR");
  for (const leak of ["secret-bucket-name", "your-media-local", "mock R2", "Error", "at "]) {
    assert.equal(text.includes(leak), false, `内部情報が漏れています: ${leak}`);
  }
});

test("R2 のバインディングが無ければ 500", async () => {
  const res = await worker.fetch(new Request(listUrl()), { ENVIRONMENT: "local" }, {});
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error.code, "R2_ERROR");
});

test("応答に内部情報が入らない", async () => {
  const { env } = await seed(1);
  const res = await worker.fetch(new Request(listUrl()), env, {});
  const dump = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n") + "\n" + await res.text();
  for (const leak of ["your-media-local", "MEDIA_BUCKET", "wrangler", "miniflare"]) {
    assert.equal(dump.includes(leak), false, `内部情報が漏れています: ${leak}`);
  }
  assert.equal(/[A-Za-z]:\\/.test(dump), false, "Windows の絶対パスが漏れています");
});

test("JPEG・WebP も一覧に出る", async () => {
  const bucket = createMockR2();
  const env = createTestEnv(bucket, { PUBLIC_MEDIA_BASE_URL: ORIGIN });
  await worker.fetch(makeUploadRequest({ fileBytes: JPEG_BYTES, fileType: "image/jpeg" }), env, {});
  await worker.fetch(makeUploadRequest({ fileBytes: WEBP_BYTES, fileType: "image/webp" }), env, {});
  const { body } = await getList(env);
  assert.deepEqual(body.items.map(i => i.key.split(".").pop()).sort(), ["jpg", "webp"]);
});

/* 削除リクエストの組み立て（mediaDelete.test.mjs と同じ形） */
function deleteRequest(key, opts = {}){
  const {
    url = `${ORIGIN}/api/media/item`,
    method = "DELETE",
    contentType = "application/json",
    body = JSON.stringify({ key })
  } = opts;
  const headers = {};
  if (contentType !== null) headers["content-type"] = contentType;
  return new Request(url, { method, headers, body });
}
