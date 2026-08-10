/* ================================================================
   編集ツール本体を worker/public/ へコピーする（ローカル開発用）

   なぜコピーするのか：
     ブラウザは「同じ住所（オリジン）どうし」でないと通信をさせません
     （CORS／コルス＝別の住所への通信を制限する仕組み）。
     編集ツールを file:///D:/... で開いたままだと、住所が
     http://127.0.0.1:8787 の API とは別物なので、アップロードが
     ブロックされます。

     旧内部開発ルール §5 の決まりどおり、CORS の穴を開けて回避するのではなく、
     編集ツールを Worker と同じ住所から配信して解決します。

   大事なこと：
     - コピー先は .gitignore 済みです。Git に入る本体は 1つだけで、
       二重管理にはなりません。
     - 本体を編集したら、このコピーをやり直す必要があります
       （`npm run dev` を実行し直せば自動でコピーされます）。
     - このコピーは本番へ持っていきません。productionでは別の安全なbuild工程が、
       ルートの本体を production-assets/admin/index.html へコピーします。
   ================================================================ */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));   // worker/scripts
const workerDir = dirname(here);                        // worker
const repoDir = dirname(workerDir);                     // リポジトリの根

const FILE_NAME = "eruremo_SiteManager.html";
const src = join(repoDir, FILE_NAME);
const publicDir = join(workerDir, "public");
const dest = join(publicDir, FILE_NAME);

if (!existsSync(src)) {
  console.error(`編集ツール本体が見つかりません: ${FILE_NAME}`);
  console.error("リポジトリの構成が想定と違う可能性があります。");
  process.exit(1);
}

if (!existsSync(publicDir)) mkdirSync(publicDir, { recursive: true });

copyFileSync(src, dest);

const kb = Math.round(statSync(dest).size / 1024);
console.log(`編集ツールをコピーしました（${kb.toLocaleString()} KB）`);
console.log(`  ブラウザで開く: http://127.0.0.1:8787/${FILE_NAME}`);
console.log("  ※ 本体を編集したら `npm run dev` をやり直してください。");
