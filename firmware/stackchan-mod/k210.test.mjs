// The K210 camera's serial frames: what the robot makes of the bytes, whole, in pieces, dirty or missing.
// Pure arithmetic and a pretend serial port: no camera, no robot.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {K210Parser,K210Images,K210_IMAGE,encodePiece,encodeFrame,crc8,faceDirection,k210View,createK210,K210_FRAME,K210_FOV,K210_BAUD,K210_PINS,K210_SWAP_MS,K210_FRESH_MS,K210_LOG_MS} from './k210.js';
import {pictures} from '../../scripts/virtual-k210.mjs';

const face={faces:1,x:.25,y:.75,w:.2,h:.3,score:.9,ms:55};
const collect=()=>{const got=[];return {got,parser:new K210Parser(frame=>got.push({...frame}))};};
const near=(a,b)=>Math.abs(a-b)<=1/255+1e-9;

test('one frame: twelve bytes, and the robot reads back what the camera wrote',()=>{
  const bytes=encodeFrame({seq:7,...face});
  assert.equal(bytes.length,K210_FRAME);assert.equal(bytes[0],0x52);assert.equal(bytes[1],0x4B);assert.equal(bytes[11],crc8(bytes,2,11));
  const {got,parser}=collect();parser.push(bytes);
  assert.equal(got.length,1);const f=got[0];
  assert.equal(f.seq,7);assert.equal(f.faces,1);assert.equal(f.ms,55);
  assert.ok(near(f.x,.25)&&near(f.y,.75)&&near(f.w,.2)&&near(f.h,.3),'place and size within one part in 255');
  assert.ok(Math.abs(f.score-.9)<.006);
});
test('no face: a frame all the same (the camera is alive and sees nobody), place and size at zero',()=>{
  const {got,parser}=collect();parser.push(encodeFrame({seq:1,faces:0,x:.5,y:.5,w:.5,h:.5,score:1,ms:40}));
  assert.deepEqual(got,[{seq:1,faces:0,x:0,y:0,w:0,h:0,score:0,ms:40}]);
});
test('values out of range are held inside the byte, never wrapped',()=>{
  const {got,parser}=collect();parser.push(encodeFrame({seq:300,faces:999,x:2,y:-1,w:1.5,h:.5,score:7,ms:9999}));
  assert.deepEqual(got[0],{seq:300&255,faces:255,x:1,y:0,w:1,h:128/255,score:1,ms:255});
});
test('the bytes arrive in pieces of any size, one at a time too',()=>{
  const stream=new Uint8Array(K210_FRAME*5);for(let i=0;i<5;i++)stream.set(encodeFrame({seq:i,...face,x:i/10}),i*K210_FRAME);
  for(const size of [1,2,5,7,12,13,60]){
    const {got,parser}=collect();for(let at=0;at<stream.length;at+=size)parser.push(stream.subarray(at,at+size));
    assert.deepEqual(got.map(f=>f.seq),[0,1,2,3,4],`pieces of ${size}`);assert.equal(parser.bad,0);assert.equal(parser.lost,0);
  }
});
test('a count shorter than the buffer: only that many bytes are read (the serial port fills part of a fixed buffer)',()=>{
  const buffer=new Uint8Array(64);buffer.fill(0x52);buffer.set(encodeFrame({seq:3,...face}),0);
  const {got,parser}=collect();parser.push(buffer,K210_FRAME);
  assert.equal(got.length,1);assert.equal(parser.noise,0);
});
test('noise before, between and after the frames is skipped and counted',()=>{
  const a=encodeFrame({seq:1,...face}),b=encodeFrame({seq:2,...face});
  const {got,parser}=collect();
  parser.push(Uint8Array.of(0,255,0x4B,9));parser.push(a);parser.push(Uint8Array.of(0x52,0x52,1,2,3));parser.push(b);parser.push(Uint8Array.of(0x10));
  assert.deepEqual(got.map(f=>f.seq),[1,2]);assert.ok(parser.noise>=8);assert.equal(parser.lost,0);
});
test('a frame with a damaged byte is refused, and the one right after it is read',()=>{
  for(let damaged=2;damaged<K210_FRAME;damaged++){
    const a=encodeFrame({seq:1,...face}),b=encodeFrame({seq:2,...face});a[damaged]^=0x10;
    const {got,parser}=collect();parser.push(a);parser.push(b);
    assert.deepEqual(got.map(f=>f.seq),[2],`byte ${damaged}`);assert.equal(parser.bad>=1,true);
  }
});
test('a frame cut short (bytes lost on the line): the next whole one is still read',()=>{
  for(let kept=1;kept<K210_FRAME;kept++){
    const {got,parser}=collect();
    parser.push(encodeFrame({seq:1,...face}).subarray(0,kept));parser.push(encodeFrame({seq:2,...face}));parser.push(encodeFrame({seq:3,...face}));
    assert.ok(got.some(f=>f.seq===3),`${kept} bytes kept: the frame after the next at the latest`);
    assert.ok(got.every(f=>f.seq===2||f.seq===3));
  }
});
test('the letters R K inside a frame do not start a false one',()=>{
  // Place 0x52 and size 0x4B: «RK» in the middle of a good frame, then the stream goes on.
  const tricky=encodeFrame({seq:1,faces:1,x:0x52/255,y:0x4B/255,w:0x52/255,h:0x4B/255,score:.5,ms:0x52});
  const {got,parser}=collect();
  // Starting in the middle of the tricky frame: the false start is refused by the checksum.
  parser.push(tricky.subarray(5));parser.push(encodeFrame({seq:2,...face}));parser.push(encodeFrame({seq:3,...face}));
  assert.ok(got.length>=1&&got.at(-1).seq===3);assert.ok(got.every(f=>f.seq>=2));
});
test('another version of the format is not read as this one',()=>{
  const other=encodeFrame({seq:1,...face});other[2]=2;other[11]=crc8(other,2,11);
  const {got,parser}=collect();parser.push(other);assert.equal(got.length,0);assert.equal(parser.bad,1);
});
test('pictures that never arrived are counted from their numbers, across the wrap at 255',()=>{
  const {parser}=collect();
  for(const seq of [250,251,254,255,0,3])parser.push(encodeFrame({seq}));
  assert.equal(parser.frames,6);assert.equal(parser.lost,2+2);
  parser.reset();parser.push(encodeFrame({seq:100}));assert.equal(parser.lost,4,'after the line is opened again the count starts afresh');
});
test('the same frame object every time: nothing is made for each picture',()=>{
  const seen=new Set(),parser=new K210Parser(frame=>seen.add(frame));
  for(let i=0;i<20;i++)parser.push(encodeFrame({seq:i,...face}));
  assert.equal(seen.size,1);
});
test('where the face is, as head angles: the middle of the picture is where the camera points',()=>{
  const fov=K210_FOV.ov2640,frame=(x,y)=>({faces:1,x,y});
  assert.deepEqual(faceDirection(frame(.5,.5),{y:.2,p:-.3}),{yaw:.2,pitch:-.3});
  // Left in the picture = the robot's left = more yaw; up in the picture = more negative pitch (as live-device.js).
  const left=faceDirection(frame(0,.5),{y:0,p:0});assert.ok(Math.abs(left.yaw-fov.x/2)<1e-9);assert.equal(left.pitch,0);
  const up=faceDirection(frame(.5,0),{y:0,p:0});assert.ok(Math.abs(up.pitch+fov.y/2)<1e-9);
  assert.ok(Math.abs(faceDirection(frame(1,.5),{y:0,p:0},K210_FOV.m12).yaw+K210_FOV.m12.x/2)<1e-9,'the wide lens covers more');
  assert.equal(faceDirection({faces:0,x:.5,y:.5},{y:0,p:0}),undefined,'no face, no direction');
  assert.equal(faceDirection(frame(.5,.5),undefined),undefined,'no known direction of the camera, no answer');
});

// A pretend serial port with the host's shape: read(buffer) fills it and says how many bytes, undefined when empty.
const fakeSerial=()=>{
  const ports=[];
  class Serial{
    constructor(options){if(Serial.fail)throw Error(Serial.fail);this.options=options;this.queue=[];this.closed=false;ports.push(this);}
    read(buffer){if(this.closed)throw Error('closed');if(!this.queue.length)return undefined;const out=new Uint8Array(buffer),n=Math.min(out.length,this.queue.length);out.set(this.queue.splice(0,n));return n;}
    feed(bytes){this.queue.push(...bytes);this.options.onReadable.call(this,bytes.length);}
    close(){this.closed=true;}
  }
  return {Serial,ports};
};
const robot=()=>{
  const {Serial,ports}=fakeSerial(),lines=[];let time=0;
  const k210=createK210({Serial,now:()=>time,log:line=>lines.push(line)});
  return {Serial,ports,lines,k210,at:ms=>{time=ms;k210.tick();},clock:ms=>{time=ms;}};
};
test('the robot listens only: one pin to receive, nothing to send, the camera\'s speed',()=>{
  const r=robot();assert.equal(r.ports.length,0,'nothing is opened before the first cycle');
  r.at(0);assert.equal(r.ports.length,1);
  const {receive,transmit,port,baud,format}=r.ports[0].options;
  assert.equal(receive,K210_PINS[0]);assert.equal(transmit,undefined);assert.equal(port,2,'port 1 is the motors\'');assert.equal(baud,K210_BAUD);assert.equal(format,'buffer');
});
test('frames arrive: the last face is kept while it is recent, then forgotten',()=>{
  const r=robot();r.at(0);
  r.ports[0].feed(encodeFrame({seq:1,...face}));
  assert.equal(r.k210.alive,true);assert.ok(near(r.k210.face().x,.25));
  r.clock(K210_FRESH_MS-1);assert.ok(r.k210.face());
  r.clock(K210_FRESH_MS);assert.equal(r.k210.face(),undefined,'an old picture says nothing about now');assert.equal(r.k210.alive,false);
  r.ports[0].feed(encodeFrame({seq:2,faces:0}));assert.equal(r.k210.alive,true);assert.equal(r.k210.face(),undefined,'alive, and nobody in the picture');
});
test('a long burst is read whole, more than the 64-byte buffer at a time',()=>{
  const r=robot();r.at(0);
  const burst=[];for(let i=0;i<10;i++)burst.push(...encodeFrame({seq:i,...face}));
  r.ports[0].feed(burst);assert.equal(r.k210.frames,10);
});
test('silence on a wire: the other wire is tried, in turn, and the one that speaks is kept',()=>{
  const r=robot();r.at(0);
  r.at(K210_SWAP_MS-100);assert.equal(r.ports.length,1);
  r.at(K210_SWAP_MS);assert.equal(r.ports.length,2);assert.equal(r.ports[0].closed,true,'the first pin is given back');assert.equal(r.ports[1].options.receive,K210_PINS[1]);
  r.at(2*K210_SWAP_MS);assert.equal(r.ports[2].options.receive,K210_PINS[0]);
  // Frames on this wire: it stays, however long.
  for(let t=2*K210_SWAP_MS;t<6*K210_SWAP_MS;t+=100){r.clock(t);r.ports[2].feed(encodeFrame({seq:t/100,...face}));r.k210.tick();}
  assert.equal(r.ports.length,3);assert.equal(r.k210.pin,K210_PINS[0]);
  // The camera is unplugged: after the wait the search begins again.
  r.at(6*K210_SWAP_MS+K210_SWAP_MS);assert.equal(r.ports.length,4);
});
test('noise on an open wire is not a camera: the wire is still changed',()=>{
  const r=robot();r.at(0);
  for(let t=100;t<K210_SWAP_MS;t+=100){r.clock(t);r.ports[0].feed([0x52,0x4B,1,2,3,0xff,0]);r.k210.tick();}
  assert.equal(r.k210.alive,false);r.at(K210_SWAP_MS);assert.equal(r.ports.length,2);
});
test('the port cannot be opened: no error leaves, it is tried again later and said on the log',()=>{
  const r=robot();r.Serial.fail='in use';
  assert.doesNotThrow(()=>r.at(0));assert.equal(r.ports.length,0);
  for(let t=100;t<=30000;t+=100)r.at(t);
  assert.ok(r.lines.some(line=>/cannot open: in use/.test(line)));
  r.Serial.fail=undefined;r.at(33000);assert.equal(r.ports.length,1,'opened as soon as it can be');
});
test('an error inside the serial callback never reaches the host',()=>{
  const r=robot();r.at(0);const port=r.ports[0];
  port.read=()=>{throw Error('boom');};
  assert.doesNotThrow(()=>port.feed([1,2,3]));
});
test('the log: silent at first, then frames, faces, time for a picture and what was lost, every five seconds',()=>{
  const r=robot();r.at(0);
  for(let t=100;t<=30000;t+=100)r.at(t);
  assert.ok(r.lines.length>=1&&/k210 G1[78] silent/.test(r.lines[0]),r.lines[0]);
  const from=30000,port=()=>r.ports.at(-1);r.lines.length=0;
  for(let t=from+100,seq=0;t<=from+2*K210_LOG_MS+500;t+=100,seq++){r.clock(t);port().feed(encodeFrame({seq,...face}));r.k210.tick();}
  const line=r.lines.find(text=>/frames=/.test(text));
  assert.match(line,/^k210 G1[78] frames=\d+ faces=\d+ ms=55 lost=0 bad=0 noise=\d+ at 25,75 wide 20 sure 90 in \d+ ms$/);
});
test('closed: the pin is given back and nothing more is done',()=>{
  const r=robot();r.at(0);r.k210.close();
  assert.equal(r.ports[0].closed,true);r.at(10*K210_SWAP_MS);assert.equal(r.ports.length,1);assert.equal(r.k210.face(),undefined);assert.equal(r.k210.alive,false);
});
test('the pretend camera speaks the same format: a face that goes round, then nobody',()=>{
  const {got,parser}=collect();
  for(const bytes of pictures({pattern:'circle',count:40}))parser.push(bytes);
  assert.equal(got.length,40);assert.equal(parser.bad,0);assert.equal(parser.lost,0);
  assert.ok(got.every(f=>f.faces===1&&f.x>=0&&f.x<=1&&f.y>=0&&f.y<=1));
  assert.ok(Math.max(...got.map(f=>f.x))-Math.min(...got.map(f=>f.x))>.3,'it moves across the picture');
  const none=collect();for(const bytes of pictures({pattern:'none',count:5}))none.parser.push(bytes);
  assert.deepEqual(none.got.map(f=>f.faces),[0,0,0,0,0]);
});
// The camera's own script (MaixPy) is never run here, but its arithmetic is plain Python: the same face, written by
// the script's byte() and crc8(), must give the very bytes the robot expects.
test('the camera\'s script writes the same bytes as the robot reads (its arithmetic, run with python3)',async t=>{
  const {execFileSync}=await import('node:child_process'),{readFileSync}=await import('node:fs');
  const script=readFileSync(new URL('../k210/boot.py',import.meta.url),'utf8');
  const functions=script.slice(script.indexOf('def crc8'),script.indexOf('def light'));
  const program=functions+`
f=bytearray(12);f[0]=0x52;f[1]=0x4B;f[2]=1;f[3]=7;f[4]=1
x,y,w,h=48,132,64,72
f[5]=byte((x+w/2)*255/320);f[6]=byte((y+h/2)*255/240);f[7]=byte(w*255/320);f[8]=byte(h*255/240);f[9]=min(100,byte(0.9*100));f[10]=byte(55);f[11]=crc8(f,2,11)
print(bytes(f).hex())`;
  let hex;try{hex=execFileSync('python3',['-I','-c',program],{encoding:'utf8'}).trim();}catch(error){if(error.code==='ENOENT'){t.skip('python3 not installed');return;}throw error;}
  assert.equal(hex,Buffer.from(encodeFrame({seq:7,faces:1,x:(48+32)/320,y:(132+36)/240,w:64/320,h:72/240,score:.9,ms:55})).toString('hex'));
  assert.match(script,/frame\[0\] = 0x52\s+frame\[1\] = 0x4B\s+frame\[2\] = 1\b/,'the script begins every frame with R, K and the version');
  assert.match(script,/UART\(UART\.UART1, 115200,/,'at the speed the robot listens at');assert.equal(K210_BAUD,115200);
});
// The camera's script, whole, run on the Mac with pretend MaixPy modules (firmware/k210/pretend-maixpy.py): from its
// first line to the loop, and every byte it sends read by the robot's own parser. What is NOT proved here: that the
// real MaixPy has these calls with these arguments (they are M5Stack's and Sipeed's examples), and the pictures.
const camera=async(t,scenario)=>{
  const {execFileSync}=await import('node:child_process'),{fileURLToPath}=await import('node:url');
  const file=name=>fileURLToPath(new URL('../k210/'+name,import.meta.url));
  try{return JSON.parse(execFileSync('python3',['-I','-B',file('pretend-maixpy.py'),file('boot.py'),JSON.stringify(scenario)],{encoding:'utf8',maxBuffer:1<<22}));}
  catch(error){if(error.code==='ENOENT'){t.skip('python3 not installed');return undefined;}throw error;}
};
const read=(hex,piece=64)=>{const c=collect(),bytes=Buffer.from(hex,'hex');for(let at=0;at<bytes.length;at+=piece)c.parser.push(bytes.subarray(at,at+piece));return c;};
test('the camera\'s script runs whole (pretend MaixPy): 300 pictures, every frame read by the robot, none lost across the wrap of the picture number',async t=>{
  // A picture with nobody, one with a face, one with two (the larger is told), one with a face over the edge; then again.
  const kinds=[[],[[48,132,64,72,.9]],[[10,10,20,20,.6],[100,60,120,150,.95]],[[300,220,40,40,.7]]];
  const out=await camera(t,{pictures:Array.from({length:300},(_,n)=>kinds[n%4]),ms:50});if(!out)return;
  assert.equal(out.printed,'','no fault said on the camera\'s console');assert.equal(out.taken,300);
  assert.equal(out.hex.length,300*K210_FRAME*2,'twelve bytes a picture, with a face or without: the small pictures are off (23 Nov 2026)');
  const {got,parser}=read(out.hex);
  assert.equal(got.length,300);assert.equal(parser.bad,0);assert.equal(parser.noise,0);assert.equal(parser.lost,0,'the number goes 0…255 and round again');
  const expected=kinds.map((faces,n)=>{
    const best=faces.reduce((a,b)=>!a||b[2]*b[3]>a[2]*a[3]?b:a,undefined);
    return read(Buffer.from(encodeFrame(best?{seq:n,faces:faces.length,x:(best[0]+best[2]/2)/320,y:(best[1]+best[3]/2)/240,w:best[2]/320,h:best[3]/240,score:best[4],ms:50}:{seq:n,ms:50})).toString('hex')).got[0];
  });
  for(const n of [0,1,2,3,256,257,258,259])assert.deepEqual(got[n],{...expected[n%4],seq:n&255},'picture '+n);
  assert.equal(got[2].faces,2);assert.ok(near(got[2].w,120/320)&&near(got[2].score,.95),'of two faces, the larger');
  assert.ok(got[3].x<=1&&got[3].y<=1,'a face over the edge stays inside the byte');
  // What it asked of the camera: one wire to send on, the line as the robot listens to it, the face model.
  const call=name=>out.calls.filter(c=>c[0]===name);
  assert.deepEqual(call('fm.register'),[['fm.register',[35,'UART1_TX'],{force:true}]],'one pin, to send: nothing is read from the robot');
  assert.deepEqual(call('UART')[0][1],['UART1',K210_BAUD,8,0,0],'8 bits, no parity, one stop bit (MaixPy reads stop 0 as 1)');
  assert.deepEqual(call('sensor.set_framesize')[0][1],['QVGA']);assert.deepEqual(call('kpu.load')[0][1],[0x300000]);
  assert.equal(call('kpu.init_yolo2')[0][1][4].length,10,'five pairs of anchors');
  assert.deepEqual(out.lights,[[8,8,8,8],[8,0,0,0]],'the small light on, then off after the first twenty pictures, and never red');
});
test('the camera\'s script without the face model: nothing is sent, a red light and the reason on its console',async t=>{
  const out=await camera(t,{pictures:[[]],noModel:true});if(!out)return;
  assert.equal(out.hex,'');assert.match(out.printed,/^robottino k210: /);assert.deepEqual(out.lights.at(-1),[8,40,0,0]);
});
test('the camera\'s script on a camera without the light module: the frames leave all the same',async t=>{
  const out=await camera(t,{pictures:[[],[[48,132,64,72,.9]]],noLight:true});if(!out)return;
  assert.equal(out.printed,'');assert.deepEqual(read(out.hex).got.map(f=>f.faces),[0,1]);assert.deepEqual(out.lights,[]);
});

test('the K210\'s face in the robot camera\'s picture (23 Nov 2026): the middle stays the middle, off the middle further out (wider field), never beyond the edge; nothing without a face',()=>{
  const cam={x:1.01,y:.79};
  assert.deepEqual(k210View({faces:1,x:.5,y:.5,w:.1},cam),{x:.5,y:.5,size:.1*K210_FOV.m12.x/cam.x});
  const v=k210View({faces:1,x:.3,y:.7,w:.1},cam);
  assert.ok(Math.abs(v.x-(.5-.2*K210_FOV.m12.x/cam.x))<1e-12&&Math.abs(v.y-(.5+.2*K210_FOV.m12.y/cam.y))<1e-12);
  assert.deepEqual([k210View({faces:1,x:0,y:1,w:.1},cam).x,k210View({faces:1,x:0,y:1,w:.1},cam).y],[0,1]);
  assert.equal(k210View({faces:0,x:.5,y:.5,w:0},cam),undefined);assert.equal(k210View(undefined,cam),undefined);
});

test('the small picture for the app\'s Live (23 Nov 2026): the camera\'s script cuts it in pieces after its faces, the robot puts it together whole, in front the room for its header',async t=>{
  const out=await camera(t,{pictures:Array.from({length:12},()=>[[48,132,64,72,.9]]),jpeg:250,picturesOn:true});if(!out)return;
  assert.equal(out.printed,'');
  const images=[],c=collect(),parts=new K210Images(buffer=>images.push(buffer));
  const parser=new K210Parser(frame=>c.got.push({...frame}),(...piece)=>parts.piece(...piece));
  const bytes=Buffer.from(out.hex,'hex');for(let at=0;at<bytes.length;at+=50)parser.push(bytes.subarray(at,at+50));
  assert.equal(c.got.length,12,'every face frame still read');assert.equal(parser.bad,0);assert.equal(parser.noise,0);
  // 250 bytes: 7 pieces (six of 40, one of 10), one after each look: a picture every seven looks.
  assert.equal(parser.pieces,12);assert.equal(images.length,1);
  // Never more than 12 + 8 + 40 bytes after a look (the robot's line keeps 128).
  assert.equal(bytes.length,12*12+12*8+6*40+10+5*40);
  const first=new Uint8Array(images[0]);assert.equal(first.length,K210_IMAGE.head+250);
  assert.deepEqual([...first.subarray(K210_IMAGE.head,K210_IMAGE.head+3)],[0xFF,0xD8,0],'the JPEG after the room for the header');
  assert.deepEqual([...first.subarray(-2)],[0xFF,0xD9]);
  assert.deepEqual(out.calls.filter(x=>x[0]==='image.resize')[0][1],[160,120]);
  // The robot's JPEG frame takes it as it is (live-wire.js).
  const {jpegFrame,JPEG_HEAD}=await import('./live-wire.js');assert.equal(JPEG_HEAD,K210_IMAGE.head);
  const big=await camera(t,{pictures:Array.from({length:10},()=>[]),jpeg:300,picturesOn:true});
  const bigParts=[],p2=new K210Images(buffer=>bigParts.push(buffer)),r2=new K210Parser(()=>{},(...piece)=>p2.piece(...piece));r2.push(Buffer.from(big.hex,'hex'));
  assert.ok(bigParts.length>=1);assert.equal(jpegFrame(bigParts[0],1,160,120).byteLength,K210_IMAGE.head+300);
  // A MaixPy that cannot make the picture smaller: the faces go on, the reason on its console.
  const old=await camera(t,{pictures:[[],[[48,132,64,72,.9]]],noResize:true,picturesOn:true});
  assert.deepEqual(read(old.hex).got.map(f=>f.faces),[0,1]);assert.match(old.printed,/robottino k210 picture: /);
});
test('pieces of a picture: one lost, that picture is not given (broken) and the next is whole; damaged pieces are skipped and the faces around them read',()=>{
  const jpeg=new Uint8Array(200);jpeg[0]=0xFF;jpeg[1]=0xD8;jpeg[198]=0xFF;jpeg[199]=0xD9;
  const P=K210_IMAGE.piece,n=Math.ceil(200/P);
  const cut=(number)=>Array.from({length:n},(_,index)=>encodePiece({number,index,count:n,bytes:jpeg.subarray(index*P,Math.min(200,index*P+P))}));
  const images=[],parts=new K210Images(buffer=>images.push(buffer)),faces=[];
  const parser=new K210Parser(frame=>faces.push(frame.seq),(...piece)=>parts.piece(...piece));
  const first=cut(1);parser.push(first[0]);parser.push(encodeFrame({seq:1}));for(const p of first.slice(2))parser.push(p); // piece 1 lost
  for(const p of cut(2))parser.push(p);
  assert.equal(images.length,1);assert.equal(parts.broken,1);assert.equal(new Uint8Array(images[0]).length,12+200);
  const bad=cut(3)[1].slice();bad[20]^=1;parser.push(bad);parser.push(encodeFrame({seq:2}));
  assert.deepEqual(faces,[1,2]);assert.ok(parser.bad>=1);
  // A length that cannot be: taken as noise, the face frame after it is read.
  parser.push(Uint8Array.from([0x52,0x4A,1,0,0,1,200]));parser.push(encodeFrame({seq:3}));assert.deepEqual(faces,[1,2,3]);
});

test('the camera\'s script with its pictures turned by 90° (23 Nov 2026: held upright the camera sees faces on their side): each picture turned and made ready for the face finder before it looks',async t=>{
  const out=await camera(t,{pictures:[[],[[48,132,64,72,.9]]],rotate:90});if(!out)return;
  assert.equal(out.printed,'');assert.deepEqual(read(out.hex).got.map(f=>[f.faces,f.ms]),[[0,115],[1,115]],'the 65 ms of the turn counted in the time of each picture');
  assert.deepEqual(out.calls.filter(c=>c[0].startsWith('image.')).map(c=>c[0]),['image.rotation_corr','image.pix_to_ai','image.rotation_corr','image.pix_to_ai']);
  assert.equal(out.calls.find(c=>c[0]==='image.rotation_corr')[2].z_rotation,90);
  const plain=await camera(t,{pictures:[[]]});assert.equal(plain.calls.some(c=>c[0]==='image.rotation_corr'),false,'ROTATE 0: not turned');
});
