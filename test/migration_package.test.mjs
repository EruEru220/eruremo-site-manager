/* ================================================================
   Phase 4.5 ― 移行パッケージの確認（ブラウザ側）のテスト

   確かめること：
   - 正しい50件だけを受け入れる
   - 件数・重複・除外キー・指紋・大きさ・形式のどれが崩れても**拒否する**
   - 知らない項目・壊れた中身・巨大なファイルを拒否する
   - **確認だけでは通信を1回もしない**（fetch 0回）
   - 実移行の経路が存在しない（POST 0回）
   - 見本の1枚（canary）が**何度やっても同じ1枚**になる

   実行方法:  node --test "test/*.test.mjs"
   外部パッケージは使いません。ネットワークにも出ません。
   ================================================================ */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const HTML_PATH = new URL("../eruremo_SiteManager.html", import.meta.url);
const HTML = readFileSync(HTML_PATH, "utf8");

function slice(startMarker, endMarker, label){
  const s = HTML.indexOf(startMarker);
  assert.ok(s >= 0, `切り出しに失敗しました（開始）: ${label}`);
  const e = HTML.indexOf(endMarker, s + startMarker.length);
  assert.ok(e >= 0, `切り出しに失敗しました（終了）: ${label}`);
  return HTML.slice(s, e);
}

const SRC_MEDIA  = slice("/* 画像の置き場所。Worker 側の固定リスト", "let webpOK=null;", "保管庫の処理");
const SRC_PKG    = slice("const MIGRATION_SCHEMA  = 1;", "\n/* ====", "移行パッケージ");
const SRC_CANARY = slice("async function sendMigrationCanary(state){",
                         "\n/* ボタンから呼ばれる入口", "見本の1枚を送る");
/* 残り49枚のうち「1枚分」を送る関数（通信はこの中だけ） */
const SRC_ONE    = slice("async function sendMigrationOne(item){",
                         "\n/* 49件を1枚ずつ", "1枚だけ送る");
/* 49件を1枚ずつ回す関数（この中に通信は無い） */
const SRC_BATCH  = slice("async function sendMigrationBatch(state, onProgress){",
                         "\n/* ボタンから呼ばれる入口", "49枚を送る");

/* 説明の文章まで数えてしまわないよう、コード部分だけを取り出す */
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, "");
const CODE_PKG = stripComments(SRC_PKG);
const CODE_CANARY = stripComments(SRC_CANARY);
const CODE_ONE = stripComments(SRC_ONE);
const CODE_BATCH = stripComments(SRC_BATCH);

/* 安全弁を**開けた版**のソース。テストの中だけで使い、本体は閉じたままです。
   （本体の `MIGRATION_CANARY_ENABLED = false` を書き換えるのはここだけ） */
const SRC_PKG_OPEN = SRC_PKG.replace(/const MIGRATION_CANARY_ENABLED = (?:true|false);/,
                                     "const MIGRATION_CANARY_ENABLED = true;");

/* 残り49枚の安全弁を**開けた版／閉じた版**。どちらもテストの中だけです。 */
const SRC_PKG_BATCH_OPEN = SRC_PKG.replace(/const MIGRATION_BATCH_ENABLED = (?:true|false);/,
                                           "const MIGRATION_BATCH_ENABLED = true;");
const SRC_PKG_BATCH_SHUT = SRC_PKG.replace(/const MIGRATION_BATCH_ENABLED = (?:true|false);/,
                                           "const MIGRATION_BATCH_ENABLED = false;");

/* ---- 動かすための入れ物 ---- */
function build(fetchImpl, src = SRC_PKG){
  const rec = { modals: [], toasts: [] };
  const $ = () => null;                 /* 画面は使わない（純粋な判定だけ試す） */
  const fetchCalls = [];
  const wrapped = async (url, init) => {
    fetchCalls.push({ url: String(url), init: init || null });
    if (!fetchImpl) throw new Error("通信してはいけません");
    return fetchImpl(String(url), init || null);
  };
  const fn = new Function(
    "location", "fetch", "toast", "$", "openModal", "elm", "fmtSize", `
      ${SRC_MEDIA}
      ${src}
      return { verifyMigrationPackage, pickCanary, migrationB64ToBytes, sha256Hex,
               sendMigrationCanary, runMigrationCanary,
               migrationBatchEntries, sendMigrationOne, sendMigrationBatch, runMigrationBatch,
               setState: s => { migrationState = s; },
               MIGRATION_EXCLUDED, MIGRATION_COUNT, MIGRATION_APPLY_ENABLED,
               MIGRATION_CANARY_ENABLED, MIGRATION_BATCH_ENABLED, MIGRATION_BATCH_COUNT,
               MIGRATION_MAX_FILE_BYTES, MIGRATION_MAX_DECODED_BYTES };
    `);
  const api = fn(
    { protocol: "https:" }, wrapped,
    (m, k) => rec.toasts.push({ m: String(m), k }),
    $, h => rec.modals.push(String(h)),
    () => ({ appendChild(){}, append(){}, replaceChildren(){} }),
    b => b + " B"
  );
  api.rec = rec; api.fetchCalls = fetchCalls;
  api.posts = () => fetchCalls.filter(c => c.init && c.init.method === "POST");
  api.deletes = () => fetchCalls.filter(c => c.init && c.init.method === "DELETE");
  return api;
}

/* 偽の保管庫。POST を受け、GET で読み返せる。 */
const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body,
  arrayBuffer: async () => new ArrayBuffer(0)
});
const binary = bytes => ({
  ok: true, status: 200,
  json: async () => { throw new Error("json ではありません"); },
  /* 元の入れ物を切り出さず、ちょうどの大きさで作り直す */
  arrayBuffer: async () => Uint8Array.from(bytes).buffer
});

function makeStore({ uploadStatus = 201, uploadBody = null, readBytes = null,
                     readStatus = 200, uploadThrows = false, readThrows = false } = {}){
  return async (url, init) => {
    if (url === "/api/media/upload") {
      if (uploadThrows) throw new Error("つながりません");
      return json(uploadBody, uploadStatus);
    }
    if (readThrows) throw new Error("つながりません");
    if (readStatus !== 200) return { ...json({}, readStatus), arrayBuffer: async () => new ArrayBuffer(0) };
    return binary(readBytes || new Uint8Array(0));
  };
}

/* ---- 正しいパッケージを組み立てる ---- */
const sha256 = b => createHash("sha256").update(b).digest("hex");
const CATS = ["gallery","cast","history","shop","about","logo"];

function makeEntry(i){
  /* 中身を変えて、指紋とキーがつじつまの合う画像を作る */
  const bytes = Buffer.from("image-" + i + "-" + "x".repeat(i % 7));
  const full = sha256(bytes);
  const cat = CATS[i % CATS.length];
  const ext = i % 3 === 0 ? "png" : i % 3 === 1 ? "jpg" : "webp";
  const type = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" }[ext];
  return {
    key: `media/${cat}/2026/08/${full.slice(0, 16)}.${ext}`,
    category: cat,
    contentType: type,
    size: bytes.length,
    sha256: full,
    dataBase64: bytes.toString("base64")
  };
}

function makePackage(count = 50){
  const entries = [];
  for (let i = 0; i < count; i++) entries.push(makeEntry(i));
  return {
    schemaVersion: 1,
    purpose: "eruremo-staging-media-migration",
    createdAt: "2026-08-07T00:00:00.000Z",
    targetBucket: "your-media-staging",
    entryCount: entries.length,
    totalBytes: entries.reduce((a, e) => a + e.size, 0),
    entries
  };
}

/* 壊し方を1つだけ適用する */
function broken(mutate){
  const pkg = makePackage();
  mutate(pkg);
  return pkg;
}

/* ================================================================
   1. 正しいパッケージ
   ================================================================ */

test("正しい50件のパッケージは受け入れられる", async () => {
  const api = build();
  const r = await api.verifyMigrationPackage(makePackage());
  assert.equal(r.ok, true, r.problems.join(" / "));
  assert.equal(r.entries.length, 50);
  assert.equal(r.problems.length, 0);
  assert.ok(r.canary, "見本の1枚が選ばれていません");
});

test("確認しても通信は1回も起きない", async () => {
  const api = build();
  await api.verifyMigrationPackage(makePackage());
  assert.equal(api.fetchCalls.length, 0, "通信が発生しています");
});

/* ================================================================
   2. 件数
   ================================================================ */

test("49件は拒否する", async () => {
  const api = build();
  const r = await api.verifyMigrationPackage(makePackage(49));
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /50 件ではありません/);
});

test("51件は拒否する", async () => {
  const api = build();
  const r = await api.verifyMigrationPackage(makePackage(51));
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /50 件ではありません/);
});

test("件数の申告だけを書き換えても拒否する", async () => {
  const api = build();
  const r = await api.verifyMigrationPackage(broken(p => { p.entryCount = 49; }));
  assert.equal(r.ok, false);
});

/* ================================================================
   3. 中身の改ざん
   ================================================================ */

test("移さないと決めた画像が混ざっていたら拒否する", async () => {
  const api = build();
  const excludedKey = api.MIGRATION_EXCLUDED[0];
  /* 除外キーに合う中身を用意しても通らないこと（キーそのもので弾く） */
  const r = await api.verifyMigrationPackage(broken(p => {
    p.entries[0].key = excludedKey;
    p.entries[0].category = excludedKey.split("/")[1];
    p.entries[0].contentType = "image/webp";
    p.entries[0].sha256 = excludedKey.split("/").pop().split(".")[0] + "0".repeat(48);
  }));
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /移さないと決めた/);
});

test("同じキーが二重に入っていたら拒否する", async () => {
  const api = build();
  const r = await api.verifyMigrationPackage(broken(p => { p.entries[1] = { ...p.entries[0] }; }));
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /二重/);
});

test("指紋を書き換えたら拒否する", async () => {
  const api = build();
  const r = await api.verifyMigrationPackage(broken(p => {
    p.entries[3].sha256 = "f".repeat(64);
  }));
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /食い違って|一致しません/);
});

test("中身をすり替えたら拒否する（指紋はそのまま）", async () => {
  const api = build();
  const r = await api.verifyMigrationPackage(broken(p => {
    const evil = Buffer.from("すりかえた中身");
    p.entries[5].dataBase64 = evil.toString("base64");
    p.entries[5].size = evil.length;
    p.totalBytes = p.entries.reduce((a, e) => a + e.size, 0);
  }));
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /すり替え/);
});

test("大きさを書き換えたら拒否する", async () => {
  const api = build();
  const r = await api.verifyMigrationPackage(broken(p => { p.entries[7].size += 1; }));
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /大きさが申告と違います/);
});

test("合計の大きさを書き換えたら拒否する", async () => {
  const api = build();
  const r = await api.verifyMigrationPackage(broken(p => { p.totalBytes += 1; }));
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /合計の大きさ/);
});

test("Base64 が壊れていたら拒否する", async () => {
  const api = build();
  for (const bad of ["", "!!!!", "abc", "AAAA=AAA", "こんにちは", null, 123, []]) {
    const r = await api.verifyMigrationPackage(broken(p => { p.entries[2].dataBase64 = bad; }));
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});

test("画像の種類が食い違っていたら拒否する", async () => {
  const api = build();
  for (const bad of ["image/gif", "text/html", "image/svg+xml", "", null]) {
    const r = await api.verifyMigrationPackage(broken(p => { p.entries[4].contentType = bad; }));
    assert.equal(r.ok, false, String(bad));
    assert.match(r.problems.join(" "), /種類が食い違/);
  }
});

test("置き場所の名前が食い違っていたら拒否する", async () => {
  const api = build();
  const r = await api.verifyMigrationPackage(broken(p => { p.entries[6].category = "other"; }));
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /置き場所の名前が食い違/);
});

/* ================================================================
   4. キーの形（パストラバーサルなど）
   ================================================================ */

test("キーの形が正しくなければ拒否する", async () => {
  const api = build();
  const bad = [
    "../secret.txt",
    "media/../secret.txt",
    "media/gallery/../../secret.txt",
    "media\\gallery\\2026\\08\\0123456789abcdef.png",
    "/media/gallery/2026/08/0123456789abcdef.png",
    "media/gallery/2026/08/0123456789abcdef.svg",
    "media/unknown/2026/08/0123456789abcdef.png",
    "media/gallery/2026/08/0123456789ABCDEF.png",
    "trash/media/gallery/2026/08/0123456789abcdef.png",
    "https://evil.example.com/x.png",
    "media/gallery/2026/08/0123456789abcdef.png\n",
    "", null, 123, {}
  ];
  for (const key of bad) {
    const r = await api.verifyMigrationPackage(broken(p => { p.entries[0].key = key; }));
    assert.equal(r.ok, false, JSON.stringify(key));
  }
});

/* ================================================================
   5. いちばん外側の形
   ================================================================ */

test("形式の版が違えば拒否する", async () => {
  const api = build();
  for (const v of [0, 2, "1", null, undefined]) {
    const r = await api.verifyMigrationPackage(broken(p => { p.schemaVersion = v; }));
    assert.equal(r.ok, false, String(v));
    assert.match(r.problems.join(" "), /形式の版/);
  }
});

test("用途の名前が違えば拒否する", async () => {
  const api = build();
  for (const v of ["", "other", "eruremo-staging-media-migration ", null]) {
    const r = await api.verifyMigrationPackage(broken(p => { p.purpose = v; }));
    assert.equal(r.ok, false, String(v));
    assert.match(r.problems.join(" "), /用途の名前/);
  }
});

test("送り先の名前が違えば拒否する", async () => {
  const api = build();
  const r = await api.verifyMigrationPackage(broken(p => { p.targetBucket = "your-media-local"; }));
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /送り先の名前/);
});

test("知らない項目が入っていたら拒否する", async () => {
  const api = build();
  const r1 = await api.verifyMigrationPackage(broken(p => { p.cookie = "x"; }));
  assert.equal(r1.ok, false);
  assert.match(r1.problems.join(" "), /知らない項目/);

  const r2 = await api.verifyMigrationPackage(broken(p => { p.entries[0].accessToken = "x"; }));
  assert.equal(r2.ok, false);
  assert.match(r2.problems.join(" "), /知らない項目/);
});

test("配列や文字列そのものは拒否する", async () => {
  const api = build();
  for (const v of [null, undefined, [], "text", 123, true]) {
    const r = await api.verifyMigrationPackage(v);
    assert.equal(r.ok, false, String(v));
  }
});

/* ================================================================
   6. 大きさの上限
   ================================================================ */

test("上限の値が決まっている", () => {
  const api = build();
  assert.equal(api.MIGRATION_MAX_FILE_BYTES, 15 * 1024 * 1024);
  assert.equal(api.MIGRATION_MAX_DECODED_BYTES, 10 * 1024 * 1024);
  assert.equal(api.MIGRATION_COUNT, 50);
});

test("中身の合計が上限を超えたら拒否する", async () => {
  const api = build();
  /* 1件あたり 300KB × 50 = 約15MB（上限10MBを超える） */
  const big = Buffer.alloc(300 * 1024, 7);
  const entries = [];
  for (let i = 0; i < 50; i++) {
    const bytes = Buffer.concat([big, Buffer.from(String(i))]);
    const full = sha256(bytes);
    entries.push({
      key: `media/gallery/2026/08/${full.slice(0, 16)}.png`,
      category: "gallery", contentType: "image/png",
      size: bytes.length, sha256: full, dataBase64: bytes.toString("base64")
    });
  }
  const pkg = {
    schemaVersion: 1, purpose: "eruremo-staging-media-migration",
    createdAt: "2026-08-07T00:00:00.000Z", targetBucket: "your-media-staging",
    entryCount: 50, totalBytes: entries.reduce((a, e) => a + e.size, 0), entries
  };
  const r = await api.verifyMigrationPackage(pkg);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /合計が大きすぎ/);
});

test("ファイルの大きさは読み込む前に確かめる", () => {
  /* checkMigrationFile が file.size を先に見ていること */
  const src = slice("async function checkMigrationFile(file){", "\nfunction showMigrationProblems", "checkMigrationFile");
  const sizeAt = src.indexOf("file.size");
  const readAt = src.indexOf("file.text()");
  assert.ok(sizeAt >= 0, "ファイルの大きさを見ていません");
  assert.ok(sizeAt < readAt, "読み込んでから大きさを見ています");
});

/* ================================================================
   7. 見本の1枚（canary）
   ================================================================ */

test("見本はいちばん小さい1枚が選ばれる", async () => {
  const api = build();
  const r = await api.verifyMigrationPackage(makePackage());
  const smallest = Math.min(...r.entries.map(e => e.size));
  assert.equal(r.canary.size, smallest);
});

test("見本は何度やっても同じ1枚になる", async () => {
  const api = build();
  const a = await api.verifyMigrationPackage(makePackage());
  const b = await api.verifyMigrationPackage(makePackage());
  assert.equal(a.canary.key, b.canary.key);

  /* 並び順を変えても同じ結果になること */
  const shuffled = makePackage();
  shuffled.entries.reverse();
  const c = await api.verifyMigrationPackage(shuffled);
  assert.equal(c.canary.key, a.canary.key, "並び順で結果が変わっています");
});

test("同じ大きさが並んでも、キーの順で1枚に決まる", () => {
  const api = build();
  const list = [
    { key: "media/gallery/2026/08/bbbbbbbbbbbbbbbb.png", size: 10 },
    { key: "media/gallery/2026/08/aaaaaaaaaaaaaaaa.png", size: 10 },
    { key: "media/gallery/2026/08/cccccccccccccccc.png", size: 20 }
  ];
  assert.equal(api.pickCanary(list).key, "media/gallery/2026/08/aaaaaaaaaaaaaaaa.png");
  assert.equal(api.pickCanary(list.slice().reverse()).key, "media/gallery/2026/08/aaaaaaaaaaaaaaaa.png");
});

/* ================================================================
   8. 実移行の経路が存在しないこと（いちばん大事）
   ================================================================ */

test("実移行はまだ有効化されていない", () => {
  const api = build();
  assert.equal(api.MIGRATION_APPLY_ENABLED, false);
  assert.match(SRC_PKG, /const MIGRATION_APPLY_ENABLED = false;/);
});

test("削除や一覧の経路は存在しない", () => {
  for (const forbidden of ["XMLHttpRequest", "sendBeacon",
                           "/api/media/item", "method:\"DELETE\"", "method: \"DELETE\"",
                           "storeImage", "mediaDeleteOne", "mediaListPage",
                           "removeMediaCardsByKey"]) {
    assert.equal(SRC_PKG.includes(forbidden), false, `あってはいけない経路があります: ${forbidden}`);
  }
});

test("通信は「1枚を送る」2つの関数の中だけ・POST もその中だけ", () => {
  /* この画面全体で fetch は4か所だけ。
       ・見本の1枚を送る（送る1回・読み返す1回）
       ・残り49枚の1枚分を送る（送る1回・読み返す1回）
     49枚ぶんの繰り返しは sendMigrationBatch が行いますが、
     **その関数の中に通信は1つもありません**（下のテストで固定）。 */
  assert.equal([...CODE_PKG.matchAll(/fetch\(/g)].length, 4,
    "通信の書かれている場所の数が想定と違います");
  assert.equal([...CODE_PKG.matchAll(/method:"POST"/g)].length, 2);
  assert.equal([...CODE_PKG.matchAll(/"\/api\/media\/upload"/g)].length, 2);

  /* しかもすべて sendMigrationCanary / sendMigrationOne の中にある */
  const outside = CODE_PKG.replace(CODE_CANARY, "").replace(CODE_ONE, "");
  assert.equal(outside.includes("fetch("), false, "1枚を送る関数の外に通信があります");
  assert.equal(outside.includes("method:\"POST\""), false, "1枚を送る関数の外に POST があります");

  /* 49件を回す関数そのものには、通信が1つも無い */
  assert.equal(CODE_BATCH.includes("fetch("), false, "回す関数の中に通信があります");
});

test("見本を送る関数の中に、繰り返しの構文が無い（50件送れない）", () => {
  for (const loop of ["for(", "for (", ".forEach(", ".map(", "while(", "while (", "do{"]) {
    assert.equal(CODE_CANARY.includes(loop), false, `繰り返しがあります: ${loop}`);
  }
});

test("②のボタンは、安全弁に直結していて、押したときだけ動く", () => {
  /* ボタンの作りは1か所だけ。押せるかどうかは安全弁がそのまま決める。 */
  assert.match(SRC_PKG, /const b2=elm\("button","mini","② 残り49枚を送る"\); b2\.type="button";/);
  assert.match(SRC_PKG, /b2\.disabled = !MIGRATION_BATCH_ENABLED;/,
    "②の押せる・押せないが安全弁に直結していません");
  /* 無条件で押せるようにする記述が無いこと */
  assert.equal(/b2\.disabled\s*=\s*false/.test(SRC_PKG), false, "②を無条件で押せるようにしています");
  /* 動作は click のときだけ。ほかの出来事には結び付けていない。 */
  const listeners = [...SRC_PKG.matchAll(/b2\.addEventListener\("([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(listeners, ["click"], "click 以外にも結び付けています");
  assert.match(SRC_PKG, /b2\.addEventListener\("click",\(\)=>runMigrationBatch\(b2,box\)\);/);
});

test("安全弁の状態がボタンの押せる・押せないに直結している", () => {
  /* 見本の1枚は 2026-08-08 に送り終えたので、**閉じた**状態に戻しています。
     閉じている＝①のボタンが押せない＝この画面から出ていく通信は0回。
     Worker 側も MEDIA_MUTATIONS_ENABLED / MIGRATION_CANARY_MUTATION_ENABLED の
     両方が "false" で、二重に閉じています（worker/test/mutations.test.mjs）。 */
  assert.match(SRC_PKG, /const MIGRATION_CANARY_ENABLED = false;/);
  assert.match(SRC_PKG, /b1\.disabled = !MIGRATION_CANARY_ENABLED;/);
  /* 閉じたときは案内を出して止まる道が、いまも残っていること */
  assert.match(SRC_PKG, /if\(!MIGRATION_CANARY_ENABLED\)\{ migrationNotEnabled\(\); return; \}/);
  const fn = slice("function migrationNotEnabled(){", "\nlet migrationState=null;", "migrationNotEnabled");
  assert.match(fn, /実移行機能はまだ有効化されていません/);
  assert.equal(fn.includes("fetch("), false, "案内の中で通信しています");
});

test("残り49枚は、②の明示クリックからしか始まらない", () => {
  /* 2026-08-08：49件の移行が終わったので、安全弁は**閉じて**あります。
     Worker 側も "false" に戻したので、二重に閉じています。 */
  assert.match(SRC_PKG, /const MIGRATION_BATCH_ENABLED = false;/);
  /* 古い安全弁は閉じたまま（残り49枚の一括適用の別経路は作らない） */
  assert.match(SRC_PKG, /const MIGRATION_APPLY_ENABLED = false;/);

  /* runMigrationBatch が出てくるのは「定義」と「②の click」の2か所だけ。
     ほかから呼ばれる道（自動実行）が無いことを固定する。
     説明の文章では名前に触れているので、コード部分だけを数える。 */
  const hits = [...CODE_PKG.matchAll(/runMigrationBatch/g)];
  assert.equal(hits.length, 2, "runMigrationBatch の呼び出し場所が増えています");
  assert.match(CODE_PKG, /async function runMigrationBatch\(btn, box\)\{/);
  assert.match(CODE_PKG, /b2\.addEventListener\("click",\(\)=>runMigrationBatch\(b2,box\)\);/);

  /* 自動で動き出す仕掛けが無いこと */
  for (const w of ["setTimeout", "setInterval", "requestIdleCallback",
                   "DOMContentLoaded", "requestAnimationFrame"]) {
    assert.equal(CODE_PKG.includes(w), false, `自動で動く仕掛けがあります: ${w}`);
  }
  /* 読み込んだ瞬間に呼び出す書き方（即時実行）も無いこと */
  assert.equal(/runMigrationBatch\s*\(\s*\)\s*;/.test(CODE_PKG), false, "自動実行しています");
});

test("空打ち：保管庫が断ったら、読み返さずに止まる", async () => {
  /* Worker 側の MEDIA_MUTATIONS_ENABLED="false" のときの応答を再現する */
  const api = build(async (url) => {
    if (url === "/api/media/upload") {
      return json({ ok: false, error: { code: "MUTATIONS_DISABLED",
                                        message: "いまは画像の追加・削除をお休みしています。" } }, 503);
    }
    throw new Error("読み返してはいけません");
  });
  const st = await verifiedState(api);
  const r = await api.sendMigrationCanary(st);

  assert.equal(r.ok, false);
  assert.match(r.reason, /受け取りませんでした/);
  assert.equal(api.posts().length, 1, "POST は1回だけ");
  assert.equal(api.fetchCalls.length, 1, "断られたのに読み返しています");
  assert.equal(api.deletes().length, 0);
});

test("自動で再試行しない", () => {
  for (const w of ["setTimeout", "setInterval", "retry", "リトライ"]) {
    assert.equal(SRC_CANARY.includes(w), false, `自動の再試行があります: ${w}`);
  }
  const runner = slice("async function runMigrationCanary(btn, box){", "\nfunction showCanaryResult", "runMigrationCanary");
  assert.equal(runner.includes("setTimeout"), false);
  assert.equal([...runner.matchAll(/sendMigrationCanary\(/g)].length, 1, "1回だけ呼んでください");
});

test("この画面のコードはデータを書き換えない", () => {
  for (const forbidden of ["History.push()", "persist()", "DATA=", "renderPane()",
                           "localStorage", "rebaseMediaUrls"]) {
    assert.equal(SRC_PKG.includes(forbidden), false, `データを変える記述があります: ${forbidden}`);
  }
});

/* ================================================================
   8-2. 見本の1枚を送る（通信は偽物に差し替えて確かめる）
   ================================================================ */

/* 検証を通したあとの状態を作る */
async function verifiedState(api){
  const r = await api.verifyMigrationPackage(makePackage());
  assert.equal(r.ok, true, r.problems.join(" / "));
  return r;
}

const okBody = c => ({ ok: true, key: c.key, url: "/" + c.key, size: c.size, contentType: c.contentType });

test("見本の1枚だけを送り、読み返して指紋が一致すれば成功", async () => {
  const probe = build();
  const st = await verifiedState(probe);
  const c = st.canary;

  const api = build(makeStore({ uploadBody: okBody(c), readBytes: c.bytes }));
  const st2 = await verifiedState(api);
  const r = await api.sendMigrationCanary(st2);

  assert.equal(r.ok, true, r.reason);
  assert.equal(r.key, c.key);
  assert.equal(r.sha256, c.sha256);
});

test("送信は最大1回・対象は見本の1件だけ・削除は0回", async () => {
  const probe = build();
  const st0 = await verifiedState(probe);
  const c = st0.canary;

  const api = build(makeStore({ uploadBody: okBody(c), readBytes: c.bytes }));
  const st = await verifiedState(api);
  await api.sendMigrationCanary(st);

  assert.equal(api.posts().length, 1, "POST が1回ではありません");
  assert.equal(api.posts()[0].url, "/api/media/upload");
  assert.equal(api.deletes().length, 0, "削除しています");
  /* 通信は「送る1回」＋「読み返す1回」の合計2回だけ */
  assert.equal(api.fetchCalls.length, 2, "通信の回数が想定と違います");
  assert.equal(api.fetchCalls[1].url, "/" + c.key, "読み返す先が見本以外です");

  /* 送った中身が canary 1件だけであること */
  const fd = api.posts()[0].init.body;
  assert.ok(fd instanceof FormData);
  assert.equal(fd.getAll("file").length, 1, "ファイルが1件ではありません");
  assert.equal(fd.get("category"), c.category);
  assert.equal(fd.get("file").name, "image", "パソコンのファイル名を送っています");
  const sent = new Uint8Array(await fd.get("file").arrayBuffer());
  assert.equal(sent.length, c.size);
  assert.deepEqual(Buffer.from(sent), Buffer.from(c.bytes), "送った中身が見本と違います");
});

test("送信が失敗したら、そこで止まる（読み返さない）", async () => {
  const probe = build();
  const c = (await verifiedState(probe)).canary;
  for (const opts of [{ uploadStatus: 503, uploadBody: { ok: false, error: { code: "MUTATIONS_DISABLED" } } },
                      { uploadStatus: 500, uploadBody: { ok: false } },
                      { uploadStatus: 201, uploadBody: { ok: false } },
                      { uploadThrows: true }]) {
    const api = build(makeStore({ ...opts, readBytes: c.bytes }));
    const st = await verifiedState(api);
    const r = await api.sendMigrationCanary(st);
    assert.equal(r.ok, false, JSON.stringify(opts));
    assert.equal(api.fetchCalls.length, 1, "失敗したのに読み返しています");
  }
});

test("返ってきた置き場所が違えば停止する", async () => {
  const probe = build();
  const c = (await verifiedState(probe)).canary;
  const api = build(makeStore({
    uploadBody: { ok: true, key: "media/gallery/2026/08/0123456789abcdef.png", url: "/media/gallery/2026/08/0123456789abcdef.png" },
    readBytes: c.bytes
  }));
  const st = await verifiedState(api);
  const r = await api.sendMigrationCanary(st);
  assert.equal(r.ok, false);
  assert.match(r.reason, /置き場所が違います/);
  assert.equal(api.fetchCalls.length, 1, "読み返しています");
});

test("返ってきた住所の形が違えば停止する", async () => {
  const probe = build();
  const c = (await verifiedState(probe)).canary;
  for (const url of ["https://evil.example.com/x.png", "javascript:alert(1)", "", null, 123]) {
    const api = build(makeStore({ uploadBody: { ok: true, key: c.key, url }, readBytes: c.bytes }));
    const st = await verifiedState(api);
    const r = await api.sendMigrationCanary(st);
    assert.equal(r.ok, false, String(url));
    assert.equal(api.fetchCalls.length, 1);
  }
});

test("読み返しに失敗したら停止する", async () => {
  const probe = build();
  const c = (await verifiedState(probe)).canary;
  for (const opts of [{ readStatus: 404 }, { readStatus: 500 }, { readThrows: true }]) {
    const api = build(makeStore({ uploadBody: okBody(c), ...opts }));
    const st = await verifiedState(api);
    const r = await api.sendMigrationCanary(st);
    assert.equal(r.ok, false, JSON.stringify(opts));
    assert.match(r.reason, /読み返せません/);
  }
});

test("読み返した中身の指紋が違えば失敗（POST 成功だけでは成功にしない）", async () => {
  const probe = build();
  const c = (await verifiedState(probe)).canary;
  const evil = new Uint8Array(Buffer.from("すりかえた中身"));
  const api = build(makeStore({ uploadBody: okBody(c), readBytes: evil }));
  const st = await verifiedState(api);
  const r = await api.sendMigrationCanary(st);
  assert.equal(r.ok, false);
  assert.match(r.reason, /大きさが違います|指紋と一致しません/);
  assert.equal(api.posts().length, 1, "POST は1回のまま");
});

test("読み返した大きさが違えば失敗", async () => {
  const probe = build();
  const c = (await verifiedState(probe)).canary;
  const short = c.bytes.slice(0, c.bytes.length - 1);
  const api = build(makeStore({ uploadBody: okBody(c), readBytes: short }));
  const st = await verifiedState(api);
  const r = await api.sendMigrationCanary(st);
  assert.equal(r.ok, false);
  assert.match(r.reason, /大きさが違います/);
});

test("確認できていないパッケージでは、通信を1回もしない", async () => {
  const probe = build();
  const c = (await verifiedState(probe)).canary;
  for (const st of [null, undefined, {}, { ok: false }, { ok: true, entries: [] },
                    { ok: true, entries: new Array(49).fill(0) }]) {
    const api = build(makeStore({ uploadBody: okBody(c), readBytes: c.bytes }));
    const r = await api.sendMigrationCanary(st);
    assert.equal(r.ok, false, JSON.stringify(st));
    assert.equal(api.fetchCalls.length, 0, "通信しています");
  }
});

test("見本が食い違っていたら、通信を1回もしない", async () => {
  const api = build(makeStore({}));
  const st = await verifiedState(api);
  st.canary = { ...st.canary, key: "media/gallery/2026/08/0123456789abcdef.png" };
  const r = await api.sendMigrationCanary(st);
  assert.equal(r.ok, false);
  assert.match(r.reason, /食い違って/);
  assert.equal(api.fetchCalls.length, 0);
});

test("見本の中身が壊れていたら、通信を1回もしない", async () => {
  const api = build(makeStore({}));
  const st = await verifiedState(api);
  const c = st.entries.find(e => e.key === st.canary.key);
  c.bytes = c.bytes.slice(0, 3);          /* 大きさと食い違わせる */
  const r = await api.sendMigrationCanary(st);
  assert.equal(r.ok, false);
  assert.match(r.reason, /中身が壊れています/);
  assert.equal(api.fetchCalls.length, 0);
});

/* ================================================================
   8-3. 二度押し・安全弁
   ================================================================ */

test("安全弁が開いていれば、①は1回だけ送る", async () => {
  const probe = build();
  const c = (await verifiedState(probe)).canary;
  /* 本体は閉じているので、テストの中だけ開けた版で確かめます */
  const api = build(makeStore({ uploadBody: okBody(c), readBytes: c.bytes }), SRC_PKG_OPEN);
  assert.equal(api.MIGRATION_CANARY_ENABLED, true);

  const st = await verifiedState(api);
  /* runMigrationCanary は内部の migrationState を見るので、直接 send を呼んで確かめる */
  const r = await api.sendMigrationCanary(st);
  assert.equal(r.ok, true, r.reason);
  assert.equal(api.posts().length, 1, "POST は1回だけ");
});

test("安全弁を閉じれば、押しても通信0回に戻る", async () => {
  /* 本体はいま閉じている。開いていても閉じていても同じ結論になるよう、
     ここでは**必ず閉じた版**にしてから確かめる。 */
  const src = SRC_PKG.replace(/const MIGRATION_CANARY_ENABLED = (true|false);/,
                              "const MIGRATION_CANARY_ENABLED = false;");
  const calls = [];
  const modals = [];
  const fn = new Function("location", "fetch", "toast", "$", "openModal", "elm", "fmtSize", `
    ${SRC_MEDIA}
    ${src}
    return { runMigrationCanary, MIGRATION_CANARY_ENABLED };
  `);
  const api = fn({ protocol: "https:" },
    async (...a) => { calls.push(a); throw new Error("通信してはいけません"); },
    () => {}, () => null, h => modals.push(String(h)),
    () => ({ appendChild(){}, append(){}, replaceChildren(){} }), b => b + " B");

  assert.equal(api.MIGRATION_CANARY_ENABLED, false);
  const btn = { disabled: false, textContent: "① 見本の1枚を送る" };
  const r = await api.runMigrationCanary(btn, null);
  assert.equal(r, undefined, "送ってしまっています");
  assert.equal(calls.length, 0, "通信しています");
  assert.match(modals[0], /実移行機能はまだ有効化されていません/);
});

test("二度押ししても、送信は増えない", async () => {
  const probe = build();
  const c = (await verifiedState(probe)).canary;

  /* 安全弁が開いた状態で確かめる（閉じていても開いた版を作る） */
  const src = SRC_PKG.replace(/const MIGRATION_CANARY_ENABLED = (true|false);/,
                              "const MIGRATION_CANARY_ENABLED = true;");
  const fetchCalls = [];
  let release;
  const held = new Promise(r => { release = r; });
  const fn = new Function("location", "fetch", "toast", "$", "openModal", "elm", "fmtSize", `
    ${SRC_MEDIA}
    ${src}
    return { verifyMigrationPackage, runMigrationCanary, setState:s=>{ migrationState=s; } };
  `);
  const api = fn({ protocol: "https:" },
    async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      if (String(url) === "/api/media/upload") { await held; return json(okBody(c), 201); }
      return binary(c.bytes);
    },
    () => {}, () => null, () => {},
    () => ({ appendChild(){}, append(){}, replaceChildren(){} }), b => b + " B");

  const st = await api.verifyMigrationPackage(makePackage());
  api.setState(st);

  const btn = { disabled: false, textContent: "① 見本の1枚を送る" };
  const first = api.runMigrationCanary(btn, null);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(btn.disabled, true, "送っている間もボタンが押せます");

  /* 送信中にもう一度押す */
  const second = await api.runMigrationCanary(btn, null);
  assert.equal(second, undefined, "二重に送っています");

  release();
  const r1 = await first;
  assert.equal(r1.ok, true, r1.reason);
  assert.equal(fetchCalls.filter(x => x.init && x.init.method === "POST").length, 1,
    "POST が2回起きています");
  assert.equal(btn.disabled, false, "終わったのにボタンが戻っていません");
});

test("①の成功が、そのまま49枚の送信につながらない", async () => {
  /* 見本の1枚の結果を出す処理の中で、次を送り始めないこと */
  const result = slice("function showCanaryResult(box, r){", "\n/* ---- 残り49枚を送る",
                       "見本の結果表示");
  assert.equal(result.includes("fetch("), false, "成功のあとに通信しています");
  assert.equal(result.includes("sendMigrationBatch"), false, "成功のあとに49枚を送っています");
  assert.equal(result.includes("runMigrationBatch"), false, "成功のあとに49枚を送っています");

  /* 見本を送る関数そのものからも、49枚の送信を呼んでいないこと */
  assert.equal(CODE_CANARY.includes("sendMigrationBatch"), false);
  assert.equal(CODE_CANARY.includes("sendMigrationOne"), false);
  assert.equal(SRC_PKG.includes("MIGRATION_APPLY_ENABLED = false"), true);
});

/* ================================================================
   9. 表示のしかた・秘密情報
   ================================================================ */

test("パッケージの中身を innerHTML に流し込まない", () => {
  assert.equal(SRC_PKG.includes("innerHTML"), false, "innerHTML を使っています");
  /* 表示は elm(...) の第3引数（textContent）で行う */
  assert.match(SRC_PKG, /elm\("li",null,"置き場所：" \+ r\.canary\.key\)/);
});

test("秘密情報を扱う項目が存在しない", () => {
  const api = build();
  for (const word of ["Cookie", "cookie", "ACCESS_AUD", "ALLOWED_EMAIL",
                      "accountId", "account_id", "token", "Token",
                      "secret", "Secret", "cardNumber", "creditCard", "支払い"]) {
    assert.equal(SRC_PKG.includes(word), false, `秘密に関わる記述があります: ${word}`);
  }
  /* メールアドレスらしき文字列も無いこと */
  assert.equal(/[\w.+-]+@[\w-]+\.[\w.-]+/.test(SRC_PKG), false, "メールアドレスが書かれています");
  /* 受け取ってよい項目は6つだけ */
  assert.match(SRC_PKG, /const MIGRATION_ENTRY_FIELDS = \["key","category","contentType","size","sha256","dataBase64"\]/);
});

/* ================================================================
   10. 画面の作り
   ================================================================ */

test("メニューに項目があり、既定では隠れている", () => {
  assert.match(HTML, /data-act="importMigration" id="miMigrate" hidden>📦 移行パッケージを確認する</);
  assert.match(HTML, /act==="importMigration"\) openMigrationImport\(\)/);
});

test("ステージングのときだけメニューに出す", () => {
  const src = slice("function setEnvBadge(name){", "\nconst MediaAPI=", "setEnvBadge");
  assert.match(src, /mig\.hidden = \(v!=="staging"\)/);
});

test("Phase 2-2 / 3 / 4 / 4.5 の既存機能に手を入れていない", () => {
  for (const marker of [
    "async function toR2Mode(){", "async function openMediaLibrary(){",
    "async function openRebaseMedia(){", "function rebaseMediaUrls(root, base){",
    "async function storeImage(dataUrl, path){", "function toUrlMode(){"
  ]) {
    assert.ok(HTML.includes(marker), `失われています: ${marker}`);
  }
});

/* ================================================================
   11. 残り49枚を送るしくみ（Phase 4.5 ／ いまは実行不能）

   確かめること：
   - 送る対象がちょうど49件で、見本の1枚が入らない
   - 並びが決まっている（何度呼んでも同じ順番）
   - **1枚ずつ・完全に直列**（同時に2つ送らない）
   - POST → 返却キー確認 → GET → 大きさ → 指紋、が全部そろったときだけ次へ
   - 途中で1つでも失敗したら、その場で完全停止して残りを送らない
   - 自動でやり直さない／二度押しでも増えない
   - 安全弁が閉じていれば、通信は0回
   ================================================================ */

/* 偽の保管庫（49枚ぶん）。POST を受け、GET で読み返せる。
   fail に key を渡すと、その1枚の POST（または GET）だけを失敗させられる。 */
function makeBatchStore({ failPostAt = null, failGetAt = null, failBodyAt = null,
                          wrongKeyAt = null, wrongSizeAt = null, wrongShaAt = null,
                          dedupeAll = false, onCall = null } = {}){
  const stored = new Map();
  return async (url, init) => {
    if (onCall) onCall(url, init);
    if (url === "/api/media/upload") {
      const fd = init && init.body;
      const blob = fd.get("file");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const full = sha256(Buffer.from(bytes));
      const cat = fd.get("category");
      const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[blob.type];
      const key = `media/${cat}/2026/08/${full.slice(0, 16)}.${ext}`;
      if (failPostAt === key) return json({ ok: false, error: { code: "R2_ERROR" } }, 500);
      if (failBodyAt === key) return json({ ok: false }, 200);
      stored.set(key, bytes);
      const outKey = wrongKeyAt === key ? "media/other/2026/08/0123456789abcdef.png" : key;
      return json({ ok: true, key: outKey, url: "/" + outKey,
                    size: bytes.length, contentType: blob.type,
                    ...(dedupeAll ? { deduped: true } : {}) },
                  dedupeAll ? 200 : 201);
    }
    /* 読み返し */
    const key = String(url).replace(/^\//, "");
    if (failGetAt === key) return { ...json({}, 404), arrayBuffer: async () => new ArrayBuffer(0) };
    const bytes = stored.get(key);
    if (!bytes) return { ...json({}, 404), arrayBuffer: async () => new ArrayBuffer(0) };
    if (wrongSizeAt === key) return binary(bytes.slice(0, Math.max(0, bytes.length - 1)));
    if (wrongShaAt === key) {
      const b = Uint8Array.from(bytes); b[0] = (b[0] + 1) & 0xFF; return binary(b);
    }
    return binary(bytes);
  };
}

const batchApi = (opts, src = SRC_PKG_BATCH_OPEN) => build(makeBatchStore(opts), src);

/* ---- 11-1. 送る対象の作り方 ---- */

test("送る対象はちょうど49件", async () => {
  const api = build();
  const st = await verifiedState(api);
  assert.equal(api.MIGRATION_BATCH_COUNT, 49);
  assert.equal(api.migrationBatchEntries(st).length, 49);
});

test("見本の1枚は、送る対象に入らない", async () => {
  const api = build();
  const st = await verifiedState(api);
  const list = api.migrationBatchEntries(st);
  assert.equal(list.some(e => e.key === st.canary.key), false, "見本の1枚が混ざっています");
  /* 49件 ＋ 見本の1枚 ＝ もとの50件（引き算しかしていない） */
  const rebuilt = [...list.map(e => e.key), st.canary.key].sort();
  assert.deepEqual(rebuilt, st.entries.map(e => e.key).sort());
});

test("移さないと決めた5件も入らない", async () => {
  const api = build();
  const st = await verifiedState(api);
  const list = api.migrationBatchEntries(st);
  for (const k of api.MIGRATION_EXCLUDED) {
    assert.equal(list.some(e => e.key === k), false, `除外キーが入っています: ${k}`);
  }
});

test("同じ画像が二重に入らない", async () => {
  const api = build();
  const st = await verifiedState(api);
  const keys = api.migrationBatchEntries(st).map(e => e.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("並びは key の昇順で、何度呼んでも同じ", async () => {
  const api = build();
  const st = await verifiedState(api);
  const a = api.migrationBatchEntries(st).map(e => e.key);
  const b = api.migrationBatchEntries(st).map(e => e.key);
  assert.deepEqual(a, b, "呼ぶたびに順番が変わります");
  assert.deepEqual(a, a.slice().sort(), "key の昇順になっていません");

  /* 入力の並びを変えても、結果の並びは変わらない */
  const st2 = { ...st, entries: st.entries.slice().reverse() };
  assert.deepEqual(api.migrationBatchEntries(st2).map(e => e.key), a);
});

test("確認できていないパッケージでは、送る対象が0件になる", () => {
  const api = build();
  for (const st of [null, undefined, {}, { ok: false, entries: [] }]) {
    assert.deepEqual(api.migrationBatchEntries(st), []);
  }
});

/* ---- 11-2. 1枚ずつ・直列 ---- */

test("49枚すべてが1枚ずつ順番に送られ、最後まで成功する", async () => {
  const order = [];
  let inFlight = 0, maxInFlight = 0;
  const api = batchApi({ onCall: (url, init) => {
    if (init && init.method === "POST") order.push("POST");
    else order.push("GET");
  } });
  /* 同時実行の見張り（fetch を包む） */
  const st = await verifiedState(api);

  const progress = [];
  const r = await api.sendMigrationBatch(st, p => progress.push(p.done));

  assert.equal(r.ok, true, r.reason);
  assert.equal(r.sent, 49);
  assert.equal(r.total, 49);
  assert.deepEqual(progress, Array.from({ length: 49 }, (_, i) => i + 1),
    "進み具合が 1..49 の順になっていません");

  /* POST と GET が交互（1枚ぶんずつ）になっていること */
  assert.equal(order.length, 98);
  for (let i = 0; i < order.length; i += 2) {
    assert.equal(order[i], "POST", `${i} 番目が POST ではありません`);
    assert.equal(order[i + 1], "GET", `${i + 1} 番目が GET ではありません`);
  }
  assert.equal(inFlight, 0);
  assert.equal(maxInFlight, 0);
});

test("同時に2つ送らない（前の1枚が終わるまで次を始めない）", async () => {
  let inFlight = 0, maxInFlight = 0;
  const store = makeBatchStore({});
  const wrapped = async (url, init) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 0));      /* わざと非同期にする */
    try { return await store(url, init); }
    finally { inFlight--; }
  };
  const api = build(wrapped, SRC_PKG_BATCH_OPEN);
  const st = await verifiedState(api);
  const r = await api.sendMigrationBatch(st, () => {});
  assert.equal(r.ok, true, r.reason);
  assert.equal(maxInFlight, 1, `同時に ${maxInFlight} 件送っています`);
});

test("まとめて送る書き方を使っていない", () => {
  /* 説明の文章では触れているので、コード部分だけを見る */
  for (const w of ["Promise.all", "Promise.allSettled", "Promise.race", "Promise.any"]) {
    assert.equal(CODE_PKG.includes(w), false, `まとめて送る書き方があります: ${w}`);
  }
  /* 繰り返しは「回す関数」の中に1つだけ */
  assert.equal([...CODE_BATCH.matchAll(/for\s*\(/g)].length, 1);
  assert.equal(CODE_ONE.includes("for("), false, "1枚を送る関数に繰り返しがあります");
  assert.equal(CODE_ONE.includes("for ("), false, "1枚を送る関数に繰り返しがあります");
});

/* ---- 11-3. 失敗したら、その場で完全停止 ---- */

const failCases = [
  ["POST が失敗した", i => ({ failPostAt: i }), /受け取りませんでした/],
  ["返事の ok が立っていない", i => ({ failBodyAt: i }), /受け取りませんでした/],
  ["返ってきた置き場所が違う", i => ({ wrongKeyAt: i }), /置き場所が違います/],
  ["読み返せない", i => ({ failGetAt: i }), /読み返せませんでした/],
  ["読み返した大きさが違う", i => ({ wrongSizeAt: i }), /大きさが違います/],
  ["読み返した指紋が違う", i => ({ wrongShaAt: i }), /指紋と一致しません/]
];

for (const [label, make, reasonRe] of failCases) {
  test(`${label}ら、その場で止まって残りを送らない`, async () => {
    const probe = build();
    const list = probe.migrationBatchEntries(await verifiedState(probe));
    const target = list[16].key;                    /* 17枚目で失敗させる */

    const posted = [];
    const api = build(makeBatchStore({ ...make(target),
      onCall: (url, init) => { if (init && init.method === "POST") posted.push(url); } }),
      SRC_PKG_BATCH_OPEN);
    const st = await verifiedState(api);

    const progress = [];
    const r = await api.sendMigrationBatch(st, p => progress.push(p.done));

    assert.equal(r.ok, false, "失敗なのに成功しています");
    assert.equal(r.sent, 16, "止まった枚数が違います");
    assert.equal(r.total, 49);
    assert.equal(r.key, target, "止まった画像が違います");
    assert.match(r.reason, reasonRe);

    /* 17枚目で止まったので、POST は17回まで（残り32枚は送っていない） */
    assert.equal(posted.length, 17, "止まったあとも送っています");
    assert.deepEqual(progress, Array.from({ length: 16 }, (_, i) => i + 1));
  });
}

test("通信そのものができないときも、その場で止まる", async () => {
  let calls = 0;
  const api = build(async () => { calls++; throw new Error("つながりません"); },
                    SRC_PKG_BATCH_OPEN);
  const st = await verifiedState(api);
  const r = await api.sendMigrationBatch(st, () => {});
  assert.equal(r.ok, false);
  assert.equal(r.sent, 0);
  assert.match(r.reason, /つながりません|送れませんでした/);
  assert.equal(calls, 1, "つながらないのに何度も試しています");
});

test("自動でやり直す処理が無い", () => {
  for (const w of ["setTimeout", "setInterval", "requestAnimationFrame", "retry", "リトライ"]) {
    assert.equal(SRC_BATCH.includes(w), false, `あってはいけない記述: ${w}`);
    assert.equal(SRC_ONE.includes(w), false, `あってはいけない記述: ${w}`);
  }
});

/* ---- 11-4. 送る前の確認 ---- */

test("確認できていないパッケージでは、通信を1回もしない", async () => {
  for (const st of [null, undefined, {}, { ok: false, entries: [] }]) {
    const api = batchApi({});
    const r = await api.sendMigrationBatch(st, () => {});
    assert.equal(r.ok, false);
    assert.equal(r.sent, 0);
    assert.equal(api.fetchCalls.length, 0, "通信しています");
  }
});

test("50件そろっていなければ、通信を1回もしない", async () => {
  const api = batchApi({});
  const st = await verifiedState(api);
  const broken = { ...st, entries: st.entries.slice(0, 49) };
  const r = await api.sendMigrationBatch(broken, () => {});
  assert.equal(r.ok, false);
  assert.equal(api.fetchCalls.length, 0, "通信しています");
});

test("移さないと決めた画像が混ざっていたら、通信を1回もしない", async () => {
  const api = batchApi({});
  const st = await verifiedState(api);
  /* 見本の1枚以外の1件を、除外キーに差し替える */
  const entries = st.entries.map(e =>
    e.key === st.canary.key ? e : { ...e, key: api.MIGRATION_EXCLUDED[0] });
  const r = await api.sendMigrationBatch({ ...st, entries }, () => {});
  assert.equal(r.ok, false);
  assert.equal(api.fetchCalls.length, 0, "通信しています");
});

test("中身が壊れている画像は送らない", async () => {
  const api = batchApi({});
  const st = await verifiedState(api);
  const list = api.migrationBatchEntries(st);
  const bad = { ...list[0], bytes: list[0].bytes.slice(0, 1) };
  const r = await api.sendMigrationOne(bad);
  assert.equal(r.ok, false);
  assert.match(r.reason, /中身が壊れています/);
  assert.equal(api.fetchCalls.length, 0, "通信しています");
});

/* ---- 11-5. 再実行（重複排除） ---- */

test("すでに保管庫にある画像は、deduped として数えられ、そのまま次へ進む", async () => {
  const api = batchApi({ dedupeAll: true });
  const st = await verifiedState(api);
  const r = await api.sendMigrationBatch(st, () => {});
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.sent, 49);
  assert.equal(r.deduped, 49, "重複排除の数が合いません");
  /* 読み返しと指紋の確認は、重複排除でも必ず行う */
  const reads = api.fetchCalls.filter(c => !(c.init && c.init.method === "POST"));
  assert.equal(reads.length, 49, "読み返していません");
});

test("消す・上書きする経路が無い", () => {
  for (const w of ["method:\"DELETE\"", "method: \"DELETE\"", "/api/media/item",
                   "trash/", "overwrite", "上書き"]) {
    assert.equal(SRC_BATCH.includes(w), false, `あってはいけない記述: ${w}`);
    assert.equal(SRC_ONE.includes(w), false, `あってはいけない記述: ${w}`);
  }
});

/* ---- 11-6. 安全弁とボタン ---- */

test("安全弁は閉じている（②が押せない）", () => {
  /* 移行が終わったので閉じています。②は disabled に戻っています。 */
  const api = build();
  assert.equal(api.MIGRATION_BATCH_ENABLED, false);
  assert.match(SRC_PKG, /const MIGRATION_BATCH_ENABLED = false;/);
  assert.match(SRC_PKG, /b2\.disabled = !MIGRATION_BATCH_ENABLED;/);
});

test("安全弁が閉じていれば、②を押しても通信0回", async () => {
  /* 本体はいま閉じている。開いていても閉じていても同じ結論になるよう、
     ここでは**必ず閉じた版**にしてから確かめる。 */
  const calls = [];
  const modals = [];
  const fn = new Function("location", "fetch", "toast", "$", "openModal", "elm", "fmtSize", `
    ${SRC_MEDIA}
    ${SRC_PKG_BATCH_SHUT}
    return { runMigrationBatch, MIGRATION_BATCH_ENABLED };
  `);
  const api = fn({ protocol: "https:" },
    async (...a) => { calls.push(a); throw new Error("通信してはいけません"); },
    () => {}, () => null, h => modals.push(String(h)),
    () => ({ appendChild(){}, append(){}, replaceChildren(){} }), b => b + " B");

  assert.equal(api.MIGRATION_BATCH_ENABLED, false);
  const btn = { disabled: false, textContent: "② 残り49枚を送る" };
  const r = await api.runMigrationBatch(btn, null);
  assert.equal(r, undefined, "送ってしまっています");
  assert.equal(calls.length, 0, "通信しています");
  assert.match(modals[0], /実移行機能はまだ有効化されていません/);
  /* 閉じた版では、ボタンも押せない状態になる */
  assert.match(SRC_PKG_BATCH_SHUT, /b2\.disabled = !MIGRATION_BATCH_ENABLED;/);
});

test("①canary はいまも押せないままになっている", () => {
  assert.match(SRC_PKG, /const MIGRATION_CANARY_ENABLED = false;/);
  assert.match(SRC_PKG, /b1\.disabled = !MIGRATION_CANARY_ENABLED;/);
  const api = build();
  assert.equal(api.MIGRATION_CANARY_ENABLED, false);
});

test("送っている間はボタンが押せなくなり、二度押しでも増えない", async () => {
  let release;
  const held = new Promise(r => { release = r; });
  const store = makeBatchStore({});
  let firstPost = true;
  const wrapped = async (url, init) => {
    if (firstPost && init && init.method === "POST") { firstPost = false; await held; }
    return store(url, init);
  };
  const api = build(wrapped, SRC_PKG_BATCH_OPEN);
  const st = await verifiedState(api);
  api.setState(st);

  const btn = { disabled: false, textContent: "② 残り49枚を送る" };
  const first = api.runMigrationBatch(btn, null);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(btn.disabled, true, "送っている間もボタンが押せます");

  const second = await api.runMigrationBatch(btn, null);
  assert.equal(second, undefined, "二重に送っています");

  release();
  const r1 = await first;
  assert.equal(r1.ok, true, r1.reason);
  assert.equal(api.posts().length, 49, "POST の回数が49ではありません");
  assert.equal(btn.disabled, false, "終わったのにボタンが戻っていません");
  assert.equal(api.deletes().length, 0);
});

test("進み具合と結果は textContent で表示する（HTML として解釈させない）", () => {
  assert.equal(SRC_BATCH.includes("innerHTML"), false);
  const run = slice("async function runMigrationBatch(btn, box){", "\nfunction showBatchResult",
                    "49枚の入口");
  const show = slice("function showBatchResult(box, r){", "\nfunction migrationNotEnabled",
                     "49枚の結果表示");
  assert.equal(run.includes("innerHTML"), false);
  assert.equal(show.includes("innerHTML"), false);
  /* 進み具合は「n / 49」の形 */
  assert.match(run, /line\.textContent = p\.done\+" \/ "\+p\.total\+" ✓"/);
  /* 失敗したときは「n / 49 で停止しました」 */
  assert.match(show, /で停止しました/);
});

test("結果の表示に、止まった枚数と理由が出る", async () => {
  const probe = build();
  const list = probe.migrationBatchEntries(await verifiedState(probe));
  const target = list[16].key;
  const api = build(makeBatchStore({ failGetAt: target }), SRC_PKG_BATCH_OPEN);
  const st = await verifiedState(api);
  const r = await api.sendMigrationBatch(st, () => {});
  assert.equal(r.sent, 16);
  assert.equal(r.total, 49);
  assert.ok(r.reason);
  assert.equal(r.key, target);
});

/* ---- 11-7. 空打ち（Worker 側の安全弁が閉じているとき） ----

   認証済みのブラウザで②を1回押したときに、
   **1件目の POST で 503 になり、そこで完全に停止する**ことを固定します。
   期待値：POST 1回 ／ GET 0回 ／ 2件目の POST 0回 ／ delete 0回
   -------------------------------------------------------------- */

/* Worker 側の MIGRATION_BATCH_MUTATION_ENABLED="false" のときの応答を再現する */
const mutationsDisabled = () => json({
  ok: false,
  error: { code: "MUTATIONS_DISABLED", message: "いまは画像の追加・削除をお休みしています。" }
}, 503);

test("空打ち：1件目で 503 なら、POST 1回・GET 0回で完全停止する", async () => {
  const seen = [];
  const api = build(async (url, init) => {
    seen.push({ url: String(url), method: (init && init.method) || "GET" });
    if (url === "/api/media/upload") return mutationsDisabled();
    throw new Error("読み返してはいけません");
  }, SRC_PKG_BATCH_OPEN);

  const st = await verifiedState(api);
  const progress = [];
  const r = await api.sendMigrationBatch(st, p => progress.push(p.done));

  /* 1枚も成功していない */
  assert.equal(r.ok, false);
  assert.equal(r.sent, 0, "0件で止まっていません");
  assert.equal(r.total, 49);
  assert.match(r.reason, /保管庫が受け取りませんでした/);
  assert.deepEqual(progress, [], "進み具合が進んでいます");

  /* 通信は POST 1回だけ。読み返しも2件目も無い。 */
  assert.equal(api.posts().length, 1, "POST の回数が1ではありません");
  assert.equal(api.fetchCalls.length, 1, "POST 以外の通信があります");
  assert.equal(seen[0].url, "/api/media/upload");
  assert.equal(seen[0].method, "POST");
  assert.equal(api.deletes().length, 0);
});

test("空打ち：止まった画像は、名簿の1件目（key 昇順の先頭）", async () => {
  const api = build(async () => mutationsDisabled(), SRC_PKG_BATCH_OPEN);
  const st = await verifiedState(api);
  const first = api.migrationBatchEntries(st)[0];
  const r = await api.sendMigrationBatch(st, () => {});
  assert.equal(r.key, first.key);
});

test("空打ち：ボタンから押しても、POST 1回で止まり、表示は 0 / 49", async () => {
  const api = build(async () => mutationsDisabled(), SRC_PKG_BATCH_OPEN);
  const st = await verifiedState(api);
  api.setState(st);

  /* 画面に入る文字を拾う入れ物（textContent で入るものだけ） */
  const texts = [];
  const box = {
    appendChild(node){ if (node && typeof node === "object") texts.push(node); },
    append(){}, replaceChildren(){}
  };

  const btn = { disabled: false, textContent: "② 残り49枚を送る" };
  const r = await api.runMigrationBatch(btn, box);

  assert.equal(r.ok, false);
  assert.equal(r.sent, 0);
  assert.equal(api.posts().length, 1, "POST が1回ではありません");
  assert.equal(api.fetchCalls.length, 1, "読み返しています");
  /* 終わったらボタンは元に戻る（もう一度押せる＝再試行は利用者の操作だけ） */
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, "② 残り49枚を送る");
});

test("空打ち：0 / 49 で止まったことが分かる文面になっている", () => {
  const show = slice("function showBatchResult(box, r){", "\nfunction migrationNotEnabled",
                     "49枚の結果表示");
  /* 見出しは「n / 49 で停止しました」（n は成功した枚数。空打ちなら 0） */
  assert.match(show, /\(r \? r\.sent : 0\)\+" \/ "\+MIGRATION_BATCH_COUNT\+" で停止しました"/);
  /* 止まった理由と、あとの画像を送っていないことを出す */
  assert.match(show, /"止まった理由："/);
  assert.match(show, /あとの画像は1枚も送っていません/);
  assert.match(show, /自動では繰り返しません/);
});

test("空打ちのあと、自動でもう一度送らない", async () => {
  let posts = 0;
  const api = build(async (url, init) => {
    if (init && init.method === "POST") posts++;
    return mutationsDisabled();
  }, SRC_PKG_BATCH_OPEN);
  const st = await verifiedState(api);
  api.setState(st);

  const btn = { disabled: false, textContent: "② 残り49枚を送る" };
  await api.runMigrationBatch(btn, null);
  assert.equal(posts, 1);

  /* しばらく待っても増えない（自動再送が無い） */
  await new Promise(r => setTimeout(r, 30));
  assert.equal(posts, 1, "自動でもう一度送っています");

  /* もう一度押したときだけ、また1回だけ送る */
  await api.runMigrationBatch(btn, null);
  assert.equal(posts, 2, "明示的に押しても送っていません");
});

test("空打ち：送っている間は②が押せず、二重に押しても増えない", async () => {
  let release;
  const held = new Promise(r => { release = r; });
  let posts = 0;
  const api = build(async (url, init) => {
    if (init && init.method === "POST") { posts++; await held; return mutationsDisabled(); }
    throw new Error("読み返してはいけません");
  }, SRC_PKG_BATCH_OPEN);
  const st = await verifiedState(api);
  api.setState(st);

  const btn = { disabled: false, textContent: "② 残り49枚を送る" };
  const first = api.runMigrationBatch(btn, null);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(btn.disabled, true, "送っている間もボタンが押せます");

  const second = await api.runMigrationBatch(btn, null);
  assert.equal(second, undefined, "二重に送っています");
  assert.equal(posts, 1, "POST が増えています");

  release();
  const r1 = await first;
  assert.equal(r1.ok, false);
  assert.equal(r1.sent, 0);
  assert.equal(posts, 1, "終わったあとに POST が増えています");
  assert.equal(btn.disabled, false, "終わったのにボタンが戻っていません");
  assert.equal(api.deletes().length, 0);
});

test("49枚すべて成功したときだけ「完了」になる", async () => {
  /* 成功のときは 49 / 49 */
  const okApi = batchApi({});
  const okR = await okApi.sendMigrationBatch(await verifiedState(okApi), () => {});
  assert.equal(okR.ok, true);
  assert.equal(okR.sent, okApi.MIGRATION_BATCH_COUNT);

  /* 途中で止まったときは ok が立たず、枚数も 49 未満 */
  const probe = build();
  const list = probe.migrationBatchEntries(await verifiedState(probe));
  const ngApi = build(makeBatchStore({ failPostAt: list[48].key }), SRC_PKG_BATCH_OPEN);
  const ngR = await ngApi.sendMigrationBatch(await verifiedState(ngApi), () => {});
  assert.equal(ngR.ok, false, "最後の1枚が失敗したのに成功しています");
  assert.equal(ngR.sent, 48);

  /* 表示も「全部そろったとき」だけ完了扱いにしている */
  const show = slice("function showBatchResult(box, r){", "\nfunction migrationNotEnabled",
                     "49枚の結果表示");
  assert.match(show, /r\.ok && r\.sent===MIGRATION_BATCH_COUNT/);
});

test("見本の1枚は、49枚の送信では1回も送られない", async () => {
  const posted = [];
  const api = build(makeBatchStore({
    onCall: (url, init) => { if (init && init.method === "POST") posted.push(init.body.get("category")); }
  }), SRC_PKG_BATCH_OPEN);
  const st = await verifiedState(api);
  const canaryKey = st.canary.key;
  const r = await api.sendMigrationBatch(st, () => {});
  assert.equal(r.ok, true, r.reason);
  /* 送られたキーの一覧に canary が無いこと（返却キーで確かめる） */
  const sentKeys = api.posts().length;
  assert.equal(sentKeys, 49);
  assert.equal(api.fetchCalls.some(c => String(c.url) === "/" + canaryKey), false,
    "見本の1枚を読み返しています");
});
