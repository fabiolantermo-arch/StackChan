// Runs the production SDK adapter with fake drivers. No camera, microphone, network or motors.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SourceTextModule,SyntheticModule,createContext} from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as wire from './live-wire.js';
import * as tracker from './tracker.js';
async function launch({token='test-device-credential-not-a-real-secret',verified=true,extra={},frame}={}){
  const context=createContext({ArrayBuffer,Uint8Array,DataView,console,Behavior:class {}}),sockets=[],timers=new Map(),inputs=[],outputs=[],calls=[],radios=[];
  let tick=1000,number=0;
  class Socket{static handshake=2;static receive=3;static disconnect=-1;constructor(options){this.options=options;this.sent=[];sockets.push(this);}write(value){this.sent.push(value);}close(){this.closed=true;}}
  class Input{constructor(options){this.options=options;this.sampleRate=16000;this.channels=1;this.bitsPerSample=16;inputs.push(this);}read(...size){assert.equal(size.length,0,'the microphone is read without a size: what is there');if(this.fail)throw Error(this.fail);if(!this.available)return undefined;const data=new ArrayBuffer(this.available);this.available=0;return data;}start(){this.started=true;}close(){this.closed=true;}}
  class Output{constructor(options){this.options=options;outputs.push(this);}write(bytes){if(this.fail)throw Error(this.fail);calls.push(['speaker',bytes.byteLength]);}start(){this.started=true;}close(){this.closed=true;}}
  class Port{constructor(_,options){this.behavior=new options.Behavior();}invalidate(){}}
  class Bitmap{static RGB565LE=1;static RGB565BE=2;constructor(width,height,format,pixels){Object.assign(this,{width,height,format,pixels});}}
  const fake=exports=>new SyntheticModule(Object.keys(exports),function(){for(const [key,value]of Object.entries(exports))this.setExport(key,value);},{context});
  const modules={'robottino-socket':{Client:Socket,lowLatency(){const lease={open:true,close(){lease.open=false;}};radios.push(lease);return lease;}},preference:{default:{get(_domain,key){return key==='deviceToken'?token:verified;}}},timer:{default:{repeat(fn,delay){const id=++number;timers.set(id,{fn,delay});return id;},set(fn,delay){const id=++number;timers.set(id,{fn:()=>{timers.delete(id);fn();},delay,once:true});return id;},clear(id){timers.delete(id);}}},time:{default:{get ticks(){return tick;},delta(start){return tick-start;}}},'embedded:io/audio/in':{default:Input},'embedded:io/audio/out':{default:Output},'piu/MC':{Container:class {}},'runtime-bitmap-port':{default:Port},'mc/config':{default:{format:'RGB565BE'}},'commodetto/Bitmap':{default:Bitmap},'robottino-live-wire':wire,'robottino-tracker':tracker};
  const source=new SourceTextModule(await readFile(new URL('./live-device.js',import.meta.url),'utf8'),{context});await source.link(name=>fake(modules[name]));await source.evaluate();
  const robot={face:{setMouthOpen(value){calls.push(["mouth",value]);},setEyeOpen(){},setEmotion(){}},ui:{showBalloon(){},showFace(){calls.push(['face']);},setMain(){calls.push(['screen']);}},connectivity:{network:{ready:Promise.resolve()}},camera:{capture:async()=>frame?frame():({width:2,height:2,imageType:'rgb565le',buffer:new ArrayBuffer(8),close(){calls.push(['frame.closed']);}}),start(options){calls.push(['camera.start',options]);},stop(){calls.push(['camera.stop']);}},audio:{acquireExclusive(){calls.push(['audio.reserve']);return()=>calls.push(['audio.release']);}}};
  const hooks={connected(){calls.push(['connected']);},disconnected(){calls.push(['disconnected']);},stop(){calls.push(['stop']);},motionEnabled:()=>true,motion:async value=>calls.push(['motion',value]),...extra};
  const live=source.namespace.createLiveDevice(robot,hooks);await live.connect();const socket=sockets[0];if(socket)socket.callback(Socket.handshake);
  const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
  async function command(action,values={}){const id=String(++number);socket.callback(Socket.receive,JSON.stringify({type:'command',id,action,...values}));await flush();return socket.sent.filter(value=>typeof value==='string').map(JSON.parse).find(value=>value.id===id);}
  return{live,socket,timers,calls,inputs,outputs,radios,command,flush,tick(value){tick=value;},media(buffer){socket.callback(Socket.receive,buffer);},disconnect(){socket.callback(Socket.disconnect);}};
}
test('SDK adapter stays inactive without credentials and rejects unverified hardware',async()=>{
  const missing=await launch({token:''});assert.equal(missing.socket,undefined);assert.equal(missing.inputs.length,0);
  const h=await launch({verified:false});assert.equal((await h.command('camera.start')).ok,false);assert.equal((await h.command('call.start')).ok,false);assert.equal((await h.command('screen.start')).ok,false);assert.equal(h.inputs.length,0);h.live.close();
});
test('SDK adapter streams camera, plays images, calls both ways and releases drivers on close',async()=>{
  const h=await launch();assert.equal(h.socket.options.Socket,undefined);assert.equal(h.inputs.length,0);
  assert.equal((await h.command('camera.start')).ok,true);for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();
  assert.ok(h.socket.sent.some(value=>value instanceof ArrayBuffer&&new DataView(value).getUint8(3)===4));assert.ok(h.calls.some(([name])=>name==='frame.closed'));
  assert.equal((await h.command('screen.start')).ok,true);h.media(wire.encodeMedia(2,1,new ArrayBuffer(8),2,2));assert.ok(h.calls.some(([name])=>name==='screen'));
  assert.equal((await h.command('call.start')).ok,true);const mic=h.inputs[0],speaker=h.outputs[0];assert.ok(mic.started&&speaker.started);
  const pieces=()=>h.socket.sent.filter(value=>value instanceof ArrayBuffer&&new DataView(value).getUint8(3)===3),count=()=>pieces().length;
  const hear=bytes=>{mic.available=bytes;mic.options.onReadable.call(mic,bytes);};
  // What the iPhone says: µ-law bytes (0xFF silence, 0x80 the loudest level), 160 of them are 640 bytes at the speaker.
  const say=(sequence,law,bytes=160)=>h.media(wire.encodeCallAudio(sequence,new Uint8Array(bytes).fill(law)));
  // A tenth of a second of the microphone (3200 bytes at 16 kHz) is one message: the marker and 800 bytes of µ-law.
  hear(3200);assert.equal(count(),1);assert.equal(pieces()[0].byteLength,12+2+800);assert.deepEqual([...new Uint8Array(pieces()[0],12,4)],[0xB1,0x08,0xFF,0xFF]);
  hear(1600);assert.equal(count(),1,'half a piece waits for the other half');hear(1600);assert.equal(count(),2);
  say(2,0xFF);speaker.options.onWritable.call(speaker,640);hear(3200);assert.equal(count(),3,'continuous silent input must not mute the microphone');
  say(3,0x80);speaker.options.onWritable.call(speaker,640);hear(3200);assert.equal(count(),3,'audible speaker output must gate echo');assert.ok(h.calls.some(([name,value])=>name==='mouth'&&value===.8));speaker.options.onWritable.call(speaker,4);assert.deepEqual(h.calls.filter(([name])=>name==='mouth').at(-1),['mouth',0]);
  h.tick(1300);hear(1600);assert.equal(count(),3);hear(1600);assert.equal(count(),4);
  h.socket.bufferedAmount=5729;hear(6400);assert.equal(count(),4,'the camera is on: more than a piece of image and two of sound waiting, the new audio is dropped, memory stays bounded');
  h.socket.bufferedAmount=0;hear(6400);assert.equal(count(),6,'room again: audio goes');
  h.disconnect();await h.flush();assert.ok(mic.closed&&speaker.closed&&h.socket.closed);assert.equal(h.timers.size,0);assert.ok(h.calls.some(([name])=>name==='audio.release'));
});
test('a call while the robot follows a face: sound may wait behind one piece of image (two pieces of sound at most), the image never behind sound (10 Nov 2026)',async()=>{
  const h=await launch({extra:{follow(){},headPose:()=>({y:0,p:0}),aim:()=>true}});
  const kind=type=>h.socket.sent.filter(value=>value instanceof ArrayBuffer&&new DataView(value).getUint8(3)===type).length,sound=()=>kind(3),image=()=>kind(6);
  const pump=async()=>{for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();};
  assert.equal((await h.command('call.start')).ok,true);const mic=h.inputs[0],hear=bytes=>{mic.available=bytes;mic.options.onReadable.call(mic,bytes);};
  h.socket.bufferedAmount=1601;hear(3200);assert.equal(sound(),0,'the call alone: nothing more behind two pieces of sound');
  assert.equal((await h.command('track.start')).ok,true);
  // The rest of a 4 KB piece of image (4096 + 20 of header + 8 of the WebSocket) waits for the connection.
  h.socket.bufferedAmount=4124;hear(3200);assert.equal(sound(),1,'the sound goes behind the piece of image');
  h.socket.bufferedAmount=4124+822;hear(3200);assert.equal(sound(),2,'and one more piece');
  h.socket.bufferedAmount=4124+822*2;hear(3200);assert.equal(sound(),2,'not a third: memory stays bounded');
  h.socket.bufferedAmount=822;await pump();assert.equal(image(),0,'no image while sound waits');
  h.socket.bufferedAmount=0;await pump();assert.ok(image()>0,'the image leaves when nothing waits');hear(3200);assert.equal(sound(),3);
  assert.equal((await h.command('track.stop')).ok,true);
  h.socket.bufferedAmount=4124;hear(3200);assert.equal(sound(),3,'camera off: the limit of the call alone again');
  h.socket.bufferedAmount=0;hear(3200);assert.equal(sound(),4);
  h.live.close();
});
test('call: the microphone is read for what is there, and no error leaves its callback or the speaker\'s (restarts of 10 Nov 2026)',async()=>{
  // The host calls the microphone's callback without catching anything: an error that leaves it restarts the robot.
  const start=async()=>{const h=await launch();assert.equal((await h.command('call.start')).ok,true);return {h,mic:h.inputs[0],speaker:h.outputs[0]};};
  const audio=h=>h.socket.sent.filter(value=>value instanceof ArrayBuffer&&new DataView(value).getUint8(3)===3).map(value=>value.byteLength-14);
  const later=h=>{for(const timer of [...h.timers.values()])if(timer.once)timer.fn();};
  {
    const {h,mic,speaker}=await start();
    // JavaScript was late: the host announced more than what is left. What is there goes, a piece for every 3200 bytes.
    mic.available=3200;mic.options.onReadable.call(mic,8192);assert.deepEqual(audio(h),[800]);
    mic.available=0;mic.options.onReadable.call(mic,640);assert.equal(audio(h).length,1,'nothing there: nothing sent');
    mic.available=3203;mic.options.onReadable.call(mic,3203);assert.deepEqual(audio(h),[800,800],'whole samples only');
    // With nothing from the iPhone the speaker plays silence, 512 bytes at a time.
    speaker.options.onWritable.call(speaker,1100);assert.deepEqual(h.calls.filter(([name])=>name==='speaker').map(([,bytes])=>bytes),[512,512,76]);
    // The speaker refuses a write: nothing leaves its callback, the sound from the iPhone stays for the next turn.
    h.media(wire.encodeCallAudio(1,new Uint8Array(160).fill(0xFF)));speaker.fail='insufficient space';const played=h.calls.length;
    assert.doesNotThrow(()=>speaker.options.onWritable.call(speaker,640));assert.equal(h.calls.length,played);
    speaker.fail=undefined;speaker.options.onWritable.call(speaker,640);assert.deepEqual(h.calls.at(-1),['speaker',640]);
    // The read itself fails, as on the robot: the error stays inside, and nothing is closed inside the callback.
    mic.fail='invalid size';const sent=audio(h).length;
    assert.doesNotThrow(()=>mic.options.onReadable.call(mic,640));assert.doesNotThrow(()=>mic.options.onReadable.call(mic,640));
    assert.equal(audio(h).length,sent);assert.ok(!mic.closed&&!h.socket.closed,'not inside the callback');
    assert.equal([...h.timers.values()].filter(timer=>timer.once).length,1,'one timer ends the link');
    // Then the link ends from a timer: the iPhone sees it close, the drivers are released.
    later(h);await h.flush();
    assert.ok(h.socket.closed&&mic.closed&&speaker.closed);assert.ok(h.calls.some(([name])=>name==='disconnected'));assert.ok(h.calls.some(([name])=>name==='audio.release'));assert.equal(h.timers.size,0);
  }
  {
    // The connection refuses the audio (it closed meanwhile): the same, nothing leaves the callback.
    const {h,mic}=await start();h.socket.write=()=>{throw Error('socket_closed');};
    mic.available=3200;assert.doesNotThrow(()=>mic.options.onReadable.call(mic,3200));assert.ok(!mic.closed);
    later(h);await h.flush();assert.ok(h.socket.closed&&mic.closed);assert.equal(h.timers.size,0);
  }
  {
    // A link that closes by itself while the timer waits clears it.
    const {h,mic}=await start();mic.fail='invalid size';mic.options.onReadable.call(mic,640);
    h.disconnect();await h.flush();assert.equal(h.timers.size,0);assert.ok(mic.closed);
  }
});
test('call: only audio in the call\'s format reaches the speaker, and at most 0.4 s of it waits (10 Nov 2026)',async()=>{
  const h=await launch();assert.equal((await h.command('call.start')).ok,true);const speaker=h.outputs[0];
  const played=()=>h.calls.filter(([name])=>name==='speaker').map(([,bytes])=>bytes),loud=()=>h.calls.some(([name,value])=>name==='mouth'&&value>0);
  // The 16 kHz PCM16 of an app from before: dropped, the speaker plays silence instead of noise.
  h.media(wire.encodeMedia(3,1,new Uint8Array(640).fill(0x30).buffer));speaker.options.onWritable.call(speaker,640);assert.deepEqual(played(),[512,128]);assert.ok(!loud());
  // A piece longer than 0.2 s: dropped whole.
  h.media(wire.encodeCallAudio(2,new Uint8Array(1602).fill(0x80)));speaker.options.onWritable.call(speaker,512);assert.deepEqual(played(),[512,128,512]);assert.ok(!loud());
  // Five pieces arrive together: four wait (0.4 s at the speaker), the fifth is dropped.
  for(let i=0;i<5;i++)h.media(wire.encodeCallAudio(3+i,new Uint8Array(800).fill(0x80)));
  speaker.options.onWritable.call(speaker,16000);assert.deepEqual(played().slice(3),[3200,3200,3200,3200,512,512,512,512,512,512,128]);assert.ok(loud());
  // Each piece continues the one before: the first sample of the second is not a jump from silence.
  h.media(wire.encodeCallAudio(9,new Uint8Array(2).fill(0x80)));
  const writes=[];speaker.write=bytes=>writes.push(...new Int16Array(bytes.slice().buffer));speaker.options.onWritable.call(speaker,8);assert.deepEqual(writes,[32124,32124,32124,32124]);
  // After the call the count starts again from silence.
  assert.equal((await h.command('call.stop')).ok,true);assert.equal((await h.command('call.start')).ok,true);const next=h.outputs[1];
  h.media(wire.encodeCallAudio(10,new Uint8Array(2).fill(0x80)));const first=[];next.write=bytes=>first.push(...new Int16Array(bytes.slice().buffer));next.options.onWritable.call(next,8);assert.deepEqual(first,[16062,32124,32124,32124]);
  h.live.close();
});
test('the link ends when nothing has come from the server for 12 s, and stays while the server answers (10 Nov 2026)',async()=>{
  const h=await launch(),beat=()=>{for(const timer of [...h.timers.values()])if(timer.delay===5000)timer.fn();};
  const pings=()=>h.socket.sent.filter(value=>typeof value==='string'&&JSON.parse(value).type==='ping').length;
  // The handshake was at 1000. Two pings without an answer are not yet 12 s.
  h.tick(6000);beat();assert.equal(pings(),1);h.tick(11000);beat();assert.equal(pings(),2);assert.ok(!h.socket.closed);
  // Anything from the server starts the count again.
  h.tick(12000);h.socket.callback(3,JSON.stringify({type:'pong'}));
  h.tick(17000);beat();h.tick(22000);beat();assert.equal(pings(),4);assert.ok(!h.socket.closed);
  // 15 s of silence: the way from the server is blocked. The link ends, and mod.js makes a new one.
  h.tick(27000);beat();assert.equal(pings(),4,'no ping on a link given up');
  assert.ok(h.socket.closed);assert.ok(h.calls.some(([name])=>name==='disconnected'));assert.equal(h.timers.size,0);
});
test('face following: small frames paced by the network, each answer turns the head from where it was at that frame',async()=>{
  const aims=[];let pose={y:.1,p:-.05},blocked=false;
  const h=await launch({extra:{follow(enabled){h.calls.push(['follow',enabled]);if(enabled&&blocked)throw Error('motion_unavailable');},headPose:()=>({...pose}),aim(value){aims.push(value);return true;}}});
  const frames=()=>h.socket.sent.filter(value=>value instanceof ArrayBuffer&&new DataView(value).getUint8(3)===6).map(value=>new DataView(value).getUint32(12));
  const capture=async()=>{for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();};
  assert.equal((await h.command('track.start')).ok,true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.filter(([name])=>name==='camera.start'||name==='follow'))),[['follow',true],['camera.start',{width:160,height:120,imageType:'rgb565le'}]]);
  await capture();assert.deepEqual(frames(),[1]);
  await capture();assert.deepEqual(frames(),[1],'at most one frame every 150 ms');
  h.tick(1150);h.socket.bufferedAmount=1;await capture();assert.deepEqual(frames(),[1],'not while the last frame is still leaving');
  h.socket.bufferedAmount=0;pose={y:.3,p:-.1};await capture();assert.deepEqual(frames(),[1,2]);
  assert.equal((await h.command('track',{frameId:1,x:.25,y:.5})).ok,true);
  assert.deepEqual(JSON.parse(JSON.stringify(aims)),[{x:.25,y:.5,pose:{y:.1,p:-.05}}],'the head pose of frame 1, not the current one');
  assert.equal((await h.command('track',{frameId:99,x:.5,y:.5})).ok,false,'an unknown frame moves nothing');
  assert.equal((await h.command('track',{frameId:2,x:1.5,y:.5})).ok,false);assert.equal(aims.length,1);
  assert.equal((await h.command('camera.start')).ok,false,'the video waits while following');
  assert.equal((await h.command('track.stop')).ok,true);assert.deepEqual(h.calls.filter(([name])=>name==='follow').at(-1),['follow',false]);assert.ok(h.calls.some(([name])=>name==='camera.stop'));
  assert.equal((await h.command('track',{frameId:2,x:.5,y:.5})).ok,false,'answers after the stop are refused');
  blocked=true;const starts=h.calls.filter(([name])=>name==='camera.start').length;
  assert.equal((await h.command('track.start')).ok,false,'no following when the head may not move');assert.equal(h.calls.filter(([name])=>name==='camera.start').length,starts,'and the camera stays off');
  h.live.close();
});
test('during a conversation the robot says so to the iPhone and sends the following frames slower (250 ms)',async()=>{
  let talking=false;
  const h=await launch({extra:{conversation:()=>talking,follow(){},headPose:()=>({y:0,p:0}),aim(){return true;}}});
  const hellos=()=>h.socket.sent.filter(value=>typeof value==='string').map(JSON.parse).filter(value=>value.type==='hello');
  assert.equal(hellos().at(-1).capabilities.conversation,false);
  talking=true;h.live.hello();assert.equal(hellos().at(-1).capabilities.conversation,true);
  const frames=()=>h.socket.sent.filter(value=>value instanceof ArrayBuffer&&new DataView(value).getUint8(3)===6).length;
  const capture=async()=>{for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();};
  assert.equal((await h.command('track.start')).ok,true);await capture();assert.equal(frames(),1);
  h.tick(1200);await capture();assert.equal(frames(),1,'200 ms later: still waiting during the conversation');
  h.tick(1250);await capture();assert.equal(frames(),2,'250 ms later: the next frame');
  talking=false;h.tick(1400);await capture();assert.equal(frames(),3,'after the conversation: every 150 ms again');
  h.live.close();
});
test('a 320×240 frame leaves in 4 KB pieces, only when nothing waits in the socket (answers stay quick); the next one waits for the last piece',async()=>{
  let closedFrames=0;
  const h=await launch({frame:()=>({width:320,height:240,imageType:'rgb565le',buffer:new ArrayBuffer(153600),close(){closedFrames++;}})});
  const pieces=()=>h.socket.sent.filter(value=>value instanceof ArrayBuffer&&new DataView(value).getUint8(3)===4);
  const run=async()=>{for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();};
  assert.equal((await h.command('camera.start')).ok,true);
  let waiting=0;Object.defineProperty(h.socket,'bufferedAmount',{get:()=>waiting});
  const write=h.socket.write.bind(h.socket);h.socket.write=value=>{write(value);if(value instanceof ArrayBuffer)waiting+=value.byteLength;};
  await run();assert.equal(pieces().length,1,'one piece, then something waits');assert.ok(pieces()[0].byteLength<=4116);
  await run();assert.equal(pieces().length,1,'nothing more while it waits');assert.equal(closedFrames,0,'the frame waits for its last piece');
  for(let i=0;i<80&&closedFrames===0;i++){waiting=0;await run();}
  assert.equal(pieces().length,38,'the whole frame, piece by piece');assert.equal(closedFrames,1);
  waiting=0;await run();assert.equal(pieces().length,38,'the next frame waits 333 ms');
  h.tick(1400);await run();assert.equal(pieces().length,39,'then the next frame starts');
  h.live.close();assert.equal(closedFrames,2,'closing gives the frame in flight back');
});
test('an answer to the iPhone never waits behind more than one 4 KB piece of image',async()=>{
  const h=await launch({extra:{follow(){},headPose:()=>({y:0,p:0}),aim(){return true;}}});
  let waiting=0,most=0;Object.defineProperty(h.socket,'bufferedAmount',{get:()=>waiting});
  const write=h.socket.write.bind(h.socket);h.socket.write=value=>{write(value);waiting+=typeof value==='string'?value.length:value.byteLength;most=Math.max(most,waiting);};
  assert.equal((await h.command('track.start')).ok,true);
  for(let i=0;i<30;i++){for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();if(i%3===2)waiting=0;}
  assert.ok(most<=4116+200,'at most one piece waits: '+most);
  h.live.close();
});
test('following sends the whole 160×120 frame in grey, piece by piece; the frame halved to 80×60 while the robot listens (10 Nov 2026)',async()=>{
  let closedFrames=0,listening=false;const pixels=new Uint16Array(160*120).fill(0x07E0); // pure green, full level
  const h=await launch({frame:()=>({width:160,height:120,imageType:'rgb565le',buffer:pixels.buffer,close(){closedFrames++;}}),extra:{follow(){},headPose:()=>({y:0,p:0}),aim(){return true;},listening:()=>listening}});
  let waiting=0;Object.defineProperty(h.socket,'bufferedAmount',{get:()=>waiting});
  const write=h.socket.write.bind(h.socket);h.socket.write=value=>{write(value);if(value instanceof ArrayBuffer)waiting+=value.byteLength;};
  const pump=async()=>{for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();};
  const pieces=()=>h.socket.sent.filter(value=>value instanceof ArrayBuffer&&new DataView(value).getUint8(3)===6);
  assert.equal((await h.command('track.start')).ok,true);
  await pump();assert.equal(pieces().length,1,'one piece, then it waits for the socket');assert.equal(closedFrames,0,'the camera frame stays until the last piece');
  waiting=0;await pump();assert.equal(pieces().length,2,'one piece per camera tick, even with room for more');
  for(let i=0;i<10&&closedFrames===0;i++){waiting=0;await pump();}
  assert.equal(pieces().length,5,'19.2 KB: five pieces');assert.equal(closedFrames,1,'then the camera frame goes back');
  const view=new DataView(pieces()[0]);assert.equal(view.getUint16(8),160);assert.equal(view.getUint16(10),120);
  assert.equal(pieces().reduce((sum,piece)=>sum+piece.byteLength-20,0),19200);assert.equal(new Uint8Array(pieces()[0],20)[0],252,'full green: 252, the scale of the 80×60 copy');
  // Listening in a conversation: never the whole frame. The halved one, three pieces converted one per camera tick.
  listening=true;waiting=0;h.tick(2000);await pump();
  assert.equal(pieces().length,6,'the first small piece');assert.equal(closedFrames,1,'the camera frame stays until the last piece');
  for(let i=0;i<4;i++){waiting=0;await pump();}
  const all=pieces().slice(5);assert.equal(all.length,3,'4800 bytes: three pieces of 20 rows');assert.equal(closedFrames,2,'then the camera frame goes back');
  for(const [k,piece] of all.entries()){const small=new DataView(piece);assert.equal(piece.byteLength,1620);assert.equal(small.getUint16(8),80);assert.equal(small.getUint16(10),60);assert.equal(small.getUint32(16),k*1600);}
  assert.equal(new Uint8Array(all[0],20)[0],252,'four full greens: 252');
  h.live.close();
});
test('once the iPhone has found the face the robot sends an 80×60 window around it, and puts the answers back in whole-frame coordinates (10 Nov 2026)',async()=>{
  // The green of each camera pixel says where it is: the first pixel of a small image tells where its window starts
  // (24: the 120×90 window at 40,30; 20: at 10,30; 0: the whole frame halved).
  const pixels=new Uint16Array(160*120);for(let y=0;y<120;y++)for(let x=0;x<160;x++)pixels[y*160+x]=((x>>5)+5*(y>>4))<<5;
  let closedFrames=0;const aims=[];
  const h=await launch({frame:()=>({width:160,height:120,imageType:'rgb565le',buffer:pixels.buffer,close(){closedFrames++;}}),extra:{follow(){},headPose:()=>({y:0,p:0}),aim(value){aims.push(value);return true;}}});
  const pump=async(times=1)=>{for(let i=0;i<times;i++){for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();}};
  const frame=id=>h.socket.sent.filter(value=>value instanceof ArrayBuffer&&new DataView(value).getUint8(3)===6&&new DataView(value).getUint32(12)===id);
  const size=id=>{const view=new DataView(frame(id)[0]);return `${view.getUint16(8)}x${view.getUint16(10)}`;},first=id=>new Uint8Array(frame(id)[0],20)[0];
  const answer=async(frameId,x,y)=>(await h.command('track',{frameId,x,y})).ok,lastAim=()=>JSON.parse(JSON.stringify(aims.at(-1)));
  assert.equal((await h.command('track.start')).ok,true);
  await pump(6);assert.equal(frame(1).length,5,'no face yet: the whole frame');assert.equal(size(1),'160x120');assert.equal(closedFrames,1);
  assert.equal(await answer(1,.75,.75),true);assert.deepEqual(lastAim(),{x:.75,y:.75,pose:{y:0,p:0}});
  // The face is known: small frames, 250 ms apart.
  h.tick(1200);await pump();assert.equal(frame(2).length,0,'200 ms: not yet');
  h.tick(1250);await pump();assert.equal(frame(2).length,1);assert.equal(closedFrames,1,'the camera frame stays until the last piece');
  await pump(3);assert.equal(frame(2).length,3);assert.equal(closedFrames,2);
  assert.equal(size(2),'80x60');assert.deepEqual(frame(2).map(piece=>[piece.byteLength,new DataView(piece).getUint32(16)]),[[1620,0],[1620,1600],[1620,3200]]);
  assert.equal(first(2),24,'the window at 40,30: the bottom right of the frame, where the face was');
  // A quarter of the window from its left, half its height: 70 of 160 and 75 of 120 in the whole frame.
  assert.equal(await answer(2,.25,.5),true);assert.deepEqual(lastAim(),{x:.4375,y:.625,pose:{y:0,p:0}});
  // The next one waits until the connection has room for all of it, 600 ms at most.
  h.socket.room=1000;h.tick(1500);await pump();assert.equal(frame(3).length,0,'the network has not confirmed the last image yet');
  h.tick(1849);await pump();assert.equal(frame(3).length,0);
  h.tick(1850);await pump(4);assert.equal(frame(3).length,3,'600 ms: it goes anyway');assert.equal(first(3),20,'the window moved with the face: 10,30');
  h.socket.room=1000;h.tick(2100);await pump();assert.equal(frame(4).length,0);
  h.socket.room=4000;await pump();assert.equal(frame(4).length,0,'room for two pieces is not enough');
  h.socket.room=5000;await pump(4);assert.equal(frame(4).length,3,'room again: at once');assert.equal(size(4),'80x60');
  // An answer at the edge of a window is no place to remember: the head turns to that edge of the window (10 of 160
  // in the whole frame), and the next frame is whole.
  assert.equal(await answer(4,0,.5),true);assert.deepEqual(lastAim(),{x:.0625,y:.625,pose:{y:0,p:0}});assert.equal(aims.length,3);
  h.tick(2250);await pump(6);assert.equal(size(5),'160x120');assert.equal(frame(5).length,5);
  // Found again, then no answers: when the first small frame after the answer has waited long enough (tracker.js
  // LOCK_WAIT_MS) the whole frame comes back.
  assert.equal(await answer(5,.75,.75),true);assert.equal(aims.length,4);
  let id=5;const lost=2500+tracker.LOCK_WAIT_MS;assert.ok(tracker.LOCK_WAIT_MS>=1000&&tracker.LOCK_WAIT_MS%250===0);
  for(let at=2500;at<lost;at+=250){h.tick(at);await pump(4);id++;assert.equal(size(id),'80x60',`frame ${id}`);assert.equal(first(id),24);}
  h.tick(lost-1);await pump();assert.equal(frame(id+1).length,0);
  h.tick(lost);await pump(6);id++;assert.equal(size(id),'160x120','lost: the whole frame');
  // That size never got an answer: the other one next time (the whole frame halved, for a face that is near).
  assert.equal(await answer(id,.75,.75),true);
  h.tick(lost+250);await pump(4);id++;assert.equal(size(id),'80x60');assert.equal(first(id),0,'the whole frame halved');
  assert.equal(await answer(id,.3,.6),true);assert.deepEqual(lastAim(),{x:.3,y:.6,pose:{y:0,p:0}},'its answers are already in whole-frame coordinates');
  // An answer for a frame the robot no longer remembers moves nothing; stopping forgets the face.
  assert.equal(await answer(99,.5,.5),false);
  assert.equal((await h.command('track.stop')).ok,true);assert.equal((await h.command('track.start')).ok,true);
  h.tick(lost+1500);await pump(6);id++;assert.equal(size(id),'160x120','after a new start the whole frame again');
  h.live.close();
});
test('a head command waiting for the servos pauses the camera: no capture, no sending, a late frame is dropped',async()=>{
  let busy=false,captures=0,closedFrames=0;const pixels=new Uint16Array(160*120).fill(0x07E0);
  const h=await launch({frame:()=>{captures++;return {width:160,height:120,imageType:'rgb565le',buffer:pixels.buffer,close(){closedFrames++;}};},extra:{follow(){},headPose:()=>({y:0,p:0}),aim(){return true;},motionBusy:()=>busy}});
  assert.equal((await h.command('track.start')).ok,true);busy=true;
  const pump=async()=>{for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();};
  const grey=()=>h.socket.sent.filter(value=>value instanceof ArrayBuffer&&new DataView(value).getUint8(3)===6).length;
  await pump();await pump();assert.equal(captures,0,'no capture while the servos have not confirmed');assert.equal(grey(),0);
  busy=false;await pump();assert.equal(captures,1);for(let i=0;i<4;i++)await pump();assert.equal(grey(),5,'the image goes once the command is confirmed, a piece per tick');
  // A frame that arrives while a new command waits is given back and not sent.
  h.tick(10000);const before=grey();
  for(const timer of h.timers.values())if(timer.delay===25){busy=false;timer.fn();busy=true;}
  await h.flush();assert.equal(grey(),before,'the frame captured before the command is dropped');assert.equal(closedFrames,2,'and given back to the camera driver');
  h.live.close();
});
test('the camera starts and stops only once the servos have confirmed, and no head command starts meanwhile',async()=>{
  let busy=false,moving=false;const h=await launch({extra:{follow(){},headPose:()=>({y:0,p:0}),aim(){return true;},motionBusy:()=>busy,headMoving:()=>moving}});
  busy=true;
  const started=()=>h.calls.filter(([name])=>name==='camera.start').length,waits=()=>[...h.timers.values()].filter(t=>t.once);
  const answer=h.command('track.start');await h.flush();
  assert.equal(started(),0,'a head command waits for its confirmation: the camera does not start yet');assert.equal(waits().length,1);
  busy=false;waits()[0].fn();await h.flush();await answer;assert.equal(started(),1,'confirmed: the camera starts');
  assert.equal(h.live.busy(),false,'and is no longer switching');
  // Following frames only with the head still.
  const pieces=()=>h.socket.sent.filter(value=>value instanceof ArrayBuffer&&new DataView(value).getUint8(3)===6).length;
  const pump=async()=>{for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();};
  moving=true;h.tick(100);await pump();assert.equal(pieces(),0,'the head is turning: no frame');
  moving=false;await pump();assert.ok(pieces()>0,'still again: a frame');
  const sent=pieces();moving=true;h.tick(100+150);await pump();assert.equal(pieces(),sent,'moving again, not yet 1 s without a frame');
  h.tick(100+1200);await pump();assert.ok(pieces()>sent,'after 1 s without a frame, one is taken anyway');
  h.live.close();
});
test('video and following use the same camera size: the host never rebuilds the camera (crash of 9 Nov 2026)',async()=>{
  const h=await launch({extra:{follow(){},headPose:()=>({y:0,p:0}),aim(){return true;}}});
  assert.equal((await h.command('camera.start')).ok,true);assert.equal((await h.command('camera.stop')).ok,true);
  assert.equal((await h.command('track.start')).ok,true);
  const sizes=h.calls.filter(([name])=>name==='camera.start').map(([,options])=>`${options.width}x${options.height}`);
  assert.deepEqual(sizes,['160x120','160x120']);h.live.close();
});
test('when the link closes during following, the camera stops first and the face is not redrawn needlessly',async()=>{
  const h=await launch({extra:{follow(){},headPose:()=>({y:0,p:0}),aim(){return true;}}});
  assert.equal((await h.command('track.start')).ok,true);
  h.disconnect();await h.flush();
  const names=h.calls.map(([name])=>name);
  assert.ok(names.includes('camera.stop'));assert.ok(!names.includes('face'),'no iPhone image was on the screen');
  const s=await launch();assert.equal((await s.command('screen.start')).ok,true);assert.equal((await s.command('camera.start')).ok,true);
  s.disconnect();await s.flush();const order=s.calls.map(([name])=>name);
  assert.ok(order.lastIndexOf('camera.stop')<order.lastIndexOf('face'),'camera first, then the face back: '+order.join(','));
});
test('the Wi-Fi stays awake only while the camera or a call streams, and is given back when the link closes (10 Nov 2026)',async()=>{
  const h=await launch({extra:{follow(){},headPose:()=>({y:0,p:0}),aim(){return true;}}}),awake=()=>h.radios.filter(lease=>lease.open).length;
  assert.equal(h.radios.length,0,'at rest the host saves power');
  assert.equal((await h.command('camera.start')).ok,true);assert.equal(awake(),1);
  assert.equal((await h.command('call.start')).ok,true);assert.equal(h.radios.length,1,'one lease for both');
  assert.equal((await h.command('camera.stop')).ok,true);assert.equal(awake(),1,'the call still streams');
  assert.equal((await h.command('call.stop')).ok,true);assert.equal(awake(),0,'nothing streams: back to saving power');
  assert.equal((await h.command('track.start')).ok,true);assert.equal(awake(),1,'following');assert.equal(h.radios.length,2);
  assert.equal((await h.command('track.stop')).ok,true);assert.equal(awake(),0);
  assert.equal((await h.command('track.start')).ok,true);assert.equal(awake(),1);
  h.disconnect();await h.flush();assert.equal(awake(),0,'a link that closes gives the radio back');
  const refused=await launch({verified:false});assert.equal((await refused.command('camera.start')).ok,false);assert.equal(refused.radios.length,0,'a refused camera takes no lease');refused.live.close();
});

test('«cos’è questo?»: one colour picture leaves piece by piece for the conversation; the camera is switched on only for it (11 Nov 2026)',async()=>{
  const frames=[];const frame=()=>{const f={width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(38400),close(){f.closed=true;}};new Uint8Array(f.buffer).fill(7);frames.push(f);return f;};
  const h=await launch({frame});const count=name=>h.calls.filter(([n])=>n===name).length;
  const pump=async()=>{for(const timer of [...h.timers.values()])if(timer.delay===25)timer.fn();await h.flush();};
  const got=[];let room=true;
  let result;const done=h.live.snapshot(piece=>{if(!room)return false;got.push(piece);return true;}).then(ok=>{result=ok;});
  await h.flush();assert.equal(count('camera.start'),1,'the camera was off: switched on for the picture');
  await pump();assert.equal(frames.length,0,'the exposure settles first');
  h.tick(2000);await pump();assert.equal(frames.length,1);
  await pump();assert.equal(got.length,1,'one piece per turn');
  room=false;await pump();await pump();assert.equal(got.length,1,'no room in the conversation: the piece waits');
  room=true;for(let i=0;i<9;i++)await pump();assert.equal(got.length,10);assert.equal(result,undefined);assert.equal(frames[0].closed,undefined,'the frame stays until the last piece has gone');
  await pump();await done;assert.equal(result,true);assert.equal(frames[0].closed,true);assert.equal(count('camera.stop'),1,'and the camera is switched off again');
  assert.deepEqual([...got[0].subarray(0,10)],[0x52,0x49,0x4d,0x47,0,10,160,0,120,0]);assert.equal(got[9][4],9);assert.equal(got.reduce((sum,piece)=>sum+piece.length-10,0),38400);
  assert.ok(!h.socket.sent.some(value=>value instanceof ArrayBuffer),'nothing of it goes to the iPhone');
  // With the video already on, the next frame is used and the camera stays on; a picture that cannot leave ends in 7 s.
  assert.equal((await h.command('camera.start')).ok,true);const starts=count('camera.start'),stops=count('camera.stop');
  let second;const again=h.live.snapshot(()=>false).then(ok=>{second=ok;});await h.flush();
  for(let i=0;i<6;i++){h.tick(3000+i*400);await pump();}
  assert.equal(second,undefined);h.tick(3000+8000);await pump();await again;assert.equal(second,false,'given up');
  assert.equal(count('camera.start'),starts);assert.equal(count('camera.stop'),stops,'the video’s camera is left on');
  let third;const last=h.live.snapshot(()=>{throw Error('closed');}).then(ok=>{third=ok;});await h.flush();
  for(let i=0;i<4&&third===undefined;i++){h.tick(12000+i*400);await pump();}
  await last;assert.equal(third,false,'a closed conversation ends the picture');
  h.live.close();
});

test('while Robottino talks following sends no image; it goes on when the robot listens again (11 Nov 2026)',async()=>{
  let speaking=false;const frames=[];const frame=()=>{const f={width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(38400),close(){}};frames.push(f);return f;};
  const h=await launch({frame,extra:{follow(){},headPose:()=>({y:0,p:0}),aim(){return true;},conversation:()=>true,listening:()=>!speaking,speaking:()=>speaking}});
  const pump=async()=>{for(const timer of [...h.timers.values()])if(timer.delay===25)timer.fn();await h.flush();};
  assert.equal((await h.command('track.start')).ok,true);
  h.tick(2000);for(let i=0;i<6;i++)await pump();const before=frames.length;assert.ok(before>0,'listening: frames go');
  speaking=true;for(let i=0;i<12;i++){h.tick(3000+i*400);await pump();}
  assert.equal(frames.length,before,'talking: no capture at all');
  speaking=false;for(let i=0;i<6;i++){h.tick(9000+i*400);await pump();}
  assert.ok(frames.length>before,'listening again: following goes on');h.live.close();
});
