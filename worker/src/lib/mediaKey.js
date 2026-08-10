/* ================================================================
   R2 に保存するときの「キー」（保管場所の名前）の生成と検証

   いちばん大事な考え方：
   **キーは Worker がすべて決める。利用者から受け取った文字列は一切入れない。**

   ファイル名も使いません。だから「../」を使って別の場所に書き込む
   （パストラバーサル）ことが、そもそも起こりえません。

     media/{category}/{年}/{月}/{中身のSHA-256の先頭16桁}.{jpg|png|webp}
     例: media/gallery/2026/08/3f2a9c1b7e4d8a05.webp
   ================================================================ */

/* 許可するカテゴリ。ここに完全一致するものだけを受け付ける。 */
export const CATEGORIES = Object.freeze([
  "logo", "favicon", "og", "about", "cast", "staff",
  "history", "shop", "present", "gallery", "other"
]);

/* 接頭辞は Worker 内で固定（旧内部開発ルール §5 の取り決め） */
export const MEDIA_PREFIX = "media";

/* 読み書き削除のすべてで使う、キーの検証パターン。
   Phase 4 の削除APIでも、これに完全一致しないキーは拒否する。 */
export const KEY_RE = new RegExp(
  `^${MEDIA_PREFIX}/(?:${CATEGORIES.join("|")})/\\d{4}/\\d{2}/[a-f0-9]{16}\\.(?:jpg|png|webp)$`
);

/* 拡張子 → Content-Type。キーの正規表現が許すのはこの3つだけ。
   R2 に保存された申告値ではなく**キーから**決めるため、
   text/html などが返ることは構造的にありえない。 */
const EXT_TO_MIME = Object.freeze({
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp"
});

/** キー（media/…/xxxx.webp）から Content-Type を決める */
export function mimeFromKey(key){
  const s = String(key || "");
  const ext = s.slice(s.lastIndexOf(".") + 1);
  return EXT_TO_MIME[ext] || "application/octet-stream";
}

/** キーから category を取り出す（media/{category}/… の2つめ） */
export function categoryFromKey(key){
  return String(key || "").split("/")[1] || "";
}

/** カテゴリが許可リストと完全一致するか */
export function isAllowedCategory(value){
  return typeof value === "string" && CATEGORIES.includes(value);
}

/** 生成したキーが正しい形かを、保存する直前に自分で確かめる */
export function isValidMediaKey(key){
  return typeof key === "string" && KEY_RE.test(key);
}

/** バイト列の SHA-256 を計算し、先頭16桁（hex）を返す */
export async function contentHash16(bytes){
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
  return hex.slice(0, 16);
}

/**
 * R2 キーを組み立てる。
 * @param {Uint8Array} bytes    ファイルの中身
 * @param {string} category     許可リストで検証済みのカテゴリ
 * @param {string} ext          マジックバイト判定の結果（jpg / png / webp）
 * @param {Date}   now          年月の決定に使う時刻（UTC）
 */
export async function buildMediaKey(bytes, category, ext, now = new Date()){
  if (!isAllowedCategory(category)) throw new Error("category is not allowed");
  if (!["jpg", "png", "webp"].includes(ext)) throw new Error("ext is not allowed");
  const yyyy = String(now.getUTCFullYear()).padStart(4, "0");
  const mm   = String(now.getUTCMonth() + 1).padStart(2, "0");
  const hash = await contentHash16(bytes);
  return `${MEDIA_PREFIX}/${category}/${yyyy}/${mm}/${hash}.${ext}`;
}

/** 公開URLを組み立てる（環境変数の末尾スラッシュを吸収する） */
export function publicMediaUrl(env, key){
  const base = String((env && env.PUBLIC_MEDIA_BASE_URL) || "").replace(/\/+$/, "");
  return base ? `${base}/${key}` : `/${key}`;
}
