/* 画像の種類の判定（マジックバイト方式）のテスト */
import test from "node:test";
import assert from "node:assert/strict";
import { sniffImageType, normalizeDeclaredType, ALLOWED_TYPES } from "../src/lib/imageType.js";
import * as F from "./helpers/fixtures.mjs";

test("許可する形式は3つだけ", () => {
  assert.deepEqual(Object.keys(ALLOWED_TYPES).sort(), ["image/jpeg", "image/png", "image/webp"]);
});

test("JPEG を判定できる", () => {
  assert.deepEqual(sniffImageType(F.JPEG_BYTES), { mime: "image/jpeg", ext: "jpg" });
});
test("PNG を判定できる", () => {
  assert.deepEqual(sniffImageType(F.PNG_BYTES), { mime: "image/png", ext: "png" });
});
test("WebP を判定できる", () => {
  assert.deepEqual(sniffImageType(F.WEBP_BYTES), { mime: "image/webp", ext: "webp" });
});

for (const [label, data] of [
  ["SVG",              F.SVG_BYTES],
  ["XML宣言つきSVG",   F.SVG_XML_BYTES],
  ["HTML",             F.HTML_BYTES],
  ["JavaScript",       F.JS_BYTES],
  ["GIF",              F.GIF_BYTES],
  ["AVIF",             F.AVIF_BYTES],
  ["ZIP",              F.ZIP_BYTES],
  ["PDF",              F.PDF_BYTES],
  ["RIFFだけでWEBPが続かないもの", F.RIFF_ONLY_BYTES],
  ["空のバイト列",     F.EMPTY_BYTES]
]) {
  test(`${label} は画像として認めない`, () => {
    assert.equal(sniffImageType(data), null);
  });
}

test("Uint8Array 以外は認めない", () => {
  assert.equal(sniffImageType("FFD8FF"), null);
  assert.equal(sniffImageType(null), null);
  assert.equal(sniffImageType([0xFF, 0xD8, 0xFF]), null);
});

test("先頭が正しくても短すぎる WebP は認めない", () => {
  const short = new Uint8Array([0x52,0x49,0x46,0x46, 0,0,0,0, 0x57,0x45,0x42,0x50]);
  assert.equal(sniffImageType(short), null);
});

test("申告 Content-Type の正規化", () => {
  assert.equal(normalizeDeclaredType("image/JPEG; charset=utf-8"), "image/jpeg");
  assert.equal(normalizeDeclaredType("  image/png  "), "image/png");
  assert.equal(normalizeDeclaredType(null), "");
  assert.equal(normalizeDeclaredType(undefined), "");
});
