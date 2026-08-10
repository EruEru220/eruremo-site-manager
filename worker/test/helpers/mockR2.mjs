/* ================================================================
   本物の R2 の代わりに使う「偽バケット」

   メモリ（Map）の上で動くだけの、数十行のニセモノです。
   本物と同じ put() / head() / get() / delete() を持ちます。

   これを使うことで：
   - Cloudflare にログインしない
   - 本物の R2 に1バイトも書き込まない
   - ネットワークに一切出ない
   - 外部パッケージも要らない
   状態でテストできます。
   ================================================================ */

export function createMockR2(options = {}){
  const store = new Map();
  const calls = { put: [], head: [], get: [], delete: [], list: [] };

  /* 保存に失敗する状況を再現したいとき用 */
  const failOn = options.failOn || null; /* "put" | "head" | "get" | "delete" | "list" | null */

  return {
    /* テストから中身を覗くための入口（本物には無い） */
    _store: store,
    _calls: calls,
    get size(){ return store.size; },

    async put(key, value, opts){
      calls.put.push({ key, opts });
      if (failOn === "put") throw new Error("mock R2 put failure: bucket=secret-bucket-name");
      const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(value);
      store.set(key, {
        key,
        size: bytes.byteLength,
        bytes,
        httpMetadata: (opts && opts.httpMetadata) || {},
        uploaded: new Date()
      });
      return { key, size: bytes.byteLength };
    },

    async head(key){
      calls.head.push({ key });
      if (failOn === "head") throw new Error("mock R2 head failure: bucket=secret-bucket-name");
      const o = store.get(key);
      return o ? { key: o.key, size: o.size, httpMetadata: o.httpMetadata } : null;
    },

    async get(key){
      calls.get.push({ key });
      if (failOn === "get") throw new Error("mock R2 get failure: bucket=secret-bucket-name");
      const o = store.get(key);
      /* arrayBuffer() は必ずその画像の分だけを返す（本物と同じ振る舞い） */
      return o ? { ...o, arrayBuffer: async () => o.bytes.slice().buffer } : null;
    },

    async delete(key){
      calls.delete.push({ key });
      if (failOn === "delete") throw new Error("mock R2 delete failure: bucket=secret-bucket-name");
      store.delete(key);
    },

    /* 本物の R2 の list() と同じ形を返す。
       cursor（続きの目印）は「最後に返したキーを base64 にしたもの」で代用する。 */
    async list(options){
      calls.list.push({ options });
      if (failOn === "list") throw new Error("mock R2 list failure: bucket=secret-bucket-name");
      const opts = options || {};
      const prefix = typeof opts.prefix === "string" ? opts.prefix : "";
      const limit = typeof opts.limit === "number" ? opts.limit : 1000;
      const keys = [...store.keys()].filter(k => k.startsWith(prefix)).sort();

      let start = 0;
      if (opts.cursor) {
        const after = Buffer.from(String(opts.cursor), "base64").toString("utf8");
        const i = keys.indexOf(after);
        start = i < 0 ? keys.length : i + 1;
      }
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      const result = {
        objects: page.map(k => {
          const o = store.get(k);
          return { key: o.key, size: o.size, uploaded: o.uploaded, httpMetadata: o.httpMetadata };
        }),
        truncated
      };
      if (truncated && page.length) {
        result.cursor = Buffer.from(page[page.length - 1], "utf8").toString("base64");
      }
      return result;
    }
  };
}

/* テスト用の env（本番の値は一切入れない）

   MEDIA_MUTATIONS_ENABLED は「ふつうに設定された環境」を表すため "true" にします。
   **止まっている場合の確認は mutations.test.mjs が明示的に上書きして行います。** */
export function createTestEnv(bucket, overrides = {}){
  return {
    MEDIA_BUCKET: bucket,
    ENVIRONMENT: "local",
    MEDIA_MUTATIONS_ENABLED: "true",
    PUBLIC_MEDIA_BASE_URL: "https://example.invalid",
    /* 静的アセットのバインディングのニセモノ */
    ASSETS: { fetch: async () => new Response("static asset", { status: 200 }) },
    ...overrides
  };
}
