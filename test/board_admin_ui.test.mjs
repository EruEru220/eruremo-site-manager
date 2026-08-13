import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html=fs.readFileSync(new URL("../eruremo_SiteManager.html",import.meta.url),"utf8");
const start=html.indexOf("function boardManagerEl(){");
const end=html.indexOf("/* ================================================================",start);
const ui=html.slice(start,end);

test("ADMIN掲示板管理は設定ヘルプと独立したセクションである",()=>{
  assert.ok(start>0);
  assert.match(html,/boardHelp:true, boardManage:true/);
  assert.match(html,/if\(s\.boardManage\) paneEl\.appendChild\(boardManagerEl\(\)\)/);
  for(const text of ["掲示板管理","公開中","削除済み","再読み込み","もっと見る"])assert.ok(ui.includes(text),text);
});

test("一覧はADMIN専用APIをstatus・limit・cursor付きで取得する",()=>{
  assert.match(ui,/new URLSearchParams\(\{status,limit:"50"\}\)/);
  assert.match(ui,/q\.set\("cursor",state\.cursor\)/);
  assert.match(ui,/fetch\(`\/api\/admin\/board\/posts\?\$\{q\}`/);
  assert.match(ui,/credentials:"same-origin"/);
  assert.match(ui,/cache:"no-store"/);
});

test("paginationはID重複を除外しタブごとにstateを分離する",()=>{
  assert.match(ui,/active:\{posts:\[\],ids:new Set\(\),cursor:null,loaded:false\}/);
  assert.match(ui,/deleted:\{posts:\[\],ids:new Set\(\),cursor:null,loaded:false\}/);
  assert.match(ui,/if\(!state\.ids\.has\(post\.id\)\)/);
  assert.match(ui,/state\.cursor=data\.nextCursor/);
  assert.match(ui,/if\(!states\[current\]\.loaded\)await loadStatus\(current,true\)/);
});

test("投稿値はDOM text nodeだけで描画しinnerHTMLへ渡さない",()=>{
  assert.equal(ui.includes("innerHTML"),false);
  assert.match(ui,/elm\("p","board-admin-post-body",post\.body\)/);
  assert.match(ui,/elm\("code",null,post\.id\)/);
  assert.match(ui,/validPost\(post,status\)/);
});

test("削除は確認後に正しいUUIDへbodyなしで1回だけ送る",()=>{
  const confirmAt=ui.indexOf("if(!confirm(");
  const fetchAt=ui.indexOf("fetch(`/api/admin/board/posts/${encodeURIComponent(post.id)}`");
  assert.ok(confirmAt>0&&fetchAt>confirmAt);
  assert.match(ui,/if\(deleting\)return/);
  assert.match(ui,/method:"DELETE"/);
  assert.equal(/method:"DELETE"[^}]*body:/s.test(ui),false);
});

test("削除成功を確認するまで投稿を一覧から除外しない",()=>{
  const verified=ui.indexOf("data?.ok!==true||data.id!==post.id");
  const removed=ui.indexOf("state.posts=state.posts.filter");
  assert.ok(verified>0&&removed>verified);
  assert.match(ui,/states\.deleted=\{posts:\[\],ids:new Set\(\),cursor:null,loaded:false\}/);
  assert.match(ui,/await loadStatus\("deleted",true\)/);
});

test("削除失敗は404・403・その他を区別して投稿を保持する",()=>{
  for(const text of ["すでに削除済み、または見つかりません。","権限を確認してください。","投稿を削除できませんでした。時間をおいて再度確認してください。"] )assert.ok(ui.includes(text),text);
  assert.equal((ui.match(/state\.posts=state\.posts\.filter/g)||[]).length,1);
});

test("読み込み・空・error状態とaria-liveを備える",()=>{
  for(const text of ["読み込み中…","投稿はありません","投稿一覧を読み込めませんでした"] )assert.ok(ui.includes(text),text);
  assert.match(ui,/setAttribute\("aria-live","polite"\)/);
  assert.match(ui,/setAttribute\("aria-busy"/);
  assert.match(ui,/setAttribute\("role","tablist"\)/);
});

test("投稿ID全文と対象内容を削除確認へ表示する",()=>{
  assert.match(ui,/ID: \$\{post\.id\}/);
  assert.match(ui,/名前: \$\{post\.name\}/);
  assert.match(ui,/本文: \$\{preview\}/);
});

test("狭い画面でも管理カードが横overflowしないCSSを持つ",()=>{
  assert.match(html,/\.board-admin-post-body\{[^}]*overflow-wrap:anywhere/);
  assert.match(html,/\.board-admin-post code\{[^}]*word-break:break-all/);
  assert.match(html,/@media\(max-width:700px\)\{\.board-admin/);
});
