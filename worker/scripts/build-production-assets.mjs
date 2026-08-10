/* ================================================================
   Build the production Static Assets directory without duplicating sources.

   Source of truth:
     <project-root>/eruremo_SiteManager.html  -> /admin/index.html
     worker/public-site/index.html            -> /index.html

   worker/production-assets/ is generated and gitignored. Only these two exact
   HTML files are copied, so repository files and local secrets cannot be swept
   into a production deployment by a broad directory copy.
   ================================================================ */
import { copyFile, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, basename, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKER_DIR = dirname(SCRIPT_DIR);
const DEFAULT_REPO_DIR = dirname(DEFAULT_WORKER_DIR);

async function requireRegularHtml(path, label){
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new Error(`${label} が見つかりません。`);
  }
  if (!info.isFile()) throw new Error(`${label} は通常ファイルである必要があります。`);
  const text = await readFile(path, "utf8");
  if (!/<!doctype\s+html/i.test(text) || !/<html(?:\s|>)/i.test(text)) {
    throw new Error(`${label} は完全な HTML ではありません。`);
  }
  return text;
}

function requireSafeOutput(workerDir, outputDir){
  const worker = resolve(workerDir);
  const output = resolve(outputDir);
  const rel = relative(worker, output);
  if (!rel || rel.startsWith("..") || resolve(worker, rel) !== output) {
    throw new Error("production asset の出力先が worker 配下ではありません。");
  }
  if (basename(output) !== "production-assets") {
    throw new Error("production asset の出力先名が正しくありません。");
  }
  return output;
}

export async function buildProductionAssets(options = {}){
  const workerDir = resolve(options.workerDir || DEFAULT_WORKER_DIR);
  const repoDir = resolve(options.repoDir || DEFAULT_REPO_DIR);
  const editorSource = resolve(options.editorSource || join(repoDir, "eruremo_SiteManager.html"));
  const publicIndex = resolve(options.publicIndex || join(workerDir, "public-site", "index.html"));
  const outputDir = requireSafeOutput(workerDir, options.outputDir || join(workerDir, "production-assets"));
  const tempDir = join(workerDir, `production-assets.tmp-${process.pid}-${Date.now()}`);

  const editorHtml = await requireRegularHtml(editorSource, "SiteManager 本体");
  const publicHtml = await requireRegularHtml(publicIndex, "一般公開用 index.html");
  if (!editorHtml.includes("えるれも サイトエディタ") || !editorHtml.includes('id="btnDownload"')) {
    throw new Error("SiteManager 本体の識別表示が見つかりません。");
  }
  if (publicHtml.includes('id="btnDownload"') || publicHtml.includes("えるれも サイトエディタ")) {
    throw new Error("一般公開用 index.html に SiteManager が混入しています。");
  }

  await rm(tempDir, { recursive: true, force: true });
  try {
    await mkdir(join(tempDir, "admin"), { recursive: true });
    await copyFile(publicIndex, join(tempDir, "index.html"));
    await copyFile(editorSource, join(tempDir, "admin", "index.html"));

    await rm(outputDir, { recursive: true, force: true });
    await rename(tempDir, outputDir);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  return {
    outputDir,
    publicIndex: join(outputDir, "index.html"),
    adminIndex: join(outputDir, "admin", "index.html")
  };
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  try {
    await buildProductionAssets();
    console.log("production assets を作成しました。");
    console.log("  /index.html       : 一般公開サイト");
    console.log("  /admin/index.html : Access 保護下の SiteManager");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "production assets の作成に失敗しました。");
    process.exitCode = 1;
  }
}
