import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
// Execute the actual client bridge with browser globals replaced; no bundler/browser dependency.
let source=stripTypeScriptTypes(await readFile('src/compiler/world-store.ts','utf8'));
source=source.replaceAll('import.meta.env','({BASE_URL:"/flk/"})').replace("new URL('./world-store.worker.ts',import.meta.url)","new URL('https://example.invalid/flk/world-worker.js')");
const timers=new Map();let nextTimer=0,fail=true,hang=false,lastBase;
const workers=[];
const original={setTimeout,clearTimeout};
class WorkerStub {
  constructor(){this.terminated=false;this.messages=[];workers.push(this);}
  postMessage(message){
    if(fail)throw new DOMException('Cannot clone request','DataCloneError');
    lastBase=message.base;this.messages.push(message);
    if(hang)return;
    queueMicrotask(()=>this.onmessage({data:{id:message.id,type:'done'}}));
  }
  terminate(){assert(!this.terminated,'Each timed out worker terminates exactly once');this.terminated=true;}
}
Object.assign(globalThis,{Worker:WorkerStub,location:{href:'https://example.invalid/flk/?loc=1,2'},
  setTimeout:(callback,ms)=>{const id=++nextTimer;timers.set(id,{callback,ms});return id;},clearTimeout:id=>timers.delete(id)});
try{
  const {loadHostedWorld}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  await assert.rejects(()=>loadHostedWorld({lat:1,lon:2,name:'Clone failure'},()=>{}),/Cannot clone/);
  assert.equal(timers.size,0,'Synchronous postMessage failure must clear its watchdog');
  fail=false;
  assert.equal(await loadHostedWorld({lat:1,lon:2,name:'Next request'},()=>{}),undefined);
  assert.equal(lastBase,'https://example.invalid/flk/world/');
  assert.equal(timers.size,0);
  assert.equal(workers.length,1);assert(!workers[0].terminated);
  console.log('PASS synchronous postMessage failure clears watchdog; next request succeeds with production BASE URL');
  hang=true;
  const waiting=Array.from({length:6},(_,i)=>loadHostedWorld({lat:1,lon:2,name:`Hung ${i}`},()=>{}));
  const settled=Promise.allSettled(waiting); // Observe every rejection before firing a watchdog.
  assert.equal(timers.size,6);assert.equal(workers.length,1);
  const messages=workers[0].messages.length;
  await assert.rejects(()=>loadHostedWorld({lat:1,lon:2,name:'Queue overflow'},()=>{}),/queue is full/);
  assert.equal(workers[0].messages.length,messages,'Seventh request must not enter worker queue');
  assert.equal(timers.size,6,'Rejected queue overflow must not arm another watchdog');
  console.log('PASS six-request queue cap rejects excess work without another worker, message or timer');
  const watchdog=timers.values().next().value;assert.equal(watchdog.ms,30_000);watchdog.callback();
  const results=await settled;
  assert(results.every(r=>r.status==='rejected'&&/timed out/.test(r.reason.message)));
  assert(workers[0].terminated);assert.equal(timers.size,0);
  hang=false;
  assert.equal(await loadHostedWorld({lat:1,lon:2,name:'Recovery'},()=>{}),undefined);
  assert.equal(workers.length,2);assert(!workers[1].terminated);assert.equal(timers.size,0);
  // A stale completion from the terminated worker cannot settle a newer unique request.
  workers[0].onmessage({data:{id:workers[0].messages.at(-1).id,type:'done'}});
  assert.equal(timers.size,0);assert(!workers[1].terminated);
  console.log('PASS watchdog terminates hung worker, rejects every pending request, clears all timers and creates a healthy replacement');
}finally{Object.assign(globalThis,original);}
