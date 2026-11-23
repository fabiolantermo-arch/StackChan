// «La Forza» that follows the hand (force-follow.js, 23 Nov 2026: «se indietreggia la mano, avanza il rover… se avanza
// la mano, indietreggia il rover, destra e sinistra»).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ForceFollow,FORCE_FOLLOW as L} from './force-follow.js';

const hooked=(mm=140)=>{const f=new ForceFollow();f.start(mm,0);return f;};
// Readings every 50 ms from `from`; the moves that came out.
const feed=(f,list,from)=>list.map((mm,i)=>f.feed(mm,from+i*50)).filter(Boolean);

test('after the push it goes back for a moment, then keeps the hand where it was',()=>{
  const f=hooked(120);
  assert.deepEqual(f.feed(120,0),{x:0,y:-L.recoilSpeed},'the recoil first');
  assert.equal(f.feed(130,100),undefined,'the same move: not sent again so soon');
  assert.deepEqual(f.feed(140,250),{x:0,y:-L.recoilSpeed},'renewed before it runs out');
  // Settled: the distance of now is the one to keep (at least nearestMm), and the rover stands still there.
  assert.deepEqual(f.feed(200,L.settleMs),{x:0,y:0});assert.equal(f.keep,200);
  assert.equal(new ForceFollow().feed(200,0),undefined,'nothing before a push');
});
test('the hand comes nearer: back; goes away: forward, faster when the difference is bigger; within the dead band, still',()=>{
  const f=hooked();f.feed(200,L.settleMs);
  const back=f.feed(140,L.settleMs+300);assert.ok(back.y<0&&back.x===0,'nearer: back');
  const forward=f.feed(260,L.settleMs+600);assert.ok(forward.y>0,'farther: forward');
  const faster=f.feed(320,L.settleMs+900);assert.ok(faster.y>forward.y,'farther still: faster');assert.ok(faster.y<=L.maxSpeed);
  assert.deepEqual(f.feed(220,L.settleMs+1200),{x:0,y:0},'within 35 mm: still');
});
test('the keep distance is never nearer than nearestMm nor farther than farthestMm',()=>{
  const near=hooked();near.feed(60,L.settleMs);assert.equal(near.keep,L.nearestMm);
  const far=hooked();far.feed(450,L.settleMs);assert.equal(far.keep,L.farthestMm);
});
test('left and right from the iPhone: a hand on the robot\'s left of the picture (x < 0.5) is a slide to the left (x < 0); an old place counts no more',()=>{
  const f=hooked();f.feed(200,L.settleMs);let t=L.settleMs+300;
  f.hand(.2,t);assert.deepEqual(f.feed(200,t),{x:-L.sideSpeed,y:0});
  t+=300;f.hand(.85,t);assert.deepEqual(f.feed(200,t),{x:L.sideSpeed,y:0});
  t+=300;f.hand(.55,t);assert.deepEqual(f.feed(200,t),{x:0,y:0},'near the middle: no slide');
  t+=300;f.hand(.1,t);const both=f.feed(280,t);assert.ok(both.x<0&&both.y>0,'away and to the left: both at once');
  t+=L.sideFreshMs+100;assert.equal(f.feed(280,t).x,0,'the iPhone said nothing more: no slide');
  f.hand(NaN,t);f.hand(3,t);assert.equal(f.side.x,.1,'nonsense is not a place');
});
test('it lets go when the hand is gone for a moment, or after the time limit; a hand lost for an instant is kept',()=>{
  const f=hooked();f.feed(200,L.settleMs);
  assert.equal(f.feed(2000,L.settleMs+100),undefined,'lost: it stays still, nothing new');
  assert.deepEqual(f.feed(210,L.settleMs+400),{x:0,y:0},'back in time: still hooked, still');assert.equal(f.active,true);
  assert.deepEqual(feed(f,Array(20).fill(2000),L.settleMs+500).at(-1),{end:'hand gone'});assert.equal(f.active,false);
  assert.equal(f.feed(200,L.settleMs+2000),undefined,'let go: nothing more');
  const g=hooked();assert.deepEqual(g.feed(200,L.maxMs),{end:'time limit'});
});
