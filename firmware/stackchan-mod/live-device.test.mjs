// Runs the production SDK adapter with fake drivers. No camera, microphone, network or motors.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SourceTextModule,SyntheticModule,createContext} from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as wire from './live-wire.js';
import * as tracker from './tracker.js';
const trackerMod=tracker;
import * as k210mod from './k210.js';
async function launch({token='test-device-credential-not-a-real-secret',verified=true,extra={},frame,finder,trace}={}){
  const context=createContext({ArrayBuffer,Uint8Array,DataView,console,Behavior:class {},...(trace?{trace}:{})}),sockets=[],timers=new Map(),inputs=[],outputs=[],calls=[],radios=[];
  let tick=1000,number=0;
  class Socket{static handshake=2;static receive=3;static disconnect=-1;constructor(options){this.options=options;this.sent=[];sockets.push(this);}write(value){this.sent.push(value);}close(){this.closed=true;}}
  class Input{constructor(options){this.options=options;this.sampleRate=16000;this.channels=1;this.bitsPerSample=16;inputs.push(this);}read(...size){assert.equal(size.length,0,'the microphone is read without a size: what is there');if(this.fail)throw Error(this.fail);if(!this.available)return undefined;const data=new ArrayBuffer(this.available);this.available=0;return data;}start(){this.started=true;}close(){this.closed=true;}}
  class Output{constructor(options){this.options=options;outputs.push(this);}write(bytes){if(this.fail)throw Error(this.fail);calls.push(['speaker',bytes.byteLength]);}start(){this.started=true;}close(){this.closed=true;}}
  class Port{constructor(_,options){this.behavior=new options.Behavior();}invalidate(){}}
  class Bitmap{static RGB565LE=1;static RGB565BE=2;constructor(width,height,format,pixels){Object.assign(this,{width,height,format,pixels});}}
  const fake=exports=>new SyntheticModule(Object.keys(exports),function(){for(const [key,value]of Object.entries(exports))this.setExport(key,value);},{context});
  const modules={modules:{default:{has:name=>name==='robottino-face-finder'&&!!finder,importNow:()=>finder}},'robottino-socket':{Client:Socket,lowLatency(){const lease={open:true,close(){lease.open=false;}};radios.push(lease);return lease;}},preference:{default:{get(_domain,key){return key==='deviceToken'?token:verified;}}},timer:{default:{repeat(fn,delay){const id=++number;timers.set(id,{fn,delay});return id;},set(fn,delay){const id=++number;timers.set(id,{fn:()=>{timers.delete(id);fn();},delay,once:true});return id;},clear(id){timers.delete(id);}}},time:{default:{get ticks(){return tick;},delta(start){return tick-start;}}},'embedded:io/audio/in':{default:Input},'embedded:io/audio/out':{default:Output},'piu/MC':{Container:class {}},'runtime-bitmap-port':{default:Port},'mc/config':{default:{format:'RGB565BE'}},'commodetto/Bitmap':{default:Bitmap},'robottino-live-wire':wire,'robottino-tracker':tracker,'robottino-k210':k210mod};
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

// A face finder like the host's (firmware/host/face/face-finder.js): `faces` are the answers, one a frame.
function fakeFinder(faces){
  const calls=[];
  return {calls,find(buffer,width,height,hx,hy,hs){calls.push({bytes:buffer.byteLength,width,height,hx,hy,hs});const face=faces.length>1?faces.shift():faces[0];return face?face.x+256*face.y+65536*face.size+16777216*Math.round(face.score*10):0;},tested:()=>100,
    unpack:value=>value?{x:value&255,y:(value>>>8)&255,size:(value>>>16)&255,score:Math.floor(value/16777216)/10}:undefined};
}
test('following alone: the robot finds the face in its own frames and aims the head, nothing leaves it (13 Nov 2026)',async()=>{
  let closedFrames=0,busy=false,speaking=false,moving=false,pose={y:0,p:-.4};const aims=[];
  const finder=fakeFinder([{x:120,y:30,size:40,score:20},{x:80,y:60,size:40,score:8},{x:80,y:60,size:40,score:2},null,{x:40,y:60,size:30,score:5},{x:40,y:60,size:30,score:9}]);
  const h=await launch({finder,frame:()=>({width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(160*120*2),close(){closedFrames++;}}),
    extra:{headPose:()=>pose,aim(value){aims.push(JSON.parse(JSON.stringify(value)));return true;},motionBusy:()=>busy,speaking:()=>speaking,headMoving:()=>moving}});
  const turn=async(at)=>{if(at)h.tick(at);for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();};
  assert.equal(h.live.selfAvailable,true);assert.equal(h.live.selfActive,false);
  await h.live.self(true);assert.equal(h.live.selfActive,true);
  assert.equal(JSON.stringify(h.calls.find(([n])=>n==='camera.start')[1]),JSON.stringify({width:160,height:120,imageType:'rgb565le'}),'the one camera size');
  await turn(1100);
  assert.deepEqual(finder.calls[0],{bytes:38400,width:160,height:120,hx:0,hy:0,hs:0},'no face known: everywhere');
  assert.equal(aims.length,1);assert.deepEqual([aims[0].x,aims[0].y,aims[0].pose,aims[0].gain],[.75,.25,{y:0,p:-.4},.9]);
  assert.equal(closedFrames,1,'the frame goes back at once');assert.equal(h.socket.sent.some(value=>value instanceof ArrayBuffer),false,'no picture leaves the robot');
  // The head has turned to the face: the next search is where the face must be now, about the middle.
  pose={y:-.25,p:-.6};await turn(1130);
  assert.ok(Math.abs(finder.calls[1].hx-80)<=2&&Math.abs(finder.calls[1].hy-60)<=2&&finder.calls[1].hs===40,JSON.stringify(finder.calls[1]));
  assert.equal(aims.length,2);
  await turn(1160);assert.equal(aims.length,2,'a weak answer near the face is not a face');
  assert.equal(finder.calls[3]?.hs??0,0);await turn(1190);assert.equal(finder.calls[3].hs,0,'lost: everywhere again');assert.equal(aims.length,2);
  await turn(1220);assert.equal(aims.length,2,'everywhere, a face needs more confidence');
  moving=true;await turn(1250);assert.equal(aims.length,3);assert.equal(aims[2].gain,.5,'with the head turning: half of the way');moving=false;
  // The servos come first, and the voice.
  busy=true;const before=finder.calls.length;await turn(1280);assert.equal(finder.calls.length,before,'a head command waits for its confirmation: no frame');busy=false;
  speaking=true;await turn(1310);await turn(1340);assert.equal(finder.calls.length,before,'talking: at most a frame every 120 ms (the last was at 1250)');
  await turn(1380);assert.equal(finder.calls.length,before+1);await turn(1410);await turn(1470);assert.equal(finder.calls.length,before+1);await turn(1510);assert.equal(finder.calls.length,before+2);speaking=false;
  assert.equal(closedFrames,finder.calls.length,'every frame went back');
  await h.live.self(false);assert.equal(h.live.selfActive,false);assert.ok(h.calls.some(([n])=>n==='camera.stop'));
});
test('no face in sight: the head looks at all the space it can reach in ten stops, as a zigzag, the way the face was going first (14 Nov 2026)',async()=>{
  // Owner: «usa uno schema di movimento ottimizzato quando mi perde, uno zigzag o qualcosa che calcoli tu, ottimizzato
  // per fare minori movimenti possibili e maggiore spazio controllato». Before: small moves around the last place,
  // which never looked where the owner had gone («mi ha perso andando a sinistra e cerca in basso»).
  let pose={y:0,p:-.44},moving=false;const looks=[],aims=[],faces=[null];
  const finder=fakeFinder(faces),stops=list=>list.map(([y,p])=>Math.round(y*57.3)+'/'+Math.round(-p*57.3)).join(' ');
  const h=await launch({finder,frame:()=>({width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(160*120*2),close(){}}),
    extra:{headPose:()=>pose,headMoving:()=>moving,aim(value){aims.push([value.x,value.y,value.gain]);return true;},look(value){looks.push([value.y,value.p]);pose={y:value.y,p:value.p};return true;}}});
  const turn=async at=>{h.tick(at);for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();};
  await h.live.self(true);let at=1100;
  for(;at<2600;at+=100)await turn(at);assert.deepEqual(looks,[],'not at once: a face may just be turning');
  for(;at<3000;at+=100)await turn(at);assert.equal(stops(looks),'-39/22','nobody, sitting height: the same height first, to a side (owner, 19:25: «mi si continua a girare in alto»)');
  moving=true;for(;at<4600;at+=100)await turn(at);assert.equal(looks.length,1,'not while the head turns');moving=false;
  for(;at<40000&&looks.length<10;at+=100)await turn(at);
  // Sideways 39° at a time, 30° between the two heights: one height out to its end, the other on the way back.
  assert.equal(stops(looks),'-39/22 -78/22 39/22 78/22 78/52 39/52 0/52 -39/52 -78/52 0/22','ten stops: the sitting height, both sides (owner, 19:52: «si è girato a sinistra e poi in alto»), then the standing one; for the whole space, each next to the one before but for one crossing');
  assert.equal(aims.length,0,'never a jump on a guess');
  const rested=at;for(;at<rested+18000;at+=100)await turn(at);assert.equal(looks.length,10,'then it rests where a sitting person is: 20 s with no conversation');
  for(;at<rested+24000;at+=100)await turn(at);assert.ok(looks.length>=11,'and starts again');
  // A face seen on the left of the picture, then lost: after 2 s the round begins on that side (owner: «mi ha perso
  // andando a sinistra e cerca in basso»), goes on to its end, and comes back at the other height.
  for(const end=at+40000;at<end;at+=100)await turn(at);
  pose={y:0,p:-.4};faces[0]={x:40,y:60,size:40,score:20};await turn(at+=100);assert.equal(aims.length,1,'the face is followed');const before=looks.length;
  faces[0]=null;for(const end=at+1800;at<end;at+=100)await turn(at);assert.equal(looks.length,before,'just lost: the head waits');
  for(const end=at+9000;at<end;at+=100)await turn(at);
  assert.equal(stops(looks.slice(before,before+4)),'39/22 78/22 -39/22 -78/22','to the side the face was going, then the other side at the same height');
  // Lost high up with no way known (the owner standing still, then gone): down first, to where he sits.
  for(const end=at+60000;at<end;at+=100)await turn(at);
  pose={y:-.2,p:-.86};faces[0]={x:80,y:60,size:40,score:20};await turn(at+=100);await turn(at+=100);await turn(at+=100);const high=looks.length;
  faces[0]=null;for(const end=at+9000;at<end;at+=100)await turn(at);
  assert.equal(stops(looks.slice(high,high+2)),'0/22 -39/22','from where a standing person is: the lower height first');
});

test('how long nobody has been seen: from the last face, or from when the camera began to look (14 Nov 2026)',async()=>{
  // Owner: «se per 30 secondi non vede nessuno, deve fermarsi e chiudere gli occhi» (mod.js reads selfAloneMs).
  const faces=[null],finder=fakeFinder(faces);
  const h=await launch({finder,frame:()=>({width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(160*120*2),close(){}}),
    extra:{headPose:()=>({y:0,p:-.4}),headMoving:()=>false,aim(){return true;},look(){return true;}}});
  const turn=async at=>{h.tick(at);for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();};
  assert.equal(h.live.selfAloneMs,0,'not looking: not alone');
  await h.live.self(true);const began=h.now?.()??1000;await turn(began+5000);
  assert.ok(Math.abs(h.live.selfAloneMs-5000)<200,'no face yet: counted from when the camera began to look: '+h.live.selfAloneMs);
  faces[0]={x:80,y:60,size:40,score:20};await turn(began+6000);faces[0]=null;assert.ok(h.live.selfAloneMs<200,'a face: no longer alone');
  await turn(began+6000+31000);assert.ok(Math.abs(h.live.selfAloneMs-31000)<300,'31 s after the last face: '+h.live.selfAloneMs);
  await h.live.self(false);assert.equal(h.live.selfAloneMs,0);
});
test('following with the K210 on the head (23 Nov 2026, «l\'inseguimento facciamolo con la nuova camera»): its faces aim the head, each picture once and only with the head still; the camera\'s own search does not run',async()=>{
  let pose={y:0,p:-.4},settled=true,k210={seq:1,faces:1,x:.25,y:.5,w:.1,h:.1,score:.8,ms:69};const aims=[];
  const finder=fakeFinder([{x:120,y:30,size:40,score:20}]);
  const h=await launch({finder,frame:()=>({width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(160*120*2),close(){}}),
    extra:{headPose:()=>pose,aim(value){aims.push(JSON.parse(JSON.stringify(value)));return true;},headSettled:()=>settled,k210:()=>k210}});
  const turn=async(at)=>{if(at)h.tick(at);for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();};
  await h.live.self(true);await turn(1100);
  assert.equal(aims.length,1);assert.equal(finder.calls.length,0,'the robot camera\'s search does not run');
  // 25 % from the left of the K210's wider picture: further out in the robot camera's (CAMERA_FOV).
  const x=.5-(.5-.25)*k210mod.K210_FOV.m12.x/trackerMod.CAMERA_FOV.x;
  assert.ok(Math.abs(aims[0].x-x)<1e-9&&Math.abs(aims[0].y-.5)<1e-9,JSON.stringify(aims[0]));
  await turn(1130);assert.equal(aims.length,1,'the same picture: once');
  k210={...k210,seq:2};settled=false;await turn(1160);assert.equal(aims.length,1,'the head on its way: that picture is not used');
  settled=true;k210={...k210,seq:3,x:.5};await turn(1190);assert.equal(aims.length,2,'a new picture with the head still');
  k210=undefined;await turn(1220);assert.equal(finder.calls.length,1,'no K210: the robot camera searches again');
  h.live.close();
});
test('a voice while nobody is in sight: the time alone starts again and the look around goes first to the side of the voice (14 Nov 2026)',async()=>{
  // Owner: «girarsi verso la voce quando non ti vede» (mod.js calls selfWake with the side sound-ear.js gave).
  for(const side of [1,-1]){
    let pose={y:0,p:-.44};const looks=[],faces=[null],finder=fakeFinder(faces);
    const h=await launch({finder,frame:()=>({width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(160*120*2),close(){}}),
      extra:{headPose:()=>pose,headMoving:()=>false,aim(){return true;},look(value){looks.push([value.y,value.p]);pose={y:value.y,p:value.p};return true;}}});
    const turn=async at=>{h.tick(at);for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();};
    assert.equal(h.live.selfWake(side),false,'the camera is not looking: nothing to wake');
    await h.live.self(true);const began=1000;
    // Half a minute with nobody (mod.js stops the head: here the look hook simply goes on answering).
    for(let at=began;at<=began+31000;at+=500)await turn(at);
    assert.ok(h.live.selfAloneMs>=30000);
    pose={y:0,p:-.44};looks.length=0; // asleep the head is back at its place of rest
    assert.equal(h.live.selfWake(side),true);assert.ok(h.live.selfAloneMs<200,'awake for another half minute');
    for(let at=began+31500;at<=began+36000;at+=500)await turn(at);
    assert.ok(looks.length>=1,'it looks around again');
    assert.ok(looks[0][0]*side>.3,`the first move goes to the robot's ${side>0?'left':'right'}: ${JSON.stringify(looks[0])}`);
    await h.live.self(false);
  }
});
test('the side the face is going to (15 Nov 2026: «se vede la persona che sparisce sulla sinistra deve girarsi a sinistra e viceversa»): left in the picture is the robot\'s left',async()=>{
  const faces=[null],finder=fakeFinder(faces);
  const h=await launch({finder,frame:()=>({width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(160*120*2),close(){}}),
    extra:{headPose:()=>({y:0,p:-.44}),headMoving:()=>false,aim(){return true;},look(){return true;}}});
  const turn=async at=>{h.tick(at);for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();};
  await h.live.self(true);let at=1000;const show=async x=>{faces[0]=x===undefined?null:{x,y:60,size:40,score:20};await turn(at+=500);};
  assert.equal(h.live.selfSide,0,'nobody seen yet');
  await show(80);assert.equal(h.live.selfSide,0,'in the middle: no way');
  await show(88);assert.equal(h.live.selfSide,0,'a twentieth of the picture is the detector\'s jitter');
  await show(30);assert.equal(h.live.selfSide,1,'at the left of the picture: going to the robot\'s left');
  await show();await show();assert.equal(h.live.selfSide,1,'gone: the side stays');
  await show(130);assert.equal(h.live.selfSide,-1,'at the right of the picture: to the robot\'s right');
  await show(150);await show(80);assert.equal(h.live.selfSide,-1,'further right, then in the middle once: still on its way, from the frames before');
  await show(80);assert.equal(h.live.selfSide,0,'staying in the middle: no way');
  await h.live.self(false);
});
test('the rover looks for the face with the whole body (15 Nov 2026): the head stays where it is; when the body stops searching it looks around again',async()=>{
  let pose={y:.5,p:-.44},turns;const looks=[],faces=[null],finder=fakeFinder(faces);
  const h=await launch({finder,frame:()=>({width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(160*120*2),close(){}}),
    extra:{headPose:()=>pose,headMoving:()=>false,bodySearch:()=>turns,aim(){return true;},look(value){looks.push([value.y,value.p]);pose={y:value.y,p:value.p};return true;}}});
  const turn=async at=>{h.tick(at);for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();};
  await h.live.self(true);let at=1000;
  turns=0;for(;at<=28000;at+=500){turns=Math.floor(at/2000);await turn(at);}
  assert.deepEqual(looks,[],'no look around: the turning body carries the view');
  // The body no longer searches (asleep, a conversation, following switched off): the head looks around again.
  turns=undefined;looks.length=0;for(;at<=40000;at+=500)await turn(at);
  assert.ok(looks.length>=3,'the head\'s own look around: '+looks.length);
  await h.live.self(false);
});
test('following alone needs the face finder of the host; the iPhone’s «Segui il mio viso» uses it too (13 Nov 2026)',async()=>{
  const none=await launch({extra:{follow(){},headPose:()=>({y:0,p:0}),aim(){return true;}}});
  assert.equal(none.live.selfAvailable,false);await assert.rejects(()=>none.live.self(true),/finder_unavailable/);
  assert.equal((await none.command('track.start')).ok,true);assert.equal(none.live.selfActive,false,'an older host: frames go to the iPhone as before');
  const aims=[],follows=[],finder=fakeFinder([{x:80,y:60,size:50,score:30}]);
  const h=await launch({finder,frame:()=>({width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(160*120*2),close(){}}),extra:{follow(on){follows.push(on);},headPose:()=>({y:0,p:0}),aim(value){aims.push(value);return true;}}});
  const turn=async at=>{h.tick(at);for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();};
  assert.equal((await h.command('track.start')).ok,true);assert.equal(h.live.selfActive,true);assert.deepEqual(follows,[true]);
  await turn(1100);await turn(1130);assert.equal(aims.length,2);assert.equal(h.socket.sent.some(value=>value instanceof ArrayBuffer),false,'no frame goes to the iPhone');
  {const answer=await h.command('camera.start');assert.equal(answer.ok,false,'following owns the camera');}
  assert.equal((await h.command('track.stop')).ok,true);assert.equal(h.live.selfActive,false,'the iPhone stops what it started');assert.deepEqual(follows,[true,false]);
  // Started by a conversation, it goes on when the iPhone's following ends.
  await h.live.self(true);assert.equal((await h.command('track.start')).ok,true);assert.equal((await h.command('track.stop')).ok,true);assert.equal(h.live.selfActive,true);
  await h.live.self(false);assert.equal(h.live.selfActive,false);
});

test('with the neural detector a frame is searched in its own task: nothing waits, the answer aims the head with the pose of that frame (13 Nov 2026)',async()=>{
  // The cascade never found the owner's real face in the camera's pictures; the host's neural detector is asked instead.
  let pose={y:0,p:-.3},closedFrames=0,captures=0;const aims=[],started=[],answers=[];
  const finder={neural:()=>true,neuralMs:()=>60,tested:()=>0,find(){throw Error('the cascade is not used');},unpack(){return undefined;},
    startNeural(buffer,width,height){started.push([buffer.byteLength,width,height]);return 1;},pollNeural(){return answers.length?answers.shift():-1;},
    unpackNeural:value=>value>0?{x:value&255,y:(value>>>8)&255,size:(value>>>16)&255,score:Math.floor(value/16777216)/1000}:undefined};
  const pack=(x,y,size,score)=>x+256*y+65536*size+16777216*Math.round(score*1000);
  const h=await launch({finder,frame:()=>{captures++;return {width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(160*120*2),close(){closedFrames++;}};},
    extra:{headPose:()=>pose,headMoving:()=>false,aim(value){aims.push(JSON.parse(JSON.stringify(value)));return true;}}});
  const turn=async at=>{h.tick(at);for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();};
  await h.live.self(true);await turn(1100);
  assert.deepEqual(started,[[38400,160,120]],'a copy of the frame goes to the detector');assert.equal(closedFrames,1,'and the frame goes back to the camera at once');
  pose={y:.5,p:-.3};await turn(1125);await turn(1150);assert.equal(captures,1,'still searching: no new frame, nothing waits');assert.equal(aims.length,0);
  answers.push(pack(120,30,44,.83));await turn(1175);
  assert.equal(aims.length,1);assert.deepEqual([aims[0].x,aims[0].y,aims[0].pose,aims[0].gain],[.75,.25,{y:0,p:-.3},.9],'the pose the frame was taken with, not the head’s pose now');
  assert.equal(captures,2,'and the next frame is taken in the same turn');
  answers.push(0);await turn(1200);assert.equal(aims.length,1,'no face: nothing');assert.equal(captures,3);
  answers.push(pack(80,60,40,.3));await turn(1225);assert.equal(aims.length,1,'under the score a face is not counted');
  // A detector that never answers is given up after 3 s.
  const before=captures;for(let at=1250;at<4200;at+=25)await turn(at);assert.equal(captures,before,'waiting');
  for(let at=4200;at<4400;at+=25)await turn(at);assert.equal(captures,before+1,'given up: the next frame');
  await h.live.self(false);assert.equal(h.live.selfActive,false);
});

test('with the neural detector no frame is taken while the head turns: the head is not where the frame says yet (13 Nov 2026)',async()=>{
  // Owner, after the search went from 0.19 s to 0.08 s: «l'inseguimento mi sembra peggiorato». Frames taken on the
  // way to the face sent the head past it.
  let pose={y:0,p:-.3},moving=false,captures=0;const aims=[],answers=[],lines=[];
  const finder={neural:()=>true,neuralMs:()=>60,tested:()=>0,find(){throw Error('the cascade is not used');},unpack(){return undefined;},
    startNeural(){return 1;},pollNeural(){return answers.length?answers.shift():-1;},
    unpackNeural:value=>value>0?{x:value&255,y:(value>>>8)&255,size:(value>>>16)&255,score:Math.floor(value/16777216)/1000}:undefined};
  const pack=(x,y,size,score)=>x+256*y+65536*size+16777216*Math.round(score*1000);
  const h=await launch({finder,trace:text=>lines.push(text),frame:()=>{captures++;return {width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(160*120*2),close(){}};},
    extra:{headPose:()=>pose,headMoving:()=>moving,aim(value){aims.push(JSON.parse(JSON.stringify(value)));return true;}}});
  const turn=async at=>{h.tick(at);for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();};
  await h.live.self(true);await turn(1100);assert.equal(captures,1);
  // The answer aims the head; the next frame is taken at once, before the head starts (its pose is still true).
  answers.push(pack(120,30,44,.83));await turn(1125);assert.equal(aims.length,1);assert.equal(captures,2);
  // The head is on its way: the answer of that frame is taken, with the pose it was taken at, but no new frame.
  moving=true;pose={y:-.2,p:-.45};answers.push(pack(120,30,44,.83));await turn(1150);
  assert.equal(aims.length,2);assert.deepEqual([aims[1].pose,aims[1].gain],[{y:0,p:-.3},.9],'the same aim as before: nothing is added to it');
  for(let at=1175;at<1400;at+=25)await turn(at);assert.equal(captures,2,'turning: no frame');assert.equal(aims.length,2);
  // Arrived and still: frames again, with the pose of now.
  moving=false;await turn(1400);assert.equal(captures,3);answers.push(pack(84,58,44,.9));await turn(1425);
  assert.equal(aims.length,3);assert.deepEqual(aims[2].pose,{y:-.2,p:-.45});
  // A host that says when the head has really arrived (mod.js headSettled) is believed, whatever the older wait says.
  {let settled=false,shots=0;const fast={neural:()=>true,neuralMs:()=>60,tested:()=>0,find(){return 0;},unpack(){return undefined;},startNeural(){return 1;},pollNeural(){return 0;},unpackNeural(){return undefined;}};
    const g=await launch({finder:fast,frame:()=>{shots++;return {width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(160*120*2),close(){}};},extra:{headPose:()=>({y:0,p:0}),headMoving:()=>false,headSettled:()=>settled,aim(){return true;}}});
    const go=async at=>{g.tick(at);for(const timer of g.timers.values())if(timer.delay===25)timer.fn();await g.flush();};
    await g.live.self(true);for(let at=1100;at<1600;at+=25)await go(at);assert.equal(shots,0,'not settled yet: no frame, although the older wait is over');
    settled=true;await go(1600);assert.equal(shots,1,'settled: a frame');await g.live.self(false);}
  // The trail on the USB log: where each frame showed the face, and where the head is.
  answers.push(0);for(let at=1450;at<6400;at+=25){if(!answers.length)answers.push(0);await turn(at);}
  const trail=lines.find(line=>line.includes('self trail'));assert.ok(trail,'a trail every 5 s');
  assert.match(trail,/self trail 727254(?:\.\.)+ head=-11,-26\n$/);
});

test.skip('SWITCHED OFF (SELF_QUICK, SELF_FAR, SELF_GONE_STEPS: worse on the robot, 13 Nov 2026 23:00) — a face being followed is searched quickly, near where it must be; both networks again when it is lost and every 2 s (13 Nov 2026)',async()=>{
  // On the robot the second network takes 70 ms more: it is asked only to make sure, the first one follows.
  let pose={y:0,p:-.3};const started=[],answers=[],aims=[];
  const pack=(x,y,size,score)=>x+256*y+65536*size+16777216*Math.round(score*1000);
  const finder={neural:()=>true,neuralMs:()=>50,tested:()=>0,find(){return 0;},unpack(){return undefined;},neuralSize(w,h){started.push(['size',w,h]);return true;},
    startNeural(buffer,width,height,quick,x,y){started.push([quick,x,y]);return 1;},pollNeural(){return answers.length?answers.shift():-1;},
    unpackNeural:value=>value>0?{x:value&255,y:(value>>>8)&255,size:(value>>>16)&255,score:Math.floor(value/16777216)/1000}:undefined};
  const h=await launch({finder,frame:()=>({width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(160*120*2),close(){}}),
    extra:{headPose:()=>pose,headMoving:()=>false,aim(value){aims.push(value);return true;}}});
  const turn=async at=>{h.tick(at);for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();};
  await h.live.self(true);await turn(1100);
  assert.deepEqual(JSON.parse(JSON.stringify(started)),[['size',96,72],[false,0,0]],'the detector works at 96×72; no face known: both networks');
  answers.push(pack(120,30,44,.9));await turn(1150);assert.equal(aims.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(started.at(-1))),[true,120,30],'seen for sure: the next search is quick, where the face was');
  // The head has turned to it: the place asked for is where the face must be now.
  pose={y:-.25,p:-.5};answers.push(pack(120,30,44,.8));await turn(1200);
  {const [quick,x,y]=started.at(-1);assert.equal(quick,true);assert.ok(Math.abs(x-80)<=3&&Math.abs(y-61)<=3,`${x},${y}`);}
  answers.push(0);await turn(1250);assert.deepEqual(JSON.parse(JSON.stringify(started.at(-1))),[false,0,0],'not found quickly: both networks at once');
  answers.push(pack(80,60,44,.9));await turn(1300);assert.equal(started.at(-1)[0],true);
  // Followed without a break: every 2 s both networks make sure it is a face.
  let whole=0;for(let at=1350;at<3600;at+=50){answers.push(pack(80,60,44,.8));await turn(at);if(started.at(-1)[0]===false)whole++;}
  assert.ok(whole>=1&&whole<=3,`both networks ${whole} times in 2.2 s`);
  await h.live.self(false);
});

test.skip('SWITCHED OFF AGAIN (SELF_GONE_STEPS 0, 14 Nov 2026 09:15: with the full size and the gentler moves the owner said «non funziona») — a face that leaves by an edge is followed that way, two steps at most, then the small moves (14 Nov 2026)',async()=>{
  // Owner: «se vado troppo in alto mi perde». Standing up close to the robot, the face goes out by the top of the picture.
  let pose={y:0,p:-.5};const answers=[],aims=[],looks=[];
  const pack=(x,y,size,score)=>x+256*y+65536*size+16777216*Math.round(score*1000);
  const finder={neural:()=>true,neuralMs:()=>60,tested:()=>0,find(){return 0;},unpack(){return undefined;},neuralSize(){return true;},
    startNeural(){return 1;},pollNeural(){return answers.length?answers.shift():0;},
    unpackNeural:value=>value>0?{x:value&255,y:(value>>>8)&255,size:(value>>>16)&255,score:Math.floor(value/16777216)/1000}:undefined};
  const h=await launch({finder,frame:()=>({width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(160*120*2),close(){}}),
    extra:{headPose:()=>pose,headMoving:()=>false,aim(value){aims.push([value.x,value.y,value.gain]);return true;},look(value){looks.push(value);return true;}}});
  const turn=async at=>{h.tick(at);for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();};
  await h.live.self(true);
  // The face at the top of the picture (y 24 of 120), then gone.
  await turn(1100);answers.push(pack(80,24,60,.9));await turn(1150);assert.equal(aims.length,1);
  let at=1200;for(;at<1650;at+=50)await turn(at);assert.equal(aims.length,1,'gone for less than half a second: nothing yet');
  for(;at<1900;at+=50)await turn(at);assert.deepEqual(aims[1],[.5,0,1],'after it: half a picture up');
  for(;at<2700;at+=50)await turn(at);assert.deepEqual(aims[2],[.5,0,1],'still not there half a second later: once more');assert.equal(aims.length,3);
  for(;at<4000;at+=50)await turn(at);assert.equal(aims.length,3,'two steps, no more');assert.equal(looks.length,0,'then it waits as after any lost face');
  for(;at<6500;at+=50)await turn(at);assert.equal(aims.length,3);assert.ok(looks.length>=1,'and makes its small moves around where the face was');
  // Found again and lost in the middle of the picture: no step towards an edge.
  const before=aims.length;answers.push(pack(80,60,60,.9));await turn(at+=50);await turn(at+=50);assert.equal(aims.length,before+1);
  for(const end=at+1500;at<end;at+=50)await turn(at);assert.equal(aims.length,before+1,'lost in the middle: only the wait');
  // Standing up and walking away to one side (owner: «mi alzo e vado a sinistra e lui si gira a destra»): last seen above
  // and beside the middle, not yet near an edge. The head goes that way on both axes at once.
  answers.push(pack(56,40,50,.9));await turn(at+=50);await turn(at+=50);const rising=aims.length;
  for(const end=at+900;at<end;at+=50)await turn(at);assert.deepEqual(aims[rising],[0,0,1],'up and to that side together');
  answers.push(pack(80,60,60,.9));await turn(at+=50);await turn(at+=50);for(const end=at+1500;at<end;at+=50)await turn(at);
  // Out by the right-hand side: after it, that way.
  answers.push(pack(150,60,60,.9));await turn(at+=50);await turn(at+=50);const side=aims.length;
  for(const end=at+900;at<end;at+=50)await turn(at);assert.deepEqual(aims[side],[1,.5,1],'to the side it left by');
  await h.live.self(false);
});

test.skip('SWITCHED OFF (SELF_FAR: worse on the robot, 13 Nov 2026 23:00; the step after an edge is on again, see the test above) — a face that leaves by an edge is followed that way at once; a small or lost face makes the detector work at full size (13 Nov 2026)',async()=>{
  // Owner: «se mi alzo in su si perde ogni tanto», «anche se vado in basso».
  let pose={y:0,p:-.3};const sizes=[],answers=[],aims=[];
  const pack=(x,y,size,score)=>x+256*y+65536*size+16777216*Math.round(score*1000);
  const finder={neural:()=>true,neuralMs:()=>60,tested:()=>0,find(){return 0;},unpack(){return undefined;},neuralSize(w,h){sizes.push([w,h]);return true;},
    startNeural(){return 1;},pollNeural(){return answers.length?answers.shift():0;},
    unpackNeural:value=>value>0?{x:value&255,y:(value>>>8)&255,size:(value>>>16)&255,score:Math.floor(value/16777216)/1000}:undefined};
  const h=await launch({finder,frame:()=>({width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(160*120*2),close(){}}),
    extra:{headPose:()=>pose,headMoving:()=>false,aim(value){aims.push([value.x,value.y,value.gain]);return true;}}});
  const turn=async at=>{h.tick(at);for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();};
  await h.live.self(true);assert.deepEqual(JSON.parse(JSON.stringify(sizes)),[[96,72]],'near faces: the quick size');
  // The owner stands up: the face is at the top of the picture, then gone.
  await turn(1100);answers.push(pack(80,14,60,.9));await turn(1150);assert.equal(aims.length,1);
  let at=1200;for(;at<1600;at+=50)await turn(at);assert.equal(aims.length,1,'gone for less than half a second: nothing yet');
  for(;at<2000;at+=50)await turn(at);assert.deepEqual(aims[1],[.5,0,1],'after it, upwards, without the 3 s wait');
  for(;at<3800;at+=50)await turn(at);assert.equal(aims.length,2,'one step that way, then the usual wait and the small moves');
  assert.deepEqual(JSON.parse(JSON.stringify(sizes.at(-1))),[0,0],'not found for over a second: the detector at its full size, for a far face');
  // Found again, small: full size stays; near and big again: back to the quick size.
  answers.push(pack(80,60,30,.8));await turn(at+=50);answers.push(pack(80,60,30,.8));await turn(at+=50);assert.deepEqual(JSON.parse(JSON.stringify(sizes.at(-1))),[0,0]);
  answers.push(pack(80,60,60,.9));await turn(at+=50);answers.push(pack(80,60,60,.9));await turn(at+=50);assert.deepEqual(JSON.parse(JSON.stringify(sizes.at(-1))),[96,72]);
  // Going down: the face leaves by the bottom edge, the head goes after it.
  const before=aims.length;answers.push(pack(80,110,60,.9));await turn(at+=50);await turn(at+=50);
  for(const end=at+900;at<end;at+=50)await turn(at);assert.deepEqual(aims.at(-1),[.5,1,1],'downwards');assert.ok(aims.length>before);
  await h.live.self(false);
});

test('in a conversation the voice comes first: a frame every 0.8 s while Robottino talks, every 0.25 s while it listens, a slow look around (14 Nov 2026)',async()=>{
  // First conversation with the neural detector at full pace (13 Nov): the speaker ran dry for up to 1.6 s and the internal
  // RAM went to 0 KB; then no frame at all while talking and one every 0.5 s: «non mi sta seguendo» (14 Nov, with the
  // internal RAM doubled). The frames are paced, never one after the other as at rest.
  let talking=false,speaking=false,captures=0;const sizes=[],aims=[];
  const finder={neural:()=>true,neuralMs:()=>80,tested:()=>0,find(){return 0;},unpack(){return undefined;},neuralSize(w,h){sizes.push([w,h]);return true;},
    startNeural(){return 1;},pollNeural(){return 0;},unpackNeural(){return undefined;}};
  const h=await launch({finder,frame:()=>{captures++;return {width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(160*120*2),close(){}};},
    extra:{headPose:()=>({y:0,p:-.3}),headMoving:()=>false,conversation:()=>talking,speaking:()=>speaking,aim(value){aims.push(value);return true;},look(value){aims.push(value);return true;}}});
  const run=async(from,to)=>{for(let at=from;at<to;at+=25){h.tick(at);for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();}};
  await h.live.self(true);await run(1100,2100);const idle=captures;assert.ok(idle>=10,`with no conversation the frames are searched one after the other: ${idle} in a second`);
  talking=true;speaking=true;await run(2100,4100);assert.ok(captures-idle>=2&&captures-idle<=3,`Robottino talks: a frame every 0.8 s (${captures-idle} in 2 s; 0.4 s until 14 Nov 2026, 20:01: «la voce sta andando un po' a scatti»)`);
  speaking=false;const before=captures;await run(4100,7100);assert.ok(captures-before>=10&&captures-before<=13,`listening: one frame every quarter of a second (${captures-before} in 3 s)`);
  const moved=aims.length;await run(7100,16000);assert.ok(aims.length-moved>=2&&aims.length-moved<=4,`its small moves are slow, one every 2.5 s (${aims.length-moved} in 9 s)`);
  assert.ok(sizes.every(([w,h])=>w===96&&h===72),'and the detector stays at its quick size');
  await h.live.self(false);
});

test('every frame is searched with both networks, at the quick size; a missed frame moves nothing; lost for over a second, the slower detector is asked (14 Nov 2026)',async()=>{
  // The quick search (first network only) made following worse on the robot and stays off. The full size for far faces
  // is on again since 14 Nov 2026 (owner, standing up: «non mi segue bene»), like the step after a face that left by an
  // edge (its own test is above).
  let pose={y:0,p:-.3},last,sees;const started=[],sizes=[],answers=[],aims=[],looks=[]; // sees: what each detector answers when nothing is scripted
  const pack=(x,y,size,score)=>x+256*y+65536*size+16777216*Math.round(score*1000);
  const finder={neural:()=>true,neuralMs:()=>120,tested:()=>0,find(){return 0;},unpack(){return undefined;},neuralSize(w,h){sizes.push([w,h]);return true;},
    startNeural(buffer,width,height,quick){started.push(quick);last=quick;return 1;},pollNeural(){return answers.length?answers.shift():sees?(last===2?sees.deep:sees.quick):0;},
    unpackNeural:value=>value>0?{x:value&255,y:(value>>>8)&255,size:(value>>>16)&255,score:Math.floor(value/16777216)/1000}:undefined};
  const h=await launch({finder,frame:()=>({width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(160*120*2),close(){}}),
    extra:{headPose:()=>pose,headMoving:()=>false,aim(value){aims.push([value.x,value.y,value.gain]);return true;},look(value){looks.push(value);return true;}}});
  const turn=async at=>{h.tick(at);for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();};
  await h.live.self(true);let at=1100;
  for(const face of [[80,60,50],[100,50,30],[90,55,28]]){answers.push(pack(...face,.9));await turn(at+=50);}await turn(at+=50);
  assert.equal(aims.length,3,'each face found aims the head');
  // The face in the middle of the picture, small, then missed for a second and a half: nothing moves, no change of size.
  for(const end=at+1500;at<end;at+=50)await turn(at);
  assert.equal(aims.length,3);assert.equal(looks.length,0,'missed frames move nothing');
  // Owner standing still in front of the robot for twenty seconds, never found by the quick pair (14 Nov 2026): after
  // 1.2 s with no face the frames go to the host's other detector (mode 2).
  const firstDeep=started.indexOf(2);assert.ok(firstDeep>=3,'both networks while the face is found: '+started.map(mode=>mode||0).join(''));assert.ok(started.slice(0,firstDeep).every(mode=>!mode));
  // Nobody found: the slower detector takes a frame every second and a half, the quick pair the others.
  {const after=started.slice(firstDeep),deepFrames=after.filter(mode=>mode===2).length;assert.ok(deepFrames>=1&&deepFrames<=2,`in the 0.3 s after the first: ${after.map(mode=>mode||0).join('')}`);}
  assert.deepEqual(JSON.parse(JSON.stringify(sizes)),[[96,72]],'one size for the quick pair');
  for(const end=at+4500;at<end;at+=50)await turn(at);assert.ok(looks.length>=1,'then the look around (after SELF_LOST_MS, 5 s)');
  // The slower detector finds the face: it keeps the frames (owner standing, 14 Nov 2026: each time it had found him
  // the frames went back to the quick pair, which does not see him, for 1.2 s).
  sees={deep:pack(80,60,60,.8),quick:0};for(const end=at+2000;at<end;at+=50)await turn(at);
  assert.ok(started.slice(-4).every(mode=>mode===2),'found by the slower detector at its next frame: from then on it goes on with it');
  // Every 4 s one frame goes to the quick pair. It finds nothing: the slower detector again.
  const probed=started.length;for(const end=at+4300;at<end;at+=50)await turn(at);
  const later=started.slice(probed);assert.equal(later.filter(mode=>!mode).length,1,'the quick pair is tried again with one frame: '+later.map(mode=>mode||0).join(''));assert.equal(later.at(-1),2);
  // The owner sits down: the next try of the quick pair finds the face, and the frames are its own again.
  sees={deep:pack(80,60,60,.8),quick:pack(80,60,60,.9)};for(const end=at+4300;at<end;at+=50)await turn(at);
  assert.ok(started.slice(-5).every(mode=>!mode),'found by the quick pair: its frames from now on');
  await h.live.self(false);
});

// The Live video as JPEG pictures (14 Nov 2026). A host that makes them: head empty bytes, then a «JPEG» of the size asked for.
const jpegHost=(sizes,made=[])=>({videoJpeg(buffer,width,height,quality,head){made.push({width,height,quality,head,bytes:buffer.byteLength});const size=sizes.length>1?sizes.shift():sizes[0];if(size<0)return size;const out=new ArrayBuffer(head+size),body=new Uint8Array(out,head);body[0]=0xff;body[1]=0xd8;body[size-2]=0xff;body[size-1]=0xd9;return out;},videoMs:()=>4,videoEnd(){made.push('end');}});
const videoFrame=calls=>()=>({width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(38400),close(){calls.push('closed');}});
const kinds=h=>h.socket.sent.filter(value=>value instanceof ArrayBuffer).map(value=>new DataView(value).getUint8(3));
test('the K210\'s pictures are the Live video when it sends them (23 Nov 2026, «nella live dell\'app si deve vedere la nuova camera»): each once, no robot camera picture taken; without them the robot camera as before',async()=>{
  const made=[],closed=[];let image;
  const picture=id=>{const buffer=new ArrayBuffer(12+300),body=new Uint8Array(buffer,12);body[0]=0xff;body[1]=0xd8;return {id,buffer,width:160,height:120};};
  const h=await launch({finder:jpegHost([5000],made),frame:videoFrame(closed),extra:{k210Image:()=>image}});
  const turn=async at=>{h.tick(at);for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();};
  assert.equal((await h.command('camera.start',{jpeg:true})).ok,true);
  image=picture(1);await turn(1000);await turn(1400);
  const jpegs=()=>h.socket.sent.filter(value=>value instanceof ArrayBuffer&&new DataView(value).getUint8(3)===8);
  assert.equal(jpegs().length,1,'the K210 picture, once');assert.equal(made.length,0,'no robot camera picture made');
  const sent=new DataView(jpegs()[0]);assert.deepEqual([sent.getUint16(8),sent.getUint16(10),sent.byteLength],[160,120,312]);
  image=picture(2);await turn(1800);assert.equal(jpegs().length,2,'the next one');
  image=undefined;await turn(2200);await turn(2600);assert.ok(made.length>=1,'no K210 pictures: the robot camera again');
  h.live.close();
});
test('video asked as JPEG: each picture is one message of a few KB, made by the host and written at once; the camera frame goes straight back (14 Nov 2026)',async()=>{
  const made=[],closed=[],lines=[],h=await launch({finder:jpegHost([5000],made),frame:videoFrame(closed),trace:line=>lines.push(line)});
  const turn=async at=>{h.tick(at);for(const timer of [...h.timers.values()])if(timer.delay===25)timer.fn();await h.flush();};
  assert.equal((await h.command('camera.start',{jpeg:true})).ok,true);
  h.socket.room=11488;h.socket.bufferedAmount=0;
  await turn(1000);
  const sent=h.socket.sent.filter(value=>value instanceof ArrayBuffer);assert.equal(sent.length,1);
  const view=new DataView(sent[0]);assert.equal(sent[0].byteLength,12+5000);
  assert.deepEqual([view.getUint16(0),view.getUint8(3),view.getUint16(8),view.getUint16(10),view.getUint16(12)],[0x5242,8,160,120,0xffd8]);
  assert.deepEqual(made[0],{width:160,height:120,quality:wire.JPEG_QUALITY,head:12,bytes:38400});assert.equal(closed.length,1,'the camera has its frame back');
  // The next one a tenth of a second later, not before.
  await turn(1050);assert.equal(kinds(h).length,1);await turn(1100);assert.equal(kinds(h).length,2);
  // No room in the connection for a whole picture: it waits (never a queue), and goes anyway after 0.6 s.
  h.socket.room=3000;await turn(1300);assert.equal(kinds(h).length,2);
  h.socket.bufferedAmount=1;await turn(1800);assert.equal(kinds(h).length,2,'something still waits in the socket: nothing new');
  h.socket.bufferedAmount=0;await turn(1810);assert.equal(kinds(h).length,3);
  assert.ok(kinds(h).every(kind=>kind===8),'no raw piece');
  const sequences=h.socket.sent.filter(value=>value instanceof ArrayBuffer).map(value=>new DataView(value).getUint32(4));assert.deepEqual(sequences,[1,2,3]);
  // Stopping the video gives the encoder back and says on the log how it went.
  assert.equal((await h.command('camera.stop')).ok,true);assert.equal(made.at(-1),'end');
  assert.ok(lines.some(line=>/video jpeg frames=3 bytes=5000\/5000 q=65 ms=4 waited=\d+ in/.test(line)),lines.join(''));
  h.live.close();
});
test('video without the request, or with a host that has no encoder: raw pieces as before',async()=>{
  const turn=async(h,at)=>{h.tick(at);for(const timer of [...h.timers.values()])if(timer.delay===25)timer.fn();await h.flush();};
  const made=[],plain=await launch({finder:jpegHost([5000],made),frame:videoFrame([])});
  assert.equal((await plain.command('camera.start')).ok,true);await turn(plain,1000);
  const raw=h=>kinds(h).length>0&&kinds(h).every(kind=>kind===4);
  assert.ok(raw(plain));assert.equal(made.length,0,'the iPhone did not ask');plain.live.close();
  const old=await launch({finder:{},frame:videoFrame([])});
  assert.equal((await old.command('camera.start',{jpeg:true})).ok,true);await turn(old,1000);assert.ok(raw(old));old.live.close();
  const none=await launch({frame:videoFrame([])});
  assert.equal((await none.command('camera.start',{jpeg:true})).ok,true);await turn(none,1000);assert.ok(raw(none));none.live.close();
});
test('the iPhone\'s video and following alone share the camera (15 Nov 2026: hand gestures while the robot stays on its own): the video goes out from the frames of following, nothing is switched',async()=>{
  const made=[],closed=[];let talking=false;
  const finder={neural:()=>true,neuralMs:()=>60,tested:()=>0,find(){return 0;},unpack(){return undefined;},startNeural(){return 1;},pollNeural(){return 0;},unpackNeural(){return undefined;},...jpegHost([3000],made)};
  const h=await launch({finder,frame:videoFrame(closed),extra:{follow(){},headPose:()=>({y:0,p:0}),headMoving:()=>false,headSettled:()=>true,conversation:()=>talking,aim(){return true;},look(){return true;}}});
  const go=async at=>{h.tick(at);for(const timer of [...h.timers.values()])if(timer.delay===25)timer.fn();await h.flush();};
  const pictures=()=>kinds(h).filter(kind=>kind===8).length;
  h.socket.room=11488;h.socket.bufferedAmount=0;
  await h.live.self(true);let at=1000;for(;at<1300;at+=25)await go(at);
  assert.equal(pictures(),0,'following alone: nothing goes to the iPhone');assert.equal(h.live.selfActive,true);
  // The iPhone asks for the video: accepted, and following keeps the camera.
  assert.equal((await h.command('camera.start',{jpeg:true})).ok,true);assert.equal(h.live.selfActive,true,'the camera is not taken from following');
  for(;at<2300;at+=25)await go(at);
  const sent=pictures();assert.ok(sent>=4&&sent<=11,'a picture every 100 ms at most: '+sent+' in a second');
  const last=h.socket.sent.filter(value=>value instanceof ArrayBuffer).at(-1);assert.deepEqual([new DataView(last).getUint8(3),new DataView(last).getUint16(8),new DataView(last).getUint16(10)],[8,160,120]);
  // In a conversation the voice comes first: no picture for the iPhone.
  talking=true;const before=pictures();for(;at<3300;at+=25)await go(at);assert.equal(pictures(),before,'a conversation: no video');talking=false;
  // Following stops (motions switched off): the camera stays on for the iPhone alone, and comes back to following when asked.
  await h.live.self(false);assert.equal(h.live.selfActive,false);const alone=pictures();for(;at<4300;at+=25)await go(at);assert.ok(pictures()>alone,'the video goes on');
  await h.live.self(true);assert.equal(h.live.selfActive,true,'following takes the camera back without a refusal');const again=pictures();for(;at<5300;at+=25)await go(at);assert.ok(pictures()>again);
  // A conversation opening (mod.js videoHeld): with following off too, the camera is given back; ready again, the video returns.
  await h.live.self(false);h.live.videoHeld=true;await h.live.videoSync(false);const held=pictures();for(;at<6300;at+=25)await go(at);assert.equal(pictures(),held,'held: no camera');
  h.live.videoHeld=false;await h.live.videoSync(false);for(;at<7300;at+=25)await go(at);assert.ok(pictures()>held,'ready: the video is back');
  // The iPhone stops the video: following (on again) goes on alone.
  await h.live.self(true);assert.equal((await h.command('camera.stop')).ok,true);const stopped=pictures();for(;at<8300;at+=25)await go(at);
  assert.equal(pictures(),stopped,'no more pictures');assert.equal(h.live.selfActive,true,'and following still has the camera');
  // The iPhone's «Segui il mio viso» during a conversation (track.start, followed with the robot's own frames): the video
  // for the gestures is still given (23 Nov 2026: refused as camera_busy, the gestures stopped at every conversation).
  const trackAck=await h.command('track.start');assert.equal(trackAck.ok,true,JSON.stringify(trackAck));const camAck=await h.command('camera.start',{jpeg:true});assert.equal(camAck.ok,true,'video while following for the iPhone: '+JSON.stringify(camAck));
  const tracked=pictures();for(;at<9300;at+=25)await go(at);assert.ok(pictures()>tracked,'pictures go out');
  await h.live.self(false);
});
test('with the K210 leading, the look around stays near the front (23 Nov 2026, «quando mi perde va a cercarmi troppo lontano»: it went to 78° and 52° up)',async()=>{
  let pose={y:0,p:-.35},seq=1;const looks=[];
  const h=await launch({finder:fakeFinder([]),frame:()=>({width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(160*120*2),close(){}}),
    extra:{headPose:()=>pose,aim(){return true;},look(value){looks.push(value);pose={y:value.y,p:value.p};return true;},headSettled:()=>true,k210:()=>({seq,faces:0,x:0,y:0,w:0,h:0,score:0,ms:69})}});
  await h.live.self(true);
  for(let at=1000;at<40000;at+=50){seq++;h.tick(at);for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();}
  assert.ok(looks.length>=3,'it looks around: '+looks.length);
  for(const look of looks){assert.ok(Math.abs(look.y)<=.69,'never further than 39° to a side: '+JSON.stringify(look));assert.ok(look.p>=-.39&&look.p<=0,'at the height of rest: '+JSON.stringify(look));}
  h.live.close();
});
test('with the K210 leading (23 Nov 2026), the iPhone\'s answers about the robot camera\'s video move nothing: on the robot they took the head 68° away',async()=>{
  const made=[];let pose={y:.2,p:-.4},k210={seq:1,faces:0,x:0,y:0,w:0,h:0,score:0,ms:69};const aims=[];
  const finder={neural:()=>true,neuralMs:()=>60,tested:()=>0,find(){return 0;},unpack(){return undefined;},startNeural(){return 1;},pollNeural(){return 0;},unpackNeural:()=>undefined,...jpegHost([3000],made)};
  const h=await launch({finder,frame:videoFrame([]),extra:{headPose:()=>pose,headMoving:()=>false,headSettled:()=>true,aim(value){aims.push(value);return true;},look(){return true;},k210:()=>k210}});
  const go=async at=>{h.tick(at);for(const timer of [...h.timers.values()])if(timer.delay===25)timer.fn();await h.flush();};
  h.socket.room=11488;h.socket.bufferedAmount=0;
  await h.live.self(true);assert.equal((await h.command('camera.start',{jpeg:true})).ok,true);
  for(let at=1000;at<2000;at+=25){k210={...k210,seq:k210.seq+1};await go(at);}
  const frames=h.socket.sent.filter(value=>value instanceof ArrayBuffer);assert.ok(frames.length>0,'the video goes on for the iPhone');
  const before=aims.length,frame=new DataView(frames.at(-1)).getUint32(4);
  assert.equal((await h.command('track',{frameId:frame,x:.2,y:.5})).ok,true);
  assert.equal(aims.length,before,'not moved by the iPhone');assert.equal(h.live.selfHelped,0);
  h.live.close();
});
test('the iPhone helps following (15 Nov 2026): its answer about a frame of following\'s video moves the head when the robot\'s own detector is blind, not when it sees the face itself',async()=>{
  const made=[];let own=false,talking=false,listening=false,pose={y:.2,p:-.4};const aims=[];
  // The robot's own detector: a face in the middle of the frame when `own`, nothing otherwise.
  const finder={neural:()=>true,neuralMs:()=>60,tested:()=>0,find(){return 0;},unpack(){return undefined;},startNeural(){return 1;},pollNeural(){return own?1:0;},
    unpackNeural:value=>value>0?{x:80,y:60,size:40,score:20}:undefined,...jpegHost([3000],made)};
  const h=await launch({finder,frame:videoFrame([]),extra:{headPose:()=>pose,headMoving:()=>false,headSettled:()=>true,conversation:()=>talking,listening:()=>listening,aim(value){aims.push(value);return true;},look(){return true;}}});
  const go=async at=>{h.tick(at);for(const timer of [...h.timers.values()])if(timer.delay===25)timer.fn();await h.flush();};
  const lastFrame=()=>new DataView(h.socket.sent.filter(value=>value instanceof ArrayBuffer).at(-1)).getUint32(4);
  h.socket.room=11488;h.socket.bufferedAmount=0;
  await h.live.self(true);assert.equal((await h.command('camera.start',{jpeg:true})).ok,true);
  let at=1000;for(;at<2000;at+=25)await go(at);
  // The robot sees nobody; the iPhone found the face at the left of the last frame.
  const frame=lastFrame(),before=aims.length;pose={y:.5,p:-.6}; // the head has moved on since that frame
  assert.equal((await h.command('track',{frameId:frame,x:.2,y:.5})).ok,true);
  assert.equal(aims.length,before+1);assert.deepEqual([aims.at(-1).x,aims.at(-1).y,aims.at(-1).pose.y,aims.at(-1).pose.p],[.2,.5,.2,-.4],'aimed with the pose the head had for that frame');
  assert.ok(h.live.selfSeenMs<100,'and the face counts as seen: no looking around');assert.equal(h.live.selfSide,1,'at the left of the picture: the side it is going to');assert.equal(h.live.selfHelped,1);
  // An answer about a frame the robot does not know (too old): refused, nothing moves.
  assert.equal((await h.command('track',{frameId:frame+1000,x:.5,y:.5})).ok,false);assert.equal(aims.length,before+1);
  // The robot's own detector has the face: the iPhone's answers are taken but move nothing (the robot's are newer).
  own=true;for(;at<2600;at+=25)await go(at);const mine=aims.length;assert.ok(mine>before+1,'the robot follows by itself');
  assert.equal((await h.command('track',{frameId:lastFrame(),x:.9,y:.5})).ok,true);assert.equal(aims.length,mine,'not moved by the iPhone');assert.equal(h.live.selfHelped,1);
  // In a conversation the video goes on only while the robot listens, and slowly.
  own=false;talking=true;listening=false;const sent=kinds(h).filter(kind=>kind===8).length;for(;at<3600;at+=25)await go(at);
  assert.equal(kinds(h).filter(kind=>kind===8).length,sent,'speaking or thinking: no picture');
  listening=true;for(;at<5600;at+=25)await go(at);const slow=kinds(h).filter(kind=>kind===8).length-sent;assert.ok(slow>=2&&slow<=4,'listening: one every 0.6 s at most, '+slow+' in two seconds');
  await h.live.self(false);
});
test('with the iPhone helping, the look around keeps the pace of before: 5 s after the last sighting, 1.6 s at each stop (the quicker one was tried on 15 Nov 2026 and lost the owner all the time)',async()=>{
  let pose={y:0,p:-.44};const looks=[];
  const finder={neural:()=>true,neuralMs:()=>60,tested:()=>0,find(){return 0;},unpack(){return undefined;},startNeural(){return 1;},pollNeural(){return 0;},unpackNeural(){return undefined;},...jpegHost([3000],[])};
  const h=await launch({finder,frame:videoFrame([]),extra:{headPose:()=>pose,headMoving:()=>false,headSettled:()=>true,conversation:()=>false,aim(){return true;},look(value){looks.push(value);pose={y:value.y,p:value.p};return true;}}});
  let at=1000;const go=async()=>{h.tick(at);for(const timer of [...h.timers.values()])if(timer.delay===25)timer.fn();await h.flush();at+=25;};
  const lastFrame=()=>new DataView(h.socket.sent.filter(value=>value instanceof ArrayBuffer).at(-1)).getUint32(4);
  h.socket.room=11488;h.socket.bufferedAmount=0;
  await h.live.self(true);assert.equal((await h.command('camera.start',{jpeg:true})).ok,true);
  while(at<2000)await go();
  // The iPhone sees the face once, then nobody does.
  assert.equal((await h.command('track',{frameId:lastFrame(),x:.5,y:.5})).ok,true);
  const lostAt=at,moves=[];let seen=looks.length;
  while(at<lostAt+12000){await go();if(looks.length>seen){moves.push(at-lostAt);seen=looks.length;}}
  assert.ok(moves[0]>=5000,'not before 5 s: a face missed for a second or two is still there: '+moves[0]);
  assert.ok(moves[1]-moves[0]>=1600,'1.6 s at each stop: '+(moves[1]-moves[0]));
  await h.live.self(false);
});
test('the head aims ahead of a face that moves steadily, not of one that stands or turns back; and no frame for the slower detector while the iPhone sees the face (15 Nov 2026)',async()=>{
  const modes=[],aims=[];let pose={y:0,p:-.4};
  const finder={neural:()=>true,neuralMs:()=>60,tested:()=>0,find(){return 0;},unpack(){return undefined;},startNeural(_b,_w,_h,mode){modes.push(mode);return 1;},pollNeural(){return 0;},unpackNeural(){return undefined;},...jpegHost([3000],[])};
  const h=await launch({finder,frame:videoFrame([]),extra:{headPose:()=>pose,headMoving:()=>false,headSettled:()=>true,conversation:()=>false,aim(value){aims.push(value);return true;},look(){return true;}}});
  let at=1000;const go=async ms=>{for(const end=at+ms;at<end;at+=25){h.tick(at);for(const timer of [...h.timers.values()])if(timer.delay===25)timer.fn();await h.flush();}};
  const lastFrame=()=>new DataView(h.socket.sent.filter(value=>value instanceof ArrayBuffer).at(-1)).getUint32(4);
  const seen=async x=>{assert.equal((await h.command('track',{frameId:lastFrame(),x,y:.5})).ok,true);return aims.at(-1).x;};
  h.socket.room=11488;h.socket.bufferedAmount=0;
  await h.live.self(true);assert.equal((await h.command('camera.start',{jpeg:true})).ok,true);
  await go(3000);assert.ok(modes.includes(2),'nobody for a while: the slower detector is tried, as before');
  // The iPhone sees the face going steadily to the left of the frame (the head, here, does not move).
  assert.equal(await seen(.6),.6,'the first sighting: no speed yet');await go(400);
  assert.equal(await seen(.5),.5,'the second: a speed, but not yet twice the same way');await go(400);
  const led=await seen(.4);assert.ok(led<.4&&led>=.1,'the third, still going left: aimed ahead of it, '+led);await go(400);
  // It stands still, then turns back: no lead.
  assert.equal(await seen(.4),.4,'standing still');await go(400);
  assert.equal(await seen(.5),.5,'turning back: not twice the same way');await go(400);
  // While the iPhone has seen the face in the last 2 s the frames stay with the quick detectors.
  modes.length=0;await go(1500);await seen(.5);await go(400);assert.equal(modes.includes(2),false,'no frame for the slower detector');
  await go(6000);assert.ok(modes.includes(2),'the iPhone no longer sees it: the slower detector is back');
  await h.live.self(false);
});
test('a host that cannot make the JPEG: the same picture leaves raw, the video goes on raw, and the log says why',async()=>{
  const made=[],closed=[],lines=[],h=await launch({finder:jpegHost([-2],made),frame:videoFrame(closed),trace:line=>lines.push(line)});
  assert.equal((await h.command('camera.start',{jpeg:true})).ok,true);h.socket.room=11488;h.socket.bufferedAmount=0;
  for(let at=1000;at<1400;at+=25){h.tick(at);for(const timer of [...h.timers.values()])if(timer.delay===25)timer.fn();await h.flush();}
  assert.ok(kinds(h).length>=10&&kinds(h).every(kind=>kind===4),'raw pieces of the very picture that could not be made');
  assert.equal(made.filter(item=>item!=='end').length,1,'asked once, not at every picture');
  assert.ok(lines.some(line=>/live video jpeg: -2/.test(line)));
  h.live.close();
});
test('JPEG video: the quality follows the size, and during a call a picture every quarter of a second at most',async()=>{
  const made=[],h=await launch({finder:jpegHost([9000,9000,5000,5000,5000,5000,5000,5000],made),frame:videoFrame([])});
  const turn=async at=>{h.tick(at);for(const timer of [...h.timers.values()])if(timer.delay===25)timer.fn();await h.flush();};
  assert.equal((await h.command('camera.start',{jpeg:true})).ok,true);h.socket.room=11488;h.socket.bufferedAmount=0;
  await turn(1000);await turn(1100);await turn(1200);
  assert.deepEqual(made.map(item=>item.quality),[65,60,55],'two large pictures: the quality went down twice');
  assert.equal((await h.command('call.start')).ok,true);
  await turn(1300);await turn(1400);assert.equal(made.length,3,'in a call: not yet');await turn(1450);assert.equal(made.length,4);
  h.live.close();
});
test('JPEG video: a head command waiting for the servos pauses it like every other picture',async()=>{
  let busy=false;const made=[],h=await launch({finder:jpegHost([5000],made),frame:videoFrame([]),extra:{motionBusy:()=>busy}});
  assert.equal((await h.command('camera.start',{jpeg:true})).ok,true);h.socket.room=11488;h.socket.bufferedAmount=0;
  busy=true;h.tick(1000);for(const timer of [...h.timers.values()])if(timer.delay===25)timer.fn();await h.flush();assert.equal(made.length,0);
  busy=false;h.tick(1025);for(const timer of [...h.timers.values()])if(timer.delay===25)timer.fn();await h.flush();assert.equal(made.length,1);
  h.live.close();
});
test('in a conversation a face just lost is still there: the head waits where it saw it, and looks around only after 20 s (14 Nov 2026)',async()=>{
  // Owner, 19:05: «inseguimento non va, si gira dalla parte opposta»: talking to it, the quick pair lost the owner and
  // the look around took the head to the far side.
  let pose={y:0,p:-.4};const looks=[],aims=[],faces=[null];
  const finder=fakeFinder(faces);
  const h=await launch({finder,frame:()=>({width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(160*120*2),close(){}}),
    extra:{headPose:()=>pose,headMoving:()=>false,conversation:()=>true,aim(value){aims.push(value);return true;},look(value){looks.push([value.y,value.p]);pose={y:value.y,p:value.p};return true;}}});
  const turn=async at=>{h.tick(at);for(const timer of h.timers.values())if(timer.delay===25)timer.fn();await h.flush();};
  await h.live.self(true);let at=1100;
  faces[0]={x:80,y:60,size:40,score:20};for(;at<1600;at+=100)await turn(at);assert.ok(aims.length>=1,'followed');
  faces[0]=null;for(const end=at+19000;at<end;at+=100)await turn(at);
  assert.deepEqual(looks,[],'no look around while the face was seen less than 20 s ago');
  for(const end=at+8000;at<end;at+=100)await turn(at);
  assert.ok(looks.length>=1,'nobody for a while: the look around starts');
});
// External review of 17 Nov 2026, R1: the wheels' stop not confirmed by the rover is not a confirmed STOP.
test('STOP is answered as failed when the wheels\' stop was not confirmed; everything else is stopped all the same',async()=>{
  let wheels=false;const h=await launch({extra:{stop(emergency){h.calls.push(['stop',emergency]);return wheels;}}});
  assert.equal((await h.command('camera.start')).ok,true);
  assert.equal((await h.command('stop')).ok,false,'no «fermato» with the wheels unconfirmed');
  assert.ok(h.calls.some(([name,emergency])=>name==='stop'&&emergency===true));
  wheels=true;assert.equal((await h.command('stop')).ok,true);
  wheels=false;h.live.close();await h.flush();
});

test('exploration gives speech priority over video and resumes the camera afterwards',async()=>{
  let paused=true,captures=0;
  const h=await launch({extra:{mediaPaused:()=>paused},frame:()=>{captures++;return {width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(38400),close(){}};}});
  await h.command('camera.start');
  for(const t of h.timers.values())if(t.delay===25)t.fn();
  await h.flush();assert.equal(captures,0);
  paused=false;
  for(const t of h.timers.values())if(t.delay===25)t.fn();
  await h.flush();assert.ok(captures>0);
  h.live.close();
});

test('an in-progress snapshot survives a ten-second speech pause and resumes its remaining pieces',async()=>{
  let paused=false;const got=[],frames=[];
  const h=await launch({extra:{mediaPaused:()=>paused},frame:()=>{const f={width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(38400),close(){f.closed=true;}};frames.push(f);return f;}});
  const pump=async()=>{for(const timer of [...h.timers.values()])if(timer.delay===25)timer.fn();await h.flush();};
  let result;const done=h.live.snapshot(piece=>{got.push(piece);return true;}).then(value=>{result=value;});
  await h.flush();h.tick(2000);await pump();await pump();assert.equal(got.length,1);
  paused=true;for(let t=3000;t<=12000;t+=1000){h.tick(t);await pump();}
  assert.equal(result,undefined);assert.equal(got.length,1);assert.equal(frames[0].closed,undefined);
  paused=false;for(let i=0;i<15&&result===undefined;i++){h.tick(12025+i*25);await pump();}
  await done;assert.equal(result,true);assert.equal(got.length,10);assert.equal(frames[0].closed,true);h.live.close();
});

test('a snapshot paused indefinitely releases its frame at the absolute resource deadline',async()=>{
  let paused=false;const frames=[];
  const h=await launch({extra:{mediaPaused:()=>paused},frame:()=>{const f={width:160,height:120,imageType:'rgb565le',buffer:new ArrayBuffer(38400),close(){f.closed=true;}};frames.push(f);return f;}});
  const pump=async()=>{for(const timer of [...h.timers.values()])if(timer.delay===25)timer.fn();await h.flush();};
  const done=h.live.snapshot(()=>true);await h.flush();h.tick(2000);await pump();await pump();
  assert.equal(frames.length,1);paused=true;h.tick(31001);await pump();
  assert.equal(await done,false);assert.equal(frames[0].closed,true);h.live.close();
});
