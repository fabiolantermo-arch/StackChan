// Pairing adapter with fake socket, preferences and timers: no network involved.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SourceTextModule,SyntheticModule,createContext} from 'node:vm';
import {readFile} from 'node:fs/promises';
async function launch({saveWorks=true,diag}={}){
  const context=createContext({JSON,Promise,Error,String,Number});
  const sockets=[],timers=new Map(),calls=[],store=new Map();let id=0;
  class Socket{static handshake=2;static receive=3;static disconnect=-1;constructor(options){this.options=options;this.sent=[];sockets.push(this);}write(v){this.sent.push(JSON.parse(v));}close(){this.closed=true;}}
  const fake=exports=>new SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context});
  const modules={'robottino-socket':fake({Client:Socket}),
    preference:fake({default:{get:(_d,k)=>store.get(k),set:(_d,k,v)=>{if(saveWorks)store.set(k,v);}}}),
    timer:fake({default:{set(fn,ms){timers.set(++id,{fn,ms});return id;},repeat(fn,ms){timers.set(++id,{fn,ms,repeat:true});return id;},clear(n){timers.delete(n);}}})};
  const root=new SourceTextModule(await readFile(new URL('./pairing-device.js',import.meta.url),'utf8'),{context});
  await root.link(async name=>{if(modules[name])return modules[name];const m=new SourceTextModule(await readFile(new URL('./live-wire.js',import.meta.url),'utf8'),{context});await m.link(()=>{throw Error('unexpected');});return m;});
  await root.evaluate();
  const pairing=root.namespace.createPairing({connectivity:{network:{ready:Promise.resolve()}}},{code(c){calls.push(['code',c]);},ended(r){calls.push(['ended',r]);},diag});
  return {pairing,sockets,timers,calls,store,receive:v=>sockets[0].callback(Socket.receive,JSON.stringify(v)),runTimers(){for(const [n,t] of [...timers])if(timers.has(n)){if(!t.repeat)timers.delete(n);t.fn();}}};
}
test('pairing shows the code, saves the credential locally and confirms before closing',async()=>{
  const h=await launch();assert.equal(await h.pairing.start(),true);
  assert.equal(h.sockets[0].options.path,'/api/robot/pair');assert.equal(h.sockets[0].options.Socket,undefined);assert.equal(h.sockets[0].options.headers,undefined,'no credential sent');
  h.receive({type:'code',code:'042137'});assert.deepEqual(h.calls.at(-1),['code','042137']);
  h.receive({type:'credential',token:'r'.repeat(64)});
  assert.equal(h.store.get('deviceToken'),'r'.repeat(64));assert.deepEqual(h.sockets[0].sent,[{type:'stored',ok:true}]);
  assert.equal(h.pairing.active,true,'stays open briefly so the confirmation leaves');h.runTimers();
  assert.deepEqual(h.calls.at(-1),['ended','paired']);assert.equal(h.sockets[0].closed,true);
});
test('while the owner types the code a keep-alive goes out every 20 s, and each step is recorded',async()=>{
  const steps=[];const h=await launch({diag:entry=>steps.push(entry)});await h.pairing.start();h.sockets[0].callback(2);
  h.receive({type:'code',code:'042137'});assert.equal(h.pairing.code,'042137','kept to show again');
  const keepalive=[...h.timers.values()].find(t=>t.repeat);assert.equal(keepalive.ms,20000);
  keepalive.fn();keepalive.fn();assert.deepEqual(h.sockets[0].sent,[{type:'ping'},{type:'ping'}]);
  h.receive({type:'credential',token:'r'.repeat(64)});h.runTimers();
  assert.deepEqual(steps,['start','open','code','cred','stored','end:paired']);assert.equal(h.timers.size,0,'keep-alive stopped');assert.equal(h.pairing.code,undefined);
});
test('a failed save is reported, bad messages end the pairing, and the code expires',async()=>{
  const a=await launch({saveWorks:false});await a.pairing.start();a.receive({type:'credential',token:'r'.repeat(64)});
  assert.deepEqual(a.sockets[0].sent,[{type:'stored',ok:false}]);a.runTimers();assert.deepEqual(a.calls.at(-1),['ended','store_failed']);
  const b=await launch();await b.pairing.start();b.receive({type:'credential',token:'short'});assert.deepEqual(b.calls.at(-1),['ended','error']);assert.equal(b.store.size,0);
  const c=await launch();await c.pairing.start();c.runTimers();assert.deepEqual(c.calls.at(-1),['ended','expired']);
});
