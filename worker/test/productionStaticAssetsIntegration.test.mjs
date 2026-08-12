/* Real Wrangler/Static Assets regression test for production public URLs.
   The server is local-only and the generated config contains no remote bindings. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = dirname(TEST_DIR);
const WRANGLER = join(WORKER_DIR, "node_modules", "wrangler", "bin", "wrangler.js");
const WORKER_ENTRY = join(WORKER_DIR, "src", "index.js");
const PUBLIC_SOURCE = join(WORKER_DIR, "public-site", "index.html");

async function freePort(){
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  await new Promise(resolveClose => server.close(resolveClose));
  return address.port;
}

async function waitForServer(url, child, output){
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Wrangler exited before ready (${child.exitCode})\n${output()}`);
    }
    try {
      const response = await fetch(url, { redirect: "manual" });
      return response;
    } catch {
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
  }
  throw new Error(`Wrangler did not become ready\n${output()}`);
}

async function follow(url, method = "GET", limit = 5){
  const history = [];
  let current = new URL(url);
  for (let index = 0; index <= limit; index++) {
    const response = await fetch(current, { method, redirect: "manual" });
    const location = response.headers.get("location");
    history.push({ url: current.href, status: response.status, location });
    if (!location || response.status < 300 || response.status >= 400) {
      return { response, history };
    }
    current = new URL(location, current);
  }
  throw new Error(`redirect limit exceeded: ${JSON.stringify(history)}`);
}

async function stop(child){
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise(resolveExit => child.once("exit", resolveExit)),
    new Promise(resolveWait => setTimeout(resolveWait, 5_000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitForPortClosed(port){
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const open = await new Promise(resolveOpen => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolveOpen(true); });
      socket.once("error", () => resolveOpen(false));
    });
    if (!open) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`local Wrangler port ${port} did not close`);
}

test("production PUBLIC root avoids the Static Assets canonical redirect loop", { timeout: 45_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "eruremo-public-routing-"));
  const assetsDir = join(root, "assets");
  const configPath = join(root, "wrangler.jsonc");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let logs = "";
  let child;

  t.after(async () => {
    if (child) await stop(child);
    await waitForPortClosed(port);
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  await mkdir(assetsDir, { recursive: true });
  await copyFile(PUBLIC_SOURCE, join(assetsDir, "index.html"));
  await writeFile(configPath, JSON.stringify({
    name: "eruremo-public-routing-integration-test",
    main: resolve(WORKER_ENTRY),
    compatibility_date: "2026-08-01",
    assets: {
      directory: resolve(assetsDir),
      binding: "ASSETS",
      run_worker_first: true
    },
    vars: {
      ENVIRONMENT: "production",
      PUBLIC_HOST: "127.0.0.1",
      ADMIN_HOST: "admin.example.invalid",
      PUBLIC_MEDIA_BASE_URL: "",
      MEDIA_MUTATIONS_ENABLED: "false",
      MIGRATION_CANARY_MUTATION_ENABLED: "false",
      MIGRATION_BATCH_MUTATION_ENABLED: "false"
    }
  }, null, 2), "utf8");

  child = spawn(process.execPath, [
    WRANGLER, "dev", "--local", "--config", configPath,
    "--ip", "127.0.0.1", "--port", String(port),
    "--log-level", "error", "--show-interactive-dev-session", "false"
  ], {
    cwd: WORKER_DIR,
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: "false",
      NO_UPDATE_NOTIFIER: "1",
      CLOUDFLARE_API_TOKEN: ""
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", chunk => { logs += chunk.toString(); });
  child.stderr.on("data", chunk => { logs += chunk.toString(); });
  await waitForServer(`${base}/`, child, () => logs);

  const expected = createHash("sha256").update(await readFile(PUBLIC_SOURCE)).digest("hex");

  const getRoot = await follow(`${base}/`);
  assert.deepEqual(getRoot.history.map(({ status, location }) => ({ status, location })), [
    { status: 200, location: null }
  ]);
  const rootBytes = Buffer.from(await getRoot.response.arrayBuffer());
  assert.equal(createHash("sha256").update(rootBytes).digest("hex"), expected);

  const getIndex = await follow(`${base}/index.html`);
  assert.deepEqual(getIndex.history.map(({ status, location }) => ({ status, location })), [
    { status: 307, location: "/" },
    { status: 200, location: null }
  ]);
  const indexBytes = Buffer.from(await getIndex.response.arrayBuffer());
  assert.equal(createHash("sha256").update(indexBytes).digest("hex"), expected);

  const headRoot = await follow(`${base}/`, "HEAD");
  assert.deepEqual(headRoot.history.map(({ status, location }) => ({ status, location })), [
    { status: 200, location: null }
  ]);

  const headIndex = await follow(`${base}/index.html`, "HEAD");
  assert.deepEqual(headIndex.history.map(({ status, location }) => ({ status, location })), [
    { status: 307, location: "/" },
    { status: 200, location: null }
  ]);

  for (const path of [
    "/admin", "/admin/", "/admin/index.html",
    "/api", "/api/health", "/api/media", "/api/media/upload", "/api/media/item"
  ]) {
    const response = await fetch(`${base}${path}`, { redirect: "manual" });
    assert.equal(response.status, 404, path);
  }

  assert.doesNotMatch(logs, /\bERROR\b/i);
});
