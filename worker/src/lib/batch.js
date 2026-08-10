/* ================================================================
   残り49件だけを通す、もう一本の細い道（batch ゲート）

   なぜ要るのか：
     見本の1枚（canary）は送り終わりました。残りは49件です。
     この49件を送るために `MEDIA_MUTATIONS_ENABLED` を "true" にすると、
     **ふつうのアップロードも削除も全部**開いてしまいます。
     それは避けたいので、canary と同じ考え方で
     「決めておいた49件だけ」を通す道を、もう一本だけ用意します。

   通す条件（**4つぜんぶ**が文字列として完全一致したときだけ）：
     1. ENVIRONMENT                        が ちょうど "staging"
     2. MEDIA_MUTATIONS_ENABLED            が ちょうど "false"
     3. MIGRATION_CANARY_MUTATION_ENABLED  が ちょうど "false"
     4. MIGRATION_BATCH_MUTATION_ENABLED   が ちょうど "true"

     未設定・空文字・大文字小文字違い・前後の空白・打ちまちがいは
     **すべて禁止側**に倒します（大文字小文字も空白も吸収しません）。

     3 を「"false" の完全一致」にしているのは、
     **canary の道と batch の道が同時に開くことを構造的にありえなくする**ためです。
     どちらか一方しか開きません（batchAndCanaryNeverBothOpen をテストで固定）。

   通す中身の条件（**ぜんぶ**満たしたときだけ）：
     ・置き場所（category）が名簿と完全一致
     ・マジックバイトから判定した種類が名簿と完全一致
     ・大きさ（バイト数）が名簿と完全一致
     ・**実際のバイト列から計算した SHA-256** が名簿と完全一致

   ★ 保存先のキーは「名簿の1件」から取ります（**現在日時を使いません**）

     ふつうのアップロードは `buildMediaKey()` が
     `media/{置き場所}/{いまの年}/{いまの月}/{指紋16桁}.{拡張子}` を作ります。
     この作り方だと、**同じ画像でも送る月が変わればキーが変わります**。
     名簿のキーは 2026/08 で固定なので、9月に送ると1件も一致しなくなります。

     そこで batch では、現在日時からキーを作るのをやめ、
     **実バイトから求めた4つの値で名簿の1件を特定し、その entry.key を使います。**
     こうすると、いつ実行しても結果がまったく同じになります。

   ★ 一致するのが「ちょうど1件」のときだけ通します

     0件はもちろん、**2件以上でも通しません**（「最初の1件を使う」はしません）。
     万一 同じ4つ組の entry が2件ある名簿ができてしまっても、
     その4つ組は**引けなくなる**だけで、取り違えは起こりません。
     （そもそも生成スクリプトが、そんな名簿は作らずに止まります）

   大事なこと：
     ・ブラウザが名乗ってきた key / sha256 / size は**一切信用しません**。
       ブラウザから key を受け取る場所は、そもそもありません。
     ・**見本の1枚（canary）は、この道では絶対に通しません。**
       名簿からも機械的に除いてありますが、念のためキーでも弾きます。
     ・**削除はこの道では絶対に開きません。**
       削除は `MEDIA_MUTATIONS_ENABLED` だけを見ます（mediaDelete.js）。
     ・名簿に無い「51件目」も絶対に通りません。
   ================================================================ */
import { BATCH_ALLOWLIST } from "./batchAllowlist.generated.js";
import { CANARY, sha256Hex } from "./canary.js";

/** 名簿に載っている件数（一覧50件 − 見本の1枚） */
export const BATCH_EXPECTED_COUNT = 49;

/**
 * 名簿の1件を見分けるための「4つ組」を、1本の文字列にする。
 * 区切りに改行を使うのは、どの値にも改行が入りえないためです
 * （置き場所は固定リスト、種類は image/… 、大きさは数、指紋は16進）。
 */
export function compositeOf({ category, contentType, size, sha256 }){
  return [category, contentType, size, sha256].join("\n");
}

/**
 * 名簿から、引くための索引を作る。
 *
 * 同じ4つ組が2件以上あったら、**その4つ組は索引から取り除きます**
 * （引けなくする＝fail closed）。取り除いたものは duplicates に残すので、
 * テストから「本当に1件も重複していないか」を確かめられます。
 *
 * ここで例外を投げないのは、読み出し（GET /media/…）や疎通確認まで
 * 巻き添えで止めないためです。**書き込みだけが静かに閉じます。**
 */
export function buildBatchIndex(list){
  const byKey = new Map();
  const byComposite = new Map();
  const duplicates = new Set();

  for (const e of list) {
    if (byKey.has(e.key)) duplicates.add("key:" + e.key);
    byKey.set(e.key, e);

    const c = compositeOf(e);
    if (byComposite.has(c)) duplicates.add(c);
    byComposite.set(c, e);
  }
  /* 重複していた4つ組は、引けないようにする（最初の1件を使わない） */
  for (const c of duplicates) byComposite.delete(c);

  return { byKey, byComposite, duplicates };
}

/* 読み込み時に1回だけ索引を作る */
const BATCH_INDEX = buildBatchIndex(BATCH_ALLOWLIST);

/** 名簿に、同じ4つ組・同じキーの重複が1つも無いか */
export const BATCH_INDEX_IS_UNIQUE = BATCH_INDEX.duplicates.size === 0;

const BY_KEY = BATCH_INDEX.byKey;

/**
 * 環境の設定として、この道を使ってよいか。
 * **4つとも文字列そのものが一致したときだけ**開きます。
 */
export function batchEnvAllows(env){
  if (!env) return false;
  if (env.ENVIRONMENT !== "staging") return false;
  if (env.MEDIA_MUTATIONS_ENABLED !== "false") return false;
  if (env.MIGRATION_CANARY_MUTATION_ENABLED !== "false") return false;
  if (env.MIGRATION_BATCH_MUTATION_ENABLED !== "true") return false;
  return true;
}

/** 名簿から1件を引く。無ければ null。 */
export function batchEntryFor(key){
  if (typeof key !== "string") return null;
  return BY_KEY.get(key) || null;
}

/**
 * 送られてきたものが名簿のどの1件かを特定し、その entry を返す。
 * 見つからなければ null。**現在日時は一切使いません。**
 *
 * 使うのは、Worker が自分で調べた4つだけです。
 *   ・category    … 固定リストで検証済みのもの
 *   ・contentType … マジックバイト（中身の先頭）から判定したもの
 *   ・size        … 実際に受け取ったバイト数
 *   ・sha256      … 実際のバイト列から計算したもの
 * ブラウザの申告（key / sha256 / size）は1つも使いません。
 *
 * @param {Uint8Array} bytes     実際に受け取ったバイト列
 * @param {string}     mime      マジックバイトから判定した種類
 * @param {string}     category  検証済みの置き場所
 * @param {object}     index     索引（既定は名簿から作ったもの。テスト用に差し替え可）
 * @returns {Promise<object|null>} 名簿の1件、または null
 */
export async function findBatchTarget(bytes, mime, category, index = BATCH_INDEX){
  if (!(bytes instanceof Uint8Array)) return null;
  if (typeof mime !== "string" || typeof category !== "string") return null;
  if (!index || !(index.byComposite instanceof Map)) return null;

  let sha256;
  try {
    sha256 = await sha256Hex(bytes);
  } catch {
    return null;
  }

  /* 4つ組がちょうど一致する1件だけを引く。
     重複していた4つ組は索引から外してあるので、ここでは引けません。 */
  const entry = index.byComposite.get(
    compositeOf({ category, contentType: mime, size: bytes.byteLength, sha256 }));
  if (!entry) return null;

  /* 引けた1件が、本当に4つとも一致しているかを、もう一度確かめる */
  if (entry.category !== category) return null;
  if (entry.contentType !== mime) return null;
  if (entry.size !== bytes.byteLength) return null;
  if (entry.sha256 !== sha256) return null;

  /* 見本の1枚は、この道では絶対に通さない */
  if (entry.key === CANARY.key) return null;
  return entry;
}

/**
 * 送られてきたものが、名簿の49件のうちのちょうど1件かを確かめる。
 * **申告ではなく、実際のバイト列から計算して**判断します。
 *
 * こちらは「このキーの画像で合っているか」を確かめる用です。
 * 保存先のキーを決めるのは findBatchTarget のほうです。
 *
 * @param {Uint8Array} bytes     実際に受け取ったバイト列
 * @param {string}     mime      マジックバイトから判定した種類
 * @param {string}     key       確かめたいキー
 * @param {string}     category  受け取った置き場所
 * @returns {Promise<boolean>}
 */
export async function isBatchUpload(bytes, mime, key, category){
  if (!(bytes instanceof Uint8Array)) return false;

  /* 見本の1枚は、この道では絶対に通さない */
  if (key === CANARY.key) return false;

  const entry = batchEntryFor(key);
  if (!entry) return false;

  const found = await findBatchTarget(bytes, mime, category);
  return found === entry;
}
