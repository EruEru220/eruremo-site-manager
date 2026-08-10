/* ================================================================
   Cloudflare Access が付ける通行証（JWT）を、Worker 自身でも確かめる

   なぜ必要か（多層防御）：
     Cloudflare Access は「入口（エッジ）」で未認証のアクセスを止めます。
     ただし、設定を1か所まちがえると素通りになり得ます。
     そこで Worker 側でも通行証を確かめ、**おかしければ必ず断る**ようにします。

   大事な決まりごと：
   - **設定が1つでも欠けていたら通しません**（fail closed ＝ 迷ったら閉じる）。
     「設定し忘れたから素通り」という事故が起きない向きに倒しています。
   - 署名を確かめてから中身を見ます（中身を先に信用しない）。
   - 断る理由は外に返しません（403 とだけ返す）。
   - 外部パッケージは使いません。ブラウザ／Worker に標準の crypto.subtle だけです。

   通行証の見た目：
     ヘッダ Cf-Access-Jwt-Assertion に、ドットで区切られた3つの部分が入ります。
       ヘッダ部 . 中身部 . 署名部
     署名は RS256（RSA ＋ SHA-256）です。
     署名を確かめるための公開鍵は、次の住所から取れます。
       https://<チーム名>.cloudflareaccess.com/cdn-cgi/access/certs
   ================================================================ */

/* 公開鍵を取りに行く先の道すじ（住所の後ろに付ける） */
const CERTS_PATH = "/cdn-cgi/access/certs";

/* チームの住所として認めるかたち。
   ここを厳しくしておくと、設定を書きまちがえても
   「まったく別のサーバへ鍵を取りに行く」ことが起こりません。 */
const TEAM_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;

/* 時計のずれをどれだけ許すか（秒）。サーバ間の数十秒のずれを吸収します。 */
export const CLOCK_SKEW_SECONDS = 60;

/* 公開鍵を覚えておく時間（ミリ秒） */
const JWKS_TTL_MS = 10 * 60 * 1000;
/* 鍵が入れ替わったときの取り直しは、これより短い間隔では行わない（ミリ秒） */
const JWKS_MIN_REFETCH_MS = 30 * 1000;

const str = v => (v == null ? "" : String(v));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ALLOWED_EMAILS = 50;

function readAllowedEmails(env){
  const plural = str(env && env.ALLOWED_EMAILS).trim();
  const legacy = str(env && env.ALLOWED_EMAIL).trim();
  const rawValues = plural ? plural.split(",") : legacy ? [legacy] : [];

  if (!rawValues.length || rawValues.length > MAX_ALLOWED_EMAILS) return null;
  if (plural.length > 16_000) return null;

  const emails = [];
  const seen = new Set();
  for (const raw of rawValues) {
    const email = normalizeEmail(raw);
    if (!email || email.length > 320 || !EMAIL_RE.test(email) || seen.has(email)) return null;
    seen.add(email);
    emails.push(email);
  }
  return emails;
}

/**
 * 設定がそろっているかを見て、そろっていれば取り出す。
 * 1つでも欠けていたら null を返す（＝通さない）。
 */
export function readAccessConfig(env){
  const teamDomain = str(env && env.ACCESS_TEAM_DOMAIN).trim().toLowerCase();
  const aud        = str(env && env.ACCESS_AUD).trim();
  const emails     = readAllowedEmails(env);

  if (!TEAM_DOMAIN_RE.test(teamDomain)) return null;
  /* AUD（どのアプリ向けの通行証か）は空白を含まない適度な長さの文字列 */
  if (!aud || aud.length > 256 || /\s/.test(aud)) return null;
  /* 許可するメールアドレス（形が明らかにおかしいものは弾く） */
  if (!emails) return null;

  return { teamDomain, aud, emails };
}

/** メールアドレスの表記ゆれを吸収する（前後の空白を取り、小文字にそろえる） */
export function normalizeEmail(value){
  return str(value).trim().toLowerCase();
}

/* ---- base64url の読み取り ------------------------------------- */
function b64urlToBytes(part){
  const s = str(part).replace(/-/g, "+").replace(/_/g, "/");
  if (/[^A-Za-z0-9+/=]/.test(s)) throw new Error("bad base64url");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToJson(part){
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));
}

/* ---- 公開鍵の置き場（覚えておいて使い回す）--------------------- */
let jwksCache = { domain: "", keys: null, fetchedAt: 0 };

/** テスト用：覚えている鍵を捨てる（本番の処理では呼びません） */
export function resetAccessKeyCache(){
  jwksCache = { domain: "", keys: null, fetchedAt: 0 };
}

async function fetchJwks(teamDomain, fetchImpl){
  const f = fetchImpl || fetch;
  const res = await f(`https://${teamDomain}${CERTS_PATH}`, { headers: { accept: "application/json" } });
  if (!res || !res.ok) throw new Error("jwks fetch failed");
  const body = await res.json();
  const keys = body && Array.isArray(body.keys) ? body.keys : null;
  if (!keys || !keys.length) throw new Error("jwks empty");
  return keys;
}

/**
 * kid（鍵の名前）に合う公開鍵を探す。
 * 覚えている鍵に無ければ、鍵が入れ替わったとみなして取り直す（ただし取りすぎない）。
 */
async function findKey(teamDomain, kid, opts){
  const now = (opts && opts.nowMs) || Date.now();
  const fetchImpl = opts && opts.fetch;

  const fresh = jwksCache.domain === teamDomain
             && jwksCache.keys
             && (now - jwksCache.fetchedAt) < JWKS_TTL_MS;

  if (!fresh) {
    const keys = await fetchJwks(teamDomain, fetchImpl);
    jwksCache = { domain: teamDomain, keys, fetchedAt: now };
  }

  let hit = jwksCache.keys.find(k => k && k.kid === kid);
  if (hit) return hit;

  /* 見つからない＝鍵が入れ替わった可能性。短い間隔での取り直しは避ける。 */
  if ((now - jwksCache.fetchedAt) >= JWKS_MIN_REFETCH_MS) {
    const keys = await fetchJwks(teamDomain, fetchImpl);
    jwksCache = { domain: teamDomain, keys, fetchedAt: now };
    hit = jwksCache.keys.find(k => k && k.kid === kid);
  }
  return hit || null;
}

/* ---- 署名の確認 ------------------------------------------------ */
async function verifySignature(jwk, signingInput, signatureBytes){
  /* 鍵そのものも RS256 用でなければ受け付けない */
  if (!jwk || jwk.kty !== "RSA") return false;
  if (jwk.alg && jwk.alg !== "RS256") return false;
  if (jwk.use && jwk.use !== "sig") return false;

  let key;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
  } catch {
    return false;
  }
  try {
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", key, signatureBytes, new TextEncoder().encode(signingInput));
  } catch {
    return false;
  }
}

const deny = reason => ({ ok: false, reason });

/**
 * 通行証を確かめる。
 * @param {string} token   Cf-Access-Jwt-Assertion の中身
 * @param {object} cfg     readAccessConfig() が返したもの
 * @param {object} [opts]  now（秒）／nowMs（ミリ秒）／fetch（テスト用の差し替え）
 * @returns {{ok:true,email:string}|{ok:false,reason:string}}
 *          reason は**ログにも応答にも出しません**（テストで使うためだけ）。
 */
export async function verifyAccessJwt(token, cfg, opts = {}){
  if (!cfg) return deny("NO_CONFIG");
  if (typeof token !== "string" || !token) return deny("NO_TOKEN");
  if (token.length > 8192) return deny("TOO_LONG");

  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return deny("MALFORMED");

  let header, payload, signature;
  try {
    header = b64urlToJson(parts[0]);
    payload = b64urlToJson(parts[1]);
    signature = b64urlToBytes(parts[2]);
  } catch {
    return deny("MALFORMED");
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) return deny("MALFORMED");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return deny("MALFORMED");

  /* --- 署名の種類。RS256 以外は受け付けない（"none" 攻撃を防ぐ） --- */
  if (header.alg !== "RS256") return deny("BAD_ALG");
  if (header.typ != null && String(header.typ).toUpperCase() !== "JWT") return deny("BAD_TYP");
  if (typeof header.kid !== "string" || !header.kid) return deny("NO_KID");

  /* --- 公開鍵を探す --- */
  let jwk;
  try {
    jwk = await findKey(cfg.teamDomain, header.kid, opts);
  } catch {
    /* 鍵が取れないときは通さない */
    return deny("JWKS_UNAVAILABLE");
  }
  if (!jwk) return deny("UNKNOWN_KID");

  /* --- 署名を確かめてから、中身を見る --- */
  const okSig = await verifySignature(jwk, `${parts[0]}.${parts[1]}`, signature);
  if (!okSig) return deny("BAD_SIGNATURE");

  /* --- 発行元。完全一致のみ --- */
  if (payload.iss !== `https://${cfg.teamDomain}`) return deny("BAD_ISS");

  /* --- 宛先（aud）。文字列でも配列でもよい --- */
  const auds = Array.isArray(payload.aud) ? payload.aud
             : payload.aud == null ? []
             : [payload.aud];
  if (!auds.some(a => typeof a === "string" && a === cfg.aud)) return deny("BAD_AUD");

  /* --- 時刻 --- */
  const now = typeof opts.now === "number" ? opts.now : Math.floor(Date.now() / 1000);
  const skew = typeof opts.skew === "number" ? opts.skew : CLOCK_SKEW_SECONDS;
  if (typeof payload.exp !== "number") return deny("NO_EXP");
  if (payload.exp <= now - skew) return deny("EXPIRED");
  if (typeof payload.nbf === "number" && payload.nbf > now + skew) return deny("NOT_YET");
  if (typeof payload.iat === "number" && payload.iat > now + skew) return deny("BAD_IAT");

  /* --- 許可したメールアドレスか（大文字小文字・前後の空白を吸収） --- */
  const email = normalizeEmail(payload.email);
  if (!email) return deny("NO_EMAIL");
  if (!Array.isArray(cfg.emails) || !cfg.emails.includes(email)) return deny("BAD_EMAIL");

  return { ok: true, email };
}

/**
 * リクエストが通ってよいかを判断する。
 * 通ってよければ null、だめなら理由を伏せた 403 の材料を返す。
 */
export async function checkAccess(request, env, opts){
  const cfg = readAccessConfig(env);
  if (!cfg) {
    /* 設定が足りない＝まだ守れていない。通さない。 */
    console.error("Access の設定が足りません");
    return deny("NO_CONFIG");
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  try {
    return await verifyAccessJwt(token, cfg, opts || {});
  } catch {
    console.error("通行証の確認に失敗しました");
    return deny("INTERNAL");
  }
}
