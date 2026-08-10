/* ================================================================
   Phase 4 の回帰テスト
   （保管庫の画像の一覧・使用中の判定・使っていない画像の削除）

   実行方法:  node --test "test/*.test.mjs"
   外部パッケージは使いません（Node.js 標準の node:test のみ）。
   ネットワークにも出ません（fetch は偽物に差し替えます）。

   考え方（Phase 2-2 / Phase 3 のテストと同じ）:
     eruremo_SiteManager.html からソースコードそのものを切り出して動かします。
     テスト用に書き直したコピーではなく、本物のコードを確かめます。
     画面（DOM）も、必要な部分だけの小さな偽物を用意します。
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

/* Phase 2-2 の部分（MEDIA_URL_RE / isMediaUrl / setMediaMode / MediaAPI） */
const SRC_MEDIA = slice("/* 画像の置き場所。Worker 側の固定リスト", "let webpOK=null;", "保管庫の処理");
/* Phase 3 の mediaAlive()（その場で生死を確かめ直す） */
const SRC_ALIVE = slice("async function mediaAlive(){", "async function toR2Mode(){", "mediaAlive");
/* Phase 4 の本体 */
const SRC_LIB   = slice("/* 保管庫の画像URLから、キー", "\n/* ====", "保管庫の整理");

/* ---- テスト用のデータ ---------------------------------------- */
const BASE = "http://127.0.0.1:8787";
const keyOf = (cat, hash, ext = "png") => `media/${cat}/2026/08/${hash}.${ext}`;
const urlOf = (cat, hash, ext = "png") => `${BASE}/${keyOf(cat, hash, ext)}`;

/* 一覧が返す1件分 */
function item(cat, hash, opts = {}){
  const ext = opts.ext || "png";
  return {
    key: keyOf(cat, hash, ext),
    url: urlOf(cat, hash, ext),
    category: cat,
    size: opts.size == null ? 12345 : opts.size,
    uploaded: opts.uploaded === undefined ? "2026-08-06T12:00:00.000Z" : opts.uploaded,
    ...(opts.extra || {})
  };
}

const H = {
  LOGO:    "0000000000000001",
  CAST:    "0000000000000002",
  GALLERY: "0000000000000003",
  FREE_A:  "00000000000000aa",
  FREE_B:  "00000000000000bb",
  FREE_C:  "00000000000000cc"
};

/* logo / cast / gallery の3枚だけが「使用中」のデータ */
function sampleData(){
  return {
    pageTitle: "テスト用",
    logo: urlOf("logo", H.LOGO),
    seo: { favicon: "", ogImage: "https://example.com/og.png", siteUrl: "https://example.com" },
    about: { photo: "data:image/png;base64,QUJD", text: "説明" },   /* まだ埋め込みのもの */
    cast: { members: [{ name: "あ", photo: urlOf("cast", H.CAST) },
                      { name: "い", photo: "photos/01.jpg" }] },     /* 手入力のパス */
    gallery: { items: [{ src: urlOf("gallery", H.GALLERY), cap: "", alt: "" },
                       { src: "https://example.com/other.png", cap: "", alt: "" },
                       { src: "", cap: "", alt: "" }] },
    faq: { items: [{ q: "？", a: "！" }] }
  };
}

/* ---- 小さな偽の画面（DOM） ------------------------------------ */
function makeEl(tag){
  const el = {
    tagName: String(tag), className: "", textContent: "", type: "",
    src: "", alt: "", loading: "", title: "", disabled: false,
    style: {}, dataset: {}, children: [], parent: null, listeners: {},
    classList: {
      add(...c){ const s = new Set(el.className.split(" ").filter(Boolean)); c.forEach(x => s.add(x)); el.className = [...s].join(" "); },
      remove(...c){ const s = new Set(el.className.split(" ").filter(Boolean)); c.forEach(x => s.delete(x)); el.className = [...s].join(" "); },
      contains(c){ return el.className.split(" ").includes(c); }
    },
    appendChild(child){ if (child) { child.parent = el; el.children.push(child); } return child; },
    append(...nodes){ nodes.forEach(n => el.appendChild(n)); },
    replaceChildren(...nodes){ el.children = []; nodes.forEach(n => el.appendChild(n)); },
    remove(){
      if (!el.parent) return;
      const i = el.parent.children.indexOf(el);
      if (i >= 0) el.parent.children.splice(i, 1);
      el.parent = null;
    },
    addEventListener(type, fn){ (el.listeners[type] = el.listeners[type] || []).push(fn); },
    /* 本物のブラウザと同じく、押せない状態のボタンでは動作が起きない */
    click(){
      if (el.disabled) return Promise.resolve([]);
      return Promise.all((el.listeners.click || []).map(f => f()));
    },
    querySelector(sel){
      const want = sel.replace(/^\./, "");
      const dig = n => {
        for (const c of n.children || []) {
          if (typeof c.className === "string" && c.className.split(" ").includes(want)) return c;
          const found = dig(c);
          if (found) return found;
        }
        return null;
      };
      return dig(el);
    }
  };
  return el;
}

function fakeChip(){
  const set = new Set(["media-off"]);
  return { title: "", textContent: "",
    classList: { add: (...c) => c.forEach(x => set.add(x)),
                 remove: (...c) => c.forEach(x => set.delete(x)),
                 contains: c => set.has(c) } };
}

const reply = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status, json: async () => body
});

/* ---- 偽の fetch ---------------------------------------------- */
/*  healthOk … true / false / "down"（通信そのものが失敗する）
    pages    … cursor をキーにした一覧の返事（"" が1ページ目）
    deleteOk … 削除の成否
    onDelete … 削除の送信時に呼ばれる（送信中にデータを変えたい時に使う） */
function makeFetch({ healthOk = true, pages = null, deleteOk = true, onDelete = null } = {}){
  const calls = [];
  const impl = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init: init || null });

    if (u.includes("/api/health")) {
      if (healthOk === "down") throw new Error("つながりません");
      return healthOk ? reply({ ok: true, service: "eruremo-media-api", environment: "local" })
                      : reply({ ok: false }, 500);
    }

    if (u.startsWith("/api/media/item")) {
      const key = JSON.parse(init.body).key;
      if (onDelete) await onDelete(key);
      return deleteOk ? reply({ ok: true, key, trashed: true })
                      : reply({ ok: false, error: { code: "R2_ERROR", message: "…" } }, 500);
    }

    if (u.startsWith("/api/media")) {
      const m = /[?&]cursor=([^&]*)/.exec(u);
      const cursor = m ? decodeURIComponent(m[1]) : "";
      const page = (pages || { "": { items: [] } })[cursor];
      assert.ok(page, `用意していない cursor で一覧が呼ばれました: ${JSON.stringify(cursor)}`);
      if (page.fail) return reply({ ok: false, error: { code: "R2_ERROR" } }, 500);
      const body = { ok: true, items: page.items, truncated: !!page.cursor };
      if (page.cursor) body.cursor = page.cursor;
      return reply(body);
    }

    throw new Error("想定していないURLが呼ばれました: " + u);
  };
  impl.calls = calls;
  impl.lists = () => calls.filter(c => c.url.startsWith("/api/media") && !c.url.startsWith("/api/media/item"));
  impl.deletes = () => calls.filter(c => c.url.startsWith("/api/media/item"));
  return impl;
}

/* ---- 切り出したコードを動かすための入れ物 -------------------- */
function build({ protocol = "http:", data = sampleData(), fetchImpl = makeFetch(),
                 confirmResult = true } = {}){
  const rec = { modals: [], toasts: [], confirms: [] };
  const chip = fakeChip(), chipText = { textContent: "" };
  const dom = { body: makeEl("div"), more: makeEl("button"), count: makeEl("span"), open: true };

  const $ = sel => {
    if (sel === "#mediaMode") return chip;
    if (sel === "#mediaModeText") return chipText;
    if (!dom.open) return null;                 /* モーダルを閉じた状態 */
    if (sel === "#mlibBody") return dom.body;
    if (sel === "#mlibMore") return dom.more;
    if (sel === "#mlibCount") return dom.count;
    return null;
  };

  const documentStub = {
    createElement: makeEl,
    createTextNode: s => ({ textContent: String(s), nodeType: 3 })
  };
  const elm = (tag, cls, text) => {
    const n = makeEl(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const fmtSize = b => b < 1024 ? b + " B"
                     : b < 1048576 ? (b / 1024).toFixed(0) + " KB"
                     : (b / 1048576).toFixed(2) + " MB";

  const fn = new Function(
    "location", "fetch", "toast", "$", "DATA", "document", "openModal", "confirm", "elm", "fmtSize", `
      ${SRC_MEDIA}
      ${SRC_ALIVE}
      ${SRC_LIB}
      return { mediaKeyOf, usedMediaKeys, mediaListPage, mediaDeleteOne,
               openMediaLibrary, loadMediaPage, mediaCardEl, deleteMediaItem,
               updateMediaCount, mediaDate, MediaAPI };
    `);

  const api = fn(
    { protocol }, fetchImpl,
    (msg, kind) => rec.toasts.push({ msg: String(msg), kind }),
    $, data, documentStub,
    html => rec.modals.push(String(html)),
    msg => { rec.confirms.push(String(msg)); return confirmResult; },
    elm, fmtSize
  );

  api.rec = rec; api.data = data; api.dom = dom; api.fetchImpl = fetchImpl;
  /* 一覧に並んでいるカード（説明文だけの時は空になる） */
  api.cards = () => dom.body.children.filter(c => c.className.includes("mlib-card"));
  api.cardFor = key => api.cards().find(c => (c.children[0] || {}).src === `${BASE}/${key}`);
  api.badgeOf = card => card.querySelector(".mlib-badge");
  api.buttonOf = card => card.children[card.children.length - 1];
  return api;
}

/* ================================================================
   1. 使用中かどうかの見分け方
   ================================================================ */

test("保管庫のURLから、キーだけを取り出せる", () => {
  const { mediaKeyOf } = build();
  assert.equal(mediaKeyOf(urlOf("logo", H.LOGO)), keyOf("logo", H.LOGO));
  assert.equal(mediaKeyOf("https://images.eruremo.com/" + keyOf("cast", H.CAST)),
               keyOf("cast", H.CAST));
  assert.equal(mediaKeyOf("/" + keyOf("gallery", H.GALLERY, "webp")),
               keyOf("gallery", H.GALLERY, "webp"));
});

test("保管庫の画像でないものからは、キーを取り出さない", () => {
  const { mediaKeyOf } = build();
  for (const v of [
    "", "photos/01.jpg", "https://example.com/a.png",
    "data:image/png;base64,QUJD",
    `${BASE}/media/unknown/2026/08/0000000000000001.png`,   /* 許可されていない置き場所 */
    `${BASE}/media/logo/2026/08/0000000000000001.gif`,      /* 許可されていない拡張子 */
    `${BASE}/media/logo/2026/08/0000000000000001.png?x=1`,  /* 後ろに何か付いている */
    `${BASE}/media/logo/26/08/0000000000000001.png`,
    null, undefined, 123, {}, []
  ]) {
    assert.equal(mediaKeyOf(v), "", `キーとして拾ってしまいました: ${String(v)}`);
  }
});

test("データの中で使われている画像を、すべて見つける", () => {
  const { usedMediaKeys } = build();
  const used = usedMediaKeys(sampleData());
  assert.deepEqual([...used].sort(), [
    keyOf("cast", H.CAST), keyOf("gallery", H.GALLERY), keyOf("logo", H.LOGO)
  ].sort());
});

test("同じ画像が何か所から使われていても、1件として数える", () => {
  const { usedMediaKeys } = build();
  const u = urlOf("logo", H.LOGO);
  const used = usedMediaKeys({ logo: u, about: { photo: u }, cast: { members: [{ photo: u }] } });
  assert.equal(used.size, 1);
});

test("深い階層・配列の中の画像も見つける", () => {
  const { usedMediaKeys } = build();
  const used = usedMediaKeys({
    a: [{ b: [{ c: { d: urlOf("staff", H.FREE_A) } }] }],
    e: null, f: 0, g: false, h: undefined
  });
  assert.deepEqual([...used], [keyOf("staff", H.FREE_A)]);
});

/* ================================================================
   2. 保管庫につながらないとき（何もしない）
   ================================================================ */

test("保管庫につながらなければ、一覧を読みに行かず案内だけ出す", async () => {
  const f = makeFetch({ healthOk: false });
  const api = build({ fetchImpl: f });
  await api.openMediaLibrary();
  assert.equal(f.lists().length, 0, "つながらないのに一覧を読みに行っています");
  assert.equal(api.rec.modals.length, 1);
  assert.match(api.rec.modals[0], /つながりません/);
  assert.match(api.rec.modals[0], /npm run dev/);
});

test("通信そのものが失敗しても、案内だけ出して終わる", async () => {
  const f = makeFetch({ healthOk: "down" });
  const api = build({ fetchImpl: f });
  await api.openMediaLibrary();
  assert.equal(f.lists().length, 0);
  assert.match(api.rec.modals[0], /つながりません/);
});

test("file:// で開いているときは、問い合わせもしない", async () => {
  const f = makeFetch();
  const api = build({ protocol: "file:", fetchImpl: f });
  await api.openMediaLibrary();
  assert.equal(f.calls.length, 0, "file:// なのに通信しています");
  assert.match(api.rec.modals[0], /つながりません/);
});

test("開くたびに、その場で保管庫の生死を確かめ直す", async () => {
  const f = makeFetch({ pages: { "": { items: [] } } });
  const api = build({ fetchImpl: f });
  await api.openMediaLibrary();
  await api.openMediaLibrary();
  assert.equal(f.calls.filter(c => c.url.includes("/api/health")).length, 2);
});

/* ================================================================
   3. 一覧の表示
   ================================================================ */

const threePages = () => ({
  "": { items: [
    item("logo", H.LOGO), item("cast", H.CAST), item("gallery", H.GALLERY),
    item("other", H.FREE_A), item("shop", H.FREE_B)
  ] }
});

test("保管庫の画像が一覧に並ぶ", async () => {
  const api = build({ fetchImpl: makeFetch({ pages: threePages() }) });
  await api.openMediaLibrary();
  assert.equal(api.cards().length, 5);
});

test("1枚ずつサムネイル（画像）が付く", async () => {
  const api = build({ fetchImpl: makeFetch({ pages: threePages() }) });
  await api.openMediaLibrary();
  const card = api.cardFor(keyOf("logo", H.LOGO));
  const img = card.children[0];
  assert.equal(img.tagName, "img");
  assert.equal(img.src, urlOf("logo", H.LOGO));
  assert.equal(img.loading, "lazy", "遅延読み込みになっていません");
  assert.equal(img.alt, "");
});

test("使用中と使っていないが、見た目で区別される", async () => {
  const api = build({ fetchImpl: makeFetch({ pages: threePages() }) });
  await api.openMediaLibrary();

  const inUse = api.cardFor(keyOf("logo", H.LOGO));
  assert.equal(inUse.className.includes("in-use"), true);
  assert.equal(api.badgeOf(inUse).textContent, "使用中");

  const free = api.cardFor(keyOf("other", H.FREE_A));
  assert.equal(free.className.includes("in-use"), false);
  assert.equal(api.badgeOf(free).textContent, "使っていない");
});

test("置き場所・大きさ・日付が表示される", async () => {
  const api = build({ fetchImpl: makeFetch({ pages: {
    "": { items: [item("gallery", H.FREE_A, { size: 204800 })] } } }) });
  await api.openMediaLibrary();
  const meta = api.cards()[0].children[2];
  const text = meta.children.map(c => c.textContent).join("");
  assert.match(text, /gallery/);
  assert.match(text, /200 KB/);
  assert.match(text, /2026\/08\/06/);
});

test("枚数の内訳（使用中／使っていない）が出る", async () => {
  const api = build({ fetchImpl: makeFetch({ pages: threePages() }) });
  await api.openMediaLibrary();
  assert.equal(api.dom.count.textContent, "5枚（使用中 3枚／使っていない 2枚）");
});

test("保管庫が空なら、その旨を出す", async () => {
  const api = build({ fetchImpl: makeFetch({ pages: { "": { items: [] } } }) });
  await api.openMediaLibrary();
  assert.equal(api.cards().length, 0);
  assert.match(api.dom.body.children[0].textContent, /まだ画像がありません/);
});

test("一覧を読み込めなければ、その旨を出す（作業は止まらない）", async () => {
  const api = build({ fetchImpl: makeFetch({ pages: { "": { fail: true } } }) });
  await api.openMediaLibrary();
  assert.match(api.dom.body.children[0].textContent, /読み込めませんでした/);
});

test("保管庫の画像の形をしていないURLは、表示しない", async () => {
  const api = build({ fetchImpl: makeFetch({ pages: { "": { items: [
    item("gallery", H.FREE_A),
    { key: keyOf("gallery", H.FREE_B), url: "javascript:alert(1)", category: "gallery", size: 1, uploaded: null },
    { key: keyOf("gallery", H.FREE_C), url: "https://evil.example/x.png", category: "gallery", size: 1, uploaded: null },
    { key: keyOf("gallery", "00000000000000dd"), category: "gallery", size: 1, uploaded: null }
  ] } } }) });
  await api.openMediaLibrary();
  assert.equal(api.cards().length, 1);
  assert.equal(api.cards()[0].children[0].src, urlOf("gallery", H.FREE_A));
});

test("日付が読めない値でも、表示を壊さない", async () => {
  const api = build({ fetchImpl: makeFetch({ pages: { "": { items: [
    item("other", H.FREE_A, { uploaded: null }),
    item("other", H.FREE_B, { uploaded: "こわれた日付" })
  ] } } }) });
  await api.openMediaLibrary();
  assert.equal(api.cards().length, 2);
});

/* ================================================================
   4. 続きの読み込み
   ================================================================ */

test("続きがあるときだけ「もっと読み込む」が出る", async () => {
  const one = build({ fetchImpl: makeFetch({ pages: { "": { items: [item("other", H.FREE_A)] } } }) });
  await one.openMediaLibrary();
  assert.equal(one.dom.more.style.display, "none");

  const many = build({ fetchImpl: makeFetch({ pages: {
    "": { items: [item("other", H.FREE_A)], cursor: "c1" },
    "c1": { items: [item("other", H.FREE_B)] } } }) });
  await many.openMediaLibrary();
  assert.equal(many.dom.more.style.display, "");
  assert.match(many.dom.count.textContent, /続きがあります/);
});

test("「もっと読み込む」で、続きが下に足される", async () => {
  const f = makeFetch({ pages: {
    "": { items: [item("other", H.FREE_A)], cursor: "c1" },
    "c1": { items: [item("other", H.FREE_B)] } } });
  const api = build({ fetchImpl: f });
  await api.openMediaLibrary();
  assert.equal(api.cards().length, 1);

  await api.dom.more.click();
  assert.equal(api.cards().length, 2, "続きが足されていません");
  assert.equal(api.dom.more.style.display, "none");
  assert.match(f.lists()[1].url, /cursor=c1/);
});

test("続きの読み込みに失敗しても、いま出ているものは消えない", async () => {
  const f = makeFetch({ pages: {
    "": { items: [item("other", H.FREE_A)], cursor: "c1" },
    "c1": { fail: true } } });
  const api = build({ fetchImpl: f });
  await api.openMediaLibrary();
  await api.dom.more.click();
  assert.equal(api.cards().length, 1);
  assert.match(api.rec.toasts.at(-1).msg, /読み込めませんでした/);
});

/* ================================================================
   5. 使用中の画像は消せない（最重要）
   ================================================================ */

test("使用中の画像の削除ボタンは押せない", async () => {
  const api = build({ fetchImpl: makeFetch({ pages: threePages() }) });
  await api.openMediaLibrary();
  for (const key of [keyOf("logo", H.LOGO), keyOf("cast", H.CAST), keyOf("gallery", H.GALLERY)]) {
    const btn = api.buttonOf(api.cardFor(key));
    assert.equal(btn.disabled, true, `押せてしまいます: ${key}`);
    assert.equal(btn.textContent, "使用中は消せません");
  }
});

test("使用中のカードには、削除の動作そのものが付いていない", async () => {
  const api = build({ fetchImpl: makeFetch({ pages: threePages() }) });
  await api.openMediaLibrary();
  const btn = api.buttonOf(api.cardFor(keyOf("logo", H.LOGO)));
  assert.deepEqual(btn.listeners.click, undefined, "使用中なのに削除の動作が付いています");
});

test("一覧を開いたあとに使い始めた画像は、消す直前に止める", async () => {
  const f = makeFetch({ pages: threePages() });
  const api = build({ fetchImpl: f });
  await api.openMediaLibrary();

  /* 一覧を開いた時点では「使っていない」画像 */
  const card = api.cardFor(keyOf("other", H.FREE_A));
  assert.equal(api.badgeOf(card).textContent, "使っていない");

  /* ここでデータ側がその画像を使い始める（別のタブで編集した、など） */
  api.data.gallery.items[2].src = urlOf("other", H.FREE_A);

  await api.buttonOf(card).click();

  assert.equal(f.deletes().length, 0, "使用中になったのに削除を送っています");
  assert.equal(api.rec.confirms.length, 0, "確認すら出してはいけません");
  assert.match(api.rec.toasts.at(-1).msg, /使われています/);
  /* 表示も「使用中」に直る */
  assert.equal(api.badgeOf(card).textContent, "使用中");
  assert.equal(api.buttonOf(card).disabled, true);
  assert.equal(card.className.includes("in-use"), true);
});

/* ================================================================
   6. 使っていない画像の削除
   ================================================================ */

test("使っていない画像を1枚だけ消せる", async () => {
  const f = makeFetch({ pages: threePages() });
  const api = build({ fetchImpl: f });
  await api.openMediaLibrary();
  await api.buttonOf(api.cardFor(keyOf("other", H.FREE_A))).click();

  assert.equal(f.deletes().length, 1);
  assert.equal(JSON.parse(f.deletes()[0].init.body).key, keyOf("other", H.FREE_A));
  assert.equal(api.cards().length, 4, "一覧から消えていません");
  assert.equal(api.cardFor(keyOf("other", H.FREE_A)), undefined);
  assert.match(api.rec.toasts.at(-1).msg, /消しました/);
});

test("削除の指示は DELETE ＋ JSON で、キー以外を送らない", async () => {
  const f = makeFetch({ pages: threePages() });
  const api = build({ fetchImpl: f });
  await api.openMediaLibrary();
  await api.buttonOf(api.cardFor(keyOf("shop", H.FREE_B))).click();

  const req = f.deletes()[0];
  assert.equal(req.url, "/api/media/item", "同一オリジンの相対パス以外を使っています");
  assert.equal(req.init.method, "DELETE");
  assert.equal(req.init.headers["content-type"], "application/json");
  assert.deepEqual(Object.keys(JSON.parse(req.init.body)), ["key"]);
});

test("確認でやめたら、何も送らない", async () => {
  const f = makeFetch({ pages: threePages() });
  const api = build({ fetchImpl: f, confirmResult: false });
  await api.openMediaLibrary();
  await api.buttonOf(api.cardFor(keyOf("other", H.FREE_A))).click();

  assert.equal(api.rec.confirms.length, 1);
  assert.equal(f.deletes().length, 0);
  assert.equal(api.cards().length, 5, "消していないのに一覧から減っています");
});

test("削除に失敗したら、カードは残り、もう一度押せる", async () => {
  const f = makeFetch({ pages: threePages(), deleteOk: false });
  const api = build({ fetchImpl: f });
  await api.openMediaLibrary();
  const card = api.cardFor(keyOf("other", H.FREE_A));
  await api.buttonOf(card).click();

  assert.equal(api.cards().length, 5, "失敗したのに一覧から消えています");
  assert.equal(api.buttonOf(card).disabled, false);
  assert.equal(api.buttonOf(card).textContent, "削除する");
  assert.match(api.rec.toasts.at(-1).msg, /消せませんでした/);
});

test("削除しても、編集中のデータには一切手を触れない", async () => {
  const f = makeFetch({ pages: threePages() });
  const api = build({ fetchImpl: f });
  const before = JSON.stringify(api.data);
  await api.openMediaLibrary();
  await api.buttonOf(api.cardFor(keyOf("other", H.FREE_A))).click();
  assert.equal(JSON.stringify(api.data), before, "データが書き換えられています");
});

test("送信中はボタンを押せなくする（二重送信の防止）", async () => {
  const f = makeFetch({ pages: threePages() });
  const api = build({ fetchImpl: f });
  await api.openMediaLibrary();
  const btn = api.buttonOf(api.cardFor(keyOf("other", H.FREE_A)));

  const running = btn.click();                 /* まだ待たない */
  assert.equal(btn.disabled, true, "送信中もボタンが押せてしまいます");
  assert.equal(btn.textContent, "消しています…");
  await btn.click();                           /* 押せない状態なので何も起きない */
  await running;
  assert.equal(f.deletes().length, 1);
});

test("枚数の内訳は、削除のあとに直る", async () => {
  const api = build({ fetchImpl: makeFetch({ pages: threePages() }) });
  await api.openMediaLibrary();
  await api.buttonOf(api.cardFor(keyOf("other", H.FREE_A))).click();
  assert.equal(api.dom.count.textContent, "4枚（使用中 3枚／使っていない 1枚）");
});

test("最後の1枚を消したら、空の案内に戻る", async () => {
  const api = build({ fetchImpl: makeFetch({ pages: {
    "": { items: [item("other", H.FREE_A)] } } }) });
  await api.openMediaLibrary();
  await api.buttonOf(api.cards()[0]).click();
  assert.equal(api.cards().length, 0);
  assert.match(api.dom.body.children[0].textContent, /まだ画像がありません/);
});

/* ================================================================
   7. 途中で閉じられたときのふるまい
   ================================================================ */

test("読み込みの途中で閉じられても、エラーにならない", async () => {
  const base = makeFetch({ pages: { "": { items: [item("other", H.FREE_A)] } } });
  let api = null;
  /* 一覧の返事が返った直後にモーダルを閉じる（利用者が ✕ を押した状況） */
  const impl = async (url, init) => {
    const res = await base(url, init);
    if (String(url).startsWith("/api/media") && api) api.dom.open = false;
    return res;
  };
  Object.assign(impl, { calls: base.calls, lists: base.lists, deletes: base.deletes });
  api = build({ fetchImpl: impl });

  await assert.doesNotReject(() => api.openMediaLibrary());
  assert.equal(api.dom.body.children.length, 0, "閉じたあとに描き足しています");
});

test("開き直したとき、前回の読み込み結果が混ざらない", async () => {
  /* 1回目の一覧の返事をわざと遅らせて、2回目のあとに返す */
  let release = null;
  const slow = new Promise(r => { release = r; });
  let call = 0;
  const base = makeFetch({ pages: {
    "": { items: [item("other", H.FREE_A), item("other", H.FREE_B)] } } });
  const impl = async (url, init) => {
    if (String(url).startsWith("/api/media") && ++call === 1) {
      const res = await base(url, init);
      await slow;                       /* 1回目だけ、返事を止めておく */
      return res;
    }
    return base(url, init);
  };
  Object.assign(impl, { calls: base.calls, lists: base.lists, deletes: base.deletes });
  const api = build({ fetchImpl: impl });

  const first = api.openMediaLibrary();  /* 1回目（返事待ちで止まる） */
  await new Promise(r => setTimeout(r, 0));
  await api.openMediaLibrary();          /* 2回目（こちらは普通に終わる） */
  assert.equal(api.cards().length, 2, "2回目の一覧が出ていません");

  release();                             /* ここで1回目の返事が返る */
  await first;

  assert.equal(api.cards().length, 2, "古い読み込み結果が混ざっています");
  assert.equal(api.dom.count.textContent, "2枚（使用中 0枚／使っていない 2枚）");
});

test("削除の途中で開き直しても、消えた画像は新しい一覧からも外れる", async () => {
  /* 削除の返事が返る前に開き直すと、保管庫にはまだその画像が残っているので
     新しい一覧にも同じ画像が並ぶ。返事が返った時点で、それも外れること。 */
  let release = null;
  const slow = new Promise(r => { release = r; });
  const base = makeFetch({ pages: {
    "": { items: [item("other", H.FREE_A), item("other", H.FREE_B)] } } });
  const impl = async (url, init) => {
    if (String(url).startsWith("/api/media/item")) {
      const res = await base(url, init);
      await slow;                       /* 削除の返事を止めておく */
      return res;
    }
    return base(url, init);
  };
  Object.assign(impl, { calls: base.calls, lists: base.lists, deletes: base.deletes });
  const api = build({ fetchImpl: impl });

  await api.openMediaLibrary();
  const removing = api.buttonOf(api.cardFor(keyOf("other", H.FREE_A))).click();
  await new Promise(r => setTimeout(r, 0));

  /* 返事を待たずに開き直す。保管庫はまだ消えていないので2枚出る。 */
  await api.openMediaLibrary();
  assert.equal(api.cards().length, 2);
  assert.equal(api.dom.count.textContent, "2枚（使用中 0枚／使っていない 2枚）");

  release();
  await removing;

  assert.equal(api.cardFor(keyOf("other", H.FREE_A)), undefined,
    "消えた画像が新しい一覧に残っています");
  assert.equal(api.cards().length, 1);
  assert.equal(api.dom.count.textContent, "1枚（使用中 0枚／使っていない 1枚）",
    "新しい一覧の枚数が直っていません");
});

test("開き直したあと、消えた画像が一覧に無ければ枚数を触らない", async () => {
  /* 削除の返事が返る前に開き直し、そのとき既に一覧から消えている場合。
     二重に枚数を減らしてはいけない。 */
  let release = null;
  const slow = new Promise(r => { release = r; });
  let listCall = 0;
  const base = makeFetch({ pages: {
    "": { items: [item("other", H.FREE_A), item("other", H.FREE_B)] },
    "gone": { items: [item("other", H.FREE_B)] } } });
  const impl = async (url, init) => {
    if (String(url).startsWith("/api/media/item")) {
      const res = await base(url, init);
      await slow;
      return res;
    }
    /* 2回目の一覧では、もう消えた画像は返さない */
    if (String(url).startsWith("/api/media") && ++listCall === 2) {
      return base("/api/media?cursor=gone", init);
    }
    return base(url, init);
  };
  Object.assign(impl, { calls: base.calls, lists: base.lists, deletes: base.deletes });
  const api = build({ fetchImpl: impl });

  await api.openMediaLibrary();
  const removing = api.buttonOf(api.cardFor(keyOf("other", H.FREE_A))).click();
  await new Promise(r => setTimeout(r, 0));

  await api.openMediaLibrary();
  assert.equal(api.cards().length, 1);

  release();
  await removing;

  assert.equal(api.cards().length, 1);
  assert.equal(api.dom.count.textContent, "1枚（使用中 0枚／使っていない 1枚）",
    "一覧に無いのに枚数を減らしています");
});

/* ================================================================
   8. 画面の作りが崩れていないか（HTMLそのものの確認）
   ================================================================ */

test("メニューに「保管庫の画像を整理する」がある", () => {
  assert.match(HTML, /data-act="mediaLibrary"[^>]*>🗂 保管庫の画像を整理する</);
  assert.match(HTML, /act==="mediaLibrary"\) openMediaLibrary\(\)/);
});

test("Phase 3 の一括移行（toR2Mode）には手を入れていない", () => {
  /* 保管庫へ移す処理と、そこから呼ばれる関数がそのまま残っていること */
  for (const marker of [
    "async function toR2Mode(){",
    "function collectEmbedded(root){",
    "function backupName(now){",
    "async function mediaAlive(){",
    "function toUrlMode(){",
    "async function storeImage(dataUrl, path){"
  ]) {
    assert.ok(HTML.includes(marker), `失われています: ${marker}`);
  }
});

test("削除するのは保管庫だけで、DATA を書き換える呼び出しを含まない", () => {
  /* 一覧・削除の部分に、保存や履歴の操作が混ざっていないこと */
  for (const forbidden of ["History.push()", "History.commit()", "persist()", "renderPane()", "DATA="]) {
    assert.equal(SRC_LIB.includes(forbidden), false, `含まれてはいけません: ${forbidden}`);
  }
});
