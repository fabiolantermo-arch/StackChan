// Head calibration: the MOD's servo positions must survive the host's own conversions exactly.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {hostRotation,rawFromHost,servoPositions,toHost,fromMeasurements,parseCalibration,storeCalibration,rotationFromRaw,reachable,moveTime,HEAD_SPEED,MIN_MOVE,HOST_LIMITS,MARGIN,CalmWait,RETRY_STEP_MS,RETRY_CALM_STEPS,RETRY_MAX_MS} from './calibration.js';
// The host (host/modules/motion/m5stackchan-servo.ts) with the limits the MOD sets in its manifest.
const STEP=16/5/10,TENTH=1800/Math.PI,clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const limits=JSON.parse(readFileSync(new URL('./manifest.json',import.meta.url),'utf8')).config.driver.config;
const host={
  command(rotation,lim=limits){return {
    yaw:clamp(460+Math.trunc(clamp(Math.trunc(rotation.y*TENTH),lim.yaw.angleLimit.min,lim.yaw.angleLimit.max)*STEP),0,1000),
    pitch:clamp(620+Math.trunc(clamp(Math.trunc(-rotation.p*TENTH),lim.pitch.angleLimit.min,lim.pitch.angleLimit.max)*STEP),0,1000)};},
  read(raw,lim=limits){return {
    y:clamp(Math.trunc((raw.yaw-460)/STEP),lim.yaw.angleLimit.min,lim.yaw.angleLimit.max)/TENTH,
    p:-(clamp(Math.trunc((raw.pitch-620)/STEP),lim.pitch.angleLimit.min,lim.pitch.angleLimit.max)/TENTH)};}
};
const ORIGINAL={yaw:{angleLimit:{min:-1280,max:1280}},pitch:{angleLimit:{min:50,max:850}}};
test('the widened host limits reach every servo position, and each one lands exactly',()=>{
  for(let raw=0;raw<=1000;raw++){
    assert.deepEqual(host.command(hostRotation({yaw:raw,pitch:raw})),{yaw:raw,pitch:raw},`position ${raw}`);
    assert.deepEqual(rawFromHost(host.read({yaw:raw,pitch:raw})),{yaw:raw,pitch:raw},`reading ${raw}`);
  }
});
test('before calibration the head goes where the host alone sent it, mirrored sideways (K151), within one servo step (0.3°)',()=>{
  for(const y of [-1.2,-.8,-.3,0,.05,.3,.8,1.2])for(const p of [-1.6,-.52,-.2,-.05,0,.1,.3]){
    const mine=host.command(toHost({y,p,r:0})),theirs=host.command({y:-y,p},ORIGINAL);
    assert.ok(Math.abs(mine.yaw-theirs.yaw)<=1&&Math.abs(mine.pitch-theirs.pitch)<=1,`y ${y} p ${p}: ${JSON.stringify(mine)} vs ${JSON.stringify(theirs)}`);
  }
  assert.equal(servoPositions({y:0,p:0}).pitch,636,'rest: the host’s 5° (raw 636), the position this robot refused');
});
// A robot like this one: straight ahead at pitch 700, which is also the lowest point the head reaches.
const measured={center:{yaw:470,pitch:702},again:{yaw:466,pitch:698},up:{yaw:468,pitch:930},down:{yaw:470,pitch:690},left:{yaw:790,pitch:700},right:{yaw:150,pitch:700}};
test('a calibration from the hand measurements: centre, end stops with a margin, pitch direction',()=>{
  const {calibration,error}=fromMeasurements(measured);assert.equal(error,undefined);
  assert.deepEqual(calibration,{yaw:{center:468,lo:150+MARGIN,hi:790-MARGIN,sign:1},pitch:{center:702,lo:690+MARGIN,hi:930-MARGIN,sign:1}});
  assert.deepEqual(host.command(toHost({y:0,p:0,r:0},calibration)),{yaw:468,pitch:702},'rest: straight ahead');
  assert.equal(host.command(toHost({y:0,p:-.52,r:0},calibration)).pitch,702+Math.round(.52*TENTH*STEP),'looking up 30° from straight ahead');
  assert.equal(host.command(toHost({y:0,p:1,r:0},calibration)).pitch,702,'never below the lower stop plus the margin');
  // The K151 yaw servo is reversed (YAW_SERVO): the robot's left (positive yaw) is the lower servo end.
  assert.equal(host.command(toHost({y:3,p:-3,r:0},calibration)).yaw,150+MARGIN);assert.equal(host.command(toHost({y:3,p:-3,r:0},calibration)).pitch,930-MARGIN);
  assert.equal(host.command(toHost({y:-3,p:0,r:0},calibration)).yaw,790-MARGIN);
  const flipped=fromMeasurements({...measured,up:{yaw:468,pitch:450},down:{yaw:470,pitch:705}}).calibration;
  assert.equal(flipped.pitch.sign,-1,'a pitch servo mounted the other way round');
  assert.ok(host.command(toHost({y:0,p:-.3,r:0},flipped)).pitch<flipped.pitch.center,'looking up still means towards the upper stop');
});
test('measurements that do not make sense are refused',()=>{
  assert.equal(fromMeasurements({...measured,up:undefined}).error,'reading');
  assert.equal(fromMeasurements({...measured,left:{yaw:1200,pitch:700}}).error,'reading');
  assert.equal(fromMeasurements({...measured,again:{yaw:470,pitch:760}}).error,'center_moved');
  assert.equal(fromMeasurements({...measured,up:{yaw:468,pitch:740}}).error,'pitch_range');
  assert.equal(fromMeasurements({...measured,left:{yaw:240,pitch:700}}).error,'yaw_range');
  assert.equal(fromMeasurements({...measured,center:{yaw:900,pitch:700},again:{yaw:900,pitch:700},left:{yaw:850,pitch:700}}).error,'yaw_center');
  assert.equal(fromMeasurements({...measured,center:{yaw:470,pitch:600},again:{yaw:470,pitch:600}}).error,'pitch_center');
});
test('a stored calibration is read back only when complete and consistent',()=>{
  const {calibration}=fromMeasurements(measured);
  assert.deepEqual(parseCalibration(storeCalibration(calibration)),calibration);
  assert.equal(parseCalibration(JSON.stringify(calibration)),undefined,'saved before version 2 (checked only to 46° and 30°): measured again');
  const stored=v=>JSON.stringify({v:2,...v});
  for(const text of [undefined,'','{',stored({yaw:calibration.yaw}),stored({...calibration,pitch:{...calibration.pitch,lo:900}}),stored({...calibration,yaw:{...calibration.yaw,sign:0}})])
    assert.equal(parseCalibration(text),undefined,String(text));
  assert.deepEqual(HOST_LIMITS.pitch,{center:620,lo:636,hi:892,sign:1});
});
test('every pose stays within the robot limits: 90° sideways, from straight ahead up to 85°, never down',async()=>{
  const {safeRotation,HEAD_LIMITS}=await import('./calibration.js');
  assert.ok(Math.abs(HEAD_LIMITS.yaw-Math.PI/2)<1e-9&&Math.abs(HEAD_LIMITS.up-85*Math.PI/180)<1e-9);
  assert.deepEqual(safeRotation({y:2,p:-2}),{y:HEAD_LIMITS.yaw,p:-HEAD_LIMITS.up,r:0});
  assert.deepEqual(safeRotation({y:-2,p:.3}),{y:-HEAD_LIMITS.yaw,p:0,r:0});
  assert.deepEqual(safeRotation({y:.1,p:-.2}),{y:.1,p:-.2,r:0});
  assert.ok(Number.isNaN(safeRotation({y:NaN,p:0}).y),'an invalid pose stays invalid and is refused by toHost');
  assert.throws(()=>toHost(safeRotation({y:NaN,p:0})),/invalid_pose/);
});
test('a refused position shrinks only that end of the range, never closer than 20 steps to the centre',async()=>{
  const {narrowRange,NARROW,MIN_REACH}=await import('./calibration.js');
  const cal={yaw:{center:468,lo:162,hi:778,sign:1},pitch:{center:702,lo:702,hi:918,sign:1}};
  assert.deepEqual(narrowRange(cal,{yaw:468,pitch:797}),{yaw:cal.yaw,pitch:{...cal.pitch,hi:797-NARROW}},'up: the upper pitch end');
  assert.deepEqual(narrowRange(cal,{yaw:321,pitch:702}),{yaw:{...cal.yaw,lo:321+NARROW},pitch:cal.pitch},'one side: that yaw end');
  assert.deepEqual(narrowRange(cal,{yaw:778,pitch:702}).yaw.hi,778-NARROW);
  assert.equal(narrowRange(cal,{yaw:468,pitch:702}),undefined,'the centre itself: nothing to shrink');
  assert.equal(narrowRange(cal,{yaw:468,pitch:702+MIN_REACH+NARROW-1}),undefined,'too close to the centre');
  assert.equal(cal.pitch.hi,918,'the original calibration is not changed');
});
test('one head speed: timed from where the head is, inside the calibrated range',()=>{
  const cal={yaw:{center:493,lo:204,hi:743,sign:1},pitch:{center:621,lo:621,hi:868,sign:1}};
  const back=rotationFromRaw(servoPositions({y:.6,p:-.4,r:0},cal),cal);
  assert.ok(Math.abs(back.y-.6)<.01&&Math.abs(back.p+.4)<.01,'servo positions back to the rotation');
  assert.deepEqual(rotationFromRaw({yaw:493,pitch:621},cal),{y:0,p:0,r:0});
  const far=reachable({y:-Math.PI/2,p:-Math.PI/2,r:0},cal);
  assert.ok(Math.abs(far.y+(743-493)/(1800/Math.PI*.32))<1e-9,'90° asked, the calibrated end reached: '+far.y);
  assert.ok(servoPositions({y:.3,p:0},cal).yaw<493,'positive yaw (the robot\'s left) goes to lower servo positions on the K151');
  assert.ok(Math.abs(far.p+(868-621)/(1800/Math.PI*.32))<1e-9,'up to the calibrated top');
  assert.equal(HEAD_SPEED,3);assert.equal(MIN_MOVE,.1);
  assert.ok(Math.abs(moveTime({y:0,p:0},{y:Math.PI/2,p:0})-Math.PI/6)<1e-9,'90° in about half a second at 3 rad/s');
  assert.equal(moveTime({y:0,p:0},{y:.01,p:0}),MIN_MOVE,'a small step takes the shortest time');
  assert.ok(Number.isNaN(moveTime({y:NaN,p:0},{y:0,p:0})));
});
test('the one repeat of a lost servo command waits for a quiet moment: three timers on time, or 400 ms in all',()=>{
  // JavaScript free: the 20 ms timers fire on time, the repeat goes after three of them (60 ms).
  const free=new CalmWait(1000);
  assert.equal(free.step(1020),false);assert.equal(free.step(1040),false);assert.equal(free.step(1061),true);assert.equal(free.waited,61);
  // JavaScript held up (a timer 150 ms late): the count starts again, the repeat goes three calm timers later.
  const held=new CalmWait(0);
  assert.equal(held.step(20),false);assert.equal(held.step(190),false,'150 ms late: not a quiet moment');assert.equal(held.late,150);
  assert.equal(held.step(212),false);assert.equal(held.step(232),false);assert.equal(held.step(255),true);
  // Timers on time, but the robot says it is busy (the speaker is opening): not a quiet moment either.
  const told=new CalmWait(0);
  assert.equal(told.step(20,false),false);assert.equal(told.step(40,false),false);assert.equal(told.step(60,false),false);assert.equal(told.step(80,false),false);
  assert.equal(told.calm,0);assert.equal(told.step(100,true),false);assert.equal(told.step(120,true),false);assert.equal(told.step(140,true),true);
  const never=new CalmWait(0);let at=0;do at+=RETRY_STEP_MS;while(!never.step(at,false));
  assert.equal(at,RETRY_MAX_MS,'busy all the time: the repeat goes at 400 ms all the same');
  // Never quiet: the repeat goes anyway after 400 ms, so both tries stay inside the 1.2 s watchdog.
  const busy=new CalmWait(0);let now=0,steps=0;
  do{now+=RETRY_STEP_MS+60;steps++;}while(!busy.step(now));
  assert.ok(now>=RETRY_MAX_MS&&now<RETRY_MAX_MS+100,'given up at '+now);assert.equal(busy.calm,0);assert.equal(steps,5);
  assert.ok(250+RETRY_MAX_MS+100+250<1200,'two commands of a quarter of a second and the longest wait: under the watchdog');
  assert.ok(RETRY_CALM_STEPS*RETRY_STEP_MS>=50,'never back at once: at least 60 ms after the lost confirmation');
  // A clock that jumps back or is not a number: no more waiting (the pose watchdog decides).
  assert.equal(new CalmWait(500).step(100),true);assert.equal(new CalmWait(NaN).step(20),true);assert.equal(new CalmWait(0).step(NaN),true);
  assert.equal(new CalmWait(NaN).waited,0);
});
