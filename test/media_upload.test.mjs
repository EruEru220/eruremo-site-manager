/* ================================================================
   Phase 2-2 の回帰テスト
   （画像を保管庫へ送る処理と、失敗しても作業が止まらないこと）

   実行方法:  node --test "test/*.test.mjs"
   外部パッケージは使いません（Node.js 標準の node:test のみ）。
   ネットワークにも出ません（fetch は偽物に差し替えます）。

   考え方:
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

const SRC_MEDIA = slice("/* 画像の置き場所。Worker 側の固定リスト",
                        "/* ================================================================\n   画像の圧縮", "保管庫の処理");
const SRC_BYTES = slice("function dataUrlToBytes(u){", "\nfunction toUrlMode(){", "dataUrlToBytes");

/* ---- 切り出したコードを動かすための入れ物 -------------------- */
/*  location・fetch・DOM を差し替えて、いろいろな状況を再現します */

/* トップバーの表示（#mediaMode）のニセモノ。classList と textContent だけ持つ。 */
function fakeChip(){
  const set = new Set(["media-off"]);
  return {
    title: "", textContent: "画像：埋め込み",
    classList: {
      add: (...c) => c.forEach(x => set.add(x)),
      remove: (...c) => c.forEach(x => set.delete(x)),
      contains: c => set.has(c)
    }
  };
}

function build({ protocol = "http:", fetchImpl = async () => { throw new Error("呼ばれないはず"); } } = {}){
  const toasts = [];
  const chip = fakeChip();
  const text = { textContent: "画像：埋め込み" };
  const $ = sel => sel === "#mediaMode" ? chip : (sel === "#mediaModeText" ? text : null);

  const fn = new Function("location", "fetch", "toast", "$", `
    ${SRC_BYTES}
    ${SRC_MEDIA}
    return { mediaCategory, dataUrlToBlob, MediaAPI, storeImage, MEDIA_CATEGORIES,
             isMediaUrl, setMediaMode };
  `);
  const api = fn({ protocol }, fetchImpl, (msg, kind) => toasts.push({ msg, kind }), $);
  api.toasts = toasts;
  api.chip = chip;
  api.modeText = () => text.textContent;
  /* いまの表示が3つのどれか */
  api.mode = () => chip.classList.contains("media-warn") ? "warn"
                 : chip.classList.contains("media-off") ? "local" : "r2";
  return api;
}

/* 応答のニセモノ（本物の fetch と同じ形だけを持つ） */
const reply = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});
const HEALTH_OK = reply({ ok: true, service: "eruremo-media-api", environment: "local" });
const UPLOAD_OK = (url = "http://127.0.0.1:8787/media/gallery/2026/08/0123456789abcdef.webp") =>
  reply({ ok: true, key: url.split("/").slice(3).join("/"), url, size: 100, contentType: "image/webp" }, 201);

/* 記録つきの偽 fetch。/api/health と /api/media/upload に答える。 */
function recorder({ health = HEALTH_OK, upload = UPLOAD_OK() } = {}){
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (String(url).includes("/api/health")) {
      if (typeof health === "function") return health();
      return health;
    }
    if (typeof upload === "function") return upload(init);
    return upload;
  };
  impl.calls = calls;
  return impl;
}

/* テスト用の data URL（1×1 の PNG） */
const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const JPEG_DATA_URL = "data:image/jpeg;base64," + Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]).toString("base64");

/* ================================================================
   1. 置き場所（category）の割り当て
   ================================================================ */

test("画像フィールドの置き場所が、すべて正しく決まる", () => {
  const { mediaCategory } = build();
  const expected = {
    "logo":                      "logo",
    "seo.favicon":               "favicon",
    "about.photo":               "about",
    "cast.members.0.photo":      "cast",
    "cast.members.3.profilePhoto":"cast",
    "staff.members.0.photo":     "staff",
    "history.items.0.photo":     "history",
    "shop.photo":                "shop",
    "present.items.2.photo":     "present",
    "gallery.items.10.src":      "gallery",
    "gallery.items":             "gallery"
  };
  for (const [path, cat] of Object.entries(expected)) {
    assert.equal(mediaCategory(path), cat, `置き場所が違います: ${path}`);
  }
});

test("知らない場所は other になる（勝手な置き場所を作らない）", () => {
  const { mediaCategory, MEDIA_CATEGORIES } = build();
  const odd = ["", null, undefined, "unknown", "seo.ogImage", "logo.extra", "board.fb.apiKey",
               "../../etc/passwd", "media/logo", "..", "faq.items.0.q", 123, {}, []];
  for (const p of odd) {
    const c = mediaCategory(p);
    assert.equal(c, "other", `other になっていません: ${JSON.stringify(p)} → ${c}`);
  }
  /* どんな入力でも、必ず固定リストの中の値しか返さない */
  for (const p of [...odd, "logo", "cast.members.0.photo"]) {
    assert.ok(MEDIA_CATEGORIES.includes(mediaCategory(p)),
      `固定リストにない値を返しました: ${mediaCategory(p)}`);
  }
});

/* ================================================================
   2. data URL → 送信できる形（Blob）
   ================================================================ */

test("data URL を、申告どおりの種類の Blob に変えられる", async () => {
  const { dataUrlToBlob } = build();
  const png = dataUrlToBlob(PNG_DATA_URL);
  assert.equal(png.type, "image/png");
  const head = new Uint8Array(await png.arrayBuffer()).slice(0, 8);
  assert.deepEqual([...head], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], "PNG の中身が壊れています");

  const jpeg = dataUrlToBlob(JPEG_DATA_URL);
  assert.equal(jpeg.type, "image/jpeg");
  assert.deepEqual([...new Uint8Array(await jpeg.arrayBuffer()).slice(0, 3)], [0xFF, 0xD8, 0xFF]);
});

/* ================================================================
   3. file:// で開いたときは、今までどおり Base64
   ================================================================ */

test("file:// では保管庫に問い合わせず、Base64 のまま返す", async () => {
  const fetchImpl = recorder();
  const { storeImage, MediaAPI } = build({ protocol: "file:", fetchImpl });
  assert.equal(MediaAPI.available(), false);
  assert.equal(await storeImage(PNG_DATA_URL, "logo"), PNG_DATA_URL);
  assert.equal(fetchImpl.calls.length, 0, "file:// なのに通信しています");
});

test("http / https のときだけ保管庫を使う", () => {
  assert.equal(build({ protocol: "http:" }).MediaAPI.available(), true);
  assert.equal(build({ protocol: "https:" }).MediaAPI.available(), true);
  assert.equal(build({ protocol: "file:" }).MediaAPI.available(), false);
  assert.equal(build({ protocol: "blob:" }).MediaAPI.available(), false);
});

/* ================================================================
   4. 成功したとき
   ================================================================ */

test("保管庫が使えるとき、データに入るのは URL になる", async () => {
  const url = "http://127.0.0.1:8787/media/cast/2026/08/abcdef0123456789.webp";
  const fetchImpl = recorder({ upload: UPLOAD_OK(url) });
  const { storeImage } = build({ fetchImpl });
  assert.equal(await storeImage(PNG_DATA_URL, "cast.members.0.photo"), url);
});

test("送信先は同一オリジンの相対パス（別の住所へ送らない）", async () => {
  const fetchImpl = recorder();
  const { storeImage } = build({ fetchImpl });
  await storeImage(PNG_DATA_URL, "logo");
  for (const c of fetchImpl.calls) {
    assert.ok(String(c.url).startsWith("/api/"),
      `外部の住所へ送っています: ${c.url}`);
  }
});

test("送る中身は file と category だけ。ファイル名は固定", async () => {
  const fetchImpl = recorder();
  const { storeImage } = build({ fetchImpl });
  await storeImage(PNG_DATA_URL, "history.items.4.photo");
  const upload = fetchImpl.calls.find(c => String(c.url).includes("upload"));
  assert.equal(upload.init.method, "POST");
  const fd = upload.init.body;
  assert.deepEqual([...fd.keys()].sort(), ["category", "file"]);
  assert.equal(fd.get("category"), "history");
  assert.equal(fd.get("file").name, "image", "パソコンのファイル名を送っています");
  assert.equal(fd.get("file").type, "image/png");
});

test("固定リストにない置き場所は送らない（other に落とす）", async () => {
  const fetchImpl = recorder();
  const { MediaAPI } = build({ fetchImpl });
  await MediaAPI.upload(PNG_DATA_URL, "../../etc");
  const upload = fetchImpl.calls.find(c => String(c.url).includes("upload"));
  assert.equal(upload.init.body.get("category"), "other");
});

test("保管庫の確認は、何枚送っても1回だけ", async () => {
  const fetchImpl = recorder();
  const { storeImage } = build({ fetchImpl });
  for (let i = 0; i < 5; i++) await storeImage(PNG_DATA_URL, "gallery.items");
  const health = fetchImpl.calls.filter(c => String(c.url).includes("/api/health"));
  assert.equal(health.length, 1, `健康確認が ${health.length} 回走っています`);
  assert.equal(fetchImpl.calls.length - health.length, 5);
});

/* ================================================================
   5. 失敗したとき ― 必ず Base64 のまま続行する
   ================================================================ */

test("保管庫が応答しないとき、Base64 のまま続行する", async () => {
  const { storeImage } = build({ fetchImpl: async () => { throw new Error("つながりません"); } });
  assert.equal(await storeImage(PNG_DATA_URL, "logo"), PNG_DATA_URL);
});

test("health が失敗したら、アップロードを試みない", async () => {
  const fetchImpl = recorder({ health: reply({ ok: false }, 500) });
  const { storeImage } = build({ fetchImpl });
  assert.equal(await storeImage(PNG_DATA_URL, "logo"), PNG_DATA_URL);
  assert.equal(fetchImpl.calls.filter(c => String(c.url).includes("upload")).length, 0);
});

test("health が別のサービスを名乗ったら使わない", async () => {
  const fetchImpl = recorder({ health: reply({ ok: true, service: "something-else" }) });
  const { storeImage } = build({ fetchImpl });
  assert.equal(await storeImage(PNG_DATA_URL, "logo"), PNG_DATA_URL);
  assert.equal(fetchImpl.calls.filter(c => String(c.url).includes("upload")).length, 0);
});

test("アップロードが拒否・失敗しても Base64 のまま続行する", async () => {
  const cases = [
    ["拒否（400）",        reply({ ok: false, error: { code: "INVALID_FILE_TYPE", message: "…" } }, 400)],
    ["大きすぎ（413）",    reply({ ok: false, error: { code: "TOO_LARGE", message: "…" } }, 413)],
    ["保存失敗（500）",    reply({ ok: false, error: { code: "R2_ERROR", message: "…" } }, 500)],
    ["JSON が壊れている",  { ok: true, status: 201, json: async () => { throw new Error("壊れた"); } }],
    ["url が無い",         reply({ ok: true, key: "media/…" }, 201)],
    ["url が空",           reply({ ok: true, url: "" }, 201)],
    ["url が文字列でない", reply({ ok: true, url: { evil: 1 } }, 201)],
    ["ok が false のまま 200", reply({ ok: false, url: "http://x/y" }, 200)]
  ];
  for (const [label, res] of cases) {
    const { storeImage } = build({ fetchImpl: recorder({ upload: res }) });
    assert.equal(await storeImage(PNG_DATA_URL, "gallery.items"), PNG_DATA_URL,
      `${label}: Base64 に戻っていません`);
  }
});

test("失敗の警告は、成功するまで1回だけ出る", async () => {
  let mode = "fail";
  const fetchImpl = async (url) => {
    if (String(url).includes("/api/health")) return HEALTH_OK;
    if (mode === "fail") return reply({ ok: false, error: { code: "R2_ERROR" } }, 500);
    return UPLOAD_OK();
  };
  const api = build({ fetchImpl });
  await api.storeImage(PNG_DATA_URL, "logo");
  await api.storeImage(PNG_DATA_URL, "logo");
  await api.storeImage(PNG_DATA_URL, "logo");
  const warns = () => api.toasts.filter(t => t.kind === "warn");
  assert.equal(warns().length, 1, "同じ警告を何度も出しています");

  /* 成功をはさむと、次の失敗ではまた知らせる */
  mode = "ok";
  await api.storeImage(PNG_DATA_URL, "logo");
  mode = "fail";
  await api.storeImage(PNG_DATA_URL, "logo");
  assert.equal(warns().length, 2);
});

test("警告の文面に、内部の情報やエラーの中身が混ざらない", async () => {
  const fetchImpl = recorder({
    upload: reply({ ok: false, error: { code: "R2_ERROR", message: "bucket=secret-bucket-name" } }, 500)
  });
  const api = build({ fetchImpl });
  await api.storeImage(PNG_DATA_URL, "logo");
  const text = api.toasts.map(t => t.msg).join("\n");
  for (const leak of ["secret-bucket-name", "R2_ERROR", "Error", "bucket", "http", "127.0.0.1"]) {
    assert.equal(text.includes(leak), false, `警告に内部情報が混ざっています: ${leak}`);
  }
});

/* ================================================================
   5-2. 画面上の「いまの保存先」表示（トーストは消えるので、これが本命）
   ================================================================ */

test("保管庫が使えるときは「保管庫に保存」と表示する", async () => {
  const api = build({ fetchImpl: recorder() });
  await api.storeImage(PNG_DATA_URL, "logo");
  assert.equal(api.mode(), "r2");
  assert.match(api.modeText(), /保管庫/);
});

test("file:// のときは「埋め込み」と表示し、警告は出さない", async () => {
  const api = build({ protocol: "file:", fetchImpl: recorder() });
  await api.MediaAPI.probe();
  assert.equal(api.mode(), "local");
  assert.equal(api.toasts.length, 0, "file:// で通知を出しています");
});

test("保管庫につながらないときは、黙って切り替えずに知らせる", async () => {
  /* ここが手動確認で見つかった穴。以前は何も知らせずに埋め込みへ戻っていた。 */
  const api = build({ fetchImpl: async () => { throw new Error("つながりません"); } });
  assert.equal(await api.storeImage(PNG_DATA_URL, "logo"), PNG_DATA_URL);
  assert.equal(api.mode(), "warn");
  assert.match(api.modeText(), /埋め込み/);
  assert.equal(api.toasts.filter(t => t.kind === "warn").length, 1, "警告が出ていません");
});

test("アップロードに失敗したら表示も「埋め込み」に戻る", async () => {
  let mode = "ok";
  const api = build({ fetchImpl: async (url) => {
    if (String(url).includes("/api/health")) return HEALTH_OK;
    if (mode === "ok") return UPLOAD_OK();
    return reply({ ok: false, error: { code: "R2_ERROR" } }, 500);
  }});
  await api.storeImage(PNG_DATA_URL, "logo");
  assert.equal(api.mode(), "r2");
  mode = "fail";
  await api.storeImage(PNG_DATA_URL, "logo");
  assert.equal(api.mode(), "warn");
  mode = "ok";
  await api.storeImage(PNG_DATA_URL, "logo");
  assert.equal(api.mode(), "r2", "復旧したのに表示が戻っていません");
});

test("保管庫の画像URLだけを「保管庫のもの」と見分ける", () => {
  const { isMediaUrl } = build();
  const yes = [
    "http://127.0.0.1:8787/media/gallery/2026/08/0123456789abcdef.webp",
    "https://images.eruremo.com/media/cast/2026/12/abcdef0123456789.jpg",
    "/media/logo/2026/08/0123456789abcdef.png"
  ];
  const no = [
    "photos/01.jpg",
    "https://example.com/a.png",
    "data:image/png;base64,AAAA",
    "http://127.0.0.1:8787/media/unknown/2026/08/0123456789abcdef.webp",
    "http://127.0.0.1:8787/media/gallery/2026/08/0123456789abcdef.gif",
    "http://127.0.0.1:8787/media/gallery/2026/08/short.webp",
    "", null, undefined, 123
  ];
  for (const v of yes) assert.equal(isMediaUrl(v), true, `見分けられません: ${v}`);
  for (const v of no) assert.equal(isMediaUrl(v), false, `誤って保管庫と判定: ${v}`);
});

/* ================================================================
   6. 画像以外の値には手を出さない
   ================================================================ */

test("URL や相対パスは、そのまま返す（手入力欄を壊さない）", async () => {
  const fetchImpl = recorder();
  const { storeImage } = build({ fetchImpl });
  for (const v of ["", "photos/01.jpg", "https://example.com/a.png", "/media/x.webp", null, undefined, 42]) {
    assert.equal(await storeImage(v, "gallery.items"), v, `値が変わってしまいました: ${v}`);
  }
  assert.equal(fetchImpl.calls.length, 0, "画像以外の値で通信しています");
});

/* ================================================================
   7. 本体のコードが、想定どおり呼んでいるか（静的な確認）
   ================================================================ */

test("handleFile() が保管庫を経由し、失敗しても onChange を1回だけ呼ぶ", () => {
  const src = slice("async function handleFile(f){", "\n    inp.addEventListener", "handleFile");
  assert.match(src, /storeImage\(url, wrap\.dataset\.key\)/, "handleFile が storeImage を呼んでいません");
  assert.equal((src.match(/onChange\(/g) || []).length, 1, "onChange の呼び出し回数が変わっています");
  assert.equal((src.match(/shrinkImage\(/g) || []).length, 1, "shrinkImage の呼び出しが変わっています");
  assert.match(src, /def\.big\?1500:1150/, "圧縮の大きさ指定が変わっています");
});

test("ギャラリーの「まとめて追加」も保管庫を経由する", () => {
  const src = slice("      const files=[...e.target.files];", "\n      });", "まとめて追加");
  assert.match(src, /storeImage\(url, cfg\.k\)/, "まとめて追加が storeImage を呼んでいません");
});

test("起動時に保管庫の確認が呼ばれる", () => {
  assert.match(HTML, /\nMediaAPI\.probe\(\);/, "起動時の probe() がありません");
});

test("サムネイルに保存先が出る（トーストが消えても分かるように）", () => {
  const src = slice("    function paint(v){", "\n    paint(value);", "paint");
  assert.match(src, /isMediaUrl\(v\)/, "サムネイルに保管庫の表示がありません");
  assert.match(src, /startsWith\("data:"\)/, "埋め込み時の容量表示が消えています");
});

test("トップバーに保存先の表示がある", () => {
  assert.match(HTML, /id="mediaMode"/, "保存先の表示が HTML にありません");
  assert.match(HTML, /id="mediaModeText"/, "保存先の文字が HTML にありません");
  assert.match(HTML, /\.status\.media-warn \.dot/, "警告時の色指定がありません");
});

test("CORS をゆるめる書き方や、外部の住所が紛れ込んでいない", () => {
  const ngList = ["no-cors", "credentials", "Access-Control-Allow-Origin", "crossOrigin"];
  for (const ng of ngList) {
    assert.equal(SRC_MEDIA.includes(ng), false, `保管庫の処理に ${ng} が入っています`);
  }
  /* 外部の住所を書かない。案内文に出るローカルの住所だけは除いて確かめる。 */
  const withoutLocal = SRC_MEDIA.split("http://127.0.0.1:8787").join("");
  for (const ng of ["http://", "https://"]) {
    assert.equal(withoutLocal.includes(ng), false, `保管庫の処理に外部の住所 ${ng} が入っています`);
  }
  /* 送信先は相対パスだけ（fetch の引数が "/" で始まる） */
  const targets = [...SRC_MEDIA.matchAll(/fetch\(\s*("[^"]*")/g)].map(m => m[1]);
  assert.ok(targets.length >= 2, "fetch の呼び出しが見つかりません");
  for (const t of targets) {
    assert.match(t, /^"\/api\//, `送信先が同一オリジンの相対パスではありません: ${t}`);
  }
});

test("互換性の目印が壊れていないこと", () => {
  assert.ok(HTML.includes("elremo_editor_data_v9"), "保存キーが変わっています");
  assert.ok(HTML.includes("elremo_editor_data_v1"), "旧キーの読み込みが消えています");
  assert.ok(HTML.includes("SITE_DATA_END"), "保存HTMLの読み込みの目印が変わっています");
  assert.ok(HTML.includes("function toUrlMode(){"), "toUrlMode() が消えています");
  assert.ok(HTML.includes('elm("input","urlin")'), "URL手入力欄が消えています");
});

test("生成用ひな形（TEMPLATE）に手が入っていないこと", () => {
  /* TEMPLATE は Base64 で埋め込まれている。中身を取り出して確認する。 */
  const m = /const TEMPLATE = decodeB64\("([A-Za-z0-9+/=]+)"\)/.exec(HTML);
  assert.ok(m, "TEMPLATE の埋め込みが見つかりません");
  const TEMPLATE = Buffer.from(m[1], "base64").toString("utf8");

  /* 生成HTMLの目印（過去に保存した index.html を読み込むために必要） */
  assert.ok(TEMPLATE.includes("const SITE_DATA = __SITE_DATA__;"), "生成HTMLの目印が変わっています");
  assert.ok(TEMPLATE.includes("/* ==== SITE_DATA_END"), "生成HTMLの終了目印が変わっています");

  /* 8つのプレースホルダ */
  for (const ph of ["__PAGE_TITLE__", "__PAGE_DESC__", "__THEME_COLOR__", "__OG_EXTRA__",
                    "__TWITTER_EXTRA__", "__FAVICON__", "__JSONLD__", "__SITE_DATA__"]) {
    assert.ok(TEMPLATE.includes(ph), `プレースホルダが消えています: ${ph}`);
  }

  /* 生成サイトの localStorage キーと、画像の入れ方（URL でも Base64 でも動く形） */
  assert.ok(TEMPLATE.includes("elremo_board_v1"), "掲示板の保存キーが変わっています");
  assert.ok(TEMPLATE.includes("elremo_motion"), "演出の保存キーが変わっています");
  assert.ok(/n\.src\s*=\s*v/.test(TEMPLATE), "画像の入れ方（n.src = v）が変わっています");
});
