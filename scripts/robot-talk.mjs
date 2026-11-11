// A test conversation "as the robot": the same access (/api/robot/voice, device token) and the same
// protocol as the firmware (voice-wire.js), with the Mac's microphone and speakers.
// Use:  npm run robot:talk                      → says «Ciao Robottino, come stai?» with the voice Alice
//       npm run robot:talk -- "Cosa ricordi di me?"
//       npm run robot:talk -- --microphone       → you speak (Ctrl+C to end)
//       npm run robot:talk -- --app --openai    → the iPhone app's path (/api/voice) with the chosen provider
//       npm run robot:talk -- --ulaw            → as the robot until 9 November: binary μ-law audio both ways
//       npm run robot:talk -- --ima             → as the real robot: replies in IMA ADPCM blocks, A-law microphone
// It really calls the provider chosen in the app: it counts against the daily limits.
import WebSocket from 'ws';
import {spawn,spawnSync} from 'node:child_process';
import {readFile,mkdir,writeFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {SourceTextModule,createContext} from 'node:vm';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url)),mod=path.join(root,'firmware/stackchan-mod');
const args=process.argv.slice(2),microphone=args.includes('--microphone'),phrase=args.find(a=>!a.startsWith('--'))??'Ciao Robottino, come stai?';
// --app: same route and token as the iPhone app; otherwise the robot's route and credential.
const appRoute=args.includes('--app'),chosen=args.includes('--elevenlabs')?'elevenlabs':'openai';
const token=(await readFile(path.join(root,appRoute?'private/robot-token':'private/robot-device-token'),'utf8')).trim();
const ima=!appRoute&&args.includes('--ima'),ulaw=!appRoute&&!ima&&args.includes('--ulaw');
const route=appRoute?`/api/voice?provider=${chosen}&sessionId=${process.env.ROBOTTINO_SESSION??'prova-mac'}`:'/api/robot/voice'+(ima?'?audio=ima&mic=alaw':ulaw?'?audio=ulaw':'');
const log=text=>console.log(`[${new Date().toLocaleTimeString('it-IT')}] ${text}`);

// Load the firmware's own protocol module (it imports robottino-live-wire by name).
const context=createContext({console,ArrayBuffer,Uint8Array,DataView,JSON,Math,Number,String});
const sources={'robottino-live-wire':'live-wire.js'};
const wire=new SourceTextModule(await readFile(path.join(mod,'voice-wire.js'),'utf8'),{context});
await wire.link(async name=>{const m=new SourceTextModule(await readFile(path.join(mod,sources[name]),'utf8'),{context});await m.link(()=>{throw Error('unexpected import');});return m;});
await wire.evaluate();
const {parseVoiceEvent,audioMessage,ulawEncode,ulawDecode,pongMessage,memoryMessage,isMemoryPhrase,VoiceTurns}=wire.namespace;
const {pcmMouthLevel}=await import(pathToFileURL(path.join(mod,'live-wire.js')).href);
// With --ima the microphone goes out as A-law with the host's own arithmetic (ChatAudioIO/Codecs), and the
// replies come as the Worker's IMA frames, decoded as the robot's speaker driver does (dvi_adpcm_decode.c).
const alawOf=value=>{const sign=(value&0x8000)>>8,pcm=sign?-value-1:value;let eee=7,mask=0x4000;while((pcm&mask)===0&&eee>0){eee--;mask>>=1;}return (sign|eee<<4|(pcm>>(eee?eee+3:4))&0x0f)^0xd5;};
const alawEncode=pcm=>{const samples=new Int16Array(pcm.buffer,pcm.byteOffset,pcm.byteLength>>1);return Uint8Array.from(samples,alawOf);};
const IMA_INDEX=[-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8];
const IMA_STEPS=[7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];
const imaDecode=frame=>{
  const segments=frame[1],chunks=(frame.length-2-segments)/68;if(frame[0]!==1||!Number.isInteger(chunks))throw Error('frame IMA non valido');
  const out=new Int16Array(chunks*129);let n=0;
  for(let c=0;c<chunks;c++){
    const at=2+segments+c*68;let valpred=(frame[at]|frame[at+1]<<8)<<16>>16,index=frame[at+2],step=IMA_STEPS[index];out[n++]=valpred;
    for(let i=0;i<128;i++){
      const byte=frame[at+4+(i>>1)],delta=i&1?(byte>>4)&0xf:byte&0xf;index=Math.min(88,Math.max(0,index+IMA_INDEX[delta]));
      let vpdiff=step>>3;if(delta&4)vpdiff+=step;if(delta&2)vpdiff+=step>>1;if(delta&1)vpdiff+=step>>2;
      valpred=Math.min(32767,Math.max(-32768,valpred+(delta&8?-vpdiff:vpdiff)));step=IMA_STEPS[index];out[n++]=valpred;
    }
  }
  return {pcm:out.buffer,mouth:Math.max(0,...frame.subarray(2,2+segments))};
};
// With --ulaw the microphone goes out as binary μ-law frames, as the robot sent it until 9 Nov 2026.
const sendAudio=pcm=>socket.send(ima?Buffer.from(alawEncode(new Uint8Array(pcm))):ulaw?Buffer.from(ulawEncode(new Uint8Array(pcm))):audioMessage(provider,Buffer.from(pcm).toString('base64')));
const decode=text=>{const b=Buffer.from(text,'base64');return new Uint8Array(b).buffer;};

const socket=new WebSocket('wss://robottino-stackchan.example.workers.dev'+route,{headers:{Authorization:'Bearer '+token},handshakeTimeout:10000,maxPayload:1000000});
const turns=new VoiceTurns(),reply=[];let sentBytes=0,lastAudible=0,lastText=0,answered=false,provider,inputRate,outputRate,player,capture,playingUntil=0,lastAudio=0,finished=false,feeder;

let said='';
const startedAt=Date.now();
const quiet=Number(process.env.ROBOTTINO_ATTESA)||2500;
const flushSaid=()=>{if(said.trim())log(`Robottino: «${said.trim()}»`);said='';};
// Audio arriving ahead of real time piles up in the robot's queue (fixed 256 KB JavaScript memory).
const sizes={events:0,largest:0,largestMs:0,lead:0,burstStart:0,burstMs:0,last:0};
function measure(text,pcmBytes){
  const now=Date.now(),ms=pcmBytes/2/outputRate*1000;sizes.events++;
  if(text.length>sizes.largest){sizes.largest=text.length;sizes.largestMs=ms;}
  if(now-sizes.last>1000){sizes.burstStart=now;sizes.burstMs=0;}
  sizes.last=now;sizes.burstMs+=ms;sizes.lead=Math.max(sizes.lead,sizes.burstMs-(now-sizes.burstStart));
}
function finish(message){
  if(finished)return;finished=true;flushSaid();log(message);
  if(sizes.events)log(`Audio: ${sizes.events} pezzi; il più grande ${(sizes.largest/1024).toFixed(1)} KB di testo (${Math.round(sizes.largestMs)} ms di voce); anticipo massimo sul parlato ${(sizes.lead/1000).toFixed(1)} s.`);
  clearInterval(feeder);capture?.kill('SIGINT');player?.stdin.end();socket.close();
  if(reply.length){
    const pcm=Buffer.concat(reply),header=Buffer.alloc(44);
    header.write('RIFF',0);header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);
    header.writeUInt32LE(outputRate,24);header.writeUInt32LE(outputRate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
    const file=path.join(root,'work/virtual-robot/reply.wav');
    void mkdir(path.dirname(file),{recursive:true}).then(()=>writeFile(file,Buffer.concat([header,pcm]))).then(()=>log(`Risposta salvata in ${path.relative(root,file)} (${(pcm.length/2/outputRate).toFixed(1)} s).`));
  }
}
function stream(pcm){
  // Real-time pacing, 100 ms per message, as the robot does.
  const chunk=inputRate/10*2;let offset=0;
  feeder=setInterval(()=>{
    if(socket.readyState!==WebSocket.OPEN)return;
    const part=offset<pcm.length?pcm.subarray(offset,offset+chunk):Buffer.alloc(chunk);offset+=chunk;
    sendAudio(part);
    if(offset>pcm.length+inputRate*2*20&&!reply.length)finish('Nessuna risposta entro 20 secondi.');
    // OpenAI Live keeps streaming (also silence): end on quiet audio and no new words.
    // Never more than 60 s per test: an agent may keep talking ("ci sei ancora?") and spend credits.
    if(Date.now()-startedAt>60000&&!microphone)finish('Prova chiusa dopo 60 secondi.');
    // ROBOTTINO_ATTESA (ms) waits longer, e.g. while the agent searches the web.
    if(answered&&Date.now()-lastAudible>quiet&&Date.now()-lastText>quiet)finish('Risposta completata.');
  },100);
}
async function speak(text){
  const dir=await mkdtemp(path.join(tmpdir(),'robottino-parla-')),aiff=path.join(dir,'frase.aiff');
  const said=spawnSync('say',['-v','Alice','-o',aiff,text]);if(said.status!==0)throw Error('say non riuscito');
  const raw=spawnSync('ffmpeg',['-loglevel','error','-i',aiff,'-ac','1','-ar',String(inputRate),'-f','s16le','pipe:1'],{maxBuffer:50e6});
  if(raw.status!==0)throw Error('conversione audio non riuscita');
  log(`Tu (voce Alice): «${text}»`);stream(raw.stdout);
}
function listen(){
  log('Parla pure nel microfono del Mac. Ctrl+C per finire.');
  capture=spawn('ffmpeg',['-loglevel','error','-f','avfoundation','-i',':default','-ac','1','-ar',String(inputRate),'-f','s16le','pipe:1']);
  let pending=Buffer.alloc(0);const chunk=inputRate/10*2;
  capture.stdout.on('data',data=>{
    if(Date.now()<playingUntil+300)return; // no echo cancellation: mute while Robottino speaks, like the robot
    pending=Buffer.concat([pending,data]);
    while(pending.length>=chunk){if(socket.readyState===WebSocket.OPEN){sendAudio(pending.subarray(0,chunk));sentBytes+=chunk;}pending=pending.subarray(chunk);}
  });
  capture.on('exit',code=>{if(!finished&&code)finish('Microfono non disponibile: consenti l’accesso al Terminale in Impostazioni → Privacy → Microfono.');});
}
socket.on('unexpected-response',(_q,response)=>{finish(response.statusCode===401?'Accesso negato: token del robot non valido o server non aggiornato.':response.statusCode===429?'Limite di conversazioni raggiunto (6 al minuto, 100 al giorno).':`Collegamento rifiutato (${response.statusCode}).`);});
socket.on('error',error=>finish(`Errore di collegamento: ${error.message}`));
socket.on('close',(code,reason)=>finish(`Conversazione chiusa dal server (codice ${code}${reason?.length?', '+reason:''}; audio inviato: ${(sentBytes/2/(inputRate||16000)).toFixed(1)} s).`));
socket.on('open',()=>log(appRoute?`Collegato come l’app iPhone (${chosen}). Attendo il servizio vocale…`:'Collegato come il robot. Attendo il servizio vocale…'));
socket.on('message',(data,isBinary)=>{
  if(process.env.ROBOTTINO_DEBUG&&!isBinary){const t=JSON.parse(data.toString()).type;if(t!=='audio')log(`evento: ${t}${t==='memory.result'?'':''}`);}
  const event=!isBinary?parseVoiceEvent(data.toString(),decode):ima?(({pcm,mouth})=>({type:'audio',data:pcm,mouth}))(imaDecode(new Uint8Array(data))):(pcm=>({type:'audio',data:pcm,mouth:pcmMouthLevel(pcm)}))(ulawDecode(new Uint8Array(data).buffer));
  switch(event.type){
    case 'ready':
      provider=event.provider;inputRate=event.inputRate;outputRate=event.outputRate;
      log(`Servizio pronto: ${provider==='openai'?'OpenAI Live 1':'ElevenLabs'} (audio ${inputRate/1000} kHz).`);
      player=spawn('ffplay',['-loglevel','error','-nodisp','-autoexit','-f','s16le','-ar',String(outputRate),'-ac','1','-i','pipe:0']);
      player.stdin.on('error',()=>{});
      if(microphone)listen();else void speak(phrase).catch(error=>finish(error.message));
      return;
    case 'audio':{
      const pcm=Buffer.from(event.data);measure(isBinary?data:data.toString(),pcm.length);reply.push(pcm);player?.stdin.write(pcm);lastAudio=Date.now();if(event.mouth>0){lastAudible=Date.now();answered=true;}
      if(event.mouth>0)playingUntil=Math.max(playingUntil,Date.now())+pcm.length/2/outputRate*1000;return;
    }
    case 'interrupt':log('(interruzione)');return;
    case 'pong':socket.send(pongMessage(event.id));return;
    case 'user':case 'assistant':{
      if(event.type==='user'&&event.final!==false)log(`Riconosciuto: «${event.text}»`);
      // OpenAI streams words; ElevenLabs sends whole replies. Print one line per reply.
      if(event.type==='assistant'){said+=event.text;lastText=Date.now();answered=true;if(provider==='elevenlabs')flushSaid();}
      if(event.type==='user')flushSaid();
      const sentence=turns.apply(event);
      if(sentence){if(event.type!=='user')log(`Riconosciuto: «${sentence}»`);if(isMemoryPhrase(sentence))socket.send(memoryMessage(sentence));}
      return;
    }
    case 'memory':log(event.confirmation?'Ricordi: per cancellarli tutti usa l’app iPhone.':event.ok?'Ricordi: comando eseguito sul server.':'Ricordi: comando non riuscito.');return;
    case 'error':finish('Il servizio vocale ha segnalato un errore.');return;
  }
});
process.on('SIGINT',()=>{finish('Conversazione chiusa.');setTimeout(()=>process.exit(0),300);});
