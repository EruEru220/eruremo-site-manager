/* ================================================================
   wrangler.jsonc を読むための小さな道具（テスト専用）

   JSONC（コメントを書ける JSON）を、外部パッケージなしで読みます。
   文字列の中の // や /* は消さないように気をつけています。
   ================================================================ */
import { readFileSync } from "node:fs";

/** JSONC からコメントと末尾カンマを取り除く */
export function stripJsonc(text){
  let out = "";
  let inString = false, escaped = false;
  let inLine = false, inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];

    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  /* 末尾カンマ（, の次が } または ]）を落とす */
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** wrangler.jsonc を読み込んで、ふつうのオブジェクトにする */
export function readWranglerConfig(){
  const path = new URL("../../wrangler.jsonc", import.meta.url);
  return JSON.parse(stripJsonc(readFileSync(path, "utf8")));
}
