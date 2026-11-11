// Conversation adapter with fake drivers: no microphone, speaker, network or provider.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SourceTextModule,SyntheticModule,createContext} from 'node:vm';
import {readFile} from 'node:fs/promises';
// Node 22 lacks the TC39 base64 helpers that the Moddable runtime provides.
Uint8Array.prototype.toBase64??=function(){return Buffer.from(this).toString('base64');};
Uint8Array.fromBase64??=text=>new Uint8Array(Buffer.from(text,'base64'));
const b64={encode(buffer){return Buffer.from(new Uint8Array(buffer)).toString('base64');},decode(text){const b=Buffer.from(text,'base64');return new Uint8Array(b).buffer;}};
async function load(context,file,modules){
  const cache=new Map();
  const make=async name=>{
    if(cache.has(name))return cache.get(name);
    let module;
    if(modules[name]){module=new SyntheticModule(Object.keys(modules[name]),function(){for(const [k,v]of Object.entries(modules[name]))this.setExport(k,v);},{context});}
    else{module=new SourceTextModule(await readFile(new URL({'robottino-voice-wire':'./voice-wire.js','robottino-live-wire':'./live-wire.js','robottino-portrait-state':'./portrait-state.js'}[name]??file,import.meta.url),'utf8'),{context});}
    cache.set(name,module);return module;
  };
  const root=new SourceTextModule(await readFile(new URL(file,import.meta.url),'utf8'),{context});
  await root.link(make);await root.evaluate();return root.namespace;
}
export async function voiceWire(){return load(createContext({console,ArrayBuffer,Uint8Array,DataView,JSON,Math,Number,String}),'./voice-wire.js',{});}
// Same arithmetic as the host's native A-law encoder (ChatAudioIO/Codecs, audio-codecs.c).
export const alawOf=value=>{
  const sign=(value&0x8000)>>8,pcm=sign?-value-1:value;let eee=7,mask=0x4000;
  while((pcm&mask)===0&&eee>0){eee--;mask>>=1;}
  return (sign|eee<<4|(pcm>>(eee?eee+3:4))&0x0f)^0xd5;
};
// The Worker's IMA frame (src/robot-audio.ts): [1][segments][mouth level each][68-byte chunks of 129 samples].
const imaFrame=(levels,chunks=24,sample=6000)=>{
  const frame=new Uint8Array(2+levels.length+chunks*68);frame[0]=1;frame[1]=levels.length;frame.set(levels,2);
  for(let c=0;c<chunks;c++){const at=2+levels.length+c*68;frame[at]=sample&0xff;frame[at+1]=(sample>>8)&0xff;}
  return frame;
};
const QUEUE=24; // the host's audioOut.queueLength
async function launch({verified=true,token='test-device-credential-not-a-real-secret',busy=0,alaw=true,faceStyle}={}){
  const context=createContext({console,ArrayBuffer,SharedArrayBuffer,Uint8Array,Int16Array,DataView,JSON,Math,Number,String,Promise});
  const sockets=[],timers=new Map(),inputs=[],outputs=[],calls=[],faults={mic:0};let tick=1000,id=0;
  class Socket{static handshake=2;static receive=3;static disconnect=-1;constructor(options){this.options=options;this.sent=[];this.bufferedAmount=0;sockets.push(this);}write(value){if(this.fail)throw Error(this.fail);this.sent.push(value);}close(){this.closed=true;}}
  // Like the Moddable driver, read() with no argument returns what is buffered (the announced size, or less).
  class Input{constructor(options){if(faults.mic>0){faults.mic--;throw Error('i2s busy');}const self=this,onReadable=options.onReadable;Object.assign(this,{options:{...options,onReadable(size){self.available=Math.min(size,self.limit??size);return onReadable.call(this,size);}},sampleRate:options.sampleRate,channels:1,bitsPerSample:16});inputs.push(this);}
    read(buffer){if(buffer!==undefined)throw Error('invalid size');if(!this.available)return undefined;const data=new ArrayBuffer(this.available);new Uint8Array(data).fill(this.options.read??1);this.available=0;return data;}start(){this.started=true;}close(){this.closed=true;}}
  // The host's speaker driver (pins/audioout, modules/pins/i2s/audioout.c): a queue of 24 elements, checked
  // like the real one. play() runs the queue up to the next audio element, as its own task would.
  class Output{
    static Samples=1;static Flush=2;static Callback=3;static Volume=4;static RawSamples=5;
    constructor(options){this.options=options;this.queue=[];this.played=[];this.volume=256;outputs.push(this);}
    enqueue(stream,kind,value,repeat,offset=0,count){
      if(stream!==0)throw RangeError('invalid stream');
      if(this.closed)throw Error('closed');
      if(this.queue.length>=QUEUE)throw Error('queue full');
      if(kind===Output.Volume){if(this.queue.length)throw Error('volume is set before any audio');this.volume=value;return;}
      if(kind===Output.Callback){this.queue.push({id:value});return;}
      if(!(value instanceof SharedArrayBuffer))throw Error('non-relocatable block required');
      if(repeat!==1)throw Error('plays once');
      if(kind===Output.Samples){
        const h=new DataView(value);
        if(h.getUint8(0)!==0x6d||h.getUint8(1)!==0x61||h.getUint8(2)!==1)throw Error('bad header');
        if(h.getUint16(4,true)!==this.options.sampleRate||h.getUint8(6)!==1)throw Error("rate/channels doesn't match output");
        const total=h.getUint32(8,true);
        if(h.getUint8(7)!==1||offset%129||count%129||offset+count>total||value.byteLength<12+total/129*68)throw Error('bad IMA range');
        this.queue.push({ima:true,count,sample:h.getInt16(12+offset/129*68,true),buffer:value});
      }
      else if(kind===Output.RawSamples)this.queue.push({count,sample:new Int16Array(value)[offset],buffer:value});
      else throw Error('bad kind');
    }
    length(stream){if(stream!==0)throw RangeError('invalid stream');return QUEUE-this.queue.length;}
    start(){this.started=true;}stop(){this.stopped=true;}close(){this.closed=true;this.queue=[];}
    play(){while(this.queue.length){const element=this.queue.shift();if('id' in element){this.callback(element.id);continue;}this.played.push(element);return element;}}
  }
  const codecs={Encode:{toAlaw(input,output){
    if(!(input instanceof Uint8Array)||input.byteLength&1||output.byteLength<input.byteLength>>1)throw Error('invalid');
    calls.push(['alaw',input.byteLength,output.byteLength]);const samples=new Int16Array(input.buffer,input.byteOffset,input.byteLength>>1);
    for(let i=0;i<samples.length;i++)output[i]=alawOf(samples[i]);
  }}};
  const radios=[];
  const modules={'robottino-socket':{Client:Socket,lowLatency(){const lease={open:true,close(){lease.open=false;}};radios.push(lease);return lease;}},preference:{default:{get(_d,key){return key==='deviceToken'?token:key==='verified'?verified:undefined;}}},
    timer:{default:{repeat(fn,delay){const n=++id;timers.set(n,{fn,delay});return n;},set(fn,delay){const n=++id;timers.set(n,{fn,delay,once:true});return n;},clear(n){timers.delete(n);}}},time:{default:{get ticks(){return tick;},delta(start){return tick-start;}}},
    modules:{default:{has(name){return alaw&&name==='ChatAudioIO/Codecs';},importNow(name){if(!alaw||name!=='ChatAudioIO/Codecs')throw Error('not found');return codecs;}}},
    'embedded:io/audio/in':{default:Input},'pins/audioout':{default:Output}};
  const ns=await load(context,'./voice-device.js',modules);
  const robot={face:{setMouthOpen(v){calls.push(['mouth',v]);}},connectivity:{network:{ready:Promise.resolve()}},audio:{acquireExclusive(){if(busy-->0)throw Error('audio busy');calls.push(['audio.reserve']);return()=>calls.push(['audio.release']);}}};
  const hooks={stats(text,test){calls.push(['stats',text,test]);},listening(){calls.push(['listening']);},ended(reason){calls.push(['ended',reason]);},memory(e){calls.push(['memory',e]);},mood(m){calls.push(['mood',m]);},see(){calls.push(['see']);},timer(t){calls.push(['timer',t]);},head(c){calls.push(['head',c]);},face(c){calls.push(['face',c]);},...(faceStyle===undefined?{}:{faceStyle})};
  const voice=ns.createVoiceDevice(robot,hooks);
  const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
  return {voice,sockets,timers,inputs,outputs,calls,faults,radios,flush,tick(v){tick=v;},
    receive(value){sockets[0].callback(Socket.receive,typeof value==='string'?value:JSON.stringify(value));},binary(bytes){sockets[0].callback(Socket.receive,bytes.slice().buffer);},handshake(){sockets[0].callback(Socket.handshake);},disconnect(){sockets[0].callback(Socket.disconnect);},
    sent(){return sockets[0].sent.map(v=>typeof v==='string'?JSON.parse(v):{audio:v});},runTimers(){for(const t of [...timers.values()])t.fn();},
    runOnce(){for(const [n,t] of [...timers])if(t.once){timers.delete(n);t.fn();}},
    mouths(){return calls.filter(([n])=>n==='mouth').map(([,v])=>v);}};
}
const same=(actual,expected,message)=>assert.deepEqual(JSON.parse(JSON.stringify(actual)),expected,message);
const pcm=(value,count=320)=>{const a=new Int16Array(count).fill(value);return b64.encode(a.buffer);};
const playAll=speaker=>{let n=0;while(speaker.play())n++;return n;};
async function listening(){
  const h=await launch();await h.voice.start();h.handshake();
  h.receive({type:'conversation_initiation_metadata',conversation_initiation_metadata_event:{user_input_audio_format:'pcm_16000',agent_output_audio_format:'pcm_16000'}});
  h.tick(2000); // past the microphone's first 400 ms
  return {...h,mic:h.inputs[0],stats:()=>h.calls.filter(([n])=>n==='stats').map(([,t])=>t)};
}
test('robot conversation needs verified hardware and its own credential',async()=>{
  await assert.rejects((await launch({verified:false})).voice.start(),/hardware_unverified/);
  await assert.rejects((await launch({token:''})).voice.start(),/missing_credential/);
});
test('robot conversation takes turns: listens, closes the microphone to speak, then listens again',async()=>{
  const h=await launch();assert.equal(await h.voice.start(),true);await h.flush();
  assert.equal(h.sockets[0].options.path,'/api/robot/voice?audio=ima&mic=alaw');assert.equal(h.sockets[0].options.Socket,undefined);assert.equal(h.inputs.length,0,'microphone waits for the provider');
  h.handshake();h.receive({type:'conversation_initiation_metadata',conversation_initiation_metadata_event:{user_input_audio_format:'pcm_16000',agent_output_audio_format:'pcm_16000'}});
  assert.ok(h.calls.some(([n])=>n==='listening'));const mic=h.inputs[0];assert.equal(mic.options.sampleRate,16000);assert.ok(mic.started);
  assert.equal(h.outputs.length,0,'the speaker stays closed while listening');
  mic.options.onReadable.call(mic,3200);assert.equal(h.sent().filter(m=>m.audio).length,0,'the first 400 ms after opening are dropped');
  h.tick(1500);mic.options.onReadable.call(mic,3200);const chunk=h.sent().at(-1);
  assert.equal(chunk.audio.byteLength,1600,'100 ms of A-law: 8 bits per sample');assert.ok(chunk.audio.every(v=>v===alawOf(257)),'encoded by the host, not in JavaScript');
  same(h.calls.filter(([n])=>n==='alaw'),[['alaw',3200,1600]]);
  h.receive({type:'audio',audio_event:{audio_base_64:pcm(6000)}});
  const speaker=h.outputs[0];assert.ok(mic.closed,'the microphone is closed before speaking');assert.ok(speaker.started);assert.equal(h.voice.speaking,true);
  same(speaker.options,{streams:1,sampleRate:16000,bitsPerSample:16,numChannels:1});assert.equal(speaker.volume,256,'the provider level, no gain: +6 dB made the amplifier crackle');
  assert.equal(speaker.queue.length,0,'waits for 400 ms of audio or the end of the reply');
  h.tick(1750);h.runTimers();const played=speaker.play();
  assert.equal(played.count,320);assert.equal(played.sample,6000,'played as received');assert.deepEqual(h.mouths().at(-1),.58,'the mouth starts opening with the words (about 45 ms to open, like the app)');
  h.receive({type:'ping',ping_event:{event_id:9}});assert.deepEqual(h.sent().at(-1),{type:'pong',event_id:9});
  h.receive({type:'user_transcript',user_transcription_event:{user_transcript:'Ricorda che amo il mare'}});assert.deepEqual(h.sent().at(-1),{type:'memory.command',text:'Ricorda che amo il mare'});
  h.tick(2949);h.runTimers();assert.equal(h.inputs.length,1,'still speaking right after the last word');
  h.tick(2950);h.runTimers();assert.ok(speaker.closed,'the speaker closes 1.2 s after the last word started');assert.equal(h.mouths().at(-1),0);
  const again=h.inputs[1];assert.ok(again.started,'and the microphone opens again');assert.equal(h.voice.speaking,false);
  again.options.onReadable.call(again,3200);const sent=h.sent().filter(m=>m.audio).length;h.tick(3500);again.options.onReadable.call(again,3200);
  assert.equal(h.sent().filter(m=>m.audio).length,sent+1);
  h.voice.stop();assert.ok(again.closed&&h.sockets[0].closed);assert.equal([...h.timers.values()].filter(t=>!t.once).length,0);assert.ok(h.calls.some(([n])=>n==='audio.release'));assert.deepEqual(h.calls.at(-1),['ended','user']);
  assert.equal(h.voice.active,false);
});
test('busy() tells the head to wait: while the conversation starts, and for a moment after microphone or speaker change (10 Nov 2026)',async()=>{
  const h=await launch();assert.equal(h.voice.busy(),false,'at rest');
  assert.equal(await h.voice.start(),true);await h.flush();assert.equal(h.voice.busy(),true,'connecting: the audio is about to change');
  h.handshake();assert.equal(h.voice.busy(),true);
  h.receive({type:'conversation_initiation_metadata',conversation_initiation_metadata_event:{user_input_audio_format:'pcm_16000',agent_output_audio_format:'pcm_16000'}});
  assert.equal(h.inputs.length,1);assert.equal(h.voice.busy(),true,'the microphone has just opened');
  h.tick(1349);assert.equal(h.voice.busy(),true);h.tick(1350);assert.equal(h.voice.busy(),false,'350 ms later the head may move');
  h.tick(3000);assert.equal(h.voice.busy(),false,'listening');
  h.receive({type:'audio',audio_event:{audio_base_64:pcm(6000)}});assert.equal(h.outputs.length,1);
  assert.equal(h.voice.busy(),true,'the speaker has just opened');h.tick(3349);assert.equal(h.voice.busy(),true);h.tick(3350);assert.equal(h.voice.busy(),false);
  h.tick(5000);assert.equal(h.voice.interrupt(),true);assert.equal(h.inputs.length,2);
  assert.equal(h.voice.busy(),true,'back to the microphone');h.tick(5350);assert.equal(h.voice.busy(),false);
  h.tick(6000);h.voice.stop();assert.equal(h.voice.active,false);
  assert.equal(h.voice.busy(),true,'closing: the speaker goes 200 ms later');h.tick(6549);assert.equal(h.voice.busy(),true);
  h.tick(6550);assert.equal(h.voice.busy(),false,'then at rest again');
});
test('the conversation phase for the head lights: connecting, listening, thinking, speaking, idle',async()=>{
  const h=await launch();assert.equal(h.voice.phase,'idle');
  const started=h.voice.start();assert.equal(h.voice.phase,'connecting','while waiting for the speaker');
  await started;await h.flush();assert.equal(h.voice.phase,'connecting','until the provider is ready');
  h.handshake();h.receive({type:'conversation_initiation_metadata',conversation_initiation_metadata_event:{user_input_audio_format:'pcm_16000',agent_output_audio_format:'pcm_16000'}});
  assert.equal(h.voice.phase,'listening');
  h.receive({type:'user_transcript',user_transcription_event:{user_transcript:'Che tempo fa?'}});assert.equal(h.voice.phase,'thinking','your words were heard');
  h.tick(8999);assert.equal(h.voice.phase,'thinking');h.tick(9000);assert.equal(h.voice.phase,'listening','no reply for 8 s: listening again');
  h.receive({type:'user_transcript',user_transcription_event:{user_transcript:'Che tempo fa?'}});assert.equal(h.voice.phase,'thinking');
  h.receive({type:'audio',audio_event:{audio_base_64:pcm(6000)}});assert.equal(h.voice.phase,'speaking');
  h.receive({type:'user_transcript',user_transcription_event:{user_transcript:'Grazie'}});assert.equal(h.voice.phase,'speaking','a late transcript does not change the speaking light');
  h.voice.interrupt();assert.equal(h.voice.phase,'listening','after the reply: listening, not thinking');
  h.voice.stop();assert.equal(h.voice.phase,'idle');
});
test('without the host A-law codec the microphone falls back to μ-law',async()=>{
  const {ulawEncode}=await voiceWire(),h=await launch({alaw:false});await h.voice.start();
  assert.equal(h.sockets[0].options.path,'/api/robot/voice?audio=ima');
  h.handshake();h.receive({type:'conversation_initiation_metadata',conversation_initiation_metadata_event:{user_input_audio_format:'pcm_16000',agent_output_audio_format:'pcm_16000'}});
  h.tick(2000);h.inputs[0].options.onReadable.call(h.inputs[0],3200);
  assert.deepEqual([...h.sent().at(-1).audio],[...ulawEncode(new Uint8Array(3200).fill(1))]);h.voice.stop();
});
test('robot conversation uses OpenAI rates and ends on silence, timeout or provider error',async()=>{
  const a=await launch();await a.voice.start();a.handshake();a.receive({type:'session.started'});assert.equal(a.inputs[0].options.sampleRate,24000);
  a.tick(1500);a.inputs[0].options.onReadable.call(a.inputs[0],4800);assert.equal(a.sent().at(-1).audio.byteLength,2400);
  // OpenAI keeps streaming silence: it must neither take the turn from the microphone nor count as activity.
  const silent=a.sent().length;a.receive({type:'session.output_audio.delta',delta:pcm(0,480)});assert.equal(a.outputs.length,0,'no speaker for silence');
  a.inputs[0].options.onReadable.call(a.inputs[0],4800);assert.equal(a.sent().length,silent+1,'silence from the provider keeps the microphone open');
  a.tick(32000);a.runTimers();assert.deepEqual(a.calls.at(-1),['ended','silence']);
  const b=await launch();await b.voice.start();b.tick(12000);b.runTimers();assert.deepEqual(b.calls.at(-1),['ended','connect_timeout']);
  const c=await launch();await c.voice.start();c.handshake();c.receive({type:'error'});assert.deepEqual(c.calls.at(-1),['ended','provider_error']);assert.ok(c.calls.some(([n])=>n==='audio.release'));
  const d=await launch();await d.voice.start();d.disconnect();assert.deepEqual(d.calls.at(-1),['ended','closed']);
});
test('OpenAI silence after the last word does not keep the speaker open',async()=>{
  const a=await launch();await a.voice.start();a.handshake();a.receive({type:'session.started'});
  a.receive({type:'session.output_audio.delta',delta:pcm(6000,1440)});const speaker=a.outputs[0];assert.equal(speaker.options.sampleRate,24000);
  a.tick(1250);a.runTimers();assert.equal(speaker.play().count,1440,'60 ms of words');
  a.tick(1500);for(let i=0;i<5;i++)a.receive({type:'session.output_audio.delta',delta:pcm(0,1440)}); // silence between words still plays
  a.tick(1700);a.runTimers();assert.equal(playAll(speaker),5);
  // The mouth closes in about 200 ms after the words (three of the silent pieces): the turn ends 1.2 s after that.
  a.tick(2899);a.runTimers();assert.equal(speaker.closed,undefined,'1.2 s after the mouth closed');
  a.tick(2900);a.receive({type:'session.output_audio.delta',delta:pcm(0,1440)});assert.equal(speaker.queue.length,0,'later silence is dropped, not played');
  a.runTimers();assert.ok(speaker.closed);assert.ok(a.inputs[1].started);assert.equal(speaker.played.length,6);
  a.voice.stop();
});
test('long provider chunks move the mouth with each ~97 ms segment, not once per chunk',async()=>{
  const h=await listening();
  // 97 ms of silence followed by 97 ms of speech in one chunk (12 IMA chunks = 1548 samples at 16 kHz).
  const a=new Int16Array(3096);a.fill(6000,1548);h.receive({type:'audio',audio_event:{audio_base_64:b64.encode(a.buffer)}});
  const speaker=h.outputs[0];h.tick(2200);h.runTimers();
  assert.deepEqual(speaker.queue.map(e=>'id' in e?'callback '+e.id:e.count),['callback 1',1548,'callback 2',1548],'each segment behind a callback with its number');
  speaker.play();h.tick(2264);h.runTimers();assert.equal(h.mouths().some(v=>v>0),false,'closed during the silent part');
  speaker.play();assert.equal(h.mouths().at(-1),.58,'opens when the voice starts inside the same chunk');
  h.tick(2297);h.runTimers();assert.equal(h.mouths().at(-1),.8,'and opens fully 32 ms later, between two callbacks');
  h.voice.stop();
});
test('a tap while Robottino speaks stops it, drops the rest of the reply and listens again',async()=>{
  const h=await listening();
  for(let i=0;i<2;i++)h.receive({type:'audio',audio_event:{audio_base_64:pcm(6000,4800)}});
  const speaker=h.outputs[0];assert.equal(speaker.queue.length,16,'600 ms in hand: handed to the driver at once');speaker.play();assert.equal(h.voice.speaking,true);
  assert.equal(h.voice.interrupt(),true);assert.equal(h.voice.speaking,false);assert.ok(speaker.closed);assert.equal(speaker.queue.length,0,'the driver stops at once');assert.ok(h.inputs[1].started,'listening again at once');
  assert.equal(h.sent().filter(m=>m.type==='playback.clear').length,1,'the Worker drops the reply it still holds');
  h.receive({type:'audio',audio_event:{audio_base_64:pcm(6000)}});assert.equal(h.outputs.length,1,'the rest of the old reply is dropped');
  h.receive({type:'interruption'});h.receive({type:'audio',audio_event:{audio_base_64:pcm(6000)}});
  const next=h.outputs[1];h.tick(2500);h.runTimers();next.play();assert.equal(h.mouths().at(-1),.58,'a new reply plays after the provider confirms');
  assert.equal(h.voice.interrupt(),true);h.voice.stop();assert.match(h.stats().at(-1),/ i2 /);
});
test('callbacks still queued when the speaker closes are ignored',async()=>{
  const h=await listening();h.receive({type:'audio',audio_event:{audio_base_64:pcm(6000,960)}});h.tick(2200);h.runTimers();
  const speaker=h.outputs[0],late=speaker.callback,mouths=h.mouths().length;h.voice.interrupt();
  assert.doesNotThrow(()=>late(3));assert.equal(h.mouths().length,mouths,'no mouth after closing');assert.equal(h.inputs.length,2);assert.equal(h.voice.active,true);
  h.voice.stop();
});
test('a short reply plays once no audio has come for 200 ms; back to listening 1.2 s after its last word',async()=>{
  const h=await listening();
  h.receive({type:'audio',audio_event:{audio_base_64:pcm(6000,960)}});const speaker=h.outputs[0];
  h.tick(2199);h.runTimers();assert.equal(speaker.queue.length,0,'more words may come');
  h.tick(2200);h.runTimers();assert.equal(speaker.queue.length,2,'then it plays what it has');speaker.play();
  h.tick(3399);h.runTimers();assert.equal(speaker.closed,undefined,'not before 1.2 s');
  h.tick(3400);h.runTimers();assert.ok(speaker.closed);assert.ok(h.inputs[1].started);
  h.voice.stop();assert.match(h.stats().at(-1),/ i0 s1 v0 /);
});
test('a speaker that never reports still hands the turn back',async()=>{
  const h=await listening();
  h.receive({type:'audio',audio_event:{audio_base_64:pcm(6000,960)}});const speaker=h.outputs[0];h.tick(2200);h.runTimers();assert.equal(speaker.queue.length,2);
  h.tick(5399);h.runTimers();assert.equal(speaker.closed,undefined);
  h.tick(5400);h.runTimers();assert.ok(speaker.closed,'3.2 s after the audio was handed over at most');assert.ok(h.inputs[1].started);
  h.voice.stop();
});
test('timers go to the robot, not to the memory server, and replies set the mood',async()=>{
  const h=await launch();await h.voice.start();h.handshake();h.receive({type:'session.started'});
  h.receive({type:'session.output_transcript.delta',delta:'Sì, certo, ahah! '});
  same(h.calls.filter(([n])=>n==='mood').at(-1),['mood',{expression:'happy',gesture:'nod'}]);
  h.receive({type:'session.input_transcript.delta',delta:'Ricordami tra 10 minuti di girare la pasta'});
  same(h.calls.filter(([n])=>n==='mood').at(-1),['mood',{expression:'neutral',gesture:null}],'mood resets when the user speaks');
  const sent=h.sent().length;h.receive({type:'session.output_transcript.delta',delta:'Va bene.'});
  same(h.calls.filter(([n])=>n==='timer').at(-1),['timer',{action:'set',seconds:600,label:'girare la pasta'}]);
  assert.equal(h.sent().slice(sent).some(m=>m.type==='memory.command'),false);
  h.voice.stop();
});
test('voice wire: long press, short tap and turn endings',async()=>{
  const {LongPress,VoiceTurns,isMemoryPhrase}=await voiceWire();
  const press=new LongPress(900);press.touch({gesture:'press'},0);assert.equal(press.tick(500),false);assert.equal(press.tick(900),true);assert.equal(press.tick(1000),false);
  assert.equal(press.touch({gesture:'release'},1200),null,'a long press never also smiles');
  press.touch({gesture:'press'},2000);assert.equal(press.touch({gesture:'release',tap:{durationMs:120}},2120),'tap');
  press.touch({gesture:'press'},3000);assert.equal(press.touch({gesture:'forwardSwipe'},3100),'swipe');assert.equal(press.tick(4000),false);
  const turns=new VoiceTurns();assert.equal(turns.apply({type:'user',text:'Ricorda ',final:false}),null);turns.apply({type:'user',text:'che piove',final:false});
  assert.equal(turns.apply({type:'assistant',text:'Ok'}),'Ricorda che piove');assert.ok(isMemoryPhrase(' cosa ricordi di me?'));assert.ok(isMemoryPhrase('Robottino, ricordati che piove'));assert.equal(isMemoryPhrase('Che bella giornata'),false);
});
test('head sensor read directly: a zone stuck above 0 no longer hides a long press or a tap (10 Nov 2026)',async()=>{
  const {HeadSensorWatch}=await voiceWire();const w=new HeadSensorWatch();
  const at=(sample,now)=>{const r=w.update(sample,now);return {changed:r.changed,stuck:r.stuck,gesture:r.gesture};};
  // Normal sensor: zeros, a touch, zeros again. The host's gestures do the work; nothing is reported but changes.
  assert.deepEqual(at([0,0,0],0),{changed:true,stuck:undefined,gesture:undefined});
  assert.deepEqual(at([0,0,0],100),{changed:false,stuck:undefined,gesture:undefined});
  assert.equal(at([0,3,1],200).changed,true);assert.equal(at([0,0,0],1500).gesture,undefined,'a normal press is the host\'s');
  // One zone stays at 1: after 8 s the reading is stuck, the levels become the floor.
  assert.equal(at([1,0,0],2000).stuck,undefined);assert.equal(at([1,0,0],9999).stuck,undefined);
  assert.equal(at([1,0,0],10000).stuck,'start');assert.equal(w.stuck,true);
  // A finger: a rise over the floor. Held 1.5 s: a long press, given on release.
  assert.equal(at([1,3,1],11000).gesture,undefined);assert.equal(at([1,3,1],12000).gesture,undefined,'nothing while held');
  assert.equal(at([1,0,0],12500).gesture,'long');
  // A quick touch: a tap. A middle one (0.5 s): nothing.
  at([2,0,0],13000);assert.equal(at([1,0,0],13200).gesture,'tap');
  at([1,2,0],14000);assert.equal(at([1,0,0],14500).gesture,undefined);
  // Held too long (7 s): not a long press.
  at([1,2,0],15000);assert.equal(at([1,0,0],22000).gesture,undefined);
  // A swipe from the host cancels the touch in progress.
  at([1,3,0],23000);w.cancel();assert.equal(at([1,0,0],24200).gesture,undefined);
  // A rise that stays (8 s) becomes the new floor: no conversation from a level that changed by itself.
  at([2,0,0],25000);assert.equal(at([2,0,0],33000).stuck,'start');assert.equal(at([2,0,0],34000).gesture,undefined);
  assert.equal(at([1,0,0],35000).gesture,undefined,'falling below the floor lowers it, it is not a release');
  // A zone that drops lowers the floor; all zones at 0 end the stuck state.
  assert.equal(at([0,0,0],36000).stuck,'end');assert.equal(w.stuck,false);
  assert.equal(at([0,2,0],36100).gesture,undefined);assert.equal(at([0,0,0],36200).gesture,undefined,'back to the host');
  // Odd samples are read as 0…3.
  assert.deepEqual([...w.update([9,-2,'x'],37000).levels],[3,0,0]);assert.deepEqual([...w.update(undefined,37100).levels],[0,0,0]);
});
test('the reply queue fits the fixed memory: oversized events and audio beyond 2 s are dropped',async()=>{
  const h=await launch();await h.voice.start();h.handshake();
  h.receive({type:'conversation_initiation_metadata',conversation_initiation_metadata_event:{user_input_audio_format:'pcm_16000',agent_output_audio_format:'pcm_16000'}});
  // A 40 KB provider event (what ElevenLabs sends) is ignored instead of filling the memory.
  h.receive({type:'audio',audio_event:{audio_base_64:pcm(6000,15000)}});
  assert.equal(h.voice.speaking,false,'oversized event ignored');assert.equal(h.outputs.length,0);
  // Pieces of 192 ms: six fill the driver's 24 elements (callback + audio each), ten more wait (1920 ms), the next is dropped.
  for(let i=0;i<17;i++)h.receive({type:'audio',audio_event:{audio_base_64:pcm(6000,3072)}});
  const speaker=h.outputs[0];assert.equal(speaker.length(0),0,'the driver queue is full, never over-filled');
  h.voice.stop();assert.match(h.calls.filter(([n])=>n==='stats').at(-1)[1],/ a17 x1 c1 q1920 /);
});
test('waits up to 3 s for a short sound to free the speaker, then reports audio busy',async()=>{
  const h=await launch({busy:2});const started=h.voice.start();
  for(let i=0;i<3;i++){await h.flush();h.runOnce();}
  assert.equal(await started,true);assert.ok(h.calls.some(([n])=>n==='audio.reserve'));assert.equal(h.voice.active,true);
  assert.equal(await h.voice.start(),false,'one conversation at a time');h.voice.stop();
  const b=await launch({busy:99});const failed=b.voice.start();
  assert.equal(await b.voice.start(),false,'a second start while waiting does nothing');
  for(let i=0;i<14;i++){await b.flush();b.runOnce();}
  await assert.rejects(failed,/audio busy/);assert.equal(b.voice.active,false);assert.equal(b.sockets.length,0);
});
test('a stop while waiting for the speaker gives it back as soon as it is lent',async()=>{
  const h=await launch({busy:1});const started=h.voice.start();await h.flush();
  h.voice.stop();await h.flush();h.runOnce();
  assert.equal(await started,false);assert.ok(h.calls.some(([n])=>n==='audio.release'));assert.equal(h.voice.active,false);assert.equal(h.sockets.length,0);
});
test('a slow network drops microphone audio instead of filling the fixed memory',async()=>{
  const h=await listening(),socket=h.sockets[0],audio=()=>h.sent().filter(m=>m.audio).length;
  socket.bufferedAmount=20000;h.mic.options.onReadable.call(h.mic,3200);assert.equal(audio(),0,'dropped while 20 KB wait to be sent');
  socket.bufferedAmount=0;h.mic.options.onReadable.call(h.mic,3200);assert.equal(audio(),1);
  h.voice.stop();assert.match(h.stats().at(-1),/^m1 d1 /);
});
test('an error inside the microphone callback ends the conversation instead of restarting the robot',async()=>{
  const h=await listening();h.sockets[0].fail='write failed';
  assert.doesNotThrow(()=>h.mic.options.onReadable.call(h.mic,3200));
  assert.equal(h.voice.active,true,'closed outside the callback');h.runOnce();
  assert.equal(h.voice.active,false);assert.deepEqual(h.calls.filter(([n])=>n==='ended').at(-1),['ended','error']);
  assert.ok(h.stats().some(t=>t.includes('e:mic:write failed')));assert.ok(h.calls.some(([n])=>n==='audio.release'));
});
test('conversation counters are saved every 5 s and when it ends',async()=>{
  const h=await listening();
  h.receive({type:'user_transcript',user_transcription_event:{user_transcript:'Ciao'}});
  h.receive({type:'audio',audio_event:{audio_base_64:pcm(6000,3072)}});
  for(let i=0;i<4;i++)h.runTimers();assert.equal(h.stats().length,0);
  h.runTimers();assert.equal(h.stats().at(-1),'m0 d0 u1 g0 a1 x0 c0 q192 b0 i0 s1 v0 k0 n0 t0 f0 h0');
  h.voice.stop();assert.equal(h.stats().length,2);
});
test('reads what the microphone really has, even less than announced',async()=>{
  const h=await listening();h.mic.limit=800;
  for(let i=0;i<4;i++)h.mic.options.onReadable.call(h.mic,3200);
  assert.equal(h.voice.active,true,'no invalid size error');assert.equal(h.sent().filter(m=>m.audio).length,1,'four 800-byte reads make one 100 ms chunk');
  h.voice.stop();
});
test('a binary IMA frame from the Worker goes to the driver as it is, with its mouth levels',async()=>{
  const h=await listening();
  for(let i=0;i<3;i++)h.binary(imaFrame([3,4,4,0,0,0])); // 3 × 194 ms: past the 400 ms start; one mouth pose per 32 ms
  const speaker=h.outputs[0];assert.equal(h.voice.speaking,true);
  assert.deepEqual(speaker.queue.slice(0,4).map(e=>'id' in e?'callback':`${e.ima?'IMA':'PCM'} ${e.count}`),['callback','IMA 1548','callback','IMA 1548']);
  const sab=speaker.queue[1].buffer,header=new DataView(sab);
  assert.deepEqual([header.getUint8(0),header.getUint8(1),header.getUint8(2),header.getUint8(3),header.getUint16(4,true),header.getUint8(6),header.getUint8(7),header.getUint32(8,true)],[0x6d,0x61,1,16,16000,1,1,3096],'Moddable maud header: IMA, 16 kHz, mono');
  assert.equal(sab.byteLength,12+24*68,'one copy of the chunks, outside the JavaScript heap');assert.equal(speaker.queue[3].buffer,sab,'both segments share it');
  speaker.play();const mouths=[h.mouths().at(-1)];for(const t of [2033,2066,2097]){h.tick(t);h.runTimers();mouths.push(h.mouths().at(-1));}
  assert.deepEqual(mouths,[.58,.8,.8,.8],'the poses of the segment, 32 ms apart, then held while the next one is due');
  speaker.play();assert.equal(h.mouths().at(-1),0);h.tick(2300);h.runTimers();assert.equal(h.mouths().at(-1),0);
  h.tick(2400);h.runTimers();playAll(speaker);h.tick(2700);h.runTimers();assert.equal(h.mouths().at(-1),0,'the mouth closes when the speaker runs dry');
  h.binary(new Uint8Array(70).fill(1));h.sockets[0].callback(3,new ArrayBuffer(20000));
  h.voice.stop();assert.match(h.stats().at(-1),/ a3 x2 /,'a malformed and an oversized frame are ignored');
});
test('frames from a Worker with one mouth level per segment still move the mouth',async()=>{
  const h=await listening();for(let i=0;i<3;i++)h.binary(imaFrame([2,0])); // until 9 Nov 2026: one level per 97 ms
  const speaker=h.outputs[0];speaker.play();assert.equal(h.mouths().at(-1),.35);speaker.play();assert.equal(h.mouths().at(-1),0);
  h.voice.stop();
});
test('μ-law matches the telephone standard and the Worker',async()=>{
  const {ulawEncode,ulawDecode}=await voiceWire();
  const pcm=values=>new Uint8Array(Int16Array.from(values).buffer);
  assert.deepEqual([...ulawEncode(pcm([0,-1,32767,-32768]))],[0xff,0x7f,0x80,0x00]);
  assert.deepEqual([...new Int16Array(ulawDecode(Uint8Array.from([0xff,0x80,0x00]).buffer))],[0,32124,-32124]);
  const samples=[-30000,-5000,-300,-20,0,20,300,5000,30000],back=new Int16Array(ulawDecode(ulawEncode(pcm(samples)).buffer));
  samples.forEach((value,i)=>assert.ok(Math.abs(back[i]-value)<=Math.max(16,Math.abs(value)/16),String(value)));
});
test('a reply that ran dry starts again only with 400 ms in hand: one pause, not stutter',async()=>{
  const h=await listening();
  h.receive({type:'audio',audio_event:{audio_base_64:pcm(6000,4800)}});h.tick(2100);h.receive({type:'audio',audio_event:{audio_base_64:pcm(6000,4800)}});
  const speaker=h.outputs[0];assert.equal(playAll(speaker),8,'600 ms played');
  h.tick(2300);h.receive({type:'audio',audio_event:{audio_base_64:pcm(6000,3072)}});assert.equal(speaker.queue.length,0,'a late piece waits');
  h.tick(2400);h.receive({type:'audio',audio_event:{audio_base_64:pcm(6000,3072)}});assert.equal(speaker.queue.length,0);
  h.tick(2450);h.receive({type:'audio',audio_event:{audio_base_64:pcm(6000,3072)}});assert.equal(speaker.queue.length,12,'576 ms: plays again');
  h.voice.stop();assert.match(h.stats().at(-1),/ s1 v1 k\d+ n200 /,'one restart, 200 ms the longest wait between pieces');
});
test('μ-law replies are played 6 dB louder, linear up to half scale, never clipping',async()=>{
  const {ulawEncode,ulawDecode,ULAW_LOUD}=await voiceWire();
  const pcm=values=>new Uint8Array(Int16Array.from(values).buffer);
  const quiet=new Int16Array(ulawDecode(ulawEncode(pcm([1000])).buffer,ULAW_LOUD))[0];assert.ok(quiet>1900&&quiet<2100,String(quiet));
  const loud=new Int16Array(ulawDecode(ulawEncode(pcm([32000,-32000])).buffer,ULAW_LOUD));assert.ok(loud[0]<=32767&&loud[0]>30000&&loud[1]>=-32767&&loud[1]<-30000);
  assert.ok([...ULAW_LOUD].every(v=>Math.abs(v)<=32767));
  const plain=new Int16Array(ulawDecode(Uint8Array.from({length:256},(_,i)=>i).buffer));
  plain.forEach((v,i)=>{if(Math.abs(v)*2<=16383)assert.equal(ULAW_LOUD[i],2*v,'exactly twice as loud below half scale: no distortion');});
});
test('a microphone that cannot reopen ends the conversation without restarting the robot',async()=>{
  // After the reply: the turn timer reopens the microphone.
  const a=await listening();a.receive({type:'audio',audio_event:{audio_base_64:pcm(6000,960)}});a.tick(2200);a.runTimers();a.outputs[0].play();a.faults.mic=1;
  a.tick(3400);assert.doesNotThrow(()=>a.runTimers());a.runOnce();assert.deepEqual(a.calls.at(-1),['ended','error']);
  assert.ok(a.outputs[0].closed);assert.match(a.stats().at(-1),/ e:turn:i2s busy$/);
  // A tap while speaking.
  const b=await listening();b.receive({type:'audio',audio_event:{audio_base_64:pcm(6000,960)}});b.faults.mic=1;
  assert.doesNotThrow(()=>b.voice.interrupt());b.runOnce();assert.deepEqual(b.calls.at(-1),['ended','error']);assert.match(b.stats().at(-1),/ e:tap:i2s busy$/);
  // The provider's own interruption: inside the network callback.
  const c=await listening();c.receive({type:'audio',audio_event:{audio_base_64:pcm(6000,960)}});c.faults.mic=1;
  c.receive({type:'interruption'});assert.deepEqual(c.calls.at(-1),['ended','error']);assert.match(c.stats().at(-1),/ e:ws:i2s busy$/);
});
test('speaker check without the network: a recorded phrase takes the path of a reply',async()=>{
  const h=await launch(),parts=[];
  for(let i=0;i<6;i++){const frame=imaFrame([2,2]);parts.push(Uint8Array.of(frame.length&0xff,frame.length>>8),frame);} // as the Worker sends it, each behind its length
  const phrase=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));parts.reduce((at,p)=>{phrase.set(p,at);return at+p.length;},0);
  let done;const played=h.voice.selfTest({length:phrase.length,read:(start,end)=>phrase.slice(start,end).buffer},{volume:.5}).then(reason=>{done=reason;});
  await h.flush();assert.equal(h.sockets.length,0,'no network');h.runTimers();
  const speaker=h.outputs[0];assert.ok(speaker.started);assert.equal(speaker.volume,128);assert.equal(h.inputs.length,0,'no microphone');
  assert.equal(playAll(speaker),12,'about 1.2 s in 12 segments, all through the driver');assert.ok(speaker.played.every(e=>e.ima&&e.sample===6000));
  h.tick(2199);h.runTimers();assert.equal(speaker.closed,undefined,'the last segment is still playing');
  h.tick(2200);h.runTimers();h.runOnce();await played;
  assert.ok(speaker.stopped&&!speaker.closed,'stopped at once, closed a little later (callbacks on their way, audioout.c)');
  assert.ok(!h.calls.some(([n])=>n==='audio.release'),'the speaker goes back to the host only once closed');
  h.runOnce();assert.ok(speaker.closed);assert.equal(done,'test','resolves when the phrase has been played');assert.equal(h.inputs.length,0,'still no microphone at the end');assert.ok(h.calls.some(([n,r])=>n==='ended'&&r==='test'));
  assert.ok(h.calls.some(([n])=>n==='audio.release'));const stats=h.calls.filter(([n])=>n==='stats').at(-1);assert.equal(stats[2],true,'saved apart from the call counters');
  assert.equal(await h.voice.start(),true,'a real conversation can start afterwards');h.voice.stop();
});
test('the faster μ-law encoder gives exactly the bytes of the standard formula',async()=>{
  const {ulawEncode}=await voiceWire(),all=new Int16Array(65536);for(let i=0;i<65536;i++)all[i]=i-32768;
  const reference=v=>{let sample=v,sign=0;if(sample<0){sign=0x80;sample=-sample;}sample=Math.min(sample,32635)+0x84;const exponent=24-Math.clz32(sample);return ~(sign|(exponent<<4)|((sample>>(exponent+3))&0x0f))&0xff;};
  const law=ulawEncode(all);for(let i=0;i<65536;i++)if(law[i]!==reference(all[i]))assert.fail(`sample ${all[i]}: ${law[i]} instead of ${reference(all[i])}`);
  const odd=new Uint8Array(7);odd.set(new Uint8Array(Int16Array.of(1000,-1000,32767).buffer),1);
  assert.deepEqual([...ulawEncode(odd.subarray(1))],[reference(1000),reference(-1000),reference(32767)],'a view that starts on an odd byte');
});
test('the robot tells the Worker which face it shows, so the agent speaks in the feminine or masculine',async()=>{
  for(const [style,path] of [['redhead','/api/robot/voice?audio=ima&mic=alaw&face=redhead'],['white','/api/robot/voice?audio=ima&mic=alaw&face=white'],['portrait','/api/robot/voice?audio=ima&mic=alaw&face=portrait']]){
    const h=await launch({faceStyle:()=>style});await h.voice.start();await h.flush();assert.equal(h.sockets[0].options.path,path);h.voice.stop();
  }
  const odd=await launch({faceStyle:()=>'x&y'});await odd.voice.start();await odd.flush();assert.equal(odd.sockets[0].options.path,'/api/robot/voice?audio=ima&mic=alaw','an unknown face is not sent');odd.voice.stop();
  const broken=await launch({faceStyle:()=>{throw Error('no face');}});await broken.voice.start();await broken.flush();assert.equal(broken.sockets[0].options.path,'/api/robot/voice?audio=ima&mic=alaw');broken.voice.stop();
});
test('the Wi-Fi stays awake for the whole conversation, from before the connection opens to its end (10 Nov 2026)',async()=>{
  const h=await launch();assert.equal(h.radios.length,0);
  await h.voice.start();assert.equal(h.radios.length,1,'taken before the handshake');assert.equal(h.radios[0].open,true);
  h.handshake();assert.equal(h.radios.length,1);
  h.voice.stop();assert.equal(h.radios[0].open,false,'given back at the end');
  await h.voice.start();assert.equal(h.radios.length,2);h.disconnect();assert.equal(h.radios[1].open,false,'also when the server closes');
  const off=await launch({verified:false});await assert.rejects(off.voice.start(),/hardware_unverified/);assert.equal(off.radios.length,0,'a refused conversation takes no lease');
});

test('from the provider’s words to the robot: the transcripts of 11 Nov 2026 become head and face commands, nothing else',async()=>{
  const h=await listening();
  const heard=text=>{const before=h.calls.length;h.receive({type:'user_transcript',user_transcription_event:{user_transcript:text}});return JSON.parse(JSON.stringify(h.calls.slice(before).filter(([n])=>['head','face','timer','memory'].includes(n))));};
  assert.deepEqual(heard('Tutta destra.'),[['head',{direction:'right',full:true}]]);
  assert.deepEqual(heard('Tutta a sinistra.'),[['head',{direction:'left',full:true}]]);
  assert.deepEqual(heard('Spostati a destra.'),[['head',{direction:'right'}]]);
  assert.deepEqual(heard('Destra.'),[['head',{direction:'right'}]]);assert.deepEqual(heard('Alto.'),[['head',{direction:'up'}]]);assert.deepEqual(heard('Basso.'),[['head',{direction:'down'}]]);
  assert.deepEqual(heard('Guarda a sinistra.'),[['head',{direction:'left'}]]);
  assert.deepEqual(heard('Sorridi.'),[['face',{expression:'happy'}]]);
  assert.deepEqual(heard('Fai la faccia triste.'),[['face',{expression:'sad'}]]);
  assert.deepEqual(heard('Fai la faccia arrabbiata.'),[['face',{expression:'angry'}]]);
  for(const text of ['Mh.','Spera.','Sì, grazie.','Guarda quanto.','L\'estra.','Allora, come stai?'])assert.deepEqual(heard(text),[],text+': nothing moves');
  assert.equal(heard('Avvisami tra 5 minuti')[0][0],'timer','timers still first');
  assert.deepEqual(heard('Tra.'),[['head',{direction:'left'}]],'11 Nov 2026: «sinistra» cut short');
  const seen=()=>h.calls.filter(([n])=>n==='see').length,before=seen(),heads=h.calls.filter(([n])=>n==='head').length;
  h.receive({type:'user_transcript',user_transcription_event:{user_transcript:"Cos'è questo?"}});assert.equal(seen(),before+1,'«cos’è questo?» asks for a picture');
  h.receive({type:'agent_response',agent_response_event:{agent_response:'Fammi vedere… ho girato la testa a destra.'}});assert.equal(seen(),before+1,'one picture for the question, not a second one for the reply');
  h.receive({type:'user_transcript',user_transcription_event:{user_transcript:'Mh, senti un po\''}});h.receive({type:'agent_response',agent_response_event:{agent_response:'Fammi vedere…'}});assert.equal(seen(),before+2,'the question was lost by the recognizer, Robottino says it looks: the picture is taken');
  h.receive({type:'agent_response',agent_response_event:{agent_response:'Fammi vedere meglio…'}});assert.equal(seen(),before+2,'once');assert.equal(h.calls.filter(([n])=>n==='head').length,heads,'and the reply to it moves nothing');
});

test('a piece of the picture goes on the conversation’s connection only when it has room; a closed conversation refuses it (11 Nov 2026)',async()=>{
  const h=await listening(),piece=new Uint8Array(3850);
  const socket=h.sockets[0],binary=()=>socket.sent.filter(value=>value===piece).length;
  assert.equal(h.voice.picture(piece),true);assert.equal(binary(),1);
  socket.bufferedAmount=5000;assert.equal(h.voice.picture(piece),false,'no room: it waits');assert.equal(binary(),1);
  socket.bufferedAmount=0;h.voice.pictureFailed();assert.ok(socket.sent.includes(JSON.stringify({type:'see.failed'})));
  h.voice.stop();assert.throws(()=>h.voice.picture(piece),/closed/);
});
test('when the user’s words gave no command, the robot does the head move Robottino says it did, once (11 Nov 2026)',async()=>{
  const h=await listening();
  const moves=()=>JSON.parse(JSON.stringify(h.calls.filter(([n])=>n==='head')));
  const user=text=>h.receive({type:'user_transcript',user_transcription_event:{user_transcript:text}});
  const said=text=>h.receive({type:'agent_response',agent_response_event:{agent_response:text}});
  user('Ehm, stra?');said('Ecco, ho girato la testa a sinistra.');
  assert.deepEqual(moves(),[['head',{direction:'left'}]],'the reply moves the head');
  said('Ecco, ho girato la testa a sinistra.');assert.equal(moves().length,1,'once per turn');
  user('Destra.');said('Ecco, ho girato la testa a destra.');assert.equal(moves().length,2,'the user’s own command, not twice');
  user('Mi senti?');said('Sì, ti sento benissimo!');assert.equal(moves().length,2,'no move in the reply: nothing');
  user('Puoi alzare un po\' lo sguardo?');said('Non posso alzare la testa ora.');assert.equal(moves().length,2,'never what it says it cannot do');
  user('Va bene così, grazie mille davvero.');said('Ecco, ho alzato la testa.');assert.deepEqual(moves().at(-1),['head',{direction:'up'}]);
});
