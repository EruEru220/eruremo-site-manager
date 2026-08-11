/* ================================================================
   Phase A - production public/admin host separation

   No Cloudflare, network, or real R2 is used. Access verification is injected
   only into the test-created Worker; the deployed default export keeps the real
   JWT verifier.
   ================================================================ */
import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalHostname,
  classifyProductionHost,
  createWorker,
  readProductionHosts
} from "../src/index.js";
import { createMockR2 } from "./helpers/mockR2.mjs";

const PUBLIC = "www.example.com";
const ADMIN = "admin.example.com";
const MEDIA_KEY = "media/gallery/2026/08/0123456789abcdef.png";
const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function productionEnv(bucket, overrides = {}){
  const assetCalls = [];
  const env = {
    ENVIRONMENT: "production",
    PUBLIC_HOST: PUBLIC,
    ADMIN_HOST: ADMIN,
    PUBLIC_MEDIA_BASE_URL: "",
    MEDIA_MUTATIONS_ENABLED: "false",
    MEDIA_BUCKET: bucket,
    ASSETS: {
      fetch: async request => {
        const path = new URL(request.url).pathname;
        assetCalls.push({ path, method: request.method });
        if (path === "/admin/index.html") {
          return Response.redirect(`https://${ADMIN}/admin/`, 307);
        }
        const content = path === "/index.html" ? "PUBLIC INDEX"
          : path === "/admin/" ? "ADMIN SITE MANAGER"
          : `ADMIN ASSET ${path}`;
        return new Response(request.method === "HEAD" ? null : content, {
          status: 200,
          headers: { "x-test-asset": path }
        });
      }
    },
    ...overrides
  };
  env._assetCalls = assetCalls;
  return env;
}

const request = (host, path = "/", init) => new Request(`https://${host}${path}`, init);
const allowedAccess = async () => ({ ok: true, email: "admin@example.invalid" });
const deniedAccess = async () => ({ ok: false, reason: "NO_TOKEN" });

test("production hostname は小文字・末尾ドットを正規化する", () => {
  assert.equal(canonicalHostname(" WWW.Example.COM. "), PUBLIC);
  assert.equal(canonicalHostname("admin.example.com"), ADMIN);
});

test("scheme・port・path・wildcard を hostname 設定として受け付けない", () => {
  for (const value of ["https://www.example.com", "www.example.com:443", "www.example.com/x",
                       "*.example.com", "www..example.com", "-www.example.com", ""]) {
    assert.equal(canonicalHostname(value), null, value);
  }
});

test("PUBLIC_HOST と ADMIN_HOST が同じ設定は fail closed", () => {
  assert.equal(readProductionHosts({ PUBLIC_HOST: PUBLIC, ADMIN_HOST: PUBLIC }), null);
  assert.equal(readProductionHosts({ PUBLIC_HOST: PUBLIC, ADMIN_HOST: "" }), null);
});

test("host は完全一致だけで分類し、suffix を許可しない", () => {
  const env = productionEnv(createMockR2());
  assert.equal(classifyProductionHost(request(PUBLIC), env), "public");
  assert.equal(classifyProductionHost(request(ADMIN), env), "admin");
  assert.equal(classifyProductionHost(request(`${PUBLIC}.attacker.invalid`), env), "unknown");
  assert.equal(classifyProductionHost(request(`not-${ADMIN}`), env), "unknown");
});

test("Host系headerではURL hostnameのPUBLIC/ADMIN判定を上書きできない", async () => {
  const env = productionEnv(createMockR2());
  let accessCalls = 0;
  const worker = createWorker({ accessCheck: async () => { accessCalls++; return allowedAccess(); } });
  const spoofedPublic = await worker.fetch(request(PUBLIC, "/admin/", {
    headers: { host: ADMIN, "x-forwarded-host": ADMIN, forwarded: `host=${ADMIN}` }
  }), env);
  assert.equal(spoofedPublic.status, 404);
  assert.equal(accessCalls, 0);
  assert.equal(env._assetCalls.length, 0);

  const spoofedUnknown = await worker.fetch(request("unknown.example.com", "/", {
    headers: { host: PUBLIC, "x-forwarded-host": PUBLIC }
  }), env);
  assert.equal(spoofedUnknown.status, 404);
  assert.equal(env._assetCalls.length, 0);
});

test("PUBLIC HOSTはAccess verifierを呼ばず匿名GETを返す", async () => {
  const env = productionEnv(createMockR2());
  let accessCalls = 0;
  const worker = createWorker({ accessCheck: async () => { accessCalls++; return deniedAccess(); } });
  const res = await worker.fetch(request(PUBLIC, "/"), env);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "PUBLIC INDEX");
  assert.equal(accessCalls, 0);
});

test("PUBLIC GET / は public index だけを返す", async () => {
  const env = productionEnv(createMockR2());
  const worker = createWorker({ accessCheck: () => { throw new Error("PUBLIC must not check Access"); } });
  const res = await worker.fetch(request(PUBLIC), env);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "PUBLIC INDEX");
  assert.deepEqual(env._assetCalls, [{ path: "/index.html", method: "GET" }]);
});

test("PUBLIC HEAD / は public index のHEADとして処理する", async () => {
  const env = productionEnv(createMockR2());
  const res = await createWorker().fetch(request(PUBLIC, "/", { method: "HEAD" }), env);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "");
  assert.deepEqual(env._assetCalls, [{ path: "/index.html", method: "HEAD" }]);
});

test("PUBLIC GET/HEAD /index.html を許可する", async () => {
  const env = productionEnv(createMockR2());
  const worker = createWorker();
  for (const method of ["GET", "HEAD"]) {
    const res = await worker.fetch(request(PUBLIC, "/index.html", { method }), env);
    assert.equal(res.status, 200, method);
  }
  assert.deepEqual(env._assetCalls.map(x => x.path), ["/index.html", "/index.html"]);
});

test("PUBLIC GET/HEAD /media/* は production R2 を読み出す", async () => {
  const bucket = createMockR2();
  await bucket.put(MEDIA_KEY, PNG, {});
  const env = productionEnv(bucket);
  const worker = createWorker();
  for (const method of ["GET", "HEAD"]) {
    const res = await worker.fetch(request(PUBLIC, `/${MEDIA_KEY}`, { method }), env);
    assert.equal(res.status, 200, method);
    assert.equal(res.headers.get("content-type"), "image/png");
  }
  assert.equal(bucket._calls.get.length, 1);
  assert.equal(bucket._calls.head.length, 1);
});

test("PUBLIC から API・admin・SiteManager・その他assetへ到達できない", async () => {
  const bucket = createMockR2();
  const env = productionEnv(bucket);
  let accessCalls = 0;
  const worker = createWorker({ accessCheck: async () => { accessCalls++; return allowedAccess(); } });
  const paths = [
    "/api", "/api/health", "/api/media", "/api/media/upload", "/api/media/item",
    "/admin", "/admin/", "/admin/index.html", "/eruremo_SiteManager.html", "/favicon.ico"
  ];
  for (const path of paths) {
    const res = await worker.fetch(request(PUBLIC, path), env);
    assert.equal(res.status, 404, path);
  }
  assert.equal(accessCalls, 0, "PUBLIC で Access を要求してはいけません");
  assert.equal(env._assetCalls.length, 0, "禁止パスを asset binding へ渡してはいけません");
  assert.equal(bucket._calls.list.length + bucket._calls.get.length, 0);
});

test("PUBLIC のGET/HEAD以外は、許可パスでも拒否する", async () => {
  const env = productionEnv(createMockR2());
  for (const [path, method] of [["/", "POST"], ["/index.html", "PUT"], [`/${MEDIA_KEY}`, "DELETE"]]) {
    const res = await createWorker().fetch(request(PUBLIC, path, { method, body: "x" }), env);
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  assert.equal(env._assetCalls.length, 0);
});

test("PUBLIC /media のpath traversal表現はR2へ到達しない", async () => {
  const bucket = createMockR2();
  const env = productionEnv(bucket);
  for (const path of ["/media/../admin/index.html", "/media/%2e%2e/admin/index.html",
                      "/media/gallery/2026/08/not-a-key.png", "/media//gallery/x.png"]) {
    const res = await createWorker().fetch(request(PUBLIC, path), env);
    assert.equal(res.status, 404, path);
  }
  assert.equal(bucket._calls.get.length + bucket._calls.head.length, 0);
});

test("ADMIN はAccessなしでは全経路403でasset・API・R2に触れない", async () => {
  const bucket = createMockR2();
  const env = productionEnv(bucket);
  let checks = 0;
  const worker = createWorker({ accessCheck: async () => { checks++; return deniedAccess(); } });
  for (const path of ["/", "/admin", "/admin/", "/admin/index.html", "/api/health",
                      "/api/media", `/${MEDIA_KEY}`, "/unknown"]) {
    const res = await worker.fetch(request(ADMIN, path), env);
    assert.equal(res.status, 403, path);
  }
  assert.equal(checks, 8);
  assert.equal(env._assetCalls.length, 0);
  assert.equal(bucket._calls.get.length + bucket._calls.head.length + bucket._calls.list.length, 0);
});

test("認証済みADMINの / と /admin は /admin/ へredirectする", async () => {
  const env = productionEnv(createMockR2());
  const worker = createWorker({ accessCheck: allowedAccess });
  for (const path of ["/", "/admin"]) {
    const res = await worker.fetch(request(ADMIN, path), env);
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get("location"), `https://${ADMIN}/admin/`);
  }
});

test("認証済みADMINの /admin/ は生成コピーのSiteManagerを返す", async () => {
  const env = productionEnv(createMockR2());
  const worker = createWorker({ accessCheck: allowedAccess });
  const res = await worker.fetch(request(ADMIN, "/admin/"), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("location"), null);
  assert.equal(await res.text(), "ADMIN SITE MANAGER");
  assert.deepEqual(env._assetCalls, [{ path: "/admin/", method: "GET" }]);
});

test("認証済みADMINの /admin/index.html はAssetsのcanonical redirectを返す", async () => {
  const env = productionEnv(createMockR2());
  const worker = createWorker({ accessCheck: allowedAccess });
  const res = await worker.fetch(request(ADMIN, "/admin/index.html"), env);
  assert.equal(res.status, 307);
  assert.equal(res.headers.get("location"), `https://${ADMIN}/admin/`);
  assert.deepEqual(env._assetCalls, [{ path: "/admin/index.html", method: "GET" }]);
});

test("認証済みADMINは /admin/* の管理assetだけを取得できる", async () => {
  const env = productionEnv(createMockR2());
  const worker = createWorker({ accessCheck: allowedAccess });
  const res = await worker.fetch(request(ADMIN, "/admin/theme.css"), env);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ADMIN ASSET /admin/theme.css");
  const noRootAsset = await worker.fetch(request(ADMIN, "/favicon.ico"), env);
  assert.equal(noRootAsset.status, 404);
});

test("認証済みADMINはhealthとmedia listを利用できる", async () => {
  const bucket = createMockR2();
  await bucket.put(MEDIA_KEY, PNG, {});
  const env = productionEnv(bucket);
  const worker = createWorker({ accessCheck: allowedAccess });

  const health = await worker.fetch(request(ADMIN, "/api/health"), env);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: "eruremo-media-api", environment: "production" });

  const list = await worker.fetch(request(ADMIN, "/api/media"), env);
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.equal(body.ok, true);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].url, `/${MEDIA_KEY}`);
  assert.equal(JSON.stringify(body).includes("admin@example.invalid"), false);
});

test("認証済みADMINはGET/HEAD /media/*を同じproduction R2から読める", async () => {
  const bucket = createMockR2();
  await bucket.put(MEDIA_KEY, PNG, {});
  const env = productionEnv(bucket);
  const worker = createWorker({ accessCheck: allowedAccess });
  for (const method of ["GET", "HEAD"]) {
    const res = await worker.fetch(request(ADMIN, `/${MEDIA_KEY}`, { method }), env);
    assert.equal(res.status, 200, method);
  }
});

test("認証済みADMINでも/media/*のGET/HEAD以外はR2へ到達しない", async () => {
  const bucket = createMockR2();
  const env = productionEnv(bucket);
  const worker = createWorker({ accessCheck: allowedAccess });
  for (const method of ["POST", "PUT", "DELETE"]) {
    const res = await worker.fetch(request(ADMIN, `/${MEDIA_KEY}`, { method }), env);
    assert.equal(res.status, 404, method);
  }
  assert.equal(bucket._calls.get.length + bucket._calls.head.length
    + bucket._calls.put.length + bucket._calls.delete.length, 0);
});

test("production mutation=falseではuploadがR2に一切触れない", async () => {
  const bucket = createMockR2();
  const env = productionEnv(bucket);
  const worker = createWorker({ accessCheck: allowedAccess });
  const res = await worker.fetch(request(ADMIN, "/api/media/upload", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=x" },
    body: "--x--"
  }), env);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "MUTATIONS_DISABLED");
  assert.equal(bucket._calls.put.length + bucket._calls.head.length, 0);
});

test("production mutation=falseではdeleteがR2に一切触れない", async () => {
  const bucket = createMockR2();
  const env = productionEnv(bucket);
  const worker = createWorker({ accessCheck: allowedAccess });
  const res = await worker.fetch(request(ADMIN, "/api/media/item", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: MEDIA_KEY })
  }), env);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "MUTATIONS_DISABLED");
  assert.equal(bucket._calls.get.length + bucket._calls.put.length + bucket._calls.delete.length, 0);
});

test("認証済みADMINでもadmin staticへの書き込みメソッドは拒否する", async () => {
  const env = productionEnv(createMockR2());
  const res = await createWorker({ accessCheck: allowedAccess }).fetch(
    request(ADMIN, "/admin/index.html", { method: "POST", body: "x" }), env);
  assert.equal(res.status, 404);
  assert.equal(env._assetCalls.length, 0);
});

test("UNKNOWN HOSTはAccess・asset・API・R2のすべてに触れずfail closed", async () => {
  const bucket = createMockR2();
  const env = productionEnv(bucket);
  let accessCalls = 0;
  const worker = createWorker({ accessCheck: async () => { accessCalls++; return allowedAccess(); } });
  for (const path of ["/", "/index.html", "/admin/", "/api/health", `/${MEDIA_KEY}`]) {
    const res = await worker.fetch(request("unknown.example.com", path), env);
    assert.equal(res.status, 404, path);
  }
  assert.equal(accessCalls, 0);
  assert.equal(env._assetCalls.length, 0);
  assert.equal(bucket._calls.get.length + bucket._calls.head.length + bucket._calls.list.length, 0);
});

test("production host設定が欠落・不正なら全リクエストfail closed", async () => {
  const bucket = createMockR2();
  for (const overrides of [
    { PUBLIC_HOST: undefined },
    { ADMIN_HOST: undefined },
    { PUBLIC_HOST: "https://www.example.com" },
    { ADMIN_HOST: PUBLIC }
  ]) {
    const env = productionEnv(bucket, overrides);
    const res = await createWorker({ accessCheck: allowedAccess }).fetch(request(PUBLIC), env);
    assert.equal(res.status, 404, JSON.stringify(overrides));
    assert.equal(env._assetCalls.length, 0);
  }
  assert.equal(bucket._calls.get.length + bucket._calls.head.length + bucket._calls.list.length, 0);
});
