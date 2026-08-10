/* ================================================================
   DELETE /api/media/item ― 画像を1枚だけ消す

   いきなり消しません。まず `trash/` へ写してから、元を消します。
   （PHASE_PLAN_JA.md の Phase 4「trash/ へ移動してから元を消す」）
   写す先の名前は Worker が元のキーから組み立てます。利用者は指定できません。

     media/gallery/2026/08/abcd….webp
       → trash/media/gallery/2026/08/abcd….webp へ写す
       → 元を消す

   `trash/` は読み出しAPI（/media/…）の対象外です。
   isValidMediaKey() が `media/` で始まるものしか通さないため、
   ゴミ箱の中身が外から読まれることはありません。

   安全のための決まりごと：
   - キーは isValidMediaKey() に**完全一致**したものだけ。`..` や別の接頭辞は拒否。
   - 指定は JSON の本体で受け取る（application/json 以外は拒否）。
     ふつうのフォームからは application/json を送れないため、
     よそのサイトに置いた仕掛けで勝手に消させること（CSRF）が起きにくくなります。
   - 「使用中かどうか」は Worker には分かりません（DATA はブラウザの中にあるため）。
     使用中の画像を守るのは管理画面側の役目で、ここは `trash/` が最後の受け皿です。
   - 本体は 4KB まで。大きなものは読む前に断ります。
   ================================================================ */
import { jsonOk, jsonError } from "./http.js";
import { isValidMediaKey, mimeFromKey } from "./mediaKey.js";
import { normalizeDeclaredType } from "./imageType.js";
import { MAX_UPLOAD_BYTES } from "./upload.js";
import { mutationsEnabled } from "./mutations.js";

/* ゴミ箱の接頭辞。Worker 内で固定（外から受け取らない）。 */
export const TRASH_PREFIX = "trash";
/* 指示の本体の上限。キー1本しか入らないので、これで十分。 */
export const MAX_DELETE_BODY_BYTES = 4096;

/** 検証済みのキーから、ゴミ箱側の名前を組み立てる */
export function trashKeyFor(key){
  return `${TRASH_PREFIX}/${key}`;
}

export async function handleMediaDelete(request, env){
  /* --- 1. メソッド --- */
  if (request.method !== "DELETE") return jsonError("METHOD_NOT_ALLOWED", "DELETE");

  /* --- 1-2. 非常停止スイッチ ---
     R2 のバインディングを見るより前に判定します。
     止まっているときは、保管庫に1回も触りません。 */
  if (!mutationsEnabled(env)) return jsonError("MUTATIONS_DISABLED");

  /* --- 2. Content-Type --- */
  const contentType = normalizeDeclaredType(request.headers.get("content-type"));
  if (contentType !== "application/json") return jsonError("BAD_JSON_TYPE");

  /* --- 3. 申告サイズによる事前拒否（本体を読む前に切る） --- */
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DELETE_BODY_BYTES) {
    return jsonError("BAD_REQUEST");
  }

  /* --- 4. 本体の読み取り --- */
  let text;
  try {
    text = await request.text();
  } catch {
    return jsonError("BAD_REQUEST");
  }
  /* 申告が無い場合に備えて、実際の長さでも切る */
  if (text.length > MAX_DELETE_BODY_BYTES) return jsonError("BAD_REQUEST");

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return jsonError("BAD_REQUEST");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return jsonError("BAD_REQUEST");
  }

  /* --- 5. キーの検証（ここが最重要） --- */
  const key = payload.key;
  if (!isValidMediaKey(key)) return jsonError("INVALID_KEY");

  /* --- 6. R2 --- */
  const bucket = env && env.MEDIA_BUCKET;
  if (!bucket
      || typeof bucket.get !== "function"
      || typeof bucket.put !== "function"
      || typeof bucket.delete !== "function") {
    console.error("メディア保管庫のバインディングが見つかりません");
    return jsonError("R2_ERROR");
  }

  try {
    const object = await bucket.get(key);
    /* 無いものは消せない。理由は明かさず「ありません」だけ返す。 */
    if (!object) return jsonError("NOT_FOUND");

    /* ゴミ箱へ写すために、いったん中身をメモリへ読みます。
       アップロードAPIを通ったものは必ず 10MB 以下ですが、万一それより大きい
       ものが同じ名前で置かれていた場合に備えて、読む前に大きさを見ます。 */
    if (typeof object.size === "number" && object.size > MAX_UPLOAD_BYTES) {
      console.error("削除対象が大きすぎます");
      return jsonError("TOO_LARGE");
    }

    const bytes = new Uint8Array(await object.arrayBuffer());

    /* まずゴミ箱へ写す。ここで失敗したら、元は消さずに終わる。 */
    await bucket.put(trashKeyFor(key), bytes, {
      httpMetadata: {
        contentType: mimeFromKey(key),
        /* ゴミ箱の中身はキャッシュさせない */
        cacheControl: "no-store"
      },
      customMetadata: {
        deletedAt: new Date().toISOString(),
        originalKey: key
      }
    });

    /* 写し終えてから、元を消す */
    await bucket.delete(key);
  } catch {
    /* 例外の中身はログにもレスポンスにも出さない（内部情報の漏えい防止） */
    console.error("メディアの削除に失敗しました");
    return jsonError("R2_ERROR");
  }

  return jsonOk({ ok: true, key, trashed: true });
}
