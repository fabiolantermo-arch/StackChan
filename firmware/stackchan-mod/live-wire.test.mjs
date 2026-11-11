import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DeviceCommands,encodeMedia,decodeMedia,screenPixels,audiblePCM,pcmMouthLevel,cameraChunks,greyChunks,windowChunks,SMALL_PIECES,CALL_PIECE,CALL_PIECE_MAX,CallPacker,encodeCallAudio,callAudioLength,decodeCallAudio} from './live-wire.js';
function fixture(overrides={}){
  const events=[],acks=[];const io=Object.fromEntries(['camera','call','screen','motion','face','dance','stop','audio','image'].map(name=>[name,value=>{events.push([name,value]);}]));
  const device=new DeviceCommands({...io,...overrides},value=>acks.push(value));return {device,events,acks};
}
test('live dispatcher starts and stops camera, call and screen only on commands',async()=>{
  const h=fixture();assert.equal(h.events.length,0);
  for(const action of ['camera.start','camera.stop','call.start','call.stop','screen.start','screen.stop'])await h.device.command({id:action,action});
  assert.deepEqual(h.events.map(([name,value])=>[name,value]),[['camera',true],['camera',false],['call',true],['call',false],['screen',true],['screen',false]]);
  assert.equal(h.acks.length,6);assert.ok(h.acks.every(ack=>ack.ok));
});
test('live dispatcher bounds physical poses and mirrors numeric face without video',async()=>{
  const h=fixture();await h.device.command({id:'a',action:'mirror',yaw:2,pitch:-3,leftEye:.2,rightEye:.8,mouth:.5,followHead:true});
  assert.deepEqual(h.events.map(([name])=>name),['face','motion']);
  for(const pose of [{yaw:91,pitch:0},{yaw:-91,pitch:0},{yaw:0,pitch:1},{yaw:0,pitch:-86},{yaw:NaN,pitch:0}])await h.device.command({id:'bad',action:'motion',...pose});
  assert.equal(h.events.length,2);assert.equal(h.acks.at(-1).ok,false);
  await h.device.command({id:'badmirror',action:'mirror',yaw:11,pitch:0,leftEye:.2,rightEye:.8,mouth:.5,followHead:true});assert.equal(h.events.length,2,'the mirror stays within 10°');
  await h.device.command({id:'wide',action:'motion',yaw:90,pitch:-85});assert.deepEqual(h.events.at(-1)[0],'motion','90° sideways and 85° up from the iPhone');h.events.pop();
  await h.device.command({id:'badface',action:'mirror',yaw:0,pitch:0,leftEye:-1,rightEye:1,mouth:0,followHead:true});assert.equal(h.events.length,2);
});
test('live STOP cancels late ACKs and closing prevents new hardware actions',async()=>{
  let resolve;const h=fixture({camera:()=>new Promise(done=>{resolve=done;})});
  const waiting=h.device.command({id:'slow',action:'camera.start'});
  await h.device.command({id:'busy',action:'screen.start'});assert.equal(h.acks.at(-1).ok,false);
  await h.device.command({id:'halt',action:'stop'});resolve();await waiting;
  assert.deepEqual(h.acks.map(ack=>ack.id),['busy','halt']);
  h.device.close();const count=h.events.length;await h.device.command({id:'later',action:'call.start'});assert.equal(h.events.length,count);
});
test('live binary media enforces format, direction, maximum size and replay protection',()=>{
  const h=fixture(),image=encodeMedia(2,1,new Uint8Array(38400).buffer,160,120);
  assert.equal(image.byteLength,38412);h.device.media(image);assert.equal(h.events[0][0],'image');
  const pcm=encodeMedia(3,2,new Uint8Array(640).buffer);h.device.media(pcm);assert.equal(h.events[1][0],'audio');
  assert.throws(()=>h.device.media(pcm),/replay/);
  assert.throws(()=>decodeMedia(encodeMedia(1,3,new Uint8Array(8).buffer,2,2)),/invalid_image/);
  assert.throws(()=>decodeMedia(encodeMedia(2,3,new Uint8Array(38640).buffer,161,120)),/invalid_image/);
  assert.throws(()=>decodeMedia(encodeMedia(3,3,new Uint8Array(3).buffer)),/invalid_audio/);
  assert.throws(()=>decodeMedia(encodeMedia(3,0,new Uint8Array(2).buffer)),/invalid_media/);
});
test('hardware failures ACK rejection; stop failure and close never leak a rejection',async()=>{
  const h=fixture({call:()=>{throw Error('hardware');},stop:()=>{throw Error('stop');}});
  await h.device.command({id:'call',action:'call.start'});await h.device.command({id:'stop',action:'stop'});h.device.close();
  assert.deepEqual(h.acks,[{type:'ack',id:'call',ok:false},{type:'ack',id:'stop',ok:false}]);
});

test('screen raster doubles pixels to 320x240 and converts the display byte order',()=>{
  const payload=new Uint8Array([0x00,0xf8,0xe0,0x07]).buffer;
  assert.deepEqual([...new Uint8Array(screenPixels({width:2,height:1,payload},true))],[0xf8,0,0xf8,0,7,0xe0,7,0xe0,0xf8,0,0xf8,0,7,0xe0,7,0xe0]);
  assert.equal(screenPixels({width:160,height:120,payload:new ArrayBuffer(38400)}).byteLength,153600);
});

test('silence never permanently mutes the robot microphone during a phone call',()=>{
  assert.equal(audiblePCM(new ArrayBuffer(640)),false);
  assert.equal(audiblePCM(new Uint8Array([0xff,0xff,1,0]).buffer),false);
  assert.equal(audiblePCM(new Uint8Array([0x00,0x10,0x00,0xf0]).buffer),true);
});

test('320x240 camera frames go in 4 KB pieces, built one at a time, and round-trip every byte',()=>{
  const pixels=Uint8Array.from({length:153600},(_,index)=>index%251);let sequence=0;
  const pieces=cameraChunks(7,pixels.buffer,320,240,()=>++sequence);assert.equal(sequence,0,'nothing built before it is asked for');
  pieces.next();assert.equal(sequence,1,'one piece at a time');
  const chunks=[...cameraChunks(7,pixels.buffer,320,240,()=>++sequence)];sequence-=1;assert.equal(chunks.length,38);
  const restored=new Uint8Array(153600);let offset=0;
  for(const chunk of chunks){assert.ok(chunk.byteLength<=20+4096);const view=new DataView(chunk);assert.equal(view.getUint8(3),4);assert.equal(view.getUint16(8),320);assert.equal(view.getUint16(10),240);assert.equal(view.getUint32(12),7);assert.equal(view.getUint32(16),offset);const body=new Uint8Array(chunk,20);restored.set(body,offset);offset+=body.length;}
  assert.deepEqual(restored,pixels);assert.equal(sequence,38);
  assert.throws(()=>cameraChunks(1,new ArrayBuffer(2),320,240,()=>1),/invalid_camera_frame/);
});
test('face style accepts only the two supported options',async()=>{
  const h=fixture({faceStyle:value=>h.events.push(['style',value])});
  await h.device.command({id:'style',action:'face.style',style:'white'});assert.equal(h.acks.at(-1).ok,true);
  await h.device.command({id:'style2',action:'face.style',style:'redhead'});assert.equal(h.acks.at(-1).ok,true);
  await h.device.command({id:'invalid',action:'face.style',style:'other'});assert.equal(h.acks.at(-1).ok,false);
});

test('live dispatcher forwards only bounded dances with known fields',async()=>{
  const h=fixture(),step={yaw:5,pitch:-5,durationMs:800,expression:'happy',extra:1};
  await h.device.command({id:'d',action:'dance',steps:[step]});
  assert.deepEqual(h.events,[['dance',[{yaw:5,pitch:-5,durationMs:800,expression:'happy'}]]]);assert.equal(h.acks.at(-1).ok,true);
  for(const steps of [[],[{...step,yaw:12}],[{...step,durationMs:100}],[{...step,expression:'x'}],Array(33).fill(step),Array(13).fill({...step,durationMs:5000})])
    await h.device.command({id:'bad',action:'dance',steps});
  assert.equal(h.events.length,1);assert.equal(h.acks.at(-1).ok,false);
});
test('full-resolution screen images arrive in pieces and are rebuilt once, without doubling',()=>{
  const width=320,height=240,image=new Uint8Array(width*height*2);for(let i=0;i<image.length;i++)image[i]=i%251;
  const pieces=[];let sequence=0;
  for(let offset=0;offset<image.length;offset+=32768){const count=Math.min(32768,image.length-offset),body=new ArrayBuffer(8+count),view=new DataView(body);view.setUint32(0,7);view.setUint32(4,offset);new Uint8Array(body,8).set(image.subarray(offset,offset+count));pieces.push(encodeMedia(5,++sequence,body,width,height));}
  assert.equal(pieces.length,5);
  const shown=[];const commands=new DeviceCommands({image(frame){shown.push(frame);}},()=>{});
  for(const piece of pieces.slice(0,4))commands.media(piece);assert.equal(shown.length,0,'incomplete image is never shown');
  commands.media(pieces[4]);assert.equal(shown.length,1);
  assert.deepEqual([shown[0].width,shown[0].height,shown[0].scale],[320,240,1]);
  assert.deepEqual(new Uint8Array(screenPixels(shown[0])),image,'little-endian: shown as received');
  assert.equal(screenPixels(shown[0],true).byteLength,153600);
  const bad=new ArrayBuffer(16),view=new DataView(bad);view.setUint32(0,1);view.setUint32(4,153598);
  assert.throws(()=>decodeMedia(encodeMedia(5,9,bad,320,240)),/invalid_image/,'a piece past the end is rejected');
});

test('mouth level reads a view in place and only its own samples',()=>{
  const samples=new Int16Array([0,0,6000,6000,0,0]);
  assert.equal(pcmMouthLevel(new Uint8Array(samples.buffer,4,4)),.8);
  assert.equal(pcmMouthLevel(new Uint8Array(samples.buffer,8,4)),0);
  assert.equal(pcmMouthLevel(samples.buffer),pcmMouthLevel(new Uint8Array(samples.buffer)));
});
test('an explicit STOP is an emergency; a link that closes is not (the robot keeps its motions on)',async()=>{
  const h=fixture();await h.device.command({id:'halt',action:'stop'});assert.deepEqual(h.events.at(-1),['stop',true]);
  assert.deepEqual(h.acks,[{type:'ack',id:'halt',ok:true}],'a STOP that stopped everything is answered as done, once (until 10 Nov 2026: as failed)');
  h.device.close();assert.deepEqual(h.events.at(-1),['stop',undefined]);
});
test('the small following image: 80×60 grey cut from a window of the camera frame, three pieces made one at a time (10 Nov 2026)',()=>{
  const frame=new Uint16Array(160*120);let seed=7;for(let i=0;i<frame.length;i++){seed=(seed*1103515245+12345)>>>0;frame[i]=seed>>>16;}
  // The same grey read slowly: the green of the 2×2 block at each place, added up.
  const slow=(x0,y0,step)=>{const out=new Uint8Array(80*60);for(let y=0;y<60;y++)for(let x=0;x<80;x++){const i=(y0+Math.floor(y*step/2))*160+x0+Math.floor(x*step/2);out[y*80+x]=((frame[i]&0x7E0)+(frame[i+1]&0x7E0)+(frame[i+160]&0x7E0)+(frame[i+161]&0x7E0))>>5;}return out;};
  const image=(x0,y0,step,id=5)=>{
    let sequence=40;const made=windowChunks(id,frame.buffer,160,120,x0,y0,step,()=>++sequence);
    assert.equal(sequence,40,'nothing converted before it is asked for');
    const first=made.next().value;assert.equal(sequence,41,'one piece at a time');
    const all=[first,...made];assert.equal(all.length,SMALL_PIECES);assert.equal(all.length,3);
    const pixels=new Uint8Array(80*60);
    for(const [k,piece] of all.entries()){
      const view=new DataView(piece);assert.equal(piece.byteLength,1620,'20 rows and the header: three of them fit what the connection sends in one go');
      assert.equal(view.getUint16(0),0x5242);assert.equal(view.getUint8(2),1);assert.equal(view.getUint8(3),6,'grey');assert.equal(view.getUint32(4),41+k);
      assert.equal(view.getUint16(8),80);assert.equal(view.getUint16(10),60);assert.equal(view.getUint32(12),id);assert.equal(view.getUint32(16),k*1600);
      pixels.set(new Uint8Array(piece,20),k*1600);
    }
    return pixels;
  };
  assert.deepEqual([...image(0,0,4)],[...slow(0,0,4)],'step 4: the whole frame halved');
  for(const [x0,y0] of [[0,0],[40,30],[17,9],[20,15]])assert.deepEqual([...image(x0,y0,3)],[...slow(x0,y0,3)],`step 3: the 120×90 window at ${x0},${y0}`);
  // Full green everywhere gives 252, the same scale as the whole grey frame.
  const green=new Uint16Array(160*120).fill(0x07E0),piece=windowChunks(1,green.buffer,160,120,40,30,3,()=>1).next().value;
  assert.ok(new Uint8Array(piece,20).every(value=>value===252));
  // Only a window inside the frame, only the two known steps.
  for(const [x0,y0,step] of [[41,30,3],[40,31,3],[1,0,4],[0,1,4],[-1,0,3],[0,0,2],[0,0,5],[.5,0,3]])assert.throws(()=>windowChunks(1,frame.buffer,160,120,x0,y0,step,()=>1),/invalid_camera_frame/,`${x0},${y0} step ${step}`);
  assert.throws(()=>windowChunks(0,frame.buffer,160,120,0,0,3,()=>1),/invalid_camera_frame/);
  assert.throws(()=>windowChunks(1,new ArrayBuffer(160*120),160,120,0,0,3,()=>1),/invalid_camera_frame/,'a frame shorter than two bytes a pixel');
  assert.throws(()=>windowChunks(1,new ArrayBuffer(8),2,2,0,0,3,()=>1),/invalid_camera_frame/,'a frame smaller than the window');
});
test('grey pieces are kind 6, one byte per pixel, up to 160×120',()=>{
  const grey=new Uint8Array(4800).fill(7);let sequence=0;
  const pieces=[...cameraChunks(3,grey.buffer,80,60,()=>++sequence,6)];assert.equal(pieces.length,2);
  assert.equal(new DataView(pieces[0]).getUint8(3),6);assert.equal(new DataView(pieces[1]).getUint32(16),4096);
  assert.throws(()=>cameraChunks(3,new ArrayBuffer(9600),80,60,()=>1,6),/invalid_camera_frame/,'grey is one byte per pixel');
  assert.throws(()=>cameraChunks(3,new ArrayBuffer(161*120),161,120,()=>1,6),/invalid_camera_frame/,'grey up to 160×120');
});
test('following at full resolution: 160×120 grey pieces of 4 KB made one at a time from the camera frame (10 Nov 2026)',()=>{
  const frame=new Uint16Array(160*120);let seed=11;for(let i=0;i<frame.length;i++){seed=(seed*1103515245+12345)>>>0;frame[i]=seed>>>16;}
  let sequence=0;const pieces=greyChunks(9,frame.buffer,160,120,()=>++sequence);
  assert.equal(sequence,0,'nothing converted before it is asked for');
  const all=[...pieces];assert.equal(all.length,5);assert.equal(sequence,5);
  const rebuilt=new Uint8Array(160*120);
  for(const [k,piece] of all.entries()){
    const view=new DataView(piece);
    assert.equal(view.getUint16(0),0x5242);assert.equal(view.getUint8(3),6);assert.equal(view.getUint16(8),160);assert.equal(view.getUint16(10),120);
    assert.equal(view.getUint32(12),9);assert.equal(view.getUint32(16),k*4096);assert.ok(piece.byteLength-20<=4096,'within the relay limit for kind 6');
    rebuilt.set(new Uint8Array(piece,20),view.getUint32(16));
  }
  for(let i=0;i<frame.length;i++)if(rebuilt[i]!==((frame[i]&0x7E0)>>3))assert.fail('pixel '+i);
  // Same brightness scale as the 80×60 copy: four greens of 1 add up to 4, one green of 1 is 4.
  assert.deepEqual([...new Uint8Array([...greyChunks(1,Uint16Array.of(0x0020,0x07E0).buffer,2,1,()=>1)][0],20)],[4,252]);
  assert.throws(()=>greyChunks(1,new ArrayBuffer(4),2,2,()=>1),/invalid_camera_frame/);
  assert.throws(()=>greyChunks(1,new ArrayBuffer(320*240*2),320,240,()=>1),/invalid_camera_frame/,'up to 160×120');
});
// Audio of the Live call (10 Nov 2026). The values marked «as the app» are the same in ios/test-connection.swift.
const callPayload=law=>Uint8Array.of(0xB1,0x08,...law).buffer;
const packed=(reads,packer=new CallPacker())=>{const pieces=[];for(const read of reads)packer.add(read,piece=>pieces.push(Uint8Array.from(piece)));return pieces;};
const steady=value=>[...packed([new Int16Array(1600).fill(value).buffer])[0].slice(0,3)];
const heard=(law,state={last:0})=>[...new Int16Array(decodeCallAudio(callPayload(law),state).buffer)];
test('call audio: 8 kHz µ-law in pieces of a tenth of a second, the same values as the app',()=>{
  // A tenth of a second of silence at 16 kHz (3200 bytes) is one piece of 800 bytes, all 0xFF.
  const silent=packed([new ArrayBuffer(3200)]);assert.equal(silent.length,1);assert.equal(silent[0].length,CALL_PIECE);assert.ok(silent[0].every(byte=>byte===0xFF));
  // As the app: steady values (the first byte still feels the silence before, through the filter).
  assert.deepEqual(steady(1000),[0xD4,0xCE,0xCE]);assert.deepEqual(steady(-1000),[0x54,0x4E,0x4E]);
  assert.deepEqual(steady(32767),[0x87,0x80,0x80]);assert.deepEqual(steady(-32768),[0x07,0x00,0x00]);
  assert.deepEqual(steady(-1),[0x7F,0x7F,0x7F],'negative values round down, not towards zero');assert.deepEqual(steady(0),[0xFF,0xFF,0xFF]);
  // As the app: every µ-law sample comes back twice at 16 kHz, the first time halfway from the one before.
  assert.deepEqual(heard([0xCE,0xCE,0x4E,0x4E]),[494,988,988,988,0,-988,-988,-988]);
  assert.deepEqual(heard([0x80,0x00]),[16062,32124,0,-32124]);assert.deepEqual(heard([0xFF,0x7F]),[0,0,0,0]);
  // The last sample goes on to the next piece.
  const state={last:0};heard([0xCE,0xCE],state);assert.equal(state.last,988);assert.deepEqual(heard([0xCE,0xCE],state),[988,988,988,988]);
  // As the app: a fixed sequence of 3200 samples, all levels mixed.
  const samples=new Int16Array(3200);for(let i=0;i<3200;i++)samples[i]=((i*7919)%65536)-32768;
  const pieces=packed([samples.buffer]);let sum=0,mix=0;for(const piece of pieces)for(const byte of piece){sum+=byte;mix=(mix*31+byte)%65521;}
  assert.deepEqual([pieces.length,sum,mix,...pieces[0].slice(0,6)],[2,146413,4571,9,15,76,146,148,13]);
  const back={last:0};let total=0,mixed=0;for(const piece of pieces)for(const sample of heard(piece,back)){total+=sample;mixed=(mixed*31+(sample&0xFFFF))%65521;}
  assert.deepEqual([total,mixed,back.last],[-163170,7895,-4604]);
});
test('call audio: the µ-law tables agree with the textbook formulas, and a voice-like tone comes back nearly as it was',()=>{
  // Decoding, straight from the definition of G.711 µ-law.
  for(let code=0;code<256;code++){
    const u=~code&0xFF,magnitude=((((u&15)<<3)+132)<<((u>>4)&7))-132,expected=u&0x80?0-magnitude:magnitude;
    assert.equal(heard([code,code])[1],expected,'code '+code);
    // And every level encodes back to its own code (0x7F is the second zero: it becomes 0xFF).
    assert.equal(steady(expected)[2],code===0x7F?0xFF:code,'level '+expected);
  }
  // Encoding of any value: sign, 132 added, the place of the highest bit, four bits below it.
  for(let value=-32768;value<=32767;value+=37){
    let magnitude=Math.min(32635,Math.abs(value))+132;const exponent=Math.max(0,24-Math.clz32(magnitude)),code=~((value<0?0x80:0)|exponent<<4|(magnitude>>(exponent+3))&15)&0xFF;
    assert.equal(steady(value)[2],code,'value '+value);
  }
  // 440 Hz at a speaking level: what the robot plays is within 4% of what the iPhone's microphone heard
  // (one sample later: the filter looks one sample ahead).
  const tone=new Int16Array(3200);for(let i=0;i<3200;i++)tone[i]=Math.round(8000*Math.sin(2*Math.PI*440*i/16000));
  const state={last:0},back=packed([tone.buffer]).flatMap(piece=>heard(piece,state));assert.equal(back.length,3200);
  let error=0;for(let i=100;i<3200;i++)error+=(back[i]-tone[i-1])**2;
  assert.ok(Math.sqrt(error/3100)<320,'error '+Math.sqrt(error/3100));
});
test('call audio: reads of any size make the same pieces, an odd sample waits for the next read',()=>{
  const samples=new Int16Array(3200);for(let i=0;i<3200;i++)samples[i]=((i*7919)%65536)-32768;
  const whole=packed([samples.buffer]),cuts=[0,1,2,5,6,807,1600,1601,2999,3200],parts=[];
  for(let i=0;i+1<cuts.length;i++)parts.push(samples.slice(cuts[i],cuts[i+1]).buffer);
  assert.deepEqual(packed([new ArrayBuffer(0),...parts]),whole);
  // A view is read in place, also from an odd byte; a stray last byte is left out.
  const bytes=new Uint8Array(6401);bytes.set(new Uint8Array(samples.buffer),1);
  assert.deepEqual(packed([new Uint8Array(bytes.buffer,1,6400)]),whole);assert.deepEqual(packed([new Uint8Array(bytes.buffer,1,3200),bytes.slice(3201,6401)]),whole);
  const odd=new Uint8Array(3203).fill(0);assert.equal(packed([odd.buffer]).length,1);
  // clear() forgets the piece begun and the odd sample: after a pause the sound starts clean.
  const packer=new CallPacker();assert.equal(packed([samples.slice(0,1001).buffer],packer).length,0);packer.clear();
  assert.deepEqual(packed([samples.buffer],packer),whole);
});
test('call audio: the message is a type-3 one with the marker; anything else is not call audio',()=>{
  const law=new Uint8Array(CALL_PIECE).fill(0xCE),message=encodeCallAudio(7,law);
  assert.equal(message.byteLength,12+2+CALL_PIECE);assert.deepEqual([...new Uint8Array(message,0,14)],[0x52,0x42,1,3,0,0,0,7,0,0,0,0,0xB1,0x08]);
  const frame=decodeMedia(message);assert.equal(frame.kind,3);assert.equal(frame.sequence,7);assert.equal(callAudioLength(frame.payload),CALL_PIECE);
  const h=fixture();h.device.media(message);assert.equal(h.events[0][0],'audio');assert.equal(callAudioLength(h.events[0][1]),CALL_PIECE);
  assert.equal(callAudioLength(callPayload(new Uint8Array(CALL_PIECE_MAX))),CALL_PIECE_MAX);assert.equal(callAudioLength(callPayload([0xFF,0xFF])),2);
  assert.equal(callAudioLength(new ArrayBuffer(640)),0,'the 16 kHz PCM16 of before 10 Nov 2026');
  assert.equal(callAudioLength(callPayload([])),0);assert.equal(callAudioLength(callPayload([0xFF,0xFF,0xFF])),0,'an even number of bytes');
  assert.equal(callAudioLength(callPayload(new Uint8Array(CALL_PIECE_MAX+2))),0,'at most 0.2 s a piece');
  assert.equal(callAudioLength(Uint8Array.of(0xB1,0x09,0xFF,0xFF).buffer),0);assert.equal(callAudioLength(Uint8Array.of(0xB0,0x08,0xFF,0xFF).buffer),0);
  assert.equal(callAudioLength(new ArrayBuffer(0)),0);
});
