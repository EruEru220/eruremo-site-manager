/* ================================================================
   Phase 4.5 の回帰テスト
   （画像URLの住所の付け替え ＋ 環境の表示）

   実行方法:  node --test "test/*.test.mjs"
   外部パッケージは使いません（Node.js 標準の node:test のみ）。
   ネットワークにも出ません。

   考え方（Phase 2-2 / 3 / 4 のテストと同じ）:
     eruremo_SiteManager.html からソースコードそのものを切り出して動かします。
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

/* Phase 2-2 の部分（MEDIA_URL_RE / isMediaUrl / setEnvBadge など） */
const SRC_MEDIA  = slice("/* 画像の置き場所。Worker 側の固定リスト", "let webpOK=null;", "保管庫の処理");
/* Phase 4 の mediaKeyOf（付け替えが使う） */
const SRC_KEYOF  = slice("/* 保管庫の画像URLから、キー", "/* 一覧の状態。開くたびに", "mediaKeyOf");
/* Phase 4.5 の本体 */
const SRC_REBASE = slice("/* 頭の住所として受け付けるかたち。", "\n/* ====", "住所の付け替え");

const BASE_LOCAL = "http://127.0.0.1:8787";
const key = (cat, hash, ext = "webp") => `media/${cat}/2026/08/${hash}.${ext}`;
const H = { LOGO: "0000000000000001", CAST: "0000000000000002", GAL: "0000000000000003" };

/* ---- 動かすための入れ物 --------------------------------------- */
function fakeEl(){
  const set = new Set();
  return { title: "", textContent: "", hidden: false, value: "", listeners: {},
    classList: { add: (...c) => c.forEach(x => set.add(x)),
                 remove: (...c) => c.forEach(x => set.delete(x)),
                 contains: c => set.has(c) },
    addEventListener(t, f){ (this.listeners[t] = this.listeners[t] || []).push(f); },
    click(){ return Promise.all((this.listeners.click || []).map(f => f())); } };
}

function build({ data = null, protocol = "http:", origin = "https://example.invalid",
                 confirmResult = true } = {}){
  const rec = { modals: [], toasts: [], confirms: [], closed: 0, calls: [], history: [] };
  const els = {
    "#mediaMode": fakeEl(), "#mediaModeText": fakeEl(), "#envBadge": fakeEl(),
    "#rbInput": fakeEl(), "#rbRel": fakeEl(), "#rbHere": fakeEl(), "#rbApply": fakeEl()
  };
  const $ = sel => els[sel] || null;
  const note = name => () => rec.calls.push(name);
  const DATA = data || sampleData();

  const fn = new Function(
    "location", "fetch", "toast", "$", "DATA", "History", "persist", "renderTabs", "renderPane",
    "refreshPreview", "openModal", "closeModal", "confirm", "escHtml", `
      ${SRC_MEDIA}
      ${SRC_KEYOF}
      ${SRC_REBASE}
      return { normalizeMediaBase, mediaBases, rebaseMediaUrls, openRebaseMedia,
               applyRebase, mediaKeyOf, setEnvBadge };
    `);

  const api = fn(
    { protocol, origin },
    async () => { throw new Error("このテストでは通信しません"); },
    (msg, kind) => rec.toasts.push({ msg: String(msg), kind }),
    $, DATA,
    { push: () => rec.history.push("push"), commit: () => rec.history.push("commit") },
    note("persist"), note("renderTabs"), note("renderPane"), note("refreshPreview"),
    html => rec.modals.push(String(html)),
    () => rec.closed++,
    msg => { rec.confirms.push(String(msg)); return confirmResult; },
    s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
  );
  api.rec = rec; api.data = DATA; api.els = els;
  return api;
}

function sampleData(){
  return {
    pageTitle: "テスト用",
    logo: `${BASE_LOCAL}/${key("logo", H.LOGO, "png")}`,
    seo: { favicon: "", ogImage: "https://example.com/og.png", siteUrl: "https://example.com" },
    about: { photo: "data:image/png;base64,QUJD", text: "説明" },
    cast: { members: [{ name: "あ", photo: `${BASE_LOCAL}/${key("cast", H.CAST, "jpg")}` },
                      { name: "い", photo: "photos/01.jpg" }] },
    gallery: { items: [{ src: `${BASE_LOCAL}/${key("gallery", H.GAL)}` },
                       { src: `${BASE_LOCAL}/${key("gallery", H.GAL)}` },  /* 同じ画像を2か所で */
                       { src: "https://example.com/other.png" },
                       { src: "" }] },
    faq: { items: [{ q: "？", a: "！" }] }
  };
}

/* ================================================================
   1. 新しい住所の受け付け方
   ================================================================ */

test("受け付ける住所のかたち", () => {
  const { normalizeMediaBase } = build();
  assert.equal(normalizeMediaBase(""), "");
  assert.equal(normalizeMediaBase("   "), "");
  assert.equal(normalizeMediaBase(null), "");
  assert.equal(normalizeMediaBase("https://images.example.com"), "https://images.example.com");
  assert.equal(normalizeMediaBase("https://images.example.com/"), "https://images.example.com");
  assert.equal(normalizeMediaBase("https://images.example.com///"), "https://images.example.com");
  assert.equal(normalizeMediaBase("  http://127.0.0.1:8787  "), "http://127.0.0.1:8787");
});

test("http(s) 以外の住所は受け付けない", () => {
  const { normalizeMediaBase } = build();
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://x.example.com",
                     "images.example.com", "//images.example.com", "/media", "https://"]) {
    assert.equal(normalizeMediaBase(bad), null, bad);
  }
});

/* ================================================================
   2. いま使われている住所を数える
   ================================================================ */

test("いま使われている住所と件数が分かる", () => {
  const { mediaBases } = build();
  const bases = mediaBases(sampleData());
  assert.deepEqual(bases, [{ base: BASE_LOCAL, count: 4 }]);
});

test("相対パスは「住所なし」として数える", () => {
  const { mediaBases } = build();
  const bases = mediaBases({ logo: `/${key("logo", H.LOGO, "png")}` });
  assert.deepEqual(bases, [{ base: "", count: 1 }]);
});

test("住所が混ざっていても、それぞれ数える", () => {
  const { mediaBases } = build();
  const bases = mediaBases({
    a: `${BASE_LOCAL}/${key("logo", H.LOGO, "png")}`,
    b: `https://images.example.com/${key("cast", H.CAST, "jpg")}`,
    c: `https://images.example.com/${key("gallery", H.GAL)}`
  });
  assert.deepEqual(bases, [
    { base: "https://images.example.com", count: 2 },
    { base: BASE_LOCAL, count: 1 }
  ]);
});

test("保管庫の画像が無ければ、空を返す", () => {
  const { mediaBases } = build();
  assert.deepEqual(mediaBases({ a: "photos/01.jpg", b: "data:image/png;base64,QUJD", c: "" }), []);
});

/* ================================================================
   3. 付け替え（いちばん大事なところ）
   ================================================================ */

test("絶対URLを相対パスにできる", () => {
  const api = build();
  const n = api.rebaseMediaUrls(api.data, "");
  assert.equal(n, 4);
  assert.equal(api.data.logo, `/${key("logo", H.LOGO, "png")}`);
  assert.equal(api.data.cast.members[0].photo, `/${key("cast", H.CAST, "jpg")}`);
  assert.equal(api.data.gallery.items[0].src, `/${key("gallery", H.GAL)}`);
  assert.equal(api.data.gallery.items[1].src, `/${key("gallery", H.GAL)}`);
});

test("相対パスを絶対URLにできる", () => {
  const api = build({ data: { logo: `/${key("logo", H.LOGO, "png")}` } });
  const n = api.rebaseMediaUrls(api.data, "https://images.example.com");
  assert.equal(n, 1);
  assert.equal(api.data.logo, `https://images.example.com/${key("logo", H.LOGO, "png")}`);
});

test("別の住所へ付け替えられる（目印は変わらない）", () => {
  const api = build();
  api.rebaseMediaUrls(api.data, "https://images.example.com");
  assert.equal(api.data.logo, `https://images.example.com/${key("logo", H.LOGO, "png")}`);
  /* うしろの目印がそのままであること */
  assert.equal(api.mediaKeyOf(api.data.logo), key("logo", H.LOGO, "png"));
});

test("保管庫の画像でないものには1文字も触らない", () => {
  const api = build();
  const before = {
    pageTitle: api.data.pageTitle,
    ogImage: api.data.seo.ogImage,
    siteUrl: api.data.seo.siteUrl,
    aboutPhoto: api.data.about.photo,
    manual: api.data.cast.members[1].photo,
    other: api.data.gallery.items[2].src,
    empty: api.data.gallery.items[3].src,
    faq: api.data.faq.items[0].q
  };
  api.rebaseMediaUrls(api.data, "https://images.example.com");
  assert.equal(api.data.pageTitle, before.pageTitle);
  assert.equal(api.data.seo.ogImage, before.ogImage);
  assert.equal(api.data.seo.siteUrl, before.siteUrl);
  assert.equal(api.data.about.photo, before.aboutPhoto, "埋め込み画像が書き換えられています");
  assert.equal(api.data.cast.members[1].photo, before.manual, "手入力のパスが書き換えられています");
  assert.equal(api.data.gallery.items[2].src, before.other);
  assert.equal(api.data.gallery.items[3].src, before.empty);
  assert.equal(api.data.faq.items[0].q, before.faq);
});

test("同じ住所への付け替えは、何も変えない", () => {
  const api = build();
  const n = api.rebaseMediaUrls(api.data, BASE_LOCAL);
  assert.equal(n, 0);
});

test("何度やっても結果が変わらない（繰り返し実行して安全）", () => {
  const api = build();
  api.rebaseMediaUrls(api.data, "https://images.example.com");
  const once = JSON.stringify(api.data);
  api.rebaseMediaUrls(api.data, "https://images.example.com");
  assert.equal(JSON.stringify(api.data), once);
});

test("配列の中の文字列も付け替えられる", () => {
  const api = build({ data: { list: [`${BASE_LOCAL}/${key("gallery", H.GAL)}`, "photos/01.jpg", ""] } });
  const n = api.rebaseMediaUrls(api.data, "");
  assert.equal(n, 1);
  assert.deepEqual(api.data.list, [`/${key("gallery", H.GAL)}`, "photos/01.jpg", ""]);
});

test("深い階層の中も付け替えられる", () => {
  const api = build({ data: { a: [{ b: [{ c: { d: `${BASE_LOCAL}/${key("staff", H.GAL)}` } }] }] } });
  assert.equal(api.rebaseMediaUrls(api.data, ""), 1);
  assert.equal(api.data.a[0].b[0].c.d, `/${key("staff", H.GAL)}`);
});

test("データのかたち（キーの並び）を変えない", () => {
  const api = build();
  const before = Object.keys(api.data).join(",");
  api.rebaseMediaUrls(api.data, "");
  assert.equal(Object.keys(api.data).join(","), before);
  assert.equal(api.data.gallery.items.length, 4);
  assert.equal(api.data.cast.members.length, 2);
});

/* ================================================================
   4. 画面からの操作
   ================================================================ */

test("付け替えると、履歴・保存・再描画が呼ばれる", () => {
  const api = build();
  api.applyRebase("");
  assert.deepEqual(api.rec.history, ["push", "commit"], "Ctrl+Z で戻せる形になっていません");
  assert.ok(api.rec.calls.includes("persist"));
  assert.ok(api.rec.calls.includes("renderPane"));
  assert.ok(api.rec.calls.includes("refreshPreview"));
  assert.equal(api.rec.closed, 1);
  assert.match(api.rec.toasts.at(-1).msg, /4か所/);
});

test("確認でやめたら、1文字も変えない", () => {
  const api = build({ confirmResult: false });
  const before = JSON.stringify(api.data);
  api.applyRebase("");
  assert.equal(JSON.stringify(api.data), before);
  assert.deepEqual(api.rec.history, [], "やめたのに履歴を積んでいます");
  assert.equal(api.rec.calls.length, 0);
});

test("受け付けられない住所は、確認も出さずに断る", () => {
  const api = build();
  const before = JSON.stringify(api.data);
  api.applyRebase("javascript:alert(1)");
  assert.equal(JSON.stringify(api.data), before);
  assert.equal(api.rec.confirms.length, 0);
  assert.match(api.rec.toasts.at(-1).msg, /https:\/\//);
});

test("保管庫の画像が無ければ、案内だけ出して終わる", async () => {
  const api = build({ data: { a: "photos/01.jpg" } });
  await api.openRebaseMedia();
  assert.equal(api.rec.modals.length, 0);
  assert.match(api.rec.toasts.at(-1).msg, /まだ使われていません/);
});

test("いまの住所の一覧が画面に出る", async () => {
  const api = build();
  await api.openRebaseMedia();
  const m = api.rec.modals[0];
  assert.match(m, /住所を付け替える/);
  assert.match(m, /127\.0\.0\.1:8787/);
  assert.match(m, /4か所/);
});

test("住所の表示は、そのままHTMLとして解釈させない", async () => {
  const evil = "https://evil.example.com/<img src=x onerror=alert(1)>";
  const api = build({ data: { a: `${evil}/${key("gallery", H.GAL)}` } });
  await api.openRebaseMedia();
  const m = api.rec.modals[0];
  assert.equal(m.includes("<img src=x onerror"), false, "エスケープされていません");
  assert.match(m, /&lt;img/);
});

/* ================================================================
   5. 環境の表示（Phase 4.5）
   ================================================================ */

test("ステージングでは帯が出る", () => {
  const api = build();
  api.setEnvBadge("staging");
  assert.equal(api.els["#envBadge"].hidden, false);
  assert.match(api.els["#envBadge"].textContent, /ステージング/);
});

test("本番では別の帯が出る", () => {
  const api = build();
  api.setEnvBadge("production");
  assert.equal(api.els["#envBadge"].hidden, false);
  assert.match(api.els["#envBadge"].textContent, /本番/);
});

test("ローカルや不明のときは帯を出さない", () => {
  const api = build();
  for (const v of ["local", "unknown", "", null, undefined, "staging2"]) {
    api.setEnvBadge("staging");          /* いったん出してから */
    api.setEnvBadge(v);
    assert.equal(api.els["#envBadge"].hidden, true, String(v));
    assert.equal(api.els["#envBadge"].textContent, "", String(v));
  }
});

/* ================================================================
   6. 画面の作りが崩れていないか（HTMLそのものの確認）
   ================================================================ */

test("メニューに「画像URLの住所を付け替える」がある", () => {
  assert.match(HTML, /data-act="rebaseMedia"[^>]*>🔁 画像URLの住所を付け替える</);
  assert.match(HTML, /act==="rebaseMedia"\) openRebaseMedia\(\)/);
});

test("環境の帯の置き場所がある", () => {
  assert.match(HTML, /id="envBadge"/);
  assert.match(HTML, /\.env-badge\{/);
});

test("Phase 2-2 / 3 / 4 の関数には手を入れていない", () => {
  for (const marker of [
    "async function toR2Mode(){",
    "function collectEmbedded(root){",
    "async function mediaAlive(){",
    "function toUrlMode(){",
    "async function storeImage(dataUrl, path){",
    "async function openMediaLibrary(){",
    "function removeMediaCardsByKey(key){",
    "async function handleFile(f){"
  ]) {
    assert.ok(HTML.includes(marker), `失われています: ${marker}`);
  }
});

test("付け替えの処理は、保管庫に一切アクセスしない", () => {
  for (const forbidden of ["fetch(", "/api/media", "mediaDeleteOne", "mediaListPage"]) {
    assert.equal(SRC_REBASE.includes(forbidden), false, `含まれてはいけません: ${forbidden}`);
  }
});
