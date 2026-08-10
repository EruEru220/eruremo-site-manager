/* ================================================================
   残り49件の「許可名簿（allowlist）」のテスト

   確かめること：
   - 名簿は一覧（migration-input.local.json）から**作り直しても1文字も変わらない**
   - 件数がちょうど49件（50件 − 見本の1枚）
   - **見本の1枚（canary）が入っていない**
   - 移さないと決めた5件も入っていない
   - 重複がない／並びが key の昇順で決まっている
   - キー・指紋・大きさ・種類・置き場所のつじつまが全件合っている
   - 名簿に画像の中身（Base64）が入っていない
   - 一覧が壊れていたら、名簿を作らずに止まる

   本物の R2 にも Cloudflare にも接続しません（ファイルを読むだけ）。
   ================================================================ */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BATCH_ALLOWLIST } from "../src/lib/batchAllowlist.generated.js";
import { CANARY } from "../src/lib/canary.js";
import { BATCH_EXPECTED_COUNT } from "../src/lib/batch.js";
import { createMigrationManifest } from "./helpers/migrationManifest.mjs";
import {
  renderAllowlistSource, selectBatchEntries,
  MANIFEST_COUNT, ALLOWLIST_COUNT, ALLOWLIST_FIELDS,
  OUTPUT_PATH
} from "../scripts/build-batch-allowlist.mjs";

const MANIFEST = createMigrationManifest();
/* 改行の違い（CRLF / LF）は中身の違いではないので、そろえてから比べる */
const lf = s => s.replace(/\r\n/g, "\n");

/* ================================================================
   1. 作り直しても同じであること（＝人が手で書き換えていない）
   ================================================================ */

test("名簿は、一覧から作り直したものと完全に一致する", () => {
  const regenerated = renderAllowlistSource(MANIFEST);
  const onDisk = readFileSync(OUTPUT_PATH, "utf8");
  assert.equal(lf(onDisk), lf(regenerated),
    "名簿が一覧と食い違っています。node scripts/build-batch-allowlist.mjs で作り直してください");
});

test("何度作っても同じ中身になる（並びが決まっている）", () => {
  assert.equal(renderAllowlistSource(MANIFEST), renderAllowlistSource(MANIFEST));
});

test("並びは key の昇順に固定されている", () => {
  const keys = BATCH_ALLOWLIST.map(e => e.key);
  assert.deepEqual(keys, keys.slice().sort(), "key の昇順になっていません");
});

/* ================================================================
   2. 件数と、見本の1枚
   ================================================================ */

test("一覧はちょうど50件、名簿はちょうど49件", () => {
  assert.equal(MANIFEST.entries.length, MANIFEST_COUNT);
  assert.equal(ALLOWLIST_COUNT, 49);
  assert.equal(BATCH_ALLOWLIST.length, 49);
  assert.equal(BATCH_EXPECTED_COUNT, 49);
  assert.equal(BATCH_ALLOWLIST.length, MANIFEST.entries.length - 1);
});

test("見本の1枚（canary）は名簿に入っていない", () => {
  assert.equal(BATCH_ALLOWLIST.some(e => e.key === CANARY.key), false,
    "canary が名簿に混ざっています");
  assert.equal(BATCH_ALLOWLIST.some(e => e.sha256 === CANARY.sha256), false,
    "canary の指紋が名簿に混ざっています");
});

test("名簿 ＋ 見本の1枚 ＝ 一覧そのもの（引き算しかしていない）", () => {
  const fromManifest = MANIFEST.entries.map(e => e.key).sort();
  const rebuilt = [...BATCH_ALLOWLIST.map(e => e.key), CANARY.key].sort();
  assert.deepEqual(rebuilt, fromManifest);
});

test("移さないと決めた5件は名簿に入っていない", () => {
  assert.equal(MANIFEST.excludedKeys.length, 5);
  for (const k of MANIFEST.excludedKeys) {
    assert.equal(BATCH_ALLOWLIST.some(e => e.key === k), false, `除外キーが入っています: ${k}`);
  }
});

test("同じキーが二重に入っていない", () => {
  const keys = BATCH_ALLOWLIST.map(e => e.key);
  assert.equal(new Set(keys).size, keys.length, "同じキーが二重に入っています");
});

test("同じ指紋が2件あるときは、置き場所だけが違う（別のキー）", () => {
  /* 同じ画像を2つの置き場所で使っていると、指紋は同じでキーが違う
     2件になります（例：gallery と present）。これは正しい状態です。
     ただし「指紋もキーも同じ」が2件あってはいけません。 */
  const bySha = new Map();
  for (const e of BATCH_ALLOWLIST) {
    if (!bySha.has(e.sha256)) bySha.set(e.sha256, []);
    bySha.get(e.sha256).push(e);
  }
  for (const [sha, list] of bySha) {
    if (list.length === 1) continue;
    const cats = list.map(e => e.category);
    assert.equal(new Set(cats).size, cats.length, `置き場所まで同じものが2件あります: ${sha}`);
    for (const e of list) {
      /* キーの指紋の部分は同じ、置き場所の部分だけが違う */
      assert.equal(e.key.split("/").pop(), list[0].key.split("/").pop(), sha);
    }
  }
});

/* ================================================================
   3. 1件ずつの中身
   ================================================================ */

const KEY_RE = /^media\/(?:logo|favicon|og|about|cast|staff|history|shop|present|gallery|other)\/\d{4}\/\d{2}\/[a-f0-9]{16}\.(?:jpg|png|webp)$/;
const EXT_TYPE = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

test("49件すべてが、一覧の値とそのまま一致する", () => {
  const byKey = new Map(MANIFEST.entries.map(e => [e.key, e]));
  for (const e of BATCH_ALLOWLIST) {
    const src = byKey.get(e.key);
    assert.ok(src, `一覧に無いキーがあります: ${e.key}`);
    assert.equal(e.category, src.category, e.key);
    assert.equal(e.contentType, src.contentType, e.key);
    assert.equal(e.size, src.size, e.key);
    assert.equal(e.sha256, src.sha256, e.key);
  }
});

test("キー・指紋・大きさ・種類・置き場所のつじつまが合っている", () => {
  for (const e of BATCH_ALLOWLIST) {
    assert.match(e.key, KEY_RE, e.key);
    assert.match(e.sha256, /^[a-f0-9]{64}$/, e.key);
    assert.equal(e.key.split("/")[1], e.category, e.key);
    assert.equal(e.key.split("/").pop().split(".")[0], e.sha256.slice(0, 16), e.key);
    const ext = e.key.slice(e.key.lastIndexOf(".") + 1);
    assert.equal(e.contentType, EXT_TYPE[ext], e.key);
    assert.ok(Number.isInteger(e.size) && e.size > 0, e.key);
  }
});

test("名簿に載っているのは5つの項目だけ（画像の中身は入っていない）", () => {
  for (const e of BATCH_ALLOWLIST) {
    assert.deepEqual(Object.keys(e).sort(), [...ALLOWLIST_FIELDS].sort(), e.key);
  }
  const raw = readFileSync(OUTPUT_PATH, "utf8");
  for (const w of ["dataBase64", "base64", "data:image"]) {
    assert.equal(raw.includes(w), false, `名簿に画像の中身が入っています: ${w}`);
  }
});

test("名簿は書き換えられないように凍らせてある", () => {
  assert.equal(Object.isFrozen(BATCH_ALLOWLIST), true);
  for (const e of BATCH_ALLOWLIST) assert.equal(Object.isFrozen(e), true, e.key);
});

/* ================================================================
   4. 一覧が壊れていたら、名簿を作らない
   ================================================================ */

const clone = () => JSON.parse(JSON.stringify(MANIFEST));

test("一覧が50件でなければ作らない", () => {
  const m = clone(); m.entries.pop();
  assert.throws(() => selectBatchEntries(m), /50 件ではありません/);
});

test("移さないと決めたキーが混ざっていたら作らない", () => {
  const m = clone();
  m.entries[0].key = m.excludedKeys[0];
  assert.throws(() => selectBatchEntries(m), /移さないと決めたキー|キーと指紋/);
});

test("同じキーが2回出てきたら作らない", () => {
  const m = clone();
  m.entries[1] = { ...m.entries[0] };
  assert.throws(() => selectBatchEntries(m), /同じキーが2回/);
});

test("キーと指紋のつじつまが合わなければ作らない", () => {
  const m = clone();
  m.entries[0].sha256 = "0".repeat(64);
  assert.throws(() => selectBatchEntries(m), /つじつま/);
});

test("種類が食い違っていたら作らない", () => {
  const m = clone();
  m.entries[0].contentType = "text/html";
  assert.throws(() => selectBatchEntries(m), /種類が食い違って/);
});

test("置き場所が食い違っていたら作らない", () => {
  const m = clone();
  m.entries[0].category = "other";
  assert.throws(() => selectBatchEntries(m), /置き場所が食い違って/);
});

test("大きさが正しくなければ作らない", () => {
  for (const v of [0, -1, 1.5, "100", null]) {
    const m = clone();
    m.entries[0].size = v;
    assert.throws(() => selectBatchEntries(m), /大きさが正しくありません/, String(v));
  }
});

test("一覧に見本の1枚が無ければ作らない（49件になってしまうため）", () => {
  const m = clone();
  const i = m.entries.findIndex(e => e.key === CANARY.key);
  assert.ok(i >= 0);
  m.entries.splice(i, 1);
  assert.throws(() => selectBatchEntries(m), /50 件ではありません/);
});

test("引き算する1枚を別のキーにすると、件数が合わずに止まる", () => {
  assert.throws(() => selectBatchEntries(MANIFEST, "media/gallery/2026/08/0123456789abcdef.webp"),
    /見本の1枚がありません/);
});

/* ================================================================
   5. 生成スクリプトそのもの
   ================================================================ */

test("生成スクリプトは通信も R2 操作もしない", () => {
  const src = readFileSync(new URL("../scripts/build-batch-allowlist.mjs", import.meta.url), "utf8");
  for (const w of ["fetch(", "MEDIA_BUCKET", ".put(", ".delete(", "wrangler", "setTimeout"]) {
    assert.equal(src.includes(w), false, `あってはいけない記述: ${w}`);
  }
});

test("名簿の値は、一覧から取ったものだけ（スクリプトに直接書かれていない）", () => {
  const src = readFileSync(new URL("../scripts/build-batch-allowlist.mjs", import.meta.url), "utf8");
  /* 64桁の指紋がスクリプト本体に書かれていないこと（人の手入力の跡） */
  assert.equal(/[a-f0-9]{64}/.test(src), false, "指紋が直接書かれています");
  /* 画像のキーも書かれていないこと（canary はコードから読み込む） */
  assert.equal(/media\/[a-z]+\/\d{4}\/\d{2}\/[a-f0-9]{16}\./.test(src), false,
    "画像のキーが直接書かれています");
});
