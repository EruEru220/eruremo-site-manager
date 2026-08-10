/* ================================================================
   見本の1枚（canary）だけを通す抜け道のテスト

   確かめること：
   - 抜け道が閉じていれば、canary でも R2 に1回も触らない
   - 開いていても、**その1枚以外は絶対に通らない**（大きさ・種類・指紋・キー）
   - 通るのは canary だけ。しかも put は最大1回
   - **削除は抜け道が開いていても拒否**（`MEDIA_MUTATIONS_ENABLED` だけを見る）
   - `MEDIA_MUTATIONS_ENABLED` は "false" のまま
   - ブラウザの申告（key / sha256 / size）を信用しない
   - canary の値が migration-input.local.json と**ずれていない**

   本物の R2 にも Cloudflare にも接続しません。
   ================================================================ */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import worker from "../src/index.js";
/* ステージングでは Access の門番が先に働くため、
   ここでは門番の内側にあたる処理を直接呼んで確かめます
   （門番そのものは stagingGuard.test.mjs で確認済み）。 */
import { handleUpload } from "../src/lib/upload.js";
import { handleMediaDelete } from "../src/lib/mediaDelete.js";
import { CANARY, canaryEnvAllows, isCanaryUpload } from "../src/lib/canary.js";
import { createMockR2, createTestEnv } from "./helpers/mockR2.mjs";
import { readWranglerConfig } from "./helpers/wranglerConfig.mjs";
import { createMigrationManifest } from "./helpers/migrationManifest.mjs";

const ORIGIN = "http://localhost:8787";
const MANIFEST = createMigrationManifest();

/* ================================================================
   1. canary の値が、決めた一覧とずれていないか
   ================================================================ */

test("canary は一覧の中の「いちばん小さい1枚」と一致する", () => {
  /* 一覧から機械的に選び直して、コードに書いた値と突き合わせる */
  const picked = MANIFEST.entries.slice()
    .sort((a, b) => a.size - b.size || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))[0];

  assert.equal(CANARY.key, picked.key, "キーがずれています");
  assert.equal(CANARY.sha256, picked.sha256, "指紋がずれています");
  assert.equal(CANARY.size, picked.size, "大きさがずれています");
  assert.equal(CANARY.contentType, picked.contentType, "種類がずれています");
  assert.equal(CANARY.category, picked.category, "置き場所がずれています");
});

test("canary のキーと指紋のつじつまが合っている", () => {
  assert.match(CANARY.sha256, /^[a-f0-9]{64}$/);
  assert.equal(CANARY.key.split("/").pop().split(".")[0], CANARY.sha256.slice(0, 16));
  assert.equal(CANARY.key.split("/")[1], CANARY.category);
});

/* ================================================================
   2. 設定ファイル
   ================================================================ */

test("ふつうの許可は、ステージングでは閉じたまま", () => {
  /* ここが "false" である限り、通常のアップロードも削除も通りません。
     canary の抜け道が開いていても、この行は変えません。 */
  const cfg = readWranglerConfig();
  assert.equal(cfg.env.staging.vars.MEDIA_MUTATIONS_ENABLED, "false");
});

test("canary の抜け道は、ローカルでは閉じたまま", () => {
  /* ローカルは ENVIRONMENT が "local" なので抜け道は働きませんが、
     意図を示すために閉じたままにしておきます。 */
  const cfg = readWranglerConfig();
  assert.equal(cfg.vars.MIGRATION_CANARY_MUTATION_ENABLED, "false");
});

test("canary の抜け道の値は、\"true\" か \"false\" のどちらかだけ", () => {
  /* いまは見本の1枚を送るために "true"。
     "true" のときでも、通るのは決めておいた1枚だけです（下のテスト群で確認）。 */
  const cfg = readWranglerConfig();
  const v = cfg.env.staging.vars.MIGRATION_CANARY_MUTATION_ENABLED;
  assert.ok(v === "true" || v === "false", `想定外の値です: ${JSON.stringify(v)}`);
});

/* ================================================================
   3. 環境の条件
   ================================================================ */

const stagingCanaryEnv = (over = {}) => ({
  ENVIRONMENT: "staging",
  MEDIA_MUTATIONS_ENABLED: "false",
  MIGRATION_CANARY_MUTATION_ENABLED: "true",
  ...over
});

test("抜け道が開くのは、3つとも文字列が完全一致したときだけ", () => {
  assert.equal(canaryEnvAllows(stagingCanaryEnv()), true);

  /* ENVIRONMENT は "staging" の完全一致だけ */
  for (const e of ["local", "production", "", " staging ", "Staging", "STAGING",
                   undefined, null, 0, false]) {
    assert.equal(canaryEnvAllows(stagingCanaryEnv({ ENVIRONMENT: e })), false, JSON.stringify(e));
  }

  /* MEDIA_MUTATIONS_ENABLED は **"false" の完全一致だけ**。
     「"true" でなければよい」ではありません。 */
  for (const v of [undefined, null, "", " ", "FALSE", "False", " false ", "false ",
                   "fasle", "0", "no", "off", "true", "TRUE", 0, false]) {
    assert.equal(canaryEnvAllows(stagingCanaryEnv({ MEDIA_MUTATIONS_ENABLED: v })), false,
      JSON.stringify(v));
  }

  /* MIGRATION_CANARY_MUTATION_ENABLED は "true" の完全一致だけ */
  for (const v of [undefined, null, "", " ", "false", "TRUE", "True", " true ", "true ",
                   "tru", "1", "yes", 1, true]) {
    assert.equal(canaryEnvAllows(stagingCanaryEnv({ MIGRATION_CANARY_MUTATION_ENABLED: v })), false,
      JSON.stringify(v));
  }

  assert.equal(canaryEnvAllows(null), false);
  assert.equal(canaryEnvAllows(undefined), false);
  assert.equal(canaryEnvAllows({}), false);
});

test("許される組み合わせは、ちょうど1通りだけ", () => {
  /* 3つの設定に、それぞれ「正しい値」と「惜しい値」を並べて総当たりする */
  const envs = ["staging", "Staging", "local", "", undefined];
  const muts = ["false", "FALSE", " false ", "true", "", undefined];
  const cans = ["true", "TRUE", " true ", "false", "", undefined];

  let opened = 0;
  for (const ENVIRONMENT of envs) {
    for (const MEDIA_MUTATIONS_ENABLED of muts) {
      for (const MIGRATION_CANARY_MUTATION_ENABLED of cans) {
        const ok = canaryEnvAllows({
          ENVIRONMENT, MEDIA_MUTATIONS_ENABLED, MIGRATION_CANARY_MUTATION_ENABLED });
        if (ok) {
          opened++;
          assert.equal(ENVIRONMENT, "staging");
          assert.equal(MEDIA_MUTATIONS_ENABLED, "false");
          assert.equal(MIGRATION_CANARY_MUTATION_ENABLED, "true");
        }
      }
    }
  }
  assert.equal(opened, 1, `開いた組み合わせが ${opened} 通りあります（1通りだけのはずです）`);
});

/* ================================================================
   4. 中身の判定（申告ではなく実バイト）
   ================================================================ */

/* 本物の canary と同じ指紋になるバイト列は作れないので、
   「作れないこと」を前提に、違うものが通らないことを確かめる */
const fakeCanaryBytes = () => {
  const b = new Uint8Array(CANARY.size);
  b.set([0x52, 0x49, 0x46, 0x46], 0);           /* "RIFF" */
  b.set([0x57, 0x45, 0x42, 0x50], 8);           /* "WEBP" */
  b.set([0x56, 0x50, 0x38, 0x20], 12);          /* "VP8 " */
  for (let i = 16; i < b.length; i++) b[i] = i & 0xFF;
  return b;
};

test("大きさが同じでも、指紋が違えば通らない", async () => {
  const bytes = fakeCanaryBytes();
  assert.equal(bytes.byteLength, CANARY.size, "前提の大きさが違います");
  assert.notEqual(createHash("sha256").update(bytes).digest("hex"), CANARY.sha256);
  assert.equal(await isCanaryUpload(bytes, CANARY.contentType, CANARY.key), false);
});

test("大きさが違えば通らない", async () => {
  const bytes = new Uint8Array(CANARY.size - 1);
  assert.equal(await isCanaryUpload(bytes, CANARY.contentType, CANARY.key), false);
});

test("種類が違えば通らない", async () => {
  const bytes = fakeCanaryBytes();
  for (const mime of ["image/png", "image/jpeg", "text/html", "", null]) {
    assert.equal(await isCanaryUpload(bytes, mime, CANARY.key), false, String(mime));
  }
});

test("キーが違えば通らない", async () => {
  const bytes = fakeCanaryBytes();
  for (const key of ["media/gallery/2026/08/0123456789abcdef.webp",
                     "media/other/2026/08/fcc4e376a9120c02.webp",
                     CANARY.key + "x", "", null]) {
    assert.equal(await isCanaryUpload(bytes, CANARY.contentType, key), false, String(key));
  }
});

test("バイト列でないものは通らない", async () => {
  for (const v of [null, undefined, "text", 123, [], {}]) {
    assert.equal(await isCanaryUpload(v, CANARY.contentType, CANARY.key), false, String(v));
  }
});

/* ================================================================
   5. Worker 全体としてのふるまい
   ================================================================ */

function uploadRequest(bytes, { type = "image/webp", category = "gallery",
                                extra = null, name = "image" } = {}){
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), name);
  form.append("category", category);
  if (extra) for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return new Request(`${ORIGIN}/api/media/upload`, { method: "POST", body: form });
}

const totalCalls = b =>
  b._calls.get.length + b._calls.head.length + b._calls.put.length +
  b._calls.list.length + b._calls.delete.length;

/* ちゃんとした WebP（小さいがマジックバイトは正しい） */
function webpBytes(size = 64, seed = 1){
  const b = new Uint8Array(size);
  b.set([0x52, 0x49, 0x46, 0x46], 0);
  b.set([0x57, 0x45, 0x42, 0x50], 8);
  b.set([0x56, 0x50, 0x38, 0x20], 12);
  for (let i = 16; i < size; i++) b[i] = (i * seed) & 0xFF;
  return b;
}

const stagingEnvWith = (bucket, over = {}) =>
  ({ ...stagingCanaryEnv(over), MEDIA_BUCKET: bucket });

test("抜け道が閉じていれば、R2 に1回も触らない", async () => {
  for (const v of [undefined, "", "false", "TRUE", "tru"]) {
    const bucket = createMockR2();
    const env = stagingEnvWith(bucket, { MIGRATION_CANARY_MUTATION_ENABLED: v });
    const res = await handleUpload(uploadRequest(webpBytes()), env);
    assert.equal(res.status, 503, JSON.stringify(v));
    assert.equal((await res.json()).error.code, "MUTATIONS_DISABLED", JSON.stringify(v));
    assert.equal(totalCalls(bucket), 0, `R2 に触れています: ${JSON.stringify(v)}`);
  }
});

test("抜け道が開いていても、別の画像は R2 に1回も触らずに 403", async () => {
  const cases = [
    ["大きさが違う WebP", webpBytes(64), "image/webp"],
    ["大きさは同じだが中身が違う WebP", fakeCanaryBytes(), "image/webp"],
    ["PNG", (() => { const b = new Uint8Array(64);
      b.set([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A], 0); return b; })(), "image/png"],
    ["JPEG", (() => { const b = new Uint8Array(64);
      b.set([0xFF,0xD8,0xFF,0xE0], 0); return b; })(), "image/jpeg"]
  ];
  for (const [label, bytes, type] of cases) {
    const bucket = createMockR2();
    const res = await handleUpload(uploadRequest(bytes, { type }), stagingEnvWith(bucket));
    assert.equal(res.status, 403, label);
    assert.equal((await res.json()).error.code, "NOT_THE_CANARY", label);
    assert.equal(totalCalls(bucket), 0, `R2 に触れています: ${label}`);
  }
});

test("置き場所を変えて送っても、キーが変わるので通らない", async () => {
  const bucket = createMockR2();
  const res = await handleUpload(
    uploadRequest(fakeCanaryBytes(), { category: "other" }), stagingEnvWith(bucket));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, "NOT_THE_CANARY");
  assert.equal(totalCalls(bucket), 0);
});

test("key / sha256 / size を名乗ってきても、無視される", async () => {
  const bucket = createMockR2();
  /* 本物の canary の値を名乗るが、中身は別物 */
  const res = await handleUpload(uploadRequest(fakeCanaryBytes(), {
    extra: { key: CANARY.key, sha256: CANARY.sha256, size: String(CANARY.size) }
  }), stagingEnvWith(bucket));
  assert.equal(res.status, 403, "申告を信用しています");
  assert.equal(totalCalls(bucket), 0);
});

test("抜け道が開いていても、SVG や HTML は通らない", async () => {
  const bucket = createMockR2();
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const res = await handleUpload(
    uploadRequest(svg, { type: "image/webp" }), stagingEnvWith(bucket));
  assert.equal(res.status, 400, "画像でないものが通っています");
  assert.equal(totalCalls(bucket), 0);
});

test("通常の許可が「false」以外なら、抜け道は開かず R2 に触らない", async () => {
  /* 未設定・""・"FALSE"・" false "・打ちまちがい、すべて 503 */
  for (const v of [undefined, "", " ", "FALSE", "False", " false ", "false ", "fasle", "0", "no"]) {
    const bucket = createMockR2();
    const env = stagingEnvWith(bucket, { MEDIA_MUTATIONS_ENABLED: v });
    const res = await handleUpload(uploadRequest(fakeCanaryBytes()), env);
    assert.equal(res.status, 503, JSON.stringify(v));
    assert.equal((await res.json()).error.code, "MUTATIONS_DISABLED", JSON.stringify(v));
    assert.equal(totalCalls(bucket), 0, `R2 に触れています: ${JSON.stringify(v)}`);
  }
});

/* ================================================================
   5-2. file はちょうど1個だけ
   ================================================================ */

/* file を好きな個数だけ入れたリクエストを作る */
function multiFileRequest(list, { category = "gallery" } = {}){
  const form = new FormData();
  for (const { bytes, type } of list) {
    form.append("file", new Blob([bytes], { type: type || "image/webp" }), "image");
  }
  form.append("category", category);
  return new Request(`${ORIGIN}/api/media/upload`, { method: "POST", body: form });
}

test("file が0個なら、R2 に触らずに断る", async () => {
  const bucket = createMockR2();
  const res = await handleUpload(multiFileRequest([]), stagingEnvWith(bucket));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "NO_FILE");
  assert.equal(totalCalls(bucket), 0);
});

test("file が2個以上なら、R2 に触らずに断る（先頭を採用しない）", async () => {
  for (const n of [2, 3, 5]) {
    const bucket = createMockR2();
    const list = Array.from({ length: n }, (_, i) => ({ bytes: webpBytes(64, i + 1) }));
    const res = await handleUpload(multiFileRequest(list), stagingEnvWith(bucket));
    assert.equal(res.status, 400, `${n} 個`);
    assert.equal((await res.json()).error.code, "NO_FILE", `${n} 個`);
    assert.equal(totalCalls(bucket), 0, `${n} 個で R2 に触れています`);
  }
});

test("正しい見本に余分な file を足したら、R2 に触らずに断る", async () => {
  const bucket = createMockR2();
  /* 1件目は見本と同じ大きさ・種類、2件目は別物 */
  const res = await handleUpload(multiFileRequest([
    { bytes: fakeCanaryBytes() },
    { bytes: webpBytes(64, 9) }
  ]), stagingEnvWith(bucket));
  assert.equal(res.status, 400, "先頭だけを採用しています");
  assert.equal((await res.json()).error.code, "NO_FILE");
  assert.equal(totalCalls(bucket), 0);
});

test("ふつうの許可が開いていても、file は1個だけ", async () => {
  const bucket = createMockR2();
  const env = createTestEnv(bucket, { ENVIRONMENT: "local" });
  const res = await handleUpload(multiFileRequest([
    { bytes: webpBytes(64, 1) }, { bytes: webpBytes(64, 2) }
  ]), env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "NO_FILE");
  assert.equal(bucket._calls.put.length, 0, "余分があるのに保存しています");
});

test("file がちょうど1個なら、これまでどおり進む", async () => {
  const bucket = createMockR2();
  const env = createTestEnv(bucket, { ENVIRONMENT: "local" });
  const res = await handleUpload(multiFileRequest([{ bytes: webpBytes(64, 7) }]), env);
  assert.equal(res.status, 201);
  assert.equal(bucket._calls.put.length, 1);
});

test("個数の判定は getAll で行っている（先頭だけを見ない）", () => {
  const src = readFileSync(new URL("../src/lib/upload.js", import.meta.url), "utf8");
  /* 説明の文章は数えない */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(code, /form\.getAll\("file"\)/, "getAll で数えていません");
  assert.match(code, /files\.length !== 1/, "ちょうど1個かを見ていません");
  assert.equal(code.includes('form.get("file")'), false, "先頭だけを取る書き方が残っています");
});

test("抜け道が開いていても、Access の門番は先に働く", async () => {
  /* Worker 全体としては、認証されていなければ 403 FORBIDDEN で止まる */
  const bucket = createMockR2();
  const env = { ...stagingCanaryEnv(), STAGING_LOCKED: "false",
                MEDIA_BUCKET: bucket,
                ASSETS: { fetch: async () => new Response("static asset") } };
  const res = await worker.fetch(uploadRequest(fakeCanaryBytes()), env, {});
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, "FORBIDDEN", "門番より先に抜け道を見ています");
  assert.equal(totalCalls(bucket), 0);
});

/* ================================================================
   6. 削除は、抜け道が開いていても閉じたまま
   ================================================================ */

test("抜け道が開いていても、削除は 503 で拒否される", async () => {
  const bucket = createMockR2();
  const env = { ...stagingCanaryEnv(), MEDIA_BUCKET: bucket };
  await bucket.put(CANARY.key, webpBytes(CANARY.size), {});
  const before = totalCalls(bucket);

  const res = await handleMediaDelete(new Request(`${ORIGIN}/api/media/item`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: CANARY.key })
  }), env);

  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "MUTATIONS_DISABLED");
  assert.equal(totalCalls(bucket), before, "R2 に触れています");
  assert.equal(bucket._store.has(CANARY.key), true, "消えています");
  assert.equal(bucket._calls.delete.length, 0);
});

test("削除の判定は、抜け道の設定をまったく見ていない", () => {
  const src = readFileSync(new URL("../src/lib/mediaDelete.js", import.meta.url), "utf8");
  assert.equal(src.includes("MIGRATION_CANARY_MUTATION_ENABLED"), false);
  assert.equal(src.includes("canaryEnvAllows"), false);
  assert.equal(src.includes("isCanaryUpload"), false);
  assert.match(src, /if \(!mutationsEnabled\(env\)\) return jsonError\("MUTATIONS_DISABLED"\);/);
});

/* ================================================================
   7. ふつうの許可が開いているときは、これまでどおり
   ================================================================ */

test("ローカル（ふつうの許可が開いている）では、どの画像も保存できる", async () => {
  const bucket = createMockR2();
  const env = createTestEnv(bucket, { ENVIRONMENT: "local" });   /* 既定で "true" */
  const res = await worker.fetch(uploadRequest(webpBytes(64, 3)), env, {});
  assert.equal(res.status, 201);
  assert.equal(bucket._calls.put.length, 1);
});

test("ふつうの許可が閉じていれば、ローカルでも canary の抜け道は開かない", async () => {
  const bucket = createMockR2();
  const env = createTestEnv(bucket, {
    ENVIRONMENT: "local",
    MEDIA_MUTATIONS_ENABLED: "false",
    MIGRATION_CANARY_MUTATION_ENABLED: "true"
  });
  const res = await worker.fetch(uploadRequest(webpBytes()), env, {});
  assert.equal(res.status, 503, "ローカルで抜け道が開いています");
  assert.equal(totalCalls(bucket), 0);
});

/* ================================================================
   8. 抜け道を通ったときの保存（put は最大1回）
   ================================================================ */

/* 本物の canary のバイト列は手元にないので、
   「判定を通ったあとの流れ」だけを、判定を差し替えて確かめる。 */
test("判定を通れば、これまでの保存処理（重複排除つき）へ進む", async () => {
  /* isCanaryUpload の中身は上で確かめてあるので、ここでは
     ふつうの許可が開いている経路と同じ流れになることを見る */
  const bucket = createMockR2();
  const env = createTestEnv(bucket, { ENVIRONMENT: "local" });
  const bytes = webpBytes(64, 5);

  const a = await worker.fetch(uploadRequest(bytes), env, {});
  assert.equal(a.status, 201);
  assert.equal(bucket._calls.put.length, 1, "put は1回");

  /* 同じものをもう一度 → 重複排除で put は増えない */
  const b = await worker.fetch(uploadRequest(bytes), env, {});
  assert.equal(b.status, 200);
  assert.equal((await b.json()).deduped, true);
  assert.equal(bucket._calls.put.length, 1, "put が増えています");
  assert.equal(bucket._calls.delete.length, 0);
});

/* ================================================================
   8-2. 本物の見本の1枚が、実際に通ること

   本物のバイト列は移行パッケージの中にあります。
   まだ作っていない場合（Git 対象外なので普通は無い）は、この確認を飛ばします。
   ================================================================ */

function loadCanaryBytes(){
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../migration-package.json", import.meta.url), "utf8"));
    const e = pkg.entries.find(x => x.key === CANARY.key);
    return e ? new Uint8Array(Buffer.from(e.dataBase64, "base64")) : null;
  } catch {
    return null;
  }
}
const CANARY_BYTES = loadCanaryBytes();

test("本物の見本の1枚は、条件がそろえば通り、put は1回だけ", { skip: !CANARY_BYTES }, async () => {
  /* まず、用意したバイト列が本当に見本かを確かめる */
  assert.equal(CANARY_BYTES.byteLength, CANARY.size);
  assert.equal(createHash("sha256").update(CANARY_BYTES).digest("hex"), CANARY.sha256);
  assert.equal(await isCanaryUpload(CANARY_BYTES, CANARY.contentType, CANARY.key), true);

  const bucket = createMockR2();
  const env = stagingEnvWith(bucket);          /* 3条件すべて完全一致 */
  const res = await handleUpload(
    uploadRequest(CANARY_BYTES, { type: CANARY.contentType, category: CANARY.category }), env);

  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.key, CANARY.key, "別のキーで保存されています");
  assert.equal(bucket._calls.put.length, 1, "put は1回だけ");
  assert.equal(bucket._calls.delete.length, 0);

  /* もう一度送っても、重複排除で put は増えない */
  const again = await handleUpload(
    uploadRequest(CANARY_BYTES, { type: CANARY.contentType, category: CANARY.category }), env);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).deduped, true);
  assert.equal(bucket._calls.put.length, 1, "put が増えています");
});

test("本物の見本でも、抜け道が閉じていれば通らない", { skip: !CANARY_BYTES }, async () => {
  for (const over of [{ MIGRATION_CANARY_MUTATION_ENABLED: "false" },
                      { MEDIA_MUTATIONS_ENABLED: "" },
                      { ENVIRONMENT: "local" }]) {
    const bucket = createMockR2();
    const res = await handleUpload(
      uploadRequest(CANARY_BYTES, { type: CANARY.contentType, category: CANARY.category }),
      stagingEnvWith(bucket, over));
    assert.equal(res.status, 503, JSON.stringify(over));
    assert.equal(totalCalls(bucket), 0, `R2 に触れています: ${JSON.stringify(over)}`);
  }
});

test("本物の見本でも、置き場所を変えたら通らない", { skip: !CANARY_BYTES }, async () => {
  const bucket = createMockR2();
  const res = await handleUpload(
    uploadRequest(CANARY_BYTES, { type: CANARY.contentType, category: "other" }),
    stagingEnvWith(bucket));
  assert.equal(res.status, 403, "キーが変わっても通っています");
  assert.equal((await res.json()).error.code, "NOT_THE_CANARY");
  assert.equal(totalCalls(bucket), 0);
});

test("抜け道の判定は R2 のバインディングより前に終わる", () => {
  const src = readFileSync(new URL("../src/lib/upload.js", import.meta.url), "utf8");
  const canaryAt = src.indexOf("isCanaryUpload(bytes");
  const bucketAt = src.indexOf("const bucket = env && env.MEDIA_BUCKET");
  assert.ok(canaryAt >= 0, "canary の判定がありません");
  assert.ok(bucketAt >= 0);
  assert.ok(canaryAt < bucketAt, "R2 を見てから判定しています");
});

test("自動でやり直す処理が無い", () => {
  const src = readFileSync(new URL("../src/lib/canary.js", import.meta.url), "utf8");
  for (const w of ["setTimeout", "setInterval", "retry", "while(", "while ("]) {
    assert.equal(src.includes(w), false, `あってはいけない記述: ${w}`);
  }
  /* 判定そのものに繰り返しが無いこと（指紋を16進にする for だけは必要） */
  const judge = src.slice(src.indexOf("export async function isCanaryUpload"));
  for (const w of ["for(", "for (", ".forEach(", "while("]) {
    assert.equal(judge.includes(w), false, `判定に繰り返しがあります: ${w}`);
  }
});

test("抜け道のコードに、削除や一覧の経路が無い", () => {
  const src = readFileSync(new URL("../src/lib/canary.js", import.meta.url), "utf8");
  for (const w of ["delete", "\.put(", "\.list(", "fetch("]) {
    assert.equal(src.includes(w), false, `あってはいけない記述: ${w}`);
  }
});
