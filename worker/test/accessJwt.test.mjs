/* ================================================================
   Phase 4.5 ― Cloudflare Access の通行証（JWT）検証のテスト

   本物の Cloudflare には接続しません。
   ・鍵はこのテストの中で作ります（Node 標準の crypto.subtle）
   ・公開鍵の取得（JWKS）は偽物に差し替えます
   → ネットワークにいっさい出ません。
   ================================================================ */
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import {
  readAccessConfig, verifyAccessJwt, normalizeEmail, resetAccessKeyCache, CLOCK_SKEW_SECONDS
} from "../src/lib/accessJwt.js";

const TEAM = "example-team.cloudflareaccess.com";
const AUD = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const EMAIL = "someone@example.invalid";
const CFG = { teamDomain: TEAM, aud: AUD, emails: [EMAIL] };
const NOW = 1_800_000_000;   /* テストの中の「いま」（秒） */

/* ---- base64url ---- */
const toB64url = bytes =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jsonToB64url = obj => toB64url(new TextEncoder().encode(JSON.stringify(obj)));

/* ---- 鍵を作る（毎回作ると遅いので使い回す） ---- */
async function makeKeyPair(kid){
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, priv: pair.privateKey, jwk: { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", use: "sig", kid } };
}

const KEY_A = await makeKeyPair("key-a");
const KEY_B = await makeKeyPair("key-b");

/** 通行証を組み立てる */
async function makeToken({
  key = KEY_A, header = {}, payload = {}, signWith = null, tamper = false
} = {}){
  const h = { alg: "RS256", typ: "JWT", kid: key.kid, ...header };
  const p = {
    iss: `https://${TEAM}`,
    aud: AUD,
    email: EMAIL,
    iat: NOW - 10,
    nbf: NOW - 10,
    exp: NOW + 3600,
    ...payload
  };
  const input = `${jsonToB64url(h)}.${jsonToB64url(p)}`;
  const sig = new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", (signWith || key).priv, new TextEncoder().encode(input)));
  if (tamper) sig[0] = sig[0] ^ 0xFF;
  return `${input}.${toB64url(sig)}`;
}

/** 偽の JWKS 取得。呼ばれた回数と、返す鍵を差し替えられる。 */
function makeJwks(keys){
  let current = keys;
  const state = { calls: 0, fail: false };
  const impl = async () => {
    state.calls++;
    if (state.fail) throw new Error("network down");
    return { ok: true, json: async () => ({ keys: current.map(k => k.jwk) }) };
  };
  impl.state = state;
  impl.setKeys = k => { current = k; };
  return impl;
}

const verify = (token, opts = {}) => {
  resetAccessKeyCache();
  return verifyAccessJwt(token, CFG, { now: NOW, fetch: makeJwks([KEY_A]), ...opts });
};

/* ================================================================
   1. 設定の読み取り（設定不足なら通さない）
   ================================================================ */

test("設定がそろっていれば読み取れる", () => {
  const cfg = readAccessConfig({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAIL: EMAIL });
  assert.deepEqual(cfg, { teamDomain: TEAM, aud: AUD, emails: [EMAIL] });
});

test("設定が1つでも欠けたら null（＝通さない）", () => {
  const full = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAIL: EMAIL };
  for (const k of Object.keys(full)) {
    const v = { ...full }; delete v[k];
    assert.equal(readAccessConfig(v), null, `${k} が無いのに通っています`);
    assert.equal(readAccessConfig({ ...full, [k]: "" }), null, `${k} が空なのに通っています`);
    assert.equal(readAccessConfig({ ...full, [k]: "   " }), null, `${k} が空白だけなのに通っています`);
  }
  assert.equal(readAccessConfig({}), null);
  assert.equal(readAccessConfig(null), null);
});

test("チームの住所は cloudflareaccess.com のものしか受け付けない", () => {
  const base = { ACCESS_AUD: AUD, ALLOWED_EMAIL: EMAIL };
  for (const bad of [
    "evil.example.com",
    "example-team.cloudflareaccess.com.evil.com",
    "https://example-team.cloudflareaccess.com",
    "example-team.cloudflareaccess.com/path",
    "../example-team.cloudflareaccess.com",
    "cloudflareaccess.com",
    "-bad.cloudflareaccess.com",
    "example team.cloudflareaccess.com"
  ]) {
    assert.equal(readAccessConfig({ ...base, ACCESS_TEAM_DOMAIN: bad }), null, bad);
  }
  /* 大文字で書かれていても、小文字にそろえて受け入れる */
  assert.ok(readAccessConfig({ ...base, ACCESS_TEAM_DOMAIN: "Example-Team.CloudflareAccess.com" }));
});

test("メールアドレスは前後の空白と大文字小文字を吸収する", () => {
  assert.equal(normalizeEmail("  SomeOne@Example.INVALID  "), "someone@example.invalid");
  assert.equal(normalizeEmail(null), "");
  const cfg = readAccessConfig({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAIL: " SomeOne@Example.INVALID " });
  assert.deepEqual(cfg.emails, [EMAIL]);
});

test("複数の管理者メールを正規化して読み込める", () => {
  const cfg = readAccessConfig({
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ALLOWED_EMAILS: " SomeOne@Example.INVALID, second@example.invalid "
  });
  assert.deepEqual(cfg.emails, [EMAIL, "second@example.invalid"]);
});

test("ALLOWED_EMAILS がある場合は旧 ALLOWED_EMAIL を許可一覧へ混ぜない", () => {
  const cfg = readAccessConfig({
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ALLOWED_EMAILS: "second@example.invalid",
    ALLOWED_EMAIL: EMAIL
  });
  assert.deepEqual(cfg.emails, ["second@example.invalid"]);
});

test("管理者メール一覧の空要素・重複・過大件数は fail closed", () => {
  const base = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
  assert.equal(readAccessConfig({ ...base, ALLOWED_EMAILS: `${EMAIL},` }), null);
  assert.equal(readAccessConfig({ ...base, ALLOWED_EMAILS: `${EMAIL},${EMAIL.toUpperCase()}` }), null);
  assert.equal(readAccessConfig({
    ...base,
    ALLOWED_EMAILS: Array.from({ length: 51 }, (_, i) => `admin${i}@example.invalid`).join(",")
  }), null);
});

test("設定が無ければ、通行証が正しくても通さない", async () => {
  const token = await makeToken();
  const r = await verifyAccessJwt(token, null, { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "NO_CONFIG");
});

/* ================================================================
   2. 正しい通行証
   ================================================================ */

test("正しい通行証は通る", async () => {
  const r = await verify(await makeToken());
  assert.equal(r.ok, true);
  assert.equal(r.email, EMAIL);
});

test("複数管理者許可一覧の2人目も署名検証後に通る", async () => {
  const token = await makeToken({ payload: { email: "second@example.invalid" } });
  resetAccessKeyCache();
  const r = await verifyAccessJwt(token,
    { teamDomain: TEAM, aud: AUD, emails: [EMAIL, "second@example.invalid"] },
    { now: NOW, fetch: makeJwks([KEY_A]) });
  assert.equal(r.ok, true);
  assert.equal(r.email, "second@example.invalid");
});

test("aud が配列でも、その中に入っていれば通る", async () => {
  const r = await verify(await makeToken({ payload: { aud: ["ほかのアプリ", AUD] } }));
  assert.equal(r.ok, true);
});

test("メールの大文字小文字・前後の空白が違っても通る", async () => {
  const r = await verify(await makeToken({ payload: { email: "  SomeOne@Example.INVALID " } }));
  assert.equal(r.ok, true);
});

test("nbf / iat が無くても通る（任意の項目）", async () => {
  const r = await verify(await makeToken({ payload: { nbf: undefined, iat: undefined } }));
  assert.equal(r.ok, true);
});

/* ================================================================
   3. 署名まわり
   ================================================================ */

test("RS256 以外の alg は拒否する", async () => {
  for (const alg of ["none", "HS256", "RS512", "ES256", "PS256", "", null, 256]) {
    const r = await verify(await makeToken({ header: { alg } }));
    assert.equal(r.ok, false, String(alg));
    assert.equal(r.reason, "BAD_ALG", String(alg));
  }
});

test("alg を none にして署名を空にしても通らない", async () => {
  const h = jsonToB64url({ alg: "none", typ: "JWT", kid: KEY_A.kid });
  const p = jsonToB64url({ iss: `https://${TEAM}`, aud: AUD, email: EMAIL, exp: NOW + 3600 });
  resetAccessKeyCache();
  const r = await verifyAccessJwt(`${h}.${p}.`, CFG, { now: NOW, fetch: makeJwks([KEY_A]) });
  assert.equal(r.ok, false);
});

test("知らない kid は拒否する", async () => {
  const r = await verify(await makeToken({ header: { kid: "知らない鍵" } }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "UNKNOWN_KID");
});

test("kid が無い通行証は拒否する", async () => {
  for (const kid of [undefined, "", null, 123]) {
    const r = await verify(await makeToken({ header: { kid } }));
    assert.equal(r.ok, false, String(kid));
    assert.equal(r.reason, "NO_KID", String(kid));
  }
});

test("署名を1バイトでも書き換えたら拒否する", async () => {
  const r = await verify(await makeToken({ tamper: true }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "BAD_SIGNATURE");
});

test("別の鍵で署名したものは拒否する", async () => {
  /* kid は key-a と名乗りつつ、実際は key-b で署名したもの */
  const token = await makeToken({ key: KEY_A, signWith: KEY_B });
  const r = await verify(token);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "BAD_SIGNATURE");
});

test("中身を書き換えたら署名が合わなくなる", async () => {
  const token = await makeToken();
  const [h, , s] = token.split(".");
  const evil = jsonToB64url({ iss: `https://${TEAM}`, aud: AUD, email: "evil@example.invalid", exp: NOW + 3600 });
  const r = await verify(`${h}.${evil}.${s}`);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "BAD_SIGNATURE");
});

/* ================================================================
   4. 中身の確認
   ================================================================ */

test("iss は完全一致でなければ拒否する", async () => {
  for (const iss of [
    `http://${TEAM}`,
    `https://${TEAM}/`,
    `https://${TEAM}/x`,
    "https://evil.example.com",
    `https://evil.com/https://${TEAM}`,
    "", null, undefined
  ]) {
    const r = await verify(await makeToken({ payload: { iss } }));
    assert.equal(r.ok, false, String(iss));
    assert.equal(r.reason, "BAD_ISS", String(iss));
  }
});

test("aud が違えば拒否する", async () => {
  for (const aud of ["ちがうアプリ", "", null, undefined, [], ["a", "b"], 12345, [12345], { a: 1 }]) {
    const r = await verify(await makeToken({ payload: { aud } }));
    assert.equal(r.ok, false, JSON.stringify(aud));
    assert.equal(r.reason, "BAD_AUD", JSON.stringify(aud));
  }
});

test("aud の部分一致では通らない", async () => {
  const r = await verify(await makeToken({ payload: { aud: AUD.slice(0, 32) } }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "BAD_AUD");
});

test("期限切れは拒否する（時計のずれは少しだけ許す）", async () => {
  const expired = await verify(await makeToken({ payload: { exp: NOW - CLOCK_SKEW_SECONDS - 1 } }));
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "EXPIRED");

  /* ぎりぎり許される範囲 */
  const edge = await verify(await makeToken({ payload: { exp: NOW - CLOCK_SKEW_SECONDS + 1 } }));
  assert.equal(edge.ok, true, "時計のずれの許容が効いていません");
});

test("exp が無い・数値でないものは拒否する", async () => {
  for (const exp of [undefined, null, "9999999999", {}, []]) {
    const r = await verify(await makeToken({ payload: { exp } }));
    assert.equal(r.ok, false, String(exp));
    assert.equal(r.reason, "NO_EXP", String(exp));
  }
});

test("まだ使えない通行証（nbf が未来）は拒否する", async () => {
  const r = await verify(await makeToken({ payload: { nbf: NOW + CLOCK_SKEW_SECONDS + 10 } }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "NOT_YET");
  /* ずれの範囲内なら通る */
  const ok = await verify(await makeToken({ payload: { nbf: NOW + CLOCK_SKEW_SECONDS - 10 } }));
  assert.equal(ok.ok, true);
});

test("発行時刻が未来すぎる通行証は拒否する", async () => {
  const r = await verify(await makeToken({ payload: { iat: NOW + CLOCK_SKEW_SECONDS + 10 } }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "BAD_IAT");
  const ok = await verify(await makeToken({ payload: { iat: NOW + CLOCK_SKEW_SECONDS - 10 } }));
  assert.equal(ok.ok, true);
});

test("許可していないメールアドレスは拒否する", async () => {
  for (const email of [
    "other@example.invalid",
    "someone@example.invalid.evil.com",
    "someone@example",
    "", null, undefined,
    "someone@example.invalid ", /* 空白は吸収されるので、これは通る想定外の値ではない */
  ]) {
    const r = await verify(await makeToken({ payload: { email } }));
    if (email === "someone@example.invalid ") { assert.equal(r.ok, true); continue; }
    assert.equal(r.ok, false, String(email));
  }
});

test("メールが無い通行証は拒否する", async () => {
  const r = await verify(await makeToken({ payload: { email: undefined } }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "NO_EMAIL");
});

/* ================================================================
   5. かたちがおかしい通行証
   ================================================================ */

test("形が正しくない通行証は拒否する", async () => {
  for (const token of [
    "", "abc", "a.b", "a.b.c.d", "..", "a..c", ".b.c", "a.b.",
    "!!!.???.###",
    "eyJhbGciOiJSUzI1NiJ9",
    null, undefined, 123, {}, [],
    "x".repeat(9000)
  ]) {
    const r = await verify(token);
    assert.equal(r.ok, false, JSON.stringify(token));
  }
});

test("ヘッダや中身が JSON でなければ拒否する", async () => {
  const notJson = toB64url(new TextEncoder().encode("これはJSONではありません"));
  const good = jsonToB64url({ alg: "RS256", typ: "JWT", kid: KEY_A.kid });
  assert.equal((await verify(`${notJson}.${notJson}.AAAA`)).reason, "MALFORMED");
  assert.equal((await verify(`${good}.${notJson}.AAAA`)).reason, "MALFORMED");
});

test("ヘッダや中身が配列でも拒否する", async () => {
  const arr = jsonToB64url([1, 2, 3]);
  const good = jsonToB64url({ alg: "RS256", typ: "JWT", kid: KEY_A.kid });
  assert.equal((await verify(`${arr}.${arr}.AAAA`)).reason, "MALFORMED");
  assert.equal((await verify(`${good}.${arr}.AAAA`)).reason, "MALFORMED");
});

test("typ が JWT 以外なら拒否する", async () => {
  const r = await verify(await makeToken({ header: { typ: "JWE" } }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "BAD_TYP");
});

/* ================================================================
   6. 公開鍵の取得（JWKS）
   ================================================================ */

test("公開鍵が取れなければ拒否する（通信の失敗）", async () => {
  const jwks = makeJwks([KEY_A]);
  jwks.state.fail = true;
  const r = await verify(await makeToken(), { fetch: jwks });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "JWKS_UNAVAILABLE");
});

test("公開鍵の応答がおかしければ拒否する", async () => {
  const bad = [
    async () => ({ ok: false, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => ({ keys: [] }) }),
    async () => ({ ok: true, json: async () => ({ keys: "鍵じゃない" }) }),
    async () => { throw new Error("boom"); }
  ];
  const token = await makeToken();
  for (const f of bad) {
    const r = await verify(token, { fetch: f });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "JWKS_UNAVAILABLE");
  }
});

test("公開鍵は覚えておいて、毎回は取りに行かない", async () => {
  resetAccessKeyCache();
  const jwks = makeJwks([KEY_A]);
  const token = await makeToken();
  for (let i = 0; i < 5; i++) {
    const r = await verifyAccessJwt(token, CFG, { now: NOW, nowMs: 1_000_000, fetch: jwks });
    assert.equal(r.ok, true);
  }
  assert.equal(jwks.state.calls, 1, "毎回取りに行っています");
});

test("覚えている時間を過ぎたら取り直す", async () => {
  resetAccessKeyCache();
  const jwks = makeJwks([KEY_A]);
  const token = await makeToken();
  await verifyAccessJwt(token, CFG, { now: NOW, nowMs: 1_000_000, fetch: jwks });
  assert.equal(jwks.state.calls, 1);
  /* 11分後 */
  await verifyAccessJwt(token, CFG, { now: NOW, nowMs: 1_000_000 + 11 * 60 * 1000, fetch: jwks });
  assert.equal(jwks.state.calls, 2);
});

test("鍵が入れ替わったら取り直して、新しい鍵で通る", async () => {
  resetAccessKeyCache();
  const jwks = makeJwks([KEY_A]);
  const tokenA = await makeToken({ key: KEY_A });
  await verifyAccessJwt(tokenA, CFG, { now: NOW, nowMs: 1_000_000, fetch: jwks });
  assert.equal(jwks.state.calls, 1);

  /* Cloudflare 側の鍵が B に入れ替わった */
  jwks.setKeys([KEY_B]);
  const tokenB = await makeToken({ key: KEY_B });
  /* 取り直しの最短間隔（30秒）を過ぎてから */
  const r = await verifyAccessJwt(tokenB, CFG, { now: NOW, nowMs: 1_000_000 + 31_000, fetch: jwks });
  assert.equal(r.ok, true, "鍵の入れ替えに追随できていません");
  assert.ok(jwks.state.calls >= 2);
});

test("知らない kid が来ても、取り直しを繰り返しすぎない", async () => {
  resetAccessKeyCache();
  const jwks = makeJwks([KEY_A]);
  const bad = await makeToken({ header: { kid: "知らない鍵" } });
  await verifyAccessJwt(bad, CFG, { now: NOW, nowMs: 1_000_000, fetch: jwks });
  const after = jwks.state.calls;
  /* すぐもう一度（30秒未満）来ても、取りに行かない */
  await verifyAccessJwt(bad, CFG, { now: NOW, nowMs: 1_000_000 + 1_000, fetch: jwks });
  assert.equal(jwks.state.calls, after, "短い間隔で取りに行っています");
});

/* ================================================================
   7. Worker 全体としてのふるまい
   ================================================================ */

test("正しい通行証があれば、ステージングでも通れる", async () => {
  resetAccessKeyCache();
  /* Worker 本体は「本当のいまの時刻」で見るので、通行証も実時刻で作る */
  const real = Math.floor(Date.now() / 1000);
  const token = await makeToken({ payload: { iat: real - 10, nbf: real - 10, exp: real + 3600 } });
  /* JWKS の取得だけ差し替える（ネットワークに出さないため） */
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ keys: [KEY_A.jwk] }) });
  try {
    const env = {
      ENVIRONMENT: "staging",
      STAGING_LOCKED: "false",
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD: AUD,
      ALLOWED_EMAIL: EMAIL,
      ASSETS: { fetch: async () => new Response("static asset", { status: 200 }) }
    };
    const res = await worker.fetch(
      new Request("http://localhost:8787/api/health",
        { headers: { "cf-access-jwt-assertion": token } }), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.environment, "staging");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("断るときに、理由を外に返さない", async () => {
  const env = {
    ENVIRONMENT: "staging",
    STAGING_LOCKED: "false",
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ALLOWED_EMAIL: EMAIL,
    ASSETS: { fetch: async () => new Response("static asset") }
  };
  const res = await worker.fetch(new Request("http://localhost:8787/"), env, {});
  const text = await res.text();
  for (const leak of ["NO_TOKEN", "BAD_SIGNATURE", "UNKNOWN_KID", "JWKS", "cloudflareaccess",
                      EMAIL, AUD, TEAM, "kid", "email"]) {
    assert.equal(text.includes(leak), false, `理由や設定が漏れています: ${leak}`);
  }
});
