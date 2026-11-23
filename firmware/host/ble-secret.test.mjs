// The host's Bluetooth settings server (upstream preference-server.ts with firmware/host/patches/ble-no-secret-echo.patch).
// External review of 17 Nov 2026, R3: whoever subscribed was sent the Wi-Fi password and the tokens, and what was
// written went to the log. Runs on the Mac only; skipped when work/ is not there.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import path from 'node:path';

const root=fileURLToPath(new URL('../../',import.meta.url));
const connectivity=path.join(root,'work/stack-chan-upstream/firmware/host/modules/connectivity');
const source=path.join(connectivity,'preference-server.ts');
const available=existsSync(source);
const SECRET='pàssword-di-prova-123',TOKEN='token-di-prova-456';
const sim=globalThis.__bleSim={};
const reset=()=>Object.assign(sim,{now:0,store:{'wifi.ssid':'Casa','wifi.password':SECRET,'ai.token':TOKEN,'tts.volume':3},sent:[],log:[]});
globalThis.trace=text=>sim.log.push(String(text));
ArrayBuffer.fromString??=text=>new TextEncoder().encode(text).buffer;
String.fromArrayBuffer??=buffer=>new TextDecoder().decode(buffer);

let loaded;
const load=async()=>{
  if(loaded)return loaded;
  const {build}=await import('esbuild');
  const dir=mkdtempSync(path.join(tmpdir(),'robottino-ble-'));
  const fake=(name,code)=>{const file=path.join(dir,name);writeFileSync(file,code);return file;};
  const map={
    preference:fake('preference.mjs',`const sim=globalThis.__bleSim;export default {get:(d,k)=>sim.store[d+'.'+k],set(d,k,v){sim.store[d+'.'+k]=v;}};`),
    'preference-write-guard':path.join(connectivity,'preference-write-guard.ts'),
    time:fake('time.mjs','const sim=globalThis.__bleSim;export default {get ticks(){return sim.now;},delta:start=>sim.now-start};'),
    timer:fake('timer.mjs','export default {set(){return {};},clear(){}};'),
    uartserver:fake('uartserver.mjs',`const sim=globalThis.__bleSim;export const SERVICE_UUID='uart';
      export class UARTServer{onConnected(){}startAdvertising(){}close(){}notifyValue(_c,buffer){sim.sent.push(JSON.parse(new TextDecoder().decode(buffer)));}}`)
  };
  const out=path.join(dir,'preference-server.mjs');
  await build({entryPoints:[source],bundle:true,format:'esm',outfile:out,logLevel:'silent',
    plugins:[{name:'host',setup(b){b.onResolve({filter:/.*/},args=>map[args.path]?{path:map[args.path]}:undefined);}}]});
  loaded=await import(pathToFileURL(out).href);
  rmSync(dir,{recursive:true,force:true});
  return loaded;
};
const KEYS=[['wifi','ssid',String],['wifi','password',String],['ai','token',String],['tts','volume',Number]];
const open=async()=>{
  reset();const {PreferenceServer}=await load(),changed=[];
  const server=new PreferenceServer({keys:KEYS,onPreferenceChanged:(key,value)=>changed.push([key,value])});
  server.enableWrites(300000);server.onCharacteristicNotifyEnabled({name:'tx'});
  const write=object=>{const bytes=new TextEncoder().encode(JSON.stringify(object));for(let i=0;i<bytes.length;i+=20)server.onCharacteristicWritten({name:'rx'},bytes.slice(i,i+20).buffer);};
  return {server,changed,write};
};
const leaked=()=>JSON.stringify([sim.sent,sim.log]);

test('subscribing: plain values as before, passwords and tokens only as «stored or not», never their text',{skip:!available},async()=>{
  await open();
  assert.deepEqual(sim.sent.find(m=>m.prop==='wifi.ssid'),{prop:'wifi.ssid',value:'Casa'});
  assert.deepEqual(sim.sent.find(m=>m.prop==='tts.volume'),{prop:'tts.volume',value:3});
  assert.deepEqual(sim.sent.find(m=>m.prop==='wifi.password'),{prop:'wifi.password',value:'',secret:true,set:true});
  assert.deepEqual(sim.sent.find(m=>m.prop==='ai.token'),{prop:'ai.token',value:'',secret:true,set:true});
  assert.ok(!leaked().includes(SECRET)&&!leaked().includes(TOKEN));
  reset();delete sim.store['wifi.password'];const {PreferenceServer}=await load();
  const empty=new PreferenceServer({keys:KEYS});empty.onCharacteristicNotifyEnabled({name:'tx'});
  assert.deepEqual(sim.sent.find(m=>m.prop==='wifi.password'),{prop:'wifi.password',value:'',secret:true,set:false},'none stored: said so');
});
test('writing a network: saved, confirmed with «saved» and no echo; nothing of it in the log, in pieces or whole',{skip:!available},async()=>{
  const h=await open(),before=sim.sent.length,fresh='nuova-pàssword-789';
  h.write({_batch:{'wifi.ssid':'Hotspot','wifi.password':fresh}});
  assert.equal(sim.store['wifi.ssid'],'Hotspot');assert.equal(sim.store['wifi.password'],fresh,'really stored');
  assert.deepEqual(sim.sent.slice(before),[{prop:'wifi.ssid',value:'Hotspot'},{prop:'wifi.password',value:'',secret:true,set:true,saved:true}]);
  assert.deepEqual(h.changed,[['wifi.ssid','Hotspot'],['wifi.password',fresh]],'the settings screen still gets the value, inside the robot');
  for(const text of [fresh,SECRET,'nuova-p','ssword-789'])assert.ok(!leaked().includes(text),'leaked: '+text);
  // The same password again: nothing changes, and it is confirmed all the same.
  const again=sim.sent.length;h.write({_batch:{'wifi.ssid':'Hotspot','wifi.password':fresh}});
  assert.deepEqual(sim.sent.slice(again),[{prop:'wifi.password',value:'',secret:true,set:true,saved:true}]);
});
test('outside the write window nothing is saved and nothing is confirmed',{skip:!available},async()=>{
  const h=await open();h.server.disableWrites();const before=sim.sent.length;
  h.write({_batch:{'wifi.ssid':'Altro','wifi.password':'altra-password'}});
  assert.equal(sim.store['wifi.password'],SECRET);assert.equal(sim.sent.length,before);assert.ok(!leaked().includes('altra-password'));
});
