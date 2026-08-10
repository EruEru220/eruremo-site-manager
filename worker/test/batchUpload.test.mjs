/* ================================================================
   残り49件だけを通す道（batch ゲート）のテスト

   確かめること：
   - 道が閉じていれば、名簿に載っている画像でも **R2 に1回も触らない**
   - 開く条件は **4つの完全一致だけ**（未設定・空・大小文字・空白・typo は全部だめ）
   - **canary（見本の1枚）は、この道では絶対に通らない**
   - 名簿に無い画像（51件目）は絶対に通らない
   - 大きさ・指紋・種類・置き場所・キーのどれが違っても通らない
   - file はちょうど1個だけ
   - **削除は、この道が開いていても 503**（新しい設定を見ていない）
   - `MEDIA_MUTATIONS_ENABLED` は "false" のまま
   - 自動でやり直す処理が無い

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
import {
  batchEnvAllows, batchEntryFor, isBatchUpload, findBatchTarget,
  buildBatchIndex, compositeOf, BATCH_EXPECTED_COUNT, BATCH_INDEX_IS_UNIQUE
} from "../src/lib/batch.js";
import { BATCH_ALLOWLIST } from "../src/lib/batchAllowlist.generated.js";
import { CANARY, canaryEnvAllows } from "../src/lib/canary.js";
import { mutationsEnabled } from "../src/lib/mutations.js";
import { createMockR2, createTestEnv } from "./helpers/mockR2.mjs";
import { readWranglerConfig } from "./helpers/wranglerConfig.mjs";
import { renderAllowlistSource, selectBatchEntries } from "../scripts/build-batch-allowlist.mjs";
import { createMigrationManifest } from "./helpers/migrationManifest.mjs";

const ORIGIN = "http://localhost:8787";

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

function uploadRequest(bytes, { type = "image/webp", category = "gallery",
                                extra = null, name = "image" } = {}){
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), name);
  form.append("category", category);
  if (extra) for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return new Request(`${ORIGIN}/api/media/upload`, { method: "POST", body: form });
}

/* 4条件がすべてそろった環境 */
const stagingBatchEnv = (over = {}) => ({
  ENVIRONMENT: "staging",
  MEDIA_MUTATIONS_ENABLED: "false",
  MIGRATION_CANARY_MUTATION_ENABLED: "false",
  MIGRATION_BATCH_MUTATION_ENABLED: "true",
  ...over
});
const stagingEnvWith = (bucket, over = {}) => ({ ...stagingBatchEnv(over), MEDIA_BUCKET: bucket });

/* ================================================================
   1. 設定ファイル ― 今回は必ず閉じたまま
   ================================================================ */

test("新しい道は、ステージングでもローカルでも閉じている", () => {
  /* 2026-08-08：一度だけ開けて49件を移し、**移行後に閉じました。**
     移行はもう終わっているので、ここは閉じたままが正しい状態です。 */
  const cfg = readWranglerConfig();
  assert.equal(cfg.env.staging.vars.MIGRATION_BATCH_MUTATION_ENABLED, "false",
    "移行は終わっているのに、ステージングの道が開いています");
  assert.equal(cfg.vars.MIGRATION_BATCH_MUTATION_ENABLED, "false",
    "ローカルで新しい道が開いています");
});

test("新しい道の値は、\"true\" か \"false\" のどちらかだけ", () => {
  /* 打ちまちがいがそのまま入っていないことを確かめる。
     なお "true" 以外はすべて禁止側に倒れます（batchEnvAllows）。 */
  const cfg = readWranglerConfig();
  for (const v of [cfg.env.staging.vars.MIGRATION_BATCH_MUTATION_ENABLED,
                   cfg.vars.MIGRATION_BATCH_MUTATION_ENABLED]) {
    assert.ok(v === "true" || v === "false", `想定外の値です: ${JSON.stringify(v)}`);
  }
});

test("ふつうの許可も canary の抜け道も、閉じたまま", () => {
  /* ★ ここが今回いちばん大事。batch を開けても、この2つは開けません。
     ・MEDIA_MUTATIONS_ENABLED="false" … ふつうのアップロードと削除は禁止
     ・MIGRATION_CANARY_MUTATION_ENABLED="false" … canary の再送も禁止 */
  const cfg = readWranglerConfig();
  assert.equal(cfg.env.staging.vars.MEDIA_MUTATIONS_ENABLED, "false");
  assert.equal(cfg.env.staging.vars.MIGRATION_CANARY_MUTATION_ENABLED, "false");
});

test("ステージングの3つの安全弁が、すべて閉じている", () => {
  /* 移行（canary 1件 ＋ 49件 ＝ 50件）は 2026-08-08 に終わりました。
     以後は3つとも "false" が正しい状態です。 */
  const v = readWranglerConfig().env.staging.vars;
  assert.deepEqual({
    MEDIA_MUTATIONS_ENABLED: v.MEDIA_MUTATIONS_ENABLED,
    MIGRATION_CANARY_MUTATION_ENABLED: v.MIGRATION_CANARY_MUTATION_ENABLED,
    MIGRATION_BATCH_MUTATION_ENABLED: v.MIGRATION_BATCH_MUTATION_ENABLED
  }, {
    MEDIA_MUTATIONS_ENABLED: "false",
    MIGRATION_CANARY_MUTATION_ENABLED: "false",
    MIGRATION_BATCH_MUTATION_ENABLED: "false"
  });

  /* この組み合わせでは、どの道も開かない */
  const env = { ENVIRONMENT: "staging", ...v };
  assert.equal(batchEnvAllows(env), false, "batch の道が開いています");
  assert.equal(canaryEnvAllows(env), false, "canary の道が開いています");
  assert.equal(mutationsEnabled(env), false, "ふつうの許可が開いています");
});

test("新しい設定は、両方の環境に書いてある", () => {
  const cfg = readWranglerConfig();
  assert.equal("MIGRATION_BATCH_MUTATION_ENABLED" in cfg.vars, true);
  assert.equal("MIGRATION_BATCH_MUTATION_ENABLED" in cfg.env.staging.vars, true);
});

/* ================================================================
   2. 環境の条件（4つの完全一致だけ）
   ================================================================ */

test("道が開くのは、4つとも文字列が完全一致したときだけ", () => {
  assert.equal(batchEnvAllows(stagingBatchEnv()), true);

  for (const e of ["local", "production", "", " staging ", "Staging", "STAGING",
                   undefined, null, 0, false]) {
    assert.equal(batchEnvAllows(stagingBatchEnv({ ENVIRONMENT: e })), false, JSON.stringify(e));
  }
  for (const v of [undefined, null, "", " ", "FALSE", "False", " false ", "false ",
                   "fasle", "0", "no", "off", "true", "TRUE", 0, false]) {
    assert.equal(batchEnvAllows(stagingBatchEnv({ MEDIA_MUTATIONS_ENABLED: v })), false,
      JSON.stringify(v));
  }
  for (const v of [undefined, null, "", " ", "FALSE", "False", " false ", "false ",
                   "fasle", "true", "TRUE", 0, false]) {
    assert.equal(batchEnvAllows(stagingBatchEnv({ MIGRATION_CANARY_MUTATION_ENABLED: v })), false,
      JSON.stringify(v));
  }
  for (const v of [undefined, null, "", " ", "false", "TRUE", "True", " true ", "true ",
                   "tru", "1", "yes", 1, true]) {
    assert.equal(batchEnvAllows(stagingBatchEnv({ MIGRATION_BATCH_MUTATION_ENABLED: v })), false,
      JSON.stringify(v));
  }

  assert.equal(batchEnvAllows(null), false);
  assert.equal(batchEnvAllows(undefined), false);
  assert.equal(batchEnvAllows({}), false);
});

test("許される組み合わせは、ちょうど1通りだけ", () => {
  const envs  = ["staging", "Staging", "local", "", undefined];
  const muts  = ["false", "FALSE", " false ", "true", "", undefined];
  const cans  = ["false", "FALSE", " false ", "true", "", undefined];
  const batch = ["true", "TRUE", " true ", "false", "", undefined];

  let opened = 0;
  for (const ENVIRONMENT of envs)
    for (const MEDIA_MUTATIONS_ENABLED of muts)
      for (const MIGRATION_CANARY_MUTATION_ENABLED of cans)
        for (const MIGRATION_BATCH_MUTATION_ENABLED of batch) {
          const ok = batchEnvAllows({ ENVIRONMENT, MEDIA_MUTATIONS_ENABLED,
                                      MIGRATION_CANARY_MUTATION_ENABLED,
                                      MIGRATION_BATCH_MUTATION_ENABLED });
          if (ok) {
            opened++;
            assert.equal(ENVIRONMENT, "staging");
            assert.equal(MEDIA_MUTATIONS_ENABLED, "false");
            assert.equal(MIGRATION_CANARY_MUTATION_ENABLED, "false");
            assert.equal(MIGRATION_BATCH_MUTATION_ENABLED, "true");
          }
        }
  assert.equal(opened, 1, `開いた組み合わせが ${opened} 通りあります（1通りだけのはずです）`);
});

test("canary の道と batch の道は、同時に開かない", () => {
  /* canary は canary フラグ "true"、batch は同フラグ "false" が条件なので
     構造的に同時には開かない。総当たりで確かめる。 */
  const vals = ["true", "false", "TRUE", "", " true ", undefined];
  for (const ENVIRONMENT of ["staging", "local", undefined])
    for (const MEDIA_MUTATIONS_ENABLED of ["false", "true", "", undefined])
      for (const MIGRATION_CANARY_MUTATION_ENABLED of vals)
        for (const MIGRATION_BATCH_MUTATION_ENABLED of vals) {
          const env = { ENVIRONMENT, MEDIA_MUTATIONS_ENABLED,
                        MIGRATION_CANARY_MUTATION_ENABLED, MIGRATION_BATCH_MUTATION_ENABLED };
          assert.equal(canaryEnvAllows(env) && batchEnvAllows(env), false,
            `両方開いています: ${JSON.stringify(env)}`);
        }
});

/* ================================================================
   3. 道が閉じているとき ― R2 に1回も触らない
   ================================================================ */

test("道が閉じていれば、R2 に1回も触らずに 503", async () => {
  for (const v of [undefined, "", " ", "false", "FALSE", "True", "TRUE", " true ", "true ", "tru", "1"]) {
    const bucket = createMockR2();
    const env = stagingEnvWith(bucket, { MIGRATION_BATCH_MUTATION_ENABLED: v });
    const res = await handleUpload(uploadRequest(webpBytes()), env);
    assert.equal(res.status, 503, JSON.stringify(v));
    assert.equal((await res.json()).error.code, "MUTATIONS_DISABLED", JSON.stringify(v));
    assert.equal(totalCalls(bucket), 0, `R2 に触れています: ${JSON.stringify(v)}`);
  }
});

test("ふつうの許可が「false」以外なら、道は開かず R2 に触らない", async () => {
  for (const v of [undefined, "", " ", "FALSE", "False", " false ", "fasle", "true"]) {
    const bucket = createMockR2();
    const env = stagingEnvWith(bucket, { MEDIA_MUTATIONS_ENABLED: v });
    const res = await handleUpload(uploadRequest(webpBytes()), env);
    /* "true" のときだけは、ふつうの許可として開く（従来どおり）。
       それ以外はすべて 503。 */
    if (v === "true") { assert.equal(res.status, 201); continue; }
    assert.equal(res.status, 503, JSON.stringify(v));
    assert.equal(totalCalls(bucket), 0, `R2 に触れています: ${JSON.stringify(v)}`);
  }
});

test("ステージング以外では、道は開かない", async () => {
  for (const e of ["local", "production", "", " staging ", undefined]) {
    const bucket = createMockR2();
    const env = stagingEnvWith(bucket, { ENVIRONMENT: e });
    const res = await handleUpload(uploadRequest(webpBytes()), env);
    assert.equal(res.status, 503, JSON.stringify(e));
    assert.equal(totalCalls(bucket), 0, `R2 に触れています: ${JSON.stringify(e)}`);
  }
});

/* ================================================================
   4. 中身の判定（申告ではなく実バイト）
   ================================================================ */

const SAMPLE = BATCH_ALLOWLIST[0];

/* 名簿の1件と「大きさ・種類・キー」だけ同じで、中身が違うバイト列。
   本物の指紋は作れないので、**指紋だけが違う**状態を再現する。 */
function lookalikeBytes(entry){
  const b = new Uint8Array(entry.size);
  if (entry.contentType === "image/webp") {
    b.set([0x52, 0x49, 0x46, 0x46], 0); b.set([0x57, 0x45, 0x42, 0x50], 8);
    b.set([0x56, 0x50, 0x38, 0x20], 12);
  } else if (entry.contentType === "image/png") {
    b.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], 0);
  } else {
    b.set([0xFF, 0xD8, 0xFF, 0xE0], 0);
  }
  for (let i = 16; i < b.length; i++) b[i] = i & 0xFF;
  return b;
}

test("名簿に無いキーは通らない", async () => {
  const bytes = lookalikeBytes(SAMPLE);
  for (const key of ["media/gallery/2026/08/0123456789abcdef.webp",
                     SAMPLE.key + "x", "", null, undefined, 123]) {
    assert.equal(await isBatchUpload(bytes, SAMPLE.contentType, key, SAMPLE.category), false,
      String(key));
  }
});

test("大きさが同じでも、指紋が違えば通らない", async () => {
  const bytes = lookalikeBytes(SAMPLE);
  assert.equal(bytes.byteLength, SAMPLE.size, "前提の大きさが違います");
  assert.notEqual(createHash("sha256").update(bytes).digest("hex"), SAMPLE.sha256);
  assert.equal(await isBatchUpload(bytes, SAMPLE.contentType, SAMPLE.key, SAMPLE.category), false);
});

test("大きさが違えば通らない", async () => {
  const bytes = new Uint8Array(SAMPLE.size - 1);
  assert.equal(await isBatchUpload(bytes, SAMPLE.contentType, SAMPLE.key, SAMPLE.category), false);
});

test("種類が違えば通らない", async () => {
  const bytes = lookalikeBytes(SAMPLE);
  for (const mime of ["image/png", "image/jpeg", "text/html", "", null]) {
    if (mime === SAMPLE.contentType) continue;
    assert.equal(await isBatchUpload(bytes, mime, SAMPLE.key, SAMPLE.category), false, String(mime));
  }
});

test("置き場所が違えば通らない", async () => {
  const bytes = lookalikeBytes(SAMPLE);
  for (const cat of ["other", "gallery", "cast", "", null]) {
    if (cat === SAMPLE.category) continue;
    assert.equal(await isBatchUpload(bytes, SAMPLE.contentType, SAMPLE.key, cat), false, String(cat));
  }
});

test("バイト列でないものは通らない", async () => {
  for (const v of [null, undefined, "text", 123, [], {}]) {
    assert.equal(await isBatchUpload(v, SAMPLE.contentType, SAMPLE.key, SAMPLE.category), false,
      String(v));
  }
});

test("見本の1枚（canary）は、この道では絶対に通らない", async () => {
  /* 名簿に入っていないうえ、キーでも弾いている（二重の守り） */
  assert.equal(batchEntryFor(CANARY.key), null, "canary が名簿から引けてしまいます");
  const bytes = new Uint8Array(CANARY.size);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  assert.equal(await isBatchUpload(bytes, CANARY.contentType, CANARY.key, CANARY.category), false);
});

/* ================================================================
   5. Worker 全体としてのふるまい（道が開いているとき）
   ================================================================ */

test("道が開いていても、名簿に無い画像は R2 に触らずに 403", async () => {
  const cases = [
    ["小さい WebP", webpBytes(64), "image/webp", "gallery"],
    ["名簿の1件と同じ大きさだが中身が違う", lookalikeBytes(SAMPLE), SAMPLE.contentType, SAMPLE.category],
    ["PNG", (() => { const b = new Uint8Array(64);
      b.set([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A], 0); return b; })(), "image/png", "gallery"],
    ["JPEG", (() => { const b = new Uint8Array(64);
      b.set([0xFF,0xD8,0xFF,0xE0], 0); return b; })(), "image/jpeg", "gallery"]
  ];
  for (const [label, bytes, type, category] of cases) {
    const bucket = createMockR2();
    const res = await handleUpload(uploadRequest(bytes, { type, category }), stagingEnvWith(bucket));
    assert.equal(res.status, 403, label);
    assert.equal((await res.json()).error.code, "NOT_IN_BATCH", label);
    assert.equal(totalCalls(bucket), 0, `R2 に触れています: ${label}`);
  }
});

test("key / sha256 / size を名乗ってきても、無視される", async () => {
  const bucket = createMockR2();
  const res = await handleUpload(uploadRequest(lookalikeBytes(SAMPLE), {
    type: SAMPLE.contentType, category: SAMPLE.category,
    extra: { key: SAMPLE.key, sha256: SAMPLE.sha256, size: String(SAMPLE.size) }
  }), stagingEnvWith(bucket));
  assert.equal(res.status, 403, "申告を信用しています");
  assert.equal(totalCalls(bucket), 0);
});

test("道が開いていても、SVG や HTML は通らない", async () => {
  const bucket = createMockR2();
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const res = await handleUpload(uploadRequest(svg, { type: "image/webp" }), stagingEnvWith(bucket));
  assert.equal(res.status, 400, "画像でないものが通っています");
  assert.equal(totalCalls(bucket), 0);
});

test("道が開いていても、Access の門番は先に働く", async () => {
  const bucket = createMockR2();
  const env = { ...stagingBatchEnv(), STAGING_LOCKED: "false", MEDIA_BUCKET: bucket,
                ASSETS: { fetch: async () => new Response("static asset") } };
  const res = await worker.fetch(uploadRequest(webpBytes()), env, {});
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, "FORBIDDEN", "門番より先に道を見ています");
  assert.equal(totalCalls(bucket), 0);
});

/* ================================================================
   6. file はちょうど1個だけ
   ================================================================ */

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

test("file が2個以上なら、R2 に触らずに断る", async () => {
  for (const n of [2, 3, 5]) {
    const bucket = createMockR2();
    const list = Array.from({ length: n }, (_, i) => ({ bytes: webpBytes(64, i + 1) }));
    const res = await handleUpload(multiFileRequest(list), stagingEnvWith(bucket));
    assert.equal(res.status, 400, `${n} 個`);
    assert.equal((await res.json()).error.code, "NO_FILE", `${n} 個`);
    assert.equal(totalCalls(bucket), 0, `${n} 個で R2 に触れています`);
  }
});

test("名簿の1件に余分な file を足したら、R2 に触らずに断る", async () => {
  const bucket = createMockR2();
  /* 1件目は名簿の1件と同じ大きさ・種類、2件目は別物。
     先頭だけを採用してしまうと通ってしまうので、そうなっていないことを見る。 */
  const res = await handleUpload(multiFileRequest([
    { bytes: lookalikeBytes(SAMPLE), type: SAMPLE.contentType },
    { bytes: webpBytes(64, 9) }
  ], { category: SAMPLE.category }), stagingEnvWith(bucket));
  assert.equal(res.status, 400, "先頭だけを採用しています");
  assert.equal((await res.json()).error.code, "NO_FILE");
  assert.equal(totalCalls(bucket), 0);
});

/* ================================================================
   7. 削除は、この道が開いていても閉じたまま
   ================================================================ */

test("この道が開いていても、削除は 503 で拒否される", async () => {
  const bucket = createMockR2();
  const env = { ...stagingBatchEnv(), MEDIA_BUCKET: bucket };
  await bucket.put(SAMPLE.key, webpBytes(64), {});
  const before = totalCalls(bucket);

  const res = await handleMediaDelete(new Request(`${ORIGIN}/api/media/item`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: SAMPLE.key })
  }), env);

  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "MUTATIONS_DISABLED");
  assert.equal(totalCalls(bucket), before, "R2 に触れています");
  assert.equal(bucket._store.has(SAMPLE.key), true, "消えています");
  assert.equal(bucket._calls.delete.length, 0);
});

test("削除の判定は、新しい設定をまったく見ていない", () => {
  const src = readFileSync(new URL("../src/lib/mediaDelete.js", import.meta.url), "utf8");
  for (const w of ["MIGRATION_BATCH_MUTATION_ENABLED", "batchEnvAllows", "isBatchUpload",
                   "BATCH_ALLOWLIST", "batch.js"]) {
    assert.equal(src.includes(w), false, `削除が新しい設定を見ています: ${w}`);
  }
  assert.match(src, /if \(!mutationsEnabled\(env\)\) return jsonError\("MUTATIONS_DISABLED"\);/);
});

/* ================================================================
   8. コードの作りそのもの
   ================================================================ */

test("道の判定は R2 のバインディングより前に終わる", () => {
  const src = readFileSync(new URL("../src/lib/upload.js", import.meta.url), "utf8");
  const batchAt = src.indexOf("findBatchTarget(bytes");
  const bucketAt = src.indexOf("const bucket = env && env.MEDIA_BUCKET");
  assert.ok(batchAt >= 0, "batch の判定がありません");
  assert.ok(bucketAt >= 0);
  assert.ok(batchAt < bucketAt, "R2 を見てから判定しています");
});

test("自動でやり直す処理が無い", () => {
  const src = readFileSync(new URL("../src/lib/batch.js", import.meta.url), "utf8");
  for (const w of ["setTimeout", "setInterval", "retry", "while(", "while ("]) {
    assert.equal(src.includes(w), false, `あってはいけない記述: ${w}`);
  }
  /* 判定そのものに繰り返しが無いこと（名簿はキーで1回引くだけ） */
  const judge = src.slice(src.indexOf("export async function isBatchUpload"));
  for (const w of ["for(", "for (", ".forEach(", ".map(", "while("]) {
    assert.equal(judge.includes(w), false, `判定に繰り返しがあります: ${w}`);
  }
});

test("この道のコードに、削除や一覧や通信の経路が無い", () => {
  const src = readFileSync(new URL("../src/lib/batch.js", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const w of [".put(", ".list(", "fetch(", "MEDIA_BUCKET", "bucket"]) {
    assert.equal(code.includes(w), false, `あってはいけない記述: ${w}`);
  }
  /* delete は「索引から重複を外す」1か所だけ（R2 の削除ではない） */
  const deletes = [...code.matchAll(/\.delete\(/g)];
  assert.equal(deletes.length, 1, "delete の使い方が想定と違います");
  assert.match(code, /for \(const c of duplicates\) byComposite\.delete\(c\);/);
});

/* ================================================================
   9. 本物の49件が、実際に通ること

   本物のバイト列は移行パッケージの中にあります。
   まだ作っていない場合（Git 対象外なので普通は無い）は、この確認を飛ばします。
   ================================================================ */

function loadPackageEntries(){
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../migration-package.json", import.meta.url), "utf8"));
    return Array.isArray(pkg.entries) ? pkg.entries : null;
  } catch {
    return null;
  }
}
const PKG_ENTRIES = loadPackageEntries();
const bytesOf = e => new Uint8Array(Buffer.from(e.dataBase64, "base64"));

test("本物の49件は、すべて名簿と一致する", { skip: !PKG_ENTRIES }, async () => {
  const byKey = new Map(PKG_ENTRIES.map(e => [e.key, e]));
  assert.equal(BATCH_ALLOWLIST.length, BATCH_EXPECTED_COUNT);

  for (const a of BATCH_ALLOWLIST) {
    const e = byKey.get(a.key);
    assert.ok(e, `パッケージに無いキーがあります: ${a.key}`);
    const bytes = bytesOf(e);
    assert.equal(bytes.byteLength, a.size, a.key);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), a.sha256, a.key);
    assert.equal(await isBatchUpload(bytes, a.contentType, a.key, a.category), true, a.key);
  }
});

test("本物の canary は、名簿にも無く、この道でも通らない", { skip: !PKG_ENTRIES }, async () => {
  const e = PKG_ENTRIES.find(x => x.key === CANARY.key);
  assert.ok(e, "パッケージに canary がありません");
  const bytes = bytesOf(e);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), CANARY.sha256);
  assert.equal(batchEntryFor(CANARY.key), null);
  assert.equal(await isBatchUpload(bytes, CANARY.contentType, CANARY.key, CANARY.category), false,
    "canary が batch の道で通っています");
});

test("本物の49件を送ると、put はちょうど49回・delete は0回", { skip: !PKG_ENTRIES }, async () => {
  const byKey = new Map(PKG_ENTRIES.map(e => [e.key, e]));
  const bucket = createMockR2();
  const env = stagingEnvWith(bucket);

  for (const a of BATCH_ALLOWLIST) {
    const bytes = bytesOf(byKey.get(a.key));
    const res = await handleUpload(
      uploadRequest(bytes, { type: a.contentType, category: a.category }), env);
    assert.equal(res.status, 201, a.key);
    const body = await res.json();
    assert.equal(body.ok, true, a.key);
    assert.equal(body.key, a.key, "別のキーで保存されています");
  }

  assert.equal(bucket._calls.put.length, BATCH_EXPECTED_COUNT, "put の回数が49ではありません");
  assert.equal(bucket._calls.head.length, BATCH_EXPECTED_COUNT, "head の回数が49ではありません");
  assert.equal(bucket._calls.delete.length, 0, "削除しています");
  assert.equal(bucket._calls.list.length, 0, "一覧を引いています");
  assert.equal(bucket._store.has(CANARY.key), false, "canary を送っています");
});

test("もう一度送っても、重複排除で put は増えない", { skip: !PKG_ENTRIES }, async () => {
  const byKey = new Map(PKG_ENTRIES.map(e => [e.key, e]));
  const bucket = createMockR2();
  const env = stagingEnvWith(bucket);
  const a = BATCH_ALLOWLIST[0];
  const bytes = bytesOf(byKey.get(a.key));
  const req = () => uploadRequest(bytes, { type: a.contentType, category: a.category });

  const first = await handleUpload(req(), env);
  assert.equal(first.status, 201);
  assert.equal(bucket._calls.put.length, 1);

  const again = await handleUpload(req(), env);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).deduped, true);
  assert.equal(bucket._calls.put.length, 1, "put が増えています");
  assert.equal(bucket._calls.delete.length, 0);
});

test("本物の画像でも、道が閉じていれば R2 に触らない", { skip: !PKG_ENTRIES }, async () => {
  const byKey = new Map(PKG_ENTRIES.map(e => [e.key, e]));
  const a = BATCH_ALLOWLIST[0];
  const bytes = bytesOf(byKey.get(a.key));
  for (const over of [{ MIGRATION_BATCH_MUTATION_ENABLED: "false" },
                      { MIGRATION_BATCH_MUTATION_ENABLED: undefined },
                      { MIGRATION_BATCH_MUTATION_ENABLED: "TRUE" },
                      { MIGRATION_CANARY_MUTATION_ENABLED: "true" },
                      { MEDIA_MUTATIONS_ENABLED: "" },
                      { ENVIRONMENT: "local" }]) {
    const bucket = createMockR2();
    const res = await handleUpload(
      uploadRequest(bytes, { type: a.contentType, category: a.category }),
      stagingEnvWith(bucket, over));
    /* canary の抜け道が開いた場合は「見本ではない」として 403、
       それ以外は 503。どちらでも R2 には触れていないことが大事。 */
    assert.ok(res.status === 503 || res.status === 403, JSON.stringify(over));
    assert.equal(totalCalls(bucket), 0, `R2 に触れています: ${JSON.stringify(over)}`);
  }
});

test("本物の画像でも、置き場所を変えたら通らない", { skip: !PKG_ENTRIES }, async () => {
  const byKey = new Map(PKG_ENTRIES.map(e => [e.key, e]));
  const a = BATCH_ALLOWLIST.find(x => x.category !== "other");
  const bytes = bytesOf(byKey.get(a.key));
  const bucket = createMockR2();
  const res = await handleUpload(
    uploadRequest(bytes, { type: a.contentType, category: "other" }), stagingEnvWith(bucket));
  assert.equal(res.status, 403, "キーが変わっても通っています");
  assert.equal((await res.json()).error.code, "NOT_IN_BATCH");
  assert.equal(totalCalls(bucket), 0);
});

test("本物の1件に余分な file を足しても、R2 に触らずに断る", { skip: !PKG_ENTRIES }, async () => {
  const a = BATCH_ALLOWLIST[0];
  const bytes = bytesOf(PKG_ENTRIES.find(e => e.key === a.key));
  const bucket = createMockR2();
  const res = await handleUpload(multiFileRequest([
    { bytes, type: a.contentType },
    { bytes: webpBytes(64, 9) }
  ], { category: a.category }), stagingEnvWith(bucket));
  assert.equal(res.status, 400, "余分があるのに通っています");
  assert.equal((await res.json()).error.code, "NO_FILE");
  assert.equal(totalCalls(bucket), 0);
});

test("ローカル（ふつうの許可）では、これまでどおり動く", async () => {
  const bucket = createMockR2();
  const env = createTestEnv(bucket, { ENVIRONMENT: "local" });
  const res = await worker.fetch(uploadRequest(webpBytes(64, 3)), env, {});
  assert.equal(res.status, 201);
  assert.equal(bucket._calls.put.length, 1);
  assert.equal(bucket._calls.delete.length, 0);
});

/* ================================================================
   10. 指紋が同じで置き場所だけが違う2件

   実データに1組だけあります。同じ画像を gallery と present の
   両方で使っているため、**指紋は同じでキーが違う2件**になります。

   ここで確かめたいこと：
     照合が「指紋で最初の1件を選ぶ」形になっていないこと。
     名簿は **キーを鍵にした Map** で引き、キーは Worker が
     「実バイトの指紋 ＋ 検証済みの category ＋ 拡張子」から
     組み立てたものだけを使います。
     したがって category が決まればキーは一意に決まり、
     gallery として送ったものが present のキーになることはありません。
   ================================================================ */

/* 指紋が同じで、キーが2つある組を名簿から機械的に見つける */
function duplicateShaPairs(){
  const bySha = new Map();
  for (const e of BATCH_ALLOWLIST) {
    if (!bySha.has(e.sha256)) bySha.set(e.sha256, []);
    bySha.get(e.sha256).push(e);
  }
  return [...bySha.values()].filter(list => list.length > 1);
}

test("指紋が同じ2件は、名簿の中で別々の1件として持たれている", () => {
  const pairs = duplicateShaPairs();
  assert.equal(pairs.length, 1, "想定と違う数の重複があります");
  const [pair] = pairs;
  assert.equal(pair.length, 2);

  /* キーは違う。置き場所も違う。指紋・大きさ・種類は同じ。 */
  const [a, b] = pair;
  assert.notEqual(a.key, b.key, "キーが同じです");
  assert.notEqual(a.category, b.category, "置き場所が同じです");
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.size, b.size);
  assert.equal(a.contentType, b.contentType);

  /* それぞれのキーから、**自分自身**が引けること（取り違えていない） */
  assert.equal(batchEntryFor(a.key), a);
  assert.equal(batchEntryFor(b.key), b);
  assert.equal(batchEntryFor(a.key).category, a.category);
  assert.equal(batchEntryFor(b.key).category, b.category);
});

test("名簿の照合は、指紋だけではなく4つ組で引いている", () => {
  const src = readFileSync(new URL("../src/lib/batch.js", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "");

  /* 引くための鍵は、4つ全部を並べたもの */
  assert.match(code, /\[category, contentType, size, sha256\]\.join/,
    "4つ組で引いていません");
  /* 引くのは Map（1回引くだけ。総当たりで探さない） */
  assert.match(code, /index\.byComposite\.get\(/, "索引から引いていません");
  /* 指紋から1件を探す書き方・最初の1件を採る書き方が無い */
  assert.equal(/\.find\(/.test(code), false, "find で1件を選んでいます");
  assert.equal(/\.filter\(/.test(code), false, "絞り込んでから選んでいます");
  assert.equal(/\[0\]/.test(code), false, "最初の1件を採っています");
  /* 重複した4つ組は、索引から外して引けなくする（fail closed） */
  assert.match(code, /for \(const c of duplicates\) byComposite\.delete\(c\);/);
  /* 引けた1件は、4つとも突き合わせ直す */
  for (const re of [/entry\.category !== category/, /entry\.contentType !== mime/,
                    /entry\.size !== bytes\.byteLength/, /entry\.sha256 !== sha256/]) {
    assert.match(code, re);
  }
});

test("名簿の並び順を入れ替えても、キーからの引き当ては変わらない", () => {
  /* 引き当ては「キーを鍵にした Map」なので、
     キーが重複していない限り並び順に左右されません。
     実際の名簿を逆順にして、同じ作り方で引き当てが一致することを確かめます。 */
  const forward = new Map(BATCH_ALLOWLIST.map(e => [e.key, e]));
  const reversed = new Map(BATCH_ALLOWLIST.slice().reverse().map(e => [e.key, e]));
  assert.equal(forward.size, BATCH_ALLOWLIST.length, "キーが重複しています");
  assert.equal(reversed.size, forward.size);
  for (const e of BATCH_ALLOWLIST) {
    assert.equal(reversed.get(e.key), forward.get(e.key), e.key);
    assert.equal(reversed.get(e.key).category, e.category, e.key);
  }
});

test("名簿の作り方も、もとの並び順に左右されない", () => {
  /* 一覧の並びを逆にしても、出来上がる名簿は1文字も変わらない
     （生成スクリプトが key の昇順に並べ直すため） */
  const manifest = createMigrationManifest();
  const reversed = { ...manifest, entries: manifest.entries.slice().reverse() };
  assert.equal(renderAllowlistSource(reversed), renderAllowlistSource(manifest));
});

/* ---- 4つ組による一意特定と、重複したときの fail closed ---- */

test("49件は、4つ組（置き場所・種類・大きさ・指紋）で全件が一意", () => {
  const seen = new Map();
  for (const e of BATCH_ALLOWLIST) {
    const c = compositeOf(e);
    assert.equal(seen.has(c), false,
      `同じ4つ組が2件あります: ${e.key} と ${seen.get(c)}`);
    seen.set(c, e.key);
  }
  assert.equal(seen.size, BATCH_EXPECTED_COUNT);
  /* 索引にも重複が1つも無い */
  assert.equal(BATCH_INDEX_IS_UNIQUE, true, "名簿に重複があります");
  assert.equal(buildBatchIndex(BATCH_ALLOWLIST).duplicates.size, 0);
  assert.equal(buildBatchIndex(BATCH_ALLOWLIST).byComposite.size, BATCH_EXPECTED_COUNT);
});

test("同じ4つ組が2件ある名簿では、その画像は引けなくなる（最初の1件を採らない）", async () => {
  /* わざと「置き場所も種類も大きさも指紋も同じ、キーだけ違う」2件を作る */
  const bytes = webpBytes(64, 11);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const base = { category: "gallery", contentType: "image/webp", size: bytes.byteLength,
                 sha256: sha };
  const dup = [
    { ...base, key: `media/gallery/2026/08/${sha.slice(0, 16)}.webp` },
    { ...base, key: "media/gallery/2026/09/aaaaaaaaaaaaaaaa.webp" }
  ];

  const index = buildBatchIndex(dup);
  assert.equal(index.duplicates.size, 1, "重複を見つけていません");
  assert.equal(index.byComposite.size, 0, "重複した4つ組が引けるままです");

  /* 引こうとしても null（＝403 になる）。どちらか一方が選ばれることは無い。 */
  const found = await findBatchTarget(bytes, "image/webp", "gallery", index);
  assert.equal(found, null, "重複しているのに1件を選んでいます");
});

test("キーだけが重複した名簿でも、fail closed になる", () => {
  const e = { key: "media/gallery/2026/08/aaaaaaaaaaaaaaaa.webp", category: "gallery",
              contentType: "image/webp", size: 10, sha256: "a".repeat(64) };
  const index = buildBatchIndex([e, { ...e, size: 11 }]);
  assert.ok(index.duplicates.has("key:" + e.key), "キーの重複を見つけていません");
});

test("名簿を作るときにも、4つ組の重複があれば作らずに止まる", () => {
  const manifest = createMigrationManifest();
  /* 見本の1枚でない2件を、同じ4つ組にしてしまう（キーだけ変える） */
  const m = JSON.parse(JSON.stringify(manifest));
  const targets = m.entries.filter(e => e.key !== CANARY.key).slice(0, 2);
  const src = targets[0];
  targets[1].category = src.category;
  targets[1].contentType = src.contentType;
  targets[1].size = src.size;
  targets[1].sha256 = src.sha256;
  /* キーだけは形を保ったまま別物にする（先に別の検査で落ちないように） */
  targets[1].key = `media/${src.category}/2026/09/${src.sha256.slice(0, 16)}` +
                   src.key.slice(src.key.lastIndexOf("."));
  assert.throws(() => selectBatchEntries(m), /同じ4つ組の画像が2件あります/);
});

test("4つ組のどれか1つでも違えば、引けない", async () => {
  const [pair] = duplicateShaPairs();
  const e = pair[0];
  const index = buildBatchIndex(BATCH_ALLOWLIST);
  /* 大きさが違うバイト列（指紋も当然変わる）では引けない */
  const wrong = webpBytes(e.size + 1, 3);
  assert.equal(await findBatchTarget(wrong, e.contentType, e.category, index), null);
  /* 種類が違えば引けない */
  const bytes = lookalikeBytes(e);
  assert.equal(await findBatchTarget(bytes, "image/png", e.category, index), null);
  /* 置き場所が違えば引けない */
  assert.equal(await findBatchTarget(bytes, e.contentType, "other", index), null);
  /* バイト列でなければ引けない */
  for (const v of [null, undefined, "text", 123, [], {}]) {
    assert.equal(await findBatchTarget(v, e.contentType, e.category, index), null, String(v));
  }
});

test("キーで引く方法と、4つ組で引く方法の答えが一致する", { skip: !PKG_ENTRIES }, async () => {
  const byKey = new Map(PKG_ENTRIES.map(e => [e.key, e]));
  for (const a of BATCH_ALLOWLIST) {
    const bytes = bytesOf(byKey.get(a.key));
    const found = await findBatchTarget(bytes, a.contentType, a.category);
    assert.equal(found, batchEntryFor(a.key), a.key);
    assert.equal(await isBatchUpload(bytes, a.contentType, a.key, a.category), true, a.key);
  }
});

/* ---- ここから実バイトを使った確認 ---- */

/* ---- 実行する日によって結果が変わらないこと ---- */

/* いまの日時を、指定した日時に見せかけて実行する。
   `new Date()` も `Date.now()` も差し替えます。終わったら必ず元に戻します。 */
async function atUtc(iso, fn){
  const Real = globalThis.Date;
  const fixed = new Real(iso).getTime();
  class Fake extends Real {
    constructor(...args){ if (args.length === 0) super(fixed); else super(...args); }
    static now(){ return fixed; }
  }
  globalThis.Date = Fake;
  try { return await fn(); }
  finally { globalThis.Date = Real; }
}

test("見せかけの日時が、ちゃんと効いていること（道具の確認）", async () => {
  const got = await atUtc("2027-03-04T05:06:07Z", () => new Date().getUTCFullYear());
  assert.equal(got, 2027);
  /* 元に戻っている */
  assert.notEqual(new Date().getUTCFullYear(), 2027);
});

test("名簿のキーは 2026/08 で固定されている", () => {
  for (const e of BATCH_ALLOWLIST) {
    assert.equal(e.key.split("/").slice(2, 4).join("/"), "2026/08", e.key);
  }
});

test("batch の判定と保存先の決定は、現在日時をまったく使わない", () => {
  const src = readFileSync(new URL("../src/lib/batch.js", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const w of ["Date", "getUTCFullYear", "getUTCMonth", "now()", "buildMediaKey"]) {
    assert.equal(code.includes(w), false, `現在日時を使う記述があります: ${w}`);
  }
  /* upload.js の batch 側の枝でも buildMediaKey を呼んでいない */
  const up = readFileSync(new URL("../src/lib/upload.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const branch = up.slice(up.indexOf("if (batchAllowed) {"), up.indexOf("} else {"));
  assert.ok(branch.length > 0, "batch の枝が見つかりません");
  assert.equal(branch.includes("buildMediaKey"), false, "batch でキーを作り直しています");
  assert.match(branch, /key = target\.key;/, "名簿のキーを使っていません");
});

test("いつ送っても、名簿の 2026/08 のキーになる", { skip: !PKG_ENTRIES }, async () => {
  const byKey = new Map(PKG_ENTRIES.map(e => [e.key, e]));
  /* 名簿の先頭・末尾・重複SHAの2件を代表として使う */
  const [pair] = duplicateShaPairs();
  const targets = [BATCH_ALLOWLIST[0], BATCH_ALLOWLIST[BATCH_ALLOWLIST.length - 1], ...pair];

  for (const when of ["2026-08-08T00:00:00Z",   /* いまと同じ月 */
                      "2026-08-31T23:59:59Z",   /* 月の終わり */
                      "2026-09-01T00:00:00Z",   /* 月をまたいだ直後 */
                      "2026-12-31T23:59:59Z",
                      "2027-06-15T12:00:00Z",   /* 年をまたいでも */
                      "2030-01-01T00:00:00Z"]) {
    for (const entry of targets) {
      const bucket = createMockR2();
      const bytes = bytesOf(byKey.get(entry.key));
      const res = await atUtc(when, () => handleUpload(
        uploadRequest(bytes, { type: entry.contentType, category: entry.category }),
        stagingEnvWith(bucket)));

      assert.equal(res.status, 201, `${when} / ${entry.key}`);
      const body = await res.json();
      assert.equal(body.key, entry.key, `${when} に送ると別のキーになります`);
      assert.match(body.key, /\/2026\/08\//, `${when} のキーが 2026/08 ではありません`);
      assert.equal(bucket._calls.put.length, 1, `${when} / ${entry.key}`);
      assert.equal(bucket._calls.put[0].key, entry.key,
        `${when} の保存先が名簿のキーと違います`);
      assert.equal(bucket._calls.delete.length, 0);
    }
  }
});

test("同一SHAの2件は、将来の日付でもそれぞれ正しい固定キーになる",
  { skip: !PKG_ENTRIES }, async () => {
  const [pair] = duplicateShaPairs();
  const byKey = new Map(PKG_ENTRIES.map(e => [e.key, e]));

  for (const when of ["2026-09-01T00:00:00Z", "2027-11-30T23:59:59Z"]) {
    const bucket = createMockR2();
    const env = stagingEnvWith(bucket);
    for (const entry of pair) {
      const res = await atUtc(when, () => handleUpload(
        uploadRequest(bytesOf(byKey.get(entry.key)),
                      { type: entry.contentType, category: entry.category }), env));
      assert.equal(res.status, 201, `${when} / ${entry.category}`);
      assert.equal((await res.json()).key, entry.key,
        `${when} に ${entry.category} として送ったら別のキーになりました`);
    }
    /* 2件とも、それぞれのキーで保存されている（片方に寄っていない） */
    assert.equal(bucket._store.size, 2, when);
    for (const entry of pair) assert.equal(bucket._store.has(entry.key), true, entry.key);
    assert.equal(bucket._calls.delete.length, 0);
  }
});

test("ふつうのアップロードは、これまでどおり現在の年月を使う", async () => {
  /* 通常経路の挙動は変えていません（ここが変わると既存の機能が壊れます） */
  for (const [when, expect] of [["2026-08-08T00:00:00Z", "/2026/08/"],
                                ["2026-09-01T00:00:00Z", "/2026/09/"],
                                ["2027-01-31T23:59:59Z", "/2027/01/"]]) {
    const bucket = createMockR2();
    const env = createTestEnv(bucket, { ENVIRONMENT: "local" });   /* ふつうの許可 */
    const res = await atUtc(when, () =>
      handleUpload(uploadRequest(webpBytes(64, 4)), env));
    assert.equal(res.status, 201, when);
    const body = await res.json();
    assert.ok(body.key.includes(expect), `${when} のキーが ${expect} になっていません（${body.key}）`);
    assert.equal(bucket._calls.put[0].key, body.key, when);
  }
});

test("ふつうの経路のキーの作り方（buildMediaKey）に手を入れていない", () => {
  const src = readFileSync(new URL("../src/lib/mediaKey.js", import.meta.url), "utf8");
  assert.match(src, /export async function buildMediaKey\(bytes, category, ext, now = new Date\(\)\)\{/);
  assert.match(src, /const yyyy = String\(now\.getUTCFullYear\(\)\)\.padStart\(4, "0"\);/);
  assert.match(src, /return `\$\{MEDIA_PREFIX\}\/\$\{category\}\/\$\{yyyy\}\/\$\{mm\}\/\$\{hash\}\.\$\{ext\}`;/);
});

test("指紋が同じ2件を、それぞれの置き場所で送ると、それぞれのキーで保存される",
  { skip: !PKG_ENTRIES }, async () => {
  const [pair] = duplicateShaPairs();
  const byKey = new Map(PKG_ENTRIES.map(e => [e.key, e]));

  for (const entry of pair) {
    const bucket = createMockR2();
    const bytes = bytesOf(byKey.get(entry.key));
    /* 中身は2件とも同じ（指紋が同じなので当然） */
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);

    const res = await handleUpload(
      uploadRequest(bytes, { type: entry.contentType, category: entry.category }),
      stagingEnvWith(bucket));

    assert.equal(res.status, 201, entry.key);
    const body = await res.json();
    assert.equal(body.ok, true, entry.key);
    /* 返ってきたキーが、送った置き場所のキーであること */
    assert.equal(body.key, entry.key, `返ってきたキーが違います（${entry.category}）`);
    /* R2 へ書いた先も、そのキーであること（相手側のキーになっていない） */
    assert.equal(bucket._calls.put.length, 1, entry.key);
    assert.equal(bucket._calls.put[0].key, entry.key,
      `保存先が違います（${entry.category}）`);

    /* もう片方のキーには、1バイトも書いていない */
    const other = pair.find(x => x.key !== entry.key);
    assert.equal(bucket._store.has(other.key), false,
      `${entry.category} として送ったのに ${other.category} のキーに書かれています`);
    assert.equal(bucket._calls.delete.length, 0);
  }
});

test("同じ中身でも、名簿に無い置き場所で送れば通らない", { skip: !PKG_ENTRIES }, async () => {
  const [pair] = duplicateShaPairs();
  const byKey = new Map(PKG_ENTRIES.map(e => [e.key, e]));
  const bytes = bytesOf(byKey.get(pair[0].key));
  const used = new Set(pair.map(e => e.category));

  /* 名簿にある2つ以外の置き場所は、すべて拒否される */
  for (const cat of ["cast", "about", "other", "shop", "logo"]) {
    if (used.has(cat)) continue;
    const bucket = createMockR2();
    const res = await handleUpload(
      uploadRequest(bytes, { type: pair[0].contentType, category: cat }),
      stagingEnvWith(bucket));
    assert.equal(res.status, 403, cat);
    assert.equal((await res.json()).error.code, "NOT_IN_BATCH", cat);
    assert.equal(totalCalls(bucket), 0, `R2 に触れています: ${cat}`);
  }
});

test("置き場所の指定そのものが正しくなければ、名簿を見る前に断る", { skip: !PKG_ENTRIES }, async () => {
  const [pair] = duplicateShaPairs();
  const byKey = new Map(PKG_ENTRIES.map(e => [e.key, e]));
  const bytes = bytesOf(byKey.get(pair[0].key));

  for (const cat of ["", "GALLERY", " gallery ", "../gallery", "gallery/present", "unknown"]) {
    const bucket = createMockR2();
    const res = await handleUpload(
      uploadRequest(bytes, { type: pair[0].contentType, category: cat }),
      stagingEnvWith(bucket));
    assert.equal(res.status, 400, JSON.stringify(cat));
    assert.equal((await res.json()).error.code, "INVALID_CATEGORY", JSON.stringify(cat));
    assert.equal(totalCalls(bucket), 0, `R2 に触れています: ${JSON.stringify(cat)}`);
  }
});

test("同じ中身の2件は、順番を入れ替えて送っても結果が変わらない",
  { skip: !PKG_ENTRIES }, async () => {
  const [pair] = duplicateShaPairs();
  const byKey = new Map(PKG_ENTRIES.map(e => [e.key, e]));

  for (const order of [pair, pair.slice().reverse()]) {
    const bucket = createMockR2();
    const env = stagingEnvWith(bucket);
    const gotKeys = [];
    for (const entry of order) {
      const res = await handleUpload(
        uploadRequest(bytesOf(byKey.get(entry.key)),
                      { type: entry.contentType, category: entry.category }), env);
      assert.equal(res.status, 201, entry.key);
      gotKeys.push((await res.json()).key);
    }
    /* 送った順に、送った置き場所のキーが返る（先に送ったほうに引きずられない） */
    assert.deepEqual(gotKeys, order.map(e => e.key));
    assert.equal(bucket._calls.put.length, 2, "2件とも別のキーで保存されていません");
    assert.equal(bucket._store.size, 2);
    assert.equal(bucket._calls.delete.length, 0);
  }
});
