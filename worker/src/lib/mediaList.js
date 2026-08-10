/* ================================================================
   GET /api/media ― 保管庫にある画像の一覧

   何をするか：
     R2（画像の保管庫）に置いてある画像を、50件ずつ返します。
     管理画面はこれを受け取って、サムネイル付きの一覧を描きます。

   安全のための決まりごと：
   - 見に行く範囲は `media/` の中だけ（MEDIA_PREFIX）。
     利用者から接頭辞（prefix）を受け取りません。`trash/` も外から見えません。
   - 返す前に、キーが isValidMediaKey() に**完全一致**するものだけに絞ります。
     手作業などで妙な名前のものが混ざっていても、管理画面には出しません。
   - 続きを読むための cursor（目印）は R2 が発行した文字列です。
     中身が何であるかは R2 の都合なので、こちらでは形を決めつけません
     （決めつけると、R2 側の形が変わったとたんに続きが読めなくなります）。
     確かめるのは「長さ」と「改行などの制御文字が混ざっていないこと」だけです。
     cursor はパスにもキーにも使われないため、これで十分です。
   - 中身（画像そのもの）は返しません。返すのは名前・大きさ・日時・URL だけです。
   ================================================================ */
import { jsonOk, jsonError } from "./http.js";
import { MEDIA_PREFIX, isValidMediaKey, publicMediaUrl, categoryFromKey } from "./mediaKey.js";

/* 1回に返す件数。指定がなければ 50 件。 */
export const LIST_LIMIT_DEFAULT = 50;
export const LIST_LIMIT_MAX = 100;

/* cursor の長さの上限。R2 の cursor はこれよりずっと短い。 */
export const CURSOR_MAX_LENGTH = 1024;

/* 制御文字（改行・タブなど）と空白が混ざっていないか。
   文字コードで見ているのは、正規表現に制御文字を直接書かないためです。 */
function hasControlOrSpace(s){
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x20 || c === 0x7F) return true;
  }
  return false;
}

/** cursor として受け取ってよい形か（中身は解釈しない） */
export function isAcceptableCursor(value){
  return typeof value === "string"
      && value.length > 0
      && value.length <= CURSOR_MAX_LENGTH
      && !hasControlOrSpace(value);
}

export async function handleMediaList(request, env){
  /* --- 1. メソッド（読み出しだけ） --- */
  if (request.method !== "GET") return jsonError("METHOD_NOT_ALLOWED", "GET");

  /* --- 2. 指定の読み取りと検証 --- */
  let params;
  try {
    params = new URL(request.url).searchParams;
  } catch {
    return jsonError("BAD_REQUEST");
  }

  let limit = LIST_LIMIT_DEFAULT;
  const rawLimit = params.get("limit");
  if (rawLimit !== null && rawLimit !== "") {
    /* 整数以外・範囲外は、黙って直さずに拒否する */
    if (!/^\d{1,3}$/.test(rawLimit)) return jsonError("BAD_LIST_OPTION");
    const n = Number(rawLimit);
    if (n < 1 || n > LIST_LIMIT_MAX) return jsonError("BAD_LIST_OPTION");
    limit = n;
  }

  const rawCursor = params.get("cursor");
  let cursor = "";
  if (rawCursor !== null && rawCursor !== "") {
    if (!isAcceptableCursor(rawCursor)) return jsonError("BAD_LIST_OPTION");
    cursor = rawCursor;
  }

  /* --- 3. R2 --- */
  const bucket = env && env.MEDIA_BUCKET;
  if (!bucket || typeof bucket.list !== "function") {
    console.error("メディア保管庫のバインディングが見つかりません");
    return jsonError("R2_ERROR");
  }

  let listed;
  try {
    /* prefix はここで固定。外から受け取らないので、別の場所は覗けない。 */
    const options = { prefix: `${MEDIA_PREFIX}/`, limit };
    if (cursor) options.cursor = cursor;
    listed = await bucket.list(options);
  } catch {
    /* 例外の中身はログにもレスポンスにも出さない（内部情報の漏えい防止） */
    console.error("メディアの一覧取得に失敗しました");
    return jsonError("R2_ERROR");
  }

  /* --- 4. 形が正しいキーだけを、必要な情報に絞って返す --- */
  const objects = (listed && listed.objects) || [];
  const items = [];
  for (const o of objects) {
    const key = o && o.key;
    if (!isValidMediaKey(key)) continue;
    items.push({
      key,
      url: publicMediaUrl(env, key),
      category: categoryFromKey(key),
      size: typeof o.size === "number" ? o.size : 0,
      uploaded: toIso(o.uploaded)
    });
  }

  const truncated = !!(listed && listed.truncated);
  const body = { ok: true, items, truncated };
  /* 続きがあるときだけ、次の目印を返す。
     返す cursor も受け取るときと同じ条件で確かめる
     （そうしないと、自分が返した cursor を次に自分で拒否することになる）。 */
  if (truncated && isAcceptableCursor(listed.cursor)) {
    body.cursor = listed.cursor;
  }
  return jsonOk(body);
}

/* アップロード日時を ISO 文字列にする。読めない値なら null（推測で埋めない）。 */
function toIso(value){
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
