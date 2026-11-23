// «Esplora» (explore.js, 23 Nov 2026: «esplora la stanza e il robot con il rover deve girare e riconoscere gli oggetti e
// pronunciare quello che vede»).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Explore,EXPLORE as L,exploreCommand} from './explore.js';

const half=()=>.5; // forward 3500 ms, turn 800, escape 1600; side: 0.5 is not below 0.5, so to the left
test('the opening phrase first, then forward, a turn always to the same side, a look, and again',()=>{
  const e=new Explore(L,half);e.start(0);
  assert.equal(e.step(100,{speaking:false}),undefined,'waiting for the opening words');
  e.step(1000,{speaking:true});
  assert.deepEqual(e.step(2500,{speaking:false}),{move:'forward',ms:L.moveMs},'said: off it goes');
  assert.equal(e.step(2700),undefined,'the same move: not given again so soon');
  assert.deepEqual(e.step(3000),{move:'forward',ms:L.moveMs},'given again while the stretch lasts');
  assert.deepEqual(e.step(6000),{move:'turnLeft',ms:800+100>L.moveMs?L.moveMs:900},'3.5 s forward, then the turn');
  assert.deepEqual(e.step(6800),{look:true},'turned: a look');
  assert.equal(e.step(7000,{speaking:false}),undefined,'waiting for the words');
  e.step(8000,{speaking:true});assert.equal(e.step(9000,{speaking:true}),undefined,'still talking: still');
  assert.deepEqual(e.step(10000,{speaking:false}),{move:'forward',ms:L.moveMs},'said: on again');
  assert.equal(e.step(13500).move,'turnLeft','the same side again');
});
test('nothing said after a look: on after lookWaitMs; talking too long: on after lookMaxMs',()=>{
  const e=new Explore(L,half);e.start(0);e.step(L.openingMs);for(let t=L.openingMs;t<=20000;t+=100){const r=e.step(t);if(r?.look)break;}
  const at=e.lookFrom;assert.equal(e.step(at+L.lookWaitMs-100),undefined);assert.equal(e.step(at+L.lookWaitMs).move,'forward');
  const f=new Explore(L,half);f.start(0);f.step(L.openingMs);for(let t=L.openingMs;t<=20000;t+=100){if(f.step(t)?.look)break;}
  const at2=f.lookFrom;f.step(at2+100,{speaking:true});assert.equal(f.step(at2+L.lookMaxMs-100,{speaking:true}),undefined);assert.equal(f.step(at2+L.lookMaxMs,{speaking:true}).move,'forward');
});
test('something in front: back, then a wide turn, then forward again',()=>{
  const e=new Explore(L,()=>.2);e.start(0);e.step(L.openingMs);
  e.blocked(7000);assert.equal(e.phase,'back');assert.equal(e.lastMove,'back');assert.equal(e.step(7100),undefined);assert.equal(e.step(7500).move,'back','given again');
  assert.equal(e.step(7000+L.backMs).move,'turnRight','side chosen at the start (0.2: right)');assert.equal(e.phase,'escape');
  const wide=e.until-(7000+L.backMs);assert.ok(wide>=L.escapeMs[0]&&wide<=L.escapeMs[1]);
  assert.equal(e.step(e.until).move,'forward');
});
test('three minutes at most; a stopped one says nothing more',()=>{
  const e=new Explore(L,half);e.start(0);assert.deepEqual(e.step(L.limitMs),{end:'finished'});assert.equal(e.active,false);assert.equal(e.step(L.limitMs+100),undefined);
  const s=new Explore(L,half);s.start(0);s.stop();assert.equal(s.step(100),undefined);
});
test('the words: start, stop, and the sentences that are neither (as Looi)',()=>{
  for(const text of ['Esplora la stanza','esploriamo!','Robottino, vai a esplorare','puoi esplorare un po\'?','guardati intorno','fai un giro','fai un giretto per la stanza','vai in giro','explore the room','look around'])assert.equal(exploreCommand(text),'start',text);
  for(const text of ['basta esplorare','smetti di esplorare','ferma l\'esplorazione','stop exploring','basta col giro'])assert.equal(exploreCommand(text),'stop',text);
  for(const text of ['mi piace esplorare posti nuovi','fai il giro del mondo','non esplorare','hai esplorato?','sto esplorando','vai avanti','',undefined])assert.equal(exploreCommand(text),null,String(text));
});
test('without the rover: no move at all, a look every few seconds after each sentence («muovo io il robot»)',()=>{
  const e=new Explore(L,half);e.start(0,true);
  e.step(500,{speaking:true});assert.equal(e.step(1500,{speaking:false}),undefined,'said the opening words: a pause, no move');
  assert.equal(e.phase,'turn');const pause=e.until-1500;assert.ok(pause>=L.stillMs[0]&&pause<=L.stillMs[1]);
  for(let t=1600;t<e.until;t+=100)assert.equal(e.step(t),undefined,'no move while waiting');
  assert.deepEqual(e.step(e.until),{look:true});
  const at=e.lookFrom;e.step(at+500,{speaking:true});assert.equal(e.step(at+3000,{speaking:false}),undefined);assert.equal(e.phase,'turn','said: the next pause');
  assert.equal(e.blocked(at+3100),undefined,'(a move it never makes)');
});
test('one picture every lookEveryMs at most (the server\'s quota, 6 a minute): a look that comes sooner waits, still',()=>{
  const e=new Explore({...L,lookEveryMs:10000},half);e.start(0,true);
  e.step(500,{speaking:true});e.step(1500,{speaking:false});assert.deepEqual(e.step(e.until),{look:true});const first=e.lookFrom;
  e.step(first+100,{speaking:true});e.step(first+800,{speaking:false});
  for(let t=e.until;t<first+10000;t+=250)assert.equal(e.step(t),undefined,'waiting for the quota');
  assert.deepEqual(e.step(first+10000),{look:true});
});

test('a late answer prevents the next exploration snapshot until speech finishes',()=>{
  const e=new Explore(L,half);e.start(0,true);e.step(L.openingMs);
  const due=e.until;
  assert.equal(e.step(due,{speaking:true}),undefined);
  assert.equal(e.looks,0);
  assert.deepEqual(e.step(due+100,{speaking:false}),{look:true});
});

test('rover stops alternate level, midway, high and back down, repeating after four views',()=>{
  const e=new Explore(L,half),pitches=[];e.start(0);
  for(let now=0;now<100000&&pitches.length<5;now+=100){
    if(e.step(now)?.look)pitches.push(Math.round(e.pitch*180/Math.PI));
  }
  assert.deepEqual(pitches,[0,-25,-50,-25,0]);
  e.stop();e.start(100001);assert.equal(e.pitch,0,'a new exploration begins level');
});
