/* ================================================================
   ERUREMO メディアAPI ― Cloudflare Worker の入口

   管理画面（静的ファイル）と API を、ひとつの Worker が同じ住所で出します。
   同じ住所（同一オリジン）にしておくと、CORS（コルス／別ドメインへの
   アクセス制限の仕組み）の設定が要らないため、設定ミスによる穴が生まれません。

     /                      → public/ の中のファイル（管理画面・編集ツール）
     /api/health            → 疎通確認
     /api/media/upload      → 画像アップロード
     /api/media             → 保管庫の画像一覧（Phase 4）
     /api/media/item        → 画像を1枚だけ消す（Phase 4・DELETE のみ）
     /media/…               → 保存した画像の読み出し

   ローカルでは、wrangler.jsonc の "run_worker_first" に書いたパスだけが
   このコードに来ます。それ以外は public/ の静的ファイルがそのまま返ります。
   ステージングでは "run_worker_first": true にしてあるので、
   **すべてのリクエストが必ずここを通ります**（門番を素通りさせないため）。
   ================================================================ */
import { jsonOk, jsonError } from "./lib/http.js";
import { handleUpload } from "./lib/upload.js";
import { handleMediaRead } from "./lib/mediaRead.js";
import { handleMediaList } from "./lib/mediaList.js";
import { handleMediaDelete } from "./lib/mediaDelete.js";
import { checkAccess } from "./lib/accessJwt.js";

/* ================================================================
   Phase 4.5 ― ローカル以外は必ず守る門番

   考え方（迷ったら閉じる）：
     門番を**外す**のは、ENVIRONMENT が **ちょうど "local"** のときだけです。
     "staging" はもちろん、未設定・打ちまちがい・知らない値のときも
     すべて門番が働きます。

   なぜ「staging のときだけ守る」にしないのか：
     それだと ENVIRONMENT を書き忘れたり "stagin" と打ちまちがえたりした
     瞬間に、**門番が丸ごと外れて誰でも入れる状態**になります。
     守る側を既定にしておけば、書きまちがえても「入れなくなる」だけで済みます。

   ローカル開発（wrangler.jsonc の ENVIRONMENT: "local"）は
   今までどおり、ログインなしでそのまま使えます。
   ================================================================ */

/** ログインなしで使ってよい環境か（ちょうど "local" のときだけ） */
export function isLocalEnv(env){
  return String((env && env.ENVIRONMENT) || "") === "local";
}

/** 門番が働くか（ローカル以外はすべて働く） */
export function isGuardedEnv(env){
  return !isLocalEnv(env);
}

/**
 * 仮の蓋が閉まっているか。
 * **"false" という文字列のとき以外はすべて「閉まっている」**とみなします
 * （未設定・空文字・打ちまちがいも閉まっている扱い＝迷ったら閉じる）。
 */
export function isStagingLocked(env){
  const raw = env && env.STAGING_LOCKED;
  if (raw === undefined || raw === null) return true;
  return String(raw).trim().toLowerCase() !== "false";
}

export default {
  async fetch(request, env, ctx){
    /* --- 門番。ここが**いちばん最初**であることが大事。
           静的ファイル（管理画面そのもの）より先に通します。

           断るときの返事は、**どの理由でも まったく同じ**にします。
           そうしないと「いまロック中なのか、認証待ちなのか」が
           外から見分けられてしまうためです。 --- */
    if (isGuardedEnv(env)) {
      /* ① 仮の蓋。Access の設定が終わるまで、誰にも何も見せない。 */
      if (isStagingLocked(env)) {
        console.error("公開前のロック中です");
        return jsonError("FORBIDDEN");
      }
      /* ③ 通行証（Cloudflare Access の JWT）の確認。
             設定が足りないときも通しません。理由は外に返しません。 */
      const seen = await checkAccess(request, env);
      if (!seen || seen.ok !== true) return jsonError("FORBIDDEN");
    }

    let path;
    try {
      path = new URL(request.url).pathname;
    } catch {
      return jsonError("BAD_REQUEST");
    }
    /* 末尾のスラッシュを落とす（"/api/health/" も同じ扱いにする） */
    if (path.length > 1) path = path.replace(/\/+$/, "") || "/";

    const isApi = path === "/api" || path.startsWith("/api/");
    const isMedia = path === "/media" || path.startsWith("/media/");

    /* 画像の読み出し。API とは別系統（返すのは JSON ではなく画像そのもの）。 */
    if (isMedia) {
      try {
        return await handleMediaRead(request, path, env);
      } catch {
        console.error("予期しないエラーが発生しました");
        return jsonError("INTERNAL");
      }
    }

    /* API でも画像でもなければ静的ファイルへ。
       通常は run_worker_first の設定によりここへ来ないが、念のための保険。 */
    if (!isApi) {
      if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
        return env.ASSETS.fetch(request);
      }
      return jsonError("NOT_FOUND");
    }

    try {
      if (path === "/api/health") return handleHealth(request, env);
      if (path === "/api/media/upload") return await handleUpload(request, env);
      if (path === "/api/media") return await handleMediaList(request, env);
      if (path === "/api/media/item") return await handleMediaDelete(request, env);
      return jsonError("NOT_FOUND");
    } catch {
      /* 予期しない失敗。内部の情報は一切外に出さない。 */
      console.error("予期しないエラーが発生しました");
      return jsonError("INTERNAL");
    }
  }
};

/* 疎通確認。R2 には触らない（存在確認だけでも課金対象の操作を増やさないため）。 */
function handleHealth(request, env){
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonError("METHOD_NOT_ALLOWED", "GET, HEAD");
  }
  return jsonOk({
    ok: true,
    service: "eruremo-media-api",
    environment: String((env && env.ENVIRONMENT) || "unknown")
  });
}
