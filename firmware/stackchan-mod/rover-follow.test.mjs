// «Inseguimento con rover» (rover-follow.js): turn toward the face, then keep the distance; never blind, never lifted;
// with nobody in sight, turns on the spot until a face is seen.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RoverFollow,FOLLOW,obstacleAhead} from './rover-follow.js';
import {createWorld} from '../../scripts/sim-follow-world.js';
// The search in steps and pauses (what follows a slow turn that found nobody): the slow turn switched off.
const STEPS={searchSmooth:false};
const DEG=Math.PI/180,near=(a,b,why)=>assert.ok(Math.abs(a-b)<1e-9,`${why??''} ${a} ≠ ${b}`);
const on={ready:true,allowed:true,seenMs:100};
const at=(mm,t=0)=>({mm,at:t,valid:true});

test('the head turned toward the face: the body turns that way first (robot\'s left = negative z)',()=>{
  const f=new RoverFollow(),step=f.tick(0,{...on,yaw:FOLLOW.turnYaw+.05,distance:at(2000)});
  assert.deepEqual({x:step.x,y:step.y,z:step.z,why:step.why},{x:0,y:0,z:-FOLLOW.fastSpeed,why:'turn'});
  assert.equal(f.tick(10,{...on,yaw:-1}),undefined,'resting');
  assert.equal(f.tick(step.ms+FOLLOW.restMs,{...on,yaw:-1}).z,FOLLOW.fastSpeed);
});
// A pretend rover that turns: «moving» until the step's time is over (rover-wire.js's own timer), turning `real`
// radians a second per % of speed; with `gyro`, a reading of that every 100 ms. Gives the steps and what it turned.
const spinning=(f,{yaw,real=FOLLOW.turnRate/100,gyro=true,until=4000,cycle=25,input={}})=>{
  const steps=[];let move,turned=0,spin,spinAt=-Infinity,stop;
  for(let now=0;now<=until&&!stop;now+=cycle){
    if(move&&now>=move.end)move=undefined;
    if(move)turned+=real*Math.abs(move.z)*cycle/1000;
    if(gyro&&now-spinAt>=100){spinAt=now;spin={rate:move?real*Math.abs(move.z):0,at:now};}
    const step=f.tick(now,{...on,yaw,moving:!!move,spin:gyro?spin:undefined,...input});
    if(step?.stop){stop={at:now,...step};move=undefined;}
    else if(step){steps.push({at:now,...step});move={end:now+step.ms,z:step.z};}
  }
  return {steps,stop,turned};
};
test('a turn toward the face is one move, as wide as the angle, measured by the gyroscope; the head goes back when it ends, by what the body turned (16 Nov 2026: «La rotazione possiamo evitare di farla a scatti»)',()=>{
  // 60° to the robot's left: one turn of 48° (turnShare), whatever this rover does at 50 %: as reckoned, half, twice.
  for(const k of [1,.5,2]){
    const {steps,stop,turned}=spinning(new RoverFollow(),{yaw:60*DEG,real:k*FOLLOW.turnRate/100});
    assert.equal(steps[0].z,-FOLLOW.fastSpeed,'to the robot\'s left, at the rover\'s limit');assert.equal(steps[0].head,undefined,'the head stays while the body turns: the gyroscope is in it');
    assert.ok(steps.slice(1).every(s=>s.more&&s.z===steps[0].z&&s.why==='turn'),'renewed, never stopped on the way');
    for(let i=1;i<steps.length;i++)assert.ok(steps[i].at<steps[i-1].at+steps[i-1].ms,'each renewal before the stretch before it ends');
    assert.equal(stop.why,'turned');assert.equal(stop.measured,true);
    assert.ok(Math.abs(turned-48*DEG)<=(k===2?16:8)*DEG,`×${k}: turned ${Math.round(turned/DEG)}° for 48°`);
    assert.ok(Math.abs(-stop.head-turned)<=12*DEG&&stop.head<0,`the head back by about what the body turned: ${Math.round(stop.head/DEG)}° for ${Math.round(turned/DEG)}°`);
  }
  // A little to the right: slowly, a short turn.
  const small=spinning(new RoverFollow(),{yaw:-14*DEG});
  assert.equal(small.steps[0].z,FOLLOW.speed);assert.ok(small.turned>5*DEG&&small.turned<20*DEG,`${Math.round(small.turned/DEG)}°`);assert.ok(small.stop.head>0);
  // Never longer than turnLongMs in one move: the camera is not looking meanwhile.
  const slow=spinning(new RoverFollow(),{yaw:80*DEG,real:.2*FOLLOW.turnRate/100});
  assert.ok(slow.stop.at<=FOLLOW.turnLongMs+50,`${slow.stop.at} ms`);assert.equal(slow.stop.why,'turned');
});
test('a turn without the gyroscope, or with one that says the body is not turning: reckoned by the clock, and then never more than turnMaxYaw a time',()=>{
  const rate=speed=>FOLLOW.turnRate*speed/100;
  for(const [why,options] of [['no gyroscope',{gyro:false}],['the head is moving (no reading)',{gyro:false}]]){
    const {steps,stop,turned}=spinning(new RoverFollow(),{yaw:70*DEG,...options});
    assert.equal(stop.measured,false,why);assert.ok(turned<=FOLLOW.turnMaxYaw+.01&&turned>=FOLLOW.turnMaxYaw-4*DEG,`${why}: ${Math.round(turned/DEG)}°`);
    near(-stop.head,stop.turned);assert.ok(stop.turned<=FOLLOW.turnMaxYaw+1e-9);assert.equal(steps[0].z,-FOLLOW.fastSpeed);
  }
  // A gyroscope that reads nothing while the wheels are told to turn (stuck, or not the body's): not believed.
  const f=new RoverFollow();let stop,move;
  for(let now=0;now<3000&&!stop;now+=25){if(move&&now>=move)move=undefined;const step=f.tick(now,{...on,yaw:70*DEG,moving:!!move,spin:{rate:0,at:now}});if(step?.stop)stop={at:now,...step};else if(step)move=now+step.ms;}
  assert.equal(stop.measured,false);assert.ok(Math.abs(stop.at-1000*FOLLOW.turnMaxYaw/rate(FOLLOW.fastSpeed))<=60,`ended by the clock at ${stop.at} ms`);
  // The same pretend rover twice as quick as reckoned, by the clock: 50° instead of 25°, and the head back by 25°: the
  // face is still inside the picture (29° each side). This is why turnMaxYaw stays where it is.
  const quick=spinning(new RoverFollow(),{yaw:70*DEG,gyro:false,real:2*FOLLOW.turnRate/100});
  assert.ok(quick.turned+quick.stop.head<=29*DEG,`${Math.round((quick.turned+quick.stop.head)/DEG)}° off the middle`);
  assert.ok(FOLLOW.turnMaxYaw<=25*DEG);
  // A short turn is never shorter than the wheels can make.
  const small=spinning(new RoverFollow(),{yaw:13*DEG,gyro:false});
  assert.ok(small.stop.at>=FOLLOW.nudgeMs,`${small.stop.at} ms`);
});
test('the search is one slow turn with the camera looking, kept at its rate by the gyroscope; a face stops it; a whole turn with nobody and the steps take over; two such and it is not tried again',()=>{
  const look={ready:true,allowed:true,search:true};
  const sweep=(f,{from=0,real=FOLLOW.turnRate/100,gyro=true,until=40000,seeAt}={})=>{
    const steps=[];let move,turned=0,spin,spinAt=-Infinity,stop;
    for(let now=from;now<=from+until&&!stop;now+=25){
      if(move&&now>=move.end)move=undefined;
      if(move)turned+=real*Math.abs(move.z)*.025;
      if(gyro&&now-spinAt>=100){spinAt=now;spin={rate:move?real*Math.abs(move.z):0,at:now};}
      const seen=seeAt!==undefined&&turned>=seeAt;
      const step=f.tick(now,{...look,seenMs:seen?25:Infinity,moving:!!move,spin:gyro?spin:undefined});
      if(step?.stop){stop={at:now,...step};move=undefined;}
      else if(step){steps.push({at:now,turned,...step});move={end:now+step.ms,z:step.z};}
    }
    return {steps,stop,turned};
  };
  // Nobody for 3 s, then one turn: renewed without a stop, the camera looking, the quick detectors only.
  let f=new RoverFollow(),run=sweep(f,{seeAt:200*DEG});
  assert.equal(run.steps[0].at,FOLLOW.searchAfterMs);assert.equal(run.steps[0].z,-FOLLOW.searchSmoothSpeed,'to the side of the last time (the robot\'s left), slowly');
  assert.ok(run.steps.every(s=>s.why==='search'&&s.look===true&&s.z<0));assert.ok(run.steps.slice(1).every(s=>s.more));
  for(let i=1;i<run.steps.length;i++)assert.ok(run.steps[i].at<run.steps[i-1].at+run.steps[i-1].ms,'never a pause');
  assert.deepEqual({stop:run.stop.stop,why:run.stop.why},{stop:true,why:'seen'});assert.ok(run.turned>=200*DEG&&run.turned<215*DEG,`stopped at the face: ${Math.round(run.turned/DEG)}°`);
  assert.equal(f.steps,0,'found: the search is over');
  // The same on a rover that turns twice as fast, or half as fast, at a given speed: the wheels' speed is changed
  // until the gyroscope reads searchSmoothRate, within the rover's limits.
  for(const k of [2,.5]){
    f=new RoverFollow();run=sweep(f,{real:k*FOLLOW.turnRate/100,until:6000});
    const last=run.steps.at(-1),rate=k*FOLLOW.turnRate/100*Math.abs(last.z);
    // (half as fast, this rover cannot do 45° a second within its limit: then the limit)
    const wanted=Math.min(FOLLOW.searchSmoothRate,k*FOLLOW.turnRate/100*FOLLOW.fastSpeed);
    assert.ok(Math.abs(rate-wanted)<=6*DEG,`×${k}: ${Math.round(rate/DEG)}°/s at ${Math.abs(last.z)} %`);
    assert.ok(Math.abs(last.z)>=FOLLOW.searchSmoothLeast&&Math.abs(last.z)<=FOLLOW.fastSpeed);
  }
  // Nobody in a whole turn and a bit: the slow turn ends, and the search goes on in steps and pauses as before.
  f=new RoverFollow();run=sweep(f,{until:30000});
  const first=run.steps.findIndex(s=>!s.look);assert.ok(first>0,'steps after the slow turn');
  assert.ok(run.steps[first].turned>=FOLLOW.searchSmoothTurn-10*DEG&&run.steps[first].turned<=FOLLOW.searchSmoothTurn+30*DEG,`the slow turn went ${Math.round(run.steps[first].turned/DEG)}°`);
  assert.ok(run.steps[first].at>=run.steps[first-1].at+run.steps[first-1].ms,'the slow turn ended first');
  assert.ok(run.steps.slice(first).every(s=>s.z===-FOLLOW.searchSpeed&&s.ms===FOLLOW.searchMs&&!s.look&&!s.more),'steps at the rover\'s limit, the camera waiting for the wheels');
  assert.equal(f.smooth,true,'once is not enough to give it up');
  // Found by the steps, lost again, a second fruitless slow turn: from then on steps at once.
  f.tick(100000,{...look,seenMs:50,distance:at(600,100000)});run=sweep(f,{from:101000,until:30000});assert.equal(run.steps[0].look,true);assert.equal(f.smooth,false);
  f.tick(200000,{...look,seenMs:50,distance:at(600,200000)});run=sweep(f,{from:201000,until:8000});
  assert.equal(run.steps[0].look,undefined,'steps from the start');assert.equal(run.steps[0].z,-FOLLOW.searchSpeed);
  // A slow turn that does find a face counts the failures from nothing again.
  f=new RoverFollow();sweep(f,{until:30000});f.tick(100000,{...look,seenMs:50,distance:at(600,100000)});
  run=sweep(f,{from:101000,seeAt:90*DEG});assert.equal(run.stop.why,'seen');
  f.tick(200000,{...look,seenMs:50,distance:at(600,200000)});sweep(f,{from:201000,until:30000});assert.equal(f.smooth,true);
  // Without the gyroscope: at searchSmoothSpeed, a whole turn reckoned by the clock, then the steps.
  f=new RoverFollow();run=sweep(f,{gyro:false,until:30000});
  const steps=run.steps.findIndex(s=>!s.look);assert.ok(run.steps.slice(0,steps).every(s=>s.z===-FOLLOW.searchSmoothSpeed));
  assert.ok(Math.abs(run.steps[steps].turned-FOLLOW.searchSmoothTurn)<=30*DEG);
  // Asleep or in a conversation (search false), not allowed, lifted: not renewed, or stopped.
  for(const [why,block,stops] of [['asleep',{search:false},false],['not allowed',{allowed:false},false],['lifted',{unsafe:true},true]]){
    f=new RoverFollow();let move,last,stop;
    for(let now=0;now<8000;now+=25){if(move&&now>=move)move=undefined;const step=f.tick(now,{...look,seenMs:Infinity,moving:!!move,...(now>=4000?block:{})});if(step?.stop){stop=now;move=undefined;}else if(step){last=now;move=now+step.ms;}}
    assert.ok(last<4000,why+': no renewal after it');if(stops)assert.ok(stop>=4000&&stop<4100,why+': stopped at once');
  }
});
test('head straight: farther than keep+band forward, nearer than keep−band back, in between still',()=>{
  const f=new RoverFollow();let t=0;const next=()=>(t+=5000);
  let now=next();assert.deepEqual(f.tick(now,{...on,distance:at(FOLLOW.keepMm+FOLLOW.bandMm+50,now)}),{x:0,y:FOLLOW.speed,z:0,ms:FOLLOW.driveMs,why:'closer',look:true});
  now=next();assert.deepEqual(f.tick(now,{...on,distance:at(FOLLOW.keepMm-FOLLOW.bandMm-50,now)}),{x:0,y:-FOLLOW.speed,z:0,ms:FOLLOW.backMs,why:'farther',look:true});
  now=next();assert.equal(f.tick(now,{...on,distance:at(FOLLOW.keepMm,now)}),undefined);
});
test('never blind: no face, an old or invalid distance, not allowed, moving, no rover; the head half turned: a short turn, never forward',()=>{
  const f=new RoverFollow(),far=at(1500,10000);
  assert.equal(f.tick(10000,{...on,seenMs:FOLLOW.lostMs,distance:far}),undefined,'face lost');
  assert.equal(f.tick(10000+FOLLOW.freshMs+1,{...on,distance:far}),undefined,'old distance');
  assert.equal(f.tick(10000,{...on,distance:{...far,valid:false}}),undefined);
  for(const block of [{allowed:false},{moving:true},{ready:false}])assert.equal(f.tick(10000,{...on,...block,distance:far}),undefined,JSON.stringify(block));
  const nudge=f.tick(10000,{...on,yaw:-(FOLLOW.straightYaw+.02),distance:far});
  assert.deepEqual({y:nudge.y,z:nudge.z,why:nudge.why},{y:0,z:FOLLOW.speed,why:'turn'},'the sensor does not look at the face yet: the body turns a little toward it');
});
test('lifted, shaken or fallen: a move going is stopped, nothing starts',()=>{
  const f=new RoverFollow();
  assert.deepEqual(f.tick(0,{...on,unsafe:true,moving:true,distance:at(1500)}),{stop:true});
  assert.equal(f.tick(0,{...on,unsafe:true,distance:at(1500)}),undefined);
});
test('nobody in sight (15 Nov 2026: «se non mi vede il rover deve girarsi finché non mi vede»): turns on the spot, the same way, until a face',()=>{
  const f=new RoverFollow(STEPS),look={ready:true,allowed:true,search:true};let now=0;
  // The face was to the robot's left (yaw positive), then lost.
  assert.equal(f.tick(now,{...look,seenMs:100,yaw:.2,distance:at(600,now)}),undefined,'in sight, at the right distance: still');
  for(now=1000;now<FOLLOW.searchAfterMs;now+=500)assert.equal(f.tick(now,{...look,seenMs:now+100}),undefined,`just lost (${now} ms): it may come back`);
  const turns=[];
  for(;now<30000;now+=50){const step=f.tick(now,{...look,seenMs:now+100,moving:turns.length>0&&now<turns.at(-1).at+FOLLOW.searchMs});if(step)turns.push({...step,at:now,quick:f.quick});}
  assert.equal(f.steps,turns.length);
  for(const t of turns)assert.deepEqual({x:t.x,y:t.y,z:t.z,ms:t.ms,why:t.why},{x:0,y:0,z:-FOLLOW.searchSpeed,ms:FOLLOW.searchMs,why:'search'},'toward the side it was last seen, the robot\'s left, at the rover\'s limit');
  // «troppo lento»: the first turns come one a second, the later ones leave the slower detector its time.
  const gaps=turns.slice(1).map((t,i)=>t.at-turns[i].at),n=FOLLOW.searchQuickSteps;
  assert.ok(turns.length>n+3,`${turns.length} turns in 27 s`);
  for(let i=0;i<n;i++){assert.equal(gaps[i],FOLLOW.searchMs+FOLLOW.searchRestMs,`quick turn ${i+1}`);assert.equal(turns[i].quick,true);}
  for(let i=n;i<gaps.length;i++){assert.equal(gaps[i],FOLLOW.searchMs+FOLLOW.searchSlowRestMs,`slow turn ${i+1}`);assert.equal(turns[i+1].quick,false);}
  assert.ok(FOLLOW.searchRestMs>=400,'a quarter of a second for the picture to be still (mod.js wheelsStill) and a frame or two');
  assert.ok(FOLLOW.searchSlowRestMs>=1050,'the same and the 0.8 s of the slower detector');
  // Found, with the body still: the search ends and the face is followed again.
  now=turns.at(-1).at+FOLLOW.searchMs+FOLLOW.searchSlowRestMs+100;
  assert.equal(f.tick(now,{...look,seenMs:50,yaw:1}).why,'turn');assert.equal(f.steps,0);assert.equal(f.quick,false);
});
test('a face found by a frame whose answer comes when the next search turn has begun stops that turn',()=>{
  const f=new RoverFollow(STEPS),look={ready:true,allowed:true,search:true};
  f.tick(0,{...look,seenMs:Infinity});assert.equal(f.tick(FOLLOW.searchAfterMs,{...look,seenMs:Infinity}).why,'search');
  const from=FOLLOW.searchAfterMs;
  assert.equal(f.tick(from+100,{...look,moving:true,seenMs:Infinity}),undefined,'turning, nobody');
  assert.deepEqual(f.tick(from+200,{...look,moving:true,seenMs:50,yaw:.1}),{stop:true,why:'seen'});
  assert.equal(f.tick(from+300,{...look,seenMs:150,yaw:1}),undefined,'that sighting is of before the body stopped: a new look first');
  assert.equal(f.tick(from+200+FOLLOW.restMs,{...look,seenMs:40,yaw:1}).why,'turn');
  // A face seen before the turn began (a turn of following, not of search) stops nothing.
  const g=new RoverFollow();assert.equal(g.tick(0,{...on,yaw:1}).why,'turn');assert.equal(g.tick(100,{...on,moving:true,yaw:1}),undefined);
});
test('after a move of its own the next waits for a face seen with the body still again',()=>{
  const f=new RoverFollow(),turn=f.tick(0,{...on,yaw:1});
  assert.equal(turn.why,'turn');const end=turn.ms+FOLLOW.restMs;
  assert.equal(f.tick(end,{...on,seenMs:end-turn.ms+50,yaw:1}),undefined,'seen while the body was still turning: the head\'s yaw is of before');
  assert.equal(f.tick(end+50,{...on,seenMs:40,yaw:1}).why,'turn','seen after it stopped');
});
test('the search: never asleep or in a conversation (search false), never lifted, not allowed or with a move going; a voice starts it at once, to its side',()=>{
  const blind={ready:true,allowed:true,seenMs:Infinity};
  const f=new RoverFollow(STEPS);
  for(let now=0;now<60000;now+=500)assert.equal(f.tick(now,{...blind,search:false}),undefined,'asleep: the wheels rest');
  assert.equal(f.tick(60000,{...blind,search:true}),undefined,'awake again: the wait starts again');
  assert.equal(f.tick(60000+FOLLOW.searchAfterMs-1,{...blind,search:true}),undefined);
  assert.equal(f.tick(60000+FOLLOW.searchAfterMs,{...blind,search:true}).why,'search');
  for(const block of [{allowed:false},{ready:false},{moving:true},{unsafe:true}]){
    const g=new RoverFollow(STEPS);g.tick(0,{...blind,search:true});
    assert.equal(g.tick(20000,{...blind,search:true,...block}),undefined,JSON.stringify(block));
  }
  const v=new RoverFollow(STEPS);v.toward(-1);
  assert.deepEqual(v.tick(0,{...blind,search:true}),{x:0,y:0,z:FOLLOW.searchSpeed,ms:FOLLOW.searchMs,why:'search'},'a voice from the robot\'s right: that way, without waiting');
  assert.equal(v.tick(FOLLOW.searchMs+FOLLOW.searchRestMs,{...blind,search:true}).z,FOLLOW.searchSpeed,'and on the same way');
});
test('the face leaves the picture by one side (15 Nov 2026: «se vede la persona che sparisce sulla sinistra deve girarsi a sinistra e viceversa»): the search goes that way',()=>{
  const look={ready:true,allowed:true,search:true};
  for(const [gone,yaw,z,why] of [[1,0,-FOLLOW.searchSpeed,'left, the head straight'],[-1,0,FOLLOW.searchSpeed,'right, the head straight'],
    [-1,.15,FOLLOW.searchSpeed,'right, though the head is a little to the left: the picture says where the person went'],[1,-.15,-FOLLOW.searchSpeed,'left, the head a little to the right'],
    [0,.15,-FOLLOW.searchSpeed,'not clear: the side the head is turned to']]){
    const f=new RoverFollow(STEPS);
    f.tick(0,{...look,seenMs:100,yaw,gone,distance:at(600,0)});
    // Lost: whatever the picture's side becomes afterwards (a voice sets it in live-device.js), the side of the last sight is kept.
    let step;for(let now=1000;now<10000&&!step;now+=100)step=f.tick(now,{...look,seenMs:now+100,yaw,gone:-gone});
    assert.equal(step?.why,'search');assert.equal(step.z,z,why);
  }
});
test('a distance is fresh only on the robot\'s own clock (code review, 15 Nov 2026): one stamped with another clock, or in the future, moves nothing',()=>{
  const f=new RoverFollow(),now=60000;
  assert.equal(f.tick(now,{...on,distance:{mm:1500,at:Date.UTC(2026,10,15),valid:true}}),undefined,'stamped with the time of day: its age would be negative for ever');
  assert.equal(f.tick(now,{...on,distance:{mm:1500,at:now+1,valid:true}}),undefined);
  assert.equal(f.tick(now,{...on,distance:{mm:1500,at:now-FOLLOW.freshMs-1,valid:true}}),undefined,'old');
  assert.equal(f.tick(now,{...on,distance:{mm:1500,at:now-FOLLOW.freshMs,valid:true}}).why,'closer');
});
test('obstacle ahead (15 Nov 2026): a fresh reading nearer than stopMm, also under the sensor\'s 30 mm; nothing in range, an old one or none is not',()=>{
  const now=50000,fresh=mm=>({mm,at:now-50,valid:mm>=30&&mm<=2000});
  assert.equal(obstacleAhead(fresh(FOLLOW.stopMm-1),now),true);assert.equal(obstacleAhead(fresh(12),now),true,'right against the sensor');
  assert.equal(obstacleAhead(fresh(FOLLOW.stopMm),now),false);assert.equal(obstacleAhead(fresh(1500),now),false);
  assert.equal(obstacleAhead(fresh(8190),now),false,'nothing in range');assert.equal(obstacleAhead(fresh(0),now),false);
  assert.equal(obstacleAhead({mm:100,at:now-FOLLOW.freshMs-1,valid:true},now),false,'old');assert.equal(obstacleAhead({mm:100,at:now+10,valid:true},now),false,'another clock');
  assert.equal(obstacleAhead(undefined,now),false,'no sensor');
  // «Nothing in range» right after a near reading (tof-wire.js near:true, code check 19 Nov 2026): still an obstacle.
  assert.equal(obstacleAhead({mm:31,at:now-50,valid:false,near:true,raw:8190},now),true,'still against the sensor');
  const f=new RoverFollow(),seen={ready:true,moving:false,unsafe:false,allowed:true,seenMs:0,yaw:0,search:false,gone:0,still:true,spin:undefined};
  const step=f.tick(now,{...seen,distance:{mm:31,at:now-50,valid:false,near:true,raw:8190}});
  assert.ok(!step||!(step.y>0),'never forward with something still against the sensor');
});

// --- 16 Nov 2026, owner: «ottimizza inseguimento con rover».
// A pretend rover for the drive: says «moving» until the step's time is over, as rover-wire.js's own timer.
const drive=(f,{from=0,until,cycle=50,input})=>{
  const steps=[];let move;
  for(let now=from;now<=until;now+=cycle){
    if(move&&now>=move.end)move=undefined;
    const step=f.tick(now,{...on,moving:!!move,...input(now,move)});
    if(step?.stop){steps.push({at:now,...step});move=undefined;}
    else if(step){steps.push({at:now,...step});move={end:now+step.ms,...step};}
  }
  return steps;
};
test('driving: forward goes on without stopping while the face is in sight and the sensor says far; it stops where the place is reached',()=>{
  // The person stands 1.2 m in front (one go: under driveMaxMs); the rover covers 25 cm a second at 50 %, 15 at 30 %.
  let mm=1200;const f=new RoverFollow();
  const steps=drive(f,{until:12000,input:(now,move)=>{if(move)mm-=(move.y===FOLLOW.fastSpeed?250:150)*.05;return {seenMs:100,distance:at(Math.round(mm),now)};}});
  assert.equal(steps[0].why,'closer');assert.equal(steps[0].more,undefined);assert.equal(steps[0].look,true,'the camera goes on looking');
  const stop=steps.findIndex(s=>s.stop);assert.ok(stop>3,'renewed several times before arriving');
  for(const s of steps.slice(1,stop)){assert.equal(s.more,true);assert.equal(s.why,'closer');assert.ok(s.ms<=FOLLOW.driveMs);}
  for(let i=1;i<stop;i++)assert.ok(steps[i].at<steps[i-1].at+steps[i-1].ms,'each renewal comes before the stretch before it ends: the wheels never stop');
  assert.equal(steps[0].y,FOLLOW.fastSpeed,'far: at the rover\'s limit');assert.equal(steps[stop-1].y,FOLLOW.speed,'the last stretch slowly');
  assert.deepEqual({stop:steps[stop].stop,why:steps[stop].why},{stop:true,why:'arrived'});
  assert.ok(mm<=FOLLOW.keepMm+FOLLOW.arriveMm&&mm>=FOLLOW.keepMm-FOLLOW.bandMm,`stopped inside the band, at ${Math.round(mm)} mm`);
  assert.equal(steps.length,stop+1,'and there it stays');
  // Never more than the rover's own limit for one move in one go: then a look with the wheels still.
  const far=new RoverFollow(),long=drive(far,{until:8000,input:now=>({seenMs:100,distance:at(1900,now)})});
  const second=long.findIndex((s,i)=>i>0&&!s.more);
  assert.ok(second>0);const run=long[second-1].at+long[second-1].ms-long[0].at;
  assert.ok(run<=FOLLOW.driveMaxMs&&run>FOLLOW.driveMaxMs-FOLLOW.driveMs,`one go lasted ${run} ms`);
  assert.ok(long[second].at>=long[0].at+run+FOLLOW.restMs,'a pause, the wheels still');
  assert.ok(FOLLOW.driveMaxMs<=3000&&FOLLOW.fastSpeed<=50,'rover-wire.js ROVER_LIMITS');
});
test('driving is not renewed blind: the face lost, the head too far to one side, the distance old or gone; lifted, it stops at once',()=>{
  for(const [why,blind] of [['face lost',{seenMs:FOLLOW.lostMs}],['head to one side',{yaw:FOLLOW.turnYaw+.02}],['not allowed',{allowed:false}],['no rover',{ready:false}]]){
    const steps=drive(new RoverFollow(),{until:3000,input:now=>({seenMs:100,distance:at(1500,now),...(now>=300?blind:{})})});
    assert.equal(steps.filter(s=>s.at>=300&&s.why==='closer').length,0,why+': the stretch going is the last, the wheels\' own timer stops it');
  }
  for(const [why,distance] of [['old',now=>at(1500,Math.min(now,200))],['nothing in range, the person was near',now=>now<300?at(1000,now):{mm:8190,at:now,valid:false}],['under the sensor\'s range',now=>now<300?at(1500,now):{mm:12,at:now,valid:false}]]){
    const steps=drive(new RoverFollow(),{until:3000,input:now=>({seenMs:100,yaw:FOLLOW.fineYaw+.02,distance:distance(now)})});
    assert.equal(steps.filter(s=>s.at>=600&&s.why==='closer').length,0,why);
  }
  const f=new RoverFollow();assert.equal(f.tick(0,{...on,distance:at(1500)}).why,'closer');
  assert.deepEqual(f.tick(100,{...on,moving:true,unsafe:true,distance:at(1480,100)}),{stop:true});
  // The wheels taken by someone else (a spoken command, the iPhone): that move is not this one's to renew or to stop.
  const g=new RoverFollow();assert.equal(g.tick(0,{...on,distance:at(1500)}).why,'closer');g.release();
  for(let now=50;now<1500;now+=50)assert.equal(g.tick(now,{...on,moving:true,distance:at(now<700?1500:620,now)}),undefined);
});
test('steering while driving: the head a little to one side bends the drive that way, never much',()=>{
  const start=yaw=>new RoverFollow().tick(0,{...on,yaw,distance:at(1500)});
  assert.equal(start(0).z,0);assert.equal(start(FOLLOW.steerYaw-.01).z,0,'about straight: straight');
  const left=start(10*DEG),right=start(-10*DEG);
  assert.ok(left.z<0&&left.z>=-FOLLOW.steer,'the head to the robot\'s left: bending left (negative z)');assert.equal(right.z,-left.z);
  assert.equal(left.y,FOLLOW.fastSpeed);assert.equal(left.look,true);
  assert.ok(FOLLOW.steer<=15,'a bend, not a turn: the camera is looking meanwhile');
});
test('farther than the sensor sees (2 m): «nothing in range» means far only after the person was measured far, or after a while with the head really straight',()=>{
  const nothing=now=>({mm:8190,at:now,valid:false});
  // Walking away: 1.6 m, 1.9 m, then beyond the range. The body goes after them, at the rover's limit.
  let f=new RoverFollow();
  let steps=drive(f,{until:4000,input:now=>({seenMs:100,distance:now<200?at(1900,now):nothing(now)})});
  assert.equal(steps[0].why,'closer');assert.ok(steps.filter(s=>s.at>=600).length>2,'on, with nothing in range');
  assert.ok(steps.every(s=>s.y===FOLLOW.fastSpeed));
  // A person near and just beside the sensor's cone also reads «nothing»: no drive toward them.
  // The body turns toward them instead (until the head is within fineYaw), so that the sensor sees them.
  f=new RoverFollow();assert.equal(f.tick(0,{...on,yaw:.15,distance:at(700,0)}),undefined,'at the right distance');
  steps=drive(f,{from:50,until:6000,input:now=>({yaw:.15,distance:nothing(now)})});
  assert.ok(steps.length>0&&steps.every(s=>s.why==='turn'||s.why==='turned'),'near, a little to one side: turned to, never driven at');
  assert.ok(steps.filter(s=>!s.stop).every(s=>s.z<0&&s.y===0));assert.ok(FOLLOW.fineYaw<.15&&FOLLOW.fineYaw<FOLLOW.straightYaw);
  // Found far away without ever a measure (after a search): the head straight on the face for farDwellMs, then go.
  f=new RoverFollow();
  steps=drive(f,{until:FOLLOW.farDwellMs+1000,input:now=>({seenMs:100,distance:nothing(now)})});
  assert.ok(steps[0].at>=FOLLOW.farDwellMs&&steps[0].at<FOLLOW.farDwellMs+200,`began at ${steps[0].at} ms`);assert.equal(steps[0].why,'closer');
  // The face lost meanwhile: the count starts again. A reading that is old or missing: never.
  f=new RoverFollow();
  steps=drive(f,{until:4000,input:now=>({seenMs:now>=1000&&now<1100?FOLLOW.lostMs:100,distance:nothing(now)})});
  assert.ok(steps[0].at>=1100+FOLLOW.farDwellMs,'counted from when the face is in sight again');
  f=new RoverFollow();
  for(let now=0;now<5000;now+=50)assert.equal(f.tick(now,{...on,distance:now%1000?undefined:nothing(now)}),undefined,'no fresh reading');
  // The sensor sees them again: it is the sensor that says when the place is reached.
  f=new RoverFollow();let mm=2600;
  steps=drive(f,{until:15000,input:(now,move)=>{if(move)mm-=250*.05;return {seenMs:100,distance:mm>2000?(now<100?at(1950,now):nothing(now)):at(Math.round(mm),now)};}});
  assert.equal(steps.at(-1).why,'arrived');assert.ok(mm<=FOLLOW.keepMm+FOLLOW.arriveMm&&mm>=FOLLOW.keepMm-FOLLOW.bandMm,`at ${Math.round(mm)} mm`);
});

// The same pretend world as the page of scripts/sim-follow.mjs. Its speeds are guesses (see there): these numbers say
// that the deciding is sound and quicker than before, not how the real rover will go.
const world=(sim={})=>{const w=createWorld({RoverFollow,FOLLOW,sim:{roomW:12,roomH:12,...sim}});w.robot.x=6;w.robot.y=6;return w;};
const put=(w,metres,deg)=>{const a=w.robot.h+deg*DEG;w.person.x=w.robot.x+metres*Math.cos(a);w.person.y=w.robot.y-metres*Math.sin(a);};
const there=w=>Math.abs(w.range()*1000-FOLLOW.keepMm)<=FOLLOW.bandMm&&Math.abs(w.bearing())<13*DEG;
// Seconds until the rover is at its place in front of a person standing there, and has been for 2 s; searches made.
const reach=(metres,deg,sim)=>{
  const w=world(sim);put(w,metres,deg);let from,searches=0,moves=0;
  while(w.now<60000){for(const e of w.step().events)if(e.move){moves++;if(e.move.why==='search')searches++;}
    if(there(w)){from??=w.now;if(w.now-from>=2000)return {s:from/1000,searches,moves};}else from=undefined;}
  return {s:Infinity,searches,moves};
};
test('in the pretend world: a person standing 2 m in front is reached in half the time of before (12.4 s), in one go',()=>{
  const front=reach(1.9,0);
  assert.ok(front.s<=6.5,`${front.s} s`);assert.ok(front.moves<=3,`${front.moves} moves`);assert.equal(front.searches,0);
  assert.ok(reach(1.2,0).s<=3,'1.2 m: was 4.8 s');
  // In sight but to one side: turned to and reached without ever losing the face, whatever the real rover's turning
  // rate (half or twice the guess) and speed.
  for(const sim of [{},{fullTurn:75*DEG},{fullTurn:300*DEG},{fullSpeed:.25},{fullSpeed:1,fullTurn:300*DEG},{frameMs:500},{blindDrive:true}]){
    const side=reach(1.6,25,sim);
    assert.ok(Number.isFinite(side.s),JSON.stringify(sim));assert.equal(side.searches,0,'the face never lost: '+JSON.stringify(sim));
  }
  // The pictures too shaken to find a face while driving (not known yet): slower, still much quicker than before.
  assert.ok(reach(1.9,0,{blindDrive:true}).s<=8);
});
test('in the pretend world: a person who walks away is kept in sight; one beyond the sensor\'s 2 m is gone after; one walking round is not run into',()=>{
  const walk=(path,ms,sim)=>{const w=world(sim);let seen=0,most=0,least=9,searches=0;
    while(w.now<ms){path(w,w.now/1000);const s=w.step();if(w.now-s.lastSeen<FOLLOW.lostMs)seen+=w.sim.cycleMs;most=Math.max(most,s.range);least=Math.min(least,s.range);for(const e of s.events)if(e.move?.why==='search')searches++;}
    return {seen:seen/ms,most,least,searches,w};};
  // Away at 0.2 m/s for 20 s (before: lost after a few seconds, 3.6 m behind).
  const away=walk((w,t)=>{w.person.x=6.7+.2*Math.min(t,20);w.person.y=6;},40000);
  assert.ok(away.seen>.98&&away.most<1.2&&away.searches===0,JSON.stringify({seen:away.seen,most:away.most}));
  // Away 3 m at 0.5 m/s, faster than the rover: beyond the sensor's range, then standing. Before: never reached.
  const gone=walk((w,t)=>{w.person.x=6.7+Math.min(.5*t,3);w.person.y=6;},20000);
  assert.ok(gone.most>2.2,'they did get beyond the range');assert.ok(there(gone.w),`reached in the end: ${gone.w.range().toFixed(2)} m`);
  // Round the robot at 1.2 m, slowly: followed by turning, never driven at.
  const round=walk((w,t)=>{const a=.15*t/1.2;w.person.x=6+1.2*Math.cos(a);w.person.y=6-1.2*Math.sin(a);},40000);
  assert.ok(round.seen>.98&&round.least>=FOLLOW.keepMm/1000-FOLLOW.bandMm/1000,JSON.stringify({seen:round.seen,least:round.least}));
});
