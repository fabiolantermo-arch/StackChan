// Explicit remote protocol test with a clearly marked virtual device. No sensors/providers used.
import WebSocket from 'ws';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DeviceCommands,encodeMedia} from '../firmware/stackchan-mod/live-wire.js';
const root=fileURLToPath(new URL('../',import.meta.url)),base='https://robottino-stackchan.example.workers.dev';
const appToken=(await readFile(path.join(root,'private/robot-token'),'utf8')).trim(),deviceToken=(await readFile(path.join(root,'private/robot-device-token'),'utf8')).trim();
assert.ok(appToken.length>=32&&deviceToken.length>=32&&appToken!==deviceToken);
const status=await fetch(base+'/api/robot/status',{headers:{Authorization:'Bearer '+appToken},signal:AbortSignal.timeout(10000)});assert.equal(status.status,200);
assert.equal((await status.json()).connected,false,'A robot is already online. Test will not replace it.');
class Inbox{
  values=[];waiters=[];
  constructor(ws){this.ws=ws;ws.on('message',(data,binary)=>{const value=binary?Buffer.from(data):JSON.parse(data.toString()),index=this.waiters.findIndex(w=>w.test(value));if(index>=0)this.waiters.splice(index,1)[0].done(value);else this.values.push(value);});}
  next(test){const index=this.values.findIndex(test);if(index>=0)return Promise.resolve(this.values.splice(index,1)[0]);return new Promise((resolve,reject)=>{const entry={test,done:value=>{clearTimeout(timer);resolve(value);}},timer=setTimeout(()=>{this.waiters=this.waiters.filter(w=>w!==entry);reject(Error('protocol_timeout'));},5000);this.waiters.push(entry);});}
  send(value){this.ws.send(value instanceof ArrayBuffer?value:JSON.stringify(value));}
}
const sockets=[],checks=[];let heartbeat;
function connect(route,token){return new Promise((resolve,reject)=>{const ws=new WebSocket(base.replace('https:','wss:')+route,{headers:{Authorization:'Bearer '+token},handshakeTimeout:10000,maxPayload:65535}),inbox=new Inbox(ws);sockets.push(ws);ws.once('error',reject);ws.once('open',()=>resolve(inbox));});}
try{
  const denied=await fetch(base+'/api/robot/device',{headers:{Authorization:'Bearer '+appToken},signal:AbortSignal.timeout(10000)});assert.equal(denied.status,401);checks.push('distinct_role_auth');
  const device=await connect('/api/robot/device',deviceToken),app=await connect('/api/robot/live',appToken);
  const received=[];const io=Object.fromEntries(['camera','call','screen','motion','face','faceStyle','dance','stop','audio','image'].map(name=>[name,value=>{received.push({name,value});}]));
  const dispatcher=new DeviceCommands(io,event=>device.send(event));
  device.ws.on('message',(data,binary)=>{try{if(binary)dispatcher.media(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength));else{const value=JSON.parse(data.toString());if(value.type==='command')void dispatcher.command(value);}}catch{device.ws.close();}});
  device.send({type:'hello',capabilities:{hardwareVerified:true,calibrated:true,motion:true,camera:true,audio:true,screen:true,simulated:true}});
  await app.next(value=>value.type==='status'&&value.connected&&value.simulated);checks.push('simulated_device_label');
  heartbeat=setInterval(()=>{for(const peer of [device,app])if(peer.ws.readyState===WebSocket.OPEN)peer.send({type:'ping'});},5000);
  async function command(action,values={}){const id=crypto.randomUUID();app.send({type:'command',id,action,...values});const ack=await app.next(value=>value.id===id);assert.equal(ack.ok,true);}
  await command('camera.start');const pixels=new Uint8Array(38400).fill(0x55).buffer;device.send(encodeMedia(1,1,pixels,160,120));assert.equal((await app.next(Buffer.isBuffer)).byteLength,38412);checks.push('video_160x120');
  await command('face.style',{style:'white'});assert.ok(received.some(v=>v.name==='faceStyle'&&v.value==='white'));checks.push('face_style');
  await command('motion',{yaw:5,pitch:-5});await command('mirror',{yaw:1,pitch:2,leftEye:.1,rightEye:.9,mouth:.5,followHead:true});assert.equal(received.filter(v=>v.name==='motion').length,2);checks.push('head_and_face_ack');
  await command('dance',{steps:[{yaw:5,pitch:0,durationMs:500,expression:'happy'},{yaw:-5,pitch:0,durationMs:500,expression:'blink'}]});assert.equal(received.find(v=>v.name==='dance').value.length,2);checks.push('dance_ack');
  await command('screen.start');app.send(encodeMedia(2,1,pixels,160,120));await device.next(Buffer.isBuffer);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(received.find(v=>v.name==='image').value.payload.byteLength,38400);checks.push('image_pixels');
  await command('call.start');const pcm=new Uint8Array(640).buffer;app.send(encodeMedia(3,2,pcm));await device.next(Buffer.isBuffer);device.send(encodeMedia(3,2,pcm));assert.equal((await app.next(Buffer.isBuffer)).byteLength,652);assert.equal(received.find(v=>v.name==='audio').value.byteLength,640);checks.push('audio_both_directions');
  // Full-resolution photo: 5 pieces of 32 KB, rebuilt by the firmware's own dispatcher.
  const full=new Uint8Array(153600).fill(0x33);
  for(let offset=0,sequence=3;offset<full.length;offset+=32768,sequence++){const count=Math.min(32768,full.length-offset),body=new ArrayBuffer(8+count),view=new DataView(body);view.setUint32(0,1);view.setUint32(4,offset);new Uint8Array(body,8).set(full.subarray(offset,offset+count));app.send(encodeMedia(5,sequence,body,320,240));}
  for(let i=0;i<5;i++)await device.next(Buffer.isBuffer);await new Promise(resolve=>setTimeout(resolve,20));
  const photo=received.filter(v=>v.name==='image').at(-1).value;assert.deepEqual([photo.width,photo.height,photo.scale,photo.payload.byteLength],[320,240,1,153600]);checks.push('image_320x240');
  await command('stop');checks.push('stop_ack');
  const closed=new Promise(resolve=>app.ws.once('close',resolve));device.ws.close(1000,'test_complete');await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(Error('peer_not_closed')),5000))]);checks.push('paired_disconnect');
  const out=path.join(root,'work/verification');await mkdir(out,{recursive:true});await writeFile(path.join(out,'live-cloud.json'),JSON.stringify({time:new Date().toISOString(),passed:true,checks,simulated:true,hardwareTested:false,realSensorsUsed:false,providersCalled:false},null,2)+'\n');
  console.log('PASS remote live protocol: '+checks.join(', ')+'. Virtual device only.');
}finally{clearInterval(heartbeat);for(const ws of sockets)ws.terminate();}
