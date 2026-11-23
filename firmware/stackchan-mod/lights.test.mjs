// Head lights: which light for which state, and what reaches the host's LED driver.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lightFor,HeadLights,LIGHTS,LIGHT_LEVEL,ERROR_FLASH_MS} from './lights.js';
const fakeLighting=({fail=false}={})=>{
  const calls=[];
  return {calls,led:{head:{}},
    lightOn(name,r,g,b){if(fail)throw Error('i2c');calls.push(['on',name,r,g,b]);},
    lightBlink(name,r,g,b,period){calls.push(['blink',name,r,g,b,period]);},
    lightOff(name){calls.push(['off',name]);}};
};
test('the lights: off at rest, the most important light wins',()=>{
  assert.equal(lightFor(),'off');
  assert.equal(lightFor({voice:'idle'}),'off');
  assert.equal(lightFor({voice:'listening'}),'listening');
  assert.equal(lightFor({voice:'thinking'}),'thinking');
  assert.equal(lightFor({voice:'connecting'}),'thinking','connecting blinks like thinking');
  assert.equal(lightFor({voice:'speaking'}),'speaking');assert.equal(lightFor({voice:'searching'}),'searching');assert.equal(lightFor({voice:'looking'}),'looking');
  assert.equal(lightFor({voice:'searching',reminder:true,live:true}),'searching');assert.equal(lightFor({error:true,voice:'searching'}),'error');
  // Every light is told apart by its colour or by blinking.
  {const seen=new Set();for(const [name,{color,blink,alternate}] of Object.entries(LIGHTS)){const key=color.join()+(alternate?'/'+alternate.join():blink?'b':'');assert.ok(!seen.has(key),name);seen.add(key);}}
  assert.equal(lightFor({live:true}),'live');
  assert.equal(lightFor({reminder:true,live:true}),'reminder','a reminder shows over the Live light');
  assert.equal(lightFor({voice:'listening',reminder:true,live:true}),'listening','the conversation shows over reminder and Live');
  assert.equal(lightFor({pairing:true,voice:'speaking'}),'pairing');
  assert.equal(lightFor({error:true,pairing:true,voice:'speaking',live:true}),'error');
});
test('whenever the microphone or the camera is in use a light is on',()=>{
  for(const voice of ['connecting','listening','thinking'])for(const live of [false,true])assert.notEqual(lightFor({voice,live}),'off');
  assert.notEqual(lightFor({live:true}),'off','Live: camera, call or following');
});
test('colours at «Media» brightness, blinks start from dark, nothing rewritten without a change',()=>{
  const lighting=fakeLighting(),lights=new HeadLights(lighting);assert.equal(lights.available,true);
  assert.equal(lights.update({voice:'idle'},0),false,'already off: no write');
  lights.update({voice:'listening'},0);assert.deepEqual(lighting.calls,[['on','head',0,64,10]],'green: listening (owner, 12 Nov 2026)');
  lights.update({voice:'listening'},100);assert.equal(lighting.calls.length,1,'same light: no I2C traffic');
  lights.update({voice:'thinking'},200);assert.deepEqual(lighting.calls.slice(1),[['off','head'],['blink','head',64,64,64,1200]],'white blink: the reply is coming');
  lights.update({voice:'speaking'},300);assert.deepEqual(lighting.calls.at(-1),['on','head',0,13,64],'blue: speaking');
  lights.update({voice:'searching'},320);assert.deepEqual(lighting.calls.at(-1),['on','head',64,43,0],'yellow: searching the web');
  lights.update({voice:'looking'},340);assert.deepEqual(lighting.calls.at(-1),['on','head',0,55,55],'turquoise: looking at what you show');
  lights.update({reminder:true},360);assert.deepEqual(lighting.calls.at(-1),['blink','head',64,8,30,1000],'pink blink: a reminder, no longer the yellow of the search');
  lights.update({live:true},400);assert.deepEqual(lighting.calls.at(-1),['on','head',38,0,64]);
  lights.update({},500);assert.deepEqual(lighting.calls.at(-1),['off','head']);
  for(const {color} of Object.values(LIGHTS))assert.ok(color.every(v=>v*LIGHT_LEVEL<=64),'never above a quarter of full brightness');
});
test('speaking with the angry face: red and yellow in turn, one write at each half second (12 Nov 2026)',()=>{
  const lighting=fakeLighting(),lights=new HeadLights(lighting);
  assert.equal(lightFor({voice:'speaking',angry:true}),'angry');assert.equal(lightFor({voice:'listening',angry:true}),'listening','green stays the sign that it is your turn');
  assert.equal(lightFor({voice:'idle',angry:true}),'off');assert.equal(lightFor({voice:'speaking',angry:true,error:true}),'error');
  lights.update({voice:'speaking',angry:true},1000);assert.deepEqual(lighting.calls,[['on','head',64,0,0]],'red first, no host blink');
  for(const now of [1100,1200,1300,1400])lights.update({voice:'speaking',angry:true},now);assert.equal(lighting.calls.length,1,'no write within the half second');
  lights.update({voice:'speaking',angry:true},1500);assert.deepEqual(lighting.calls.at(-1),['on','head',64,43,0],'then yellow');
  lights.update({voice:'speaking',angry:true},1900);assert.equal(lighting.calls.length,2);
  lights.update({voice:'speaking',angry:true},2000);assert.deepEqual(lighting.calls.at(-1),['on','head',64,0,0],'red again');
  lights.update({voice:'listening',angry:true},2100);assert.deepEqual(lighting.calls.at(-1),['on','head',0,64,10]);
  lights.update({voice:'speaking',angry:true},5250);assert.deepEqual(lighting.calls.at(-1),['on','head',64,0,0],'each time it starts from red');
  lights.update({voice:'speaking',angry:false},5300);assert.deepEqual(lighting.calls.at(-1),['on','head',0,13,64],'no longer angry: blue');
  const failing=new HeadLights({led:{head:{}},lightOn(){if(this.n++)throw Error('i2c');},n:0});failing.update({voice:'speaking',angry:true},0);
  assert.equal(failing.update({voice:'speaking',angry:true},500),false);assert.equal(failing.available,false,'a failing driver stops the light, never the robot');
});
test('an error flashes red three times, then the light of the state returns',()=>{
  const lighting=fakeLighting(),lights=new HeadLights(lighting);
  lights.update({live:true},1000);lights.flashError(1000);lights.update({live:true},1000);
  assert.deepEqual(lighting.calls.slice(-2),[['off','head'],['blink','head',64,0,0,600]]);
  assert.equal(ERROR_FLASH_MS,3*LIGHTS.error.blink,'three blinks');
  lights.update({live:true},1000+ERROR_FLASH_MS-1);assert.deepEqual(lighting.calls.at(-1)[0],'blink');
  lights.update({live:true},1000+ERROR_FLASH_MS);assert.deepEqual(lighting.calls.at(-1),['on','head',38,0,64]);
  lights.flashError(NaN);lights.update({live:true},5000);assert.deepEqual(lighting.calls.at(-1),['on','head',38,0,64],'an invalid clock does not flash');
});
test('without LEDs, or with a failing driver, the robot carries on with the lights off',()=>{
  for(const lighting of [undefined,{},{led:{}},{led:{a:{}}}]){const lights=new HeadLights(lighting);assert.equal(lights.available,false);assert.equal(lights.update({voice:'listening'},0),false);lights.close();}
  const failing=fakeLighting({fail:true}),lights=new HeadLights(failing);
  assert.equal(lights.update({voice:'listening'},0),false);assert.equal(lights.available,false,'stops writing after the first failure');
  assert.equal(lights.update({voice:'thinking'},100),false);assert.equal(failing.calls.length,0);
});
test('closing turns the lights off',()=>{
  const lighting=fakeLighting(),lights=new HeadLights(lighting);lights.update({voice:'speaking'},0);lights.close();
  assert.deepEqual(lighting.calls.at(-1),['off','head']);
});
