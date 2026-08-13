import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { BOARD_STAMPS, handleBoardList, handleBoardPost, handleBoardDelete, encodeBoardCursor, decodeBoardCursor } from "../src/lib/board.js";
import { createWorker } from "../src/index.js";

const migration=fs.readFileSync(new URL("../migrations/0001_shared_board.sql",import.meta.url),"utf8");
const UUID="018f47a0-12ab-4def-8abc-0123456789ab";
async function fixture(){
  const mf=new Miniflare({modules:true,script:"export default {fetch(){return new Response('ok')}}",compatibilityDate:"2026-08-01",d1Databases:["BOARD_DB"]});
  const {BOARD_DB}=await mf.getBindings();
  await BOARD_DB.exec(migration);
  return {mf,BOARD_DB,env:{BOARD_DB,PUBLIC_HOST:"eruremo.com",ADMIN_HOST:"admin.eruremo.com",BOARD_RATE_LIMIT_SECRET:"test-rate-secret",TURNSTILE_SECRET_KEY:"test-turnstile"}};
}
const okVerify=async()=>new Response(JSON.stringify({success:true}),{headers:{"content-type":"application/json"}});
const postRequest=(body,extra={})=>new Request("https://eruremo.com/api/board/posts",{method:"POST",headers:{origin:"https://eruremo.com","content-type":"application/json","CF-Connecting-IP":"192.0.2.1",...extra},body:JSON.stringify(body)});
const valid={name:" テスト ",body:" こんにちは ",stamp:"✦",turnstileToken:"token"};

test("Worker stamp allowlist exactly matches the eight public canonical values",()=>{
  assert.deepEqual([...BOARD_STAMPS],["☕","✦","🌙","🍰","💗","🎧","🎀","🍾"]);
  assert.equal(new Set(BOARD_STAMPS).size,8);
  assert.equal(BOARD_STAMPS.includes("✨"),false);
});

test("U+2726 reaches Turnstile and D1 while U+2728 fails before all side effects",async()=>{
  const good=await fixture();
  try{
    let verifyCalls=0;
    const r=await handleBoardPost(postRequest(valid),good.env,{fetch:async()=>{verifyCalls++;return okVerify()},now:()=>1700000000000,randomUUID:()=>UUID});
    assert.equal(r.status,201);
    assert.equal(verifyCalls,1);
    assert.equal((await good.BOARD_DB.prepare("SELECT stamp FROM board_posts WHERE id=?").bind(UUID).first()).stamp,"✦");
  }finally{await good.mf.dispose()}
  const bad=await fixture();
  try{
    let verifyCalls=0;
    const r=await handleBoardPost(postRequest({...valid,stamp:"✨"}),bad.env,{fetch:async()=>{verifyCalls++;return okVerify()}});
    assert.equal(r.status,400);
    const errorBody=await r.json();
    assert.equal(errorBody.ok,false);
    assert.equal(errorBody.error.code,"BAD_REQUEST");
    assert.equal(verifyCalls,0);
    for(const table of ["board_posts","board_rate_limits","board_recent_content"]){
      assert.equal((await bad.BOARD_DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count,0,table);
    }
    assert.equal((await bad.BOARD_DB.prepare("SELECT active_count FROM board_state WHERE singleton=1").first()).active_count,0);
  }finally{await bad.mf.dispose()}
});

test("migrationは再適用でき、必要なtable/index/triggerを保持する",async()=>{const x=await fixture();try{await x.BOARD_DB.exec(migration);const rows=await x.BOARD_DB.prepare("SELECT name,type FROM sqlite_master WHERE name LIKE 'board_%' ORDER BY name").all();for(const n of ["board_posts","board_state","board_rate_limits","board_recent_content","board_posts_count_insert","board_posts_count_delete"])assert.ok(rows.results.some(r=>r.name===n),n)}finally{await x.mf.dispose()}});

test("cursorはcreated_atとUUIDだけを厳格に往復する",()=>{const c=encodeBoardCursor({created_at:123,id:UUID});assert.deepEqual(decodeBoardCursor(c),{createdAt:123,id:UUID});for(const x of ["!","WzEsXCJiYWRcIl0",Buffer.from(JSON.stringify([1,2])).toString("base64url")])assert.equal(decodeBoardCursor(x),false)});

test("GETはactiveだけを降順・30件初期・50件上限・cursor付きで返す",async()=>{const x=await fixture();try{for(let i=0;i<32;i++)await x.BOARD_DB.prepare("INSERT INTO board_posts VALUES(?,?,?,?,?,'active',NULL)").bind(`018f47a0-12ab-4def-8abc-${String(i).padStart(12,"0")}`,"n",`b${i}`,"☕",1000+i).run();await x.BOARD_DB.prepare("UPDATE board_posts SET status='deleted',deleted_at=2000 WHERE body='b31'").run();let r=await handleBoardList(new Request("https://eruremo.com/api/board/posts"),x.env);let j=await r.json();assert.equal(r.status,200);assert.equal(j.posts.length,30);assert.equal(j.posts[0].body,"b30");assert.ok(j.nextCursor);r=await handleBoardList(new Request(`https://eruremo.com/api/board/posts?limit=50&cursor=${encodeURIComponent(j.nextCursor)}`),x.env);j=await r.json();assert.equal(j.posts.length,1);for(const q of ["?limit=0","?limit=51","?cursor=bad","?x=1"])assert.equal((await handleBoardList(new Request("https://eruremo.com/api/board/posts"+q),x.env)).status,400)}finally{await x.mf.dispose()}});

test("空一覧と同時刻UUID cursor境界は欠落・重複なし",async()=>{const x=await fixture();try{let r=await handleBoardList(new Request("https://eruremo.com/api/board/posts"),x.env);assert.deepEqual(await r.json(),{ok:true,posts:[],nextCursor:null});for(let i=0;i<3;i++)await x.BOARD_DB.prepare("INSERT INTO board_posts VALUES(?,?,?,?,?,'active',NULL)").bind(`018f47a0-12ab-4def-8abc-${String(i).padStart(12,"0")}`,"n",`same${i}`,"☕",1000).run();r=await handleBoardList(new Request("https://eruremo.com/api/board/posts?limit=2"),x.env);const a=await r.json();r=await handleBoardList(new Request(`https://eruremo.com/api/board/posts?limit=2&cursor=${encodeURIComponent(a.nextCursor)}`),x.env);const b=await r.json();assert.deepEqual([...a.posts,...b.posts].map(p=>p.id),["018f47a0-12ab-4def-8abc-000000000002","018f47a0-12ab-4def-8abc-000000000001","018f47a0-12ab-4def-8abc-000000000000"])}finally{await x.mf.dispose()}});

test("POSTはTurnstile後に正規化しserver id/timeで保存する",async()=>{const x=await fixture();try{const r=await handleBoardPost(postRequest(valid),x.env,{fetch:okVerify,now:()=>1700000000000,randomUUID:()=>UUID});assert.equal(r.status,201);const j=await r.json();assert.deepEqual(j.post,{id:UUID,name:"テスト",body:"こんにちは",stamp:"✦",created_at:1700000000000});const row=await x.BOARD_DB.prepare("SELECT status FROM board_posts WHERE id=?").bind(UUID).first();assert.equal(row.status,"active")}finally{await x.mf.dispose()}});

test("production相当workerdはreceiver付きWeb Crypto UUIDでPOSTを保存する",async()=>{
  let verifyCalls=0;
  const mf=new Miniflare({
    modules:true,
    modulesRules:[{type:"ESModule",include:["**/*.js"]}],
    scriptPath:fileURLToPath(new URL("../src/index.js",import.meta.url)),
    compatibilityDate:"2026-08-01",
    d1Databases:["BOARD_DB"],
    bindings:{ENVIRONMENT:"production",PUBLIC_HOST:"eruremo.com",ADMIN_HOST:"admin.eruremo.com",BOARD_RATE_LIMIT_SECRET:"local-rate-secret",TURNSTILE_SECRET_KEY:"local-turnstile-secret",MEDIA_MUTATIONS_ENABLED:"false"},
    outboundService:async request=>{verifyCalls++;assert.equal(new URL(request.url).hostname,"challenges.cloudflare.com");return okVerify()}
  });
  try{
    const {BOARD_DB}=await mf.getBindings();
    await BOARD_DB.exec(migration);
    const r=await mf.dispatchFetch("https://eruremo.com/api/board/posts",{method:"POST",headers:{origin:"https://eruremo.com","content-type":"application/json"},body:JSON.stringify(valid)});
    assert.equal(r.status,201);
    assert.match(r.headers.get("content-type")||"",/^application\/json\b/);
    const j=await r.json();
    assert.match(j.post.id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(j.post.stamp,"✦");
    assert.equal(verifyCalls,1);
    assert.equal((await BOARD_DB.prepare("SELECT COUNT(*) AS count FROM board_posts WHERE id=? AND stamp='✦'").bind(j.post.id).first()).count,1);
    assert.equal((await BOARD_DB.prepare("SELECT active_count FROM board_state WHERE singleton=1").first()).active_count,1);
    assert.equal((await BOARD_DB.prepare("SELECT COUNT(*) AS count FROM board_rate_limits").first()).count,1);
    assert.equal((await BOARD_DB.prepare("SELECT COUNT(*) AS count FROM board_recent_content").first()).count,1);
    const listed=await mf.dispatchFetch("https://eruremo.com/api/board/posts");
    assert.equal(listed.status,200);
    const listedJson=await listed.json();
    assert.equal(listedJson.posts.length,1);
    assert.equal(listedJson.posts[0].id,j.post.id);
    assert.equal(listedJson.posts[0].stamp,"✦");
  }finally{await mf.dispose()}
});

test("production POSTの非同期rejectionは固定JSON INTERNALへ変換する",async()=>{
  const x=await fixture();
  try{
    const env={...x.env,ENVIRONMENT:"production",ASSETS:{fetch:async()=>new Response("asset")}};
    const worker=createWorker({boardDependencies:{fetch:okVerify,randomUUID:()=>{throw new Error("private sentinel")}}});
    const r=await worker.fetch(postRequest(valid),env);
    assert.equal(r.status,500);
    assert.match(r.headers.get("content-type")||"",/^application\/json\b/);
    assert.equal(r.headers.get("cache-control"),"no-store");
    const text=await r.text();
    const j=JSON.parse(text);
    assert.equal(j.error.code,"INTERNAL");
    assert.equal(/private sentinel|stack|SQL|D1/.test(text),false);
    for(const table of ["board_posts","board_rate_limits","board_recent_content"]){
      assert.equal((await x.BOARD_DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count,0,table);
    }
  }finally{await x.mf.dispose()}
});

test("POST validationはOrigin/type/size/schema/Unicode/stamp/Turnstileをfail closedにする",async()=>{const x=await fixture();try{assert.equal((await handleBoardPost(postRequest(valid,{origin:"https://evil.invalid"}),x.env,{fetch:okVerify})).status,403);assert.equal((await handleBoardPost(new Request("https://eruremo.com/api/board/posts",{method:"POST",headers:{origin:"https://eruremo.com","content-type":"text/plain"},body:"{}"}),x.env,{fetch:okVerify})).status,415);for(const bad of [{...valid,extra:1},{...valid,body:""},{...valid,body:"x".repeat(141)},{...valid,name:"x".repeat(17)},{...valid,stamp:"x"}])assert.equal((await handleBoardPost(postRequest(bad),x.env,{fetch:okVerify})).status,400);assert.equal((await handleBoardPost(postRequest(valid),x.env,{fetch:async()=>new Response('{"success":false}',{headers:{"content-type":"application/json"}})})).status,403)}finally{await x.mf.dispose()}});

test("Unicode上限はcode point単位で扱い、raw IPをschemaへ保存しない",async()=>{const x=await fixture();try{const r=await handleBoardPost(postRequest({...valid,name:"😀".repeat(16),body:"🌙".repeat(140)}),x.env,{fetch:okVerify,now:()=>1700000000000,randomUUID:()=>UUID});assert.equal(r.status,201);const schema=(await x.BOARD_DB.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name LIKE 'board_%'").all()).results.map(v=>v.sql).join("\n").toLowerCase();assert.equal(schema.includes("ip_address"),false);assert.equal(schema.includes("192.0.2.1"),false)}finally{await x.mf.dispose()}});

test("空名はななしさん、NFC、SQL/HTML文字列はbindでデータとして保持",async()=>{const x=await fixture();try{const body="<script>alert(1)</script>' OR 1=1 --";const r=await handleBoardPost(postRequest({...valid,name:" e\u0301 ",body}),x.env,{fetch:okVerify,now:()=>1700000000000,randomUUID:()=>UUID});assert.equal(r.status,201);const j=await r.json();assert.equal(j.post.name,"é");assert.equal(j.post.body,body);const x2=await fixture();try{const r2=await handleBoardPost(postRequest({...valid,name:"   ",body:"x"}),x2.env,{fetch:okVerify,now:()=>1700000000000,randomUUID:()=>UUID});assert.equal((await r2.json()).post.name,"ななしさん")}finally{await x2.mf.dispose()}}finally{await x.mf.dispose()}});

test("request bodyは4KiBちょうどを読み、超過は413",async()=>{const x=await fixture();try{const make=n=>{let token="t";for(;;){const raw=JSON.stringify({...valid,turnstileToken:token});const size=Buffer.byteLength(raw);if(size===n)return raw;if(size>n)throw new Error("size");token+="x"}};const raw=make(4096);let r=await handleBoardPost(new Request("https://eruremo.com/api/board/posts",{method:"POST",headers:{origin:"https://eruremo.com","content-type":"application/json","CF-Connecting-IP":"192.0.2.1"},body:raw}),x.env,{fetch:okVerify,now:()=>1700000000000,randomUUID:()=>UUID});assert.equal(r.status,201);r=await handleBoardPost(new Request("https://eruremo.com/api/board/posts",{method:"POST",headers:{origin:"https://eruremo.com","content-type":"application/json","content-length":"4097"},body:"{}"}),x.env,{fetch:okVerify});assert.equal(r.status,413)}finally{await x.mf.dispose()}});

test("Turnstile timeout/通信失敗/再利用失敗は保存前に403",async()=>{const x=await fixture();try{for(const f of [async()=>{throw new Error("timeout")},async()=>new Response("bad",{status:500})])assert.equal((await handleBoardPost(postRequest(valid),x.env,{fetch:f})).status,403);let used=false;const once=async()=>new Response(JSON.stringify({success:!used}),{headers:{"content-type":"application/json"}});let r=await handleBoardPost(postRequest(valid),x.env,{fetch:async(...a)=>{const q=await once(...a);used=true;return q},now:()=>1700000000000,randomUUID:()=>UUID});assert.equal(r.status,201);r=await handleBoardPost(postRequest({...valid,body:"other"}),x.env,{fetch:once,now:()=>1700000030000,randomUUID:()=>crypto.randomUUID()});assert.equal(r.status,403)}finally{await x.mf.dispose()}});

test("HMAC secret欠落はTurnstileやD1へ進まず503",async()=>{const x=await fixture();try{let calls=0;const env={...x.env,BOARD_RATE_LIMIT_SECRET:""};const r=await handleBoardPost(postRequest(valid),env,{fetch:async()=>{calls++;return okVerify()}});assert.equal(r.status,503);assert.equal(calls,0)}finally{await x.mf.dispose()}});

test("30秒・10分5件・同一本文10分制限はatomic claimで拒否する",async()=>{const x=await fixture();try{let now=1000000;const call=(body=valid)=>handleBoardPost(postRequest(body),x.env,{fetch:okVerify,now:()=>now,randomUUID:()=>crypto.randomUUID()});assert.equal((await call()).status,201);now+=30000;assert.equal((await call({...valid,body:"別本文"})).status,201);now+=30000;assert.equal((await call({...valid,body:"こんにちは"})).status,429);for(let i=0;i<2;i++){now+=30000;assert.equal((await call({...valid,body:`別${i}`})).status,201)}now+=30000;assert.equal((await call({...valid,body:"sixth"})).status,429)}finally{await x.mf.dispose()}});

test("active上限5000は同時INSERTでも超えずsoft deleteで枠を戻す",async()=>{
  const x=await fixture();
  try{
    const stmt=`INSERT INTO board_posts(id,name,body,stamp,created_at,status) SELECT ?,?,?,?,?,'active' WHERE (SELECT active_count FROM board_state WHERE singleton=1)<5000 RETURNING id`;
    await x.BOARD_DB.exec("WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<4998) INSERT INTO board_posts(id,name,body,stamp,created_at,status) SELECT printf('018f47a0-12ab-4def-8abc-%012d',i),'n','b','☕',i,'active' FROM n;");
    const out=await Promise.all([
      x.BOARD_DB.prepare(stmt).bind("018f47a0-12ab-4def-8abc-000000009999","n","b","☕",9999).first(),
      x.BOARD_DB.prepare(stmt).bind("018f47a0-12ab-4def-8abc-000000010000","n","b","☕",10000).first()
    ]);
    assert.equal(out.filter(Boolean).length,1);
    assert.equal((await x.BOARD_DB.prepare("SELECT active_count FROM board_state WHERE singleton=1").first()).active_count,5000);
    const id=out.find(Boolean).id;
    const req=()=>new Request(`https://admin.eruremo.com/api/admin/board/posts/${id}`,{method:"DELETE",headers:{origin:"https://admin.eruremo.com"}});
    let r=await handleBoardDelete(req(),x.env,id);
    assert.equal(r.status,200);
    assert.equal((await x.BOARD_DB.prepare("SELECT active_count FROM board_state WHERE singleton=1").first()).active_count,4999);
    r=await handleBoardDelete(req(),x.env,id);
    assert.equal(r.status,404);
  } finally { await x.mf.dispose(); }
});

test("binding/secret欠落とD1障害は503で内部情報を漏らさない",async()=>{const r=await handleBoardList(new Request("https://eruremo.com/api/board/posts"),{});assert.equal(r.status,503);assert.equal(JSON.stringify(await r.json()).includes("SQL"),false)});

test("production routingはPUBLIC掲示板GET/POSTと認証済みADMIN deleteだけを通す",async()=>{
  const x=await fixture();
  try{
    const env={...x.env,ENVIRONMENT:"production",PUBLIC_HOST:"eruremo.com",ADMIN_HOST:"admin.eruremo.com",MEDIA_MUTATIONS_ENABLED:"false",ASSETS:{fetch:async()=>new Response("asset")}};
    const worker=createWorker({accessCheck:async()=>({ok:true,email:"admin@example.invalid"}),boardDependencies:{fetch:okVerify,now:()=>1700000000000,randomUUID:()=>UUID}});
    let r=await worker.fetch(new Request("https://eruremo.com/api/board/posts"),env);
    assert.equal(r.status,200);
    r=await worker.fetch(postRequest(valid),env);
    assert.equal(r.status,201);
    for(const method of ["HEAD","OPTIONS","PUT","DELETE"]){r=await worker.fetch(new Request("https://eruremo.com/api/board/posts",{method}),env);assert.equal(r.status,404,method)}
    r=await worker.fetch(new Request(`https://eruremo.com/api/admin/board/posts/${UUID}`,{method:"DELETE",headers:{origin:"https://eruremo.com"}}),env);
    assert.equal(r.status,404);
    r=await worker.fetch(new Request(`https://admin.eruremo.com/api/admin/board/posts/${UUID}`,{method:"DELETE",headers:{origin:"https://admin.eruremo.com"}}),env);
    assert.equal(r.status,200);
    r=await worker.fetch(new Request("https://admin.eruremo.com/api/board/posts"),env);
    assert.equal(r.status,404);
    r=await worker.fetch(new Request("https://eruremo.com/api/health"),env);
    assert.equal(r.status,404);
  } finally { await x.mf.dispose(); }
});

test("ADMIN board deleteはAccess拒否時にD1へ到達しない",async()=>{
  const db={prepare(){throw new Error("D1 must not be touched")}};
  const env={ENVIRONMENT:"production",PUBLIC_HOST:"eruremo.com",ADMIN_HOST:"admin.eruremo.com",BOARD_DB:db};
  const worker=createWorker({accessCheck:async()=>({ok:false})});
  const r=await worker.fetch(new Request(`https://admin.eruremo.com/api/admin/board/posts/${UUID}`,{method:"DELETE",headers:{origin:"https://admin.eruremo.com"}}),env);
  assert.equal(r.status,403);
});

test("production default exportにはtest flagやverifier迂回経路が無い",()=>{
  const index=fs.readFileSync(new URL("../src/index.js",import.meta.url),"utf8");
  const board=fs.readFileSync(new URL("../src/lib/board.js",import.meta.url),"utf8");
  assert.match(index,/export default createWorker\(\);/);
  assert.equal(/env\.[A-Z_]*TEST|TURNSTILE_BYPASS|SKIP_TURNSTILE/.test(index+board),false);
  assert.match(board,/deps\.fetch\|\|fetch/);
});
