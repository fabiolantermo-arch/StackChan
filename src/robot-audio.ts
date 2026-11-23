// Robot audio for ?audio=ima (9 Nov 2026). The robot's JavaScript is too slow for per-sample work:
// decoding μ-law and measuring the mouth for every sample kept it so busy that the speaker went
// unserved and the voice stuttered. Its native speaker driver (the one that plays the laugh) decodes
// IMA ADPCM by itself, from its own task. So the Worker sends IMA ADPCM, with the mouth levels already
// measured, and the robot only copies bytes. Half the data of μ-law, too: about 8.4 KB/s at 16 kHz.

// Moddable's IMA chunk (modules/pins/i2s/dvi_adpcm_decode.c): int16 first sample, uint8 step index,
// one spare byte, then 128 samples as 4-bit codes, low nibble first. 68 bytes for 129 samples.
export const IMA={chunkBytes:68,chunkSamples:129,frameChunks:24,mouthChunks:4};
// One frame: 24 chunks (3096 samples, about 194 ms at 16 kHz), one mouth pose every 4 chunks (about 32 ms).
// Layout: [1 = IMA][mouth count][one mouth pose each, index of MOUTH_POSES][chunks].
export const FRAME_IMA=1;
const INDEX=[-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8];
const STEPS=[7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,
  130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,
  1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,
  11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];

// The step index carries over from chunk to chunk; each chunk starts from its exact first sample.
export class ImaEncoder{
  index=0;
  chunk(samples:Int16Array,out:Uint8Array,at:number){
    let valpred=samples[0],index=this.index,step=STEPS[index];
    out[at]=valpred&0xff;out[at+1]=(valpred>>8)&0xff;out[at+2]=index;out[at+3]=0;
    for(let i=1;i<IMA.chunkSamples;i++){
      // Same arithmetic as the decoder (shifts only), so both follow the same prediction.
      let diff=(samples[i]??0)-valpred,code=0;
      if(diff<0){code=8;diff=-diff;}
      let s=step,vpdiff=step>>3;
      if(diff>=s){code|=4;diff-=s;vpdiff+=s;}
      s>>=1;if(diff>=s){code|=2;diff-=s;vpdiff+=s;}
      s>>=1;if(diff>=s){code|=1;vpdiff+=s;}
      valpred+=code&8?-vpdiff:vpdiff;
      if(valpred>32767)valpred=32767;else if(valpred<-32768)valpred=-32768;
      index+=INDEX[code];if(index<0)index=0;else if(index>88)index=88;step=STEPS[index];
      const byte=at+4+((i-1)>>1);
      if((i-1)&1)out[byte]|=code<<4;else out[byte]=code;
    }
    this.index=index;
  }
}
// Mouth (9 Nov 2026): the same rule as the iPhone app, so both mouths move alike. Openness from the loudness,
// (RMS − 500) / 2100 (RobotVoiceProtocol.mouthOpenness), smoothed like RobotMouthSmoother (about 45 ms to
// open, 90 ms to close), then the nearest of the robot's mouth poses (portrait-state.js MOUTH_POSES): 0 closed,
// then openness .18, .35 (the talk-small picture), .58 and .8 (talk-open).
export const MOUTH_POSES=[0,.18,.35,.58,.8];
export class MouthTrack{
  value=0;
  pose(samples:Int16Array,seconds:number):number{
    let energy=0;for(let i=0;i<samples.length;i++)energy+=samples[i]*samples[i];
    const rms=samples.length?Math.sqrt(energy/samples.length):0,target=Math.min(1,Math.max(0,(rms-500)/2100));
    this.value+=(target-this.value)*(1-Math.exp(-(target>this.value?22:11)*seconds));
    if(Math.abs(this.value-target)<.002)this.value=target;
    const v=this.value;return v<.09?0:v<.265?1:v<.465?2:v<.69?3:4;
  }
}
// Shapes of the lips (owner, 16 Nov 2026: «nuove espressioni per migliorare movimenti labbra»; «ElevenLabs manda
// anche le lettere e i loro tempi… così scelgo la forma della bocca per ogni lettera»). The loudness alone opens and
// closes the mouth, the same for every sound. ElevenLabs sends, with every piece of audio, the letters said in it
// and when (audio_event.alignment: chars, char_start_times_ms, char_durations_ms). So for a robot that asks for it
// (&lips=1: one that has the pictures) each mouth pose also carries the shape of the letter said at that moment:
//   1 lips pressed (m, b, p), 2 round (o), 3 narrow and forward (u), 4 wide with the teeth (e, i),
//   5 teeth on the lower lip (f, v); 0 none: «a» and silence keep the mouth that follows the loudness.
// The pose byte is then: loudness pose (0…4) + 16 × shape. A robot that does not ask gets the poses as before.
// The times are not exact (measured on 16 Nov 2026: about 80 ms for a syllable, shared evenly among its letters, and
// the letters of a piece can run up to a tenth of a second past its audio), so the letter only chooses the shape and
// the loudness still says when the mouth is open: a vowel's shape shows only while there is sound; the other
// consonants take the shape of the vowel beside them. Pressed lips and teeth on the lip show whenever their
// letter is said: they are the closings of the mouth that the loudness never showed.
export const LIPS={none:0,pressed:1,round:2,narrow:3,wide:4,teeth:5} as const;
export const LIP_TRACK={driftMs:250,keepMs:1000,maxChars:600,maxMarks:2400,nearChars:3};
const LIP_LETTERS:Record<string,number>={m:1,b:1,p:1,o:2,ò:2,ó:2,u:3,ù:3,ú:3,e:4,è:4,é:4,i:4,ì:4,í:4,f:5,v:5,a:0,à:0,á:0};
const VOWEL=/^[aeiouàáèéìíòóùú]$/,LETTER=/^\p{L}$/u;
type LipMark={from:number;to:number;shape:number;vowel:boolean;letter:boolean};
export class LipTrack{
  private marks:LipMark[]=[];private audio=0;private text=0;
  // One piece of the provider's audio (ms long) and its alignment, if any. The letters go on a clock of their own
  // (each piece's letters after the last piece's), which is set back on the audio's clock when the two drift apart.
  add(ms:number,alignment?:unknown){
    const a=alignment as {chars?:unknown;char_start_times_ms?:unknown;char_durations_ms?:unknown}|null|undefined;
    const chars=a?.chars,starts=a?.char_start_times_ms,lasts=a?.char_durations_ms;
    if(Array.isArray(chars)&&Array.isArray(starts)&&Array.isArray(lasts)&&chars.length&&chars.length<=LIP_TRACK.maxChars&&starts.length===chars.length&&lasts.length===chars.length){
      const base=Math.abs(this.text-this.audio)>LIP_TRACK.driftMs?this.audio:this.text;let end=base;
      for(let i=0;i<chars.length;i++){
        const start=Number(starts[i]),last=Number(lasts[i]),char=typeof chars[i]==='string'?(chars[i] as string).toLowerCase():'';
        if(!(start>=0&&start<=60000&&last>=0&&last<=10000))continue;
        const from=base+start,to=from+last;end=Math.max(end,to);
        if(to>from)this.marks.push({from,to,shape:LIP_LETTERS[char]??0,vowel:VOWEL.test(char),letter:LETTER.test(char)});
      }
      this.text=end;
      if(this.marks.length>LIP_TRACK.maxMarks)this.marks.splice(0,this.marks.length-LIP_TRACK.maxMarks);
    }
    if(ms>0)this.audio+=ms;
  }
  // Silence added to the audio (the padding of a last frame): both clocks move on.
  skip(ms:number){if(ms>0){this.audio+=ms;this.text+=ms;}}
  // The vowel beside a consonant: the next one in the same word, else the one before.
  private near(i:number):number{
    for(const step of [1,-1])for(let n=1;n<=LIP_TRACK.nearChars;n++){const mark=this.marks[i+step*n];if(!mark?.letter)break;if(mark.vowel)return mark.shape;}
    return 0;
  }
  // The shape at this moment of the audio (ms from its start), given the loudness pose of the same moment.
  shape(ms:number,pose:number):number{
    while(this.marks.length>LIP_TRACK.nearChars+1&&this.marks[LIP_TRACK.nearChars+1].to<ms-LIP_TRACK.keepMs)this.marks.shift();
    let i=-1;for(let n=this.marks.length-1;n>=0;n--){const mark=this.marks[n];if(ms>=mark.from&&ms<mark.to){i=n;break;}}
    const mark=this.marks[i];if(!mark?.letter)return 0;
    if(mark.shape===LIPS.pressed||mark.shape===LIPS.teeth)return mark.shape;
    if(pose<=0)return 0;
    return mark.vowel?mark.shape:this.near(i);
  }
  byte(ms:number,pose:number):number{return pose|this.shape(ms,pose)<<4;}
}
// A frame from whole chunks of PCM (the last one padded with silence). The mouth carries on from frame to frame.
// lips: the track of the letters and the time of this frame's first sample: each pose then carries its shape.
export function imaFrame(pcm:Int16Array,encoder:ImaEncoder,mouth=new MouthTrack(),rate=16000,lips?:{track:LipTrack;ms:number}):Uint8Array{
  const chunks=Math.max(1,Math.ceil(pcm.length/IMA.chunkSamples)),poses=Math.ceil(chunks/IMA.mouthChunks),step=IMA.mouthChunks*IMA.chunkSamples;
  const padded=new Int16Array(chunks*IMA.chunkSamples);padded.set(pcm);
  const frame=new Uint8Array(2+poses+chunks*IMA.chunkBytes);frame[0]=FRAME_IMA;frame[1]=poses;
  for(let m=0;m<poses;m++){
    const from=m*step,pose=mouth.pose(pcm.subarray(Math.min(pcm.length,from),Math.min(pcm.length,from+step)),step/rate);
    frame[2+m]=lips?lips.track.byte(lips.ms+(from+step/2)*1000/rate,pose):pose;
  }
  for(let c=0;c<chunks;c++)encoder.chunk(padded.subarray(c*IMA.chunkSamples,(c+1)*IMA.chunkSamples),frame,2+poses+c*IMA.chunkBytes);
  return frame;
}
export const frameSamples=(frame:Uint8Array)=>(frame.length-2-frame[1])/IMA.chunkBytes*IMA.chunkSamples;
// G.711 A-law (the robot's microphone, encoded natively by the host's ChatAudioIO/Codecs).
const ALAW=Int16Array.from({length:256},(_,i)=>{
  const a=i^0x55,segment=(a&0x70)>>4;let t=(a&0x0f)<<4;
  if(segment===0)t+=8;else{t+=0x108;if(segment>1)t<<=segment-1;}
  return a&0x80?t:-t;
});
export function alawToPcm16(alaw:Uint8Array):Uint8Array{const out=new Int16Array(alaw.length);for(let i=0;i<alaw.length;i++)out[i]=ALAW[alaw[i]];return new Uint8Array(out.buffer);}
