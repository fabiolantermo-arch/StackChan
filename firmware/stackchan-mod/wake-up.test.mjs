// Waking up (wake-up.js): the times and the pictures. No robot.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {wakeBrightness,wakeEyes,WAKE_EYES,WAKE_EYES_MS,WAKE_FADE_MS,WAKE_YAWN_AT,YAWN_MOUTH,WAKE_YAWN,WAKE_HELLO} from './wake-up.js';
import {WAKE_STEPS} from './portrait-state.js';

test('from black: the light goes up and never down, to what it was, before the yawn',()=>{
  assert.equal(wakeBrightness(0,80),0);
  let last=0;for(let t=50;t<=WAKE_FADE_MS;t+=50){const v=wakeBrightness(t,80);assert.ok(v>=last&&v>=37&&v<=80,`${t}: ${v}`);last=v;}
  assert.equal(wakeBrightness(10,30),30,'a screen set dimmer than the first step that lights: no fade');
  assert.equal(wakeBrightness(WAKE_FADE_MS,80),80);assert.equal(wakeBrightness(99999,80),80);
  assert.ok(WAKE_YAWN_AT>=WAKE_FADE_MS,'the yawn comes with the face already lit');
});
test('the eyes: closed, half open, a sleepy droop, open; every picture exists',()=>{
  const steps=WAKE_EYES.map(([,step])=>step);
  assert.deepEqual(steps,[0,1,2,1,2,3,undefined]);
  for(const step of steps)assert.ok(step===undefined||step>=0&&step<WAKE_STEPS);
  assert.equal(wakeEyes(0),0);assert.equal(wakeEyes(300),1);assert.equal(wakeEyes(900),1);assert.equal(wakeEyes(WAKE_EYES_MS),undefined);
});
test('the yawn\'s mouth lasts as long as its recording, opens wide, and is shut for the «mmh» at the end',()=>{
  const wav=readFileSync(new URL('./assets/'+WAKE_YAWN,import.meta.url)),seconds=(wav.length-44)/2/16000;
  assert.ok(Math.abs(YAWN_MOUTH.length*.05-seconds)<.1,`${YAWN_MOUTH.length*.05} s of mouth, ${seconds} s of sound`);
  assert.match(YAWN_MOUTH,/^0/);assert.match(YAWN_MOUTH,/4{8}/);assert.match(YAWN_MOUTH,/0{10}$/);
  assert.ok(readFileSync(new URL('./assets/'+WAKE_HELLO,import.meta.url)).length>16000,'«Ciao, eccomi!» is there');
});
