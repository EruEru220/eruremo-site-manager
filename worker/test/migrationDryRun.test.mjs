/* ================================================================
   移行スクリプト（下見・dry-run）のテスト

   確かめること：
   - 一覧（マニフェスト）が50件で、除外5件が混ざっていない
   - --apply を付けても、**実移行が始まらない**
   - スクリプトの中に、ステージングへ書き込む経路が**存在しない**
   - delete を呼ぶ経路が**存在しない**
   - 指紋（SHA-256）が合わなければ失敗する
   - 除外した5件が混ざったら失敗する

   ネットワークには出ません（スクリプトを読む・切り出して動かすだけ）。
   ================================================================ */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createMigrationManifest } from "./helpers/migrationManifest.mjs";

const SCRIPT_PATH = new URL("../scripts/migrate-to-staging.mjs", import.meta.url);
const SRC = readFileSync(SCRIPT_PATH, "utf8");
const MANIFEST = createMigrationManifest();

/* 「やらないこと」を説明した文章まで拾ってしまわないよう、
   コード部分だけを見るためにブロックコメントを取り除く。 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "");

const KEY_RE = /^media\/(?:logo|favicon|og|about|cast|staff|history|shop|present|gallery|other)\/\d{4}\/\d{2}\/[a-f0-9]{16}\.(?:jpg|png|webp)$/;

/* ================================================================
   1. 一覧（マニフェスト）
   ================================================================ */

test("一覧はちょうど50件", () => {
  assert.equal(MANIFEST.entries.length, 50);
  assert.equal(MANIFEST.totalCount, 50);
});

test("送り先はステージングのバケットに固定", () => {
  assert.equal(MANIFEST.target.bucket, "your-media-staging");
});

test("移さないと決めた5件が、送る一覧に混ざっていない", () => {
  const excluded = new Set(MANIFEST.excludedKeys);
  assert.equal(excluded.size, 5, "除外は5件です");
  for (const e of MANIFEST.entries) {
    assert.equal(excluded.has(e.key), false, `混ざっています: ${e.key}`);
  }
});

test("キーの重複がない", () => {
  const keys = MANIFEST.entries.map(e => e.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("すべてのキーと指紋の形が正しい", () => {
  for (const e of MANIFEST.entries) {
    assert.match(e.key, KEY_RE, e.key);
    assert.match(e.sha256, /^[a-f0-9]{64}$/, e.key);
    assert.ok(Number.isInteger(e.size) && e.size > 0, e.key);
  }
});

test("キーの中の指紋と SHA-256 の先頭16桁が一致する", () => {
  for (const e of MANIFEST.entries) {
    assert.equal(e.key.split("/").pop().split(".")[0], e.sha256.slice(0, 16), e.key);
  }
});

test("全件に使用箇所が記録されている", () => {
  for (const e of MANIFEST.entries) {
    assert.ok(Array.isArray(e.usedAt) && e.usedAt.length > 0, `使用箇所がありません: ${e.key}`);
  }
});

test("合計サイズが一致している", () => {
  const sum = MANIFEST.entries.reduce((a, e) => a + e.size, 0);
  assert.equal(sum, MANIFEST.totalBytes);
});

test("一覧に秘密情報・個人情報が入っていない", () => {
  const raw = JSON.stringify(MANIFEST);
  assert.equal(/[\w.+-]+@[\w-]+\.[\w.-]+/.test(raw), false, "メールアドレスが入っています");
  assert.equal(/cloudflareaccess\.com/.test(raw), false);
  assert.equal(/workers\.dev/.test(raw), false);
});

/* ================================================================
   2. スクリプトの作り（危ない経路が存在しないこと）
   ================================================================ */

test("既定は下見（dry-run）である", () => {
  assert.match(SRC, /const APPLY_IS_IMPLEMENTED = false;/,
    "実移行が有効になっています");
});

test("--apply を付けても実移行に進まない", () => {
  const guard = SRC.indexOf("wantsApply && !APPLY_IS_IMPLEMENTED");
  assert.ok(guard >= 0, "--apply を止める分岐がありません");
  const after = SRC.slice(guard, guard + 900);
  assert.match(after, /実移行はまだ有効化されていません/);
  assert.match(after, /process\.exit\(2\)/, "終了していません");
});

test("ステージングへ書き込む経路が存在しない", () => {
  /* 送信に使われる語が、コード中に1つも無いこと */
  for (const forbidden of ["method: \"POST\"", "method:\"POST\"",
                           "method: \"PUT\"", "method:\"PUT\"",
                           "method: \"DELETE\"", "method:\"DELETE\"",
                           "FormData", "/api/media/upload", "/api/media/item",
                           "r2 object put", "bucket.put", "bucket.delete"]) {
    assert.equal(CODE.includes(forbidden), false, `書き込みの経路があります: ${forbidden}`);
  }
});

test("削除の経路が存在しない", () => {
  for (const forbidden of ["delete(", "DELETE", "trash/", ".delete"]) {
    assert.equal(CODE.includes(forbidden), false, `削除に関わる記述があります: ${forbidden}`);
  }
});

test("通信先はローカルだけ", () => {
  const urls = [...SRC.matchAll(/https?:\/\/[^\s"'`)]+/g)].map(m => m[0]);
  for (const u of urls) {
    assert.match(u, /^http:\/\/127\.0\.0\.1:8787/, `ローカル以外へ通信しようとしています: ${u}`);
  }
  assert.equal(SRC.includes("workers.dev"), false, "ステージングの住所が書かれています");
  assert.equal(SRC.includes("cloudflareaccess"), false);
});

test("fetch はローカルの読み出しの1か所だけ", () => {
  const calls = [...SRC.matchAll(/await fetch\(/g)].length;
  assert.equal(calls, 1, `fetch が ${calls} か所あります（1か所にしてください）`);
  assert.match(SRC, /await fetch\(`\$\{LOCAL_ORIGIN\}\/\$\{e\.key\}`\)/);
});

test("データや画像URLを書き換える経路が存在しない", () => {
  for (const forbidden of ["writeFileSync", "appendFileSync", "rmSync", "unlinkSync",
                           "localStorage", "rebaseMediaUrls", "toR2Mode"]) {
    assert.equal(CODE.includes(forbidden), false, `データを変える記述があります: ${forbidden}`);
  }
  /* 読むのは一覧だけ */
  assert.match(CODE, /readFileSync\(MANIFEST_PATH, "utf8"\)/);
});

test("送り先とバケット名がコードに固定されている", () => {
  assert.match(SRC, /const TARGET_BUCKET = "your-media-staging";/);
  assert.match(SRC, /const LOCAL_ORIGIN = "http:\/\/127\.0\.0\.1:8787";/);
  assert.match(SRC, /const EXPECTED_COUNT = 50;/);
});

test("最後に DRY RUN の結果を必ず出す", () => {
  for (const line of ["DRY RUN", "staging requests: 0", "R2 writes: 0",
                      "R2 deletes: 0", "DATA changes: 0"]) {
    assert.ok(SRC.includes(line), `表示がありません: ${line}`);
  }
});

/* ================================================================
   3. 判定のしくみ（切り出して動かす）

   スクリプト本体は実行すると通信するので、
   ここでは「判定の式」だけを取り出して確かめます。
   ================================================================ */

const sha256 = b => createHash("sha256").update(b).digest("hex");

/* スクリプトと同じ判定を、テスト側で再現する */
function judge(entries, excludedKeys, files){
  const excluded = new Set(excludedKeys);
  const problems = [];
  if (entries.length !== 50) problems.push("件数が50件ではない");
  if (new Set(entries.map(e => e.key)).size !== entries.length) problems.push("キーが重複");
  if (entries.some(e => excluded.has(e.key))) problems.push("除外したキーが混入");
  if (entries.some(e => !KEY_RE.test(e.key))) problems.push("キーの形が不正");
  if (entries.some(e => e.key.split("/").pop().split(".")[0] !== e.sha256.slice(0, 16)))
    problems.push("キーと指紋が食い違う");
  for (const e of entries) {
    const buf = files.get(e.key);
    if (!buf) { problems.push(`読み出せない: ${e.key}`); continue; }
    if (sha256(buf) !== e.sha256) problems.push(`指紋が違う: ${e.key}`);
    if (buf.length !== e.size) problems.push(`大きさが違う: ${e.key}`);
  }
  return problems;
}

/* 50件ぶんの、つじつまの合った一覧とファイルを作る */
function makeCase(){
  const entries = [], files = new Map();
  for (let i = 0; i < 50; i++) {
    const buf = Buffer.from(`image-${i}`);
    const full = sha256(buf);
    const key = `media/gallery/2026/08/${full.slice(0, 16)}.png`;
    entries.push({ key, category: "gallery", fileType: "png", size: buf.length, sha256: full, usedAt: ["a"] });
    files.set(key, buf);
  }
  return { entries, files, excluded: ["media/other/2026/08/aaaaaaaaaaaaaaaa.png"] };
}

test("つじつまが合っていれば問題なし", () => {
  const c = makeCase();
  assert.deepEqual(judge(c.entries, c.excluded, c.files), []);
});

test("件数が50件でなければ失敗", () => {
  const c = makeCase();
  c.entries.pop();
  assert.ok(judge(c.entries, c.excluded, c.files).includes("件数が50件ではない"));
});

test("除外したキーが混ざったら失敗", () => {
  const c = makeCase();
  const buf = Buffer.from("excluded");
  const key = c.excluded[0];
  c.entries[0] = { key, category: "other", fileType: "png", size: buf.length, sha256: sha256(buf), usedAt: ["a"] };
  c.files.set(key, buf);
  assert.ok(judge(c.entries, c.excluded, c.files).includes("除外したキーが混入"));
});

test("指紋が合わなければ失敗", () => {
  const c = makeCase();
  c.files.set(c.entries[0].key, Buffer.from("すりかえた中身"));
  const p = judge(c.entries, c.excluded, c.files);
  assert.ok(p.some(x => x.startsWith("指紋が違う")), p.join(" / "));
});

test("大きさが合わなければ失敗", () => {
  const c = makeCase();
  c.entries[0].size = c.entries[0].size + 1;
  const p = judge(c.entries, c.excluded, c.files);
  assert.ok(p.some(x => x.startsWith("大きさが違う")), p.join(" / "));
});

test("読み出せなければ失敗", () => {
  const c = makeCase();
  c.files.delete(c.entries[0].key);
  const p = judge(c.entries, c.excluded, c.files);
  assert.ok(p.some(x => x.startsWith("読み出せない")), p.join(" / "));
});

test("キーと指紋が食い違えば失敗", () => {
  const c = makeCase();
  c.entries[0].key = "media/gallery/2026/08/0000000000000000.png";
  const p = judge(c.entries, c.excluded, c.files);
  assert.ok(p.includes("キーと指紋が食い違う"), p.join(" / "));
});

test("キーが重複したら失敗", () => {
  const c = makeCase();
  c.entries[1] = { ...c.entries[0] };
  assert.ok(judge(c.entries, c.excluded, c.files).includes("キーが重複"));
});

/* ================================================================
   4. 実物の一覧でも、判定が通ること
   ================================================================ */

test("実物の一覧は、形の検査をすべて通る", () => {
  const excluded = new Set(MANIFEST.excludedKeys);
  assert.equal(MANIFEST.entries.length, 50);
  assert.equal(MANIFEST.entries.some(e => excluded.has(e.key)), false);
  assert.equal(MANIFEST.entries.every(e => KEY_RE.test(e.key)), true);
  assert.equal(
    MANIFEST.entries.every(e => e.key.split("/").pop().split(".")[0] === e.sha256.slice(0, 16)), true);
});
