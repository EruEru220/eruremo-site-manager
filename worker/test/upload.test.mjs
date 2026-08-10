/* POST /api/media/upload のテスト
   本物の Cloudflare / R2 には一切つながず、メモリ上の偽バケットを使う。 */
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { MAX_UPLOAD_BYTES, IMAGE_CACHE_CONTROL } from "../src/lib/upload.js";
import { isValidMediaKey } from "../src/lib/mediaKey.js";
import { createMockR2, createTestEnv } from "./helpers/mockR2.mjs";
import * as F from "./helpers/fixtures.mjs";

/* テスト1回ごとに新しい偽バケットを用意して呼ぶ */
async function upload(opts = {}, bucketOptions = {}){
  const bucket = createMockR2(bucketOptions);
  const res = await worker.fetch(F.makeUploadRequest(opts), createTestEnv(bucket), {});
  return { res, bucket, body: await res.clone().json() };
}

/* ================================================================
   1. 正常系
   ================================================================ */
for (const [label, data, type, mime, ext] of [
  ["JPEG", F.JPEG_BYTES, "image/jpeg", "image/jpeg", "jpg"],
  ["PNG",  F.PNG_BYTES,  "image/png",  "image/png",  "png"],
  ["WebP", F.WEBP_BYTES, "image/webp", "image/webp", "webp"]
]) {
  test(`有効な ${label} を保存できる`, async () => {
    const { res, bucket, body } = await upload({ fileBytes: data, fileType: type });

    assert.equal(res.status, 201);
    assert.equal(body.ok, true);
    assert.equal(body.contentType, mime);
    assert.equal(body.size, data.byteLength);
    assert.match(body.key, new RegExp(`^media/gallery/\\d{4}/\\d{2}/[a-f0-9]{16}\\.${ext}$`));
    assert.equal(isValidMediaKey(body.key), true);
    assert.equal(body.url, "https://example.invalid/" + body.key);

    /* R2 に1件だけ、正しい中身・正しいメタデータで入っていること */
    assert.equal(bucket.size, 1);
    const saved = bucket._store.get(body.key);
    assert.deepEqual(saved.bytes, data);
    assert.equal(saved.httpMetadata.contentType, mime);
    assert.equal(saved.httpMetadata.cacheControl, IMAGE_CACHE_CONTROL);
  });
}

test("申告 Content-Type が無くても、中身で判定して保存できる", async () => {
  const { res, body } = await upload({ fileBytes: F.PNG_BYTES, fileType: null });
  assert.equal(res.status, 201);
  assert.equal(body.contentType, "image/png");
});

test("application/octet-stream の申告は「不明」として扱い、中身で判定する", async () => {
  const { res, body } = await upload({ fileBytes: F.WEBP_BYTES, fileType: "application/octet-stream" });
  assert.equal(res.status, 201);
  assert.equal(body.contentType, "image/webp");
  assert.ok(body.key.endsWith(".webp"));
});

test("すべてのカテゴリで保存できる", async () => {
  const cats = ["logo","favicon","og","about","cast","staff","history","shop","present","gallery","other"];
  for (const c of cats) {
    const { res, body } = await upload({ category: c });
    assert.equal(res.status, 201, c);
    assert.ok(body.key.startsWith(`media/${c}/`), `${c}: ${body.key}`);
  }
});

test("同じ画像を2回送ると、2回目は保存せず 200 deduped:true", async () => {
  const bucket = createMockR2();
  const env = createTestEnv(bucket);

  const res1 = await worker.fetch(F.makeUploadRequest(), env, {});
  const body1 = await res1.json();
  assert.equal(res1.status, 201);
  assert.equal(body1.deduped, undefined);

  const res2 = await worker.fetch(F.makeUploadRequest(), env, {});
  const body2 = await res2.json();
  assert.equal(res2.status, 200);
  assert.equal(body2.deduped, true);
  assert.equal(body2.key, body1.key);

  assert.equal(bucket.size, 1, "R2 に2件保存されています");
  assert.equal(bucket._calls.put.length, 1, "put が2回呼ばれています");
});

/* ================================================================
   2. メソッド・Content-Type の拒否
   ================================================================ */
for (const method of ["PUT", "DELETE", "PATCH"]) {
  test(`${method} は 405 で拒否`, async () => {
    const { res, body, bucket } = await upload({ method });
    assert.equal(res.status, 405);
    assert.equal(body.error.code, "METHOD_NOT_ALLOWED");
    assert.equal(res.headers.get("allow"), "POST");
    assert.equal(bucket.size, 0);
  });
}

test("GET は 405 で拒否", async () => {
  const bucket = createMockR2();
  const res = await worker.fetch(
    new Request("http://localhost:8787/api/media/upload"), createTestEnv(bucket), {});
  assert.equal(res.status, 405);
  assert.equal(bucket.size, 0);
});

for (const [label, ct] of [
  ["JSON",          "application/json"],
  ["URLエンコード", "application/x-www-form-urlencoded"],
  ["プレーンテキスト", "text/plain"],
  ["画像そのもの",  "image/jpeg"],
  ["ヘッダなし",    null]
]) {
  test(`Content-Type が ${label} なら 415 で拒否`, async () => {
    const bucket = createMockR2();
    const headers = ct ? { "content-type": ct } : {};
    const res = await worker.fetch(
      new Request("http://localhost:8787/api/media/upload",
        { method: "POST", body: "x=1", headers }),
      createTestEnv(bucket), {});
    assert.equal(res.status, 415);
    assert.equal((await res.json()).error.code, "BAD_CONTENT_TYPE");
    assert.equal(bucket.size, 0);
  });
}

/* ================================================================
   3. ファイルの拒否
   ================================================================ */
test("file が無ければ 400 NO_FILE", async () => {
  const { res, body, bucket } = await upload({ fileBytes: null });
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "NO_FILE");
  assert.equal(bucket.size, 0);
});

test("file が文字列なら 400 NO_FILE（ファイル以外を受け付けない）", async () => {
  const bucket = createMockR2();
  const form = new FormData();
  form.append("file", "これはファイルではありません");
  form.append("category", "gallery");
  const res = await worker.fetch(
    new Request("http://localhost:8787/api/media/upload", { method: "POST", body: form }),
    createTestEnv(bucket), {});
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "NO_FILE");
  assert.equal(bucket.size, 0);
});

test("空ファイルは 400 EMPTY_FILE", async () => {
  const { res, body, bucket } = await upload({ fileBytes: F.EMPTY_BYTES });
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "EMPTY_FILE");
  assert.equal(bucket.size, 0);
});

test("10MB を超えるファイルは 413 TOO_LARGE", async () => {
  const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
  big.set([0xFF, 0xD8, 0xFF], 0);
  const { res, body, bucket } = await upload({ fileBytes: big });
  assert.equal(res.status, 413);
  assert.equal(body.error.code, "TOO_LARGE");
  assert.equal(bucket.size, 0);
});

test("Content-Length の申告が大きすぎる場合は本体を読む前に 413", async () => {
  const bucket = createMockR2();
  const res = await worker.fetch(
    new Request("http://localhost:8787/api/media/upload", {
      method: "POST",
      body: "dummy",
      headers: {
        "content-type": "multipart/form-data; boundary=----x",
        "content-length": String(50 * 1024 * 1024)
      }
    }), createTestEnv(bucket), {});
  assert.equal(res.status, 413);
  assert.equal(bucket.size, 0);
});

/* ================================================================
   4. 偽装ファイルの拒否（いちばん大事なところ）
   ================================================================ */
for (const [label, data] of [
  ["SVG",            F.SVG_BYTES],
  ["XML宣言つきSVG", F.SVG_XML_BYTES],
  ["HTML",           F.HTML_BYTES],
  ["JavaScript",     F.JS_BYTES],
  ["GIF",            F.GIF_BYTES],
  ["AVIF",           F.AVIF_BYTES],
  ["ZIP",            F.ZIP_BYTES],
  ["PDF",            F.PDF_BYTES],
  ["RIFFだけのファイル", F.RIFF_ONLY_BYTES]
]) {
  test(`${label} は、拡張子と Content-Type を偽っても拒否される`, async () => {
    /* いちばん意地悪な条件：ファイル名も Content-Type も「JPEGです」と嘘をつく */
    const { res, body, bucket } = await upload({
      fileBytes: data, fileType: "image/jpeg", fileName: "innocent.jpg"
    });
    assert.equal(res.status, 400, label);
    assert.equal(body.error.code, "INVALID_FILE_TYPE", label);
    assert.equal(bucket.size, 0, `${label} が保存されてしまいました`);
    assert.equal(bucket._calls.put.length, 0, label);
  });
}

test("SVG を正直に image/svg+xml と申告しても拒否される", async () => {
  const { res, body } = await upload({
    fileBytes: F.SVG_BYTES, fileType: "image/svg+xml", fileName: "logo.svg"
  });
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "INVALID_FILE_TYPE");
});

test("中身は PNG なのに image/jpeg と申告したら 400 MIME_MISMATCH", async () => {
  const { res, body, bucket } = await upload({ fileBytes: F.PNG_BYTES, fileType: "image/jpeg" });
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "MIME_MISMATCH");
  assert.equal(bucket.size, 0);
});

test("中身は JPEG なのに image/webp と申告したら 400 MIME_MISMATCH", async () => {
  const { res, body } = await upload({ fileBytes: F.JPEG_BYTES, fileType: "image/webp" });
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "MIME_MISMATCH");
});

/* ================================================================
   5. category の検証
   ================================================================ */
for (const bad of [
  "", " ", "GALLERY", "Gallery", "unknown", "media", "../", "..",
  "gallery/../logo", "gallery/x", "../../etc/passwd", "%2e%2e%2f"
]) {
  test(`不正な category を拒否する: ${JSON.stringify(bad)}`, async () => {
    const { res, body, bucket } = await upload({ category: bad });
    assert.equal(res.status, 400);
    assert.equal(body.error.code, "INVALID_CATEGORY");
    assert.equal(bucket.size, 0);
  });
}

test("category フィールドそのものが無ければ 400 INVALID_CATEGORY", async () => {
  const { res, body, bucket } = await upload({ omitCategory: true });
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "INVALID_CATEGORY");
  assert.equal(bucket.size, 0);
});

test("category にファイルを送りつけても拒否される", async () => {
  const bucket = createMockR2();
  const form = new FormData();
  form.append("file", new Blob([F.JPEG_BYTES], { type: "image/jpeg" }), "a.jpg");
  form.append("category", new Blob(["gallery"]), "gallery.txt");
  const res = await worker.fetch(
    new Request("http://localhost:8787/api/media/upload", { method: "POST", body: form }),
    createTestEnv(bucket), {});
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "INVALID_CATEGORY");
  assert.equal(bucket.size, 0);
});

/* ================================================================
   6. 保存先を利用者が指定できないこと（パストラバーサル防止）
   ================================================================ */
test("key / path / filename / prefix を送りつけても無視される", async () => {
  const { res, body, bucket } = await upload({
    fileName: "../../../etc/passwd.jpg",
    extraFields: {
      key:      "../../secret/evil.jpg",
      path:     "/etc/passwd",
      prefix:   "../..",
      filename: "../../../evil.html",
      bucket:   "someone-elses-bucket",
      dir:      "..%2F..%2F"
    }
  });

  assert.equal(res.status, 201);
  assert.equal(isValidMediaKey(body.key), true);
  assert.equal(body.key.includes(".."), false);
  assert.equal(body.key.includes("passwd"), false);
  assert.equal(body.key.includes("evil"), false);
  assert.equal(body.key.includes("secret"), false);

  /* 実際に R2 へ渡されたキーも確認する */
  const putKey = bucket._calls.put[0].key;
  assert.equal(putKey, body.key);
  assert.equal(isValidMediaKey(putKey), true);
});

test("ファイル名の拡張子は使われない（中身の判定が優先）", async () => {
  const { body } = await upload({
    fileBytes: F.PNG_BYTES, fileType: "image/png", fileName: "photo.jpg.exe"
  });
  assert.ok(body.key.endsWith(".png"));
  assert.equal(body.key.includes("exe"), false);
  assert.equal(body.key.includes("photo"), false);
});

/* ================================================================
   7. R2 の失敗
   ================================================================ */
test("R2 の put が失敗したら 500 R2_ERROR", async () => {
  const { res, body } = await upload({}, { failOn: "put" });
  assert.equal(res.status, 500);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "R2_ERROR");
});

test("R2 の head が失敗しても 500 R2_ERROR", async () => {
  const { res, body } = await upload({}, { failOn: "head" });
  assert.equal(res.status, 500);
  assert.equal(body.error.code, "R2_ERROR");
});

test("R2 のバインディングが無ければ 500 R2_ERROR", async () => {
  const res = await worker.fetch(F.makeUploadRequest(),
    /* 非常停止スイッチは通し、バインディングだけが無い状態を作る */
    { ENVIRONMENT: "local", MEDIA_MUTATIONS_ENABLED: "true",
      PUBLIC_MEDIA_BASE_URL: "https://example.invalid" }, {});
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error.code, "R2_ERROR");
});

/* ================================================================
   8. 内部情報が漏れないこと
   ================================================================ */
test("R2 失敗時のレスポンスに内部情報が含まれない", async () => {
  const bucket = createMockR2({ failOn: "put" });
  const res = await worker.fetch(F.makeUploadRequest(), createTestEnv(bucket), {});
  const text = await res.text();
  for (const leak of [
    "secret-bucket-name", "mock R2", "bucket=", "Error", "at ",
    "src/lib", "/worker/", "MEDIA_BUCKET", "stack"
  ]) {
    assert.equal(text.includes(leak), false, `内部情報が漏れています: ${leak}`);
  }
  assert.equal(/[A-Za-z]:\\/.test(text), false, "Windows の絶対パスが漏れています");
  const body = JSON.parse(text);
  assert.deepEqual(Object.keys(body).sort(), ["error", "ok"]);
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "message"]);
});

test("すべての拒否パターンで、返るのは code と message だけ", async () => {
  const cases = [
    { fileBytes: F.SVG_BYTES },
    { fileBytes: F.HTML_BYTES },
    { fileBytes: F.EMPTY_BYTES },
    { category: "../evil" },
    { fileBytes: null },
    { fileBytes: F.PNG_BYTES, fileType: "image/jpeg" }
  ];
  for (const c of cases) {
    const { res, body } = await upload(c);
    assert.equal(res.ok, false);
    assert.deepEqual(Object.keys(body).sort(), ["error", "ok"]);
    assert.deepEqual(Object.keys(body.error).sort(), ["code", "message"]);
    assert.equal(typeof body.error.message, "string");
    /* 利用者が送った文字列がそのまま返っていないこと（反射の防止） */
    assert.equal(body.error.message.includes("evil"), false);
    assert.equal(body.error.message.includes("script"), false);
    assert.equal(body.error.message.includes("<"), false);
  }
});

test("成功レスポンスに余計な情報が入らない", async () => {
  const { body } = await upload();
  assert.deepEqual(Object.keys(body).sort(), ["contentType", "key", "ok", "size", "url"]);
});
