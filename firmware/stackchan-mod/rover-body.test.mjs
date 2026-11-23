// What the rover does by itself (rover-body.js): turns toward a voice, follows a face with the body, stops when lifted.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RoverBody,BODY} from './rover-body.js';
const free={ready:true,allowed:true};

test('5: lifted, shaken or fallen, a move is stopped at once and nothing starts until it stands quietly for a while',()=>{
  const body=new RoverBody();
  assert.deepEqual(body.tick(0,{...free,moving:true,unsafe:true}),{stop:true});
  body.voice(1);assert.equal(body.tick(10,{...free,unsafe:true}),undefined,'not moving: nothing to stop');
  assert.equal(body.free(100),false);
  assert.equal(body.tick(100,{...free}),undefined,'just put down: still waiting');
  assert.equal(body.tick(10+BODY.safeAfterMs,{...free}),undefined,'the voice heard while held is forgotten');
  assert.equal(body.free(10+BODY.safeAfterMs),true);
});
test('1: a voice from the robot\'s left turns the body left once, then it rests',()=>{
  const body=new RoverBody();body.voice(1);
  assert.deepEqual(body.tick(0,free),{z:BODY.yawToTurn*BODY.turnSpeed,ms:BODY.voiceTurnMs,why:'voice'});
  assert.equal(body.tick(100,free),undefined,'once');
  body.voice(-1);assert.equal(body.tick(200,free),undefined,'resting');
  assert.deepEqual(body.tick(BODY.voiceTurnMs+BODY.restMs,free),{z:-BODY.yawToTurn*BODY.turnSpeed,ms:BODY.voiceTurnMs,why:'voice'});
  body.voice(0);assert.equal(body.tick(99999,free),undefined,'side not known: no turn');
});
test('2: following a face with the head near the end of its turn for a moment, the body turns the same way',()=>{
  const body=new RoverBody(),wide={...free,following:true,yaw:BODY.followYaw+.1};
  assert.equal(body.tick(0,wide),undefined);
  assert.equal(body.tick(BODY.followHoldMs-1,wide),undefined,'not yet');
  assert.deepEqual(body.tick(BODY.followHoldMs,wide),{z:BODY.yawToTurn*BODY.turnSpeed,ms:BODY.turnMs,why:'face'});
  const right={...wide,yaw:-wide.yaw},t=BODY.followHoldMs+BODY.turnMs+BODY.restMs;
  assert.equal(body.tick(t,right),undefined);assert.equal(body.tick(t+BODY.followHoldMs,right).z,-BODY.yawToTurn*BODY.turnSpeed);
});
test('the body keeps still: head in the middle, no face, a move going, not allowed, no rover',()=>{
  const body=new RoverBody(),wide={...free,following:true,yaw:BODY.followYaw+.1};
  assert.equal(body.tick(0,{...wide,yaw:.2}),undefined);assert.equal(body.tick(5000,{...wide,yaw:.2}),undefined);
  assert.equal(body.tick(0,{...wide,following:false}),undefined);assert.equal(body.tick(5000,{...wide,following:false}),undefined);
  body.tick(10000,wide);assert.equal(body.tick(20000,{...wide,moving:true}),undefined);
  body.voice(1);assert.equal(body.tick(30000,{...wide,allowed:false}),undefined);assert.equal(body.tick(30001,{...free}),undefined,'the voice is forgotten when not allowed');
  body.voice(1);assert.equal(body.tick(40000,{...free,ready:false}),undefined);
  assert.equal(body.tick(40001,{...free}),undefined,'a voice heard while the rover did not answer is not kept for later');
});
