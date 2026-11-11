// Hardware-independent conversation protocol shared by the MOD and Node tests.
// Events are the providers' own, relayed unchanged by /api/robot/voice.
import {pcmMouthLevel} from 'robottino-live-wire';

const rate=format=>{const match=/^pcm_(\d+)$/.exec(format??'pcm_16000');const value=match?Number(match[1]):NaN;return value>=8000&&value<=48000?value:null;};

export function parseVoiceEvent(text,decode){
  let value;try{value=JSON.parse(text);}catch{return {type:'error'};}
  if(!value||typeof value.type!=='string')return {type:'error'};
  switch(value.type){
    case 'session.started':return {type:'ready',provider:'openai',inputRate:24000,outputRate:24000};
    case 'conversation_initiation_metadata':{
      const meta=value.conversation_initiation_metadata_event??{},inputRate=rate(meta.user_input_audio_format),outputRate=rate(meta.agent_output_audio_format);
      return inputRate&&outputRate?{type:'ready',provider:'elevenlabs',inputRate,outputRate}:{type:'error'};
    }
    case 'session.output_audio.delta':return audio(value.delta,decode);
    case 'audio':return audio(value.audio_event?.audio_base_64,decode);
    case 'session.input_audio.speech_started':case 'interruption':return {type:'interrupt'};
    case 'session.input_transcript.delta':return typeof value.delta==='string'?{type:'user',text:value.delta,final:false}:{type:'ignore'};
    case 'user_transcript':{const text=value.user_transcription_event?.user_transcript;return typeof text==='string'?{type:'user',text,final:true}:{type:'ignore'};}
    case 'session.output_transcript.delta':return typeof value.delta==='string'?{type:'assistant',text:value.delta}:{type:'ignore'};
    case 'agent_response':{const text=value.agent_response_event?.agent_response;return typeof text==='string'?{type:'assistant',text}:{type:'ignore'};}
    case 'ping':return {type:'pong',id:Number(value.ping_event?.event_id)||0};
    case 'memory.result':return value.error==='invalid_command'?{type:'ignore'}:{type:'memory',ok:!value.error&&!value.result?.error,confirmation:typeof value.result?.confirmation==='string'};
    case 'error':case 'session.error':return {type:'error'};
    default:return {type:'ignore'};
  }
}
function audio(base64,decode){
  if(typeof base64!=='string'||!base64)return {type:'ignore'};
  let data;try{data=decode(base64);}catch{return {type:'ignore'};}
  return data instanceof ArrayBuffer&&data.byteLength>0&&data.byteLength%2===0?{type:'audio',data,mouth:pcmMouthLevel(data)}:{type:'ignore'};
}
export function audioMessage(provider,base64){
  return provider==='openai'?JSON.stringify({type:'session.input_audio.append',audio:base64}):JSON.stringify({user_audio_chunk:base64});
}
export function pongMessage(id){return JSON.stringify({type:'pong',event_id:id});}
// G.711 μ-law, 8 bits per sample, in binary frames (same tables as src/voice-stream.ts): the host's
// TCP window is only 5.7 KB, too narrow for base64 PCM in JSON at 44 KB/s per direction.
const ULAW=Int16Array.from({length:256},(_,i)=>{const u=~i&0xff,t=(((u&0x0f)<<3)+0x84)<<((u>>4)&7);return u&0x80?0x84-t:t-0x84;});
// Replies are quiet (ElevenLabs: peaks −7.7 dBFS, speech −26 dBFS) for the robot's small speaker:
// +6 dB, baked into the decode table so it costs nothing at play time. +12 dB gave silence on the
// K151 (9 Nov 2026), probably the amplifier (no boost) protecting itself; +6 dB puts speech at the
// level of the laugh, which plays fine. Linear up to half scale, then a soft knee keeps the peaks
// below full scale: a plain tanh bent the whole voice (3.5% distortion on an ElevenLabs reply, 0.2% now).
// No longer used by the call (9 Nov 2026, evening): with +6 dB the amplifier crackled.
export const REPLY_GAIN=2;
const KNEE=0.5;
const louder=v=>{const a=Math.abs(v)*REPLY_GAIN/32767,y=a<=KNEE?a:KNEE+(1-KNEE)*Math.tanh((a-KNEE)/(1-KNEE));return v<0?-Math.round(32767*y):Math.round(32767*y);};
export const ULAW_LOUD=Int16Array.from(ULAW,louder);
export function ulawDecode(law,table=ULAW){const bytes=new Uint8Array(law),out=new Int16Array(bytes.length);for(let i=0;i<bytes.length;i++)out[i]=table[bytes[i]];return out.buffer;}
// The robot's JavaScript is slow per sample (9 Nov 2026: three calls per sample made the microphone fall
// behind): the exponent comes from a table on the top bits instead of Math.clz32, samples are read from
// an Int16Array (both ends are little-endian) instead of a DataView, and there is no Math.min.
const ULAW_EXP=Uint8Array.from({length:256},(_,i)=>i<2?0:31-Math.clz32(i));
export function ulawEncode(pcm){
  const bytes=ArrayBuffer.isView(pcm)?pcm:new Uint8Array(pcm),count=bytes.byteLength>>1,out=new Uint8Array(count);
  const samples=bytes.byteOffset%2===0?new Int16Array(bytes.buffer,bytes.byteOffset,count):new Int16Array(new Uint8Array(bytes.buffer,bytes.byteOffset,count*2).slice().buffer);
  for(let i=0;i<count;i++){
    let sample=samples[i],sign=0;if(sample<0){sign=0x80;sample=-sample;}
    if(sample>32635)sample=32635;sample+=0x84;const exponent=ULAW_EXP[sample>>7];
    out[i]=~(sign|(exponent<<4)|((sample>>(exponent+3))&0x0f))&0xff;
  }
  return out;
}
// Robot barge-in: the Worker drops the part of the reply it is still holding back.
// Mouth while the robot speaks (9 Nov 2026): the rule of the iPhone app and of the Worker (src/robot-audio.ts
// MouthTrack). Openness (RMS − 500) / 2100, smoothed: about 45 ms to open, 90 ms to close. Returns the
// mouth pose, index of portrait-state.js MOUTH_POSES (0 closed … 4 talk-open).
export class MouthTrack {
  constructor(){this.value=0;}
  pose(rms,seconds){
    const target=Math.min(1,Math.max(0,(rms-500)/2100));
    this.value+=(target-this.value)*(1-Math.exp(-(target>this.value?22:11)*seconds));
    if(Math.abs(this.value-target)<.002)this.value=target;
    const v=this.value;return v<.09?0:v<.265?1:v<.465?2:v<.69?3:4;
  }
}
export function clearPlaybackMessage(){return JSON.stringify({type:'playback.clear'});}
export function memoryMessage(text){return JSON.stringify({type:'memory.command',text});}
// Loose filter: anything about memories goes to the server, which parses it strictly.
// "Dimentica tutto" needs an on-screen confirmation: the robot points to the iPhone app.
export function isMemoryPhrase(text){
  const value=String(text).toLowerCase();
  return ['ricord','memorizz','tieni a mente','dimentic','scord','segnat','cosa sai di me'].some(word=>value.includes(word));
}

/** Returns a finished user sentence when a turn ends (OpenAI: when Robottino answers). */
export class VoiceTurns {
  constructor(){this.pending='';}
  apply(event){
    if(event.type==='user'){if(event.final){this.pending='';return event.text;}this.pending+=event.text;return null;}
    if(event.type==='assistant'){const done=this.pending;this.pending='';return done||null;}
    return null;
  }
}

/**
 * The head sensor read straight from the host's last sample (Si12T, three zones at 0…3, every 50 ms), next to the
 * host's own gestures (10 Nov 2026: «tenendo il dito sul sensore superiore non parte la chiamata», and a tap no
 * longer laughed; no head gesture at all reached the MOD, while at 21:14 a 2.3 s press had started a conversation).
 * The host's recognizer gives a press when a zone leaves 0 and nothing more until every zone is back at 0: a zone
 * that stays above 0 (sensor reference off) silences it for good. So:
 * - every change of the three zones is reported (`changed`), for the diagnostics;
 * - a zone above 0 for `stuckMs` without a break makes the reading «stuck»: the levels at that moment become the
 *   floor, and a finger is a rise above that floor. A rise of up to `tapMs` is a tap; one held from `holdMs` to
 *   `maxHoldMs` is a long press, given on release (a level that rises and stays, as a stuck one does, never
 *   starts a conversation); a rise that lasts `stuckMs` becomes the new floor. All zones at 0 end the stuck state
 *   and the host's gestures work again.
 */
export class HeadSensorWatch {
  constructor({holdMs=900,tapMs=300,stuckMs=8000,maxHoldMs=6000}={}){
    Object.assign(this,{holdMs,tapMs,stuckMs,maxHoldMs});
    this.key=undefined;this.touchedSince=undefined;this.floor=undefined;this.riseAt=undefined;
  }
  get stuck(){return !!this.floor;}
  /** A swipe from the host (petting) is not a press. */
  cancel(){this.riseAt=undefined;}
  update(sample,now){
    const levels=[0,1,2].map(i=>{const v=sample?.[i];return Number.isFinite(v)?Math.max(0,Math.min(3,Math.trunc(v))):0;});
    const key=levels.join(','),result={changed:key!==this.key,levels};this.key=key;
    if(!Number.isFinite(now))return result;
    if(Math.max(...levels)===0){
      this.touchedSince=undefined;this.riseAt=undefined;
      if(this.floor){this.floor=undefined;result.stuck='end';}
      return result;
    }
    if(this.touchedSince===undefined)this.touchedSince=now;
    if(!this.floor){
      if(now-this.touchedSince>=this.stuckMs){this.floor=levels;this.riseAt=undefined;result.stuck='start';}
      return result;
    }
    this.floor=this.floor.map((v,i)=>Math.min(v,levels[i]));
    const rise=Math.max(...levels.map((v,i)=>v-this.floor[i]));
    if(rise>=1){
      if(this.riseAt===undefined)this.riseAt=now;
      else if(now-this.riseAt>=this.stuckMs){this.floor=levels;this.riseAt=undefined;result.stuck='start';}
      return result;
    }
    if(this.riseAt!==undefined){
      const held=now-this.riseAt;this.riseAt=undefined;
      if(held<=this.tapMs)result.gesture='tap';
      else if(held>=this.holdMs&&held<=this.maxHoldMs)result.gesture='long';
    }
    return result;
  }
}

/** Long press on the head: press, no swipe, held for at least `holdMs`. */
export class LongPress {
  // tapMs: a pat with the hand is slower than a fingertip tap (10 Nov 2026: touches of 0.37 s and 0.75 s were felt
  // and did nothing; the host calls a tap only up to 0.3 s). Whatever is released before the long press is a tap:
  // no gap in between where a touch does nothing.
  constructor(holdMs=900,tapMs=holdMs){this.holdMs=holdMs;this.tapMs=tapMs;this.started=undefined;this.fired=false;}
  touch(event,now){
    if(event?.gesture==='press'){this.started=now;this.fired=false;return null;}
    if(event?.gesture==='forwardSwipe'||event?.gesture==='backwardSwipe'){this.started=undefined;return 'swipe';}
    if(event?.gesture==='release'){
      const short=this.started!==undefined&&!this.fired&&(event.tap!==undefined||(Number.isFinite(now)&&now-this.started<=this.tapMs));
      this.started=undefined;const fired=this.fired;this.fired=false;
      return fired?null:short?'tap':null;
    }
    return null;
  }
  tick(now){
    if(this.started===undefined||this.fired||!Number.isFinite(now)||now-this.started<this.holdMs)return false;
    this.fired=true;return true;
  }
}

/** RMS of little-endian PCM16 bytes. */
export function pcmLevel(bytes){
  let energy=0;const count=bytes.byteLength>>1;if(!count)return 0;
  for(let i=0;i+1<bytes.byteLength;i+=2){let sample=bytes[i]|bytes[i+1]<<8;if(sample&0x8000)sample-=65536;energy+=sample*sample;}
  return Math.sqrt(energy/count);
}
/** Interrupting by voice without echo cancellation: speech much louder than the robot's own echo, held for `holdMs`. */
export class BargeIn {
  constructor(level=6000,holdMs=300){this.level=level;this.holdMs=holdMs;this.loud=0;}
  feed(rms,ms){if(!(this.level>0)||!(rms>=this.level)){this.loud=0;return false;}this.loud+=ms;if(this.loud<this.holdMs)return false;this.loud=0;return true;}
  reset(){this.loud=0;}
}

// Robottino's mood from the words of its reply: face and a small head gesture, no extra AI calls.
// The smiling face only when Robottino actually laughs, not for any cheerful word.
const LAUGHTER=/a?h(?:ah)+|ah ?ah|eh(?:eh)+|ih(?:ih)+|hi(?:hi)+|che ridere|mi fai ridere|rido(?![a-zàèéìíòóùú])|risat/u;
export function replyMood(text){
  const value=String(text).toLowerCase().trim();
  if(!value)return null;
  const gesture=/^(?:sì|si|certo|certamente|esatto|giusto|va bene|ok|okay|perfetto|d'accordo|d’accordo|volentieri)(?![a-zàèéìíòóùú])/u.test(value)?'nod':/^(?:no|nah|non credo|assolutamente no)(?![a-zàèéìíòóùú])/u.test(value)?'shake':/\?\s*$/.test(value)?'tilt':null;
  // The face follows only the sentence being spoken: "mi dispiace" makes it sad until the next
  // sentence starts, not for the rest of the reply. The gesture keeps looking at the start.
  const cut=value.search(/[.!?…]\s+(?=\S)[^.!?…]*$/u),sentence=cut<0?value:value.slice(cut).replace(/^[.!?…]\s+/u,'');
  const expression=/mi dispiace|purtroppo|peccato|triste|scusami|scusa(?![a-zàèéìíòóùú])|non posso|non riesco/u.test(sentence)?'sad':LAUGHTER.test(sentence)?'happy':'neutral';
  return {expression,gesture};
}
// Absolute degrees (±10° limits of the dance validator).
// Pitch in degrees with the upstream convention (negative looks up). On the K151 straight ahead is
// near the lower stop, so a nod lifts the chin and comes back instead of dipping.
export const GESTURES={
  nod:[{yaw:0,pitch:-6,durationMs:300},{yaw:0,pitch:-1,durationMs:300},{yaw:0,pitch:-4,durationMs:300},{yaw:0,pitch:0,durationMs:300}],
  shake:[{yaw:7,pitch:0,durationMs:300},{yaw:-7,pitch:0,durationMs:300},{yaw:5,pitch:0,durationMs:300},{yaw:0,pitch:0,durationMs:300}],
  tilt:[{yaw:6,pitch:-4,durationMs:900},{yaw:0,pitch:0,durationMs:400}]
};

// Spoken head commands (owner, 11 Nov 2026): «muovi la testa», «guarda a destra», «muoviti a sinistra», «alza la
// testa», «guarda in basso», «guarda avanti». Right and left are the user's, facing the robot (mod.js voiceLook).
// Only a short sentence with a movement verb counts, and never a negated one («non guardare a destra»).
function headCommandIt(text){
  const value=String(text).toLowerCase().replace(/[’`]/g,"'").replace(/^(?:ehi|ciao|ok|senti)?\s*robottino[\s,:!]*/u,'').replace(/[.!?,]+/gu,' ').replace(/\s+/gu,' ').trim();
  if(!value||value.split(' ').length>8||/(?:^|\s)non\s/u.test(value))return null;
  // The four words are enough on their own, in a short sentence (owner, 11 Nov 2026: «riconoscere solo le parole
  // destra, sinistra, alto, basso»); «tutto a destra», «tutto in alto»… go to the end of the calibrated range.
  const full=/\btutt[oa]\b/u.test(value)?{full:true}:{};
  if(/^(?:alza(?:re)?|solleva) (?:la )?testa\b/u.test(value))return {direction:'up',...full};
  if(/^(?:abbassa(?:re)?) (?:la )?testa\b/u.test(value))return {direction:'down',...full};
  // The first direction said wins (11 Nov 2026: «sinistra» came as «Sinis-- destra.»), and a word cut short counts
  // («sinis…», «destr…»). In a very short sentence also what the recognizer makes of «sinistra» («finestra») and of
  // «su» («sù», «insù»).
  const short=value.split(' ').length<=3;
  const words=[[/\bdestr\w*/u,'right'],[/\bsinis\w*/u,'left'],[/\balto\b/u,'up'],[/\bbasso\b/u,'down']];
  if(short)words.push([/\bfinestr[ae]\b/u,'left'],[/(?:^|\s)(?:in ?sù|sù)(?=\s|$)/u,'up']);
  // «Su.» alone also comes as «Tu.» (11 Nov 2026).
  if(value==='tu')words.push([/^/u,'up']);
  // A single word ending in «-tra» is «sinistra» cut short (11 Nov 2026: «Tra.»), never «destra» (already above).
  if(value.split(' ').length===1&&/^(?:si|ni|i)?(?:nis|ni|s)?tra$|^(?:si)?nistr[ao]$/u.test(value))words.push([/^/u,'left']);
  let first;
  for(const [pattern,direction] of words){const at=value.search(pattern);if(at>=0&&(!first||at<first.at))first={at,direction};}
  if(first)return {direction:first.direction,...full};
  // Other ways of saying it need a movement verb, or to be said alone («più su», «avanti»).
  const alone=/^(?:(?:ancora|più|piu|un po'|un poco|e|tutto|tutta)\s+)*(?:in su|su|in giù|giù|giu|avanti|dritto|al centro)(?:\s+(?:ancora|di più|di piu|un po'))*$/u.test(value);
  if(!alone&&!/\b(?:guarda(?:re)?|gira(?:re|ti)?|volta(?:re|ti)?|muovi(?:ti)?|sposta(?:re|ti)?)\b/u.test(value))return null;
  if(/\b(?:in su|su|verso l'alto|sopra)\b/u.test(value))return {direction:'up',...full};
  if(/(?:\bin giù|\bgiù|\bgiu\b|\bsotto\b)/u.test(value))return {direction:'down',...full};
  if(/\b(?:avanti|dritto|diritto|davanti|al centro|in centro|verso di me|me)\b/u.test(value))return {direction:'center'};
  if(/^muovi (?:la )?testa$/u.test(value))return {direction:'shake'};
  return null;
}

// What Robottino says it did with its head (11 Nov 2026: the recognizer wrote «sinistra» as «Tra.», the model understood
// and answered «Ecco, ho girato la testa a sinistra», and the head did not move). Used only when the user's sentence
// gave no command of its own (voice-device.js), at most once per turn, never when it says it did not or cannot.
function replyHeadCommandIt(text){
  const value=String(text).toLowerCase().replace(/[’`]/g,"'").replace(/\s+/gu,' ');
  if(/\bnon\b/u.test(value))return null;
  const side=/\b(?:girat[oa]|giro|girata|guardo|guardato|spostat[oa]|sposto|voltat[oa]|volto) (?:(?:la|di|con la) testa )?(?:(?:tutt[oa]|ancora|un po') )?(?:a|verso) (destra|sinistra)\b/u.exec(value);
  if(side)return {direction:side[1]==='destra'?'right':'left'};
  if(/\b(?:alzat[oa]|alzo|sollevat[oa]|sollevo) (?:la testa|lo sguardo)\b|\bguard(?:o|ato) (?:in alto|in su|in sù|su|sù)\b/u.test(value))return {direction:'up'};
  if(/\b(?:abbassat[oa]|abbasso) (?:la testa|lo sguardo)\b|\bguard(?:o|ato) (?:in basso|in giù|giù)\b/u.test(value))return {direction:'down'};
  return null;
}

// «Cos'è questo?» (owner, 11 Nov 2026): the robot takes one picture with its camera and the server says what it shows
// (src/robot-vision.ts). Short questions only, about what is in front of the robot.
function seeCommandIt(text){
  const value=String(text).toLowerCase().replace(/[’`]/g,"'").replace(/^(?:ehi|ciao|ok|senti)?\s*robottino[\s,:!]*/u,'').replace(/[.!?,]+/gu,' ').replace(/\s+/gu,' ').trim();
  if(!value||value.split(' ').length>8)return false;
  // The recognizer often keeps only the end of the question (11 Nov 2026: «Cos'è questo?» came as «Questo?»).
  if(/^(?:e |ma )?(?:quest[oa]|quell[oa])(?: qui| qua)?$/u.test(value))return true;
  // «Questo cos'è?», «E questo che cos'è?», «Cos'è?» (owner, 11 Nov 2026): the same question the other way round.
  if(/^(?:e |ma |allora |dimmi )?(?:(?:quest[oa]|quell[oa])(?: qui| qua| oggetto)? )?(?:che )?cos(?:'| |a |a )?(?:è|e')$/u.test(value))return true;
  return /(?:^|\s)(?:che )?cos(?:'| |a |a )?(?:è|e') (?:quest|quell|che ho|che tengo)|(?:^|\s)(?:che )?cosa (?:vedi|ho in mano|tengo in mano|ti (?:sto )?mostr|ti faccio vedere|c'è qui)|(?:^|\s)che oggetto (?:è|vedi)|(?:^|\s)(?:guarda|riconosci|vedi) (?:cosa ho|che cosa ho|quest[oa] oggett|quest[oa]$|cos'è)|(?:^|\s)dimmi (?:che )?cos(?:'| |a )?(?:è|e')(?: quest[oa])?$|(?:^|\s)sai (?:che )?cos(?:'| |a )?(?:è|e') quest/u.test(value);
}
// Robottino says it is about to look («Fammi vedere…», the server's SEE_RULE) although the user's words gave no
// command here (the question was written badly by the recognizer): the robot takes the picture all the same.
const replySeeIt=text=>/\bfammi (?:vedere|guardare|dare un'occhiata)\b|\b(?:guardo|controllo) subito\b|\bdo un'occhiata\b/u.test(String(text).toLowerCase().replace(/[’`]/g,"'"));

// Spoken face commands (owner, 11 Nov 2026): «sorridi», «fai la faccia triste», «fai la faccia arrabbiata». The face
// changes; the smile goes back to normal after 5 s, the sad and angry faces stay until told (mod.js). Short sentences only.
function faceCommandIt(text){
  const value=String(text).toLowerCase().replace(/[’`]/g,"'").replace(/^(?:ehi|ciao|ok|senti)?\s*robottino[\s,:!]*/u,'').replace(/[.!?,]+/gu,' ').replace(/\s+/gu,' ').trim();
  if(!value||value.split(' ').length>8)return null;
  // Back to normal (owner, 11 Nov 2026: the sad or angry face stays «finché non gli dico di tornare felice»): «torna
  // felice» smiles and then is serene; «torna normale», «basta», «non essere più triste» go straight to serene.
  if(/\b(?:torna(?:re)? (?:a essere |ad essere )?(?:felice|contenta|contento|allegra|allegro|a sorridere)|di nuovo (?:felice|contenta|allegra))\b/u.test(value))return {expression:'happy'};
  if(/\b(?:torna(?:re)? (?:normale|serena|sereno|tranquilla|tranquillo|calma|calmo|come prima)|faccia (?:normale|serena)|calmati|non (?:essere|fare) (?:più |piu )?(?:(?:la |il )?(?:faccia )?)?(?:triste|a?rr?abb?iat[oa])|basta (?:essere |fare )?(?:(?:la |il )?(?:faccia )?)?(?:triste|a?rr?abb?iat[oa]|cos[iì]))\b/u.test(value))return {expression:'normal'};
  if(/(?:^|\s)non\s/u.test(value))return null;
  if(/\b(?:sorridi|sorridimi|sorridere|fai un sorriso|fammi un sorriso|faccia (?:felice|contenta|sorridente|allegra)|sii (?:felice|contento|contenta))\b/u.test(value))return {expression:'happy'};
  if(/\b(?:faccia (?:triste|dispiaciuta)|sii triste|fai (?:il|la) triste)\b/u.test(value))return {expression:'sad'};
  // The recognizer also writes «arrabiata» or drops the first syllable («Rabbiata.», 11 Nov 2026).
  if(/\b(?:faccia (?:a?rr?abb?iat[oa]|cattiva)|arr?abb?iati|sii a?rr?abb?iat[oa])\b/u.test(value))return {expression:'angry'};
  // In a very short sentence the feeling alone is enough (11 Nov 2026: «Fai la faccia triste» came as «C'è triste.»).
  if(value.split(' ').length<=3){if(/\btrist[ei]\b/u.test(value))return {expression:'sad'};if(/\b(?:a?rr?abb?iat[oaie]|rabbia)\b/u.test(value))return {expression:'angry'};}
  return null;
}

const NUMBERS={un:1,uno:1,una:1,due:2,tre:3,quattro:4,cinque:5,sei:6,sette:7,otto:8,nove:9,dieci:10,undici:11,dodici:12,tredici:13,quattordici:14,quindici:15,sedici:16,diciassette:17,diciotto:18,diciannove:19,venti:20,venticinque:25,trenta:30,quaranta:40,quarantacinque:45,cinquanta:50,sessanta:60,novanta:90};
/** Spoken timers: "avvisami tra 10 minuti", "timer di 5 minuti", "ricordami tra mezz'ora di …", "pomodoro", "annulla il timer", "quanto manca?". */
export function timerCommand(text){
  const value=String(text).toLowerCase().replace(/[’`]/g,"'").replace(/^(?:ehi|ciao|ok|senti)?\s*robottino[\s,:!]*/u,'').replace(/[.!?]+$/u,'').trim();
  if(/\b(?:annulla|ferma|cancella|togli|elimina|stop)\b.*\b(?:timer|pomodoro|promemoria|sveglia|avvis)/u.test(value))return {action:'cancel'};
  if(/\bquanto manca\b/u.test(value)&&!/\b(?:a|al|alla|per)\s+(?:natale|capodanno)\b/u.test(value))return {action:'status'};
  if(/\b(?:avvia|fai|facciamo|inizia|parti con|metti)\b.*\bpomodoro\b|^pomodoro$|\bmetodo pomodoro\b/u.test(value))return {action:'pomodoro'};
  if(!/\b(?:timer|avvisami|ricordami|svegliami|sveglia|chiamami|dimmi quando|fammi sapere)\b/u.test(value))return null;
  let seconds=0,found=false;
  if(/\bmezz'?\s?ora\b/u.test(value)){seconds+=1800;found=true;}
  if(/\bun quarto d'?\s?ora\b/u.test(value)){seconds+=900;found=true;}
  if(/\bun'?\s?ora e mezza\b/u.test(value)){seconds+=1800;found=true;}
  for(const match of value.matchAll(/(\d+(?:[.,]\d+)?|[a-z]+)\s*(secondi|secondo|minuti|minuto|ore|ora)\b/gu)){
    const raw=match[1],amount=/^\d/.test(raw)?Number(raw.replace(',','.')):NUMBERS[raw];
    if(!Number.isFinite(amount))continue;
    found=true;seconds+=amount*(match[2].startsWith('second')?1:match[2].startsWith('minut')?60:3600);
  }
  if(/\bun'?\s?ora\b/u.test(value)&&!/\d+\s*or[ea]\b/u.test(value)&&!/\b(?:mezz'?\s?ora|quarto d'?\s?ora)\b/u.test(value.replace(/\bun'?\s?ora e mezza\b/u,''))){seconds+=3600;found=true;}
  if(!found)return null;
  seconds=Math.round(seconds);
  if(seconds<10||seconds>6*3600)return {action:'invalid'};
  const label=/\b(?:di|per|che)\s+(?!\d)(.{3,60})$/u.exec(value.replace(/\b(?:tra|fra|in|di|per)\s+(?:\d+(?:[.,]\d+)?|[a-z']+)\s*(?:secondi|secondo|minuti|minuto|ore|ora)\b/gu,'').replace(/\b(?:tra|fra)\s+(?:mezz'?\s?ora|un quarto d'?\s?ora|un'?\s?ora(?: e mezza)?)\b/gu,'').trim())?.[1]?.trim();
  return {action:'set',seconds,label:label&&!/^(?:timer|minuti|secondi)$/.test(label)?label:''};
}

// The same commands in English (owner, 11 Nov 2026: «tutti i comandi… devono funzionare sia in italiano che in
// inglese»). Italian is tried first; English words that are everyday words too («right», «up», «down») count only in
// a very short sentence or next to a movement verb, never inside the usual sayings («all right», «what's up»,
// «calm down»), and never negated.
const english=text=>String(text).toLowerCase().replace(/[’`]/g,"'").replace(/^(?:hey|hi|ok|okay)?\s*robottino[\s,:!]*/u,'').replace(/[.!?,]+/gu,' ').replace(/\s+/gu,' ').trim();
const EN_NOT=/\b(?:don't|do not|dont|never|not)\b/u;
function headCommandEn(text){
  const value=english(text),count=value?value.split(' ').length:0;
  if(!count||count>8||EN_NOT.test(value))return null;
  const full=/\b(?:all the way|fully|completely|as far as (?:you can|it goes))\b/u.test(value)?{full:true}:{};
  if(/\b(?:raise|lift) (?:your |the )?head\b/u.test(value))return {direction:'up',...full};
  if(/\blower (?:your |the )?head\b/u.test(value))return {direction:'down',...full};
  if(/^(?:shake|move) (?:your |the )?head$/u.test(value))return {direction:'shake'};
  if(/\b(?:all right|alright|that's right|you're right|you are right|right now|right away|what's up|what is up|up to|shut down|sit down|calm down|slow down|write down|let down|left (?:me|you|him|her|us|them|it|the|my|a)\b)/u.test(value))return null;
  if(/^(?:straight ahead|straight|ahead|forward|cent(?:er|re)|middle|back to (?:the )?cent(?:er|re))$/u.test(value))return {direction:'center'};
  const verb=/\b(?:look|turn|move|go|face|tilt|head|rotate|point)\b/u.test(value);
  const bare=value.replace(/\b(?:all the way|fully|completely|please|a bit|a little|more|to the|the|to|and|now)\b/gu,' ').replace(/\s+/gu,' ').trim();
  if(!verb&&bare.split(' ').length>1)return null;
  let first;
  for(const [pattern,direction] of [[/\bright\b/u,'right'],[/\bleft\b/u,'left'],[/\b(?:up|upwards?)\b/u,'up'],[/\b(?:down|downwards?)\b/u,'down']]){const at=value.search(pattern);if(at>=0&&(!first||at<first.at))first={at,direction};}
  if(first)return {direction:first.direction,...full};
  if(/\b(?:ahead|straight|forward|cent(?:er|re)|middle|at me)\b/u.test(value))return {direction:'center'};
  return null;
}
function faceCommandEn(text){
  const value=english(text),count=value?value.split(' ').length:0;
  if(!count||count>8)return null;
  if(/\b(?:(?:be|get|go|back to|back to being) happy(?: again)?|happy again|smile again|cheer up)\b/u.test(value)&&/\b(?:again|back|cheer up)\b/u.test(value))return {expression:'happy'};
  if(/\b(?:back to normal|normal face|normal again|calm down|relax|(?:stop|quit) (?:being |looking )?(?:sad|angry|mad)|(?:don't|do not) (?:be|look) (?:so )?(?:sad|angry|mad)(?: any ?more)?|no more (?:sad|angry) face|enough)\b/u.test(value))return {expression:'normal'};
  if(EN_NOT.test(value))return null;
  if(/\b(?:smile|give me a smile|happy face|be happy|look happy)\b/u.test(value))return {expression:'happy'};
  if(/\b(?:sad face|be sad|look sad|make a sad)\b/u.test(value))return {expression:'sad'};
  if(/\b(?:(?:angry|mad|grumpy) face|be angry|get angry|get mad|look angry|make an angry)\b/u.test(value))return {expression:'angry'};
  if(count<=3){if(/\bsad\b/u.test(value))return {expression:'sad'};if(/\b(?:angry|mad)\b/u.test(value))return {expression:'angry'};}
  return null;
}
function seeCommandEn(text){
  const value=english(text),count=value?value.split(' ').length:0;
  if(!count||count>8)return false;
  if(/^(?:and |but )?(?:this|that|this one|that one|these|those)$/u.test(value))return true;
  return /(?:^|\s)what(?:'s| is| are| s)? (?:this|that|these|those|it)(?: thing| object)?$|(?:^|\s)what(?:'s| is| are) (?:this|that|these|those) (?:thing|object|here)|(?:^|\s)what (?:do|can) you see|(?:^|\s)what(?:'s| is) in my hand|(?:^|\s)what am i (?:holding|showing)|(?:^|\s)what (?:object|thing) is (?:this|that)|(?:^|\s)(?:tell me|do you know|can you tell me) what (?:this|that|it) is$|(?:^|\s)(?:look at|can you see|do you see|recogni[sz]e) (?:this|that|these|what i)/u.test(value);
}
function replyHeadCommandEn(text){
  const value=String(text).toLowerCase().replace(/[’`]/g,"'").replace(/\s+/gu,' ');
  if(/\b(?:can't|cannot|can not|couldn't|not|unable)\b/u.test(value))return null;
  const side=/\b(?:turned|turning|looking|looked|moved|moving) (?:my head )?(?:all the way )?(?:to (?:the|my) )?(right|left)\b/u.exec(value);
  if(side)return {direction:side[1]};
  if(/\b(?:raised|lifted|raising|lifting) my head\b|\blook(?:ing|ed) up\b/u.test(value))return {direction:'up'};
  if(/\b(?:lowered|lowering) my head\b|\blook(?:ing|ed) down\b/u.test(value))return {direction:'down'};
  return null;
}
export const headCommand=text=>headCommandIt(text)??headCommandEn(text);
export const faceCommand=text=>faceCommandIt(text)??faceCommandEn(text);
export const seeCommand=text=>seeCommandIt(text)||seeCommandEn(text);
export const replyHeadCommand=text=>replyHeadCommandIt(text)??replyHeadCommandEn(text);
// «Let me check…» is not among them: the agent says it for anything («Let me check the connection», 11 Nov 2026).
export const replySee=text=>replySeeIt(text)||/\blet me (?:see|look|take a look|have a look)\b|\bi'll take a look\b/u.test(String(text).toLowerCase().replace(/[’`]/g,"'"));
