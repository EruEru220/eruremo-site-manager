/* ================================================================
   残り49件の「許可名簿（allowlist）」を、一覧から**機械的に**作る

   なぜ要るのか：
     残り49件を送るには、Worker 側が「この49件だけ」を見分ける必要が
     あります。その49件を**人が手で書き写すと、必ず写しまちがえます**。
     写しまちがえた1件は、永久に送れないか、あるいは
     送るべきでないものを通してしまいます。

     そこで、決めておいた一覧（migration-input.local.json）から
     見本の1枚（canary）を**引き算するだけ**で名簿を作ります。
     人が値を入力する場所は、どこにもありません。

   作られるもの：
     worker/src/lib/batchAllowlist.generated.js
       key / category / contentType / size / sha256 の5つだけを持つ
       49件の凍った配列。**画像の中身は入りません。**

   決まりごと：
     ・並び順は key の昇順に固定します（何度作っても同じ中身になる）。
     ・見本の1枚（canary）は必ず除きます。そのキーは src/lib/canary.js から
       読み込みます（**このファイルには1件も書き写しません**）。
     ・移さないと決めた5件（excludedKeys）が混ざっていたら、作らずに止まります。
     ・キーの形・指紋の形・キーと指紋のつじつまを、1件ずつ確かめます。
     ・Worker が1件を特定するのに使う「4つ組」
       （category ＋ contentType ＋ size ＋ sha256）が**全件で一意**であることを
       確かめます。1組でも重複していたら、**名簿を作らずに止まります**。
     ・作られたファイルが一覧と食い違っていないことは、
       worker/test/batchAllowlist.test.mjs が**作り直して突き合わせて**確かめます。

   使い方：
     cd worker
     node scripts/build-batch-allowlist.mjs

   ⚠ このスクリプトは通信を1回もしません。R2 にも触りません。
   ================================================================ */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CANARY } from "../src/lib/canary.js";

/* 一覧の総数と、そこから canary を引いた数 */
export const MANIFEST_COUNT = 50;
export const ALLOWLIST_COUNT = 49;

/* 名簿に載せてよい項目は、この5つだけ（画像の中身は載せません） */
export const ALLOWLIST_FIELDS = Object.freeze(["key", "category", "contentType", "size", "sha256"]);

const KEY_RE = /^media\/(?:logo|favicon|og|about|cast|staff|history|shop|present|gallery|other)\/\d{4}\/\d{2}\/[a-f0-9]{16}\.(?:jpg|png|webp)$/;
const EXT_TYPE = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

export const MANIFEST_PATH = new URL("./migration-input.local.json", import.meta.url);
export const OUTPUT_PATH   = new URL("../src/lib/batchAllowlist.generated.js", import.meta.url);

/**
 * 一覧から、canary を除いた49件を選び出す。
 * おかしなところが1つでもあれば、例外を投げて**何も作りません**。
 */
export function selectBatchEntries(manifest, canaryKey = CANARY.key){
  if (!manifest || !Array.isArray(manifest.entries)) throw new Error("一覧の形が違います");
  const entries = manifest.entries;
  if (entries.length !== MANIFEST_COUNT) {
    throw new Error(`一覧が ${MANIFEST_COUNT} 件ではありません（${entries.length} 件）`);
  }

  const excluded = new Set(manifest.excludedKeys || []);
  const seen = new Set();
  const picked = [];

  for (const e of entries) {
    if (!e || typeof e !== "object") throw new Error("項目の形が違います");
    if (typeof e.key !== "string" || !KEY_RE.test(e.key)) throw new Error(`キーの形が違います: ${e.key}`);
    if (seen.has(e.key)) throw new Error(`同じキーが2回出てきます: ${e.key}`);
    seen.add(e.key);
    if (excluded.has(e.key)) throw new Error(`移さないと決めたキーが混ざっています: ${e.key}`);

    const ext = e.key.slice(e.key.lastIndexOf(".") + 1);
    if (e.category !== e.key.split("/")[1]) throw new Error(`置き場所が食い違っています: ${e.key}`);
    if (e.contentType !== EXT_TYPE[ext]) throw new Error(`種類が食い違っています: ${e.key}`);
    if (!Number.isInteger(e.size) || e.size <= 0) throw new Error(`大きさが正しくありません: ${e.key}`);
    if (typeof e.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(e.sha256)) {
      throw new Error(`指紋の形が正しくありません: ${e.key}`);
    }
    if (e.key.split("/").pop().split(".")[0] !== e.sha256.slice(0, 16)) {
      throw new Error(`キーと指紋のつじつまが合いません: ${e.key}`);
    }

    /* ★ 見本の1枚は、ここで機械的に取り除く */
    if (e.key === canaryKey) continue;

    picked.push({
      key: e.key, category: e.category, contentType: e.contentType,
      size: e.size, sha256: e.sha256
    });
  }

  if (!seen.has(canaryKey)) throw new Error("一覧の中に見本の1枚がありません");
  if (picked.length !== ALLOWLIST_COUNT) {
    throw new Error(`残りが ${ALLOWLIST_COUNT} 件になりません（${picked.length} 件）`);
  }

  /* ★ 引くときに使う「4つ組」が、全件で一意であることを確かめる。
     Worker は category ＋ contentType ＋ size ＋ sha256 で名簿の1件を特定します。
     ここが重複していると「どちらの entry か」を決められません。
     **そのときは名簿を作らずに止めます**（あとで「最初の1件」を使わないため）。 */
  const composites = new Set();
  for (const e of picked) {
    const c = [e.category, e.contentType, e.size, e.sha256].join("\n");
    if (composites.has(c)) {
      throw new Error(`同じ4つ組の画像が2件あります（一意に決められません）: ${e.key}`);
    }
    composites.add(c);
  }

  /* 並び順を key の昇順に固定する（何度作っても同じ中身にするため） */
  picked.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return picked;
}

/** 名簿ファイルの中身（文字列）を組み立てる。改行は LF。 */
export function renderAllowlistSource(manifest, canaryKey = CANARY.key){
  const entries = selectBatchEntries(manifest, canaryKey);

  const body = entries.map(e => [
    "  Object.freeze({",
    `    key: ${JSON.stringify(e.key)},`,
    `    category: ${JSON.stringify(e.category)},`,
    `    contentType: ${JSON.stringify(e.contentType)},`,
    `    size: ${e.size},`,
    `    sha256: ${JSON.stringify(e.sha256)}`,
    "  })"
  ].join("\n")).join(",\n");

  return [
    "/* ================================================================",
    "   自動生成ファイル ― **手で書き換えないでください**",
    "",
    "   作り方：",
    "     cd worker",
    "     node scripts/build-batch-allowlist.mjs",
    "",
    "   もと：scripts/migration-input.local.json（50件）",
    "   引き算：見本の1枚（canary）を1件だけ取り除いたもの",
    `   結果：${ALLOWLIST_COUNT} 件（key の昇順）`,
    "",
    "   ここに画像の中身は入りません。key / category / contentType /",
    "   size / sha256 の5つだけです。",
    "",
    "   一覧と食い違っていないことは worker/test/batchAllowlist.test.mjs が",
    "   **作り直して1バイトずつ突き合わせて**確かめます。",
    "   ================================================================ */",
    "",
    `export const BATCH_ALLOWLIST = Object.freeze([`,
    body,
    "]);",
    ""
  ].join("\n");
}

/* ---- コマンドとして実行されたときだけ、ファイルを書き出す ---- */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const source = renderAllowlistSource(manifest);
  writeFileSync(fileURLToPath(OUTPUT_PATH), source, "utf8");
  console.log(`名簿を作り直しました：${ALLOWLIST_COUNT} 件`);
  console.log(`  出力先 : src/lib/batchAllowlist.generated.js`);
  console.log(`  除いた見本の1枚 : ${CANARY.key}`);
  console.log("  通信 0回 / R2 操作 0回");
}
