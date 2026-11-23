// The K210 camera (M5Stack UnitV, bought by the owner in November 2026) finds faces by itself and tells the robot
// where they are over the Grove serial line (PORT.C of the K151). One frame of 12 bytes for every picture the camera
// has looked at, with a face or without, so the robot also knows that the camera is alive and sees nobody:
//    0 'R'   1 'K'   2 version (1)   3 picture number (0…255, then 0 again)   4 how many faces in the picture
//    5, 6  the middle of the largest face, 0…255 from the left and from the top of the picture
//    7, 8  its width and its height, 0…255 of the picture's
//    9     how sure the camera is, 0…100      10 ms spent on this picture (255 = that or more)
//    11    CRC-8 (polynomial 7) of bytes 2…10
// With no face bytes 5…9 are 0. The same format is written by firmware/k210/boot.py (the camera's own script) and by
// scripts/virtual-k210.mjs (a pretend camera): change the three together.
// The first half of this file is pure arithmetic; the second (createK210) listens on the serial port it is given.
// No import: the host's serial module comes from mod.js, so the tests run the same file on the Mac.
export const K210_BAUD=115200,K210_FRAME=12,K210_VERSION=1;
const R=0x52,K=0x4B;
export const crc8=(bytes,from,to)=>{
  let crc=0;
  for(let i=from;i<to;i++){crc^=bytes[i];for(let bit=0;bit<8;bit++)crc=crc&0x80?((crc<<1)^7)&255:(crc<<1)&255;}
  return crc;
};
const byte=value=>{const n=Math.round(value);return n<0?0:n>255?255:n;};
// What the camera sends for one picture (the tests and the pretend camera use it).
export const encodeFrame=({seq=0,faces=0,x=0,y=0,w=0,h=0,score=0,ms=0}={})=>{
  const f=new Uint8Array(K210_FRAME),seen=faces>0;
  f[0]=R;f[1]=K;f[2]=K210_VERSION;f[3]=seq&255;f[4]=byte(faces);
  if(seen){f[5]=byte(x*255);f[6]=byte(y*255);f[7]=byte(w*255);f[8]=byte(h*255);f[9]=Math.min(100,byte(score*100));}
  f[10]=byte(ms);f[11]=crc8(f,2,11);
  return f;
};
// The small picture for the app's Live (23 Nov 2026, firmware/k210/boot.py): JPEG 160×120, in pieces of at most
// K210_IMAGE.piece bytes, each in its own frame:
//    0 'R'   1 'J'   2 version (1)   3 picture number   4 piece (0…)   5 pieces in all (1…maxPieces)
//    6 bytes in this piece (1…piece)   7… the bytes   last: CRC-8 of bytes 2 up to the last one before it
// head: the room the robot's JPEG frame for the iPhone keeps in front (live-wire.js JPEG_HEAD), so that the picture
// goes out with no copy.
// piece 40 and up to 100 pieces since 23 Nov 2026 (96 flooded the line: firmware/k210/boot.py).
export const K210_IMAGE={width:160,height:120,piece:40,maxPieces:100,head:12,freshMs:6000};
const J=0x4A,PIECE_TOP=8+K210_IMAGE.piece;
// What the camera sends for one piece (the tests and the pretend camera use it).
export const encodePiece=({number=0,index=0,count=1,bytes=new Uint8Array(0)}={})=>{
  const f=new Uint8Array(8+bytes.length);
  f[0]=R;f[1]=J;f[2]=K210_VERSION;f[3]=number&255;f[4]=index;f[5]=count;f[6]=bytes.length;f.set(bytes,7);f[7+bytes.length]=crc8(f,2,7+bytes.length);
  return f;
};
// Bytes as they arrive, in pieces of any size: every whole, correct frame is handed to onFrame (faces) or onPiece
// (picture). The frame object is always the same one (the robot's memory is fixed: nothing is made for each picture),
// so whoever keeps it copies it; a piece is given as the parser's own bytes (from, length) and must be copied at once.
// Noise, a frame cut short and a wrong checksum are counted and skipped; the search starts again from the next 'R'
// inside what had been taken for a frame, so one bad byte costs one frame and not the ones after it.
export class K210Parser{
  #bytes=new Uint8Array(PIECE_TOP);#at=0;#need=K210_FRAME;#seq;
  frames=0;bad=0;lost=0;noise=0;pieces=0;
  frame={seq:0,faces:0,x:0,y:0,w:0,h:0,score:0,ms:0};
  constructor(onFrame,onPiece){this.onFrame=onFrame;this.onPiece=onPiece;}
  push(bytes,count=bytes.length){
    const f=this.#bytes;
    for(let i=0;i<count;i++){
      const b=bytes[i];
      if(this.#at===0&&b!==R){this.noise++;continue;}
      if(this.#at===1&&b!==K&&b!==J){this.noise++;if(b!==R){this.#at=0;this.noise++;}continue;}
      if(this.#at===1)this.#need=b===K?K210_FRAME:8; // a piece: its length is known at byte 6
      f[this.#at++]=b;
      if(this.#at===7&&f[1]===J){
        const size=f[6];
        if(size>=1&&size<=K210_IMAGE.piece)this.#need=8+size;else{this.#need=7;} // impossible: taken as bad below
      }
      if(this.#at===this.#need){
        const n=this.#need,ok=f[2]===K210_VERSION&&(f[1]===K?crc8(f,2,11)===f[11]:n>8&&f[5]>=1&&f[5]<=K210_IMAGE.maxPieces&&f[4]<f[5]&&crc8(f,2,n-1)===f[n-1]);
        this.#at=0;this.#need=K210_FRAME;
        if(ok){if(f[1]===K)this.#take();else{this.pieces++;this.onPiece?.(f[3],f[4],f[5],f,7,f[6]);}continue;}
        // Not a frame: the next 'R' in it may be where a real one begins. What follows it is read again.
        this.bad++;
        let next=1;while(next<n&&!(f[next]===R&&(next===n-1||f[next+1]===K||f[next+1]===J)))next++;
        this.noise+=next;
        if(next<n)this.push(f.slice(next,n));
      }
    }
  }
  #take(){
    const f=this.#bytes,out=this.frame,seq=f[3];
    if(this.#seq!==undefined)this.lost+=(seq-this.#seq-1)&255;
    this.#seq=seq;this.frames++;
    out.seq=seq;out.faces=f[4];out.x=f[5]/255;out.y=f[6]/255;out.w=f[7]/255;out.h=f[8]/255;out.score=f[9]/100;out.ms=f[10];
    this.onFrame?.(out);
  }
  // The line was closed and opened again (another pin, a camera plugged in): what was half read is dropped.
  reset(){this.#at=0;this.#need=K210_FRAME;this.#seq=undefined;}
}
// The pieces of one picture put together. A picture is given (onImage) only when every piece has come: then a new
// ArrayBuffer with K210_IMAGE.head bytes free in front and the JPEG after them. A piece of another picture before the
// last is complete: the last is dropped (counted in broken; the line lost a piece).
export class K210Images{
  #buffer;#have=new Uint8Array(K210_IMAGE.maxPieces);#number=-1;#count=0;#got=0;#size=0;
  images=0;broken=0;
  constructor(onImage){this.onImage=onImage;}
  piece(number,index,count,bytes,from,size){
    const L=K210_IMAGE;
    if(!(count>=1&&count<=L.maxPieces&&index<count&&size>=1&&size<=L.piece))return;
    if(index<count-1&&size!==L.piece)return; // only the last piece is short
    if(number!==this.#number||count!==this.#count){
      if(this.#number>=0&&this.#got<this.#count)this.broken++;
      this.#number=number;this.#count=count;this.#got=0;this.#size=0;this.#have.fill(0);this.#buffer=new Uint8Array(L.head+count*L.piece);
    }
    if(this.#have[index])return;
    this.#have[index]=1;this.#got++;
    this.#buffer.set(bytes.subarray(from,from+size),L.head+index*L.piece);
    if(index===count-1)this.#size=index*L.piece+size;
    if(this.#got<count)return;
    const out=this.#buffer.buffer.slice(0,L.head+this.#size);
    this.#number=-1;this.#got=0;this.#count=0;this.#buffer=undefined;this.images++;
    this.onImage?.(out);
  }
}
// How much of the scene the camera's picture covers, in radians. NOT MEASURED: worked out from the diagonal angle of
// the two data sheets (UnitV with the OV2640: 65°; UnitV «M12» with the OV7740: 80°) for a 4:3 picture. To be
// measured with the camera in hand before the head follows it.
export const K210_FOV={ov2640:{x:.94,y:.73},m12:{x:1.18,y:.93}};
// Where the face is, as angles of the head (yaw + = the robot's left, pitch − = up, as everywhere in the MOD).
// origin is where the camera was pointing when it took the picture: the pose of the head if the camera rides on the
// head, or the fixed direction it was mounted in if it stays on the body. Same arithmetic as the robot's own camera
// (live-device.js selfAnswer); the few centimetres between the camera and the neck are not counted.
export const faceDirection=(frame,origin,fov=K210_FOV.ov2640)=>
  frame&&frame.faces>0&&origin?{yaw:origin.y+(.5-frame.x)*fov.x,pitch:origin.p-(.5-frame.y)*fov.y}:undefined;

// Where the K210's face is in the picture of the robot's own camera (x, y, size: 0…1 of that picture), so that the
// robot's following (live-device.js selfAnswer, made for that camera) takes it as it is. The K210 rides on the head
// (owner, 23 Nov 2026: «sulla testa», upright, cable below): the same angle off the middle is the same place for both.
// The K210 here has the OV7740 (seen on its console, 23 Nov 2026): K210_FOV.m12. cam: the robot camera's field
// (tracker.js CAMERA_FOV). A face beyond the robot camera's edge is put on that edge.
export const k210View=(frame,cam,fov=K210_FOV.m12)=>{
  if(!frame||!(frame.faces>0)||!cam)return undefined;
  const edge=v=>v<0?0:v>1?1:v;
  return {x:edge(.5-(.5-frame.x)*fov.x/cam.x),y:edge(.5-(.5-frame.y)*fov.y/cam.y),size:frame.w*fov.x/cam.x};
};
// Listens to the K210 camera on the Grove serial line of the K151, PORT.C (G18 and G17, 5 V; free on
// this robot: the motors' line is on G6/G7, port 1), and keeps what the camera last said.
// Tried on the robot on 23 Nov 2026: about 15 pictures a second on G17. Since then the head follows its faces (owner:
// «l'inseguimento facciamolo con la nuova camera»): live-device.js selfTurn gives them to selfAnswer instead of the
// robot camera's own search, which then runs no more (it held the internal RAM: crash of 17:16 on 23 Nov 2026).
// - Nothing is ever sent to the camera: one pin is taken, to receive.
// - Which of the cable's two signal wires carries the camera's words depends on the camera's script and has not been
//   seen: the robot listens on G18 and, after K210_SWAP_MS without one good frame, on G17, and so on in turn.
// - The line has no memory but the chip's own 128 bytes: at 20 frames a second that is half a second of JavaScript
//   busy elsewhere. What is lost beyond that is counted (`lost`, `bad`) and the next frame is good again.
// - Off unless it is switched on on the robot (preference k210 true, «K210» in the large menu): with nothing plugged
//   in an open pin would only pick up noise.
export const K210_PINS=[18,17],K210_PORT=2,K210_SWAP_MS=3000,K210_FRESH_MS=500,K210_LOG_MS=5000,K210_QUIET_LOG_MS=30000;
// Serial: the host's embedded:io/serial. now(): ms. log(text): one line on the USB log.
export function createK210({Serial,now,log,pins=K210_PINS,port=K210_PORT}){
  const scratch=new ArrayBuffer(64),view=new Uint8Array(scratch);
  const last={seq:0,faces:0,x:0,y:0,w:0,h:0,score:0,ms:0};
  let serial,pin=0,openedAt,frameAt,closed=false,shownAt,failure,seen=0,withFace=0,spent=0;
  // The last whole picture for the app (K210Images), with its own number: the app is sent each one once.
  let image,imageNumber=0;
  const images=new K210Images(buffer=>{image={id:++imageNumber,buffer,width:K210_IMAGE.width,height:K210_IMAGE.height,at:now()};});
  const parser=new K210Parser(frame=>{
    last.seq=frame.seq;last.faces=frame.faces;last.x=frame.x;last.y=frame.y;last.w=frame.w;last.h=frame.h;last.score=frame.score;last.ms=frame.ms;
    frameAt=now();seen++;spent+=frame.ms;if(frame.faces>0)withFace++;
  },(number,index,count,bytes,from,size)=>{frameAt=now();images.piece(number,index,count,bytes,from,size);});
  const shut=()=>{const port=serial;serial=undefined;try{port?.close();}catch{}};
  const open=()=>{
    shut();parser.reset();openedAt=now();failure=undefined;
    try{
      serial=new Serial({receive:pins[pin],port,baud:K210_BAUD,format:'buffer',onReadable(){
        // The host calls this with no protection: no error may leave it (firmware.md). At most 256 bytes a call.
        try{for(let turn=0;turn<4;turn++){const count=this.read(scratch);if(!(count>0))break;parser.push(view,count);}}catch{}
      }});
    }catch(error){serial=undefined;failure=String(error?.message??error).slice(0,40);}
  };
  const fresh=()=>frameAt!==undefined&&now()-frameAt<K210_FRESH_MS;
  return {
    // Called from the robot's own cycle (every 100 ms): opens the line, changes wire when nothing comes, writes the log.
    tick(){
      if(closed)return;
      const time=now();
      if(openedAt===undefined)open();
      else if(time-Math.max(openedAt,frameAt??openedAt)>=K210_SWAP_MS){pin=(pin+1)%pins.length;open();}
      const quiet=!fresh();
      if(shownAt===undefined)shownAt=time;
      if(time-shownAt<(quiet&&!seen?K210_QUIET_LOG_MS:K210_LOG_MS))return;
      const line=failure?`k210 G${pins[pin]} cannot open: ${failure}`
        :!seen?`k210 G${pins[pin]} silent (noise ${parser.noise} bad ${parser.bad})`
        :`k210 G${pins[pin]} frames=${seen} faces=${withFace} ms=${Math.round(spent/seen)} lost=${parser.lost} bad=${parser.bad} noise=${parser.noise}`+(images.images||images.broken?` pictures=${images.images} broken=${images.broken}`:'')+(last.faces>0&&!quiet?` at ${Math.round(last.x*100)},${Math.round(last.y*100)} wide ${Math.round(last.w*100)} sure ${Math.round(last.score*100)}`:'')+` in ${time-shownAt} ms`;
      shownAt=time;seen=0;withFace=0;spent=0;images.images=0;images.broken=0;
      try{log?.(line);}catch{}
    },
    // The camera is sending pictures right now (with or without a face).
    get alive(){return !closed&&fresh();},
    // The largest face of the last picture, if that picture is recent; otherwise nothing. The same object each time.
    face(){return !closed&&fresh()&&last.faces>0?last:undefined;},
    // The last picture's answer, with a face or without, if it is recent; otherwise nothing. The same object each time:
    // a new picture has another seq.
    frame(){return !closed&&fresh()?last:undefined;},
    // The last whole small picture ({id,buffer,width,height}), if it came within K210_IMAGE.freshMs; otherwise nothing.
    // The buffer has K210_IMAGE.head bytes free in front (live-wire.js jpegFrame writes its header there).
    image(){return !closed&&image&&now()-image.at<K210_IMAGE.freshMs?image:undefined;},
    get pin(){return pins[pin];},
    get frames(){return parser.frames;},
    close(){closed=true;shut();}
  };
}
