/* ================================================================
   ステージングへ運ぶ「移行パッケージ」を1つのファイルに書き出す

   ── なにをするか ───────────────────────────────
   決めておいた一覧（migration-input.local.json）の50件を、
   ローカルの保管庫から読み出して、**1個の JSON ファイル**にまとめます。

   できたファイルを、認証済みのブラウザでステージングの編集ツールから
   選んで読み込む、という流れです。

   ── なぜ JSON なのか ──────────────────────────
   ・合計 約3.3MB と小さい
   ・ブラウザの標準機能だけで中身を確かめられる（新しい部品が要らない）
   ・zip のように「展開する処理」を別に作らなくてよい

   ── 絶対にしないこと ───────────────────────────
   ・ステージングへの通信（1回もしません）
   ・保管庫への書き込み・削除
   ・データ（.json / localStorage）の変更
   ・秘密情報を入れること（下の「入れないもの」を参照）

   ── 入れないもの（絶対に） ──────────────────────
   Access の Cookie ／ ACCESS_AUD ／ ALLOWED_EMAIL ／ アカウントID ／
   Cloudflare のトークン ／ Secret ／ 支払い情報
   入れるのは **画像そのものと、移行に必要な秘密でない情報だけ**です。

   ── 使い方 ─────────────────────────────────
     cd worker
     npm run dev            （別の窓で、ローカルの保管庫を起動しておく）
     node scripts/build-migration-package.mjs

   できあがり： worker/migration-package.json（Git には入りません）
   ================================================================ */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/* ---- 決めごと ---- */
const LOCAL_ORIGIN = "http://127.0.0.1:8787";
const TARGET_BUCKET = "your-media-staging";
const SCHEMA_VERSION = 1;
const PURPOSE = "eruremo-staging-media-migration";
const EXPECTED_COUNT = 50;
const MAX_DECODED_BYTES = 10 * 1024 * 1024;   /* 中身の合計の上限 */

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "migration-input.local.json");
const OUT_PATH = join(dirname(here), "migration-package.json");

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const fmt = n => n.toLocaleString("en-US");

/* 途中でおかしなことがあれば、その場で作るのをやめる */
function abort(message){
  console.error(`\n  ✋ 中止しました：${message}`);
  console.error("     移行パッケージは作られていません。");
  console.error("     staging requests: 0 / R2 writes: 0 / R2 deletes: 0 / DATA changes: 0\n");
  process.exit(1);
}

console.log("=== 移行パッケージの書き出し ===\n");
console.log(`読み出し元 : ${LOCAL_ORIGIN}（ローカルの保管庫）`);
console.log(`書き出し先 : ${OUT_PATH}`);
console.log(`送り先の名前 : ${TARGET_BUCKET}（**今回は1回も通信しません**）\n`);

/* ================================================================
   1. 一覧を読んで、形を確かめる
   ================================================================ */
let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
} catch {
  abort("一覧（migration-input.local.json）が読めません");
}

const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
const excluded = new Set(manifest.excludedKeys || []);

if (entries.length !== EXPECTED_COUNT) abort(`一覧が ${EXPECTED_COUNT} 件ではありません（${entries.length} 件）`);
if (manifest.target?.bucket !== TARGET_BUCKET) abort("一覧の送り先が違います");

const dupes = entries.map(e => e.key).filter((k, i, a) => a.indexOf(k) !== i);
if (dupes.length) abort(`キーが重複しています：${dupes.join(", ")}`);

const mixed = entries.filter(e => excluded.has(e.key)).map(e => e.key);
if (mixed.length) abort(`移さないと決めたキーが混ざっています：${mixed.join(", ")}`);

const KEY_RE = /^media\/(?:logo|favicon|og|about|cast|staff|history|shop|present|gallery|other)\/\d{4}\/\d{2}\/[a-f0-9]{16}\.(?:jpg|png|webp)$/;
for (const e of entries) {
  if (!KEY_RE.test(String(e.key))) abort(`キーの形が正しくありません：${e.key}`);
  if (!/^[a-f0-9]{64}$/.test(String(e.sha256))) abort(`指紋の形が正しくありません：${e.key}`);
  if (!Number.isInteger(e.size) || e.size <= 0) abort(`大きさが正しくありません：${e.key}`);
  if (e.key.split("/").pop().split(".")[0] !== e.sha256.slice(0, 16)) {
    abort(`キーの中の指紋と SHA-256 が食い違っています：${e.key}`);
  }
}
console.log(`--- 1. 一覧の確認 ---\n  OK  ${entries.length} 件・重複なし・除外 ${excluded.size} 件の混入なし\n`);

/* ================================================================
   2. ローカルの保管庫から読み出して、指紋を照らし合わせる
   ================================================================ */
console.log("--- 2. 読み出しと照合 ---");
const packed = [];
let decodedTotal = 0;

for (const e of entries) {
  let res;
  try {
    res = await fetch(`${LOCAL_ORIGIN}/${e.key}`);
  } catch {
    abort(`読み出せません（ローカルの保管庫は起動していますか）：${e.key}`);
  }
  if (!res.ok) abort(`読み出せません（HTTP ${res.status}）：${e.key}`);

  const bytes = new Uint8Array(await res.arrayBuffer());

  /* 書き出す直前に、もう一度この場で指紋を計算して確かめる */
  const actual = sha256(bytes);
  if (actual !== e.sha256) abort(`指紋が一致しません：${e.key}`);
  if (bytes.length !== e.size) abort(`大きさが一致しません：${e.key}（${bytes.length} B）`);

  decodedTotal += bytes.length;
  if (decodedTotal > MAX_DECODED_BYTES) {
    abort(`中身の合計が上限（${fmt(MAX_DECODED_BYTES)} B）を超えました`);
  }

  packed.push({
    key: e.key,
    category: e.category,
    contentType: e.contentType,
    size: bytes.length,
    sha256: actual,
    dataBase64: Buffer.from(bytes).toString("base64")
  });
}
console.log(`  OK  ${packed.length} 件すべて読み出し・指紋一致・大きさ一致\n`);

/* ================================================================
   3. 合計の確認
   ================================================================ */
const totalBytes = packed.reduce((a, e) => a + e.size, 0);
if (totalBytes !== manifest.totalBytes) {
  abort(`合計サイズが一覧と違います（一覧 ${fmt(manifest.totalBytes)} B / 実際 ${fmt(totalBytes)} B）`);
}

/* ================================================================
   4. 書き出す
   ================================================================ */
const pkg = {
  schemaVersion: SCHEMA_VERSION,
  purpose: PURPOSE,
  createdAt: new Date().toISOString(),
  targetBucket: TARGET_BUCKET,
  entryCount: packed.length,
  totalBytes,
  entries: packed
};

const text = JSON.stringify(pkg);
writeFileSync(OUT_PATH, text, "utf8");

console.log("--- 3. 書き出しました ---\n");
console.log(`  件数           : ${packed.length} 件`);
console.log(`  中身の合計     : ${fmt(totalBytes)} B（約 ${(totalBytes / 1024 / 1024).toFixed(2)} MB）`);
console.log(`  ファイルの大きさ : ${fmt(Buffer.byteLength(text, "utf8"))} B（約 ${(Buffer.byteLength(text, "utf8") / 1024 / 1024).toFixed(2)} MB）`);
console.log(`  置き場所       : ${OUT_PATH}`);
console.log("");
console.log("  ============================================");
console.log("   staging requests: 0");
console.log("   R2 writes: 0");
console.log("   R2 deletes: 0");
console.log("   DATA changes: 0");
console.log("  ============================================");
console.log("");
console.log("  このファイルは Git に入りません（.gitignore 済み）。");
console.log("  ステージングの編集ツールから「📦 移行パッケージを確認する」で読み込んでください。");
console.log("");
