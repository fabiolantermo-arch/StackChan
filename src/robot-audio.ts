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
// A frame from whole chunks of PCM (the last one padded with silence). The mouth carries on from frame to frame.
export function imaFrame(pcm:Int16Array,encoder:ImaEncoder,mouth=new MouthTrack(),rate=16000):Uint8Array{
  const chunks=Math.max(1,Math.ceil(pcm.length/IMA.chunkSamples)),poses=Math.ceil(chunks/IMA.mouthChunks),step=IMA.mouthChunks*IMA.chunkSamples;
  const padded=new Int16Array(chunks*IMA.chunkSamples);padded.set(pcm);
  const frame=new Uint8Array(2+poses+chunks*IMA.chunkBytes);frame[0]=FRAME_IMA;frame[1]=poses;
  for(let m=0;m<poses;m++){const from=m*step;frame[2+m]=mouth.pose(pcm.subarray(Math.min(pcm.length,from),Math.min(pcm.length,from+step)),step/rate);}
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
