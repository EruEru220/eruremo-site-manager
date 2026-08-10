/* ================================================================
   Phase 3 の回帰テスト
   （埋め込み画像（Base64）を、まとめて保管庫（R2）へ移す処理）

   実行方法:  node --test "test/*.test.mjs"
   外部パッケージは使いません（Node.js 標準の node:test のみ）。
   ネットワークにも出ません（fetch は偽物に差し替えます）。

   考え方（Phase 2-2 のテストと同じ）:
     eruremo_SiteManager.html からソースコードそのものを切り出して動かします。
     テスト用に書き直したコピーではなく、本物のコードを確かめます。
   ================================================================ */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const HTML_PATH = new URL("../eruremo_SiteManager.html", import.meta.url);
const HTML = readFileSync(HTML_PATH, "utf8");

/* ---- ソースコードの切り出し ---------------------------------- */
function slice(startMarker, endMarker, label){
  const s = HTML.indexOf(startMarker);
  assert.ok(s >= 0, `切り出しに失敗しました（開始が見つからない）: ${label}`);
  const e = HTML.indexOf(endMarker, s + startMarker.length);
  assert.ok(e >= 0, `切り出しに失敗しました（終了が見つからない）: ${label}`);
  return HTML.slice(s, e);
}

const SRC_BYTES   = slice("function dataUrlToBytes(u){", "function toUrlMode(){", "dataUrlToBytes");
const SRC_MEDIA   = slice("/* 画像の置き場所。Worker 側の固定リスト", "let webpOK=null;", "保管庫の処理");
const SRC_MIGRATE = slice("function collectEmbedded(root){", "function runChecks(){", "一括移行の処理");

/* ---- テスト用の画像（中身が違う data URL を作る） ------------- */
/*  img("A") の中身は文字列 "image-A"。どの画像が送られたか見分けられます。 */
const img = tag => "data:image/png;base64," + Buffer.from("image-" + tag).toString("base64");
const IMG = { A: img("A"), B: img("B"), C: img("C"), D: img("D"), E: img("E"),
              F: img("F"), G: img("G"), H: img("H"), I: img("I") };

/* データのひな形。
   ★ IMG.A は logo / about.photo / cast.members[1].photo の【3か所】から使われています。
     ここが「1回だけ送って、全部の場所を置き換える」の確認どころです。 */
function sampleData(){
  return {
    pageTitle: "テスト用",
    logo: IMG.A,
    seo:     { favicon: IMG.B, ogImage: "https://example.com/og.png", siteUrl: "https://example.com" },
    about:   { photo: IMG.A, text: "説明" },
    cast:    { members: [ { name:"あ", photo: IMG.C },
                          { name:"い", photo: IMG.A },
                          { name:"う", profilePhoto: IMG.D } ] },
    staff:   { members: [ { name:"す", photo: IMG.E } ] },
    history: { items:   [ { photo: IMG.F, text:"むかし" } ] },
    shop:    { photo: IMG.G, url: "https://shop.example.com" },
    present: { items:   [ { name:"ぷ", photo: IMG.H, url:"https://dl.example.com", password:"あいことば" } ] },
    gallery: { items:   [ { src: IMG.I, cap:"", alt:"" },
                          { src: "photos/01.jpg", cap:"手入力", alt:"" },
                          { src: "", cap:"", alt:"" } ] },
    faq:     { items:   [ { q:"？", a:"！" } ] },
    show:    { faq: true },
    board:   { fb: { apiKey: "" } }
  };
}
/* 上のひな形の内訳（テスト中で何度も使うので定数にしておく） */
const OCCURRENCES = 11;  /* data URL が入っている「場所」の数 */
const UNIQUE      = 9;   /* 実際の画像の「枚数」（IMG.A が3か所で共有） */

/* ---- 切り出したコードを動かすための入れ物 -------------------- */

function fakeChip(){
  const set = new Set(["media-off"]);
  return { title:"", textContent:"",
    classList:{ add:(...c)=>c.forEach(x=>set.add(x)),
                remove:(...c)=>c.forEach(x=>set.delete(x)),
                contains:c=>set.has(c) } };
}

const reply = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status, json: async () => body
});

/* 偽の fetch。/api/health と /api/media/upload に答え、何が送られたか記録する。
     healthOk … true / false のほか、関数も渡せる（途中で生死を切り替えるため）
     failFor  … この目印の画像だけ保存に失敗させる（例: ["A"]）
     onUpload … 送信のたびに呼ばれる。テストの途中でデータを書き換えるのに使う。 */
function makeFetch({ healthOk = true, failFor = [], onUpload = null } = {}){
  const calls = [];
  let seq = 0;
  const impl = async (url, init) => {
    const rec = { url, init };
    calls.push(rec);
    if (String(url).includes("/api/health")){
      const live = typeof healthOk === "function" ? healthOk() : healthOk;
      if (live === "down") throw new Error("つながりません");   /* 通信そのものが失敗する状況 */
      return live ? reply({ ok:true, service:"eruremo-media-api", environment:"local" })
                  : reply({ ok:false }, 500);
    }
    const fd = init.body;
    const cat = fd.get("category");
    const raw = Buffer.from(await fd.get("file").arrayBuffer()).toString("utf8"); /* "image-A" */
    const tag = raw.replace(/^image-/, "");
    rec.tag = tag; rec.category = cat; rec.fileName = fd.get("file").name;
    if (onUpload) await onUpload(tag);
    if (failFor.includes(tag)) return reply({ ok:false, error:{ code:"R2_ERROR", message:"…" } }, 500);
    seq++;
    const key = `media/${cat}/2026/08/${String(seq).padStart(16, "0")}.png`;
    return reply({ ok:true, key, url:`http://127.0.0.1:8787/${key}`, size:7, contentType:"image/png" }, 201);
  };
  impl.calls = calls;
  impl.uploads = () => calls.filter(c => String(c.url).includes("/api/media/upload"));
  return impl;
}

function build({ protocol = "http:", data = sampleData(), fetchImpl = makeFetch(),
                 confirmResult = true } = {}){
  const rec = { modals:[], closed:0, downloads:[], toasts:[], history:[], calls:[], confirms:[] };
  const progress = { textContent:"" };
  const chip = fakeChip(), chipText = { textContent:"" };
  const $ = sel => sel === "#mediaMode" ? chip
                 : sel === "#mediaModeText" ? chipText
                 : sel === "#r2Progress" ? progress : null;
  const History = { push:()=>rec.history.push("push"), commit:()=>rec.history.push("commit") };
  const note = name => () => rec.calls.push(name);

  const fn = new Function(
    "location","fetch","toast","$","DATA","History","persist","renderTabs","renderPane",
    "refreshPreview","openModal","closeModal","confirm","download","bytes","fmtSize", `
      ${SRC_BYTES}
      ${SRC_MEDIA}
      ${SRC_MIGRATE}
      return { collectEmbedded, backupName, toR2Mode, mediaCategory, storeImage, MediaAPI, mediaAlive };
    `);

  const api = fn(
    { protocol }, fetchImpl, (msg, kind) => rec.toasts.push({ msg, kind }), $, data,
    History, note("persist"), note("renderTabs"), note("renderPane"), note("refreshPreview"),
    html => rec.modals.push(String(html)),
    () => rec.closed++,
    msg => { rec.confirms.push(String(msg)); return confirmResult; },
    (name, blob) => rec.downloads.push({ name, blob }),
    s => new Blob([s]).size,
    b => b < 1024 ? b + " B" : b < 1048576 ? (b/1024).toFixed(0) + " KB" : (b/1048576).toFixed(2) + " MB"
  );
  api.rec = rec; api.data = data; api.progress = progress; api.fetchImpl = fetchImpl;
  /* トップバーの保存先表示が、いま3つのどれになっているか */
  api.mode = () => chip.classList.contains("media-warn") ? "warn"
                 : chip.classList.contains("media-off") ? "local" : "r2";
  return api;
}

/* 結果の表示は、既存の toUrlMode() と同じく 400ms 待ってから出る。
   その表示を確かめたいときだけ、少し待ってから拾う。 */
const wait = ms => new Promise(r => setTimeout(r, ms));
async function resultModal(api){
  await wait(500);
  const m = api.rec.modals.find(x => x.includes("保管庫へ移しました"));
  assert.ok(m, "結果の表示が出ていません");
  return m;
}

/* データの中に残っている data URL の数を数える */
function countDataUrls(o){
  let n = 0;
  JSON.stringify(o, (k, v) => { if (typeof v === "string" && v.startsWith("data:image/")) n++; return v; });
  return n;
}
const isStoreUrl = v => typeof v === "string" && v.startsWith("http://127.0.0.1:8787/media/");

/* ================================================================
   1. 埋め込み画像の見つけ方（collectEmbedded）
   ================================================================ */

test("埋め込み画像を、データ上の場所つきで正しく集める", () => {
  const { collectEmbedded } = build();
  const found = collectEmbedded(sampleData());
  assert.equal(found.length, OCCURRENCES, "見つけた場所の数が違います");
  assert.deepEqual(found.map(f => f.path), [
    "logo",
    "seo.favicon",
    "about.photo",
    "cast.members.0.photo",
    "cast.members.1.photo",
    "cast.members.2.profilePhoto",
    "staff.members.0.photo",
    "history.items.0.photo",
    "shop.photo",
    "present.items.0.photo",
    "gallery.items.0.src"
  ]);
});

test("画像でない値には手を出さない", () => {
  const { collectEmbedded } = build();
  const data = {
    a: "photos/01.jpg",
    b: "https://example.com/a.png",
    c: "http://127.0.0.1:8787/media/logo/2026/08/0123456789abcdef.png", /* すでに保管庫のもの */
    d: "",
    e: "data:text/plain;base64,QUJD",        /* 画像ではない data URL */
    f: "data:application/json;base64,e30=",
    g: 12345, h: null, i: undefined, j: true,
    k: ["photos/02.jpg", "data:image/png;base64,AAAA"], /* 配列の中の文字列は対象外（toUrlMode と同じ） */
    l: { m: { n: "ふつうの文章です" } }
  };
  assert.deepEqual(collectEmbedded(data), []);
});

test("集めるだけではデータを書き換えない", () => {
  const { collectEmbedded } = build();
  const data = sampleData();
  const before = JSON.stringify(data);
  collectEmbedded(data);
  assert.equal(JSON.stringify(data), before, "集めただけでデータが変わっています");
});

test("集めた場所から、置き場所（category）が正しく決まる", () => {
  const { collectEmbedded, mediaCategory } = build();
  const got = {};
  for (const f of collectEmbedded(sampleData())) got[f.path] = mediaCategory(f.path);
  assert.deepEqual(got, {
    "logo":                        "logo",
    "seo.favicon":                 "favicon",
    "about.photo":                 "about",
    "cast.members.0.photo":        "cast",
    "cast.members.1.photo":        "cast",
    "cast.members.2.profilePhoto": "cast",
    "staff.members.0.photo":       "staff",
    "history.items.0.photo":       "history",
    "shop.photo":                  "shop",
    "present.items.0.photo":       "present",
    "gallery.items.0.src":         "gallery"
  });
});

/* ================================================================
   2. ★ 同じ画像は1回だけ送り、使っている全部の場所を置き換える
      （今回いちばん確かめたいところ）
   ================================================================ */

test("同じ画像は1回だけ送られ、参照している全部の場所が新しいURLに変わる", async () => {
  const fetchImpl = makeFetch();
  const api = build({ fetchImpl });
  const D = api.data;

  /* 前提：IMG.A が3か所から使われている */
  assert.equal(D.logo, D.about.photo);
  assert.equal(D.logo, D.cast.members[1].photo);

  await api.toR2Mode();

  const ups = fetchImpl.uploads();
  /* 送った回数は「枚数」であって「場所の数」ではない */
  assert.equal(ups.length, UNIQUE, `${OCCURRENCES}か所あるのに ${ups.length} 回送っています（${UNIQUE}回のはず）`);

  /* IMG.A を送ったのはちょうど1回 */
  assert.equal(ups.filter(u => u.tag === "A").length, 1, "同じ画像を複数回送っています");
  /* 同じ中身を2回送っていないこと（全体） */
  const tags = ups.map(u => u.tag);
  assert.equal(new Set(tags).size, tags.length, "同じ中身が重複して送られています");
  assert.deepEqual([...tags].sort(), ["A","B","C","D","E","F","G","H","I"]);

  /* 3か所すべてが、同じ1つのURLに置き換わっている */
  assert.ok(isStoreUrl(D.logo), `logo が保管庫のURLになっていません: ${D.logo}`);
  assert.equal(D.about.photo, D.logo, "about.photo が置き換わっていません");
  assert.equal(D.cast.members[1].photo, D.logo, "cast.members[1].photo が置き換わっていません");

  /* 他の画像も全部 URL になり、data URL は1つも残っていない */
  assert.equal(countDataUrls(D), 0, "埋め込みのまま残っている画像があります");
  for (const v of [D.seo.favicon, D.cast.members[0].photo, D.cast.members[2].profilePhoto,
                   D.staff.members[0].photo, D.history.items[0].photo, D.shop.photo,
                   D.present.items[0].photo, D.gallery.items[0].src]) {
    assert.ok(isStoreUrl(v), `保管庫のURLになっていません: ${v}`);
  }
  /* 別々の画像には別々のURLが入っている（取り違えていない） */
  const urls = [D.logo, D.seo.favicon, D.cast.members[0].photo, D.cast.members[2].profilePhoto,
                D.staff.members[0].photo, D.history.items[0].photo, D.shop.photo,
                D.present.items[0].photo, D.gallery.items[0].src];
  assert.equal(new Set(urls).size, UNIQUE, "違う画像に同じURLが入っています");
});

test("送るときの置き場所は、最初に見つかった場所で決まる", async () => {
  const fetchImpl = makeFetch();
  await build({ fetchImpl }).toR2Mode();
  const byTag = Object.fromEntries(fetchImpl.uploads().map(u => [u.tag, u.category]));
  assert.deepEqual(byTag, {
    A:"logo",   /* logo → about → cast の順で見つかるので logo */
    B:"favicon", C:"cast", D:"cast", E:"staff",
    F:"history", G:"shop", H:"present", I:"gallery"
  });
});

test("画像以外の値・手入力のURLは、移行しても変わらない", async () => {
  const api = build();
  const D = api.data;
  await api.toR2Mode();
  assert.equal(D.pageTitle, "テスト用");
  assert.equal(D.seo.ogImage, "https://example.com/og.png");
  assert.equal(D.gallery.items[1].src, "photos/01.jpg", "手入力の相対パスが書き換わっています");
  assert.equal(D.gallery.items[2].src, "");
  assert.equal(D.present.items[0].password, "あいことば");
  assert.equal(D.faq.items[0].q, "？");
  assert.equal(D.cast.members[0].name, "あ");
});

/* ================================================================
   3. 保管庫が使えないとき ― データを1文字も変えない
   ================================================================ */

test("file:// で開いているときは、通信もせずデータも変えない", async () => {
  const fetchImpl = makeFetch();
  const api = build({ protocol:"file:", fetchImpl });
  const before = JSON.stringify(api.data);
  await api.toR2Mode();
  assert.equal(JSON.stringify(api.data), before, "データが変わっています");
  assert.equal(fetchImpl.calls.length, 0, "file:// なのに通信しています");
  assert.equal(api.rec.downloads.length, 0, "バックアップを書き出しています");
  assert.equal(api.rec.history.length, 0, "履歴を触っています");
  assert.equal(api.rec.confirms.length, 0, "確認ダイアログを出しています");
  assert.equal(api.rec.modals.length, 1, "案内が出ていません");
  assert.match(api.rec.modals[0], /つながりません/);
});

test("保管庫が応答しないときも、データを変えない", async () => {
  const fetchImpl = makeFetch({ healthOk:false });
  const api = build({ fetchImpl });
  const before = JSON.stringify(api.data);
  await api.toR2Mode();
  assert.equal(JSON.stringify(api.data), before);
  assert.equal(fetchImpl.uploads().length, 0, "つながらないのに画像を送っています");
  assert.equal(api.rec.downloads.length, 0);
  assert.equal(api.rec.history.length, 0);
  assert.match(api.rec.modals[0], /つながりません/);
});

/* ---- 3-2. ページを開いたあとに状況が変わった場合 --------------
   手動確認で見つかった不具合。MediaAPI.probe() はページを開いた時点の結果を
   覚えっぱなしにするため、一括移行の入口でその場で確かめ直す必要がある。 */

test("ページを開いたあとに保管庫が止まったら、案内だけ出してデータを変えない", async () => {
  let live = true;                               /* ページを開いた時点では動いている */
  const fetchImpl = makeFetch({ healthOk: () => live });
  const api = build({ fetchImpl });

  await api.MediaAPI.probe();                    /* 起動時の確認（ここで「使える」と覚える） */
  assert.equal(api.MediaAPI.ready, true);

  live = "down";                                 /* ここで wrangler dev を止めた状況 */
  const before = JSON.stringify(api.data);
  await api.toR2Mode();

  assert.equal(JSON.stringify(api.data), before, "データが変わっています");
  assert.equal(fetchImpl.uploads().length, 0, "止まっているのに画像を送っています");
  assert.equal(api.rec.confirms.length, 0, "確認ダイアログを出しています");
  assert.equal(api.rec.downloads.length, 0, "バックアップを書き出しています");
  assert.equal(api.rec.history.length, 0, "履歴を触っています");
  assert.ok(api.rec.modals.some(m => m.includes("つながりません")), "案内が出ていません");
  assert.equal(api.rec.modals.some(m => m.includes("保管庫へ移しました")), false,
    "移行の結果表示が出てしまっています");
});

test("ページを開いたあとに保管庫が復旧したら、ちゃんと移行できる", async () => {
  let live = "down";                             /* ページを開いた時点では止まっている */
  const fetchImpl = makeFetch({ healthOk: () => live });
  const api = build({ fetchImpl });

  await api.MediaAPI.probe();                    /* 起動時の確認（「使えない」と覚える） */
  assert.equal(api.MediaAPI.ready, false);

  live = true;                                   /* ここで wrangler dev を起動し直した状況 */
  await api.toR2Mode();

  assert.equal(fetchImpl.uploads().length, UNIQUE, "復旧したのに送っていません");
  assert.equal(countDataUrls(api.data), 0, "復旧したのに移行できていません");
  assert.ok(isStoreUrl(api.data.logo));
  assert.equal(api.data.about.photo, api.data.logo, "重複排除も働いているはず");
  assert.deepEqual(api.rec.history, ["push", "commit"]);
});

test("一括移行のたびに、その場で保管庫を確かめ直す", async () => {
  const fetchImpl = makeFetch();
  const api = build({ fetchImpl });
  const healths = () => fetchImpl.calls.filter(c => String(c.url).includes("/api/health")).length;

  await api.MediaAPI.probe();
  assert.equal(healths(), 1, "起動時の確認が1回ではありません");
  await api.toR2Mode();
  assert.equal(healths(), 2, "1回目の一括移行で確かめ直していません");
  await api.toR2Mode();               /* 2回目は移す画像が無いが、確認だけは走る */
  assert.equal(healths(), 3, "2回目の一括移行で確かめ直していません");
});

test("確かめ直した結果は、画面の表示にも反映される", async () => {
  let live = true;
  const fetchImpl = makeFetch({ healthOk: () => live });
  const api = build({ fetchImpl });
  await api.MediaAPI.probe();
  assert.equal(api.mode(), "r2");
  live = "down";
  await api.toR2Mode();
  assert.equal(api.mode(), "warn", "止まっているのに表示が切り替わっていません");
  live = true;
  await api.toR2Mode();
  assert.equal(api.mode(), "r2", "復旧したのに表示が戻っていません");
});

test("file:// では、確かめ直しの通信もしない", async () => {
  const fetchImpl = makeFetch();
  const api = build({ protocol:"file:", fetchImpl });
  assert.equal(await api.mediaAlive(), false);
  assert.equal(fetchImpl.calls.length, 0, "file:// なのに通信しています");
  assert.equal(api.mode(), "local");
});

test("移す画像が1枚も無いときは、何もせず知らせるだけ", async () => {
  const api = build({ data:{ pageTitle:"あ", logo:"photos/logo.png", gallery:{ items:[] } } });
  await api.toR2Mode();
  assert.equal(api.rec.confirms.length, 0, "確認ダイアログを出しています");
  assert.equal(api.rec.downloads.length, 0, "バックアップを書き出しています");
  assert.equal(api.rec.history.length, 0, "履歴を触っています");
  assert.equal(api.rec.toasts.filter(t => t.kind === "warn").length, 1);
});

test("確認ダイアログで「いいえ」を選んだら、何も起きない", async () => {
  const fetchImpl = makeFetch();
  const api = build({ fetchImpl, confirmResult:false });
  const before = JSON.stringify(api.data);
  await api.toR2Mode();
  assert.equal(JSON.stringify(api.data), before, "断ったのにデータが変わっています");
  assert.equal(fetchImpl.uploads().length, 0, "断ったのに画像を送っています");
  assert.equal(api.rec.downloads.length, 0, "断ったのにバックアップを書き出しています");
  assert.equal(api.rec.history.length, 0, "断ったのに履歴を触っています");
  /* 何枚あるかを、確認の文面できちんと伝えている */
  assert.match(api.rec.confirms[0], new RegExp(`${UNIQUE}枚`));
  assert.match(api.rec.confirms[0], new RegExp(`${OCCURRENCES}か所`));
});

/* ================================================================
   4. 移行前のバックアップ
   ================================================================ */

test("移行の前に、いまの内容を .json として書き出す", async () => {
  const api = build();
  const before = JSON.stringify(api.data);
  await api.toR2Mode();
  assert.equal(api.rec.downloads.length, 1, "バックアップの書き出しが1回ではありません");
  const { name, blob } = api.rec.downloads[0];
  assert.match(name, /^elremo-project-backup-\d{8}-\d{4}\.json$/, `名前の形が違います: ${name}`);
  assert.equal(blob.type, "application/json");
  /* 中身は「移行する前」の内容（＝埋め込み画像が入ったまま）であること */
  const saved = await blob.text();
  assert.equal(saved, before, "バックアップが移行前の内容になっていません");
  assert.equal(countDataUrls(JSON.parse(saved)), OCCURRENCES, "バックアップに埋め込み画像が入っていません");
});

test("バックアップの名前が、日付と時刻から作られる", () => {
  const { backupName } = build();
  assert.equal(backupName(new Date(2026, 7, 6, 9, 5)), "elremo-project-backup-20260806-0905.json");
  assert.equal(backupName(new Date(2026, 11, 31, 23, 59)), "elremo-project-backup-20261231-2359.json");
  assert.match(backupName(), /^elremo-project-backup-\d{8}-\d{4}\.json$/);
});

/* ================================================================
   5. 失敗したとき ― 部分成功を許す（作業を止めない）
   ================================================================ */

test("失敗した画像だけ埋め込みのまま残り、ほかは移行される", async () => {
  const fetchImpl = makeFetch({ failFor:["C","G"] });
  const api = build({ fetchImpl });
  const D = api.data;
  await api.toR2Mode();

  assert.equal(D.cast.members[0].photo, IMG.C, "失敗した画像が消えています");
  assert.equal(D.shop.photo,            IMG.G, "失敗した画像が消えています");
  assert.equal(countDataUrls(D), 2, "埋め込みのまま残った数が違います");

  assert.ok(isStoreUrl(D.logo));
  assert.ok(isStoreUrl(D.seo.favicon));
  assert.ok(isStoreUrl(D.gallery.items[0].src));
  /* 結果の表示に、残った数が出ている */
  assert.match(await resultModal(api), /残った場所：<strong>2<\/strong>/);
});

test("失敗した画像も、1回しか送らない（3か所から使われていても）", async () => {
  const fetchImpl = makeFetch({ failFor:["A"] });
  const api = build({ fetchImpl });
  const D = api.data;
  await api.toR2Mode();
  assert.equal(fetchImpl.uploads().filter(u => u.tag === "A").length, 1,
    "失敗した画像を何度も送り直しています");
  /* 3か所とも埋め込みのまま残る */
  assert.equal(D.logo, IMG.A);
  assert.equal(D.about.photo, IMG.A);
  assert.equal(D.cast.members[1].photo, IMG.A);
  assert.equal(countDataUrls(D), 3);
});

test("全部失敗しても、データが壊れない", async () => {
  const fetchImpl = makeFetch({ failFor:["A","B","C","D","E","F","G","H","I"] });
  const api = build({ fetchImpl });
  const before = JSON.stringify(api.data);
  await api.toR2Mode();
  assert.equal(JSON.stringify(api.data), before, "データが壊れています");
  assert.equal(countDataUrls(api.data), OCCURRENCES);
  /* それでも後片付けは走る（画面が固まらない） */
  assert.equal(api.rec.closed, 1, "進捗の表示が閉じられていません");
  assert.deepEqual(api.rec.history, ["push", "commit"]);
});

test("移行の途中で値が変わった場所には、あとから触らない", async () => {
  /* IMG.A を送っている最中に、別の参照場所（about.photo）が書き換わった状況 */
  let data;
  const fetchImpl = makeFetch({ onUpload: tag => { if (tag === "A") data.about.photo = "photos/差し替え.jpg"; } });
  data = sampleData();
  const api = build({ data, fetchImpl });
  await api.toR2Mode();
  assert.equal(data.about.photo, "photos/差し替え.jpg", "あとから上書きしてしまっています");
  assert.ok(isStoreUrl(data.logo));
  assert.equal(data.cast.members[1].photo, data.logo, "他の場所は置き換わるはずです");
});

/* ================================================================
   6. 履歴・保存・再描画・画面表示
   ================================================================ */

test("履歴は「移行前を1回積んで、終わりに確定」だけ", async () => {
  const api = build();
  await api.toR2Mode();
  assert.deepEqual(api.rec.history, ["push", "commit"], "Undo の粒度が変わっています");
});

test("終わったあとに、保存と再描画が1回ずつ走る", async () => {
  const api = build();
  await api.toR2Mode();
  assert.deepEqual(api.rec.calls, ["persist", "renderTabs", "renderPane", "refreshPreview"]);
  assert.equal(api.rec.closed, 1, "進捗の表示が閉じられていません");
});

test("進捗が最後まで進み、結果が表示される", async () => {
  const api = build();
  await api.toR2Mode();
  assert.equal(api.progress.textContent, `${OCCURRENCES} / ${OCCURRENCES}`);
  assert.match(api.rec.modals.join("\n"), /移しています/, "進捗の表示が出ていません");
  const last = await resultModal(api);
  assert.match(last, new RegExp(`移した場所：<strong>${OCCURRENCES}</strong>`));
  assert.match(last, new RegExp(`画像 ${UNIQUE} 枚`));
  assert.match(last, /Ctrl\+Z/, "戻し方の案内がありません");
});

/* ================================================================
   7. 安全まわり
   ================================================================ */

test("送信先は同一オリジンの相対パスだけ", async () => {
  const fetchImpl = makeFetch();
  await build({ fetchImpl }).toR2Mode();
  assert.ok(fetchImpl.calls.length > 0);
  for (const c of fetchImpl.calls) {
    assert.ok(String(c.url).startsWith("/api/"), `外部の住所へ送っています: ${c.url}`);
  }
});

test("パソコンのファイル名を送らない", async () => {
  const fetchImpl = makeFetch();
  await build({ fetchImpl }).toR2Mode();
  for (const u of fetchImpl.uploads()) {
    assert.equal(u.fileName, "image", "固定名以外を送っています");
    assert.deepEqual([...u.init.body.keys()].sort(), ["category", "file"]);
  }
});

test("一括移行のコードに、CORS をゆるめる書き方や外部の住所がない", () => {
  for (const ng of ["no-cors", "credentials", "Access-Control-Allow-Origin", "crossOrigin", "https://"]) {
    assert.equal(SRC_MIGRATE.includes(ng), false, `一括移行のコードに ${ng} が入っています`);
  }
  /* 案内文に出るローカルの住所だけは、書いてあってよい */
  const withoutLocal = SRC_MIGRATE.split("127.0.0.1:8787").join("");
  assert.equal(withoutLocal.includes("http://"), false, "外部の住所が入っています");
});

test("画面に出す文章に、エラーコードなどの内部情報が混ざらない", async () => {
  const fetchImpl = makeFetch({ failFor:["A"] });
  const api = build({ fetchImpl });
  await api.toR2Mode();
  const shown = api.rec.modals.join("\n") + "\n" + api.rec.toasts.map(t => t.msg).join("\n")
              + "\n" + api.rec.confirms.join("\n");
  for (const leak of ["R2_ERROR", "Error", "bucket", "media/", "stack"]) {
    assert.equal(shown.includes(leak), false, `内部情報が混ざっています: ${leak}`);
  }
});

/* ================================================================
   8. 既存の機能を壊していないこと（静的な確認）
   ================================================================ */

test("メニューと動作の割り当てに、一括移行が1つだけ足されている", () => {
  assert.equal(HTML.split('data-act="toR2Mode"').length - 1, 1, "メニュー項目の数が想定と違います");
  assert.equal(HTML.split('act==="toR2Mode"').length - 1, 1, "動作の割り当ての数が想定と違います");
  assert.equal(HTML.split("async function toR2Mode(){").length - 1, 1, "toR2Mode() が1つではありません");
  assert.equal(HTML.split("function collectEmbedded(root){").length - 1, 1, "collectEmbedded() が1つではありません");
  /* 従来の「URL方式にする」も、隣に残っている */
  assert.ok(HTML.includes('data-act="toUrlMode"'), "URL方式のメニューが消えています");
  assert.ok(HTML.includes('act==="toUrlMode"') , "URL方式の動作の割り当てが消えています");
});

test("toUrlMode()（zip書き出し）に手を入れていない", () => {
  const src = slice("function toUrlMode(){", "\n/* ============", "toUrlMode");
  /* 場所（path）を持たない、もとの walk のまま */
  assert.ok(src.includes("function walk(o){"), "toUrlMode() の walk が変わっています");
  assert.ok(src.includes("const files=[], seen=new Map();"), "toUrlMode() の先頭が変わっています");
  assert.ok(src.includes('download("photos.zip", makeZip(files));'), "zip の書き出しが変わっています");
  assert.equal(src.includes("storeImage"), false, "toUrlMode() に保管庫の処理が混ざっています");
});

test("互換性の目印が壊れていないこと", () => {
  assert.ok(HTML.includes("elremo_editor_data_v9"), "保存キーが変わっています");
  assert.ok(HTML.includes("elremo_editor_data_v1"), "旧キーの読み込みが消えています");
  assert.ok(HTML.includes("SITE_DATA_END"), "保存HTMLの読み込みの目印が変わっています");
  assert.ok(HTML.includes('elm("input","urlin")'), "URL手入力欄が消えています");
  assert.ok(HTML.includes("function shrinkImage(file, maxSide){"), "画像の縮小が変わっています");
  assert.ok(HTML.includes("async function storeImage(dataUrl, path){"), "Phase 2-2 の保存処理が変わっています");
});
