// The RoverC Pro (rover-wire.js): the bytes of M5Stack's I2C protocol and the robot's own limits. No rover needed.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {wheelSpeeds,motorMessage,stopMessage,clampSpeed,createRover,gripMessage,GRIP,ROVER_ADDRESS,ROVER_PINS,ROVER_LIMITS,STOP_RETRY} from './rover-wire.js';
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join(' ');

test('the four wheels: forward, sideways and turning mixed as M5Stack\'s library does, within the limit',()=>{
  assert.deepEqual(wheelSpeeds({y:40}),[40,40,40,40]);
  assert.deepEqual(wheelSpeeds({x:40}),[40,-40,-40,40]);
  assert.deepEqual(wheelSpeeds({z:40}),[-40,40,-40,40]);
  assert.deepEqual(wheelSpeeds({y:50,z:50}),[-25,75,-25,75],'turning takes room from going forward');
  assert.deepEqual(wheelSpeeds({x:80,y:80},50),[50,0,0,50],'never beyond the limit');
  assert.deepEqual(wheelSpeeds({y:'x'}),[0,0,0,0]);
  assert.equal(clampSpeed(-300,50),-50);assert.equal(clampSpeed(10,-5),0);
});
test('the bytes: register 0x00 then four int8 speeds, −100…100 as they are, like M5Stack\'s library (15 Nov 2026)',()=>{
  assert.equal(hex(motorMessage([100,-100,50,0])),'00 64 9c 32 00');assert.equal(hex(motorMessage([30,-30,0,0])),'00 1e e2 00 00','30 is 30 on the wire');
  assert.equal(hex(stopMessage()),'00 00 00 00 00');
  assert.equal(hex(motorMessage([500,0,0,0])),'00 64 00 00 00','never beyond 100');
});
function pretend({missing=false,refuse=false}={}){
  const writes=[],lines=[],timers=new Map();let id=0,failing=false;
  class I2C{constructor(options){if(refuse)throw Error('inUse');this.options=options;lines.push(this);}write(buffer){if(missing||failing)throw Error('write failed');writes.push(hex(new Uint8Array(buffer)));}close(){this.closed=true;}}
  return {I2C,writes,lines,timers,fail(on){failing=on;},timer:{set:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clear:t=>timers.delete(t)},run(){const all=[...timers];timers.clear();for(const [,t] of all)t.fn();}};
}
test('opens on Port A at 0x38 and stops the wheels first; nothing moves before',()=>{
  const p=pretend(),rover=createRover({I2C:p.I2C,timer:p.timer});
  assert.equal(rover.move({y:30}),false,'not open yet');assert.equal(p.writes.length,0);
  assert.equal(rover.open(),true);assert.equal(rover.state,'ready');
  assert.deepEqual({data:p.lines[0].options.data,clock:p.lines[0].options.clock,address:p.lines[0].options.address},{...ROVER_PINS,address:ROVER_ADDRESS});
  assert.deepEqual(p.writes,['00 00 00 00 00']);
});
test('every move is stopped by the robot itself, never later than the limit',()=>{
  const p=pretend(),rover=createRover({I2C:p.I2C,timer:p.timer});rover.open();
  assert.equal(rover.move({y:30},60000),true);assert.equal(rover.moving,true);
  assert.equal([...p.timers.values()][0].ms,ROVER_LIMITS.moveMs);
  assert.equal(p.writes.at(-1),hex(motorMessage([30,30,30,30])));
  p.run();assert.equal(p.writes.at(-1),'00 00 00 00 00');assert.equal(rover.moving,false);
  rover.go('forward',100,500);assert.equal(p.writes.at(-1),hex(motorMessage([50,50,50,50])),'never beyond maxSpeed');
  assert.equal(rover.go('fly'),false);
});
test('no rover on the wire: not ready, the line is given back; a failed write stops and is not a success',()=>{
  let p=pretend({missing:true}),rover=createRover({I2C:p.I2C,timer:p.timer});
  assert.equal(rover.open(),false);assert.equal(rover.state,'error');assert.equal(p.lines[0].closed,true);
  p=pretend({refuse:true});rover=createRover({I2C:p.I2C,timer:p.timer});assert.equal(rover.open(),false);
  p=pretend();rover=createRover({I2C:p.I2C,timer:p.timer});rover.open();
  p.fail(true);assert.equal(rover.move({z:30}),false);assert.equal(rover.state,'error');assert.equal(rover.moving,true,'the stop after it was not confirmed either');
  p.fail(false);assert.equal(rover.open(),true,'can be opened again');assert.equal(rover.moving,false,'opening writes the zero');assert.equal(p.timers.size,0);
});
test('the gripper (15 Nov 2026): servo 1, one byte at 0x10, only the two angles of M5Stack\'s example; a failed write is not a success',()=>{
  assert.equal(hex(gripMessage('gripOpen')),'10 5a');assert.equal(hex(gripMessage('gripClose')),'10 0a');
  assert.equal(hex(gripMessage('gripHalf')),'10 32','«chiudi poco»: half way');assert.ok(GRIP.half>Math.min(GRIP.open,GRIP.closed)&&GRIP.half<Math.max(GRIP.open,GRIP.closed),'between the two, never beyond');
  assert.equal(gripMessage('gripWide'),null);assert.equal(gripMessage('forward'),null);
  assert.deepEqual([GRIP.open,GRIP.closed].sort((a,b)=>a-b),[10,90],'nothing beyond what M5Stack itself sends');
  const p=pretend(),rover=createRover({I2C:p.I2C,timer:p.timer});
  assert.equal(rover.grip('gripOpen'),false,'not before the rover answers');
  rover.open();const before=p.writes.length;
  assert.equal(rover.grip('gripClose'),true);assert.deepEqual(p.writes.slice(before),['10 0a']);assert.equal(rover.moving,false,'no wheel turns, nothing to stop');
  assert.equal(rover.grip('gripSideways'),false);assert.equal(p.writes.length,before+1);
  // While the wheels turn the gripper may move: the move goes on and is stopped as always.
  rover.go('forward',30,500);assert.equal(rover.grip('gripOpen'),true);assert.equal(rover.moving,true);p.run();assert.equal(p.writes.at(-1),'00 00 00 00 00');
  // A failed write of the gripper with the wheels still: not a success, but the rover stays usable (review, 23 Nov 2026).
  p.fail(true);assert.equal(rover.grip('gripOpen'),false);assert.equal(rover.state,'ready','the wheels were still: nothing else stops');
  // With the wheels turning, it stops everything as any failed write.
  p.fail(false);rover.go('forward',30,500);p.fail(true);assert.equal(rover.grip('gripOpen'),false);assert.equal(rover.state,'error');
});
test('after a failed write the rover is «in error»; its stop says still when the zero went then; open() takes it back (review, 23 Nov 2026)',()=>{
  const p=pretend(),rover=createRover({I2C:p.I2C,timer:p.timer});rover.open();
  rover.go('back',30,500);p.fail(true);assert.equal(rover.go('back',30,500),false);assert.equal(rover.state,'error');
  // fail() tried the zero on the line that failed: it did not go, so it is owed and tried again.
  assert.equal(rover.moving,true,'a stop owed counts as moving');assert.equal(rover.stop(),false,'not known still');
  p.fail(false);assert.equal(rover.stop(),true,'the zero went now');assert.equal(rover.moving,false);
  assert.equal(rover.stop(),true,'in error, nothing moved since: still');
  assert.equal(rover.open(),true);assert.equal(rover.state,'ready');assert.equal(rover.go('back',30,500),true,'usable again');
});
test('close stops the wheels and gives the line back',()=>{
  const p=pretend(),rover=createRover({I2C:p.I2C,timer:p.timer});rover.open();rover.move({y:30});
  rover.close();assert.equal(p.writes.at(-1),'00 00 00 00 00');assert.equal(p.lines[0].closed,true);assert.equal(p.timers.size,0);assert.equal(rover.state,'closed');
});
// External review of 17 Nov 2026, R1: the move is taken, then the bus refuses every stop. Before, the firmware said
// «not moving» with no timer left and the wheels turning.
test('a stop the rover did not take is never a success: it stays owed and is tried again until the zero is written',()=>{
  const p=pretend(),rover=createRover({I2C:p.I2C,timer:p.timer});rover.open();
  assert.equal(rover.go('forward',30,500),true);const turning=p.writes.at(-1);
  p.fail(true);assert.equal(rover.stop(),false);
  assert.equal(p.writes.at(-1),turning,'the wheels still have the speed');
  assert.equal(rover.moving,true,'not known to be still');assert.equal(rover.unstopped,true);assert.equal(rover.state,'error');
  assert.equal(p.timers.size,1,'a new try is booked');assert.equal([...p.timers.values()][0].ms,STOP_RETRY.fastMs);
  for(let i=0;i<STOP_RETRY.fast+2;i++){p.run();assert.equal(p.timers.size,1,'still trying');assert.equal(rover.moving,true);}
  assert.equal([...p.timers.values()][0].ms,STOP_RETRY.slowMs,'then slowly, but never given up');
  assert.equal(rover.stop(),false,'asked again while the bus is down: tried, still not a success');assert.equal(p.timers.size,1);
  assert.equal(rover.move({y:30}),false,'no new move meanwhile');
  p.fail(false);p.run();
  assert.equal(p.writes.at(-1),'00 00 00 00 00','the zero reached the rover');assert.equal(rover.moving,false);assert.equal(rover.unstopped,false);assert.equal(p.timers.size,0);
});
test('the move\'s own timed stop fails: owed and tried again; a stop asked meanwhile succeeds as soon as the bus is back',()=>{
  const p=pretend(),rover=createRover({I2C:p.I2C,timer:p.timer});rover.open();rover.go('left',30,500);
  p.fail(true);p.run();assert.equal(rover.moving,true);assert.equal(rover.unstopped,true);assert.equal(p.timers.size,1);
  p.fail(false);assert.equal(rover.stop(),true,'written now');assert.equal(p.writes.at(-1),'00 00 00 00 00');assert.equal(rover.moving,false);assert.equal(p.timers.size,0);
});
test('close with the wheels turning and the bus down: the line is given back, the stop is still owed',()=>{
  const p=pretend(),rover=createRover({I2C:p.I2C,timer:p.timer});rover.open();rover.go('forward',30,500);
  p.fail(true);rover.close();assert.equal(rover.state,'closed');assert.equal(rover.moving,true);assert.equal(p.timers.size,1);
  p.fail(false);p.run();assert.equal(p.writes.at(-1),'00 00 00 00 00');assert.equal(rover.moving,false);assert.equal(p.timers.size,0);
});

test('every positive forward translation consults the guard, including direct mixed and renewed moves',()=>{
  const p=pretend();let safe=true;
  const rover=createRover({I2C:p.I2C,timer:p.timer,allowForward:()=>safe});rover.open();
  assert.equal(rover.go('forward',30,500),true);assert.equal(rover.advancing,true);
  safe=false;assert.equal(rover.move({x:10,y:30,z:5},500),false);
  assert.equal(p.writes.at(-1),'00 00 00 00 00');assert.equal(rover.moving,false);
  assert.equal(rover.go('forward',30,500),false);
  assert.equal(rover.go('back',30,500),true);assert.equal(rover.advancing,false);rover.stop();
  assert.equal(rover.go('turnLeft',30,500),true);rover.stop();
  assert.equal(rover.grip('gripOpen'),true);
});
