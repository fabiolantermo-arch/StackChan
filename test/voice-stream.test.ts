import {afterEach,expect,it,vi} from 'vitest';
import {env} from 'cloudflare:test';
import {voiceStream} from '../src/voice-stream';

afterEach(()=>vi.restoreAllMocks());
const next=(ws:WebSocket,type?:string)=>new Promise<any>(resolve=>{
  const handler=(e:MessageEvent)=>{const value=JSON.parse(String(e.data));if(!type||value.type===type){ws.removeEventListener('message',handler);resolve(value);}};
  ws.addEventListener('message',handler);
});
async function setup(provider='openai',history:{role:string;content:string}[]=[],query='') {
  const pair=new WebSocketPair(),server=pair[1];server.accept();
  const messages:any[]=[];server.addEventListener('message',e=>{messages.push(JSON.parse(String(e.data)));});
  vi.spyOn(globalThis,'fetch').mockImplementation(async input=>{
    if(String(input).includes('get-signed-url'))return Response.json({signed_url:'wss://api.elevenlabs.io/test'});
    return new Response(null,{status:101,webSocket:pair[0]});
  });
  const saved=vi.fn();
  const response=await voiceStream(new Request('https://test/api/voice?provider='+provider+query),env,history,saved);
  const client=response.webSocket!;client.accept();
  return {server,client,messages,saved};
}
it('forwards audio and interruption events and releases both sockets',async()=>{
  const h=await setup();
  const incoming=next(h.client);
  h.server.send(JSON.stringify({type:'session.output_audio.delta',delta:'AQID'}));
  expect((await incoming).delta).toBe('AQID');
  const interrupt=next(h.client);
  h.server.send(JSON.stringify({type:'session.input_audio.speech_started'}));
  expect((await interrupt).type).toBe('session.input_audio.speech_started');
  const closed=new Promise(resolve=>h.server.addEventListener('close',resolve,{once:true}));
  h.client.close();await closed;
  expect(h.saved).toHaveBeenCalledTimes(1);
});
it('combines transcript deltas and saves only text on close',async()=>{
  const h=await setup();
  for(const delta of ['Ciao ','Ada']){const delivered=next(h.client);h.server.send(JSON.stringify({type:'session.output_transcript.delta',delta}));await delivered;}
  const closed=new Promise(resolve=>h.server.addEventListener('close',resolve,{once:true}));h.client.close();await closed;
  expect(h.saved).toHaveBeenCalledWith([{role:'assistant',content:'Ciao Ada'}]);
});
it('passes prior context into the next OpenAI session',async()=>{
  const h=await setup('openai',[{role:'user',content:'Mi chiamo Ada'}]);
  const received=next(h.server);h.client.send(JSON.stringify({type:'session.input_audio.append',audio:'AAAA'}));await received;
  expect(h.messages[0].session.input[0].content[0].text).toBe('Mi chiamo Ada');
  h.client.close();
});
it('closes invalid client commands before forwarding them',async()=>{
  const h=await setup();
  const closed=new Promise(resolve=>h.client.addEventListener('close',resolve,{once:true}));
  h.client.send(JSON.stringify({type:'session.start',session:{model:'unapproved'}}));await closed;
  expect(h.messages.some(m=>m.session?.model==='unapproved')).toBe(false);
});
it('supports ElevenLabs signed connection and restores its context',async()=>{
  const h=await setup('elevenlabs',[{role:'user',content:'Contesto sintetico'}]);
  const restored=next(h.server,'contextual_update');
  h.server.send(JSON.stringify({type:'conversation_initiation_metadata'}));
  expect((await restored).type).toBe('contextual_update');
  h.client.close();
});
it('keeps a conversation open within the per-second budget beyond the old 4 MB total',async()=>{
  const {VOICE_LIMITS}=await import('../src/voice-stream');
  expect(VOICE_LIMITS.durationMs).toBe(300000);
  // 24 kHz PCM16 in base64 for 5 minutes stays within the total budget.
  expect(Math.ceil(24000*2*4/3)*300).toBeLessThan(VOICE_LIMITS.totalBytes);
  expect(Math.ceil(24000*2*4/3)).toBeLessThan(VOICE_LIMITS.bytesPerSecond);
});
it('does not leave a timeout signal on the provider WebSocket',async()=>{
  const pair=new WebSocketPair();pair[1].accept();let signal:AbortSignal|undefined;
  vi.spyOn(globalThis,'fetch').mockImplementation(async (_input,init)=>{signal=init?.signal??undefined;return new Response(null,{status:101,webSocket:pair[0]});});
  const response=await voiceStream(new Request('https://test/api/voice?provider=openai'),env,[],()=>{});
  expect(response.status).toBe(101);expect(signal).toBeDefined();
  // A handshake-only controller: once connected nothing can abort it later.
  await new Promise(resolve=>setTimeout(resolve,50));expect(signal!.aborted).toBe(false);
  response.webSocket!.accept();response.webSocket!.close();
});
it('tells both providers the current Italian date and time',async()=>{
  const open=await setup('openai');
  const received=next(open.server);open.client.send(JSON.stringify({type:'session.input_audio.append',audio:'AAAA'}));await received;
  expect(open.messages[0].session.instructions).toMatch(/Data e ora attuali in Italia: .*\d{4}/);open.client.close();
  const eleven=await setup('elevenlabs');const update=next(eleven.server,'contextual_update');
  eleven.server.send(JSON.stringify({type:'conversation_initiation_metadata'}));
  expect((await update).text).toMatch(/^Data e ora attuali in Italia: .*Timer, promemoria e Pomodoro/);eleven.client.close();
});
it('lets OpenAI delegate web searches and hides non-fatal backend errors from the devices',async()=>{
  const h=await setup('openai');
  const received=next(h.server);h.client.send(JSON.stringify({type:'session.input_audio.append',audio:'AAAA'}));await received;
  const delegation=h.messages[0].session.delegation;
  expect(delegation.type).toBe('responses');expect(delegation.responses.tools).toEqual([expect.objectContaining({type:'web_search'})]);
  expect(h.messages[0].session.instructions).toMatch(/ricerca sul web/);
  const seen:any[]=[];h.client.addEventListener('message',e=>seen.push(JSON.parse(String(e.data))));
  h.server.send(JSON.stringify({type:'error',error:{code:'responses_validation_failed',message:'bad tool'}}));
  const after=next(h.client,'session.output_transcript.delta');h.server.send(JSON.stringify({type:'session.output_transcript.delta',delta:'Domani a Milano sole.'}));await after;
  expect(seen.map(v=>v.type)).toEqual(['session.output_transcript.delta']);
  h.client.close();
});
it('removes ElevenLabs voice tags from the text and asks the agent to wait for memory results',async()=>{
  expect((await import('../src/voice-stream')).stripVoiceTags('Domani sono previste [calm] foschie. [laughs] Ciao [cheerfully]!')).toBe('Domani sono previste foschie. Ciao!');
  const h=await setup('elevenlabs');const update=next(h.server,'contextual_update');
  h.server.send(JSON.stringify({type:'conversation_initiation_metadata'}));
  expect((await update).text).toMatch(/prima di ricevere il «Risultato gestione ricordi»/);
  const reply=next(h.client,'agent_response');h.server.send(JSON.stringify({type:'agent_response',agent_response_event:{agent_response:'Sole [calm] e 14 gradi.'}}));
  expect((await reply).agent_response_event.agent_response).toBe('Sole e 14 gradi.');
  const closed=new Promise(resolve=>h.server.addEventListener('close',resolve,{once:true}));h.client.close();await closed;
  expect(h.saved).toHaveBeenCalledWith([{role:'assistant',content:'Sole e 14 gradi.'}]);
});

// Robot route: replies arrive in small pieces at speaking pace (fixed 256 KB memory on the robot).
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const msOf=(pieces:string[],rate=16000)=>pieces.reduce((sum,p)=>sum+p.length*3/8/rate*1000,0);
async function robot(){
  const h=await setup('elevenlabs',[],'&sessionId=robot');
  const audio:string[]=[],other:string[]=[];
  h.client.addEventListener('message',e=>{const v=JSON.parse(String(e.data));if(v.type==='audio')audio.push(v.audio_event.audio_base_64);else other.push(v.type);});
  h.server.send(JSON.stringify({type:'conversation_initiation_metadata',conversation_initiation_metadata_event:{agent_output_audio_format:'pcm_16000'}}));
  return {...h,audio,other};
}
it('sends the robot small whole-sample pieces, at most about a second ahead of playback',async()=>{
  const {ROBOT_AUDIO}=await import('../src/voice-stream');
  const h=await robot(),reply='AQEB'.repeat(32000); // 3 s at 16 kHz in one provider event
  h.server.send(JSON.stringify({type:'audio',audio_event:{audio_base_64:reply,event_id:1}}));
  await wait(40);
  expect(h.audio.length).toBeGreaterThan(0);
  expect(h.audio.every(p=>p.length<=ROBOT_AUDIO.pieceChars&&p.length%4===0)).toBe(true);
  expect(msOf(h.audio)).toBeLessThanOrEqual(ROBOT_AUDIO.leadMs+200);
  await wait(400);expect(msOf(h.audio)).toBeGreaterThan(ROBOT_AUDIO.leadMs+200);
  h.client.close();
});
it('delivers the whole reply to the robot in order',async()=>{
  const h=await robot(),reply='AQEB'.repeat(6400); // 0.6 s: fits in the lead window
  h.server.send(JSON.stringify({type:'audio',audio_event:{audio_base_64:reply,event_id:1}}));
  await wait(40);expect(h.audio.join('')).toBe(reply);
  h.client.close();
});
it('drops the waiting reply when the provider or the robot interrupts',async()=>{
  for(const who of ['provider','robot']){
    const h=await robot();
    h.server.send(JSON.stringify({type:'audio',audio_event:{audio_base_64:'AQEB'.repeat(32000),event_id:1}}));
    await wait(40);const sent=h.audio.length;
    if(who==='provider')h.server.send(JSON.stringify({type:'interruption',interruption_event:{event_id:1}}));
    else h.client.send(JSON.stringify({type:'playback.clear'}));
    await wait(400);
    expect(h.audio.length,who).toBe(sent);
    if(who==='provider')expect(h.other).toContain('interruption');
    else expect(h.messages.some(m=>m.type==='playback.clear'),'not forwarded to the provider').toBe(false);
    h.client.close();
  }
});
it('keeps the app route unchanged: provider audio events are forwarded whole',async()=>{
  const h=await setup('elevenlabs'),reply='AQEB'.repeat(32000);
  const incoming=next(h.client,'audio');h.server.send(JSON.stringify({type:'audio',audio_event:{audio_base_64:reply,event_id:1}}));
  expect((await incoming).audio_event.audio_base_64).toBe(reply);
  h.client.close();
});
// Robot with ?audio=ulaw: G.711 μ-law binary frames in both directions (a third of base64 JSON).
it('encodes and decodes G.711 μ-law like the telephone standard',async()=>{
  const {pcm16ToUlaw,ulawToPcm16}=await import('../src/voice-stream');
  const pcm=(values:number[])=>new Uint8Array(Int16Array.from(values).buffer);
  expect([...pcm16ToUlaw(pcm([0,-1,32767,-32768]))]).toEqual([0xff,0x7f,0x80,0x00]);
  expect([...new Int16Array(ulawToPcm16(Uint8Array.from([0xff,0x80,0x00])).buffer)]).toEqual([0,32124,-32124]);
  const samples=[-30000,-5000,-300,-20,0,20,300,5000,30000],back=new Int16Array(ulawToPcm16(pcm16ToUlaw(pcm(samples))).buffer);
  samples.forEach((value,i)=>expect(Math.abs(back[i]-value)).toBeLessThanOrEqual(Math.max(16,Math.abs(value)/16)));
});
async function robotUlaw(){
  const h=await setup('elevenlabs',[],'&sessionId=robot&audio=ulaw');
  const frames:Uint8Array[]=[],other:string[]=[];h.client.binaryType='arraybuffer';
  h.client.addEventListener('message',e=>{if(e.data instanceof ArrayBuffer)frames.push(new Uint8Array(e.data));else other.push(JSON.parse(String(e.data)).type);});
  h.server.send(JSON.stringify({type:'conversation_initiation_metadata',conversation_initiation_metadata_event:{agent_output_audio_format:'pcm_16000'}}));
  return {...h,frames,other};
}
it('sends the robot its reply as paced binary μ-law and keeps text events as text',async()=>{
  const {ROBOT_AUDIO,ulawToPcm16}=await import('../src/voice-stream');
  const h=await robotUlaw(),pcm=new Int16Array(16000*3).fill(1000); // 3 s at 16 kHz
  const reply=btoa(String.fromCharCode(...new Uint8Array(pcm.buffer).subarray(0,9600)));
  h.server.send(JSON.stringify({type:'audio',audio_event:{audio_base_64:reply,event_id:1}}));
  await wait(40);
  expect(h.frames.length).toBe(2);expect(h.frames[0].length).toBe(ROBOT_AUDIO.pieceSamples);expect(h.frames[1].length).toBe(4800-ROBOT_AUDIO.pieceSamples);
  expect([...new Int16Array(ulawToPcm16(h.frames[0]).buffer).slice(0,3)].every(v=>Math.abs(v-1000)<=64)).toBe(true);
  const text=next(h.client,'agent_response');h.server.send(JSON.stringify({type:'agent_response',agent_response_event:{agent_response:'Ciao'}}));
  expect((await text).agent_response_event.agent_response).toBe('Ciao');
  h.client.close();
});
it('turns the robot binary μ-law microphone into the provider audio event',async()=>{
  const {pcm16ToUlaw}=await import('../src/voice-stream');
  const h=await robotUlaw(),law=pcm16ToUlaw(new Uint8Array(new Int16Array(1600).fill(-2000).buffer));
  h.client.send(law);await wait(40);
  const chunk=atob(h.messages.find(m=>'user_audio_chunk'in m).user_audio_chunk);
  expect(chunk.length).toBe(3200);const first=(chunk.charCodeAt(0)|chunk.charCodeAt(1)<<8)<<16>>16;expect(Math.abs(first+2000)).toBeLessThanOrEqual(128);
  h.client.close();
});
it('accepts binary audio only from a robot that asked for μ-law',async()=>{
  const h=await setup('elevenlabs',[],'&sessionId=robot');
  const closed=new Promise(resolve=>h.client.addEventListener('close',resolve,{once:true}));
  h.client.send(new Uint8Array(160));await closed;
  expect(h.messages.some(m=>'user_audio_chunk'in m)).toBe(false);
});
it('reads robot binary frames whether they arrive as ArrayBuffer, view or Blob',async()=>{
  const {bytesOf}=await import('../src/voice-stream');
  const data=Uint8Array.from([1,2,3,4]);
  expect([...(await bytesOf(data.buffer))!]).toEqual([1,2,3,4]);
  expect([...(await bytesOf(data.subarray(1,3)))!]).toEqual([2,3]);
  expect([...(await bytesOf(new Blob([data])))!]).toEqual([1,2,3,4]);
  expect(await bytesOf({})).toBeNull();
});
// Robot with ?audio=ima: IMA ADPCM frames played natively by the robot's speaker driver, A-law microphone.
// A copy of Moddable's decoder (modules/pins/i2s/dvi_adpcm_decode.c) checks what the robot will hear.
const IMA_INDEX=[-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8];
const IMA_STEPS=[7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];
function moddableImaChunk(bytes:Uint8Array,at:number):number[]{
  let valpred=(bytes[at]|bytes[at+1]<<8)<<16>>16,index=bytes[at+2],step=IMA_STEPS[index];const out=[valpred];
  for(let n=0;n<128;n++){
    const byte=bytes[at+4+(n>>1)],delta=n&1?(byte>>4)&0xf:byte&0xf;
    index+=IMA_INDEX[delta];if(index<0)index=0;if(index>88)index=88;
    const sign=delta&8,magnitude=delta&7;let vpdiff=step>>3;
    if(magnitude&4)vpdiff+=step;if(magnitude&2)vpdiff+=step>>1;if(magnitude&1)vpdiff+=step>>2;
    valpred+=sign?-vpdiff:vpdiff;if(valpred>32767)valpred=32767;else if(valpred<-32768)valpred=-32768;
    step=IMA_STEPS[index];out.push(valpred);
  }
  return out;
}
const decodeFrame=(frame:Uint8Array)=>{const segments=frame[1],chunks=(frame.length-2-segments)/68,out:number[]=[];for(let c=0;c<chunks;c++)out.push(...moddableImaChunk(frame,2+segments+c*68));return out;};
const snr=(reference:ArrayLike<number>,decoded:number[])=>{let signal=0,noise=0;for(let i=0;i<decoded.length;i++){signal+=reference[i]**2;noise+=(reference[i]-decoded[i])**2;}return 10*Math.log10(signal/noise);};
it('encodes IMA ADPCM chunks that Moddable decodes back to the voice',async()=>{
  const {imaFrame,ImaEncoder,IMA}=await import('../src/robot-audio');
  const pcm=Int16Array.from({length:3096},(_,i)=>Math.round(8000*Math.sin(i*2*Math.PI*440/16000)+2000*Math.sin(i*2*Math.PI*1300/16000)));
  const frame=imaFrame(pcm,new ImaEncoder());
  expect(frame[0]).toBe(1);expect(frame[1]).toBe(6);expect(frame.length).toBe(2+6+IMA.frameChunks*IMA.chunkBytes);
  expect([...frame.subarray(2,8)]).toEqual([3,4,4,4,4,4]); // loud: one mouth pose every 32 ms, opening in two steps
  const decoded=decodeFrame(frame);expect(decoded.length).toBe(3096);
  expect(decoded[0]).toBe(pcm[0]);expect(decoded[129]).toBe(pcm[129]); // every chunk starts exact
  expect(snr(pcm,decoded)).toBeGreaterThan(25);
  const quiet=imaFrame(new Int16Array(300).fill(100),new ImaEncoder());
  expect(quiet[1]).toBe(1);expect(quiet[2]).toBe(0);expect(decodeFrame(quiet).length).toBe(387); // padded to 3 whole chunks
});
it('moves the robot mouth like the iPhone app: opens in about 45 ms, closes in about 90 ms, five poses',async()=>{
  const {MouthTrack,MOUTH_POSES}=await import('../src/robot-audio');
  expect(MOUTH_POSES).toEqual([0,.18,.35,.58,.8]);
  const mouth=new MouthTrack(),loud=new Int16Array(516).fill(2600),silent=new Int16Array(516),step=516/16000;
  // RobotVoiceProtocol.mouthOpenness: (RMS − 500) / 2100 → 1 for RMS 2600; RobotMouthSmoother: speed 22/s opening, 11/s closing.
  expect([0,1,2,3].map(()=>mouth.pose(loud,step))).toEqual([3,4,4,4]);expect(mouth.value).toBeCloseTo(1-Math.exp(-22*step*4),5);
  expect([0,1,2,3,4,5,6].map(()=>mouth.pose(silent,step))).toEqual([3,2,2,1,1,1,0],'closes through the middle poses, never in one jump');
  const half=new MouthTrack();for(let i=0;i<20;i++)half.pose(new Int16Array(516).fill(1235),step);expect(half.value).toBeCloseTo(.35,2);expect(half.pose(new Int16Array(516).fill(1235),step)).toBe(2);
});
async function robotIma(){
  const h=await setup('elevenlabs',[],'&sessionId=robot&audio=ima&mic=alaw');
  const frames:Uint8Array[]=[],other:string[]=[];h.client.binaryType='arraybuffer';
  h.client.addEventListener('message',e=>{if(e.data instanceof ArrayBuffer)frames.push(new Uint8Array(e.data));else other.push(JSON.parse(String(e.data)).type);});
  h.server.send(JSON.stringify({type:'conversation_initiation_metadata',conversation_initiation_metadata_event:{agent_output_audio_format:'pcm_16000'}}));
  return {...h,frames,other};
}
const base64Of=(pcm:Int16Array)=>{const bytes=new Uint8Array(pcm.buffer,pcm.byteOffset,pcm.byteLength);let text='';for(let i=0;i<bytes.length;i+=0x8000)text+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(text);};
it('sends the robot whole IMA frames, the rest once the provider pauses, paced about a second ahead',async()=>{
  const {ROBOT_AUDIO}=await import('../src/voice-stream');
  const h=await robotIma(),pcm=Int16Array.from({length:16000},(_,i)=>Math.round(6000*Math.sin(i*2*Math.PI*300/16000))); // 1 s
  h.server.send(JSON.stringify({type:'audio',audio_event:{audio_base_64:base64Of(pcm.subarray(0,10000)),event_id:1}}));
  h.server.send(JSON.stringify({type:'audio',audio_event:{audio_base_64:base64Of(pcm.subarray(10000)),event_id:1}}));
  await wait(40);
  expect(h.frames.map(f=>f.length)).toEqual([1640,1640,1640,1640,1640]);
  await wait(ROBOT_AUDIO.tailMs+100);
  expect(h.frames.length).toBe(6);const tail=decodeFrame(h.frames[5]);expect(tail.length).toBe(645); // 520 samples in 5 whole chunks
  const decoded=h.frames.flatMap(decodeFrame).slice(0,16000);expect(snr(pcm,decoded)).toBeGreaterThan(20);
  const text=next(h.client,'agent_response');h.server.send(JSON.stringify({type:'agent_response',agent_response_event:{agent_response:'Ciao'}}));
  expect((await text).agent_response_event.agent_response).toBe('Ciao');
  h.client.close();
});
it('keeps IMA frames about a second ahead and drops them, with the rest, on an interruption',async()=>{
  const {ROBOT_AUDIO}=await import('../src/voice-stream');
  const h=await robotIma(),pcm=new Int16Array(16000*3).fill(3000); // 3 s
  h.server.send(JSON.stringify({type:'audio',audio_event:{audio_base_64:base64Of(pcm.subarray(0,16000*3-100)),event_id:1}}));
  await wait(40);
  const ahead=h.frames.length*3096/16;expect(ahead).toBeLessThanOrEqual(ROBOT_AUDIO.leadMs+200);expect(ahead).toBeGreaterThan(ROBOT_AUDIO.leadMs-200);
  h.server.send(JSON.stringify({type:'interruption',interruption_event:{event_id:1}}));const sent=h.frames.length;
  await wait(ROBOT_AUDIO.tailMs+300);expect(h.frames.length,'no more frames, not even the rest').toBe(sent);
  h.client.close();
});
it('turns the robot A-law microphone (encoded by the host natively) into the provider audio event',async()=>{
  // The host's encoder (ChatAudioIO/Codecs, audio-codecs.c), copied: G.711 A-law.
  const alaw=(pcm:number)=>{let eee=7,mask=0x4000;const sign=(pcm&0x8000)>>8;pcm=sign?(-pcm-1):pcm;while((pcm&mask)===0&&eee>0){eee--;mask>>=1;}const abcd=(pcm>>(eee?eee+3:4))&0x0f;return ((sign|eee<<4|abcd)^0xD5)&0xff;};
  const {alawToPcm16}=await import('../src/robot-audio');
  for(const value of [-32768,-20000,-2000,-100,-1,0,1,100,2000,20000,32767]){
    const back=new Int16Array(alawToPcm16(Uint8Array.of(alaw(value&0xffff))).buffer)[0];
    expect(Math.abs(back-value),String(value)).toBeLessThanOrEqual(Math.max(16,Math.abs(value)/16));
  }
  const h=await robotIma();h.client.send(Uint8Array.from({length:1600},()=>alaw(-2000&0xffff)));await wait(40);
  const chunk=atob(h.messages.find(m=>'user_audio_chunk'in m).user_audio_chunk);
  expect(chunk.length).toBe(3200);const first=(chunk.charCodeAt(0)|chunk.charCodeAt(1)<<8)<<16>>16;expect(Math.abs(first+2000)).toBeLessThanOrEqual(128);
  h.client.close();
});

it('the robot call opens with a greeting from the agent, after the context; the iPhone call does not',async()=>{
  const {robotGreeting,ownerName}=await import('../src/voice-stream');
  const h=await setup('elevenlabs',[],'&sessionId=robot');const greeting=next(h.server,'user_message');
  h.server.send(JSON.stringify({type:'conversation_initiation_metadata',conversation_initiation_metadata_event:{agent_output_audio_format:'pcm_16000'}}));
  expect((await greeting).text).toBe(robotGreeting(null,ownerName(env)));
  const types=h.messages.map(m=>m.type);expect(types.indexOf('contextual_update')).toBeLessThan(types.indexOf('user_message'));
  expect(types.filter(type=>type==='user_message')).toHaveLength(1);
  const phone=await setup('elevenlabs');const update=next(phone.server,'contextual_update');
  phone.server.send(JSON.stringify({type:'conversation_initiation_metadata'}));await update;await new Promise(r=>setTimeout(r,20));
  expect(phone.messages.some(m=>m.type==='user_message')).toBe(false);
});

it('speaks of itself in the feminine with the two girls and in the masculine with the white robot (owner, 9 Nov 2026)',async()=>{
  const {genderRule,robotGreeting,robotGreetingFor,ownerName,ROBOT_GREETING}=await import('../src/voice-stream');
  expect(genderRule('portrait')).toMatch(/femminile.*pronta/);expect(genderRule('redhead')).toMatch(/femminile/);
  expect(genderRule('white')).toMatch(/maschile.*pronto/);expect(genderRule('other')).toBe('');expect(genderRule(null)).toBe('');
  expect(robotGreeting('redhead')).toMatch(/^\(Inizio chiamata dal robot:.*Parla di te al femminile\.\)$/);
  expect(robotGreeting('white')).toMatch(/al maschile\.\)$/);expect(robotGreetingFor('Ada')).toMatch(/tu sei Robottino e io sono Ada, non chiamarmi Robottino.*comincia con «Ciao Ada!».*ogni volta diversa/);expect(ROBOT_GREETING).toMatch(/io sono la persona che ti parla.*comincia con «Ciao!»/);expect(ownerName({OWNER_NAME:' Ada «x»; DROP 123 '})).toBe('Ada x DROP');expect(ownerName(undefined)).toBe('');expect(ROBOT_GREETING).toMatch(/una volta sola.*non salutare di nuovo/);expect(robotGreeting(undefined)).toBe(ROBOT_GREETING);
  // ElevenLabs from the robot: in the context, then in the greeting.
  const h=await setup('elevenlabs',[],'&sessionId=robot&face=redhead');const greeting=next(h.server,'user_message');
  h.server.send(JSON.stringify({type:'conversation_initiation_metadata',conversation_initiation_metadata_event:{agent_output_audio_format:'pcm_16000'}}));
  expect((await greeting).text).toBe(robotGreeting('redhead',ownerName(env)));
  expect(h.messages.find(m=>m.type==='contextual_update').text).toContain(genderRule('redhead'));
  // OpenAI from the iPhone: in the instructions.
  const phone=await setup('openai',[],'&sessionId=iphone&face=white');await new Promise(r=>setTimeout(r,20));
  expect(phone.messages.find(m=>m.type==='session.start').session.instructions).toContain(genderRule('white'));
  // Spoken head commands: only the robot's calls are told that the robot turns its own head.
  const {HEAD_RULE}=await import('../src/voice-stream');
  expect(h.messages.find(m=>m.type==='contextual_update').text).toContain(HEAD_RULE);
  // The voice follows the face asked for (owner, 11 Nov 2026): a laugh, a sad tone, a grumpy tone, then back to normal.
  expect(HEAD_RULE).toMatch(/sorridi.*risata.*triste.*voce triste.*arrabbiata.*voce arrabbiata.*mai offensiva.*tono normale/s);
  expect(HEAD_RULE).toMatch(/«tutto su», «tutto giù».*non sono domande vaghe/s);
  expect(HEAD_RULE).toMatch(/anche in inglese.*«right», «left», «up», «down».*«sad face», «angry face», «back to happy»/s);
  expect(HEAD_RULE).toMatch(/restano, e resta anche la tua voce.*finché l’utente non ti dice di tornare felice o normale/s);
  expect(phone.messages.find(m=>m.type==='session.start').session.instructions).not.toContain(HEAD_RULE);
  const unknown=await setup('openai',[],'&face=%3Cscript%3E');await new Promise(r=>setTimeout(r,20));
  expect(unknown.messages.find(m=>m.type==='session.start').session.instructions).not.toMatch(/Aspetto|script/);
});
