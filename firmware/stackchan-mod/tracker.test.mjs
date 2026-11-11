// The rules that choose the following image (FaceLock): whole frame, or a small window where the face must be.
// Pure arithmetic: no camera, network or motors.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FaceLock,CAMERA_FOV,LOCK_WAIT_MS,LOCK_AGE_MS,RETRY_MS,WIDE_MS} from './tracker.js';
const still={y:0,p:0};
const whole=(pose=still)=>({pose,window:undefined});
// A lock from a whole frame taken with the head straight, the face at x,y of the image.
const locked=(x=.5,y=.5,now=0)=>{const lock=new FaceLock();lock.answer(whole(),x,y,now);return lock;};
// One small frame leaves: what the robot does with a plan.
const send=(lock,now,pose=still)=>{const window=lock.plan(pose,now);lock.sent(window,now);return {pose,window};};

test('no face yet: the whole frame; while the robot listens, the halved one instead (never the whole frame)',()=>{
  const lock=new FaceLock();
  assert.equal(lock.plan(still,0),undefined);
  assert.deepEqual(lock.plan(still,0,true),{x0:0,y0:0,step:4,locked:false});
  assert.equal(lock.plan(undefined,0),undefined,'no head pose: nothing to work out');
});
// One small frame leaves while the robot listens in a conversation.
const hear=(lock,now,pose=still)=>{const window=lock.plan(pose,now,true);lock.sent(window,now);return {pose,window};};
test('listening with no face: the halved image and a 120×90 search window in turn; a face in either starts the usual following (10 Nov 2026)',()=>{
  const lock=new FaceLock();
  assert.deepEqual(hear(lock,0).window,{x0:0,y0:0,step:4,locked:false},'first the whole image halved: a face within 40 cm');
  const far=hear(lock,300);assert.deepEqual(far.window,{x0:20,y0:15,step:3,locked:false},'then the middle of the image at full detail: 40 cm to 1 m');
  assert.deepEqual(hear(lock,600).window,{x0:0,y0:0,step:4,locked:false},'and so on, in turn');
  assert.deepEqual(hear(lock,900).window,{x0:20,y0:15,step:3,locked:false});
  assert.equal(lock.since,undefined,'a search frame waits for no answer');assert.equal(lock.plan(still,1000),undefined,'not listening: the whole frame, as before');
  // A face in the search window: put back in whole-image coordinates, then followed as usual.
  assert.deepEqual(lock.answer(far,.25,.5,1000),{x:.3125,y:.5});assert.equal(lock.hits,0,'a search frame does not prove that the window size works');
  const next=hear(lock,1100);assert.deepEqual(next.window,{x0:0,y0:15,step:3,locked:true},'the window around the face');assert.equal(lock.since,1100);
  // A face in the halved image works the same way.
  const close=new FaceLock(),halved=hear(close,0);assert.deepEqual(close.answer(halved,.75,.75,200),{x:.75,y:.75});
  assert.deepEqual(close.plan(still,300,true),{x0:40,y0:30,step:3,locked:true});
  // clear() starts again from the halved image.
  const again=new FaceLock();hear(again,0);again.clear();assert.deepEqual(again.plan(still,100,true),{x0:0,y0:0,step:4,locked:false});
});
test('listening, the face at the border of the image: the search window goes where the face was last seen',()=>{
  const lock=new FaceLock();lock.answer(whole({y:.1,p:-.05}),.25,.5,0);
  const face=.1+.25*CAMERA_FOV.x,turned={y:face+.45*CAMERA_FOV.x,p:-.05};
  assert.deepEqual(hear(lock,10,turned).window,{x0:0,y0:0,step:4,locked:false},'first the halved image');
  assert.deepEqual(hear(lock,300,turned).window,{x0:40,y0:15,step:3,locked:false},'then the side of the image where the face was');
  assert.equal(lock.since,undefined);
});
test('a face found in the whole frame: the next image is the 120×90 window around where it must be now',()=>{
  const lock=new FaceLock();
  assert.deepEqual(lock.answer(whole(),.5,.5,0),{x:.5,y:.5},'whole-frame answers pass as they are');
  assert.deepEqual(lock.plan(still,10),{x0:20,y0:15,step:3,locked:true},'centred');
  // Bottom right of the frame: the window stops at the frame's edge.
  assert.deepEqual(locked(.75,.75).plan(still,10),{x0:40,y0:30,step:3,locked:true});
  assert.deepEqual(locked(.2,.2).plan(still,10),{x0:0,y0:0,step:3,locked:true});
  assert.deepEqual(locked(.4375,.625).plan(still,10),{x0:10,y0:30,step:3,locked:true});
});
test('the head has turned since: the window follows the face, not the old place in the image',()=>{
  // Face seen at a quarter of the frame with the head at 0.1 rad: it is 0.25 of the field of view to the left.
  const lock=new FaceLock();lock.answer(whole({y:.1,p:-.05}),.25,.5,0);
  const face=.1+.25*CAMERA_FOV.x;
  assert.deepEqual(lock.plan({y:face,p:-.05},10),{x0:20,y0:15,step:3,locked:true},'head on the face: the window is centred');
  assert.deepEqual(lock.plan({y:.1,p:-.05},10),{x0:0,y0:15,step:3,locked:true},'head where it was: the window is on the left');
  // Looking up moves the face down in the image.
  const up=new FaceLock();up.answer(whole(),.5,.5,0);
  assert.deepEqual(up.plan({y:0,p:-.25*CAMERA_FOV.y},10),{x0:20,y0:30,step:3,locked:true});
  // The face would be at the border of the frame or outside: the whole frame decides.
  assert.equal(lock.plan({y:face+.45*CAMERA_FOV.x,p:-.05},10),undefined);
  assert.deepEqual(lock.plan({y:face+.45*CAMERA_FOV.x,p:-.05},10,true),{x0:0,y0:0,step:4,locked:false},'listening: the halved frame');
});
test('an answer about a window is put back in whole-frame coordinates and keeps the lock where the face is',()=>{
  const lock=locked(.75,.75),frame=send(lock,100);
  assert.deepEqual(frame.window,{x0:40,y0:30,step:3,locked:true});
  assert.deepEqual(lock.answer(frame,.5,.5,300),{x:.625,y:.625},'the middle of the window');
  assert.deepEqual(lock.answer(frame,.25,.5,300),{x:.4375,y:.625});
  assert.deepEqual(lock.plan(still,350),{x0:10,y0:30,step:3,locked:true},'the next window moves with the face');
  // The halved whole frame (step 4) covers everything: its answers pass as they are.
  assert.deepEqual(lock.answer({pose:still,window:{x0:0,y0:0,step:4,locked:true}},.3,.6,400),{x:.3,y:.6});
});
test('an answer at the very edge is no place to remember: the head turns to that edge (of the window too), and the next frame is whole',()=>{
  // The centred window covers 20…140 of 160 and 15…105 of 120: its edges in the whole image.
  for(const [x,y,place] of [[0,.5,{x:.125,y:.5}],[1,.5,{x:.875,y:.5}],[.5,0,{x:.5,y:.125}],[.5,1,{x:.5,y:.875}],[0,0,{x:.125,y:.125}]]){
    const lock=locked(),frame=send(lock,100);
    assert.deepEqual(frame.window,{x0:20,y0:15,step:3,locked:true});
    assert.deepEqual(lock.answer(frame,x,y,300),place,`window answer ${x},${y}: the edge of the window, not of the camera`);
    assert.equal(lock.plan(still,350),undefined,'the whole frame next');
    // On the whole frame the edge still moves the head (a face cut by the image, a search step of the app).
    const other=locked();assert.deepEqual(other.answer(whole(),x,y,300),{x,y});assert.equal(other.plan(still,350),undefined);
  }
});
test('small frames left unanswered for a second and a half: the face is lost, the whole frame again',()=>{
  const lock=locked(),first=send(lock,100);
  assert.deepEqual(lock.answer(first,.5,.5,400),{x:.5,y:.5});
  send(lock,500);send(lock,750);
  assert.ok(lock.plan(still,500+LOCK_WAIT_MS-1),'not yet');
  assert.equal(lock.plan(still,500+LOCK_WAIT_MS),undefined,'the first small frame after the answer has waited too long');
  assert.equal(lock.step,3,'this size had worked: it is kept');assert.equal(lock.failed,0);
});
test('every answer starts the wait again: the iPhone skips the frames that reach it while it is answering (measured on the robot, 10 Nov 2026)',()=>{
  // A small frame sent before the answer arrived does not wait for one: the iPhone was busy when it got there.
  const lock=locked(),a=send(lock,100);send(lock,350);
  lock.answer(a,.5,.5,600);
  assert.ok(lock.plan(still,350+LOCK_WAIT_MS),'the frame of 350 will get no answer, and the face is not lost for that');
  // The first one sent after the answer does: the iPhone was free again when it got there.
  const next=locked(),b=send(next,100);send(next,350);next.answer(b,.5,.5,600);send(next,700);send(next,950);
  assert.ok(next.plan(still,700+LOCK_WAIT_MS-1),'not yet');
  assert.equal(next.plan(still,700+LOCK_WAIT_MS),undefined,'no answer for the frame of 700');
  // Answers that keep coming keep the lock for as long as they do, however many frames go unanswered in between.
  const steady=locked();
  for(let now=100;now<20000;now+=300){const frame=send(steady,now);assert.ok(frame.window?.locked,`small frame at ${now}`);if(now%900===100)steady.answer(frame,.5,.5,now+250);}
  const kept=locked(),only=send(kept,100);kept.answer(only,.5,.5,400);
  assert.ok(kept.plan(still,400+LOCK_AGE_MS-1),'nothing waits: the place is kept');
  assert.equal(kept.plan(still,400+LOCK_AGE_MS),undefined,'3 s without any answer: too old to trust');
});
test('never an answer at one size: the other size next time, then whole frames only for 10 s',()=>{
  const lock=locked(),first=100+LOCK_WAIT_MS;send(lock,100);send(lock,350);
  assert.equal(lock.plan(still,first),undefined);assert.equal(lock.step,4,'the 120×90 window got nothing: the halved frame next');
  lock.answer(whole(),.5,.5,first+300);
  const halved=send(lock,first+400),second=first+400+LOCK_WAIT_MS;assert.deepEqual(halved.window,{x0:0,y0:0,step:4,locked:true});
  assert.equal(lock.plan(still,second),undefined);
  // Both failed: whole frames, even with a fresh place.
  lock.answer(whole(),.5,.5,second+300);
  assert.equal(lock.plan(still,second+400),undefined);assert.deepEqual(lock.plan(still,second+400,true),{x0:0,y0:0,step:4,locked:false});
  lock.answer(whole(),.5,.5,second+WIDE_MS-100);
  assert.equal(lock.plan(still,second+WIDE_MS-1),undefined);
  assert.deepEqual(lock.plan(still,second+WIDE_MS),{x0:20,y0:15,step:3,locked:true},'10 s later: the window is tried again');
});
test('the size that works is kept, and a failure is forgotten after 4 s (the person had only gone away)',()=>{
  // Near face: the window fails, the halved frame works and stays.
  const lost=100+LOCK_WAIT_MS;
  const near=locked();send(near,100);assert.equal(near.plan(still,lost),undefined);
  near.answer(whole(),.5,.5,lost+300);const frame=send(near,lost+400);assert.equal(frame.window.step,4);
  near.answer(frame,.5,.5,lost+700);assert.equal(near.failed,0);
  send(near,lost+800);assert.equal(near.plan(still,lost+800+LOCK_WAIT_MS),undefined);assert.equal(near.step,4,'lost after it worked: the same size next time');
  // The person left just after being found, and comes back later: the window again, not the halved frame.
  const away=locked();send(away,100);assert.equal(away.plan(still,lost),undefined);assert.equal(away.step,4);
  assert.equal(away.plan(still,lost+RETRY_MS-1),undefined);assert.equal(away.step,4);
  assert.equal(away.plan(still,lost+RETRY_MS),undefined);assert.equal(away.step,3);assert.equal(away.failed,0);
  away.answer(whole(),.5,.5,lost+RETRY_MS+1200);assert.deepEqual(away.plan(still,lost+RETRY_MS+1300),{x0:20,y0:15,step:3,locked:true});
});
test('frames that are not locked small ones do not count as waiting; clear forgets everything',()=>{
  const lock=locked();lock.sent(undefined,100);lock.sent({x0:0,y0:0,step:4,locked:false},200);
  assert.ok(lock.plan(still,2000),'whole and listening frames start no wait');
  lock.clear();assert.equal(lock.plan(still,2100),undefined);assert.equal(lock.step,3);
  const empty=new FaceLock();empty.sent({x0:0,y0:0,step:3,locked:true},0);assert.equal(empty.since,undefined,'no face: nothing waits');
});
test('the clock starting again from the bottom never keeps a lock for ever',()=>{
  const lock=locked(.5,.5,2**31-500);send(lock,2**31-400);
  assert.equal(lock.plan(still,-(2**31)+100),undefined,'a wait that looks negative counts as over');
});
