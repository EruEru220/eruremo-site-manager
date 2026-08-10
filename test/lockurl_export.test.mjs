/* ================================================================
   C-1 修正の回帰テスト
   （あいことばの暗号化に失敗したとき、配布URLが平文で出ないこと）

   実行方法:  node --test test/
   外部パッケージは使いません（Node.js 標準の node:test のみ）。

   考え方:
     eruremo_SiteManager.html は DOM がないと動かないので、
     ファイルから「lockUrl()」「abortExport()」「fixUrl()」
     「buildHtml() の中のプレゼント暗号化ループ」の
     ソースコードそのものを切り出して実行し、動きを確かめます。
     テスト用に書き直したコピーではなく、本物のコードを動かします。
   ================================================================ */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

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

/* v2 化にともない、切り出す範囲を「暗号化ブロックまるごと」に広げました。
   定数・ヘッダ組み立て・PBKDF2・fresh 暗号化・覚え書き が全部入ります。 */
const SRC_LOCKURL = slice("/* ---- プレゼントURLの暗号化（v2） ----",
                          "\n/* 書き出しを安全に中止", "lockUrl");
const SRC_ABORT   = slice("/* 書き出しを安全に中止するためのエラー", "\nconst escAttr", "abortExport");
const SRC_FIXURL  = slice("const fixUrl = u=>{", "\nconst repl = ", "fixUrl");
const SRC_GIFTLOOP= slice("  /* あいことばの暗号化", "\n  /* エディタ専用の情報は落とす */", "プレゼント暗号化ループ");

/* 切り出したループが本当に buildHtml() の中のものか確認 */
const IDX_BUILDHTML = HTML.indexOf("async function buildHtml(){");
assert.ok(IDX_BUILDHTML >= 0 && HTML.indexOf(SRC_GIFTLOOP) > IDX_BUILDHTML,
  "プレゼント暗号化ループが buildHtml() の中にありません");

/* ---- 切り出したコードを動かすための入れ物 -------------------- */
/*  cryptoImpl を差し替えることで「暗号化できない環境」を再現します */
function runGiftLoop(data, cryptoImpl){
  const fn = new Function("data", "crypto", `
    ${SRC_LOCKURL}
    ${SRC_ABORT}
    ${SRC_FIXURL}
    return (async () => {
${SRC_GIFTLOOP}
      return data;
    })();
  `);
  return fn(data, cryptoImpl);
}

const realCrypto = globalThis.crypto;

/* 暗号化まわりだけを取り出して動かす（メモ化の中身も見られるようにする） */
function buildLockApi(cryptoImpl = realCrypto){
  const fn = new Function("crypto", `
    ${SRC_LOCKURL}
    return { lockUrl, lockUrlFresh, lockCache, lockHeader, lockAad,
             LOCK_ITER, LOCK_V2_PREFIX, LOCK_KDF_PBKDF2, LOCK_HEADER_LEN, LOCK_AAD_LABEL };
  `);
  return fn(cryptoImpl);
}

/* ---- ここから下は「生成サイト側の復号」を、テストのために別実装したもの ----
   本番の復号は TEMPLATE の中にあります。**わざと別々に書いています。**
   同じコードを使い回すと「自分で暗号化して自分で復号できた」だけになり、
   バイトの並びが仕様どおりかを確かめられないためです。 */

const V2_PREFIX = "v2.";
const V2_HEADER_LEN = 33;
const V2_AAD_LABEL = "eruremo-lock-v2";
const V2_ITER_MIN = 100000, V2_ITER_MAX = 2000000;

/* lock 文字列を、決めておいたバイトの並びどおりに分解する */
function parseV2(lock){
  if (typeof lock !== "string" || !lock.startsWith(V2_PREFIX)) throw new Error("v2 ではありません");
  const b64 = lock.slice(V2_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4) throw new Error("Base64 が壊れています");
  const raw = Buffer.from(b64, "base64");
  if (raw.length < V2_HEADER_LEN + 1 + 16) throw new Error("短すぎます");
  return {
    raw,
    kdfId : raw[0],
    iter  : raw.readUInt32BE(1),
    salt  : raw.subarray(5, 21),
    iv    : raw.subarray(21, 33),
    header: raw.subarray(0, V2_HEADER_LEN),
    ct    : raw.subarray(V2_HEADER_LEN)
  };
}

/* 分解したものを、もう一度 lock 文字列に戻す（改ざんテスト用） */
function packV2(raw){
  return V2_PREFIX + Buffer.from(raw).toString("base64");
}

/* v2 の復号（テスト用の実装） */
async function unlockV2(lock, pw){
  const p = parseV2(lock);
  if (p.kdfId !== 1) throw new Error("知らない鍵の作り方です");
  if (p.iter < V2_ITER_MIN || p.iter > V2_ITER_MAX) throw new Error("くり返す回数が範囲外です");
  const te = new TextEncoder();
  const aad = Buffer.concat([Buffer.from(te.encode(V2_AAD_LABEL)), Buffer.from(p.header)]);
  const base = await realCrypto.subtle.importKey("raw", te.encode(pw), "PBKDF2", false, ["deriveKey"]);
  const key = await realCrypto.subtle.deriveKey(
    { name:"PBKDF2", salt:p.salt, iterations:p.iter, hash:"SHA-256" },
    base, { name:"AES-GCM", length:256 }, false, ["decrypt"]);
  const out = await realCrypto.subtle.decrypt(
    { name:"AES-GCM", iv:p.iv, additionalData:aad }, key, p.ct);
  return new TextDecoder().decode(out);
}

/* 旧方式（v1）の復号。**消してはいけません。**
   昔配った配布物を開けるかどうかは、これで確かめます。 */
async function unlockLegacy(lockB64, pw){
  const te = new TextEncoder();
  const raw = Buffer.from(lockB64, "base64");
  const iv  = raw.subarray(0, 12);
  const ct  = raw.subarray(12);
  const keyRaw = await realCrypto.subtle.digest("SHA-256", te.encode(pw));
  const key = await realCrypto.subtle.importKey("raw", keyRaw, { name:"AES-GCM" }, false, ["decrypt"]);
  const out = await realCrypto.subtle.decrypt({ name:"AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(out);
}

/* 書き出しループの結果を確かめるときに使う（いまは v2 で復号する） */
const unlock = unlockV2;

/* 暗号化に失敗する crypto（HTTP配信などで crypto.subtle が使えない状況の再現） */
const brokenSubtleCrypto = {
  getRandomValues: (a) => realCrypto.getRandomValues(a),
  subtle: {
    digest: () => { throw new Error("secure context ではありません"); },
    importKey: () => { throw new Error("secure context ではありません"); },
    encrypt: () => { throw new Error("secure context ではありません"); }
  }
};
/* crypto.subtle 自体が存在しない状況の再現 */
const noSubtleCrypto = { getRandomValues: (a) => realCrypto.getRandomValues(a) };

const PLAIN_URL = "https://drive.example.com/very-secret-file";

/* ================================================================
   1. 成功時：これまでどおり動くこと
   ================================================================ */
test("成功時：lock が作られ、平文URLと合言葉が消える", async () => {
  const data = { present: { items: [
    { name:"モデルA", url: PLAIN_URL, password:"あいことば123" }
  ] } };

  const out = await runGiftLoop(data, realCrypto);
  const it = out.present.items[0];

  assert.ok(typeof it.lock === "string" && it.lock.length > 0, "lock が作られていません");
  assert.equal(it.url, "", "平文URLが残っています");
  assert.equal("password" in it, false, "password が残っています");

  const json = JSON.stringify(out);
  assert.equal(json.includes(PLAIN_URL), false, "書き出しデータに平文URLが含まれています");
  assert.equal(json.includes("あいことば123"), false, "書き出しデータに合言葉が含まれています");
});

test("成功時：lock は合言葉で復号できる（v2）", async () => {
  const data = { present: { items: [
    { name:"モデルA", url: PLAIN_URL, password:"あいことば123" }
  ] } };
  const out = await runGiftLoop(data, realCrypto);
  const lock = out.present.items[0].lock;
  assert.ok(lock.startsWith("v2."), "新しく作った lock が v2 ではありません");
  assert.equal(await unlockV2(lock, "あいことば123"), PLAIN_URL);
});

test("成功時：合言葉なしの配布物はURLがそのまま残る（既存挙動）", async () => {
  const data = { present: { items: [
    { name:"だれでもOK", url:"https://booth.example.com/items/1" }
  ] } };
  const out = await runGiftLoop(data, realCrypto);
  assert.equal(out.present.items[0].url, "https://booth.example.com/items/1");
  assert.equal("lock" in out.present.items[0], false);
});

test("成功時：複数の配布物がそれぞれ暗号化される", async () => {
  const data = { present: { items: [
    { name:"A", url:"https://a.example.com/x", password:"pw-a" },
    { name:"B", url:"https://b.example.com/y", password:"pw-b" },
    { name:"C", url:"https://c.example.com/z" }
  ] } };
  const out = await runGiftLoop(data, realCrypto);
  assert.equal(await unlock(out.present.items[0].lock, "pw-a"), "https://a.example.com/x");
  assert.equal(await unlock(out.present.items[1].lock, "pw-b"), "https://b.example.com/y");
  assert.equal(out.present.items[2].url, "https://c.example.com/z");
  const json = JSON.stringify(out);
  for (const s of ["pw-a","pw-b","https://a.example.com/x","https://b.example.com/y"]){
    assert.equal(json.includes(s), false, `書き出しデータに ${s} が残っています`);
  }
});

test("成功時：プレゼントが1件もなくてもエラーにならない", async () => {
  await runGiftLoop({ present: { items: [] } }, realCrypto);
  await runGiftLoop({}, realCrypto);
});

/* ================================================================
   2. 失敗時：平文URLが出ないこと（C-1 の本体）
   ================================================================ */
for (const [label, brokenCrypto] of [
  ["crypto.subtle が例外を投げる", brokenSubtleCrypto],
  ["crypto.subtle が存在しない",   noSubtleCrypto]
]){
  test(`失敗時（${label}）：例外を投げて書き出しを中止する`, async () => {
    const data = { present: { items: [
      { name:"モデルA", url: PLAIN_URL, password:"あいことば123" }
    ] } };

    await assert.rejects(
      () => runGiftLoop(data, brokenCrypto),
      (err) => {
        /* 利用者に見せる日本語メッセージがあること */
        assert.ok(typeof err.userMessage === "string" && err.userMessage.length > 0,
          "利用者向けメッセージ（userMessage）がありません");
        assert.ok(err.userMessage.includes("中止"), "中止したことが伝わる文面ではありません");
        assert.ok(err.userMessage.includes("モデルA"), "どの配布物か分かる文面ではありません");
        /* 内部情報・秘密情報が混ざっていないこと */
        assert.equal(err.userMessage.includes(PLAIN_URL), false, "メッセージにURLが含まれています");
        assert.equal(err.userMessage.includes("あいことば123"), false, "メッセージに合言葉が含まれています");
        return true;
      }
    );

    /* 例外を投げた時点のデータにも平文が残っていないこと（多重の安全策） */
    const it = data.present.items[0];
    assert.equal(it.url, "", "失敗後も平文URLが残っています");
    assert.equal("password" in it, false, "失敗後も password が残っています");
    assert.equal(JSON.stringify(data).includes(PLAIN_URL), false, "データに平文URLが含まれています");
  });
}

test("失敗時：2件目で失敗しても全体を中止する（1件目だけ出力されない）", async () => {
  /* 1件目は成功、2件目で暗号化が壊れる状況 */
  let calls = 0;
  const flakyCrypto = {
    getRandomValues: (a) => realCrypto.getRandomValues(a),
    subtle: {
      digest: (...a) => realCrypto.subtle.digest(...a),
      importKey: (...a) => realCrypto.subtle.importKey(...a),
      /* v2 は PBKDF2 を使うので、鍵づくりも通す必要があります */
      deriveKey: (...a) => realCrypto.subtle.deriveKey(...a),
      encrypt: (...a) => {
        calls++;
        if (calls >= 2) throw new Error("2件目で失敗");
        return realCrypto.subtle.encrypt(...a);
      }
    }
  };
  const data = { present: { items: [
    { name:"A", url:"https://a.example.com/x", password:"pw-a" },
    { name:"B", url:"https://b.example.com/y", password:"pw-b" }
  ] } };

  await assert.rejects(() => runGiftLoop(data, flakyCrypto), (err) => {
    assert.ok(err.userMessage.includes("B"), "失敗した配布物の名前が出ていません");
    return true;
  });

  const json = JSON.stringify(data);
  assert.equal(json.includes("https://b.example.com/y"), false, "失敗した項目の平文URLが残っています");
  assert.equal(json.includes("pw-a"), false, "合言葉が残っています");
  assert.equal(json.includes("pw-b"), false, "合言葉が残っています");
});

test("失敗時：名前が空でもメッセージが壊れない", async () => {
  const data = { present: { items: [ { url: PLAIN_URL, password:"pw" } ] } };
  await assert.rejects(() => runGiftLoop(data, brokenSubtleCrypto), (err) => {
    assert.ok(err.userMessage.includes("名前なし"));
    return true;
  });
});

/* ================================================================
   3. ソースコードの見張り（うっかり元に戻さないため）
   ================================================================ */
test("握りつぶしの catch が復活していないこと", () => {
  assert.equal(
    /catch\s*\(\s*err\s*\)\s*\{\s*console\.error\("暗号化に失敗",\s*err\s*\)\s*;?\s*\}/.test(HTML),
    false,
    "暗号化失敗を握りつぶす catch が復活しています"
  );
});

test("buildHtml() の呼び出し3か所すべてが失敗を受け止めていること", () => {
  const calls = HTML.match(/buildHtml\(\)/g).filter((_, i) => i > 0); /* 定義行を除く */
  assert.equal(calls.length, 3, "buildHtml() の呼び出し数が想定と違います");
  /* 各呼び出しの直前に try があること（簡易チェック） */
  const spots = [...HTML.matchAll(/await buildHtml\(\)/g)].map(m => m.index);
  assert.equal(spots.length, 3);
  for (const i of spots){
    const before = HTML.slice(Math.max(0, i - 200), i);
    assert.ok(/try\s*\{/.test(before), "buildHtml() の呼び出しが try で囲まれていません");
  }
});

test("互換性の目印が壊れていないこと", () => {
  assert.ok(HTML.includes("elremo_editor_data_v9"));
  assert.ok(HTML.includes("elremo_editor_data_v1"));
  assert.ok(HTML.includes("__SITE_DATA__"));
  assert.ok(HTML.includes("SITE_DATA_END"));
});

/* ================================================================
   4. v2 の暗号化そのもの（毎回あたらしく作る側）

   ここで確かめたいのは「決めたバイトの並びどおりか」と
   「1バイトでも書きかえたら開かないか」です。
   ================================================================ */

const V2_URL = "https://example.invalid/gift/v2";
const V2_PW  = "あいことば-v2";

test("v2：暗号化したものを復号すると、元のURLに戻る", async () => {
  const api = buildLockApi();
  const lock = await api.lockUrlFresh(V2_URL, V2_PW);
  assert.equal(await unlockV2(lock, V2_PW), V2_URL);
});

test("v2：lock は必ず v2. で始まる", async () => {
  const api = buildLockApi();
  const lock = await api.lockUrlFresh(V2_URL, V2_PW);
  assert.ok(lock.startsWith("v2."), "v2. で始まっていません");
  /* 旧形式と見分けられること（旧形式は「.」を含まない） */
  assert.ok(lock.indexOf(".") >= 0);
});

test("v2：中身が決めたとおりの並びになっている", async () => {
  const api = buildLockApi();
  const p = parseV2(await api.lockUrlFresh(V2_URL, V2_PW));
  assert.equal(p.kdfId, 1, "鍵の作り方が PBKDF2 ではありません");
  assert.equal(p.iter, api.LOCK_ITER, "くり返す回数が本体の設定と違います");
  assert.equal(p.salt.length, 16, "salt が16バイトではありません");
  assert.equal(p.iv.length, 12, "IV が12バイトではありません");
  assert.equal(p.header.length, 33, "ヘッダが33バイトではありません");
  assert.ok(p.ct.length >= 16 + 1, "暗号文が短すぎます");
});

test("v2：くり返す回数は 600,000", async () => {
  const api = buildLockApi();
  assert.equal(api.LOCK_ITER, 600000);
  const p = parseV2(await api.lockUrlFresh(V2_URL, V2_PW));
  assert.equal(p.iter, 600000);
});

test("v2：同じURL・同じ合言葉でも、毎回 salt / IV / 暗号文がちがう", async () => {
  const api = buildLockApi();
  /* ★ fresh 関数を直接呼びます（覚え書きを通さない） */
  const a = parseV2(await api.lockUrlFresh(V2_URL, V2_PW));
  const b = parseV2(await api.lockUrlFresh(V2_URL, V2_PW));
  assert.equal(a.salt.equals(b.salt), false, "salt が同じです");
  assert.equal(a.iv.equals(b.iv), false, "IV が同じです");
  assert.equal(a.ct.equals(b.ct), false, "暗号文が同じです");
  assert.equal(a.raw.equals(b.raw), false, "lock 全体が同じです");
  /* どちらも正しく開けること */
  assert.equal(await unlockV2(packV2(a.raw), V2_PW), V2_URL);
  assert.equal(await unlockV2(packV2(b.raw), V2_PW), V2_URL);
});

test("v2：合言葉がちがえば開かない", async () => {
  const api = buildLockApi();
  const lock = await api.lockUrlFresh(V2_URL, V2_PW);
  await assert.rejects(() => unlockV2(lock, V2_PW + "x"));
  await assert.rejects(() => unlockV2(lock, ""));
});

/* ---- 改ざんの検出（AAD と認証タグが効いていることの確認）---- */

/* raw の1バイトを変えた lock を作る */
function tamper(raw, index){
  const t = Buffer.from(raw);
  t[index] = (t[index] + 1) & 0xFF;
  return packV2(t);
}

test("v2：くり返す回数を書きかえると開かない", async () => {
  const api = buildLockApi();
  const p = parseV2(await api.lockUrlFresh(V2_URL, V2_PW));
  /* 4バイトのうち、いちばん下の桁を1だけ変える */
  await assert.rejects(() => unlockV2(tamper(p.raw, 4), V2_PW));
});

test("v2：salt を書きかえると開かない", async () => {
  const api = buildLockApi();
  const p = parseV2(await api.lockUrlFresh(V2_URL, V2_PW));
  await assert.rejects(() => unlockV2(tamper(p.raw, 5), V2_PW));
  await assert.rejects(() => unlockV2(tamper(p.raw, 20), V2_PW));
});

test("v2：IV を書きかえると開かない", async () => {
  const api = buildLockApi();
  const p = parseV2(await api.lockUrlFresh(V2_URL, V2_PW));
  await assert.rejects(() => unlockV2(tamper(p.raw, 21), V2_PW));
  await assert.rejects(() => unlockV2(tamper(p.raw, 32), V2_PW));
});

test("v2：暗号文や認証タグを書きかえると開かない", async () => {
  const api = buildLockApi();
  const p = parseV2(await api.lockUrlFresh(V2_URL, V2_PW));
  await assert.rejects(() => unlockV2(tamper(p.raw, 33), V2_PW), "暗号文の改ざんが通っています");
  await assert.rejects(() => unlockV2(tamper(p.raw, p.raw.length - 1), V2_PW), "認証タグの改ざんが通っています");
});

test("v2：知らない鍵の作り方（kdfId）は開かない", async () => {
  const api = buildLockApi();
  const p = parseV2(await api.lockUrlFresh(V2_URL, V2_PW));
  const t = Buffer.from(p.raw);
  t[0] = 2;                                  /* 1 = PBKDF2 以外にする */
  await assert.rejects(() => unlockV2(packV2(t), V2_PW), /知らない鍵の作り方/);
});

test("v2：くり返す回数が範囲外なら、鍵を作る前に断る", async () => {
  const api = buildLockApi();
  const p = parseV2(await api.lockUrlFresh(V2_URL, V2_PW));
  for (const n of [0, 1, 99999, 2000001, 4294967295]) {
    const t = Buffer.from(p.raw);
    t.writeUInt32BE(n, 1);
    await assert.rejects(() => unlockV2(packV2(t), V2_PW), /範囲外/, String(n));
  }
});

test("v2：かたちが壊れているものは断る", async () => {
  for (const bad of ["v2.", "v2.!!!!", "v2.QUJD", "v2.QQ==", "", "v2", null, 123, {}]) {
    await assert.rejects(() => unlockV2(bad, V2_PW), String(bad));
  }
});

/* ================================================================
   5. 覚え書き（メモ化）

   ⚠ ここは「同じものを返す」のが正しい仕様です。
      毎回ちがうことを確かめるのは、上の fresh 側の役目です。
   ================================================================ */

/* PBKDF2 を何回まわしたかを数える crypto */
function countingCrypto(){
  const rec = { deriveKey: 0, encrypt: 0 };
  return {
    rec,
    getRandomValues: (a) => realCrypto.getRandomValues(a),
    subtle: {
      importKey: (...a) => realCrypto.subtle.importKey(...a),
      deriveKey: (...a) => { rec.deriveKey++; return realCrypto.subtle.deriveKey(...a); },
      encrypt:   (...a) => { rec.encrypt++;   return realCrypto.subtle.encrypt(...a); },
      digest:    (...a) => realCrypto.subtle.digest(...a)
    }
  };
}

test("覚え書き：同じURL・同じ合言葉なら、同じ lock を返す", async () => {
  const c = countingCrypto();
  const api = buildLockApi(c);
  const a = await api.lockUrl(V2_URL, V2_PW);
  const b = await api.lockUrl(V2_URL, V2_PW);
  assert.equal(a, b, "同じ組なのに別の lock を返しています");
});

test("覚え書き：同じ組なら、暗号化は1回だけ", async () => {
  const c = countingCrypto();
  const api = buildLockApi(c);
  await api.lockUrl(V2_URL, V2_PW);
  await api.lockUrl(V2_URL, V2_PW);
  await api.lockUrl(V2_URL, V2_PW);
  assert.equal(c.rec.deriveKey, 1, "PBKDF2 が複数回まわっています");
  assert.equal(c.rec.encrypt, 1, "暗号化が複数回走っています");
  assert.equal(api.lockCache.size, 1);
});

test("覚え書き：URL が変われば、別の lock になる", async () => {
  const c = countingCrypto();
  const api = buildLockApi(c);
  const a = await api.lockUrl(V2_URL, V2_PW);
  const b = await api.lockUrl(V2_URL + "-2", V2_PW);
  assert.notEqual(a, b);
  assert.equal(c.rec.deriveKey, 2, "作り直していません");
  assert.equal(parseV2(a).salt.equals(parseV2(b).salt), false, "salt を使い回しています");
});

test("覚え書き：合言葉が変われば、別の lock になる", async () => {
  const c = countingCrypto();
  const api = buildLockApi(c);
  const a = await api.lockUrl(V2_URL, V2_PW);
  const b = await api.lockUrl(V2_URL, V2_PW + "-2");
  assert.notEqual(a, b);
  assert.equal(c.rec.deriveKey, 2, "作り直していません");
  assert.equal(parseV2(a).salt.equals(parseV2(b).salt), false, "salt を使い回しています");
});

test("覚え書き：目印のつなぎ方で、別の組を取りちがえない", async () => {
  /* ("a b","c") と ("a","b c") が同じ目印にならないこと */
  const api = buildLockApi();
  const a = await api.lockUrl("https://example.invalid/a b", "c");
  const b = await api.lockUrl("https://example.invalid/a", "b c");
  assert.notEqual(a, b, "別の組を同じものとして扱っています");
  assert.equal(api.lockCache.size, 2);
});

test("覚え書き：新しく開き直せば（別のcache）、また作り直される", async () => {
  const api1 = buildLockApi();
  const api2 = buildLockApi();          /* ページを開き直した状態にあたる */
  const a = await api1.lockUrl(V2_URL, V2_PW);
  const b = await api2.lockUrl(V2_URL, V2_PW);
  assert.notEqual(a, b, "開き直しても同じ lock が出ています");
  assert.equal(parseV2(a).salt.equals(parseV2(b).salt), false, "salt が同じです");
  /* どちらも正しく開けること */
  assert.equal(await unlockV2(a, V2_PW), V2_URL);
  assert.equal(await unlockV2(b, V2_PW), V2_URL);
});

test("覚え書き：外に持ち出さない作りになっている", () => {
  /* 説明の文章では触れているので、コード部分だけを見る */
  const code = SRC_LOCKURL.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const w of ["localStorage", "sessionStorage", "indexedDB", "fetch(", "XMLHttpRequest",
                   "sendBeacon", "console.log", "console.warn", "console.error"]) {
    assert.equal(code.includes(w), false, `あってはいけない記述: ${w}`);
  }
  /* 覚え書きはメモリの上（Map）だけ */
  assert.match(code, /const lockCache=new Map\(\);/);
  /* 合言葉を画面やログへ出す記述が無いこと */
  assert.equal(/console\./.test(code), false, "ログ出力があります");
});

/* ================================================================
   6. 旧方式（v1）との互換

   test/fixtures/legacy_lock.json は「昔配った配布物」の代役です。
   **作り直さないでください。** これが開けなくなったら互換性が壊れています。
   ================================================================ */

const LEGACY = JSON.parse(
  readFileSync(new URL("./fixtures/legacy_lock.json", import.meta.url), "utf8"));

test("旧方式：昔の lock を、いまも復号できる", async () => {
  const got = await unlockLegacy(LEGACY.lock, LEGACY.password);
  assert.equal(got, LEGACY.url, "昔配った配布物が開けなくなっています");
});

test("旧方式：復号した結果が fixture の URL と一致する", async () => {
  const got = await unlockLegacy(LEGACY.lock, LEGACY.password);
  assert.equal(got, "https://example.invalid/gift/legacy-fixture");
  assert.ok(got.startsWith("https://example.invalid/"), "テスト用のURLではありません");
});

test("旧方式：合言葉がちがえば開かない", async () => {
  await assert.rejects(() => unlockLegacy(LEGACY.lock, LEGACY.password + "x"));
});

test("旧方式：fixture のかたちが変わっていない", () => {
  /* 中身（lock 本文・合言葉）は画面に出しません。かたちだけ確かめます。 */
  assert.deepEqual(Object.keys(LEGACY).sort(),
    ["createdWith","format","lock","note","password","url"]);
  assert.match(LEGACY.lock, /^[A-Za-z0-9+/]+={0,2}$/, "旧形式の Base64 ではありません");
  assert.equal(LEGACY.lock.indexOf("."), -1, "旧形式に「.」が入っています");
  assert.equal(LEGACY.lock.startsWith("v2."), false, "v2 になっています");
  assert.equal(LEGACY.lock.length, 96, "fixture が作り直されています");
  assert.equal(Buffer.from(LEGACY.lock, "base64").length, 71, "fixture が作り直されています");
});

test("旧方式：v2 の復号では、昔の lock を受け付けない", async () => {
  /* かたちが違うので、v2 として読もうとすると必ず失敗する */
  await assert.rejects(() => unlockV2(LEGACY.lock, LEGACY.password), /v2 ではありません/);
});

/* ================================================================
   7. **配布される生成HTMLの中の復号コードそのもの**を動かす

   ここまでのテストは、テスト用に書いた復号で確かめていました。
   ここからは違います。

     eruremo_SiteManager.html
       → const TEMPLATE = decodeB64("…")
       → Base64 を復号
       → その中に**実際に埋め込まれている** lockBytes / unlockLegacy /
         unlockV2 / unlockUrl を取り出す
       → node:vm の隔離された場所で動かす

   つまり「配られる HTML の中の処理が本当に動くか」を確かめます。
   取り出しに失敗したら、テスト用の実装で代用せず**失敗させます**。
   ================================================================ */

/* TEMPLATE から復号のコードだけを機械的に取り出す */
function templateUnlockSource(){
  const hits = [...HTML.matchAll(/const TEMPLATE = decodeB64\("([A-Za-z0-9+/=]+)"\)/g)];
  assert.equal(hits.length, 1, "TEMPLATE がちょうど1個ではありません");
  const tpl = Buffer.from(hits[0][1], "base64").toString("utf8");

  const START = 'const LOCK_V2_PREFIX="v2.", LOCK_KDF_PBKDF2=1;';
  const s = tpl.indexOf(START);
  assert.ok(s >= 0, "TEMPLATE から復号コードの先頭を取り出せません");
  assert.equal(tpl.indexOf(START, s + 1), -1, "復号コードの先頭が2か所あります");

  const FN = "async function unlockUrl(lockStr,pw){";
  const f = tpl.indexOf(FN, s);
  assert.ok(f > s, "TEMPLATE に unlockUrl がありません");

  /* 波かっこを数えて、関数の終わりを正確に見つける */
  let depth = 0, end = -1;
  for (let i = f; i < tpl.length; i++){
    const c = tpl[i];
    if (c === "{") depth++;
    else if (c === "}"){ depth--; if (depth === 0){ end = i + 1; break; } }
  }
  assert.ok(end > f, "unlockUrl の終わりが見つかりません");

  const block = tpl.slice(s, end);
  for (const need of ["function lockBytes(", "async function unlockLegacy(",
                      "async function unlockV2(", "async function unlockUrl("]){
    assert.ok(block.includes(need), `TEMPLATE の復号コードに ${need} がありません`);
  }
  return block;
}

/* 取り出しに失敗したら、この時点で読み込みごと失敗します（代用はしません） */
const TPL_UNLOCK_SRC = templateUnlockSource();

/* 取り出したコードを、隔離した場所で動かす。
   渡すのは、そのコードが必要とする標準機能だけです。 */
function buildTemplateUnlockApi(){
  const rec = { importKey:0, deriveKey:0, decrypt:0, digest:0 };
  const cryptoForVm = {
    getRandomValues: (a) => realCrypto.getRandomValues(a),
    subtle: {
      importKey: (...a) => { rec.importKey++; return realCrypto.subtle.importKey(...a); },
      deriveKey: (...a) => { rec.deriveKey++; return realCrypto.subtle.deriveKey(...a); },
      decrypt:   (...a) => { rec.decrypt++;   return realCrypto.subtle.decrypt(...a); },
      digest:    (...a) => { rec.digest++;    return realCrypto.subtle.digest(...a); }
    }
  };
  const ctx = vm.createContext({
    crypto: cryptoForVm,
    TextEncoder, TextDecoder, atob, btoa, Uint8Array
  });
  const api = vm.runInContext(
    "(function(){\n" + TPL_UNLOCK_SRC +
    "\nreturn { lockBytes, unlockLegacy, unlockV2, unlockUrl };\n})()", ctx);
  api.rec = rec;
  return api;
}

/* ---- A. v2 の正常系（いちばん大事）---- */

test("実TEMPLATE：外側で暗号化した v2 lock を、配布HTMLの復号コードで開ける", async () => {
  const outer = buildLockApi();                       /* 本物の暗号化 */
  const tplApi = buildTemplateUnlockApi();            /* 本物の復号 */

  const lock = await outer.lockUrlFresh(V2_URL, V2_PW);
  const got = await tplApi.unlockUrl(lock, V2_PW);

  assert.equal(got, V2_URL, "暗号化側と配布側で かたちが合っていません");
  assert.equal(tplApi.rec.deriveKey, 1, "PBKDF2 が使われていません");
  assert.equal(tplApi.rec.digest, 0, "旧方式の鍵づくりが動いています");
});

test("実TEMPLATE：日本語を含むURLでも、そのまま元に戻る", async () => {
  const outer = buildLockApi();
  const tplApi = buildTemplateUnlockApi();
  const url = "https://example.invalid/贈り物/ありがとう?名前=えるれも";
  const lock = await outer.lockUrlFresh(url, "にほんご の あいことば");
  assert.equal(await tplApi.unlockUrl(lock, "にほんご の あいことば"), url);
});

test("実TEMPLATE：書き出しループが作った lock も開ける", async () => {
  const data = { present: { items: [
    { name:"モデルA", url: PLAIN_URL, password:"あいことば123" }
  ] } };
  const out = await runGiftLoop(data, realCrypto);
  const tplApi = buildTemplateUnlockApi();
  assert.equal(await tplApi.unlockUrl(out.present.items[0].lock, "あいことば123"), PLAIN_URL);
});

/* ---- B. 旧方式の正常系（振り分け経由）---- */

test("実TEMPLATE：昔の lock を、振り分け経由で開ける", async () => {
  const tplApi = buildTemplateUnlockApi();
  /* unlockLegacy を直接ではなく、入口の unlockUrl に渡す */
  const got = await tplApi.unlockUrl(LEGACY.lock, LEGACY.password);
  assert.equal(got, LEGACY.url, "昔配った配布物が開けなくなっています");
  assert.equal(tplApi.rec.digest, 1, "旧方式の鍵づくりが使われていません");
  assert.equal(tplApi.rec.deriveKey, 0, "旧方式なのに PBKDF2 が動いています");
});

test("実TEMPLATE：昔の lock でも、合言葉がちがえば開かない", async () => {
  const tplApi = buildTemplateUnlockApi();
  await assert.rejects(() => tplApi.unlockUrl(LEGACY.lock, LEGACY.password + "x"));
});

/* ---- C. かたちの判定がきびしいこと ---- */

test("実TEMPLATE：知らないバージョンは、昔の方式で試さずに断る", async () => {
  const tplApi = buildTemplateUnlockApi();
  /* 中身は本物の v2 のまま、番号だけ変える */
  const outer = buildLockApi();
  const body = (await outer.lockUrlFresh(V2_URL, V2_PW)).slice(3);
  for (const pre of ["v3.", "v99.", "v0.", "v10."]){
    await assert.rejects(() => tplApi.unlockUrl(pre + body, V2_PW), pre);
  }
  assert.equal(tplApi.rec.deriveKey, 0, "知らないバージョンで鍵を作っています");
  assert.equal(tplApi.rec.digest, 0, "知らないバージョンを昔の方式で試しています");
});

test("実TEMPLATE：区切りが「.」でなければ v2 として扱わない", async () => {
  const tplApi = buildTemplateUnlockApi();
  /* "v2X…" は v2 ではない。昔の方式として見ても不正なので断る。 */
  for (const s of ["v2Xabcd", "v2abcd", "v2-abcd"]){
    await assert.rejects(() => tplApi.unlockUrl(s, V2_PW), s);
  }
});

test("実TEMPLATE：文字列でないもの・空は断る", async () => {
  const tplApi = buildTemplateUnlockApi();
  for (const v of ["", null, undefined, 123, {}, [], true]){
    await assert.rejects(() => tplApi.unlockUrl(v, V2_PW), String(v));
  }
  assert.equal(tplApi.rec.deriveKey, 0);
  assert.equal(tplApi.rec.digest, 0);
});

/* ---- D. v2 の改ざんを、ぜんぶ断ること ---- */

/* 本物の v2 lock を1つ作って、そのバイトをいじる */
async function realV2Parts(){
  const outer = buildLockApi();
  return parseV2(await outer.lockUrlFresh(V2_URL, V2_PW));
}

test("実TEMPLATE：合言葉がちがえば開かない", async () => {
  const tplApi = buildTemplateUnlockApi();
  const p = await realV2Parts();
  await assert.rejects(() => tplApi.unlockUrl(packV2(p.raw), V2_PW + "x"));
  assert.equal(tplApi.rec.deriveKey, 1, "鍵は作ったうえで、認証で落ちるはずです");
});

test("実TEMPLATE：salt / IV / 暗号文 / 認証タグ を1バイト変えると開かない", async () => {
  const p = await realV2Parts();
  const spots = [
    ["salt の先頭", 5], ["salt の末尾", 20],
    ["IV の先頭", 21], ["IV の末尾", 32],
    ["暗号文の先頭", 33], ["認証タグの末尾", p.raw.length - 1]
  ];
  for (const [label, i] of spots){
    const tplApi = buildTemplateUnlockApi();
    const t = Buffer.from(p.raw); t[i] = (t[i] + 1) & 0xFF;
    await assert.rejects(() => tplApi.unlockUrl(packV2(t), V2_PW), label);
  }
});

test("実TEMPLATE：短すぎる中身は断る", async () => {
  const tplApi = buildTemplateUnlockApi();
  for (const n of [0, 33, 49]){
    await assert.rejects(() => tplApi.unlockUrl(packV2(Buffer.alloc(n)), V2_PW), String(n));
  }
  assert.equal(tplApi.rec.deriveKey, 0, "短すぎるのに鍵を作っています");
});

test("実TEMPLATE：壊れた Base64 は断る", async () => {
  const tplApi = buildTemplateUnlockApi();
  for (const s of ["v2.", "v2.!!!!", "v2.QUJD@@", "v2.QUJDQ", "v2.====" ]){
    await assert.rejects(() => tplApi.unlockUrl(s, V2_PW), s);
  }
  assert.equal(tplApi.rec.deriveKey, 0);
});

/* ---- E. 重い計算に入る前に断ること ---- */

test("実TEMPLATE：知らない鍵の作り方は、PBKDF2 を動かす前に断る", async () => {
  const tplApi = buildTemplateUnlockApi();
  const p = await realV2Parts();
  for (const kdf of [0, 2, 9, 255]){
    const t = Buffer.from(p.raw); t[0] = kdf;
    await assert.rejects(() => tplApi.unlockUrl(packV2(t), V2_PW), String(kdf));
  }
  assert.equal(tplApi.rec.deriveKey, 0, "鍵を作ってしまっています");
  assert.equal(tplApi.rec.importKey, 0, "鍵の材料を読み込んでしまっています");
});

test("実TEMPLATE：くり返す回数が少なすぎるときは、PBKDF2 を動かす前に断る", async () => {
  const tplApi = buildTemplateUnlockApi();
  const p = await realV2Parts();
  for (const n of [0, 1, 99999]){
    const t = Buffer.from(p.raw); t.writeUInt32BE(n, 1);
    await assert.rejects(() => tplApi.unlockUrl(packV2(t), V2_PW), String(n));
  }
  assert.equal(tplApi.rec.deriveKey, 0, "鍵を作ってしまっています");
});

test("実TEMPLATE：くり返す回数が多すぎるときは、PBKDF2 を動かす前に断る", async () => {
  /* ★ ここが大事：巨大な回数を埋め込まれても、閲覧者のブラウザが固まらない */
  const tplApi = buildTemplateUnlockApi();
  const p = await realV2Parts();
  for (const n of [2000001, 100000000, 4294967295]){
    const t = Buffer.from(p.raw); t.writeUInt32BE(n, 1);
    await assert.rejects(() => tplApi.unlockUrl(packV2(t), V2_PW), String(n));
  }
  assert.equal(tplApi.rec.deriveKey, 0, "重い計算を始めてしまっています");
});

/* ---- F. 昔の方式の判定もきびしいこと ---- */

test("実TEMPLATE：「.」を含むものは、昔の方式として扱わない", async () => {
  const tplApi = buildTemplateUnlockApi();
  for (const s of ["abc.def", "QUJD.QUJD", "....", LEGACY.lock + ".x"]){
    await assert.rejects(() => tplApi.unlockUrl(s, V2_PW), s);
  }
  assert.equal(tplApi.rec.digest, 0, "昔の方式で試しています");
});

test("実TEMPLATE：Base64 でない文字が入っていれば断る", async () => {
  const tplApi = buildTemplateUnlockApi();
  for (const s of ["###!", "あいうえ", "QUJD QUJD", "QUJD\nQUJD"]){
    await assert.rejects(() => tplApi.unlockUrl(s, V2_PW), JSON.stringify(s));
  }
});

test("実TEMPLATE：長さが4の倍数でなければ断る", async () => {
  const tplApi = buildTemplateUnlockApi();
  for (const s of ["Q", "QU", "QUJ", "QUJDQ", "QUJDQU"]){
    await assert.rejects(() => tplApi.unlockUrl(s, V2_PW), s);
  }
});

test("実TEMPLATE：中身が29バイト未満なら断る", async () => {
  const tplApi = buildTemplateUnlockApi();
  /* かたちは正しい Base64 だが、中身が短い */
  for (const n of [0, 12, 28]){
    const s = Buffer.alloc(n).toString("base64");
    if (!s) continue;
    await assert.rejects(() => tplApi.unlockUrl(s, V2_PW), String(n));
  }
  assert.equal(tplApi.rec.digest, 0, "短すぎるのに鍵を作っています");
});

test("実TEMPLATE：どの断り方でも、平文URLは返らない", async () => {
  const tplApi = buildTemplateUnlockApi();
  const p = await realV2Parts();
  const bads = [
    "", null, 123, {}, "v3." + packV2(p.raw).slice(3), "v2X", "abc.def",
    "###", "QUJD", packV2(Buffer.alloc(40)),
    (() => { const t = Buffer.from(p.raw); t[0] = 2; return packV2(t); })(),
    (() => { const t = Buffer.from(p.raw); t.writeUInt32BE(1, 1); return packV2(t); })(),
    (() => { const t = Buffer.from(p.raw); t[33] ^= 1; return packV2(t); })()
  ];
  for (const bad of bads){
    let returned;
    try { returned = await tplApi.unlockUrl(bad, V2_PW); }
    catch { continue; }                              /* 失敗するのが正しい */
    assert.fail("断るべき入力で値が返りました: " + JSON.stringify(String(returned).slice(0, 40)));
  }
});

test("実TEMPLATE：取り出したコードに、余計なものが入っていない", () => {
  /* 隔離した場所で動かすので、DOM も通信も要らないはず */
  for (const w of ["document", "window", "fetch(", "localStorage", "XMLHttpRequest",
                   "eval(", "innerHTML"]){
    assert.equal(TPL_UNLOCK_SRC.includes(w), false, `あってはいけない記述: ${w}`);
  }
  /* 三段構成であること */
  assert.equal((TPL_UNLOCK_SRC.match(/async function unlockUrl\(/g) || []).length, 1);
  assert.equal((TPL_UNLOCK_SRC.match(/async function unlockV2\(/g) || []).length, 1);
  assert.equal((TPL_UNLOCK_SRC.match(/async function unlockLegacy\(/g) || []).length, 1);
});
