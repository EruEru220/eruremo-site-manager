# Production public site input

SiteManager が生成した一般閲覧者向け `index.html` を、このディレクトリへ次の名前で置きます。

```text
worker/public-site/index.html
```

この `index.html` は生成物のため Git 管理外です。`npm run build:production-assets` は、次の2ファイルだけを `worker/production-assets/` へコピーします。

```text
worker/public-site/index.html       -> worker/production-assets/index.html
eruremo_SiteManager.html            -> worker/production-assets/admin/index.html
```

`worker/production-assets/` も生成物で、Git 管理外です。一般公開サイトと管理用SiteManagerを混同しないため、リポジトリ全体や `worker/public/` をproductionへコピーしないでください。

この工程はファイルを配置するだけで、Cloudflareへのdeployは行いません。
