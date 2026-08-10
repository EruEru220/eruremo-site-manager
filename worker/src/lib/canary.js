/* ================================================================
   見本の1枚（canary）だけを、例外的に受け取るための決まりごと

   なぜ要るのか：
     移行のしくみが正しく動くかは、**1枚だけ送って確かめる**のが安全です。
     しかし `MEDIA_MUTATIONS_ENABLED` を "true" にすると、
     **ふつうのアップロードも削除も全部**開いてしまいます。

     そこで「この1枚だけ」を通す、細い抜け道を用意します。
     抜け道は**この1枚以外を絶対に通しません**。

   通す条件（**ぜんぶ**満たしたときだけ）：
     1. ENVIRONMENT が **ちょうど "staging"**
     2. MEDIA_MUTATIONS_ENABLED が **ちょうど "false"**
        「"true" でなければよい」ではありません。**未設定も打ちまちがいも通しません。**
        意図して "false" と書いてある環境だけが、この抜け道の対象です。
     3. MIGRATION_CANARY_MUTATION_ENABLED が **ちょうど "true"**
     4. 送られてきた file がちょうど1個だけ（0個も2個以上も拒否）
     5. 中身の種類が image/webp
     6. 大きさがちょうど 12,588 バイト
     7. **実際のバイト列から計算した SHA-256** が、決めておいた値と完全一致
     8. その SHA-256 から作られるキーが、決めておいたキーと完全一致

   大事なこと：
     ・ブラウザが名乗ってきた key / sha256 / size は**信用しません**。
       Worker が**実際のバイト列から自分で計算**して確かめます。
     ・**削除はこの抜け道では絶対に開きません。**
       `MIGRATION_CANARY_MUTATION_ENABLED` が "true" でも、
       削除は `MEDIA_MUTATIONS_ENABLED` だけを見ます。
     ・ここに書いた値は `worker/scripts/migration-input.local.json` の
       見本の1枚と同じです。**ずれていないことをテストで確かめています**
       （worker/test/canaryUpload.test.mjs）。
   ================================================================ */

/** 見本の1枚（migration-input.local.json から取った値。テストで一致を固定） */
export const CANARY = Object.freeze({
  key: "media/gallery/2026/08/fcc4e376a9120c02.webp",
  category: "gallery",
  contentType: "image/webp",
  size: 12588,
  sha256: "fcc4e376a9120c02bd6db66476b5ca39c99117e62da8ab52989548197b1a3997"
});

/**
 * 環境の設定として、抜け道を使ってよいか。
 * **"true" と完全一致したときだけ**です（大文字小文字も空白も吸収しません）。
 */
export function canaryEnvAllows(env){
  if (!env) return false;
  /* 3つとも**文字列そのもの**が一致したときだけ開きます。
     大文字小文字も空白も吸収しません（うっかり開かないため）。 */
  if (env.ENVIRONMENT !== "staging") return false;
  if (env.MEDIA_MUTATIONS_ENABLED !== "false") return false;
  if (env.MIGRATION_CANARY_MUTATION_ENABLED !== "true") return false;
  return true;
}

/** バイト列の SHA-256 を、16進の64桁で返す */
export async function sha256Hex(bytes){
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * 送られてきたものが、まさにその見本の1枚かを確かめる。
 * **申告ではなく、実際のバイト列から計算して**判断します。
 *
 * @param {Uint8Array} bytes  実際に受け取ったバイト列
 * @param {string} mime       マジックバイトから判定した種類
 * @param {string} key        Worker が中身から組み立てたキー
 * @returns {Promise<boolean>}
 */
export async function isCanaryUpload(bytes, mime, key){
  if (!(bytes instanceof Uint8Array)) return false;
  if (bytes.byteLength !== CANARY.size) return false;
  if (mime !== CANARY.contentType) return false;
  if (key !== CANARY.key) return false;

  let actual;
  try {
    actual = await sha256Hex(bytes);
  } catch {
    return false;
  }
  return actual === CANARY.sha256;
}
