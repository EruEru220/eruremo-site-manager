/* Production asset build: public output and SiteManager must never be mixed. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildProductionAssets } from "../scripts/build-production-assets.mjs";

const PUBLIC_HTML = '<!doctype html><html lang="ja"><title>Public</title><body>PUBLIC SITE</body></html>';
const ADMIN_HTML = '<!doctype html><html lang="ja"><title>えるれも サイトエディタ</title><body><button id="btnDownload">save</button></body></html>';

async function fixture(){
  const root = await mkdtemp(join(tmpdir(), "eruremo-production-assets-"));
  const repoDir = join(root, "repo");
  const workerDir = join(repoDir, "worker");
  const publicDir = join(workerDir, "public-site");
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(repoDir, "eruremo_SiteManager.html"), ADMIN_HTML, "utf8");
  await writeFile(join(publicDir, "index.html"), PUBLIC_HTML, "utf8");
  return { root, repoDir, workerDir, publicDir };
}

test("production buildはpublic indexとSiteManagerを別パスへコピーする", async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const result = await buildProductionAssets({ repoDir: f.repoDir, workerDir: f.workerDir });
  assert.equal(await readFile(result.publicIndex, "utf8"), PUBLIC_HTML);
  assert.equal(await readFile(result.adminIndex, "utf8"), ADMIN_HTML);
});

test("production buildは指定した2つのHTML以外を配信物へ混ぜない", async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(join(f.publicDir, "secret.txt"), "do not copy", "utf8");
  await writeFile(join(f.workerDir, ".dev.vars"), "SECRET=value", "utf8");
  const result = await buildProductionAssets({ repoDir: f.repoDir, workerDir: f.workerDir });
  assert.deepEqual((await readdir(result.outputDir)).sort(), ["admin", "index.html"]);
  assert.deepEqual(await readdir(join(result.outputDir, "admin")), ["index.html"]);
});

test("一般公開用indexが無ければproduction buildはfail closed", async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await rm(join(f.publicDir, "index.html"));
  await assert.rejects(
    buildProductionAssets({ repoDir: f.repoDir, workerDir: f.workerDir }),
    /一般公開用 index\.html が見つかりません/
  );
});

test("一般公開用indexにSiteManagerが混入していれば拒否する", async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(join(f.publicDir, "index.html"), ADMIN_HTML, "utf8");
  await assert.rejects(
    buildProductionAssets({ repoDir: f.repoDir, workerDir: f.workerDir }),
    /SiteManager が混入/
  );
});

test("production-assets以外の出力先は拒否する", async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await assert.rejects(
    buildProductionAssets({
      repoDir: f.repoDir,
      workerDir: f.workerDir,
      outputDir: join(f.workerDir, "public")
    }),
    /出力先名が正しくありません/
  );
});
