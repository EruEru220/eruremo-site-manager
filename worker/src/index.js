/* ================================================================
   ERUREMO SiteManager / media API - Cloudflare Worker entry point

   local:
     Existing local editor, static assets, API, and local R2 behavior.

   staging:
     Every route is protected by the staging lock and Cloudflare Access.

   production:
     PUBLIC_HOST and ADMIN_HOST are deliberately separated.

       PUBLIC_HOST                ADMIN_HOST (Cloudflare Access required)
       GET/HEAD /                 GET/HEAD /admin/*
       GET/HEAD /index.html       /api/*
       GET/HEAD /media/*          GET/HEAD /media/*

   The public host never serves the editor or an admin API. Unknown hosts
   fail closed before static assets or R2 are touched.
   ================================================================ */
import { jsonOk, jsonError } from "./lib/http.js";
import { handleUpload } from "./lib/upload.js";
import { handleMediaRead } from "./lib/mediaRead.js";
import { handleMediaList } from "./lib/mediaList.js";
import { handleMediaDelete } from "./lib/mediaDelete.js";
import { checkAccess } from "./lib/accessJwt.js";

/** Only this exact environment bypasses Cloudflare Access. */
export function isLocalEnv(env){
  return String((env && env.ENVIRONMENT) || "") === "local";
}

/** Production has its own host-aware guard. Other non-local values stay guarded. */
export function isGuardedEnv(env){
  return !isLocalEnv(env);
}

export function isProductionEnv(env){
  return String((env && env.ENVIRONMENT) || "") === "production";
}

/**
 * The staging lock opens only for the string "false". Missing and malformed
 * values stay locked. Production does not use this switch; it has explicit
 * public/admin host routing and keeps mutations disabled independently.
 */
export function isStagingLocked(env){
  const raw = env && env.STAGING_LOCKED;
  if (raw === undefined || raw === null) return true;
  return String(raw).trim().toLowerCase() !== "false";
}

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;

/** Convert a hostname to the one canonical form used for comparisons. */
export function canonicalHostname(value){
  const host = String(value == null ? "" : value).trim().toLowerCase().replace(/\.$/, "");
  if (!host || !HOST_RE.test(host)) return null;
  return host;
}

/**
 * Read production host settings. Schemes, ports, paths, malformed names, and
 * identical public/admin hosts are all rejected so a bad config fails closed.
 */
export function readProductionHosts(env){
  const publicHost = canonicalHostname(env && env.PUBLIC_HOST);
  const adminHost = canonicalHostname(env && env.ADMIN_HOST);
  if (!publicHost || !adminHost || publicHost === adminHost) return null;
  return { publicHost, adminHost };
}

/** Classify only by the parsed URL hostname, never by a substring match. */
export function classifyProductionHost(request, env){
  const hosts = readProductionHosts(env);
  if (!hosts) return "unknown";
  let requestHost;
  try {
    requestHost = canonicalHostname(new URL(request.url).hostname);
  } catch {
    return "unknown";
  }
  if (requestHost === hosts.publicHost) return "public";
  if (requestHost === hosts.adminHost) return "admin";
  return "unknown";
}

function requestPath(request){
  try {
    return new URL(request.url).pathname;
  } catch {
    return null;
  }
}

function trimTrailingSlash(path){
  return path && path.length > 1 ? (path.replace(/\/+$/, "") || "/") : path;
}

function isApiPath(path){
  return path === "/api" || path.startsWith("/api/");
}

function isMediaPath(path){
  return path === "/media" || path.startsWith("/media/");
}

async function serveAsset(request, env, pathname){
  if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== "function") {
    return jsonError("NOT_FOUND");
  }
  try {
    const url = new URL(request.url);
    if (pathname) url.pathname = pathname;
    return await env.ASSETS.fetch(new Request(url, request));
  } catch {
    console.error("静的ファイルの読み出しに失敗しました");
    return jsonError("INTERNAL");
  }
}

async function serveMedia(request, path, env){
  try {
    return await handleMediaRead(request, path, env);
  } catch {
    console.error("予期しないエラーが発生しました");
    return jsonError("INTERNAL");
  }
}

async function serveApi(request, path, env){
  try {
    if (path === "/api/health") return handleHealth(request, env);
    if (path === "/api/media/upload") return await handleUpload(request, env);
    if (path === "/api/media") return await handleMediaList(request, env);
    if (path === "/api/media/item") return await handleMediaDelete(request, env);
    return jsonError("NOT_FOUND");
  } catch {
    console.error("予期しないエラーが発生しました");
    return jsonError("INTERNAL");
  }
}

async function handlePublicProduction(request, env, path){
  /* Allowlist only: public HTML and read-only media. */
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonError("NOT_FOUND");
  }
  if (path === "/" || path === "/index.html") {
    /* Keep the browser-visible path intact. Rewriting "/" to "/index.html"
       makes Static Assets canonicalize it back to "/", creating a loop. */
    return serveAsset(request, env);
  }
  if (path.startsWith("/media/")) return serveMedia(request, trimTrailingSlash(path), env);
  return jsonError("NOT_FOUND");
}

async function handleAdminProduction(request, env, path, accessCheck){
  /* Access is checked before redirects, assets, API responses, or R2 reads. */
  const identity = await accessCheck(request, env);
  if (!identity || identity.ok !== true) return jsonError("FORBIDDEN");

  /* identity.email is intentionally kept server-side. A future D1 phase can
     pass it to write handlers as the audit actor; it is not logged or returned. */

  const methodIsRead = request.method === "GET" || request.method === "HEAD";
  if (methodIsRead && (path === "/" || path === "/admin")) {
    const target = new URL(request.url);
    target.pathname = "/admin/";
    target.search = "";
    return Response.redirect(target.toString(), 302);
  }

  const normalized = trimTrailingSlash(path);
  if (path.startsWith("/media/")) {
    if (!methodIsRead) return jsonError("NOT_FOUND");
    return serveMedia(request, normalized, env);
  }
  if (isApiPath(normalized)) return serveApi(request, normalized, env);

  if (!methodIsRead || !path.startsWith("/admin/")) return jsonError("NOT_FOUND");
  return serveAsset(request, env, path);
}

async function handleProduction(request, env, accessCheck){
  const path = requestPath(request);
  if (path == null) return jsonError("BAD_REQUEST");

  const role = classifyProductionHost(request, env);
  if (role === "public") return handlePublicProduction(request, env, path);
  if (role === "admin") return handleAdminProduction(request, env, path, accessCheck);

  /* Unknown and misconfigured hosts fail closed without touching assets/R2. */
  return jsonError("NOT_FOUND");
}

async function handleLocalOrStaging(request, env, accessCheck){
  /* Existing fail-closed staging behavior. Unknown non-local environments also
     remain guarded, preserving the original typo/missing-config safety rule. */
  if (isGuardedEnv(env)) {
    if (isStagingLocked(env)) {
      console.error("公開前のロック中です");
      return jsonError("FORBIDDEN");
    }
    const identity = await accessCheck(request, env);
    if (!identity || identity.ok !== true) return jsonError("FORBIDDEN");
  }

  const rawPath = requestPath(request);
  if (rawPath == null) return jsonError("BAD_REQUEST");
  const path = trimTrailingSlash(rawPath);

  if (isMediaPath(path)) return serveMedia(request, path, env);
  if (isApiPath(path)) return serveApi(request, path, env);
  return serveAsset(request, env);
}

/**
 * Dependency injection is exported only for deterministic unit tests. The
 * deployed default export below always uses the real Cloudflare Access verifier.
 */
export function createWorker(options = {}){
  const accessCheck = typeof options.accessCheck === "function" ? options.accessCheck : checkAccess;
  return {
    async fetch(request, env, ctx){
      if (isProductionEnv(env)) return handleProduction(request, env, accessCheck);
      return handleLocalOrStaging(request, env, accessCheck);
    }
  };
}

export default createWorker();

/* Health does not touch R2. */
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
