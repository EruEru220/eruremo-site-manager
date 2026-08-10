/* ================================================================
   ローカルの画像を、ステージングへ移すための下見（dry-run）

   ── いまできること ─────────────────────────────
   このスクリプトは **下見しかしません。**
   実際の移行（ステージングへの書き込み）は**まだ作っていません**。
   `--apply` を付けても、実行せずに終わります。

   ── 下見で確かめること ─────────────────────────
   1. 決めておいた一覧（migration-input.local.json）が50件ちょうどか
   2. 移さないと決めた5件が混ざっていないか
   3. ローカルの保管庫から50件すべて読み出せるか
   4. 中身の指紋（SHA-256）が、一覧に書いたものと**完全に一致**するか
   5. 送る予定の合計サイズ

   ── 絶対にしないこと ───────────────────────────
   ・ステージングへの通信（1回もしません）
   ・保管庫への書き込み・削除
   ・データ（.json / localStorage）の変更
   ・画像URLの付け替え

   ── 使い方 ─────────────────────────────────
     cd worker
     npm run dev            （別の窓で、ローカルの保管庫を起動しておく）
     node scripts/migrate-to-staging.mjs
   ================================================================ */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/* ---- 決めごと（ここを書き換えないと、別の場所へは送れません）---- */
const LOCAL_ORIGIN = "http://127.0.0.1:8787";      /* 読み出し元。ローカルだけ */
const TARGET_BUCKET = "your-media-staging";     /* 送り先の名前（表示用） */
const EXPECTED_COUNT = 50;

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "migration-input.local.json");

/* ---- 実移行はまだ用意していません ---- */
const APPLY_IS_IMPLEMENTED = false;

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const fmt = n => n.toLocaleString("en-US");

let problems = 0;
function check(label, ok, detail){
  console.log(`  ${ok ? "OK  " : "NG  "} ${label}${detail ? "  … " + detail : ""}`);
  if (!ok) problems++;
}

/* ================================================================
   --apply を付けられたとき
   ================================================================ */
const wantsApply = process.argv.includes("--apply");
if (wantsApply && !APPLY_IS_IMPLEMENTED) {
  console.error([
    "",
    "  ✋ 実移行はまだ有効化されていません。",
    "",
    "     このスクリプトは下見（dry-run）だけを行います。",
    "     ステージングへ実際に送る手順は、次が決まってから作ります。",
    "",
    "       ・Cloudflare Access の認証を、どう安全に通すか",
    "       ・MEDIA_MUTATIONS_ENABLED を \"true\" にしてよいか（要承認）",
    "",
    "     --apply を外して、もう一度実行してください。",
    ""
  ].join("\n"));
  process.exit(2);
}

/* ================================================================
   1. 一覧を読む
   ================================================================ */
console.log("=== ステージングへの移行 ― 下見（DRY RUN）===\n");
console.log(`読み出し元 : ${LOCAL_ORIGIN}（ローカルの保管庫）`);
console.log(`送り先     : ${TARGET_BUCKET}（**今回は1回も通信しません**）\n`);

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
} catch {
  console.error("  NG  一覧（migration-input.local.json）が読めません");
  process.exit(1);
}

const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
const excluded = new Set(manifest.excludedKeys || []);

console.log("--- 1. 一覧そのものの確認 ---");
check("件数がちょうど 50 件", entries.length === EXPECTED_COUNT, `${entries.length} 件`);
check("送り先が your-media-staging", manifest.target?.bucket === TARGET_BUCKET,
  String(manifest.target?.bucket));

const dupes = entries.map(e => e.key).filter((k, i, a) => a.indexOf(k) !== i);
check("キーの重複がない", dupes.length === 0, dupes.join(", ") || "重複なし");

const mixed = entries.filter(e => excluded.has(e.key)).map(e => e.key);
check("移さないと決めた5件が混ざっていない", mixed.length === 0,
  mixed.length ? "★混入: " + mixed.join(", ") : `除外 ${excluded.size} 件・混入なし`);

const badShape = entries.filter(e =>
  typeof e.key !== "string" ||
  !/^media\/(?:logo|favicon|og|about|cast|staff|history|shop|present|gallery|other)\/\d{4}\/\d{2}\/[a-f0-9]{16}\.(?:jpg|png|webp)$/.test(e.key) ||
  !/^[a-f0-9]{64}$/.test(String(e.sha256)) ||
  !Number.isInteger(e.size) || e.size <= 0);
check("キーと指紋の形がすべて正しい", badShape.length === 0,
  badShape.map(e => e.key).join(", ") || "全件正常");

const keyHashMismatch = entries.filter(e => e.key.split("/").pop().split(".")[0] !== e.sha256.slice(0, 16));
check("キーの中の指紋と SHA-256 の先頭16桁が一致", keyHashMismatch.length === 0,
  keyHashMismatch.map(e => e.key).join(", ") || "全件一致");

if (problems > 0) {
  console.log(`\n=== 一覧に問題があります（${problems} 件）。ここで中止します。 ===`);
  console.log("  staging requests: 0 / R2 writes: 0 / R2 deletes: 0 / DATA changes: 0");
  process.exit(1);
}

/* ================================================================
   2. ローカルの保管庫から読み出して、指紋を照らし合わせる
   ================================================================ */
console.log("\n--- 2. ローカルの保管庫から読み出して照合 ---");

const results = [];
let readFailures = 0, hashMismatches = 0, sizeMismatches = 0;

for (const e of entries) {
  let res;
  try {
    res = await fetch(`${LOCAL_ORIGIN}/${e.key}`);
  } catch {
    results.push({ ...e, status: "読み出せない（ローカルの保管庫が起動していますか）" });
    readFailures++;
    continue;
  }
  if (!res.ok) {
    results.push({ ...e, status: `読み出せない（HTTP ${res.status}）` });
    readFailures++;
    continue;
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const actual = sha256(buf);
  const okHash = actual === e.sha256;
  const okSize = buf.length === e.size;
  if (!okHash) hashMismatches++;
  if (!okSize) sizeMismatches++;
  results.push({
    ...e, actualSize: buf.length, actualSha: actual,
    status: okHash && okSize ? "一致" : (!okHash ? "★指紋が違う" : "★大きさが違う")
  });
}

check("50件すべて読み出せた", readFailures === 0, `読めなかった: ${readFailures} 件`);
check("指紋（SHA-256）が全件一致", hashMismatches === 0, `不一致: ${hashMismatches} 件`);
check("大きさが全件一致", sizeMismatches === 0, `不一致: ${sizeMismatches} 件`);

/* ================================================================
   3. 送る予定の一覧
   ================================================================ */
console.log("\n--- 3. 送る予定の一覧 ---\n");
console.log("   #  key                                                category  形式  サイズ      指紋(先頭12)  状態");
console.log("  ─────────────────────────────────────────────────────────────────────────────────────────────────");
results.forEach((r, i) => {
  console.log(
    `  ${String(i + 1).padStart(2)}  ${r.key.padEnd(48)}  ${String(r.category).padEnd(8)}  ` +
    `${String(r.fileType).padEnd(4)}  ${fmt(r.size).padStart(9)}  ${r.sha256.slice(0, 12)}  ${r.status}`);
});

const totalBytes = entries.reduce((a, e) => a + e.size, 0);
const byCat = {};
entries.forEach(e => { byCat[e.category] = (byCat[e.category] || 0) + 1; });

console.log("\n--- 4. まとめ ---\n");
console.log(`  送る予定       : ${entries.length} 件`);
console.log(`  合計サイズ     : ${fmt(totalBytes)} B（約 ${(totalBytes / 1024 / 1024).toFixed(2)} MB）`);
console.log(`  内訳           : ${Object.entries(byCat).sort().map(([k, v]) => `${k} ${v}`).join(" / ")}`);
console.log(`  送らないと決めたもの : ${excluded.size} 件`);
excluded.forEach(k => console.log(`      - ${k}`));

/* ================================================================
   4. 結び
   ================================================================ */
const failed = problems > 0 || readFailures > 0 || hashMismatches > 0 || sizeMismatches > 0;

console.log("");
console.log("  ============================================");
console.log("   DRY RUN");
console.log("   staging requests: 0");
console.log("   R2 writes: 0");
console.log("   R2 deletes: 0");
console.log("   DATA changes: 0");
console.log("  ============================================");
console.log("");

if (failed) {
  console.log("  ⚠ 問題が見つかりました。上の NG を確認してください。");
  process.exit(1);
}
console.log("  下見はすべて期待どおりでした。");
console.log("  実際の移行は、まだ有効化していません（--apply を付けても実行されません）。");
console.log("");
