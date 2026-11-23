// «Chiamata con lo sguardo» (gaze.js, 21 Nov 2026).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GazeCall,GAZE} from './gaze.js';
const run=(g,ms,state,start=0)=>{let calls=0;for(let t=0;t<ms;t+=100)if(g.tick(start+t,state))calls++;return calls;};
test('off: nothing; on: 10 s of a face is one call; a face missed briefly does not start over, away for longer does',()=>{
  assert.equal(run(new GazeCall(false),20000,{watching:true,seenMs:100}),0);
  const g=new GazeCall(true);assert.equal(run(g,9900,{watching:true,seenMs:100}),0,'not yet');
  assert.equal(run(g,200,{watching:true,seenMs:100},9900),1,'10 s');
  const h=new GazeCall(true);run(h,5000,{watching:true,seenMs:100});run(h,500,{watching:true,seenMs:1200},5000);
  assert.equal(run(h,5000,{watching:true,seenMs:100},5500),1,'missed for a moment: the count goes on');
  const k=new GazeCall(true);run(k,5000,{watching:true,seenMs:100});run(k,500,{watching:true,seenMs:GAZE.gapMs+100},5000);
  assert.equal(run(k,9000,{watching:true,seenMs:100},5500),0,'gone: from zero again');
});
test('after a call, still looking: nothing until the face went away, or two minutes passed',()=>{
  const g=new GazeCall(true);run(g,10100,{watching:true,seenMs:100});
  run(g,30000,{talking:true},10100);
  assert.equal(run(g,20000,{watching:true,seenMs:100},40100),0,'still looking');
  run(g,500,{watching:true,seenMs:GAZE.awayMs+100},60100);
  assert.equal(run(g,10100,{watching:true,seenMs:100},60600),1,'looked away, then 10 s: a call');
  const h=new GazeCall(true);run(h,10100,{watching:true,seenMs:100});run(h,1000,{talking:true},10100);
  assert.equal(run(h,GAZE.againMs+11000,{watching:true,seenMs:100},11100),1,'two minutes later anyway');
});
test('busy or not watching: nothing; switched off and on: from zero',()=>{
  assert.equal(run(new GazeCall(true),20000,{watching:true,seenMs:100,busy:true}),0);
  assert.equal(run(new GazeCall(true),20000,{watching:false,seenMs:100}),0);
  const g=new GazeCall(true);run(g,8000,{watching:true,seenMs:100});g.set(false);g.set(true);
  assert.equal(run(g,9000,{watching:true,seenMs:100},8000),0,'switched off and on: the count starts again');
});
