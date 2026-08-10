/* ================================================================
   管理画面（worker/public/index.html）の表示のテスト

   なぜ必要か：
     この画面は long らく「ローカル専用」と書かれていました。
     ステージングから開いたときに「これはローカルです」「画像は
     worker/.wrangler/state/ に保存されます」と出ると、
     **事実と違う説明**になり、誤操作のもとになります。

     そこで /api/health の environment を見て表示を切り替えます。
     ここでは「切り替えの仕掛けが正しく入っているか」を、
     HTML の中身を読んで確かめます（ブラウザは動かしません）。
   ================================================================ */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const HTML = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

/* data-only="〇〇" が付いた要素の中身をざっくり取り出す */
function blocksFor(env){
  const re = new RegExp(`data-only="${env}"[^>]*>([\\s\\S]*?)</(?:div|p)>`, "g");
  return [...HTML.matchAll(re)].map(m => m[1]);
}

/* ================================================================
   1. 環境ごとの出し分けが入っているか
   ================================================================ */

test("/api/health を見て環境を判断している", () => {
  assert.match(HTML, /fetch\("\/api\/health"/);
  assert.match(HTML, /body\.environment/);
});

test("ローカル・ステージング・不明の3つの表示が用意されている", () => {
  for (const env of ["local", "staging", "unknown"]) {
    assert.ok(blocksFor(env).length > 0, `${env} 向けの表示がありません`);
  }
});

test("環境ごとの表示は、最初はすべて隠してある", () => {
  /* 判断がつくまで、どの環境の説明も出さない
     （ステージングで「ローカル専用」と一瞬でも出さないため） */
  const re = /data-only="(local|staging|unknown)"[^>]*>/g;
  for (const m of HTML.matchAll(re)) {
    assert.match(m[0], /\bhidden\b/, `最初から見えています: ${m[0]}`);
  }
});

/* ================================================================
   2. ローカル専用の説明が、ローカル以外に出ないこと（今回の修正の要）
   ================================================================ */

test("ローカル専用の文言は local の表示の中にしかない", () => {
  const localOnly = blocksFor("local").join("\n");
  const stagingOnly = blocksFor("staging").join("\n");

  for (const phrase of ["worker/.wrangler/state/", "自分のパソコンの中", "ローカルR2"]) {
    assert.ok(localOnly.includes(phrase), `local の表示に見当たりません: ${phrase}`);
    assert.equal(stagingOnly.includes(phrase), false,
      `staging の表示に出てしまいます: ${phrase}`);
  }
});

test("「ローカル開発用の入口です」を最初から書き込まない", () => {
  /* 画面の初期状態は「環境を確認しています…」。
     環境が分かってから JavaScript で差し替える。 */
  const bodyStart = HTML.slice(HTML.indexOf("<body>"), HTML.indexOf("<script>"));
  assert.equal(bodyStart.includes("ローカル開発用の入口です"), false,
    "環境が分かる前からローカル向けの説明が出ています");
  assert.match(bodyStart, /環境を確認しています/);
});

/* ================================================================
   3. ステージング向けの説明
   ================================================================ */

test("ステージングでは非公開の確認環境であることを伝える", () => {
  const stagingOnly = blocksFor("staging").join("\n");
  for (const phrase of ["Cloudflare Access", "公開サイトではありません"]) {
    assert.ok(stagingOnly.includes(phrase), `staging の表示に見当たりません: ${phrase}`);
  }
});

test("ステージングでは R2 が接続済みであることを伝える", () => {
  const stagingOnly = blocksFor("staging").join("\n");
  assert.ok(stagingOnly.includes("R2（画像の保管庫）は接続済み"), "接続済みの説明がありません");
  assert.equal(stagingOnly.includes("未接続"), false,
    "接続したのに「未接続」と書いてあります");
});

test("ステージングでは、書き込みが止まっていて読み出しは使えると伝える", () => {
  const stagingOnly = blocksFor("staging").join("\n");
  assert.ok(stagingOnly.includes("書き込み・削除は安全のため停止"),
    "書き込みが止まっている説明がありません");
  assert.ok(stagingOnly.includes("一覧・読み出しのみ利用できます"),
    "読み出しは使えるという説明がありません");
});

test("ステージングの見出しと帯が用意されている", () => {
  assert.match(HTML, /ERUREMO ステージング管理画面/);
  assert.match(HTML, /🟠 ステージング（非公開）/);
  assert.match(HTML, /Cloudflare Access で保護された非公開の確認環境/);
});

/* ================================================================
   4. 分からないときは、安全側に倒す
   ================================================================ */

test("環境が分からないときはローカル向けの説明を出さない", () => {
  /* applyEnv() は local / staging 以外をすべて unknown に寄せる */
  assert.match(HTML, /\(name === "local" \|\| name === "staging"\) \? name : "unknown"/);
});

test("疎通に失敗したときも unknown として扱う", () => {
  const script = HTML.slice(HTML.indexOf("async function detectEnv"),
                            HTML.indexOf("document.getElementById(\"btn\")"));
  /* はじめは「分からない」。はっきり分かったときだけ名前を入れる。 */
  assert.match(script, /let name = null/, "はじめから環境を決めつけています");
  assert.match(script, /if \(res\.ok\)/, "応答が ok でない場合を見ていません");
  assert.match(script, /body\.ok === true/, "ok:true 以外を信用しています");
  assert.match(script, /catch/, "例外を受け止めていません");
  /* 出口は1か所。どの失敗経路でも name は null のまま applyEnv へ渡る。 */
  assert.equal([...script.matchAll(/applyEnv\(/g)].length, 1,
    "applyEnv の呼び出しは1か所にしてください（失敗経路の見落としを防ぐため）");
  assert.match(script, /applyEnv\(name\)/);
});

test("環境が分からないときも、まだ使わないよう案内する", () => {
  const unknownOnly = blocksFor("unknown").join("\n");
  assert.ok(unknownOnly.includes("行わないでください"), "使用を控える案内がありません");
});

/* ================================================================
   5. 事故のもとを作っていないか
   ================================================================ */

test("サーバの応答を innerHTML に流し込んでいない", () => {
  assert.equal(/innerHTML/.test(HTML), false, "innerHTML を使っています");
  assert.match(HTML, /title\.textContent/);
  assert.match(HTML, /sub\.textContent/);
});

test("秘密情報・個人情報が書かれていない", () => {
  assert.equal(/[\w.+-]+@[\w-]+\.[\w.-]+/.test(HTML), false, "メールアドレスが書かれています");
  assert.equal(/cloudflareaccess\.com/.test(HTML), false, "チームの住所が書かれています");
  assert.equal(/workers\.dev/.test(HTML), false, "実際の住所が書かれています");
});

test("編集ツールへの入口は残っている", () => {
  assert.match(HTML, /href="\/eruremo_SiteManager\.html"/);
});
