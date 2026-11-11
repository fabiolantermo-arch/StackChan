import {Client,lowLatency} from 'robottino-socket';
import Preference from 'preference';
import Timer from 'timer';
import Time from 'time';
import AudioIn from 'embedded:io/audio/in';
import AudioOut from 'embedded:io/audio/out';
import {Container} from 'piu/MC';
import RuntimeBitmapPort from 'runtime-bitmap-port';
import config from 'mc/config';
import Bitmap from 'commodetto/Bitmap';
import {DeviceCommands,screenPixels,pcmMouthLevel,cameraChunks,pictureChunks,greyChunks,windowChunks,SMALL_PIECES,CAMERA_PIECE,CallPacker,encodeCallAudio,callAudioLength,decodeCallAudio} from 'robottino-live-wire';
import {FaceLock,FRAME_WIDTH,FRAME_HEIGHT} from 'robottino-tracker';

// Face following. Until the iPhone has found the face: the whole 160×120 frame in grey (19.2 KB, five pieces), at
// most every 150 ms. Once it has: an 80×60 image of the part of the frame where the face must be (4.8 KB, three
// pieces; tracker.js FaceLock chooses it and puts the answers back in whole-frame coordinates), at most every
// 250 ms. Why (measured 10 Nov 2026): the robot's connection sends 5.7 KB and then waits for the network, 130-190 ms
// on the hotspot, so the whole frame takes about a second and the head got one answer a second; the small image
// leaves in one go, and is taken when the connection has room for all of it (SMALL_ROOM; after 600 ms anyway).
// Measured on the robot with the small image (10 Nov 2026): a frame every 0.6 s, and the answer is back 0.6-0.8 s
// after the frame was taken (0.3 s to take, convert and write it, the rest is network: the iPhone answers one frame
// at a time and looks at the next only once the robot has confirmed its answer, about half a second on the
// hotspot), so about one answer a second. Taking the next frame as soon as there was room for its first piece was
// tried: 2.0 frames a second instead of 1.7 and no more answers than chance gives, because the camera had no new
// image yet (it needs about 0.2 s after the last one goes back) and its capture then held the whole robot for up to
// 0.23 s. With the head moving nothing changes anyway: the frame waits for the head to be still.
// A frame starts only once the previous one has left: a slow network gets fewer frames, never a queue. The head
// pose and the window of the last 8 frames are kept, so a late answer from the iPhone still says where the face
// was (tracker.js aim).
// During a conversation (face following with the iPhone open, 9 Nov 2026) the frames are at least 250 ms apart
// and, while the robot listens, never whole: the voice comes first for memory, processor and network.
// A piece is written only when nothing waits in the socket (SEND_BACKLOG 0). WebSocket.js keeps unsent data in the
// robot's fixed JavaScript memory (9 Nov 2026: a whole 320×240 frame queued at once restarted the robot), and the
// answers to the iPhone's commands queue behind it: the relay closes everything when an answer takes over 1.5 s,
// which happened on the hotspot (about 20 KB/s) with 16 KB of pieces ahead, and each forced close was followed by
// a restart of the robot. Now an answer waits behind one 4 KB piece at most.
const SEND_BACKLOG=0,VIDEO_FRAME_MS=333,PUMP_MS=25;
// Live call (live-wire.js, 10 Nov 2026): 8 kHz µ-law, a piece of 800 bytes every tenth of a second, 8 KB a second
// each way. With 16 kHz PCM16 (32 KB a second each way, in 640-byte pieces) the robot took in 8-25 KB a second and
// got 40-63% of its own microphone out: its link carries 30-35 KB a second in all.
// A piece from the microphone is dropped while more than two wait to be handed to the connection: by then the
// connection itself holds over a second of sound that the network has not taken. Before (9 Nov 2026) audio piled up
// in the fixed JavaScript memory until the robot restarted.
// With the camera on (a call while the robot follows a face, or with the video) a piece of image larger than the
// room left in the connection leaves in two parts, and its rest waits here: up to 4.1 KB that are image, not sound
// held up. So the limit is one piece of image higher, still two pieces of sound: with the limit of the call alone
// the microphone lost a piece every time an image was leaving. The image never waits behind sound (SEND_BACKLOG).
const CALL_BACKLOG=1600,CALL_CAMERA_BACKLOG=CALL_BACKLOG+CAMERA_PIECE+32;
// Sound from the iPhone waiting for the speaker: 0.4 s at most (16 kHz PCM16), then new pieces are dropped. Pieces
// are a tenth of a second and the hotspot delivers them in groups.
const CALL_PLAY_QUEUE=12800;
// The link ends when nothing has come from the server for this long. The robot sends a ping every 5 s and the
// server answers each one, so silence means that the way from the server is blocked (10 Nov 2026: with the
// iPhone's audio queued on that way the robot learnt that the app had gone about 70 s later, and kept its
// microphone open meanwhile; once nothing at all came for a minute). A new link is then made as after any close.
const LINK_SILENCE_MS=12000;
// What the call's speaker plays when nothing has come from the iPhone: one block for the whole program, so that
// silence makes no new memory 60 times a second.
const SILENCE=new Uint8Array(512);
// The host is busy for about a second while it starts or stops the camera (it also switches the touch panel off and
// on): a servo reply read that late looked lost and the 1.2 s check blocked the motions (9 Nov 2026, at the end of
// a conversation). So the camera first waits for the servos' confirmation (up to 1.5 s), and while it switches no
// head command starts (mod.js asks busy()). Shared by every link: an old link may still be stopping its camera.
const CAMERA_WAIT_MS=1500;let cameraSwitching=0;
// Following takes a frame only with the head still (mod.js headMoving: moving, then 150 ms to settle): a frame
// taken while the head turned at 3 rad/s was blurred and its pose up to 15° wrong. After 1 s without a frame, one
// is taken anyway.
// One camera size for following and video (9 Nov 2026): when the size changed, the host closed and rebuilt the
// camera and its camera task read freed memory (Guru Meditation in cameraLoop, camera.c), restarting the robot.
// 160×120 also suits the hotspot better: a colour frame is 38 KB instead of 153 KB.
const TRACK_SIZE={width:160,height:120},VIDEO_SIZE=TRACK_SIZE,TRACK_FRAME_MS=150,TRACK_VOICE_FRAME_MS=250,TRACK_POSES=8,TRACK_STILL_WAIT_MS=1000;
// Three pieces of the small image as the connection counts them (1620 bytes each plus about 37 of framing).
const TRACK_SMALL_FRAME_MS=250,SMALL_ROOM=5000,SMALL_ROOM_WAIT_MS=600;
export function createLiveDevice(robot,hooks){
  const lock=new FaceLock();
  let socket,controller,heartbeat,cameraTimer,captureBusy=false,cameraActive=false,cameraMode,following=false,framePoses=[],screenActive=false,closed=false,connected=false,seq=0,frameId=0,mediaGeneration=0;
  let microphone,speaker,releaseAudio,audioQueue=[],audioBytes=0,lastPlayback,screenPort,lastAudioMouth=0,heardAt;
  const playback={last:0};
  // The Wi-Fi stays awake (socket.js lowLatency) only while the camera or a call streams: at rest the host saves power.
  // With the app in (from peer.connected to the end of this link) the radio stays awake too: a head command from the
  // iPhone must be confirmed within 1.5 s or the relay closes everything, and with the radio asleep one was not
  // (10 Nov 2026, following with the iPhone's camera: «poi si è scollegato», command_timeout with the robot idle).
  let radio,appIn=false;
  const tuneRadio=()=>{const wanted=!closed&&(cameraActive||!!microphone||appIn);if(wanted&&!radio)radio=lowLatency();else if(!wanted&&radio){const held=radio;radio=undefined;held.close();}};
  // TEMPORARY (K151 bring-up): how fast following really goes, on the USB log every 5 s (frames sent, how many of
  // them small, answers from the iPhone, answers that came too late to be used, the longest and the average wait of a
  // small frame for the next answer).
  let followStats={frames:0,small:0,answers:0,late:0,wait:0,sum:0,waits:0,at:undefined};
  const followStat=(key,small=false,waited=0)=>{
    if(typeof trace!=='function')return;
    const stats=followStats;if(stats.at===undefined)stats.at=Time.ticks;stats[key]++;if(small)stats.small++;if(waited>stats.wait)stats.wait=waited;if(waited>0){stats.sum+=waited;stats.waits++;}
    if(Time.delta(stats.at)<5000)return;
    trace(`[robottino] follow frames=${stats.frames} small=${stats.small} answers=${stats.answers} late=${stats.late} wait=${stats.wait} mean=${stats.waits?Math.round(stats.sum/stats.waits):0} in ${Time.delta(stats.at)} ms\n`);
    followStats={frames:0,small:0,answers:0,late:0,wait:0,sum:0,waits:0,at:Time.ticks};
  };
  const verified=()=>Preference.get('robottino','verified')===true;
  const calibrated=()=>Preference.get('robottino','calibrated')===true;
  const send=value=>{if(connected&&!closed)socket.write(typeof value==='string'?value:JSON.stringify(value));};
  // TEMPORARY (K151 bring-up): errors that used to end the link without a word, on the USB log.
  const note=(where,error)=>{try{if(typeof trace==='function')trace(`[robottino] live ${where}: ${error}\n`);}catch{}};
  // A microphone or speaker callback that finds a problem ends the link from a timer, never from inside itself: an
  // audio driver must not be closed inside its own callback, and no error may leave the callback (see call below).
  // The iPhone sees the link close: a call that broke is never shown as going on.
  let failing;
  const failLater=(where,error)=>{try{if(failing!==undefined||closed)return;note(where,error);failing=Timer.set(()=>{failing=undefined;close();},0);}catch{}};
  // TEMPORARY (K151 bring-up, 10 Nov 2026): how a call really goes, on the USB log every 5 s and when it ends.
  // Microphone: callbacks, bytes read (16 kHz PCM16), the largest read (a full quarter of a second, 8192, means
  // JavaScript was late), bytes sent (µ-law: one for every four read), bytes not sent because the connection was full
  // (µ-law) or because the speaker was playing (PCM16). Speaker: bytes that came from the iPhone (µ-law), bytes
  // dropped because 0.4 s already waited (µ-law), pieces that were not call audio in this format, bytes played and
  // bytes of silence played instead (PCM16), write errors.
  let callStats;
  const showCall=()=>{
    const s=callStats;if(!s||typeof trace!=='function')return;
    trace(`[robottino] call mic=${s.reads} read=${s.read} most=${s.most} sent=${s.sent} full=${s.full} gated=${s.gated} heard=${s.heard} over=${s.over} bad=${s.bad} played=${s.played} silence=${s.silence} errors=${s.errors} in ${Time.delta(s.at)} ms\n`);
    s.reads=s.read=s.most=s.sent=s.full=s.gated=s.heard=s.over=s.bad=s.played=s.silence=0;s.at=Time.ticks;
  };
  const stopCall=()=>{
    if(callStats){try{showCall();}catch{}callStats=undefined;}
    try{microphone?.close();}catch{}microphone=undefined;try{speaker?.close();}catch{}speaker=undefined;tuneRadio();
    audioQueue=[];audioBytes=0;playback.last=0;lastPlayback=undefined;lastAudioMouth=0;try{releaseAudio?.();}catch{}releaseAudio=undefined;robot.face.setMouthOpen(0);
  };
  // One frame at a time, written piece by piece while the socket has room; the camera frame stays with the driver
  // until its last piece is written, then goes back.
  let sending;
  const finishFrame=()=>{const frame=sending?.frame;sending=undefined;captureBusy=false;try{frame?.close?.();}catch{}};
  const pumpFrame=()=>{
    while(sending){
      if(closed||!connected||!cameraActive||sending.generation!==mediaGeneration){finishFrame();return;}
      if((socket?.bufferedAmount??0)>SEND_BACKLOG)return;
      let next;try{const from=Time.ticks;next=sending.pieces.next();const made=Time.delta(from);if(!next.done){socket.write(next.value);socket.note?.('p',made,Time.delta(from)-made);}}catch{finishFrame();close();return;}
      if(next.done){finishFrame();return;}
      // Grey pieces are converted as they go (greyChunks, windowChunks): one per camera tick (25 ms), so the robot is
      // never busy converting a whole frame at once; the camera frame goes back as soon as the last one is written.
      if(sending.paced){if(--sending.paced<=0)finishFrame();return;}
    }
  };
  const servosConfirmed=async()=>{for(let waited=0;waited<CAMERA_WAIT_MS&&hooks.motionBusy?.();waited+=20)await new Promise(resolve=>Timer.set(resolve,20));};
  const switchCamera=async action=>{await servosConfirmed();cameraSwitching++;try{return await action();}finally{cameraSwitching--;}};
  // «Cos'è questo?» (11 Nov 2026): one colour picture for the conversation (voice-wire.js pictureChunks), given piece
  // by piece to `sink` (true: taken; false: no room now, the same piece is offered again; an error ends it). With the
  // camera already on (video, following) the next frame is used; otherwise the camera is switched on for this alone
  // (mode 'snap': nothing goes to the iPhone), lets the exposure settle and is switched off again. The camera frame
  // stays with the robot until its last piece has gone.
  const SNAP_WARM_MS=900,SNAP_MS=7000;let snap;
  const endSnap=ok=>{
    const done=snap;if(!done)return;snap=undefined;
    if(done.frame){try{done.frame.close?.();}catch{}captureBusy=false;}
    if(done.own&&cameraMode==='snap')void stopCamera().catch(()=>{});
    try{done.resolve(ok);}catch{}
  };
  const stopCamera=async()=>{if(snap){snap.own=false;endSnap(false);}cameraActive=false;cameraMode=undefined;mediaGeneration++;finishFrame();tuneRadio();if(cameraTimer!==undefined)Timer.clear(cameraTimer);cameraTimer=undefined;await switchCamera(()=>robot.camera?.stop());};
  const stopFollowing=()=>{if(!following)return;following=false;framePoses=[];lock.clear();hooks.follow?.(false);};
  // mode 'video': 160×120 colour every 333 ms; 'track': the same camera size in grey for following.
  const startCamera=async mode=>{
    if(cameraActive){if(cameraMode===mode)return;await stopCamera();}
    if(!verified()||robot.camera?.available===false||!robot.camera?.capture)throw Error('camera_unavailable');
    const options={...(mode==='track'?TRACK_SIZE:VIDEO_SIZE),imageType:'rgb565le'},generation=++mediaGeneration;
    await switchCamera(()=>robot.camera.start(options));
    if(closed||generation!==mediaGeneration){await switchCamera(()=>robot.camera.stop());throw Error('cancelled');}
    cameraActive=true;cameraMode=mode;tuneRadio();let lastSent;const startedAt=Time.ticks;
    const still=()=>mode!=='track'||!hooks.headMoving?.()||Time.delta(lastSent??startedAt)>=TRACK_STILL_WAIT_MS;
    // TEMPORARY (K151 bring-up, 10 Nov 2026): where the time of one following frame goes (socket.js probe), on the
    // USB log every 5 s: late timer turns (g), capture asked and done (c, C), pieces made and written (p).
    let lastTurn,probeShown=Time.ticks,probing=false;
    cameraTimer=Timer.repeat(()=>{
      if(lastTurn!==undefined&&Time.delta(lastTurn)>60)socket?.note?.('g',Time.delta(lastTurn));
      lastTurn=Time.ticks;
      // A head command waiting for the servos comes first: no capture, conversion or sending until it is confirmed,
      // so the servo replies are read at once (mod.js motionBusy, 9 Nov 2026).
      if(hooks.motionBusy?.())return;
      if(sending){pumpFrame();return;}
      if(snap){
        if(Time.delta(snap.at)>SNAP_MS){endSnap(false);return;}
        if(snap.pieces){
          // One piece per turn of the timer, while the conversation's connection has room.
          try{
            snap.piece??=snap.pieces.next();
            if(snap.piece.done){endSnap(true);return;}
            if(snap.sink(snap.piece.value))snap.piece=undefined;
          }catch{endSnap(false);}
          return;
        }
        if(captureBusy||Time.delta(startedAt)<(mode==='snap'?SNAP_WARM_MS:0)||hooks.headMoving?.())return;
        captureBusy=true;
        void robot.camera.capture(options).then(frame=>{
          if(!frame){captureBusy=false;return;}
          if(!snap||snap.frame||generation!==mediaGeneration||closed||frame.imageType!=='rgb565le'){try{frame.close?.();}catch{}captureBusy=false;if(snap&&!snap.frame&&frame.imageType!=='rgb565le')endSnap(false);return;}
          snap.frame=frame;try{snap.pieces=pictureChunks(frame.buffer,frame.width,frame.height);}catch{endSnap(false);}
        }).catch(()=>{captureBusy=false;endSnap(false);});
        return;
      }
      if(mode==='snap')return; // the camera is on only for a picture: nothing goes to the iPhone
      // While Robottino talks, following sends nothing (owner, 11 Nov 2026: «la voce va a scatti» with the app following
      // the face during the conversation): taking, converting and sending an image holds JavaScript for 0.1-0.25 s, four
      // times a second, and the speaker ran dry. The head stays where it is for the length of the reply and following
      // goes on as soon as the robot listens again.
      if(mode==='track'&&hooks.speaking?.())return;
      if(captureBusy||!cameraActive||closed||(socket?.bufferedAmount??0)>SEND_BACKLOG)return;
      // Following: the whole frame, or a small image of where the face should be now (tracker.js FaceLock).
      const track=mode==='track',pose=track?hooks.headPose?.():undefined,cut=track?lock.plan(pose,Time.ticks,!!hooks.listening?.()):undefined;
      const gap=track?(cut?TRACK_SMALL_FRAME_MS:hooks.conversation?.()?TRACK_VOICE_FRAME_MS:TRACK_FRAME_MS):VIDEO_FRAME_MS;
      if(lastSent!==undefined&&Time.delta(lastSent)<gap)return;
      // The small image waits for the room to leave in one go (the network has confirmed what went before; by then
      // the camera has a new image ready too, so the capture does not hold the robot).
      if(cut&&lastSent!==undefined&&Time.delta(lastSent)<SMALL_ROOM_WAIT_MS&&(socket?.room??SMALL_ROOM)<SMALL_ROOM)return;
      if(!still())return;
      captureBusy=true;
      if(probing&&Time.delta(probeShown)>=5000&&typeof trace==='function'){probeShown=Time.ticks;for(const line of socket?.probeLines?.()??[])trace(`[robottino] probe${line}\n`);}
      probing=true;socket?.probeStart?.();socket?.note?.('c');
      void robot.camera.capture(options).then(frame=>{
        socket?.note?.('C');
        if(!frame){captureBusy=false;return;}
        if(!cameraActive||generation!==mediaGeneration||closed||hooks.motionBusy?.()||!still()){try{frame.close?.();}catch{}captureBusy=false;return;}
        if(frame.imageType!=='rgb565le'||frame.width>320||frame.height>240){try{frame.close?.();}catch{}throw Error('camera_format');}
        const id=++frameId;lastSent=Time.ticks;
        // The small image is cut only from the camera's own 160×120 frame.
        const small=cut&&frame.width===FRAME_WIDTH&&frame.height===FRAME_HEIGHT?cut:undefined;
        if(pose){framePoses.push({id,pose,window:small});if(framePoses.length>TRACK_POSES)framePoses.shift();}
        if(track){lock.sent(small,lastSent);followStat('frames',!!small);}
        // Grey for following (live-wire.js: the small image, or the whole frame, found from much farther away),
        // converted piece by piece as it is sent; the camera frame goes back after the last piece.
        let pieces,paced=0;
        try{
          if(small){
            pieces=windowChunks(id,frame.buffer,frame.width,frame.height,small.x0,small.y0,small.step,()=>++seq);
            // The small image leaves in one turn when the connection has room for all of it (about 0.1 s of work):
            // one piece per turn cost two more turns of the timer, 0.1-0.25 s each with the robot busy (probe of
            // 10 Nov 2026 night: 450 ms from the capture to the last piece). Without room, one piece per turn as before.
            paced=(socket?.room??0)>=SMALL_ROOM?0:SMALL_PIECES;
          }
          else if(track){pieces=greyChunks(id,frame.buffer,frame.width,frame.height,()=>++seq);paced=Math.ceil(frame.width*frame.height/CAMERA_PIECE);}
          else pieces=cameraChunks(id,frame.buffer,frame.width,frame.height,()=>++seq);
        }catch(error){try{frame.close?.();}catch{}throw error;}
        sending={frame,generation,pieces,paced};pumpFrame();
      }).catch(()=>{if(!sending)captureBusy=false;close();});
    },PUMP_MS);
  };
  const io={
    async camera(enabled){
      if(cameraMode==='track')throw Error('camera_busy'); // following owns the camera until track.stop
      if(!enabled){await stopCamera();return;}
      await startCamera('video');
    },
    // The head may move only as for the other remote motions: verified, calibrated, motions on locally.
    async track(enabled){
      if(!enabled){stopFollowing();if(cameraMode==='track')await stopCamera();return;}
      if(!verified()||!calibrated())throw Error('uncalibrated');
      if(following)return;
      hooks.follow(true);following=true;lock.clear();
      try{await startCamera('track');}catch(error){stopFollowing();throw error;}
    },
    target(value){
      const entry=following?framePoses.find(item=>item.id===value.frameId):undefined;
      if(following)followStat(entry?'answers':'late',false,entry&&lock.since!==undefined?Time.delta(lock.since):0);
      if(!entry)throw Error('stale_frame'); // an answer for an old or unknown frame moves nothing
      // Where the face is in the whole frame (the answer may be about a small window of it). An answer at the edge
      // (a face cut by the image, or the iPhone's guess of where a lost face went) turns the head to that edge and
      // the next frame is whole (tracker.js FaceLock).
      const place=lock.answer(entry,value.x,value.y,Time.ticks);
      if(place&&!hooks.aim({x:place.x,y:place.y,pose:entry.pose}))throw Error('target_rejected');
    },
    call(enabled){
      if(!enabled){stopCall();return;}
      if(microphone)return;if(!verified())throw Error('hardware_unverified');
      releaseAudio=robot.audio.acquireExclusive();
      try{
        const stats=callStats={reads:0,read:0,most:0,sent:0,full:0,gated:0,heard:0,over:0,bad:0,played:0,silence:0,errors:0,at:Time.ticks};
        // The microphone's sound becomes pieces of 800 bytes of µ-law (live-wire.js CallPacker), one message each:
        // ten a second instead of fifty, a quarter of the bytes.
        const packer=new CallPacker(),sendPiece=piece=>{
          if((socket?.bufferedAmount??0)>(cameraActive?CALL_CAMERA_BACKLOG:CALL_BACKLOG)){stats.full+=piece.length;return;}
          if(connected&&!closed){socket.write(encodeCallAudio(++seq,piece));stats.sent+=piece.length;}
        };
        // No error may leave the two callbacks below. The host calls the microphone's without catching anything: an
        // error there ends the JavaScript machine and the robot restarts with nothing on the log (10 Nov 2026: every
        // call in which the iPhone sent its voice restarted the robot after 2-3 s). The speaker's errors the host
        // swallows without a word.
        speaker=new AudioOut({sampleRate:16000,channels:1,bitsPerSample:16,onWritable(size){
          try{
            while(size>0){
              const head=audioQueue[0],length=Math.min(size,head?.byteLength??SILENCE.byteLength);
              if(head){const part=head.subarray(0,length);this.write(part);audioBytes-=length;stats.played+=length;const mouth=pcmMouthLevel(part);if(mouth)lastPlayback=Time.ticks;if(mouth!==lastAudioMouth){lastAudioMouth=mouth;robot.face.setMouthOpen(mouth);}if(length===head.byteLength)audioQueue.shift();else audioQueue[0]=head.subarray(length);}
              else {this.write(length===SILENCE.byteLength?SILENCE:SILENCE.subarray(0,length));stats.silence+=length;if(lastAudioMouth){lastAudioMouth=0;robot.face.setMouthOpen(0);}}
              size-=length;
            }
          }catch(error){if(!stats.errors++)note('call speaker',error);}
        }});
        speaker.volume=.25;if(globalThis.amp)globalThis.amp.sampleRate=16000;
        microphone=new AudioIn({sampleRate:16000,channels:1,bitsPerSample:16,onReadable(){
          try{
            // Read what is there, as the voice does (voice-device.js), never the size the host announced: the
            // microphone keeps a quarter of a second, and when JavaScript is late it goes round in the meantime;
            // the announced size is then more than what is left and the read fails with "invalid size".
            const data=this.read();if(!data)return;
            const length=data.byteLength;stats.reads++;stats.read+=length;if(length>stats.most)stats.most=length;
            if(Time.delta(stats.at)>=5000)showCall();
            // Gated microphone while speaker is active: prevents an acoustic loop;
            // hardware AEC/full-duplex speech must be measured on the real robot.
            if(lastPlayback!==undefined&&Time.delta(lastPlayback)<180){stats.gated+=length;packer.clear();return;}
            // Read at every callback, so the microphone's quarter of a second never fills; sent when a piece is whole.
            packer.add(data,sendPiece);
          }catch(error){failLater('call mic',error);}
        }});
        if(microphone.sampleRate!==16000||microphone.channels!==1||microphone.bitsPerSample!==16)throw Error('audio_format');
        speaker.start();microphone.start();tuneRadio();
      }catch(error){stopCall();throw error;}
    },
    screen(enabled){
      if(enabled&&!verified())throw Error('hardware_unverified');screenActive=enabled;
      if(!enabled){screenPort=undefined;robot.ui.showFace();}
    },
    audio(data){
      if(!speaker)return;
      // Only call audio in the call's format (live-wire.js): anything else is dropped, never played as noise.
      const count=callAudioLength(data);if(!count){if(callStats)callStats.bad++;return;}
      if(audioBytes+count*4>CALL_PLAY_QUEUE){if(callStats)callStats.over+=count;return;}
      const buffer=decodeCallAudio(data,playback);audioQueue.push(buffer);audioBytes+=buffer.byteLength;if(callStats)callStats.heard+=count;
    },
    image(frame){
      if(!screenActive)return;
      const be=config.format==='RGB565BE',pixels=screenPixels(frame,be);
      const scale=frame.scale??2,bitmap=new Bitmap(frame.width*scale,frame.height*scale,be?Bitmap.RGB565BE:Bitmap.RGB565LE,pixels,0);
      if(!screenPort){
        screenPort=new RuntimeBitmapPort(null,{left:0,top:0,width:320,height:240,Behavior:class extends Behavior{
          onDraw(port){port.fillColor('#07101f',0,0,320,240);if(this.bitmap)port.drawBitmap(this.bitmap,Math.floor((320-this.bitmap.width)/2),Math.floor((240-this.bitmap.height)/2));}
        }});
        robot.ui.setMain(new Container(null,{left:0,top:0,width:320,height:240,contents:[screenPort]}));
      }
      screenPort.behavior.bitmap=bitmap;screenPort.invalidate();
    },
    faceStyle:style=>{if(!verified()||screenActive)throw Error("face_unavailable");hooks.faceStyle(style);},
    motion:async value=>{if(!verified()||!calibrated())throw Error('uncalibrated');await hooks.motion(value);},
    // ACK means the dance started; STOP or a disconnect cancels it.
    dance:steps=>{if(!verified()||!calibrated())throw Error('uncalibrated');hooks.dance(steps);},
    face:value=>{robot.face.setEyeOpen('left',value.leftEye);robot.face.setEyeOpen('right',value.rightEye);robot.face.setMouthOpen(value.mouth);robot.face.setEmotion(value.mouth>.35?3:0);},
    // emergency: the iPhone's STOP command. A link that simply closes stops only what the iPhone started.
    // The camera stops first, and the face comes back only if an iPhone image was on the screen: with the face shown
    // again while the camera still ran, the robot restarted every time the link closed during following (9 Nov 2026).
    async stop(emergency=false){
      stopFollowing();hooks.stop(emergency);
      try{await stopCamera();}catch{}
      stopCall();robot.face.setEyeOpen('left',1);robot.face.setEyeOpen('right',1);robot.face.setEmotion(0);
      if(screenActive){screenActive=false;screenPort=undefined;robot.ui.showFace();}
    }
  };
  const hello=()=>send({type:'hello',capabilities:{hardwareVerified:verified(),calibrated:calibrated(),motion:verified()&&calibrated()&&hooks.motionEnabled(),camera:verified()&&!!robot.camera?.capture,audio:verified()&&!!robot.audio?.acquireExclusive,screen:verified(),conversation:!!hooks.conversation?.()}});
  const close=()=>{if(closed)return;closed=true;connected=false;following=false;framePoses=[];lock.clear();finishFrame();tuneRadio();if(failing!==undefined){Timer.clear(failing);failing=undefined;}controller?.close();if(heartbeat!==undefined)Timer.clear(heartbeat);heartbeat=undefined;socket?.close();hooks.disconnected();};
  const connect=async()=>{
    const token=Preference.get('robottino','deviceToken');if(typeof token!=='string'||token.length<32){robot.ui.showBalloon('Live: configura la credenziale dedicata del robot.');return;}
    const network=await robot.connectivity.network?.ready;if(closed)return;
    await servosConfirmed();if(closed)return; // the TLS handshake keeps the robot busy: not over a servo command
    socket=new Client({host:'robottino-stackchan.example.workers.dev',port:443,path:'/api/robot/device',headers:['Authorization','Bearer '+token]});
    controller=new DeviceCommands(io,send);
    socket.callback=(type,value)=>{
      if(closed)return;
      try{
        if(type===Client.handshake){
          connected=true;heardAt=Time.ticks;hooks.online?.();hello();
          heartbeat=Timer.repeat(()=>{
            try{
              // Not even the answers to the pings for 12 s: the link ends here (LINK_SILENCE_MS).
              if(Time.delta(heardAt)>LINK_SILENCE_MS){note('heartbeat','nothing from the server');close();return;}
              send({type:'ping'});hello();
            }catch(error){note('heartbeat',error);close();}
          },5000);
        }else if(type===Client.receive){
          heardAt=Time.ticks;
          if(typeof value==='string'){
            const event=JSON.parse(value);
            if(event.type==='command')void controller.command(event);
            if(event.type==='peer.connected'){appIn=true;tuneRadio();hooks.connected();}
            if(event.type==='reaction')hooks.reaction?.(event.kind);
          }else controller.media(value);
        }else if(type===Client.disconnect)close();
      }catch(error){note('link',error);close();}
    };
  };
  const snapshot=async sink=>{
    if(closed||snap||!verified())return false;
    let own=false;
    if(!cameraActive){try{await startCamera('snap');own=true;}catch{return false;}}
    if(closed||!cameraActive||snap){if(own&&cameraMode==='snap')void stopCamera().catch(()=>{});return false;}
    return new Promise(resolve=>{snap={sink,resolve,own,at:Time.ticks};});
  };
  return {connect,close,hello,snapshot,busy:()=>cameraSwitching>0};
}
