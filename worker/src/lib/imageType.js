/* ================================================================
   画像の種類の判定（マジックバイト方式）

   「拡張子が .jpg だから JPEG」とは絶対に判断しません。
   ファイルの先頭にある決まったバイト列（マジックバイト）だけを見ます。

   これにより、中身が HTML や JavaScript や SVG のファイルを
   「画像」と偽って送りつけられても、確実に弾けます。
   ================================================================ */

/* 許可する形式だけを並べた表。ここに無いものはすべて拒否。 */
export const ALLOWED_TYPES = Object.freeze({
  "image/jpeg": "jpg",
  "image/png":  "png",
  "image/webp": "webp"
});

const startsWith = (bytes, sig, offset = 0) => {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
  return true;
};

const JPEG = [0xFF, 0xD8, 0xFF];
const PNG  = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
const RIFF = [0x52, 0x49, 0x46, 0x46]; /* "RIFF" */
const WEBP = [0x57, 0x45, 0x42, 0x50]; /* "WEBP" */

/**
 * ファイルの中身から画像の種類を判定する。
 * @param {Uint8Array} bytes
 * @returns {{mime:string, ext:string}|null}  判定できなければ null（＝拒否）
 */
export function sniffImageType(bytes){
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return null;

  /* JPEG: FF D8 FF */
  if (startsWith(bytes, JPEG)) return { mime: "image/jpeg", ext: "jpg" };

  /* PNG: 89 50 4E 47 0D 0A 1A 0A */
  if (startsWith(bytes, PNG)) return { mime: "image/png", ext: "png" };

  /* WebP: "RIFF" ＋ 8バイト目から "WEBP"
     RIFF だけでは WAV や AVI かもしれないので、両方そろって初めて WebP と認める。 */
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) {
    /* RIFF のサイズ欄が明らかに壊れている（中身が無い）ものは受け付けない */
    if (bytes.length < 16) return null;
    return { mime: "image/webp", ext: "webp" };
  }

  /* 上のどれでもない ＝ SVG・GIF・AVIF・HTML・JavaScript・ZIP など、すべて拒否 */
  return null;
}

/**
 * クライアントが申告した Content-Type を、比較できる形に整える。
 * 例: "image/jpeg; charset=x" → "image/jpeg"
 */
export function normalizeDeclaredType(value){
  return String(value == null ? "" : value).split(";")[0].trim().toLowerCase();
}
