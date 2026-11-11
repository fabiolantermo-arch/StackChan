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
test('the «Discreta» scheme: off at rest, the most important light wins',()=>{
  assert.equal(lightFor(),'off');
  assert.equal(lightFor({voice:'idle'}),'off');
  assert.equal(lightFor({voice:'listening'}),'listening');
  assert.equal(lightFor({voice:'thinking'}),'thinking');
  assert.equal(lightFor({voice:'connecting'}),'thinking','connecting blinks like thinking');
  assert.equal(lightFor({voice:'speaking'}),'speaking');
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
  lights.update({voice:'listening'},0);assert.deepEqual(lighting.calls,[['on','head',0,35,64]]);
  lights.update({voice:'listening'},100);assert.equal(lighting.calls.length,1,'same light: no I2C traffic');
  lights.update({voice:'thinking'},200);assert.deepEqual(lighting.calls.slice(1),[['off','head'],['blink','head',0,35,64,1200]]);
  lights.update({voice:'speaking'},300);assert.deepEqual(lighting.calls.at(-1),['on','head',64,43,23]);
  lights.update({live:true},400);assert.deepEqual(lighting.calls.at(-1),['on','head',38,0,64]);
  lights.update({},500);assert.deepEqual(lighting.calls.at(-1),['off','head']);
  for(const {color} of Object.values(LIGHTS))assert.ok(color.every(v=>v*LIGHT_LEVEL<=64),'never above a quarter of full brightness');
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
