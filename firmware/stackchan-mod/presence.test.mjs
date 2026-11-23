// Presence sensor (presence.js): the AS312 wakes the robot only when it sleeps, and not on a glitch.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Presence,createPir,PIR} from './presence.js';

test('awake nothing happens; asleep a movement held for steadyMs wakes once',()=>{
  const p=new Presence();
  for(let now=0;now<5000;now+=100)assert.equal(p.tick(now,{level:1,asleepMs:undefined}),false,'awake: the camera is already looking');
  assert.equal(p.tick(10000,{level:1,asleepMs:PIR.sleptMs}),false,'first high reading');
  assert.equal(p.tick(10100,{level:1,asleepMs:PIR.sleptMs+100}),false);
  assert.equal(p.tick(10000+PIR.steadyMs,{level:1,asleepMs:PIR.sleptMs+PIR.steadyMs}),true,'held: someone is there');
  assert.equal(p.tick(10000+PIR.steadyMs+100,{level:1,asleepMs:PIR.sleptMs+PIR.steadyMs+100}),false,'once: the count starts again');
});
test('not in the first seconds of sleep (the robot\'s own last moves), not on a glitch, not with no signal',()=>{
  const p=new Presence();
  for(let ms=0;ms<PIR.sleptMs;ms+=100)assert.equal(p.tick(ms,{level:1,asleepMs:ms}),false,`asleep for ${ms} ms`);
  const g=new Presence();
  assert.equal(g.tick(0,{level:1,asleepMs:20000}),false);assert.equal(g.tick(100,{level:0,asleepMs:20100}),false,'gone');
  assert.equal(g.tick(200,{level:1,asleepMs:20200}),false,'a new start, not the end of the old one');
  assert.equal(g.tick(300,{level:1,asleepMs:20300}),false);assert.equal(g.tick(400,{level:1,asleepMs:20400}),true);
  const none=new Presence();for(let now=0;now<60000;now+=100)assert.equal(none.tick(now,{level:0,asleepMs:now+10000}),false);
});
test('the pin: G8 with the pull-down (no unit: 0); a host without it, or a read that fails, is «nobody»',()=>{
  const opened=[];let level=0,fail=false;
  class Digital{static InputPullDown=2;constructor(options){opened.push(options);}read(){if(fail)throw Error('gone');return level;}close(){this.closed=true;}}
  const pir=createPir({Digital});assert.equal(pir.read(),0,'not open yet');
  assert.equal(pir.open(),true);assert.deepEqual(opened,[{pin:8,mode:2}]);
  assert.equal(pir.read(),0);level=1;assert.equal(pir.read(),1);fail=true;assert.equal(pir.read(),0);pir.close();assert.equal(pir.read(),0);
  class Broken{static InputPullDown=2;constructor(){throw Error('busy');}}
  const lines=[],bad=createPir({Digital:Broken,log:text=>lines.push(text)});assert.equal(bad.open(),false);assert.match(lines[0],/presence pin unavailable busy/);assert.equal(bad.read(),0);
});
