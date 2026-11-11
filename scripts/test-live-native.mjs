// Explicit test of production Swift client against a virtual device through Robottino cloud.
import {readFile,mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {DeviceCommands,encodeMedia,cameraChunks} from '../firmware/stackchan-mod/live-wire.js';
const root=fileURLToPath(new URL('../',import.meta.url)),base='https://robottino-stackchan.example.workers.dev',temporary=await mkdtemp(path.join(tmpdir(),'robottino-native-live-'));
const binary=path.join(temporary,'live-test');
const compilation=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5','-target',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macosx14.0`,'-module-cache-path',path.join(temporary,'ModuleCache'),path.join(root,'ios/Robottino/RobotLiveCore.swift'),path.join(root,'ios/test-live-cloud.swift'),'-o',binary],{stdio:'inherit'});
if(compilation.status!==0)process.exit(compilation.status??1);
const appToken=(await readFile(path.join(root,'private/robot-token'),'utf8')).trim(),deviceToken=(await readFile(path.join(root,'private/robot-device-token'),'utf8')).trim();
const status=await fetch(base+'/api/robot/status',{headers:{Authorization:'Bearer '+appToken},signal:AbortSignal.timeout(10000)});assert.equal(status.status,200);assert.equal((await status.json()).connected,false,'Existing robot will not be replaced');
const device=new WebSocket(base.replace('https:','wss:')+'/api/robot/device',{headers:{Authorization:'Bearer '+deviceToken},handshakeTimeout:10000,maxPayload:65535});
const events=[];let seq=0,heartbeat,child;
const io=Object.fromEntries(['camera','call','screen','motion','face','faceStyle','dance','stop','audio','image'].map(name=>[name,value=>events.push(name)]));
const controller=new DeviceCommands(io,value=>{
  device.send(JSON.stringify(value));
  const action=actions.get(value.id);
  if(value.ok&&action==='camera.start')for(const chunk of cameraChunks(1,new ArrayBuffer(153600),320,240,()=>++seq))device.send(chunk);
  if(value.ok&&action==='call.start')device.send(encodeMedia(3,++seq,new ArrayBuffer(640)));
});
const actions=new Map();
device.on('message',(data,binary)=>{try{if(binary)controller.media(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength));else{const event=JSON.parse(data.toString());if(event.type==='command'){actions.set(event.id,event.action);void controller.command(event);}}}catch{device.close();}});
try{
  await new Promise((resolve,reject)=>{device.once('open',resolve);device.once('error',reject);});
  const hello=()=>device.send(JSON.stringify({type:'hello',capabilities:{hardwareVerified:true,calibrated:true,motion:true,camera:true,audio:true,screen:true,simulated:true}}));hello();
  heartbeat=setInterval(()=>{if(device.readyState===WebSocket.OPEN){device.send('{"type":"ping"}');hello();}},5000);
  const code=await new Promise((resolve,reject)=>{child=spawn(binary,[root],{stdio:'inherit'});const deadline=setTimeout(()=>{child.kill();reject(Error('native_test_timeout'));},30000);child.on('error',reject);child.on('close',code=>{clearTimeout(deadline);resolve(code);});});
  assert.equal(code,0);assert.ok(events.includes('audio')&&events.includes('image')&&events.includes('motion')&&events.includes('face')&&events.includes('faceStyle')&&events.includes('stop'));
  await mkdir(path.join(root,'work/verification'),{recursive:true});
  await writeFile(path.join(root,'work/verification/live-native.json'),JSON.stringify({time:new Date().toISOString(),passed:true,productionSwiftClient:true,simulated:true,realSensorsUsed:false,hardwareTested:false,providersCalled:false},null,2)+'\n');
}finally{clearInterval(heartbeat);controller.close();device.terminate();if(child?.exitCode===null)child.kill();}
