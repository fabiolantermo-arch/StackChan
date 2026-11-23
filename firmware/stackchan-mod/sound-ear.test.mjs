// When a sound counts as «somebody is speaking, on that side». Pure arithmetic: no microphone.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SoundEar,readSound,sideOf,guessOf,EAR_MIN_LEVEL,EAR_AGAIN_MS,EAR_WINDOW_MS,EAR_NEED,EAR_MIDDLE,EAR_SIDE_LAG} from './sound-ear.js';
// The host's number for a piece of sound: level + 65536*quality(0…255) + 16777216*(sixteenths of a sample + 128).
const packed=(level,lag,quality)=>level+65536*Math.round(quality*255)+16777216*(Math.round(lag*16)+128);
// A quiet room for a while, so the ear knows how loud the room is.
const settled=(room=30)=>{const ear=new SoundEar();for(let t=0;t<3000;t+=100)ear.update(room,0,.3,t);return ear;};
// A voice: one piece every 100 ms from `from`, for `ms`.
const voice=(ear,from,ms,lag,{level=500,quality=.97}={})=>{const said=[];for(let t=from;t<from+ms;t+=100){const heard=ear.update(level,lag,quality,t);if(heard)said.push({...heard,at:t-from});}return said;};
// What the robot's two microphones really read while the owner spoke from his left, from the middle and from his
// right (14 Nov 2026, 13:41, «Prova orecchie»): [level, delay in samples, alike], in the order they came (76 in 20 s; only
// the pieces louder than the room were written on the log, so here they follow one another every 100 ms, as the
// robot's cycle reads them while somebody speaks).
const MEASURED=[
  [500,0.06,0.99],[753,0.13,0.99],[591,0.06,0.99],[252,0,0.97],[382,0.19,0.98],[316,0.13,0.98],[323,0.06,0.99],[308,0.13,0.98],
  [386,0.31,0.98],[415,0.13,0.97],[307,0.06,0.97],[276,0.06,0.96],[398,0.06,0.98],[195,-0.13,0.93],[337,-0.06,0.97],[221,0,0.96],
  [284,0.13,0.99],[353,0.13,0.99],[293,0.06,0.98],[280,0.06,0.98],[231,-0.25,0.94],[262,-0.06,0.95],[335,-0.13,0.97],[271,0.13,0.98],
  [315,0,0.97],[362,-0.06,0.97],[307,0.06,0.98],[398,0.19,0.98],[284,0,0.96],[370,-0.13,0.97],[266,0.5,0.95],[410,0,0.98],
  [329,0.06,0.98],[312,0.06,0.98],[611,-0.13,0.97],[667,-0.06,0.98],[324,-0.19,0.91],[535,-0.06,0.96],[492,-0.63,0.95],[253,-0.25,0.92],
  [330,-0.13,0.98],[270,-0.63,0.71],[451,-0.13,0.97],[393,-0.13,0.98],[341,-0.13,0.97],[397,-0.13,0.96],[524,-0.06,0.98],[435,0,0.98],
  [397,-0.06,0.97],[468,-0.06,0.97],[427,-0.13,0.99],[386,-0.06,0.98],[666,-0.19,0.98],[781,-0.38,0.98],[1018,-0.31,0.99],[604,-0.19,0.96],
  [477,-0.13,0.96],[674,-0.31,0.98],[679,-0.31,0.98],[605,-0.06,0.95],[505,-1.13,0.77],[580,-0.13,0.98],[487,-0.13,0.96],[345,-0.06,0.94],
  [479,-0.19,0.98],[431,-0.19,0.97],[461,0,0.95],[489,-0.56,0.98],[536,-0.63,0.98],[514,-0.38,0.98],[487,-0.19,0.97],[535,-0.19,0.98],
  [395,-0.19,0.97],[259,-0.25,0.88],[278,-0.13,0.96],[252,-0.31,0.9]
];
test('the host\'s number is read back: how loud, the delay to a sixteenth of a sample (both signs), how alike',()=>{
  const out={};
  assert.deepEqual(readSound(packed(812,-1.25,1),out),{level:812,quality:1,lag:-1.25});
  assert.deepEqual(readSound(packed(65535,6,0),out),{level:65535,quality:0,lag:6});
  assert.deepEqual(readSound(packed(1,-6,.2),out),{level:1,quality:51/255,lag:-6});
  assert.equal(readSound(0,out),undefined);assert.equal(readSound(undefined,out),undefined);
});
test('the side for a delay, as measured: the owner\'s left is the robot\'s right, and the middle is not zero',()=>{
  assert.equal(sideOf(.06),-1,'from his left (+0,06): the robot\'s right');
  assert.equal(sideOf(-.22),1,'from his right (−0,19…−0,25): the robot\'s left');
  assert.equal(sideOf(-.13),0,'from the middle (−0,13): not known');assert.equal(sideOf(EAR_MIDDLE),0);
  assert.equal(sideOf(EAR_MIDDLE+EAR_SIDE_LAG),-1);assert.equal(sideOf(EAR_MIDDLE-EAR_SIDE_LAG),1);
});
test('the readings measured on the robot, replayed: his left is heard as the robot\'s right, his right as its left, never the other way',()=>{
  const ear=settled(),said=[];
  MEASURED.forEach(([level,lag,quality],i)=>{const at=3000+i*100,heard=ear.update(level,lag,quality,at);if(heard)said.push({...heard,part:i/MEASURED.length});});
  assert.ok(said.length>=3,'a voice is heard again and again while he speaks, once every three seconds ('+said.length+' times)');
  const first=said.filter(heard=>heard.part<.4),last=said.filter(heard=>heard.part>.72);
  assert.ok(first.length>=1&&last.length>=1);
  assert.ok(first.every(heard=>heard.side<=0)&&first.some(heard=>heard.side===-1),'while he was on his left: the robot\'s right (or not known): '+JSON.stringify(first.map(heard=>heard.side)));
  assert.ok(last.every(heard=>heard.side>=0)&&last.some(heard=>heard.side===1),'while he was on his right: the robot\'s left (or not known): '+JSON.stringify(last.map(heard=>heard.side)));
});
test('a quiet room says nothing, however long',()=>{
  const ear=new SoundEar();
  for(let t=0;t<60000;t+=100)assert.equal(ear.update(30+10*Math.sin(t),.5,.97,t),undefined);
  assert.ok(ear.room>15&&ear.room<45);
});
test('a voice is said after about half a second of it, with its side; a clap or a knock is not a voice',()=>{
  for(const [lag,side] of [[.06,-1],[-.22,1],[-.12,0]]){
    const ear=settled(),said=voice(ear,3000,1500,lag);
    assert.equal(said.length,1,'once');assert.equal(said[0].side,side,'delay '+lag);assert.equal(said[0].at,(EAR_NEED-1)*100,'after the sixth piece');
    assert.ok(Math.abs(said[0].lag-lag)<1e-9);
  }
  const ear=settled();assert.deepEqual(voice(ear,3000,300,.06,{level:3000}),[],'three loud pieces: a clap');
  for(let t=3300;t<6000;t+=100)ear.update(30,0,.3,t);
  assert.deepEqual(voice(ear,6000,400,.06,{level:3000}),[],'and another one later does not add up to a voice');
});
test('stray readings do not decide: the middle one of the pieces does',()=>{
  const ear=settled(),lags=[.06,.5,.06,-1.13,.13,.06];let heard;
  lags.forEach((lag,i)=>{heard=ear.update(500,lag,.97,3000+i*100)??heard;});
  assert.equal(heard.side,-1);assert.ok(Math.abs(heard.lag-.06)<1e-9);
});
test('not a voice: too quiet, the two microphones hearing different things, a delay longer than they can give',()=>{
  const ear=settled();
  assert.deepEqual(voice(ear,3000,2000,.06,{level:EAR_MIN_LEVEL-1}),[],'too quiet');
  assert.deepEqual(voice(ear,5000,2000,.06,{quality:.6}),[],'not the same sound on both');
  assert.deepEqual(voice(ear,7000,2000,2.5),[],'an impossible delay');
});
test('after a voice, nothing more for a while: one wake for one call',()=>{
  const ear=settled(),said=voice(ear,3000,EAR_AGAIN_MS+2000,.06);
  assert.equal(said.length,2);assert.ok(said[1].at-said[0].at>=EAR_AGAIN_MS);
});
test('pieces too far apart in time are not one voice',()=>{
  const ear=settled();let said=0;
  for(let i=0;i<20;i++)if(ear.update(500,.06,.97,3000+i*(EAR_WINDOW_MS/3)))said++;
  assert.equal(said,0,'a loud piece every 0,4 s: never six within the window');
});
test('a steady noise that starts (a fan) becomes the room after a while and stops waking the robot',()=>{
  const ear=settled();let last;
  for(let t=3000;t<180000;t+=100)if(ear.update(400,.06,.97,t))last=t;
  assert.ok(last!==undefined,'heard at first');assert.ok(last<60000,'quiet about it within a minute (last at '+last+')');
  assert.ok(ear.room>130);
  // And when it stops the room is quiet again at once: a voice is a voice again.
  for(let t=180000;t<181000;t+=100)ear.update(30,0,.3,t);
  assert.equal(voice(ear,181000,1000,.06).length,1);
});

test('too near the middle to say: the side is not known, but there is a guess for where to look first',()=>{
  assert.equal(guessOf(.06),-1);assert.equal(guessOf(-.22),1);
  assert.equal(guessOf(EAR_MIDDLE+.01),-1);assert.equal(guessOf(EAR_MIDDLE-.01),1);
  // As heard on the robot at 15:57 (the owner was 61° to its right): not known, and the guess happens to be wrong.
  const ear=settled(),heard=voice(ear,3000,1000,-.13,{level:271})[0];
  assert.equal(heard.side,0);assert.equal(heard.guess,1);
  // A clear side: the guess is that side.
  for(const lag of [.06,-.22,-.47,.13]){const clear=voice(settled(),3000,1000,lag)[0];assert.notEqual(clear.side,0);assert.equal(clear.guess,clear.side);}
});

test('«guardalo e parla»: half a second of voice is enough (five pieces of the 100 ms cycle), four are not (14 Nov 2026)',async()=>{
  const {SoundEar,LOOK_NEED,LOOK_WINDOW_MS}=await import('./sound-ear.js');
  const ear=new SoundEar(LOOK_NEED,LOOK_WINDOW_MS);let now=0;
  for(let i=0;i<20;i++)ear.update(30,0,.3,now+=100); // the room
  for(let i=0;i<4;i++)assert.equal(ear.update(500,.06,.97,now+=100),undefined,'four pieces: not yet');
  assert.ok(ear.update(500,.06,.97,now+=100),'the fifth: a voice');
  const sleepy=new SoundEar();now=0;for(let i=0;i<20;i++)sleepy.update(30,0,.3,now+=100);
  for(let i=0;i<5;i++)assert.equal(sleepy.update(500,.06,.97,now+=100),undefined,'asleep: still six pieces');
});
