/* ================================================================
   POST /api/media/upload の本体

   大前提：**クライアント（ブラウザ）の申告を一切信用しない。**
   - ファイル名 → 使わない
   - Content-Type → 参考にするだけ。実際の判定は中身のバイト列
   - 保存先のパス → 受け取らない。Worker が決める
   ================================================================ */
import { jsonOk, jsonError } from "./http.js";
import { sniffImageType, normalizeDeclaredType } from "./imageType.js";
import { isAllowedCategory, buildMediaKey, isValidMediaKey, publicMediaUrl } from "./mediaKey.js";
import { mutationsEnabled } from "./mutations.js";
import { canaryEnvAllows, isCanaryUpload } from "./canary.js";
import { batchEnvAllows, findBatchTarget } from "./batch.js";

/* ファイル1件の上限（10MB）。実運用では圧縮後 100〜300KB なので、これは保険。 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/* リクエスト全体の上限（12MB）。multipart の区切り文字などの分だけ余裕をとる。 */
export const MAX_REQUEST_BYTES = 12 * 1024 * 1024;

/* 画像そのものに付けるキャッシュ設定。
   キーに中身のハッシュが入っているので、内容が変われば必ずキーも変わる。
   だから1年キャッシュしても「古い画像が出続ける」ことは起きない。 */
export const IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";

export async function handleUpload(request, env){
  /* --- 1. メソッド --- */
  if (request.method !== "POST") return jsonError("METHOD_NOT_ALLOWED", "POST");

  /* --- 1-2. 非常停止スイッチ ---
     R2 のバインディングを見るより前に判定します。
     止まっているときは、保管庫に1回も触りません。

     ふつうの許可（fullyAllowed）が開いていないときでも、
     細い道が開いていれば、続きへ進みます。細い道は2本あります。
       ・canary … 見本の1枚だけを通す道
       ・batch  … 残り49件（名簿）だけを通す道
     本当にその画像かは、**中身を読んでから**確かめます（下の 11-2）。
     2本は同時に開きません（canary は canary フラグ "true"、
     batch は同フラグ "false" を条件にしているため）。
     どれも閉じていれば、ここで本体を読まずに断ります。 */
  const fullyAllowed = mutationsEnabled(env);
  const canaryAllowed = canaryEnvAllows(env);
  const batchAllowed = batchEnvAllows(env);
  if (!fullyAllowed && !canaryAllowed && !batchAllowed) return jsonError("MUTATIONS_DISABLED");

  /* --- 2. Content-Type --- */
  const contentType = normalizeDeclaredType(request.headers.get("content-type"));
  if (contentType !== "multipart/form-data") return jsonError("BAD_CONTENT_TYPE");

  /* --- 3. 申告サイズによる事前拒否（本体を読む前に切る） --- */
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return jsonError("TOO_LARGE");
  }

  /* --- 4. 本体の読み取り --- */
  let form;
  try {
    form = await request.formData();
  } catch {
    /* 壊れた multipart など。中身は返さない。 */
    return jsonError("BAD_REQUEST");
  }

  /* --- 5. file が**ちょうど1個**か ---
     `form.get("file")` は複数あっても先頭だけを返します。
     余分を黙って捨てると「何を受け取ったか」が曖昧になるので、
     **0個も2個以上も断ります**（1個のときだけ先へ進みます）。 */
  const files = form.getAll("file");
  if (files.length !== 1) return jsonError("NO_FILE");

  const file = files[0];
  if (!file || typeof file.arrayBuffer !== "function") return jsonError("NO_FILE");

  /* --- 6. 空ファイル・サイズ超過（申告値での一次判定） --- */
  if (typeof file.size === "number") {
    if (file.size === 0) return jsonError("EMPTY_FILE");
    if (file.size > MAX_UPLOAD_BYTES) return jsonError("TOO_LARGE");
  }

  /* --- 7. 実際のバイト列で再判定（申告値は信用しない） --- */
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return jsonError("BAD_REQUEST");
  }
  if (bytes.byteLength === 0) return jsonError("EMPTY_FILE");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return jsonError("TOO_LARGE");

  /* --- 8. マジックバイトで種類を判定（SVG・HTML・JS偽装はここで落ちる） --- */
  const sniffed = sniffImageType(bytes);
  if (!sniffed) return jsonError("INVALID_FILE_TYPE");

  /* --- 9. 申告 Content-Type と食い違わないか ---
     "application/octet-stream" は「種類が分からないデータ」という意味の
     既定値なので、申告なしと同じ扱いにする（判定結果を採用する）。 */
  const declaredType = normalizeDeclaredType(file.type);
  const hasDeclaration = declaredType && declaredType !== "application/octet-stream";
  if (hasDeclaration && declaredType !== sniffed.mime) return jsonError("MIME_MISMATCH");

  /* --- 10. category を固定リストで検証 --- */
  const category = form.get("category");
  if (!isAllowedCategory(category)) return jsonError("INVALID_CATEGORY");

  /* --- 11. 保存先のキーを決める（ブラウザからは受け取りません） ---

     ふつうの経路と canary は、これまでどおり `buildMediaKey()` が
     `media/{置き場所}/{いまの年}/{いまの月}/{指紋16桁}.{拡張子}` を作ります。

     batch だけは違います。**現在日時を使いません。**
     実バイトから求めた4つ組（置き場所・種類・大きさ・指紋）で
     名簿の1件を特定し、**その entry.key をそのまま保存先にします**。
     こうしないと、月をまたいだ瞬間に同じ画像が別のキーになり、
     名簿と一致しなくなります（＝いつ実行しても結果が同じになる）。 */
  let key;
  if (batchAllowed) {
    /* 一致するのが**ちょうど1件**のときだけ通ります。
       0件でも2件以上でも null が返り、**R2 に触れる前に**断ります。 */
    const target = await findBatchTarget(bytes, sniffed.mime, category);
    if (!target) return jsonError("NOT_IN_BATCH");
    key = target.key;
  } else {
    try {
      key = await buildMediaKey(bytes, category, sniffed.ext);
    } catch {
      return jsonError("INTERNAL");
    }
  }
  if (!isValidMediaKey(key)) return jsonError("INTERNAL");

  /* --- 11-2. canary の抜け道で来た場合は、本当に見本の1枚かを確かめる ---
     ここまでの key は **実際のバイト列の SHA-256** から Worker が作ったものです。
     ブラウザの申告は一切使っていません。
     少しでも違えば、**R2 に触れる前に**断ります。

     batch はキーを決める時点で名簿と突き合わせ済みなので、ここは通りません
     （3つの道は同時に開かないため、ここへ来るのは canary のときだけです）。 */
  if (!fullyAllowed && canaryAllowed) {
    const isCanary = await isCanaryUpload(bytes, sniffed.mime, key);
    if (!isCanary) return jsonError("NOT_THE_CANARY");
  }

  /* --- 12. R2 へ保存 --- */
  const bucket = env && env.MEDIA_BUCKET;
  if (!bucket || typeof bucket.put !== "function" || typeof bucket.head !== "function") {
    console.error("メディア保管庫のバインディングが見つかりません");
    return jsonError("R2_ERROR");
  }

  let deduped = false;
  try {
    /* 同じ内容なら同じキーになる。既にあれば保存しない（重複排除） */
    const existing = await bucket.head(key);
    if (existing) {
      deduped = true;
    } else {
      await bucket.put(key, bytes, {
        httpMetadata: {
          contentType: sniffed.mime,
          cacheControl: IMAGE_CACHE_CONTROL
        }
      });
    }
  } catch {
    /* 例外の中身はログにもレスポンスにも出さない（内部情報の漏えい防止） */
    console.error("メディアの保存に失敗しました");
    return jsonError("R2_ERROR");
  }

  const body = {
    ok: true,
    key,
    url: publicMediaUrl(env, key),
    size: bytes.byteLength,
    contentType: sniffed.mime
  };
  if (deduped) body.deduped = true;

  return jsonOk(body, deduped ? 200 : 201);
}
