/* ================================================================
   GET /media/… ― 保存した画像の読み出し

   なぜ必要か：
     アップロードした画像を、編集ツールのサムネイルやプレビューに
     表示するための「取り出し口」です。
     本番では images.eruremo.com（R2 の公開配信）がこの役割を果たします。
     ここは、その役割をローカルで肩代わりするものです。

   安全のための決まりごと：
   - 受け取ったパスは、既存の isValidMediaKey() に**完全一致**したものだけ通す。
     一致しなければ、理由を明かさず 404 を返す。
   - Content-Type は R2 に保存されている申告値ではなく、**キーの拡張子から決める**。
     拡張子はアップロード時にマジックバイト（中身のバイト列）で判定した結果なので、
     ここから text/html などが返ることは構造的にありえない。
   - 読み出し専用。書き込み・削除はしない（削除APIは Phase 4）。
   ================================================================ */
import { jsonError } from "./http.js";
import { isValidMediaKey, mimeFromKey } from "./mediaKey.js";
import { IMAGE_CACHE_CONTROL } from "./upload.js";

/* 拡張子 → Content-Type の判定（mimeFromKey）は mediaKey.js に移しました。
   Phase 4 の削除APIでも同じ判定を使うため、1か所にまとめてあります。 */

/** 画像に付けるヘッダ */
function imageHeaders(key, size, etag){
  const headers = {
    "content-type": mimeFromKey(key),
    /* キーに中身のハッシュが入っているので、長期キャッシュしても古い画像は出ない */
    "cache-control": IMAGE_CACHE_CONTROL,
    /* ブラウザに中身を推測させない */
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer"
  };
  if (typeof size === "number") headers["content-length"] = String(size);
  if (etag) headers["etag"] = etag;
  return headers;
}

/**
 * GET / HEAD /media/… を処理する。
 * @param {Request} request
 * @param {string}  path    正規化済みのパス（例: /media/gallery/2026/08/abc….webp）
 * @param {object}  env
 */
export async function handleMediaRead(request, path, env){
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonError("METHOD_NOT_ALLOWED", "GET, HEAD");
  }

  /* 先頭のスラッシュを取ったものが、そのまま R2 のキーになる。
     ここでは URL デコードをしない。正しいキーに使われる文字は
     すべてそのまま書ける文字なので、%2e などが混ざっている時点で不正。 */
  const key = path.replace(/^\/+/, "");
  if (!isValidMediaKey(key)) return jsonError("NOT_FOUND");

  const bucket = env && env.MEDIA_BUCKET;
  if (!bucket || typeof bucket.get !== "function" || typeof bucket.head !== "function") {
    console.error("メディア保管庫のバインディングが見つかりません");
    return jsonError("R2_ERROR");
  }

  try {
    /* HEAD は中身を読まない（転送量を無駄にしない） */
    if (request.method === "HEAD") {
      const meta = await bucket.head(key);
      if (!meta) return jsonError("NOT_FOUND");
      return new Response(null, { status: 200, headers: imageHeaders(key, meta.size, meta.httpEtag) });
    }

    const object = await bucket.get(key);
    if (!object) return jsonError("NOT_FOUND");

    /* 本物の R2 は body（ストリーム）を持つ。持たない実装のために取り出しも用意する。 */
    const body = object.body != null ? object.body : new Uint8Array(await object.arrayBuffer());
    return new Response(body, { status: 200, headers: imageHeaders(key, object.size, object.httpEtag) });
  } catch {
    /* 例外の中身はログにもレスポンスにも出さない（内部情報の漏えい防止） */
    console.error("メディアの読み出しに失敗しました");
    return jsonError("R2_ERROR");
  }
}
