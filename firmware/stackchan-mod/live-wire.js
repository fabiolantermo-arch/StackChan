export function encodeMedia(kind,sequence,payload,width=0,height=0){
  const bytes=new Uint8Array(payload),out=new ArrayBuffer(12+bytes.byteLength),view=new DataView(out);
  view.setUint16(0,0x5242);view.setUint8(2,1);view.setUint8(3,kind);view.setUint32(4,sequence);view.setUint16(8,width);view.setUint16(10,height);
  new Uint8Array(out,12).set(bytes);return out;
}
export function decodeMedia(buffer){
  if(!(buffer instanceof ArrayBuffer)||buffer.byteLength<12||buffer.byteLength>65535)throw Error('invalid_media');
  const v=new DataView(buffer),kind=v.getUint8(3),sequence=v.getUint32(4),width=v.getUint16(8),height=v.getUint16(10),size=buffer.byteLength-12;
  if(v.getUint16(0)!==0x5242||v.getUint8(2)!==1||!sequence)throw Error('invalid_media');
  if(kind===3){if(width||height||size<2||size>6400||size%2)throw Error('invalid_audio');}
  else if(kind===5){
    // Full-resolution screen image in 32 KB pieces (same layout as camera chunks): frame id, byte offset, bytes.
    if(!width||!height||width>320||height>240||size<10||size>32776||size%2)throw Error('invalid_image');
    const frameId=v.getUint32(12),offset=v.getUint32(16);
    if(!frameId||offset%2||offset+size-8>width*height*2)throw Error('invalid_image');
    return {kind,sequence,width,height,frameId,offset,payload:buffer.slice(20)};
  }
  else if(kind!==2||!width||!height||width>160||height>120||size!==width*height*2)throw Error('invalid_image');
  return {kind,sequence,width,height,payload:buffer.slice(12)};
}
// 160x120 frames (kind 2) are doubled to fill the screen; full 320x240 frames (scale 1) are copied.
export function screenPixels(frame,bigEndian=false){
  const scale=frame.scale??2,input=new Uint8Array(frame.payload),width=frame.width*scale,height=frame.height*scale;
  if(![1,2].includes(scale)||frame.width<1||width>320||frame.height<1||height>240||input.length!==frame.width*frame.height*2)throw Error('invalid_image');
  if(scale===1&&!bigEndian)return frame.payload; // already in the display's order: no 150 KB copy
  const output=new Uint8Array(width*height*2);
  for(let y=0;y<frame.height;y++)for(let x=0;x<frame.width;x++){
    const source=(y*frame.width+x)*2,a=input[source+(bigEndian?1:0)],b=input[source+(bigEndian?0:1)];
    for(let row=0;row<scale;row++)for(let col=0;col<scale;col++){const offset=((y*scale+row)*width+x*scale+col)*2;output[offset]=a;output[offset+1]=b;}
  }
  return output.buffer;
}
/** Rebuilds one full-resolution screen image from its pieces; at most one image in RAM. */
export class ScreenAssembler {
  constructor(){this.frameId=0;}
  accept(piece){
    if(piece.frameId!==this.frameId||piece.width!==this.width||piece.height!==this.height){
      this.frameId=piece.frameId;this.width=piece.width;this.height=piece.height;this.bytes=new Uint8Array(piece.width*piece.height*2);this.received=0;this.seen=new Set();
    }
    if(this.seen.has(piece.offset))return null;
    this.seen.add(piece.offset);this.bytes.set(new Uint8Array(piece.payload),piece.offset);this.received+=piece.payload.byteLength;
    if(this.received!==this.bytes.byteLength)return null;
    const image={width:this.width,height:this.height,scale:1,payload:this.bytes.buffer};this.frameId=0;this.bytes=undefined;return image;
  }
}
// Measured on real replies: speech 1500-2700 RMS, breaths and sentence tails 300-800 (closed mouth).
export function pcmMouthLevel(data){
  // A view is read in place: copying every 60 ms piece would waste the robot's fixed memory.
  const bytes=ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,data.byteLength):new Uint8Array(data);let energy=0;
  for(let i=0;i+1<bytes.length;i+=2){let sample=bytes[i]|bytes[i+1]<<8;if(sample&0x8000)sample-=65536;energy+=sample*sample;}
  if(bytes.length<2)return 0;
  const rms=Math.sqrt(energy/(bytes.length/2));return rms>1600?.8:rms>900?.35:0;
}
export function audiblePCM(data){return pcmMouthLevel(data)>0;}
// Audio of the Live call (10 Nov 2026), the same in the app (RobotCallAudio in RobotLiveCore.swift): 8 kHz µ-law
// (G.711), one byte a sample, in pieces of 800 bytes, a tenth of a second. A type-3 message carries two marker
// bytes and then the µ-law bytes, an even number of them. What has no marker (the 16 kHz PCM16 of before) is
// dropped by whoever receives it, never played as noise.
// Why: the robot's link carries 30-35 KB a second in all and every message costs the robot about 10 ms whatever its
// size. PCM16 at 16 kHz was 32 KB a second each way in fifty messages; this is 8 KB a second in ten.
// Microphone and speaker stay at 16 kHz PCM16 on both sides: going out, two samples become one through a small
// filter (the one before, twice the first, the second: a quarter each); coming in, every sample is played twice,
// the first time halfway from the one before.
export const CALL_PIECE=800,CALL_PIECE_MAX=1600;
const CALL_MARK_0=0xB1,CALL_MARK_1=0x08,ULAW_EXPONENT=new Uint8Array(256),ULAW_LINEAR=new Int16Array(256);
for(let i=0;i<256;i++){
  ULAW_EXPONENT[i]=i<2?0:i<4?1:i<8?2:i<16?3:i<32?4:i<64?5:i<128?6:7;
  const u=~i&0xFF,t=(((u&15)<<3)+132)<<((u&0x70)>>4);ULAW_LINEAR[i]=u&0x80?132-t:t-132;
}
// PCM16 samples of a buffer or of a view, read in place (robot and iPhone are both little-endian): the robot's
// JavaScript is slow per sample, and this is half the reads of taking the bytes one by one (voice-wire.js ulawEncode).
const samplesOf=data=>{
  const view=ArrayBuffer.isView(data),buffer=view?data.buffer:data,offset=view?data.byteOffset:0,count=data.byteLength>>1;
  return offset&1?new Int16Array(new Uint8Array(buffer,offset,count*2).slice().buffer):new Int16Array(buffer,offset,count);
};
// Takes 16 kHz PCM16 as it comes from the microphone, in reads of any size, and calls piece() with CALL_PIECE
// µ-law bytes whenever that many are ready. The bytes are the packer's own fixed block: use them before returning.
export class CallPacker{
  #piece=new Uint8Array(CALL_PIECE);#fill=0;#before=0;#pair=new Int16Array(2);#odd=false;
  clear(){this.#fill=0;this.#before=0;this.#odd=false;}
  add(pcm,piece){
    const samples=samplesOf(pcm),count=samples.length;let from=0;
    // A sample left alone by the read before makes a pair with the first of this one.
    if(this.#odd&&count){this.#pair[1]=samples[0];this.#odd=false;this.#run(this.#pair,0,2,piece);from=1;}
    const end=from+((count-from)&~1);
    this.#run(samples,from,end,piece);
    if(end<count){this.#pair[0]=samples[end];this.#odd=true;}
  }
  #run(samples,i,end,piece){
    const out=this.#piece;let fill=this.#fill,before=this.#before;
    for(;i<end;i+=2){
      const a=samples[i],b=samples[i+1];
      let sample=(before+a+a+b)>>2,sign=0;before=b;
      if(sample<0){sample=-sample;sign=0x80;}
      if(sample>32635)sample=32635;
      sample+=132;
      const exponent=ULAW_EXPONENT[sample>>7];
      out[fill++]=~(sign|exponent<<4|(sample>>(exponent+3))&15);
      if(fill===CALL_PIECE){fill=0;this.#fill=0;this.#before=before;piece(out);}
    }
    this.#fill=fill;this.#before=before;
  }
}
// A whole type-3 message, header included, in one block.
export function encodeCallAudio(sequence,ulaw){
  const out=new ArrayBuffer(14+ulaw.length),view=new DataView(out);
  view.setUint16(0,0x5242);view.setUint8(2,1);view.setUint8(3,3);view.setUint32(4,sequence);
  view.setUint8(12,CALL_MARK_0);view.setUint8(13,CALL_MARK_1);new Uint8Array(out,14).set(ulaw);
  return out;
}
// µ-law bytes carried by a type-3 payload; 0 when it is not call audio in this format.
export function callAudioLength(payload){
  const bytes=ArrayBuffer.isView(payload)?new Uint8Array(payload.buffer,payload.byteOffset,payload.byteLength):new Uint8Array(payload),count=bytes.length-2;
  return count>=2&&count<=CALL_PIECE_MAX&&!(count&1)&&bytes[0]===CALL_MARK_0&&bytes[1]===CALL_MARK_1?count:0;
}
// The payload as 16 kHz PCM16 bytes, four for every µ-law byte. state.last carries the last sample to the next piece.
export function decodeCallAudio(payload,state){
  const bytes=ArrayBuffer.isView(payload)?new Uint8Array(payload.buffer,payload.byteOffset,payload.byteLength):new Uint8Array(payload),count=bytes.length-2,out=new Int16Array(count*2);
  let last=state.last|0;
  for(let i=0,at=0;i<count;i++){const sample=ULAW_LINEAR[bytes[i+2]];out[at++]=(last+sample)>>1;out[at++]=sample;last=sample;}
  state.last=last;return new Uint8Array(out.buffer);
}
// Same bounds as the cloud and the iPhone Studio: ±10°, 300–5000 ms, 32 steps, 60 s.
export const DANCE_EXPRESSIONS=['neutral','happy','sad','blink','talk-small','talk-open'];
export function validDance(steps){
  if(!Array.isArray(steps)||steps.length<1||steps.length>32)return false;
  let total=0;
  for(const s of steps){
    if(!s||![s.yaw,s.pitch].every(n=>Number.isFinite(n)&&Math.abs(n)<=10)||!Number.isInteger(s.durationMs)||s.durationMs<300||s.durationMs>5000||!DANCE_EXPRESSIONS.includes(s.expression))return false;
    total+=s.durationMs;
  }
  return total<=60000;
}

// Hardware-independent dispatcher used by both the MOD and the device test double.
export class DeviceCommands {
  constructor(io,send){this.io=io;this.send=send;this.generation=0;this.busy=false;this.closed=false;this.lastSequence=0;}
  async command(value){
    if(this.closed||!value||typeof value.id!=='string'||value.id.length>64)return;
    if(value.action==='stop'){
      // An explicit STOP from the iPhone. (Until 10 Nov 2026 this comment sat in the middle of the line and hid the
      // answer and the return: everything stopped, but the iPhone was told that the STOP had failed.)
      this.generation++;this.busy=false;let ok=true;try{await this.io.stop(true);}catch{ok=false;}
      if(!this.closed)this.send({type:'ack',id:value.id,ok});return;
    }
    if(this.busy){this.send({type:'ack',id:value.id,ok:false});return;}
    const generation=this.generation;this.busy=true;
    // TEMPORARY diagnostics (10 Nov 2026): a command confirmed more than 0.7 s after it arrived (the relay waits 1.5 s).
    const arrived=Date.now(),slow=()=>{const took=Date.now()-arrived;if(took>700&&typeof trace==='function')trace(`[robottino] live slow ${value.action} ${took}\n`);};
    try {
      switch(value.action){
        case 'camera.start':await this.io.camera(true);break;
        case 'camera.stop':await this.io.camera(false);break;
        case 'call.start':await this.io.call(true);break;
        case 'call.stop':await this.io.call(false);break;
        case 'screen.start':await this.io.screen(true);break;
        case 'screen.stop':await this.io.screen(false);break;
        case 'face.style':
          if(!['portrait','white','redhead'].includes(value.style))throw Error('invalid_style');
          await this.io.faceStyle(value.style);break;
        case 'dance':
          if(!validDance(value.steps))throw Error('invalid_dance');
          await this.io.dance(value.steps.map(s=>({yaw:s.yaw,pitch:s.pitch,durationMs:s.durationMs,expression:s.expression})));break;
        // Face following with the robot camera: small frames out, where the iPhone found the face back.
        case 'track.start':await this.io.track(true);break;
        case 'track.stop':await this.io.track(false);break;
        case 'track':
          if(!Number.isInteger(value.frameId)||value.frameId<1||value.frameId>0xffffffff||![value.x,value.y].every(n=>Number.isFinite(n)&&n>=0&&n<=1))throw Error('invalid_target');
          this.io.target({frameId:value.frameId,x:value.x,y:value.y});break;
        case 'motion':
        case 'mirror':
          // Head control from the iPhone: 90° sideways and 85° up, never down (src/robot-wire.ts); the mirror ±10°.
          if(![value.yaw,value.pitch].every(Number.isFinite))throw Error('invalid_pose');
          if(value.action==='motion'?Math.abs(value.yaw)>90||value.pitch>0||value.pitch< -85:Math.abs(value.yaw)>10||Math.abs(value.pitch)>10)throw Error('invalid_pose');
          if(value.action==='mirror'){
            if(![value.leftEye,value.rightEye,value.mouth].every(n=>Number.isFinite(n)&&n>=0&&n<=1))throw Error('invalid_face');
            this.io.face(value);if(value.followHead)await this.io.motion(value);
          }else await this.io.motion(value);
          break;
        default:throw Error('unknown_command');
      }
      slow();if(!this.closed&&this.generation===generation)this.send({type:'ack',id:value.id,ok:true});
    }catch{
      slow();if(!this.closed&&this.generation===generation)this.send({type:'ack',id:value.id,ok:false});
    }finally{if(this.generation===generation)this.busy=false;}
  }
  media(buffer){
    if(this.closed)return;
    const frame=decodeMedia(buffer);if(frame.sequence<=this.lastSequence)throw Error('replay');this.lastSequence=frame.sequence;
    if(frame.kind===3)this.io.audio(frame.payload);
    else if(frame.kind===5){if(!this.screen)this.screen=new ScreenAssembler();const image=this.screen.accept(frame);if(image)this.io.image(image);}
    else this.io.image(frame);
  }
  close(){if(this.closed)return;this.closed=true;this.generation++;this.busy=false;try{Promise.resolve(this.io.stop()).catch(()=>{});}catch{}}
}

// Pieces of 4 KB, built one at a time as they are sent (9 Nov 2026: whole frames cut in 32 KB pieces, each copied
// twice and all queued at once, used up the robot's fixed JavaScript memory and restarted it; with 8 KB pieces the
// robot's answers to the iPhone waited too long behind them on the hotspot, see live-device.js). Frame identity and
// byte offset let the phone rebuild one bounded RGB565 frame without server storage; any even piece size works.
export const CAMERA_PIECE=4096;
function* cameraPieces(frameId,source,width,height,nextSequence,kind){
  for(let offset=0;offset<source.byteLength;offset+=CAMERA_PIECE){
    const count=Math.min(CAMERA_PIECE,source.byteLength-offset),out=new ArrayBuffer(20+count),view=new DataView(out);
    view.setUint16(0,0x5242);view.setUint8(2,1);view.setUint8(3,kind);view.setUint32(4,nextSequence());view.setUint16(8,width);view.setUint16(10,height);
    view.setUint32(12,frameId);view.setUint32(16,offset);new Uint8Array(out,20).set(source.subarray(offset,offset+count));
    yield out;
  }
}
// «Cos'è questo?» (voice-wire.js seeCommand, src/robot-vision.ts).
// The picture for the server, in pieces of whole rows made one at a time from the camera frame (no copy of the whole
// 38 KB frame in the robot's fixed memory): «RIMG», piece index, piece count, width, height (16 bits little endian),
// then the rows as the camera gives them (RGB565 little endian). The frame must stay with the robot until the last.
export const PICTURE_ROWS=12;
export function* pictureChunks(buffer,width,height){
  const source=new Uint8Array(buffer),row=width*2,count=Math.ceil(height/PICTURE_ROWS);
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<16||width>320||height<16||height>240||count>32||source.byteLength!==row*height)throw Error('invalid_picture');
  for(let index=0;index<count;index++){
    const from=index*PICTURE_ROWS*row,to=Math.min(source.byteLength,from+PICTURE_ROWS*row),piece=new Uint8Array(10+to-from);
    piece[0]=0x52;piece[1]=0x49;piece[2]=0x4d;piece[3]=0x47;piece[4]=index;piece[5]=count;piece[6]=width&255;piece[7]=width>>8;piece[8]=height&255;piece[9]=height>>8;
    piece.set(source.subarray(from,to),10);yield piece;
  }
}

// Checked at once; the pieces come one by one (an iterator). Kind 4: RGB565LE up to 320×240 (video). Kind 6: 8-bit
// grey up to 160×120, one byte per pixel (face following).
export function cameraChunks(frameId,payload,width,height,nextSequence,kind=4){
  const source=new Uint8Array(payload),grey=kind===6;
  if((kind!==4&&!grey)||!Number.isInteger(frameId)||frameId<1||frameId>0xffffffff||!Number.isInteger(width)||!Number.isInteger(height)||width<1||width>(grey?160:320)||height<1||height>(grey?120:240)||source.byteLength!==width*height*(grey?1:2))throw Error('invalid_camera_frame');
  return cameraPieces(frameId,source,width,height,nextSequence,kind);
}
// Face following (9 Nov 2026, «il più veloce possibile»): the 160×120 RGB565LE frame becomes 80×60 grey, the green
// of each 2×2 block added up (0…252). 4.8 KB instead of 38.4 KB, eight times quicker on the hotspot; Vision found
// the owner's face in these images as well as in colour (confidence 0.67–0.72). One pixel at a time: reading two
// at a time through a Uint32Array over the camera frame gave the same result in Node but flat images on the robot
// (9 Nov 2026, every pixel 28), so following saw no face.
// Face following at full camera resolution (10 Nov 2026): measured on the Mac with Vision on the robot's own frames
// of the owner, shrunk as if farther away, the 80×60 copy found the face only within about 40 cm (2 of 5 at about
// 60 cm, almost never beyond), the 160×120 grey frame 5 of 5 up to more than a metre; enlarging the 80×60 copy in the
// app did not help. Each 4 KB piece is converted only when it is sent, straight from the camera frame (green of each
// pixel, 0…252 like the small image below): no 19 KB copy in the robot's fixed JavaScript memory. The camera frame must stay
// with the robot until the last piece (live-device.js closes it then).
export function greyChunks(frameId,buffer,width,height,nextSequence){
  if(!Number.isInteger(frameId)||frameId<1||frameId>0xffffffff||!Number.isInteger(width)||!Number.isInteger(height)||width<1||width>160||height<1||height>120||!buffer||buffer.byteLength<width*height*2)throw Error('invalid_camera_frame');
  return greyPieces(frameId,new Uint16Array(buffer,0,width*height),width,height,nextSequence);
}
function* greyPieces(frameId,pixels,width,height,nextSequence){
  const total=width*height;
  for(let offset=0;offset<total;offset+=CAMERA_PIECE){
    const count=Math.min(CAMERA_PIECE,total-offset),out=new ArrayBuffer(20+count),view=new DataView(out),grey=new Uint8Array(out,20);
    view.setUint16(0,0x5242);view.setUint8(2,1);view.setUint8(3,6);view.setUint32(4,nextSequence());view.setUint16(8,width);view.setUint16(10,height);
    view.setUint32(12,frameId);view.setUint32(16,offset);
    for(let i=0;i<count;i++)grey[i]=(pixels[offset+i]&0x7E0)>>3;
    yield out;
  }
}
// The small following image (10 Nov 2026): 80×60 grey cut from a window of the 160×120 camera frame, each pixel the
// green of a 2×2 block added up (0…252, as above). step is how many half camera pixels one small pixel moves:
// 3 → a 120×90 window starting at x0,y0 (the face keeps two thirds of its size), 4 → the whole frame halved.
// Why: the robot's connection sends 5.7 KB and then waits for the answer of the network (host setting, about
// 150 ms on the hotspot), so the whole 19.2 KB grey frame takes a second, this one leaves in one go. Measured on
// the Mac with Vision on the robot's frames of the owner: the 120×90 window is found from about 40 cm to 1 m with
// 2 pixels of error (the halved whole frame only when near, a plain 80×60 cut only when far); taking one pixel in
// place of the 2×2 average found far fewer.
// Three pieces of 20 rows, each converted only when it leaves (about the work of one piece of the whole frame); the
// camera frame must stay with the robot until the last one.
export const SMALL_WIDTH=80,SMALL_HEIGHT=60,SMALL_ROWS=20,SMALL_PIECES=SMALL_HEIGHT/SMALL_ROWS;
export function windowChunks(frameId,buffer,width,height,x0,y0,step,nextSequence){
  if(!Number.isInteger(frameId)||frameId<1||frameId>0xffffffff||![width,height,x0,y0].every(Number.isInteger)||(step!==3&&step!==4)||x0<0||y0<0||x0+SMALL_WIDTH*step/2>width||y0+SMALL_HEIGHT*step/2>height||!buffer||buffer.byteLength<width*height*2)throw Error('invalid_camera_frame');
  return windowPieces(frameId,new Uint16Array(buffer,0,width*height),width,x0,y0,step,nextSequence);
}
function* windowPieces(frameId,pixels,width,x0,y0,step,nextSequence){
  for(let row=0;row<SMALL_HEIGHT;row+=SMALL_ROWS){
    const out=new ArrayBuffer(20+SMALL_ROWS*SMALL_WIDTH),view=new DataView(out),grey=new Uint8Array(out,20);
    view.setUint16(0,0x5242);view.setUint8(2,1);view.setUint8(3,6);view.setUint32(4,nextSequence());view.setUint16(8,SMALL_WIDTH);view.setUint16(10,SMALL_HEIGHT);
    view.setUint32(12,frameId);view.setUint32(16,row*SMALL_WIDTH);
    for(let y=row,o=0;y<row+SMALL_ROWS;y++){
      const line=(y0+((y*step)>>1))*width+x0;
      for(let x=0;x<SMALL_WIDTH;x++,o++){const i=line+((x*step)>>1);grey[o]=((pixels[i]&0x7E0)+(pixels[i+1]&0x7E0)+(pixels[i+width]&0x7E0)+(pixels[i+width+1]&0x7E0))>>5;}
    }
    yield out;
  }
}
// First pairing (pairing-device.js): the server sends a code to show, then the robot's own credential.
export function pairingEvent(text){
  let value;try{value=JSON.parse(text);}catch{return {type:'error'};}
  if(value?.type==='code'&&typeof value.code==='string'&&/^\d{6}$/.test(value.code))return {type:'code',code:value.code};
  if(value?.type==='credential'&&typeof value.token==='string'&&/^[A-Za-z0-9_.~+/=-]{32,256}$/.test(value.token))return {type:'credential',token:value.token};
  return {type:'error'};
}
