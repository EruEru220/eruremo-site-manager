/* ================================================================
   HTTP レスポンスの共通処理

   方針：
   - 利用者に返す文言は、このファイルに書いた**固定の日本語**だけ。
   - 例外の内容・内部パス・バケット名・スタックトレースは絶対に返さない。
   - 利用者から受け取った文字列を、そのまま返さない（反射を避ける）。
   ================================================================ */

/* エラーコード → [HTTPステータス, 利用者向けメッセージ] */
export const ERRORS = Object.freeze({
  NOT_FOUND:          [404, "このURLはありません。"],
  METHOD_NOT_ALLOWED: [405, "この操作には対応していません。"],
  BAD_CONTENT_TYPE:   [415, "画像は multipart/form-data で送ってください。"],
  BAD_REQUEST:        [400, "リクエストの形式が正しくありません。"],
  NO_FILE:            [400, "画像が送られてきませんでした。"],
  EMPTY_FILE:         [400, "ファイルが空です。"],
  TOO_LARGE:          [413, "画像が大きすぎます（最大10MB）。"],
  INVALID_FILE_TYPE:  [400, "この画像形式には対応していません。"],
  MIME_MISMATCH:      [400, "ファイルの中身と種類が一致しません。"],
  INVALID_CATEGORY:   [400, "画像の置き場所の指定が正しくありません。"],
  /* --- Phase 4（一覧・削除）--- */
  BAD_JSON_TYPE:      [415, "この操作は application/json で送ってください。"],
  INVALID_KEY:        [400, "画像の指定が正しくありません。"],
  BAD_LIST_OPTION:    [400, "一覧の指定が正しくありません。"],
  /* --- Phase 4.5（門番）---
     断る理由（ロック中／通行証が無い／設定が足りない）で
     **返事を変えません**。外から状態を推し量れないようにするためです。 */
  FORBIDDEN:          [403, "アクセスできません。"],
  /* 画像を変える操作だけを止めているとき（読み出しは使えます） */
  MUTATIONS_DISABLED: [503, "いまは画像の追加・削除をお休みしています。"],
  BOARD_UNAVAILABLE:   [503, "掲示板を現在利用できません"],
  TURNSTILE_FAILED:    [403, "確認に失敗しました。もう一度お試しください。"],
  RATE_LIMITED:        [429, "投稿間隔をあけて、もう一度お試しください。"],
  DUPLICATE_POST:      [429, "同じ内容はしばらく投稿できません。"],
  BOARD_FULL:          [503, "掲示板を現在利用できません"],
  /* 見本の1枚だけを通す抜け道が開いているが、送られたものが違うとき */
  NOT_THE_CANARY:     [403, "いまは決められた1枚だけを受け付けています。"],
  /* 残り49件だけを通す道が開いているが、名簿に無いものが送られたとき */
  NOT_IN_BATCH:       [403, "いまは決められた画像だけを受け付けています。"],
  R2_ERROR:           [500, "画像の保存に失敗しました。"],
  INTERNAL:           [500, "処理に失敗しました。"]
});

/* すべての API レスポンスに付けるヘッダ */
function baseHeaders(){
  return {
    "content-type": "application/json; charset=utf-8",
    /* API の応答はキャッシュさせない（画像そのものとは別） */
    "cache-control": "no-store",
    /* ブラウザに中身を推測させない */
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer"
  };
}

export function jsonOk(body, status = 200, extraHeaders){
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...baseHeaders(), ...(extraHeaders || {}) }
  });
}

export function jsonError(code, allowedMethods){
  const entry = ERRORS[code] || ERRORS.INTERNAL;
  const safeCode = ERRORS[code] ? code : "INTERNAL";
  const body = { ok: false, error: { code: safeCode, message: entry[1] } };
  const headers = baseHeaders();
  /* 405 のときは、どのメソッドなら使えるかを HTTP の作法どおり返す */
  if (safeCode === "METHOD_NOT_ALLOWED" && allowedMethods) headers["allow"] = allowedMethods;
  return new Response(JSON.stringify(body), { status: entry[0], headers });
}
