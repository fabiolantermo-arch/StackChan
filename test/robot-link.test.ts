import {afterEach,expect,it} from 'vitest';
import {env} from 'cloudflare:workers';
import {runInDurableObject,runDurableObjectAlarm} from 'cloudflare:test';
import worker from '../src/index';
import {caps,command,packet,JPEG_MIN,JPEG_MAX} from '../src/robot-wire';
const sockets:WebSocket[]=[];
afterEach(()=>{for(const ws of sockets.splice(0))if(ws.readyState===1)ws.close();});
class Inbox {
  values:any[]=[];waiters:{test:(value:any)=>boolean;resolve:(value:any)=>void}[]=[];
  constructor(readonly ws:WebSocket){
    ws.binaryType='arraybuffer';
    ws.addEventListener('message',event=>{
      const value=typeof event.data==='string'?JSON.parse(event.data):event.data;
      const index=this.waiters.findIndex(waiter=>waiter.test(value));
      if(index>=0)this.waiters.splice(index,1)[0].resolve(value);else this.values.push(value);
    });
  }
  next(test:(value:any)=>boolean){
    const index=this.values.findIndex(test);if(index>=0)return Promise.resolve(this.values.splice(index,1)[0]);
    return new Promise<any>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('event_timeout')),1000);
      this.waiters.push({test,resolve:value=>{clearTimeout(timer);resolve(value);}});
    });
  }
  send(value:any){this.ws.send(value instanceof ArrayBuffer?value:JSON.stringify(value));}
}
async function open(stub:any,role:string){
  const response=await stub.fetch(new Request('https://unit/ws',{headers:{upgrade:'websocket','x-robottino-role':role}}));
  expect(response.status).toBe(101);const ws=response.webSocket!;sockets.push(ws);const inbox=new Inbox(ws);ws.accept();await inbox.next(value=>value.type==='connected');return inbox;
}
const capabilities={hardwareVerified:true,calibrated:true,motion:true,camera:true,audio:true,screen:true,simulated:true};
async function setup(overrides={}){
  const stub=env.ROBOT_LINK.getByName('link-'+crypto.randomUUID()),device=await open(stub,'device'),app=await open(stub,'app');
  device.send({type:'hello',capabilities:{...capabilities,...overrides}});await app.next(value=>value.type==='status'&&value.connected);return {stub,device,app};
}
async function ack(h:Awaited<ReturnType<typeof setup>>,action:string,extra={}){
  const id=crypto.randomUUID();h.app.send({type:'command',id,action,...extra});const request=await h.device.next(value=>value.id===id);
  h.device.send({type:'ack',id,ok:true});expect((await h.app.next(value=>value.id===id)).ok).toBe(true);return request;
}
function media(kind:number,sequence:number,width=0,height=0){
  const payload=kind===3?640:width*height*2,buffer=new ArrayBuffer(12+payload),view=new DataView(buffer);
  view.setUint16(0,0x5242);view.setUint8(2,1);view.setUint8(3,kind);view.setUint32(4,sequence);view.setUint16(8,width);view.setUint16(10,height);return buffer;
}
it('requires distinct role authentication and does not accept app tokens for devices',async()=>{
  const bindings={...env,ROBOT_API_TOKEN:'a'.repeat(64),ROBOT_DEVICE_TOKEN:'d'.repeat(64)};
  expect((await worker.fetch(new Request('https://unit/api/robot/device',{headers:{upgrade:'websocket',authorization:'Bearer '+bindings.ROBOT_API_TOKEN,'x-robottino-role':'device'}}),bindings)).status).toBe(401);
  expect((await worker.fetch(new Request('https://unit/api/robot/status'),bindings)).status).toBe(401);
  const status=await worker.fetch(new Request('https://unit/api/robot/status',{headers:{authorization:'Bearer '+bindings.ROBOT_API_TOKEN}}),bindings);
  expect(status.status).toBe(200);expect((await status.json() as any).connected).toBe(false);
});
it('relays live video, screen pixels and bidirectional audio only after device ACKs',async()=>{
  const h=await setup();await ack(h,'camera.start');
  const camera=media(1,1,2,2);h.device.send(camera);expect((await h.app.next(value=>value instanceof ArrayBuffer)).byteLength).toBe(camera.byteLength);
  await ack(h,'screen.start');const screen=media(2,1,2,2);h.app.send(screen);expect((await h.device.next(value=>value instanceof ArrayBuffer)).byteLength).toBe(screen.byteLength);
  await ack(h,'call.start');h.app.send(media(3,2));expect((await h.device.next(value=>value instanceof ArrayBuffer)).byteLength).toBe(652);
  h.device.send(media(3,2));expect((await h.app.next(value=>value instanceof ArrayBuffer)).byteLength).toBe(652);
  await ack(h,'call.stop');await ack(h,'camera.stop');await ack(h,'screen.stop');
});
it('forwards bounded head and face commands and rejects uncalibrated motion',async()=>{
  const h=await setup();const motion=await ack(h,'motion',{yaw:5,pitch:-5,unexpected:'not forwarded'});expect(motion.yaw).toBe(5);expect(motion.unexpected).toBeUndefined();
  await ack(h,'mirror',{yaw:1,pitch:2,leftEye:.1,rightEye:.9,mouth:.5,followHead:false});
  const limited=await setup({calibrated:false});limited.app.send({type:'command',id:'uncalibrated',action:'motion',yaw:1,pitch:-1});
  expect((await limited.app.next(value=>value.id==='uncalibrated')).error).toBe('capability_unavailable');
});
it('face following: small robot frames to the app, face positions back, only with camera and motion',async()=>{
  const h=await setup();await ack(h,'track.start');
  const frame=media(1,1,160,120);h.device.send(frame);expect((await h.app.next(value=>value instanceof ArrayBuffer)).byteLength).toBe(frame.byteLength);
  const target=await ack(h,'track',{frameId:7,x:.25,y:.4,unexpected:'not forwarded'});expect([target.frameId,target.x,target.y]).toEqual([7,.25,.4]);expect(target.unexpected).toBeUndefined();expect(target.yaw).toBeUndefined();
  for(const bad of [{frameId:0,x:.5,y:.5},{frameId:1.5,x:.5,y:.5},{frameId:1,x:1.2,y:.5},{frameId:1,x:.5,y:-0.1},{frameId:1,x:NaN,y:.5}])expect(command({type:'command',id:'x',action:'track',...bad})).toBe(false);
  await ack(h,'track.stop');h.device.send(media(1,2,160,120));h.app.send({type:'ping'});await h.app.next(value=>value.type==='pong');
  expect(h.app.values.some(value=>value instanceof ArrayBuffer),'no frames after track.stop').toBe(false);
  const still=await setup({calibrated:false});still.app.send({type:'command',id:'follow',action:'track.start'});
  expect((await still.app.next(value=>value.id==='follow')).error,'no following without motion').toBe('capability_unavailable');
});
it('cannot replace an occupied device; the robot leaving closes the app, the app leaving does not close the robot',async()=>{
  const h=await setup();const response=await h.stub.fetch(new Request('https://unit/ws',{headers:{upgrade:'websocket','x-robottino-role':'device'}}));expect(response.status).toBe(409);
  const closed=new Promise(resolve=>h.app.ws.addEventListener('close',resolve,{once:true}));h.device.ws.close();await closed;
});
it('the app leaves, the robot stays (21 Nov 2026: «continua a dire collegamento al robot ma non si connette»): its video is stopped with a command the robot knows, and the next app finds the robot at once',async()=>{
  const h=await setup();let robotClosed=false;h.device.ws.addEventListener('close',()=>{robotClosed=true;});
  // The app starts the video, the robot confirms; a second command is still waiting when the app goes.
  h.app.send({type:'command',id:'v1',action:'camera.start'});await h.device.next(value=>value.id==='v1');h.device.send({type:'ack',id:'v1',ok:true});await h.app.next(value=>value.type==='ack'&&value.id==='v1');
  h.app.send({type:'command',id:'late',action:'volume',level:5});await h.device.next(value=>value.id==='late');
  h.app.ws.close();
  const stop=await h.device.next(value=>value.type==='command'&&value.action==='camera.stop');expect(stop.id).toMatch(/^left-/);
  h.device.send({type:'ack',id:stop.id,ok:true});
  // The robot is still there: it answers a ping, and the service still says it is connected, with nothing switched on.
  h.device.send({type:'ping'});await h.device.next(value=>value.type==='pong');expect(robotClosed).toBe(false);
  await runInDurableObject(h.stub,async(instance:any,state:any)=>{
    expect(instance.status().connected).toBe(true);
    const robot=state.getWebSockets().map((ws:any)=>ws.deserializeAttachment()).find((peer:any)=>peer.role==='device'&&!peer.gone);
    expect(robot).toMatchObject({camera:false,call:false,screen:false,track:false,cleanup:[]});expect(robot.orphans).toContain('late');
  });
  // A new app joins the same robot: connected at once, the robot is told, commands pass.
  const again=await open(h.stub,'app');expect(await again.next(value=>value.type==='status')).toMatchObject({connected:true});
  await h.device.next(value=>value.type==='peer.connected');
  // The robot's late confirmation of the first app's command is ignored, not a fault.
  h.device.send({type:'ack',id:'late',ok:true});h.device.send({type:'ping'});await h.device.next(value=>value.type==='pong');expect(robotClosed).toBe(false);
  again.send({type:'command',id:'n1',action:'volume',level:6});expect(await h.device.next(value=>value.id==='n1')).toMatchObject({action:'volume',level:6});
  h.device.send({type:'ack',id:'n1',ok:true});expect(await again.next(value=>value.type==='ack'&&value.id==='n1')).toMatchObject({ok:true});
  // An app that had switched nothing on (a switch of the Robot tab): the robot gets nothing and stays.
  again.ws.close();h.device.send({type:'ping'});await h.device.next(value=>value.type==='pong');expect(robotClosed).toBe(false);
});
it('the app leaves and the robot cannot be left clean: its link is renewed, as before (21 Nov 2026)',async()=>{
  const closing=(inbox:any)=>new Promise<string>(resolve=>inbox.ws.addEventListener('close',(event:any)=>resolve(event.reason),{once:true}));
  // The robot refuses the stop (it is busy with something else).
  const r=await setup();r.app.send({type:'command',id:'v1',action:'camera.start'});await r.device.next(value=>value.id==='v1');r.device.send({type:'ack',id:'v1',ok:true});await r.app.next(value=>value.id==='v1');
  const refused=closing(r.device);r.app.ws.close();const stop=await r.device.next(value=>value.action==='camera.stop');r.device.send({type:'ack',id:stop.id,ok:false});expect(await refused).toBe('peer_disconnected');
  // The robot does not confirm the stop in 1.5 s.
  const t=await setup();t.app.send({type:'command',id:'v1',action:'camera.start'});await t.device.next(value=>value.id==='v1');t.device.send({type:'ack',id:'v1',ok:true});await t.app.next(value=>value.id==='v1');
  const late=closing(t.device);t.app.ws.close();await t.device.next(value=>value.action==='camera.stop');
  await runInDurableObject(t.stub,async(_instance:any,state:any)=>{for(const ws of state.getWebSockets()){const peer=ws.deserializeAttachment();if(peer.role==='device'&&!peer.gone)ws.serializeAttachment({...peer,cleanup:peer.cleanup.map((c:any)=>({...c,until:c.until-2000}))});}});
  await runDurableObjectAlarm(t.stub);expect(await late).toBe('command_timeout');
  // A call was on (or a picture on the screen): the robot counts what the app sends, so its link starts again.
  const c=await setup();c.app.send({type:'command',id:'c1',action:'call.start'});await c.device.next(value=>value.id==='c1');c.device.send({type:'ack',id:'c1',ok:true});await c.app.next(value=>value.id==='c1');
  const call=closing(c.device);c.app.ws.close();expect(await call).toBe('peer_disconnected');
});
it('a robot link left half open by a restart does not keep the restarted robot out; a live one still does (11 Nov 2026)',async()=>{
  const h=await setup();
  // The old link says nothing for more than 15 s (the robot was restarted) and never answers a close.
  await runInDurableObject(h.stub,async(_instance:any,state:any)=>{
    for(const ws of state.getWebSockets()){const peer=ws.deserializeAttachment();if(peer.role==='device')ws.serializeAttachment({...peer,seen:Date.now()-20000});}
  });
  const again=await h.stub.fetch(new Request('https://unit/ws',{headers:{upgrade:'websocket','x-robottino-role':'device'}}));
  expect(again.status).toBe(101);again.webSocket!.accept();
  const second=await h.stub.fetch(new Request('https://unit/ws',{headers:{upgrade:'websocket','x-robottino-role':'device'}}));
  expect(second.status,'the new link is alive: still one robot at a time').toBe(409);
  again.webSocket!.close();
});
it('a new app link takes the place of an old one that is still pinging; the robot stays and what the old one started stops (23 Nov 2026)',async()=>{
  const h=await setup();await ack(h,'camera.start');
  const left=new Promise<string>(resolve=>h.app.ws.addEventListener('close',event=>resolve((event as CloseEvent).reason),{once:true}));
  const fresh=await open(h.stub,'app');
  expect(await left).toBe('app_replaced');
  const stop=await h.device.next(value=>value.action==='camera.stop');expect(stop.id).toMatch(/^left-/);h.device.send({type:'ack',id:stop.id,ok:true});
  fresh.send({type:'ping'});await fresh.next(value=>value.type==='pong');
  const id=crypto.randomUUID();fresh.send({type:'command',id,action:'motions',on:false});const sent=await h.device.next(value=>value.id===id);
  expect(sent.on).toBe(false);h.device.send({type:'ack',id,ok:true});expect((await fresh.next(value=>value.id===id)).ok).toBe(true);
});
it('rejects replayed media and malformed commands without actuating',async()=>{
  const h=await setup();await ack(h,'camera.start');h.device.send(media(1,1,2,2));await h.app.next(value=>value instanceof ArrayBuffer);
  const closed=new Promise(resolve=>h.app.ws.addEventListener('close',resolve,{once:true}));h.device.send(media(1,1,2,2));await closed;
  expect(command({type:'command',id:'x',action:'motion',yaw:Infinity,pitch:0})).toBe(false);
  expect(command({type:'command',id:'x',action:'motion',yaw:91,pitch:0})).toBe(false);
  // The head from the iPhone: 90° sideways and 85° up, never below straight ahead; the mirror stays within 10°.
  for(const pose of [{yaw:90,pitch:-85},{yaw:-90,pitch:0},{yaw:11,pitch:-12}])expect(command({type:'command',id:'x',action:'motion',...pose})).toBe(true);
  for(const pose of [{yaw:0,pitch:1},{yaw:0,pitch:-86},{yaw:-90.5,pitch:0}])expect(command({type:'command',id:'x',action:'motion',...pose})).toBe(false);
  expect(command({type:'command',id:'x',action:'mirror',yaw:11,pitch:0,leftEye:1,rightEye:1,mouth:0,followHead:true})).toBe(false);
  expect(packet(media(2,1,161,120))).toBeNull();expect(packet(media(3,0))).toBeNull();
  expect(caps({...capabilities,malicious:'not reflected'})).not.toHaveProperty('malicious');
  // A conversation in progress reaches the iPhone (face following while talking); only a real true counts.
  expect(caps({...capabilities,conversation:true})?.conversation).toBe(true);
  expect(caps({...capabilities,conversation:'yes'})?.conversation).toBe(false);expect(caps(capabilities)?.conversation).toBe(false);
});

it('rejects media and remote expressions until hardware is verified',async()=>{
  const h=await setup({hardwareVerified:false});
  for(const action of ['camera.start','call.start','screen.start','mirror']){
    const id=crypto.randomUUID();h.app.send({type:'command',id,action,yaw:0,pitch:0,leftEye:1,rightEye:1,mouth:0,followHead:false});
    expect((await h.app.next(value=>value.id===id)).error).toBe('capability_unavailable');
  }
});
it('deduplicates commands and cannot enable media from a rejected device ACK',async()=>{
  const h=await setup();const id='reject-camera';h.app.send({type:'command',id,action:'camera.start'});
  await h.device.next(value=>value.id===id);h.device.send({type:'ack',id,ok:false});expect((await h.app.next(value=>value.id===id)).ok).toBe(false);
  h.device.send(media(1,1,2,2));h.app.send({type:'ping'});await h.app.next(value=>value.type==='pong');
  expect(h.app.values.some(value=>value instanceof ArrayBuffer)).toBe(false);
  h.app.send({type:'command',id,action:'camera.start'});expect((await h.app.next(value=>value.id===id)).error).toBe('duplicate_command');
});

it('relays 320x240 camera chunks only from an acknowledged device camera',async()=>{
  const h=await setup();await ack(h,'camera.start');
  const pixels=153600;let offset=0;
  for(let sequence=1;offset<pixels;sequence++){
    const length=Math.min(32768,pixels-offset),buffer=new ArrayBuffer(20+length),view=new DataView(buffer);
    view.setUint16(0,0x5242);view.setUint8(2,1);view.setUint8(3,4);view.setUint32(4,sequence);view.setUint16(8,320);view.setUint16(10,240);view.setUint32(12,1);view.setUint32(16,offset);
    expect(packet(buffer)?.kind).toBe(4);h.device.send(buffer);expect((await h.app.next(value=>value instanceof ArrayBuffer)).byteLength).toBe(buffer.byteLength);offset+=length;
  }
  const bad=new ArrayBuffer(22),view=new DataView(bad);view.setUint16(0,0x5242);view.setUint8(2,1);view.setUint8(3,4);view.setUint32(4,6);view.setUint16(8,320);view.setUint16(10,240);view.setUint32(12,1);view.setUint32(16,153600);expect(packet(bad)).toBeNull();
});
it('forwards only supported face styles to a verified robot',async()=>{
  const h=await setup();const request=await ack(h,'face.style',{style:'white'});expect(request.style).toBe('white');
  const portrait=await ack(h,'face.style',{style:'portrait'});expect(portrait.style).toBe('portrait');
  const redhead=await ack(h,'face.style',{style:'redhead'});expect(redhead.style).toBe('redhead');
  const curly=await ack(h,'face.style',{style:'curly'});expect(curly.style).toBe('curly');
  for(const style of ['other','blue','metal'])expect(command({type:'command',id:'x',action:'face.style',style})).toBe(false);
});
it('forwards only bounded dances, stripped to known fields, and requires enabled motion',async()=>{
  const step={yaw:5,pitch:-5,durationMs:800,expression:'happy',extra:'drop'};
  const h=await setup();const request=await ack(h,'dance',{steps:[step,{...step,yaw:-5,expression:'blink'}]});
  expect(request.steps).toEqual([{yaw:5,pitch:-5,durationMs:800,expression:'happy'},{yaw:-5,pitch:-5,durationMs:800,expression:'blink'}]);
  for(const steps of [[],[{...step,yaw:11}],[{...step,durationMs:200}],[{...step,expression:'angry'}],Array(33).fill(step),Array(13).fill({...step,durationMs:5000})])
    expect(command({type:'command',id:'x',action:'dance',steps})).toBe(false);
  const locked=await setup({calibrated:false});const id=crypto.randomUUID();
  locked.app.send({type:'command',id,action:'dance',steps:[step]});
  expect(await locked.app.next(value=>value.id===id)).toMatchObject({ok:false,error:'capability_unavailable'});
});
it('forwards the rover keys with only the move and a short time; anything else is refused',async()=>{
  const h=await setup({motion:false});const request=await ack(h,'rover',{move:'turnLeft',ms:500,speed:100});
  expect(request).toMatchObject({action:'rover',move:'turnLeft',ms:500});expect(request.speed).toBeUndefined();
  expect(command({type:'command',id:'g',action:'rover',move:'gripOpen',ms:200})).toBe(true);expect(command({type:'command',id:'g',action:'rover',move:'gripClose',ms:200})).toBe(true);expect(command({type:'command',id:'g',action:'rover',move:'gripHalf',ms:200})).toBe(true);
  for(const extra of [{move:'jump',ms:500},{move:'forward',ms:5000},{move:'forward',ms:100},{move:'forward',ms:1.5},{move:'forward'}])
    expect(command({type:'command',id:'x',action:'rover',...extra})).toBe(false);
});
it('forwards the speaker volume as a whole level 1…10 and nothing else',async()=>{
  const h=await setup({motion:false});const request=await ack(h,'volume',{level:4,amp:256});
  expect(request).toMatchObject({action:'volume',level:4});expect(request.amp).toBeUndefined();expect(request.move).toBeUndefined();
  for(const extra of [{level:0},{level:11},{level:2.5},{level:'5'},{}])
    expect(command({type:'command',id:'x',action:'volume',...extra})).toBe(false);
});
it('forwards a hand gesture by its name and nothing else (15 Nov 2026)',async()=>{
  const h=await setup({motion:false});const request=await ack(h,'gesture',{name:'thumbsUp',move:'forward',level:3,steps:[1]});
  expect(request).toMatchObject({action:'gesture',name:'thumbsUp'});expect(request.move).toBeUndefined();expect(request.level).toBeUndefined();expect(request.steps).toBeUndefined();
  for(const name of ['thumbsUp','thumbsDown','palm','wave','victory'])expect(command({type:'command',id:'x',action:'gesture',name})).toBe(true);
  for(const extra of [{name:'fist'},{name:5},{}])expect(command({type:'command',id:'x',action:'gesture',...extra})).toBe(false);
});
it('forwards what the iPhone saw (15 Nov 2026): the kind, and a few plain words only for the owner\'s name and a thing',async()=>{
  const h=await setup({motion:false});const request=await ack(h,'sight',{kind:'person',text:'Ada',name:'thumbsUp',level:3});
  expect(request).toMatchObject({action:'sight',kind:'person',text:'Ada'});expect(request.name).toBeUndefined();expect(request.level).toBeUndefined();
  for(const extra of [{kind:'person',text:"D'Angelo"},{kind:'object',text:"un'arancia"},{kind:'object',text:'un caffè'},{kind:'smile'},{kind:'serious'},{kind:'stranger'}])expect(command({type:'command',id:'x',action:'sight',...extra})).toBe(true);
  for(const extra of [{kind:'person'},{kind:'person',text:''},{kind:'person',text:'   '},{kind:'person',text:'Ada <b>'},{kind:'person',text:'a'.repeat(25)},{kind:'object',text:'tazza 2'},{kind:'smile',text:'x'},{kind:'wink'},{}])
    expect(command({type:'command',id:'x',action:'sight',...extra})).toBe(false);
});
it('forwards the motions switch as on or off and nothing else',async()=>{
  const h=await setup({motion:false});const request=await ack(h,'motions',{on:false,level:3});
  expect(request).toMatchObject({action:'motions',on:false});expect(request.level).toBeUndefined();
  for(const extra of [{on:'yes'},{on:1},{}])expect(command({type:'command',id:'x',action:'motions',...extra})).toBe(false);
});
it('forwards the «Chiamata con lo sguardo» switch and tells the app whether it is on (21 Nov 2026)',async()=>{
  const h=await setup({motion:false});const request=await ack(h,'gazeCall',{on:true,level:3});
  expect(request).toMatchObject({action:'gazeCall',on:true});expect(request.level).toBeUndefined();
  for(const extra of [{on:'yes'},{on:1},{}])expect(command({type:'command',id:'x',action:'gazeCall',...extra})).toBe(false);
  const {caps}=await import('../src/robot-wire');const base={hardwareVerified:true,calibrated:true,motion:true,camera:true,audio:true,screen:true};
  expect(caps({...base,gazeCall:true})?.gazeCall).toBe(true);expect(caps({...base,gazeCall:'yes'})?.gazeCall).toBe(false);expect(caps(base)?.gazeCall).toBe(false);
});
it('forwards «Esplora» from the Studio and tells the app while the robot explores (23 Nov 2026)',async()=>{
  const h=await setup({motion:false});const request=await ack(h,'explore',{on:true,level:3,x:.5});
  expect(request).toMatchObject({action:'explore',on:true});expect(request.level).toBeUndefined();expect(request.x).toBeUndefined();
  for(const extra of [{on:'yes'},{on:1},{}])expect(command({type:'command',id:'x',action:'explore',...extra})).toBe(false);
  const {caps}=await import('../src/robot-wire');const base={hardwareVerified:true,calibrated:true,motion:true,camera:true,audio:true,screen:true};
  expect(caps({...base,exploring:true})?.exploring).toBe(true);expect(caps({...base,exploring:1})?.exploring).toBe(false);expect(caps(base)?.exploring).toBe(false);
});
it('forwards where the iPhone sees the hand that leads the Force, and tells the app when the Force follows it (23 Nov 2026)',async()=>{
  const h=await setup();const request=await ack(h,'hand',{x:.3,y:.9,frameId:4});
  expect(request).toMatchObject({action:'hand',x:.3});expect(request.y).toBeUndefined();expect(request.frameId).toBeUndefined();
  for(const extra of [{x:-.1},{x:1.2},{x:'0.5'},{}])expect(command({type:'command',id:'x',action:'hand',...extra})).toBe(false);
  const {caps}=await import('../src/robot-wire');const base={hardwareVerified:true,calibrated:true,motion:true,camera:true,audio:true,screen:true};
  expect(caps({...base,forceFollow:true})?.forceFollow).toBe(true);expect(caps({...base,forceFollow:1})?.forceFollow).toBe(false);expect(caps(base)?.forceFollow).toBe(false);
});
it('forwards the rover follow switch and tells the app whether the rover and the following are on (15 Nov 2026)',async()=>{
  const h=await setup({motion:false});const request=await ack(h,'roverFollow',{on:true,speed:9});
  expect(request).toMatchObject({action:'roverFollow',on:true});expect(request.speed).toBeUndefined();
  expect(command({type:'command',id:'x',action:'roverFollow',on:'yes'})).toBe(false);
  const {caps}=await import('../src/robot-wire');
  expect(caps({hardwareVerified:true,calibrated:true,motion:true,camera:true,audio:true,screen:true,rover:true,roverFollow:true,extra:1})).toMatchObject({rover:true,roverFollow:true});
  expect(caps({hardwareVerified:true,calibrated:true,motion:true,camera:true,audio:true,screen:true})).toMatchObject({rover:false,roverFollow:false});
  const base={hardwareVerified:true,calibrated:true,motion:true,camera:true,audio:true,screen:true};
  expect(caps({...base,climate:{t:22.34,h:41.6,p:101325.4,x:1}})?.climate).toEqual({t:22.3,h:42,p:101325});
  expect(caps({...base,climate:{t:300,h:41}})?.climate).toBeUndefined();expect(caps({...base,climate:{t:20,h:40,p:5}})?.climate).toEqual({t:20,h:40});
});
it('lets only the robot credential open the robot conversation, with the saved provider',async()=>{
  const {vi}=await import('vitest');
  const bindings={...env,ROBOT_API_TOKEN:'a'.repeat(64),ROBOT_DEVICE_TOKEN:'d'.repeat(64)};
  const open=(token:string,upgrade=true)=>worker.fetch(new Request('https://unit/api/robot/voice?provider=openai',{headers:{authorization:'Bearer '+token,...(upgrade?{upgrade:'websocket'}:{})}}),bindings);
  expect((await open(bindings.ROBOT_API_TOKEN)).status).toBe(401);
  expect((await open('x'.repeat(64))).status).toBe(401);
  expect((await open(bindings.ROBOT_DEVICE_TOKEN,false)).status).toBe(426);
  const requested:string[]=[];
  const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async input=>{requested.push(String(input));return new Response('no',{status:503});});
  const response=await open(bindings.ROBOT_DEVICE_TOKEN);
  spy.mockRestore();
  expect(response.status).toBe(502);
  // Default preference is ElevenLabs: the caller's ?provider=openai is ignored.
  expect(requested.some(url=>url.includes('elevenlabs.io')&&url.includes('get-signed-url'))).toBe(true);
});

it('delivers only fixed Claude Code reactions to a connected robot, at most one every 2 seconds',async()=>{
  const h=await setup();
  expect(await h.stub.reaction('<script>')).toEqual({delivered:false,error:'invalid_reaction'});
  expect(await h.stub.reaction('attention')).toEqual({delivered:true});
  expect(await h.device.next(value=>value.type==='reaction')).toEqual({type:'reaction',kind:'attention'});
  expect(await h.stub.reaction('done')).toEqual({delivered:false,error:'too_soon'});
  const empty=env.ROBOT_LINK.getByName('link-'+crypto.randomUUID());
  expect(await empty.reaction('done')).toEqual({delivered:false,error:'robot_offline'});
  const denied=await worker.fetch(new Request('https://unit/api/robot/reaction',{method:'POST',body:JSON.stringify({kind:'done'})}),env as any);
  expect(denied.status).toBe(401);
});
it('relays full-resolution screen pieces only from the app and only after the robot ACKs the screen',async()=>{
  const h=await setup(),piece=()=>{const buffer=new ArrayBuffer(12+8+32768),view=new DataView(buffer);view.setUint16(0,0x5242);view.setUint8(2,1);view.setUint8(3,5);view.setUint16(8,320);view.setUint16(10,240);view.setUint32(12,1);view.setUint32(16,0);return view;};
  const early=piece();early.setUint32(4,1);h.app.send(early.buffer);
  await ack(h,'screen.start');
  const first=piece();first.setUint32(4,2);h.app.send(first.buffer);
  expect((await h.device.next(value=>value instanceof ArrayBuffer)).byteLength).toBe(32788);
  expect(h.device.values.filter((value:any)=>value instanceof ArrayBuffer).length).toBe(0); // the piece sent before the ACK was dropped
  // A screen piece coming from the robot is the wrong direction: the session closes.
  const closed=new Promise(resolve=>h.app.ws.addEventListener('close',resolve,{once:true}));
  const wrong=piece();wrong.setUint32(4,3);h.device.send(wrong.buffer);await closed;
});

it('grey following pieces (kind 6): one byte per pixel up to 160×120, robot to app, only while following',async()=>{
  const grey=(sequence:number,width:number,height:number,offset:number,length:number,frame=1)=>{
    const buffer=new ArrayBuffer(20+length),view=new DataView(buffer);
    view.setUint16(0,0x5242);view.setUint8(2,1);view.setUint8(3,6);view.setUint32(4,sequence);view.setUint16(8,width);view.setUint16(10,height);view.setUint32(12,frame);view.setUint32(16,offset);return buffer;
  };
  expect(packet(grey(1,80,60,0,4096))).toEqual({kind:6,sequence:1,width:80,height:60});
  expect(packet(grey(1,80,60,4096,704))).not.toBeNull();expect(packet(grey(1,80,60,4096,705))).toBeNull();
  expect(packet(grey(1,161,120,0,100))).toBeNull();expect(packet(grey(1,80,60,0,4097))).toBeNull();expect(packet(grey(1,80,60,0,10,0))).toBeNull();
  const h=await setup();await ack(h,'track.start');
  const piece=grey(1,80,60,0,4096);h.device.send(piece);expect((await h.app.next(value=>value instanceof ArrayBuffer)).byteLength).toBe(piece.byteLength);
  const closed=new Promise(resolve=>h.app.ws.addEventListener('close',resolve,{once:true}));h.app.send(grey(2,80,60,0,100));await closed;
});

it('camera pictures as JPEG (kind 8): asked by the app with camera.start, whole in one message, robot to app, only with the camera on (14 Nov 2026)',async()=>{
  const jpeg=(sequence:number,width:number,height:number,bytes:number,start=0xffd8)=>{
    const buffer=new ArrayBuffer(12+bytes),view=new DataView(buffer);
    view.setUint16(0,0x5242);view.setUint8(2,1);view.setUint8(3,8);view.setUint32(4,sequence);view.setUint16(8,width);view.setUint16(10,height);if(bytes>=2)view.setUint16(12,start);return buffer;
  };
  expect(packet(jpeg(1,160,120,5000))).toEqual({kind:8,sequence:1,width:160,height:120});
  expect(packet(jpeg(1,320,240,JPEG_MAX))).not.toBeNull();expect(packet(jpeg(1,320,240,JPEG_MAX+1))).toBeNull();
  expect(packet(jpeg(1,160,120,JPEG_MIN-1))).toBeNull();expect(packet(jpeg(1,321,240,5000))).toBeNull();expect(packet(jpeg(1,160,0,5000))).toBeNull();
  expect(packet(jpeg(1,160,120,5000,0x1234))).toBeNull(); // not a JPEG
  expect(packet(jpeg(0,160,120,5000))).toBeNull();
  // The request: a boolean, on camera.start only; the robot is told only when it is true.
  expect(command({type:'command',id:'a',action:'camera.start',jpeg:true})).toBe(true);expect(command({type:'command',id:'a',action:'camera.start',jpeg:'yes'})).toBe(false);
  const h=await setup();
  // Before the robot has confirmed the camera nothing is relayed.
  h.device.send(jpeg(1,160,120,5000));
  const request=await ack(h,'camera.start',{jpeg:true});expect(request.jpeg).toBe(true);
  const picture=jpeg(2,160,120,5000);h.device.send(picture);
  const got=await h.app.next(value=>value instanceof ArrayBuffer);expect(got.byteLength).toBe(picture.byteLength);expect(new DataView(got).getUint32(4)).toBe(2);
  // From the app it is the wrong way: everything closes.
  const closed=new Promise(resolve=>h.app.ws.addEventListener('close',resolve,{once:true}));h.app.send(jpeg(1,160,120,5000));await closed;
  const plain=await setup();expect('jpeg' in await ack(plain,'camera.start')).toBe(false);
  // The video and face following have their own switches (code review, 19 Nov 2026): stopping following keeps the
  // video going, and stopping the video keeps following's grey frames.
  const both=await setup();await ack(both,'camera.start',{jpeg:true});await ack(both,'track.start');await ack(both,'track.stop');
  const still=jpeg(1,160,120,5000);both.device.send(still);expect((await both.app.next(value=>value instanceof ArrayBuffer)).byteLength).toBe(still.byteLength);
  const grey=new ArrayBuffer(20+100),gv=new DataView(grey);gv.setUint16(0,0x5242);gv.setUint8(2,1);gv.setUint8(3,6);gv.setUint32(4,2);gv.setUint16(8,80);gv.setUint16(10,60);gv.setUint32(12,1);gv.setUint32(16,0);
  await ack(both,'track.start');await ack(both,'camera.stop');both.device.send(grey);expect((await both.app.next(value=>value instanceof ArrayBuffer)).byteLength).toBe(grey.byteLength);
  const other=await setup();expect('jpeg' in await ack(other,'call.start',{jpeg:true})).toBe(false);
});
it('a session lasts 10 minutes from when the app joined: an old robot link does not cut a new app, and the reason says what happened (10 Nov 2026)',async()=>{
  // Moves a link's start (born) or last sign of life (seen) back in time, or makes its commands late.
  const change=(stub:any,role:string,edit:(peer:any)=>void)=>runInDurableObject(stub,async(_instance:any,state:any)=>{
    for(const ws of state.getWebSockets()){const peer=ws.deserializeAttachment();if(peer.role===role){edit(peer);ws.serializeAttachment(peer);}}
  });
  const reason=(inbox:Inbox)=>new Promise<string>(resolve=>inbox.ws.addEventListener('close',event=>resolve((event as CloseEvent).reason),{once:true}));
  const alive=async(inbox:Inbox)=>{inbox.send({type:'ping'});await inbox.next(value=>value.type==='pong');};
  // The robot's link is 9 min 50 s old when the app joins; 20 s later it is past its own 10 minutes: the session goes on.
  const h=await setup();await change(h.stub,'device',peer=>{peer.born-=590000;});
  await runDurableObjectAlarm(h.stub);await alive(h.app);await alive(h.device);
  await change(h.stub,'device',peer=>{peer.born-=20000;});
  await runDurableObjectAlarm(h.stub);await alive(h.app);await alive(h.device);
  expect((await h.stub.status()).connected,'the robot still counts as connected').toBe(true);
  await ack(h,'camera.start');
  // Ten minutes after the app joined the session ends for both, and says why.
  const app=reason(h.app),device=reason(h.device);await change(h.stub,'app',peer=>{peer.born-=600001;});await runDurableObjectAlarm(h.stub);
  expect([await app,await device]).toEqual(['session_expired','session_expired']);
  // Alone, the robot's link still lasts 10 minutes.
  const stub=env.ROBOT_LINK.getByName('link-'+crypto.randomUUID()),alone=await open(stub,'device');await alive(alone);
  const renewed=reason(alone);await change(stub,'device',peer=>{peer.born-=600001;});await runDurableObjectAlarm(stub);expect(await renewed).toBe('session_expired');
  // The first message of a link past its time closes it too, without waiting for the alarm.
  const m=await setup(),over=reason(m.device);await change(m.stub,'app',peer=>{peer.born-=600001;});m.app.send({type:'ping'});expect(await over).toBe('session_expired');
  // Who went silent for 15 s, and a command the robot did not confirm in 1.5 s.
  const s=await setup(),silent=reason(s.app);await change(s.stub,'device',peer=>{peer.seen-=15001;});await runDurableObjectAlarm(s.stub);expect(await silent).toBe('robot_silent');
  // An app gone silent leaves alone (21 Nov 2026): its link closes with the reason, the robot's stays.
  const q=await setup(),quiet=reason(q.app);await change(q.stub,'app',peer=>{peer.seen-=15001;});await runDurableObjectAlarm(q.stub);expect(await quiet).toBe('app_silent');
  await alive(q.device);
  const c=await setup(),late=reason(c.app);c.app.send({type:'command',id:'late',action:'camera.start'});await c.device.next(value=>value.id==='late');
  await change(c.stub,'app',peer=>{for(const pending of peer.pending)pending.until-=2000;});await runDurableObjectAlarm(c.stub);expect(await late).toBe('command_timeout');
});

it('the rover\'s own stop passes a full queue too; a move does not (code review, 19 Nov 2026)',async()=>{
  const h=await setup(),ids=['b1','b2','b3','b4'];
  for(const id of ids){h.app.send({type:'command',id,action:'motion',yaw:0,pitch:0});await h.device.next(value=>value.id===id);}
  h.app.send({type:'command',id:'go',action:'rover',move:'forward',ms:500});expect(await h.app.next(value=>value.id==='go')).toMatchObject({ok:false,error:'busy'});
  h.app.send({type:'command',id:'brake',action:'rover',move:'stop',ms:200});
  const sent=await h.device.next(value=>value.id==='brake');expect([sent.action,sent.move]).toEqual(['rover','stop']);
  h.device.send({type:'ack',id:'brake',ok:true});expect(await h.app.next(value=>value.id==='brake')).toMatchObject({ok:true});
});

// External review of 17 Nov 2026, R2: four commands waiting, then STOP. It was answered «busy» and never reached the robot.
it('STOP passes a full queue, the commands it replaces are told so, and their late confirmations are ignored',async()=>{
  const h=await setup(),ids=['a1','a2','a3','a4'];
  for(const id of ids){h.app.send({type:'command',id,action:'motion',yaw:0,pitch:0});await h.device.next(value=>value.id===id);}
  h.app.send({type:'command',id:'a5',action:'motion',yaw:0,pitch:0});
  expect(await h.app.next(value=>value.id==='a5')).toMatchObject({ok:false,error:'busy'});
  h.app.send({type:'command',id:'halt',action:'stop'});
  for(const id of ids)expect(await h.app.next(value=>value.id===id)).toMatchObject({type:'ack',ok:false,error:'superseded'});
  expect((await h.device.next(value=>value.id==='halt')).action,'the robot receives the STOP').toBe('stop');
  // A late confirmation of a replaced command does not close the link and does not reach the app as a success.
  h.device.send({type:'ack',id:'a2',ok:true});
  h.device.send({type:'ack',id:'halt',ok:true});
  expect(await h.app.next(value=>value.id==='halt')).toMatchObject({type:'ack',ok:true});
  h.app.send({type:'ping'});await h.app.next(value=>value.type==='pong');
  // A STOP the robot answers as failed (wheels not confirmed, R1) reaches the app as failed.
  h.app.send({type:'command',id:'halt2',action:'stop'});await h.device.next(value=>value.id==='halt2');h.device.send({type:'ack',id:'halt2',ok:false});
  expect(await h.app.next(value=>value.id==='halt2')).toMatchObject({ok:false,error:'device_rejected'});
});

it('exploration stop passes a full queue without cancelling unrelated commands',async()=>{
  const h=await setup(),ids=['x1','x2','x3','x4'];
  for(const id of ids){h.app.send({type:'command',id,action:'motion',yaw:0,pitch:0});await h.device.next(value=>value.id===id);}
  h.app.send({type:'command',id:'end-explore',action:'explore',on:false});

  expect(await h.device.next(value=>value.id==='end-explore')).toMatchObject({action:'explore',on:false});
  h.device.send({type:'ack',id:'x1',ok:true});
  expect(await h.app.next(value=>value.id==='x1')).toMatchObject({ok:true});
  h.device.send({type:'ack',id:'end-explore',ok:true});
  expect(await h.app.next(value=>value.id==='end-explore')).toMatchObject({ok:true});
});
