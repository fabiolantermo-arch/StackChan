// Schede NFC (nfc.js, 21 Nov 2026): a pretend reader that behaves like the host's ST25R3916 driver (an edge or
// undefined from sample(), the field switched by configure()).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NfcCards,NFC} from './nfc.js';

const fakeReader=({failOpen,failSample}={})=>{
  const r={opened:0,closed:0,samples:0,field:false,fieldOnSamples:0,card:undefined,seen:undefined,failSample:!!failSample,
    fieldSwitches:0,configure({antenna}){if(antenna===true&&!r.field)r.fieldSwitches++;r.field=antenna===true;},
    sample(){
      r.samples++;if(r.field)r.fieldOnSamples++;
      if(r.failSample)throw Error('i2c');
      if(r.card!==r.seen){const was=r.seen;r.seen=r.card;if(r.card)return {present:true,uidHex:r.card,sak:0,type:'NTAG'};if(was)return {present:false};}
    },
    close(){r.closed++;r.field=false;}};
  const open=()=>{if(failOpen)throw Error(failOpen);r.opened++;return r;};
  return {r,open};
};
const make=(on,options)=>{const {r,open}=fakeReader(options);const lines=[];
  const cards=new NfcCards(on,{open,clock:()=>0,log:line=>lines.push(line)});return {r,cards,lines};};
const run=(cards,from,ms,state)=>{const out=[];for(let t=from;t<from+ms;t+=100){const seen=cards.tick(t,state);if(seen)out.push(seen);}return out;};

test('off: no reader, no questions; on: opened once, then one question a second, the field on while free',()=>{
  const off=make(false);run(off.cards,0,10000);assert.equal(off.r.opened,0);assert.equal(off.r.samples,0);
  const {r,cards}=make(true);run(cards,0,10000);
  assert.equal(r.opened,1);assert.equal(cards.state,'ready');
  assert.ok(r.samples>=8&&r.samples<=10,`about one a second, got ${r.samples}`);
  assert.equal(r.fieldOnSamples,r.samples,'every question with the field on');
  assert.equal(r.field,true,'the field stays on while the robot is free');
  assert.equal(r.fieldSwitches,1,'switched on once, not at every question');
});
test('a card arrives once, held still it is not repeated, taken away and back it is seen again',()=>{
  const {r,cards,lines}=make(true);run(cards,0,2000);
  r.card='04a1b2c3d4e5f6';
  assert.deepEqual(run(cards,2000,5000),[{uid:'04a1b2c3d4e5f6',type:'NTAG'}]);
  r.card=undefined;assert.deepEqual(run(cards,7000,2000),[]);
  assert.ok(lines.includes('[robottino] nfc removed\n'));
  r.card='04a1b2c3d4e5f6';assert.equal(run(cards,9000,2000).length,1,'back again');
});
test('busy: no questions at all, and nothing is lost after',()=>{
  const {r,cards}=make(true);run(cards,0,1500);const before=r.samples;
  r.card='04aa';assert.deepEqual(run(cards,1500,10000,{busy:true}),[]);
  assert.equal(r.samples,before,'not one question while busy');assert.equal(r.field,false,'field off while busy');
  assert.equal(run(cards,11500,2000).length,1,'seen when free');
});
test('no reader in the host: told once, never asked again until switched on again',()=>{
  const {r,cards,lines}=make(true,{failOpen:'ST25R3916 not found'});
  assert.deepEqual(run(cards,0,200000),[{problem:'missing'}]);
  assert.equal(cards.state,'missing');assert.equal(r.samples,0);
  assert.equal(lines.filter(l=>l.includes('open failed')).length,1);
  const absent=new NfcCards(true,{log:()=>{}});
  assert.deepEqual(absent.tick(0),{problem:'missing'},'no device.sensor.RFID at all');
});
test('a reader that stops answering: closed after three failures, told once, opened again a minute later',()=>{
  const {r,cards}=make(true,{failSample:true});
  assert.deepEqual(run(cards,0,5000),[{problem:'failed'}]);
  assert.equal(cards.state,'failed');assert.equal(r.closed,1);assert.equal(r.field,false);
  const asked=r.samples;
  assert.deepEqual(run(cards,5000,NFC.retryMs-2000),[]);assert.equal(r.samples,asked,'quiet for a minute');
  r.failSample=false;run(cards,5000+NFC.retryMs,3000);
  assert.equal(r.opened,2);assert.equal(cards.state,'ready');
});
test('switched off or closed: field off, reader closed, nothing more asked',()=>{
  const {r,cards}=make(true);run(cards,0,3000);
  cards.set(false);assert.equal(r.closed,1);assert.equal(r.field,false);assert.equal(cards.state,'off');
  const asked=r.samples;run(cards,3000,5000);assert.equal(r.samples,asked);
  cards.set(true);run(cards,8000,3000);assert.equal(r.opened,2);
  cards.close();assert.equal(r.closed,2);
});
test('the worst question time goes to the log once a minute',()=>{
  const {open}=fakeReader();let t=0;const lines=[];
  const cards=new NfcCards(true,{open,clock:()=>(t+=23),log:line=>lines.push(line)});
  run(cards,0,NFC.reportMs+2000);
  assert.ok(lines.some(l=>/^\[robottino\] nfc polls \d+ worst 23 ms\n$/.test(l)),lines.join(''));
});
