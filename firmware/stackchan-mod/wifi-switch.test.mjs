// Two-network switching with fake preferences, timers and scans: no radio involved.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {launchWithNetworks,learnNetwork,chooseNetwork,loadNetworks} from './wifi-switch.js';
function robot(wifi={}){
  const store=new Map(Object.entries(wifi).map(([k,v])=>['wifi.'+k,v])),repeats=new Map(),sets=new Map();let id=0;
  const preference={get:(d,k)=>store.get(d+'.'+k),set:(d,k,v)=>store.set(d+'.'+k,v),delete:(d,k)=>store.delete(d+'.'+k)};
  const timer={repeat(fn){repeats.set(++id,fn);return id;},set(fn){sets.set(++id,fn);return id;},clear(n){repeats.delete(n);sets.delete(n);}};
  const poll=()=>{for(const fn of repeats.values())fn();};
  // The app writes over Bluetooth during Settings: the PreferenceServer sets both keys together.
  const write=(ssid,password)=>{store.set('wifi.ssid',ssid);store.set('wifi.password',password);poll();};
  return {store,preference,timer,poll,write,repeats,sets,wifi:()=>[store.get('wifi.ssid'),store.get('wifi.password')]};
}
const scanner=visible=>({calls:0,scan(o){this.calls++;queueMicrotask(()=>{for(const ssid of visible)o.onFound({ssid,rssi:-50});o.onComplete();});return {close(){}};}});
test('Settings writes are learned: hotspot then home, home becomes the main network',async()=>{
  const r=robot({ssid:'Vecchia',password:'vecchia-pass'}),s=scanner(['Casa','iPhone di Ada']);
  await launchWithNetworks({preference:r.preference,timer:r.timer,scan:o=>s.scan(o),hostLaunch:async()=>{r.write('','');r.write('iPhone di Ada','hot-pass');r.write('Casa','casa-pass');return true;}});
  assert.deepEqual(loadNetworks(r.preference),[{ssid:'Casa',password:'casa-pass'},{ssid:'iPhone di Ada',password:'hot-pass'}],'only two kept, the old one dropped');
  assert.deepEqual(r.wifi(),['Casa','casa-pass'],'home is visible: it stays in the host slot');
  assert.equal(r.repeats.size,0,'polling stops when Settings ends');
});
test('away from home the hotspot goes into the host slot, and back home the home network returns',async()=>{
  const r=robot({ssid:'Casa',password:'casa-pass'});
  r.preference.set('robottino','net0ssid','Casa');r.preference.set('robottino','net0pass','casa-pass');
  r.preference.set('robottino','net1ssid','iPhone di Ada');r.preference.set('robottino','net1pass','hot-pass');
  await launchWithNetworks({preference:r.preference,timer:r.timer,scan:o=>scanner(['Bar Wi-Fi','iPhone di Ada']).scan(o),hostLaunch:async()=>true});
  assert.deepEqual(r.wifi(),['iPhone di Ada','hot-pass']);
  await launchWithNetworks({preference:r.preference,timer:r.timer,scan:o=>scanner(['iPhone di Ada','Casa']).scan(o),hostLaunch:async()=>true});
  assert.deepEqual(r.wifi(),['Casa','casa-pass'],'home wins when both are visible');
  assert.deepEqual(loadNetworks(r.preference).map(n=>n.ssid),['Casa','iPhone di Ada'],'switching never reorders the remembered networks');
  await launchWithNetworks({preference:r.preference,timer:r.timer,scan:o=>scanner([]).scan(o),hostLaunch:async()=>true});
  assert.deepEqual(r.wifi(),['Casa','casa-pass'],'nothing visible: the host keeps its network and its own retry screen');
});
test('one network, a cancelled launch or a missing scanner change nothing; a stuck scan times out',async()=>{
  const r=robot({ssid:'Casa',password:'casa-pass'}),s=scanner(['Altro']);
  await launchWithNetworks({preference:r.preference,timer:r.timer,scan:o=>s.scan(o),hostLaunch:async()=>true});
  assert.equal(s.calls,0,'a single network needs no scan');assert.deepEqual(loadNetworks(r.preference),[{ssid:'Casa',password:'casa-pass'}],'existing robot migrated');
  r.preference.set('robottino','net1ssid','iPhone');r.preference.set('robottino','net1pass','hot-pass');
  assert.equal(await launchWithNetworks({preference:r.preference,timer:r.timer,scan:o=>s.scan(o),hostLaunch:async()=>false}),false);assert.equal(s.calls,0);
  const stuck=launchWithNetworks({preference:r.preference,timer:r.timer,scan:()=>({close(){}}),hostLaunch:async()=>true});
  await new Promise(resolve=>setTimeout(resolve,0));for(const fn of r.sets.values())fn();
  assert.equal(await stuck,true);assert.deepEqual(r.wifi(),['Casa','casa-pass']);
});
test('host launch errors still stop polling; invalid networks are never learned',async()=>{
  const r=robot();
  await assert.rejects(launchWithNetworks({preference:r.preference,timer:r.timer,hostLaunch:async()=>{throw Error('boom');}}),/boom/);assert.equal(r.repeats.size,0);
  assert.deepEqual(learnNetwork([],{ssid:'',password:'x'}),[]);assert.deepEqual(learnNetwork([],{ssid:'Casa',password:''}),[]);
  assert.deepEqual(learnNetwork([{ssid:'Casa',password:'old'}],{ssid:'Casa',password:'new'}),[{ssid:'Casa',password:'new'}],'a new password replaces the old one');
  assert.equal(chooseNetwork([{ssid:'Casa',password:'p'}],['casa']),null,'names must match exactly');
});
