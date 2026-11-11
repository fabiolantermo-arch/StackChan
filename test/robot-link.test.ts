import {afterEach,expect,it} from 'vitest';
import {env} from 'cloudflare:workers';
import {runInDurableObject,runDurableObjectAlarm} from 'cloudflare:test';
import worker from '../src/index';
import {caps,command,packet} from '../src/robot-wire';
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
it('cannot replace an occupied device and closes the other peer on disconnect',async()=>{
  const h=await setup();const response=await h.stub.fetch(new Request('https://unit/ws',{headers:{upgrade:'websocket','x-robottino-role':'device'}}));expect(response.status).toBe(409);
  const closed=new Promise(resolve=>h.device.ws.addEventListener('close',resolve,{once:true}));h.app.ws.close();await closed;
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
  const q=await setup(),quiet=reason(q.device);await change(q.stub,'app',peer=>{peer.seen-=15001;});await runDurableObjectAlarm(q.stub);expect(await quiet).toBe('app_silent');
  const c=await setup(),late=reason(c.app);c.app.send({type:'command',id:'late',action:'camera.start'});await c.device.next(value=>value.id==='late');
  await change(c.stub,'app',peer=>{for(const pending of peer.pending)pending.until-=2000;});await runDurableObjectAlarm(c.stub);expect(await late).toBe('command_timeout');
});
