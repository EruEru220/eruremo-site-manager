import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../eruremo_SiteManager.html", import.meta.url), "utf8");

test("SiteManagerは編集DATAの保存先がこのブラウザ内だと常設表示する", () => {
  assert.match(html, /id="storageMode"/);
  assert.match(html, /現在の保存方式：このブラウザ内/);
});

test("SiteManagerは共有編集が未対応だと明示する", () => {
  assert.match(html, /共有編集：未対応/);
  assert.match(html, /D1による共有保存は次のフェーズで対応予定/);
});

test("保存方式表示はtext固定で、認証情報を差し込む処理を持たない", () => {
  const block = /<span class="storage-note"[\s\S]*?<\/span>\s*<\/span>/.exec(html);
  assert.ok(block, "保存方式表示が見つかりません");
  assert.equal(/innerHTML|token|jwt|email/i.test(block[0]), false);
});
