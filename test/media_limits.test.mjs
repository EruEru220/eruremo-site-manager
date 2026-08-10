/* ================================================================
   Phase 4.5 の安全装置のテスト（編集ツール側）

   確かめること：
   - ギャラリー「まとめて追加」は1回50枚まで。超えたら**1枚も処理しない**
   - 一括移行は1回200枚まで。超えたら**通信も送信も起きない**
   - メディアライブラリに**自動通信がない**
     （setInterval によるポーリング・setTimeout による自動再試行が無い）
   - 一覧は**明示操作のときだけ**取り出す

   実行方法:  node --test "test/*.test.mjs"
   外部パッケージは使いません。ネットワークにも出ません。
   ================================================================ */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const HTML_PATH = new URL("../eruremo_SiteManager.html", import.meta.url);
const HTML = readFileSync(HTML_PATH, "utf8");

function slice(startMarker, endMarker, label){
  const s = HTML.indexOf(startMarker);
  assert.ok(s >= 0, `切り出しに失敗しました（開始が見つからない）: ${label}`);
  const e = HTML.indexOf(endMarker, s + startMarker.length);
  assert.ok(e >= 0, `切り出しに失敗しました（終了が見つからない）: ${label}`);
  return HTML.slice(s, e);
}

const SRC_MEDIA   = slice("/* 画像の置き場所。Worker 側の固定リスト", "let webpOK=null;", "保管庫の処理");
const SRC_HELPERS = slice("function collectEmbedded(root){", "async function mediaAlive(){", "collectEmbedded");
const SRC_ALIVE   = slice("async function mediaAlive(){", "async function toR2Mode(){", "mediaAlive");
const SRC_MIGRATE = slice("async function toR2Mode(){", "\n/* ====", "一括移行");
const SRC_BULK    = slice("      const files=[...e.target.files];", "\n      });", "まとめて追加");
const SRC_LIBRARY = slice("/* 保管庫の画像URLから、キー", "\n/* ====", "メディアライブラリ");

/* ================================================================
   1. 上限の値
   ================================================================ */

test("上限の値が決まっている", () => {
  assert.match(SRC_MEDIA, /const MAX_BULK_ADD = 50;/, "まとめて追加の上限がありません");
  assert.match(SRC_MEDIA, /const MAX_MIGRATE  = 200;/, "一括移行の上限がありません");
});

/* ================================================================
   2. ギャラリー「まとめて追加」の上限
   ================================================================ */

test("まとめて追加は、上限を超えたら1枚も処理しない", () => {
  /* 判定が、縮小・保存より前にあること */
  const guard = SRC_BULK.indexOf("MAX_BULK_ADD");
  const shrink = SRC_BULK.indexOf("shrinkImage");
  const store = SRC_BULK.indexOf("storeImage");
  assert.ok(guard >= 0, "上限の判定がありません");
  assert.ok(guard < shrink, "縮小より前に止めてください");
  assert.ok(guard < store, "保管庫へ送るより前に止めてください");
  /* 判定のあとに return があること（一部だけ処理しない） */
  const after = SRC_BULK.slice(guard, store);
  assert.match(after, /return;/, "超えたときに中止していません");
});

test("まとめて追加の上限を超えたら、案内を出す", () => {
  assert.match(SRC_BULK, /一度に追加できるのは/, "案内の文言がありません");
  assert.match(SRC_BULK, /\$\{MAX_BULK_ADD\}枚/, "上限の枚数を案内に出していません");
});

/* 実際に動かして確かめる（偽の入れ物を使う） */
function runBulk({ count, storeImpl }){
  const rec = { toasts: [], shrink: 0, store: 0, pushed: [] };
  const arr = [];
  const files = Array.from({ length: count }, (_, i) => ({ name: `${i}.png` }));

  const fn = new Function(
    "MAX_BULK_ADD", "toast", "shrinkImage", "storeImage", "arr", "cfg", "touched", "draw", "e", `
      return (async ()=>{
        ${SRC_BULK}
      })();
    `);

  return fn(
    50,
    (msg, kind) => rec.toasts.push({ msg: String(msg), kind }),
    async () => { rec.shrink++; return "data:image/png;base64,QUJD"; },
    async (url) => { rec.store++; return storeImpl ? storeImpl(url) : url; },
    arr, { k: "gallery.items" },
    () => {}, () => {},
    { target: { files, value: "x" } }
  ).then(() => ({ rec, arr }));
}

test("50枚ちょうどなら処理する", async () => {
  const { rec, arr } = await runBulk({ count: 50 });
  assert.equal(rec.shrink, 50);
  assert.equal(rec.store, 50);
  assert.equal(arr.length, 50);
});

test("51枚なら1枚も処理せず、保管庫にも送らない", async () => {
  const { rec, arr } = await runBulk({ count: 51 });
  assert.equal(rec.shrink, 0, "縮小が走っています");
  assert.equal(rec.store, 0, "保管庫へ送っています");
  assert.equal(arr.length, 0, "一部だけ追加されています");
  assert.match(rec.toasts.at(-1).msg, /一度に追加できるのは 50枚/);
  assert.equal(rec.toasts.at(-1).kind, "warn");
});

test("1000枚選んでも、送信は0回", async () => {
  const { rec } = await runBulk({ count: 1000 });
  assert.equal(rec.store, 0);
});

/* ================================================================
   3. 一括移行の上限
   ================================================================ */

test("一括移行の上限判定が、通信より前にある", () => {
  const guard = SRC_MIGRATE.indexOf("MAX_MIGRATE");
  const alive = SRC_MIGRATE.indexOf("mediaAlive()");
  const store = SRC_MIGRATE.indexOf("storeImage(");
  const backup = SRC_MIGRATE.indexOf("download(backupName()");
  const history = SRC_MIGRATE.indexOf("History.push()");
  assert.ok(guard >= 0, "上限の判定がありません");
  assert.ok(guard < alive, "疎通確認（通信）より前に止めてください");
  assert.ok(guard < store, "保管庫へ送るより前に止めてください");
  assert.ok(guard < backup, "バックアップの書き出しより前に止めてください");
  assert.ok(guard < history, "履歴を積むより前に止めてください");
});

test("一括移行の上限を超えたら、案内を出して中止する", () => {
  const guard = SRC_MIGRATE.indexOf("MAX_MIGRATE");
  const after = SRC_MIGRATE.slice(guard, SRC_MIGRATE.indexOf("mediaAlive()"));
  assert.match(after, /return;/, "超えたときに中止していません");
  assert.match(after, /一度に移せるのは/, "案内の文言がありません");
});

/* 実際に動かして確かめる */
function buildMigrate(imageCount){
  const rec = { modals: [], toasts: [], calls: [], history: [], downloads: [], confirms: [] };
  const data = { gallery: { items: [] } };
  for (let i = 0; i < imageCount; i++) {
    data.gallery.items.push({ src: "data:image/png;base64," + Buffer.from("img" + i).toString("base64") });
  }
  const chipSet = new Set();
  const chip = { title: "", textContent: "",
    classList: { add: (...c) => c.forEach(x => chipSet.add(x)),
                 remove: (...c) => c.forEach(x => chipSet.delete(x)),
                 contains: c => chipSet.has(c) } };
  const $ = sel => sel === "#mediaMode" ? chip : sel === "#mediaModeText" ? { textContent: "" } : null;

  const fetchImpl = async (...a) => { rec.calls.push(a[0]); throw new Error("通信してはいけません"); };

  const fn = new Function(
    "location", "fetch", "toast", "$", "DATA", "History", "persist", "renderTabs", "renderPane",
    "refreshPreview", "openModal", "closeModal", "confirm", "download", "bytes", "fmtSize",
    "dataUrlToBytes", `
      ${SRC_MEDIA}
      ${SRC_HELPERS}
      ${SRC_ALIVE}
      ${SRC_MIGRATE}
      return { toR2Mode };
    `);

  const api = fn(
    { protocol: "http:" }, fetchImpl,
    (msg, kind) => rec.toasts.push({ msg: String(msg), kind }),
    $, data,
    { push: () => rec.history.push("push"), commit: () => rec.history.push("commit") },
    () => {}, () => {}, () => {}, () => {},
    html => rec.modals.push(String(html)),
    () => {},
    msg => { rec.confirms.push(String(msg)); return true; },
    (name, blob) => rec.downloads.push(name),
    s => new Blob([s]).size, b => b + " B",
    () => new Uint8Array([1, 2, 3])
  );
  api.rec = rec;
  return api;
}

test("201枚なら、通信も送信もせずに中止する", async () => {
  const api = buildMigrate(201);
  await api.toR2Mode();
  assert.equal(api.rec.calls.length, 0, "通信が発生しています");
  assert.equal(api.rec.history.length, 0, "履歴を積んでいます");
  assert.equal(api.rec.downloads.length, 0, "バックアップを書き出しています");
  assert.equal(api.rec.confirms.length, 0, "確認ダイアログを出しています");
  assert.match(api.rec.modals.at(-1), /一度に移せる枚数を超えています/);
  assert.match(api.rec.modals.at(-1), /201枚/);
});

test("200枚ちょうどなら、上限では止まらない（疎通確認まで進む）", async () => {
  const api = buildMigrate(200);
  await api.toR2Mode();
  /* 通信を試みる＝上限では止まっていない（このテストの fetch は必ず失敗する） */
  assert.ok(api.rec.calls.length > 0, "上限で止まってしまっています");
  assert.match(api.rec.modals.at(-1), /つながりません/);
});

/* ================================================================
   4. 自動通信がないこと（退行防止）
   ================================================================ */

const MEDIA_SOURCES = [
  ["メディアライブラリ（Phase 4）", SRC_LIBRARY],
  ["一括移行（Phase 3）", SRC_MIGRATE],
  ["保管庫の処理（Phase 2-2）", SRC_MEDIA],
  ["まとめて追加", SRC_BULK]
];

test("メディア関連のコードに setInterval が無い", () => {
  for (const [label, src] of MEDIA_SOURCES) {
    assert.equal(/setInterval/.test(src), false, `${label} に setInterval があります`);
  }
});

test("メディア関連のコードに自動再試行の setTimeout が無い", () => {
  /* 表示のための setTimeout（結果モーダル・トーストの遅延）は許容。
     ただし通信を伴う関数を setTimeout の中から呼んでいないことを見る。 */
  for (const [label, src] of MEDIA_SOURCES) {
    const timers = [...src.matchAll(/setTimeout\(([\s\S]{0,200}?)[,)]/g)].map(m => m[1]);
    for (const body of timers) {
      for (const call of ["fetch(", "mediaListPage", "mediaDeleteOne", "storeImage",
                          "mediaAlive", "loadMediaPage", "MediaAPI.upload"]) {
        assert.equal(body.includes(call), false,
          `${label} の setTimeout から ${call} を呼んでいます（自動再試行の疑い）`);
      }
    }
  }
});

test("一覧の取り出しは、明示操作のときだけ", () => {
  /* loadMediaPage を呼ぶのは「開いたとき」と「もっと読み込む」の2か所だけ */
  const calls = [...SRC_LIBRARY.matchAll(/loadMediaPage\(/g)].length;
  const defs = [...SRC_LIBRARY.matchAll(/function loadMediaPage\(/g)].length;
  assert.equal(defs, 1, "loadMediaPage の定義が1つではありません");
  assert.equal(calls - defs, 2, `loadMediaPage の呼び出しが2か所ではありません（${calls - defs}か所）`);
  assert.match(SRC_LIBRARY, /addEventListener\("click",\(\)=>loadMediaPage\(false\)\)/,
    "「もっと読み込む」がクリック起点になっていません");
  assert.match(SRC_LIBRARY, /await loadMediaPage\(true\)/, "開いたときの取り出しがありません");
});

test("失敗しても、自分でやり直さない", () => {
  /* 一覧・削除の失敗経路に、再帰的なやり直しが無いこと */
  const fail = SRC_LIBRARY.slice(SRC_LIBRARY.indexOf("catch(err){"));
  assert.equal(/loadMediaPage\(/.test(fail.slice(0, 400)), false,
    "読み込み失敗のあと、自分でやり直しています");
  assert.equal(/mediaDeleteOne\(/.test(
    SRC_LIBRARY.slice(SRC_LIBRARY.indexOf("btn.textContent=\"削除する\";"))), false,
    "削除失敗のあと、自分でやり直しています");
});

test("保存時刻の表示用 setInterval は残っている（通信しない）", () => {
  /* これは壊してはいけない既存の仕組み。通信を含まないことも確かめる。 */
  const m = /setInterval\(\(\)=>\{([\s\S]*?)\},5000\);/.exec(HTML);
  assert.ok(m, "保存時刻の表示更新が失われています");
  for (const call of ["fetch(", "storeImage", "mediaAlive", "loadMediaPage"]) {
    assert.equal(m[1].includes(call), false, `保存時刻の更新から ${call} を呼んでいます`);
  }
});
