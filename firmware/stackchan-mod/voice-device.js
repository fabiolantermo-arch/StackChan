import {Client,lowLatency} from 'robottino-socket';
import Preference from 'preference';
import Timer from 'timer';
import Time from 'time';
import Modules from 'modules';
import AudioIn from 'embedded:io/audio/in';
import AudioOut from 'pins/audioout';
import {exploreCommand} from 'robottino-explore';
import {parseVoiceEvent,roomMessage,ulawEncode,pongMessage,memoryMessage,clearPlaybackMessage,isMemoryPhrase,VoiceTurns,replyMood,timerCommand,headCommand,roverCommand,replyHeadCommand,replyFaceCommand,faceCommand,seeCommand,replySee,MouthTrack,toolResultMessage,agendaMessage,noticeMessage} from 'robottino-voice-wire';
import {MOUTH_LEVELS,LIPS,lipsBetween} from 'robottino-portrait-state';

// The JavaScript memory is fixed (256 KB, shared with face and menus): when it runs out the robot
// restarts. The Worker sends ~190 ms pieces at most ~1.2 s ahead; anything larger is dropped here.
const MAX_EVENT=16384;
// The host WebSocket queues without limit when the network is slow: past this the microphone drops audio.
const MAX_BACKLOG=16384;

// Microphone and speaker share one I2S port and its clock pins. Kept open together they garbled the
// voice on the K151 (9 Nov 2026); Moddable's own ChatAudioIO never does it either. So the robot takes
// turns like a walkie-talkie: it listens, closes the microphone to speak, then listens again.
const MIC_SETTLE_MS=400;  // samples right after opening the microphone are dropped (ChatAudioIO: 500)
const REPLY_FLUSH_MS=200; // no new reply audio for this long: play what is in hand
const REPLY_END_MS=1200;  // no audible word started for this long: back to listening
// The reply is over sooner when nothing more is coming (owner, 12 Nov 2026: «passa molto tempo da quando finisce la
// risposta a quando i led si accendono di blu»): the last word started REPLY_TAIL_MS ago and no reply audio at all,
// silence included, has come from the network for REPLY_QUIET_MS. The server sends the audio about half a second
// ahead of the speaker, so at the last word the network has usually been quiet for that long already. The longest
// wait between two pieces of one reply measured on the robot was 0.5–0.6 s (11 Nov 2026, `net` in the log).
const REPLY_TAIL_MS=350,REPLY_QUIET_MS=800;
const REPLY_STUCK_MS=2000; // the speaker has not reported for REPLY_END_MS + this: back to listening anyway
// A reply starts, and restarts after the speaker ran dry, only with this much audio in hand: a late
// piece from the network then becomes one short pause instead of stutter.
const PREBUFFER_MS=400;
const MAX_QUEUED_MS=2000; // reply audio waiting in the robot's memory, at most
// SPEAKER (9 Nov 2026). The robot's JavaScript is too slow for per-sample work: decoding μ-law and
// measuring the mouth sample by sample kept it so busy that the speaker went unserved for seconds and the
// voice stuttered. The reply now plays through the host's own speaker driver (the laugh's): it decodes
// IMA ADPCM by itself and plays from its own task, from a queue of 24 elements, even while the program
// draws the face. The Worker sends IMA frames with the mouth level of each ~97 ms segment already
// measured (src/robot-audio.ts): the robot only copies bytes. Each segment is preceded by a callback with
// its number: when it starts to play, the mouth follows that segment's poses, one every 4 chunks (~32 ms),
// from a 32 ms timer. Level: as the provider sends it (ElevenLabs peaks about −7.7 dBFS); +6 dB made the
// amplifier (boost off) crackle.
const SPEAKER_SETTLE_MS=200;
// Opening or closing microphone and speaker keeps the robot busy for a moment (the drivers share one I2S port and
// are created each time). A servo command waiting for its confirmation meanwhile looks lost: on 10 Nov 2026 the
// small head gesture at the start of a reply failed twice in a row and the motions were blocked. busy() tells
// mod.js to send no head command while the conversation starts and for this long after each change.
const AUDIO_SETTLE_MS=350;
const IMA_CHUNK_BYTES=68,IMA_CHUNK_SAMPLES=129,IMA_SEGMENT_CHUNKS=12,IMA_MOUTH_CHUNKS=4,MOUTH_TICK_MS=32,LIPS_HOLD_MS=110,PICTURE_MS=96,MID_MS=30;
const SAMPLE_STEP=8; // provider PCM (JSON events): the mouth looks at every 8th sample
const THINK_MS=8000; // head lights: your words were heard and the reply has not started; past this, listening again
// Head lights while Robottino is busy for you and silent (owner, 12 Nov 2026: «gialle quando cerca su web»): a web
// search, told by the server when it starts and ends, and the picture of «cos'è questo?», told by mod.js. The light
// stays until the answer starts to play (or WORK_AFTER_MS after the work ended), never longer than WORK_MS.
const WORK_MS={search:30000,look:20000},WORK_AFTER_MS=3000,LOOK_SENT_MS=800;

// Conversation with the AI provider through the robot's own microphone and speaker.
// One conversation at a time; ends on request, after 30 s of silence or when the
// cloud closes it (5-minute limit). Audio is never stored.
export function createVoiceDevice(robot,hooks){
  // The face shown on the screen (owner, 9 Nov 2026): the Worker makes the agent speak of itself in the feminine
  // for the two girls and in the masculine for the white robot. Only the three known ids are sent.
  const faceQuery=()=>{let style;try{style=hooks.faceStyle?.();}catch{}return ['portrait','white','redhead','curly'].includes(style)?'&face='+style:'';};
  let socket,microphone,speaker,releaseAudio,timer,drainTimer,provider,turns,rates,closed=true,connected=false,lastActivity=0,exploring=false,lastPlayback,mouth=0,pending;
  // The Wi-Fi stays awake for the whole conversation (socket.js lowLatency): the voice does not wait for the radio.
  let radio;
  // inFlight: segments in the driver's queue. The driver reads their memory directly, so JavaScript must keep
  // a reference until each one has been played, or the garbage collector could free it mid-playback.
  let segments=[],inFlight=[],queuedMs=0,audibleQueued=0,enqueued=0,started=0,waiting=true,lastCallbackAt,lastFrameAt,nextSegment=1,mouthTimer,mouthPlan,mouthTrack=new MouthTrack();
  let speakerVolume=1,testDone,testing=false,micOpenedAt,buffer=new Uint8Array(0),discarding,reply='',gestured=false,tagged,workerTools=false,mood='neutral',starting=false,cancelStart=false,heardAt,unheard,unfaced,work;
  let audioChangedAt,audioWindow=0,greetingTimer;
  const audioChanged=ms=>{audioChangedAt=Time.ticks;audioWindow=ms;};
  // The host encodes A-law natively (ChatAudioIO/Codecs): the microphone costs no JavaScript per sample.
  let alaw;try{if(Modules.has('ChatAudioIO/Codecs'))alaw=Modules.importNow('ChatAudioIO/Codecs').Encode;}catch{}
  // TEMPORARY diagnostics (14 Nov 2026): how strong the robot receives the Wi-Fi (dBm, the host's net module; about
  // -50 is strong, under -75 weak), next to the microphone and speaker lines of the USB log. On 13 Nov a question was
  // answered 46 s late with the robot's connection unable to send, while the service itself answered in 2 s.
  let net;try{if(Modules.has('net')){const found=Modules.importNow('net');net=typeof found?.get==='function'?found:found?.default;}}catch{net=undefined;}
  const signal=()=>{try{const value=net?.get?.('RSSI');return Number.isFinite(value)&&value<0?` rssi${Math.round(value)}`:'';}catch{return '';}};
  // The host lends the speaker only after a short sound (laugh, chime) has finished: wait up to 3 s.
  const acquireAudio=async()=>{
    for(let waited=0;;waited+=250){
      try{return robot.audio.acquireExclusive();}
      catch(error){if(String(error?.message??error)!=='audio busy'||waited>=3000)throw error;}
      await new Promise(resolve=>Timer.set(resolve,250));
    }
  };
  // Built-in base64 of the Moddable 10 runtime (the old native Base64 module is deprecated).
  const decode=text=>Uint8Array.fromBase64(text).buffer;
  // TEMPORARY diagnostics (K151 bring-up): counters saved every 5 s, so a restart leaves the last snapshot.
  let stats={},statTicks=0;
  const resetStats=()=>{stats={m:0,d:0,u:0,g:0,a:0,x:0,c:0,q:0,b:0,i:0,s:0,v:0,k:0,n:0,t:0,f:0,h:0,e:''};statTicks=0;micWindow={at:Time.ticks,bytes:0,gap:0,last:undefined};};
  // TEMPORARY diagnostics (11 Nov 2026, «con il Live non segue i comandi»): every 5 s while listening, how much the
  // microphone gave (bytes per second, expected 2 × sample rate) and the longest pause between its callbacks.
  let micWindow={at:0,bytes:0,gap:0,last:undefined};
  const micReport=()=>{
    const ms=Time.delta(micWindow.at);if(ms<1000)return;
    if(microphone&&typeof trace==='function')trace(`[robottino] mic ${Math.round(micWindow.bytes*1000/ms)}B/s gap${micWindow.gap} sent${stats.m} drop${stats.d} q${Math.round((socket?.bufferedAmount??0)/1024)}k${signal()}\n`);
    // The speaker, while a reply plays: times it ran dry in the middle of a reply so far in this conversation, the
    // longest pause between its callbacks and between the frames from the server (ms).
    if(speaker&&typeof trace==='function')trace(`[robottino] spk dry${stats.v} gap${stats.k} net${stats.n} queue${stats.q}${signal()}\n`);
    micWindow={at:Time.ticks,bytes:0,gap:0,last:undefined};
  };
  const report=()=>{try{hooks.stats?.(`m${stats.m} d${stats.d} u${stats.u} g${stats.g} a${stats.a} x${stats.x} c${stats.c} q${stats.q} b${Math.round(stats.b/1024)} i${stats.i} s${stats.s} v${stats.v} k${stats.k} n${stats.n} t${stats.t} f${stats.f} h${stats.h}${stats.e?' e:'+stats.e:''}`,testing);}catch{}};
  // An exception escaping a driver callback restarts the robot (XS unhandled exception):
  // record it and end the conversation outside the callback instead.
  // The reason goes on the USB log too (14 Nov 2026: a conversation ended with «end:error» and nothing said why).
  const fault=(where,error)=>{stats.e=(where+':'+String(error?.message??error)).slice(0,40);try{if(typeof trace==='function')trace(`[robottino] voice error ${stats.e}\n`);}catch{}};
  const failLater=(where,error)=>{if(closed)return;fault(where,error);report();Timer.set(()=>stop('error'),0);};
  const send=text=>{if(connected&&!closed)socket.write(text);};
  let mouthLevelShown=0,mouthStepAt; // the level on the screen (index of MOUTH_LEVELS) and when it last moved
  // The shape of the lips on the screen (portrait-state.js LIPS; 0 none), whether it is still its half-way picture,
  // and since when. The face decides whether it has the pictures (hooks.lips: face.js setLips).
  let lipsShown=0,lipsHalf=false,lipsAt,lipsShape=0,lipsSince; // lipsShape: the shape wanted now and since when (a shape stays LIPS_HOLD_MS at least)
  const setLips=(shape,half,now)=>{if(shape===lipsShown&&half===lipsHalf)return;lipsShown=shape;lipsHalf=half;lipsAt=now;};
  // What is on the screen (owner, 16 Nov 2026: «controlla ancora le labbra, sono scattose»: measured on a real reply, the
  // mouth picture changed 14 times a second, the loudness mouths and the shapes of the letters taking turns). The mouth
  // and the lips above are what they should be at each 32 ms tick; but the screen changes between a shape and the
  // loudness mouth, or from a shape to another, at most every PICTURE_MS (about 10 changes a second, as the lips of a
  // person). The loudness mouth alone still goes level by level at each tick, and behind a shape it is not drawn at all.
  // A closed mouth (the end of the reply, an interruption) goes to the screen at once.
  // In between (owner, 17 Nov 2026: «rendi più realistico il movimento della bocca»): the screen never cuts from a shape
  // shown whole to another, or to the mouth of the loudness: for MID_MS it shows the picture half way between the two
  // (portrait-state.js lipsBetween), as lips do on the way. The wait of PICTURE_MS is counted from the end of a passage.
  let shownMouth=0,shownLips='',lipsPresentedAt,passingAt;
  const showLips=name=>{if(name===shownLips)return;shownLips=name;try{hooks.lips?.(name);}catch{}};
  const present=(now,force)=>{
    const want=lipsShown?lipsShown+(lipsHalf?'h':''):'';
    if(force){passingAt=undefined;showLips(want);lipsPresentedAt=now;}
    else if(passingAt!==undefined){if(now-passingAt>=MID_MS){passingAt=undefined;showLips(want);lipsPresentedAt=now;}}
    else if(want!==shownLips&&(lipsPresentedAt===undefined||now-lipsPresentedAt>=PICTURE_MS)){
      const between=lipsBetween(shownLips,want,mouthLevelShown);
      if(between){showLips(between);passingAt=now;}else{showLips(want);lipsPresentedAt=now;}
    }
    if(mouth!==shownMouth&&(!shownLips||force)){shownMouth=mouth;robot.face.setMouthOpen(mouth);}
  };
  const setMouth=(value,force=value===0)=>{if(value===0){mouthLevelShown=0;mouthStepAt=undefined;lipsShape=0;lipsSince=undefined;setLips(0,false);}mouth=value;present(Time.ticks,force);};
  const setMood=(expression,gesture=null)=>{if(expression===mood&&!gesture)return;mood=expression;hooks.mood?.({expression,gesture});};
  const endReply=()=>{reply='';gestured=false;tagged=undefined;setMood('neutral');};
  // The user's last sentence gave no command, and the start of Robottino's reply says it is angry, sad or back to
  // normal (12 Nov 2026: «la voce è arrabbiata ma il viso rimane normale»): the face follows, once per turn, within
  // 10 s. The reply is read from its start, so a reply that comes in pieces (OpenAI) counts as soon as it says it.
  const faceFromReply=()=>{
    if(unfaced===undefined)return;
    if(Time.delta(unfaced)>=10000||reply.length>=400){unfaced=undefined;return;}
    const look=replyFaceCommand(reply);if(!look)return;
    unfaced=undefined;if(typeof trace==='function')trace(`[robottino] face from reply ${look.expression}\n`);hooks.face?.(look);
  };
  const dropReply=()=>{segments=[];queuedMs=0;audibleQueued=0;mouthTrack=new MouthTrack();};
  // close() stops the driver's task before returning: only then are the segments it held released.
  // While it plays, the host posts each segment's callback to JavaScript with the speaker's address but without
  // keeping it alive: a speaker closed with a callback still on its way was freed, and the callback then read
  // freed memory (Guru Meditation in deliverCallbacks, audioout.c, 9 Nov 2026, conversation ended mid-reply).
  // So when the conversation ends, the speaker is stopped at once and closed SPEAKER_SETTLE_MS later, when the
  // callbacks already posted have arrived (ignored, as the speaker is no longer ours); the segments it held stay
  // referenced until then.
  const closeSpeaker=(settle=false)=>{
    if(drainTimer!==undefined)Timer.clear(drainTimer);drainTimer=undefined;if(mouthTimer!==undefined)Timer.clear(mouthTimer);mouthTimer=undefined;mouthPlan=undefined;
    const out=speaker,held=inFlight;speaker=undefined;inFlight=[];setMouth(0);
    if(!out)return;
    if(!settle){try{out.close();}catch{}return;}
    try{out.stop();}catch{}
    return ()=>{try{out.close();}catch{}held.length=0;};
  };
  // The playing segment's mouth poses, one per ~32 ms; past its end the last pose holds two steps (the next
  // segment's callback may come a little late), then the mouth closes: the speaker ran dry.
  const showMouth=now=>{
    if(!mouthPlan)return;
    const {poses,at,step}=mouthPlan,i=Math.floor((now-at)/step);
    // The pose of this moment is the target; the mouth goes there through the eight levels (two a pose), half of the
    // way at each step of MOUTH_TICK_MS and at least one level: a change is never the big jump between two poses
    // (owner, 12 Nov 2026: «la bocca… è a scatti»), and the words still open it in about a tenth of a second.
    // Each pose: the loudness pose (0…4) and, from a Worker that knows the letters, 16 × the shape of the lips.
    const pose=i<poses.length?poses[Math.max(0,i)]:i<poses.length+2?poses.at(-1):0,target=2*(pose&15);
    // The lips (owner, 16 Nov 2026: «il movimento delle labbra è troppo scattoso»): the letters change every 40-80 ms, and
    // the lips went from one shape to the next that often. A shape stays at least LIPS_HOLD_MS before another one (or
    // none) takes its place: fewer, calmer movements.
    let shape=pose>>4;
    if(shape!==lipsShape&&lipsSince!==undefined&&now-lipsSince<LIPS_HOLD_MS)shape=lipsShape;
    if(shape!==lipsShape){lipsShape=shape;lipsSince=now;}
    if(target!==mouthLevelShown&&(mouthStepAt===undefined||now-mouthStepAt>=MOUTH_TICK_MS-8)){
      const gap=target-mouthLevelShown;mouthLevelShown+=Math.sign(gap)*Math.ceil(Math.abs(gap)/2);mouthStepAt=now;
    }
    // The shape of the letter being said: its half-way picture for one step, then the shape itself, so that the lips
    // do not jump. Without a shape the mouth is the one of the loudness, which has gone on moving underneath.
    // A vowel said softly (the lowest loudness pose) stays at its half-way picture: a small sound, a small movement.
    // The wide «e/i» (shape 4) is a smile with the teeth: owner, 16 Nov 2026, «è troppo sorridente, ogni volta che parla
    // mi sorride»: it only ever shows its half-way picture, which is a hint of it.
    const soft=shape===4||(shape>=2&&shape<=3&&(pose&15)<=1);
    if(!shape)setLips(0,false,now);
    else if(shape!==lipsShown||soft)setLips(shape,true,now);
    else if(lipsHalf&&now-lipsAt>=MOUTH_TICK_MS-8)setLips(shape,false,now);
    // Pressed lips in a silence: the loudness mouth is closed underneath, and closing it must not take the shape away.
    if(shape&&!mouthLevelShown){mouth=0;present(now);return;}
    setMouth(MOUTH_LEVELS[mouthLevelShown],false);
  };
  const closeMicrophone=()=>{try{microphone?.close();}catch{}microphone=undefined;buffer=new Uint8Array(0);};
  // Listening turn: speaker closed, microphone open.
  const openMicrophone=()=>{
    // The reply has been said (owner, 16 Nov 2026: «quando smette di parlare torna alla posa sorridente, invece deve
    // tornare alla posa neutra»): its mood, which kept the happy face while it spoke, ends with it, not only when the
    // user next speaks or the reply is interrupted.
    if(reply)endReply();
    closeSpeaker();heardAt=undefined;if(microphone||closed||!rates)return;
    audioChanged(AUDIO_SETTLE_MS);
    const {inputRate}=rates,chunk=inputRate/10*2;micOpenedAt=Time.ticks;
    microphone=new AudioIn({sampleRate:inputRate,channels:1,bitsPerSample:16,onReadable(){const began=Time.ticks;try{
      // Read what is there: when JavaScript falls behind the ring buffer wraps, and asking for the
      // announced size can fail with "invalid size".
      const data=this.read();if(!data||Time.delta(micOpenedAt)<MIC_SETTLE_MS)return;
      {const now=Time.ticks;if(micWindow.last!==undefined)micWindow.gap=Math.max(micWindow.gap,now-micWindow.last);micWindow.last=now;micWindow.bytes+=data.byteLength;}
      const bytes=new Uint8Array(data),joined=new Uint8Array(buffer.byteLength+bytes.byteLength);joined.set(buffer);joined.set(bytes,buffer.byteLength);buffer=joined;
      // One pass over what arrived (with the host's one-second microphone buffer a read can be 20 KB and more after a
      // pause): each piece is copied once, the rest once at the end.
      let at=0;
      for(;buffer.byteLength-at>=chunk;at+=chunk){
        const part=buffer.slice(at,at+chunk),backlog=socket?.bufferedAmount??0;
        // Slow network: drop audio rather than fill the memory. While a picture is going out («cos'è questo?»,
        // «Esplora») the microphone gives way to it: on a weak Wi-Fi it kept 14–17 KB waiting and a piece of the
        // picture, sent only under PICTURE_BACKLOG, never left (23 Nov 2026, «explore look failed»).
        if(backlog>(work?.kind==='look'&&work.sent===undefined?PICTURE_BACKLOG:MAX_BACKLOG)){stats.d++;continue;}
        let law;if(alaw){law=new Uint8Array(chunk>>1);alaw.toAlaw(part,law);}else law=ulawEncode(part);
        stats.b=Math.max(stats.b,backlog);send(law);stats.m++;
      }
      if(at)buffer=buffer.slice(at);
      stats.h=Math.max(stats.h,Time.ticks-began);
    }catch(error){failLater('mic',error);}}});
    if(microphone.sampleRate!==inputRate||microphone.channels!==1||microphone.bitsPerSample!==16)throw Error('audio_format');
    microphone.start();
  };
  // From a timer or a touch, an exception would restart the robot: end the conversation instead.
  const listen=where=>{if(testing){Timer.set(()=>stop('test'),0);return;}try{openMicrophone();}catch(error){failLater(where,error);}};
  // Hands segments to the driver while it has room (two elements each: callback, then audio).
  const feed=()=>{
    if(!speaker)return;
    if(waiting){
      if(!segments.length||queuedMs<PREBUFFER_MS&&Time.delta(lastFrameAt)<REPLY_FLUSH_MS)return;
      waiting=false;lastCallbackAt=Time.ticks;if(started)stats.v++; // restarted after running dry in the middle of a reply
    }
    while(segments.length&&speaker.length(0)>=2){
      const segment=segments.shift();queuedMs-=segment.ms;
      segment.seq=nextSegment++;speaker.enqueue(0,AudioOut.Callback,segment.seq);
      speaker.enqueue(0,segment.ima?AudioOut.Samples:AudioOut.RawSamples,segment.buffer,1,segment.offset,segment.count);
      inFlight.push(segment);enqueued++;
    }
  };
  // Speaking turn: microphone closed, speaker open until the reply has been played out.
  // What Robottino is busy with while it is silent: {kind:'search'|'look', at, done (ticks: the search ended),
  // sent (ticks: the picture has gone to the server, which now reads it)}.
  const working=()=>{
    if(!work)return null;
    if(Time.delta(work.at)>=WORK_MS[work.kind]||work.done!==undefined&&Time.delta(work.done)>=WORK_AFTER_MS){work=undefined;return null;}
    return work.kind;
  };
  const openSpeaker=()=>{
    closeMicrophone();heardAt=undefined;if(speaker||closed||!rates)return;
    // The answer starts: the search is over, or the picture went at least LOOK_SENT_MS ago («Fammi vedere…» is not it).
    if(work&&(work.done!==undefined||work.sent!==undefined&&Time.delta(work.sent)>=LOOK_SENT_MS))work=undefined;
    audioChanged(AUDIO_SETTLE_MS);
    const {outputRate}=rates;enqueued=0;started=0;waiting=true;lastCallbackAt=lastPlayback=Time.ticks;stats.s++;
    const out=new AudioOut({streams:1,sampleRate:outputRate,bitsPerSample:16,numChannels:1});speaker=out;
    // Callbacks still queued when the speaker closes arrive afterwards: ignored.
    out.callback=seq=>{
      if(speaker!==out)return;
      const now=Time.ticks;
      try{
        // The segments before this one have been played: their memory can go.
        stats.k=Math.max(stats.k,now-lastCallbackAt);lastCallbackAt=now;
        while(inFlight.length&&inFlight[0].seq<seq)inFlight.shift();
        const segment=inFlight[0];if(!segment||segment.seq!==seq)return;
        started++;mouthPlan={poses:segment.poses,at:now,step:segment.step};showMouth(now);
        if(segment.audible){audibleQueued--;lastPlayback=now;lastActivity=now;}
        if(started===enqueued&&!segments.length)waiting=true; // the last segment in hand is playing: ran dry
        feed();
      }catch(error){failLater('spk',error);}
      stats.t=Math.max(stats.t,Time.ticks-now);
    };
    speaker.enqueue(0,AudioOut.Volume,Math.round(256*speakerVolume));
    speaker.start();
    mouthTimer=Timer.repeat(()=>{try{showMouth(Time.ticks);}catch{}},MOUTH_TICK_MS);
    // Starts a reply shorter than PREBUFFER_MS once no audio has come for REPLY_FLUSH_MS. The turn ends when
    // no audible segment is left and the last one started REPLY_END_MS ago, or REPLY_TAIL_MS ago with the network
    // quiet for REPLY_QUIET_MS. OpenAI keeps streaming silence:
    // what is still queued after the last word is dropped, not played.
    drainTimer=Timer.repeat(()=>{
      if(closed||!speaker)return;
      try{feed();}catch(error){failLater('feed',error);return;}
      if(audibleQueued>0&&Time.delta(lastCallbackAt)<REPLY_END_MS+REPLY_STUCK_MS)return;
      const quiet=Time.delta(lastPlayback)>=REPLY_TAIL_MS&&lastFrameAt!==undefined&&Time.delta(lastFrameAt)>=REPLY_QUIET_MS;
      if(quiet||Time.delta(lastPlayback)>=REPLY_END_MS||Time.delta(lastCallbackAt)>=REPLY_END_MS+REPLY_STUCK_MS){dropReply();listen('turn');}
    },100);
  };
  // Stop talking now (tap on the head); the rest of the reply is dropped until the provider confirms (max 3 s).
  const interrupt=()=>{if(closed||!speaker)return false;stats.i++;dropReply();discarding=Time.ticks;lastActivity=Time.ticks;endReply();send(clearPlaybackMessage());listen('tap');return true;};
  const stop=reason=>{
    if(closed){if(starting)cancelStart=true;return;}closed=true;connected=false;report();
    audioChanged(SPEAKER_SETTLE_MS+AUDIO_SETTLE_MS); // the drivers close now, the speaker SPEAKER_SETTLE_MS later
    if(testing){testing=false;const done=testDone;testDone=undefined;try{done?.(reason);}catch{}}
    if(timer!==undefined)Timer.clear(timer);timer=undefined;if(greetingTimer!==undefined)Timer.clear(greetingTimer);greetingTimer=undefined;
    closeMicrophone();const closeLater=closeSpeaker(true),release=releaseAudio;releaseAudio=undefined;
    // The speaker goes back to the host only once it is really closed.
    const finish=()=>{closeLater?.();try{release?.();}catch{}};
    if(closeLater)Timer.set(finish,SPEAKER_SETTLE_MS);else finish();
    dropReply();rates=undefined;reply='';gestured=false;tagged=undefined;mood='neutral';discarding=undefined;unheard=undefined;unfaced=undefined;work=undefined;exploring=false;
    try{socket?.close();}catch{}socket=undefined;
    const held=radio;radio=undefined;held?.close();
    hooks.ended(reason);
  };
  // Reply audio in hand, as segments for the driver: [{buffer, ima, offset, count (samples), poses, audible, ms, step}].
  const queueSegments=list=>{
    if(discarding!==undefined){if(Time.delta(discarding)<3000)return;discarding=undefined;}
    const now=Time.ticks;if(speaker&&lastFrameAt!==undefined)stats.n=Math.max(stats.n,now-lastFrameAt);lastFrameAt=now;
    stats.a++;const ms=list.reduce((sum,segment)=>sum+segment.ms,0);
    if(queuedMs+ms>MAX_QUEUED_MS){stats.c++;return;} // drop rather than run out of memory
    const audible=list.filter(segment=>segment.audible).length;
    // Silence alone does not take the turn from the microphone, nor keep the speaker after the last word.
    if(!audible&&!audibleQueued&&(!speaker||Time.delta(lastPlayback)>=REPLY_END_MS))return;
    for(const segment of list)segments.push(segment);queuedMs+=ms;audibleQueued+=audible;
    stats.q=Math.max(stats.q,Math.round(queuedMs));
    if(!speaker)openSpeaker();
    feed();
  };
  // Binary frame from the Worker (src/robot-audio.ts): [1][mouth pose count][pose each][IMA chunks], one pose
  // every 4 chunks. Copied once into memory the driver can read directly (outside the JavaScript heap),
  // behind the 12-byte header of Moddable's "maud" format.
  const queueFrame=value=>{
    const bytes=new Uint8Array(value),count=bytes[1],size=bytes.length-2-count;
    if(bytes[0]!==1||!count||size<=0||size%IMA_CHUNK_BYTES){stats.x++;return;}
    const chunks=size/IMA_CHUNK_BYTES,rate=rates.outputRate,buffer=new SharedArrayBuffer(12+size),header=new DataView(buffer);
    // One pose per 4 chunks; a Worker sending fewer (one per 12 chunks until 9 Nov 2026) is spread evenly.
    const blocks=Math.ceil(chunks/IMA_MOUTH_CHUNKS),poses=[];for(let m=0;m<blocks;m++){const byte=bytes[2+Math.min(count-1,Math.floor(m*count/blocks))],shape=byte>>4;poses.push(Math.min(4,byte&15)|(shape<=LIPS?shape<<4:0));}
    header.setUint8(0,0x6d);header.setUint8(1,0x61);header.setUint8(2,1);header.setUint8(3,16);header.setUint16(4,rate,true);header.setUint8(6,1);header.setUint8(7,1);header.setUint32(8,chunks*IMA_CHUNK_SAMPLES,true);
    new Uint8Array(buffer,12).set(bytes.subarray(2+count));
    const list=[];
    const step=IMA_MOUTH_CHUNKS*IMA_CHUNK_SAMPLES*1000/rate;
    for(let first=0;first<chunks;first+=IMA_SEGMENT_CHUNKS){
      const n=Math.min(IMA_SEGMENT_CHUNKS,chunks-first),part=poses.slice(first/IMA_MOUTH_CHUNKS,Math.ceil((first+n)/IMA_MOUTH_CHUNKS));
      list.push({buffer,ima:true,offset:first*IMA_CHUNK_SAMPLES,count:n*IMA_CHUNK_SAMPLES,poses:part,audible:part.some(pose=>pose&15),ms:n*IMA_CHUNK_SAMPLES*1000/rate,step});
    }
    queueSegments(list);
  };
  // Provider PCM in a JSON event (OpenAI deltas or a Worker without IMA): copied whole, in ~97 ms segments
  // with a mouth pose every ~32 ms, measured here on every 8th sample.
  const queuePcm=data=>{
    const samples=new Int16Array(data,0,data.byteLength>>1),rate=rates.outputRate,block=Math.round(rate*IMA_MOUTH_CHUNKS*IMA_CHUNK_SAMPLES/16000),size=block*IMA_SEGMENT_CHUNKS/IMA_MOUTH_CHUNKS;
    const buffer=new SharedArrayBuffer(samples.length*2);new Uint8Array(buffer).set(new Uint8Array(data,0,samples.length*2));
    const list=[];
    for(let start=0;start<samples.length;start+=size){
      const end=Math.min(samples.length,start+size),poses=[];
      for(let from=start;from<end;from+=block){
        let energy=0,n=0;for(let i=from;i<Math.min(end,from+block);i+=SAMPLE_STEP){energy+=samples[i]*samples[i];n++;}
        poses.push(mouthTrack.pose(n?Math.sqrt(energy/n):0,block/rate));
      }
      list.push({buffer,ima:false,offset:start,count:end-start,poses,audible:poses.some(pose=>pose>0),ms:(end-start)*1000/rate,step:block*1000/rate});
    }
    queueSegments(list);
  };
  const handle=text=>{
    const event=parseVoiceEvent(text,decode);
    switch(event.type){
      case 'ready':
        if(rates)return;provider=event.provider;rates={inputRate:event.inputRate,outputRate:event.outputRate};
        // The call opens with Robottino's greeting (the server asks ElevenLabs' agent for it, src/voice-stream.ts). With
        // the microphone open meanwhile, a noise in that second (the head turning to the face, the hand leaving the
        // screen) was taken by the provider for the user speaking: the greeting was cut off, the server dropped what
        // followed a turn with no words, and the robot stayed silent until the 30 s limit (13 Nov 2026, 23:36: no
        // greeting and nothing heard). So the microphone waits for the greeting: it opens when the greeting has been
        // said (the usual end of a reply), or after hooks.greetingMs with no greeting at all.
        {const wait=provider==='elevenlabs'?Number(hooks.greetingMs)||0:0;
          if(wait>0)greetingTimer=Timer.set(()=>{greetingTimer=undefined;if(!closed&&!speaker&&!microphone)listen('greeting');},wait);
          else openMicrophone();}
        lastActivity=Time.ticks;hooks.listening();return;
      case 'audio':queuePcm(event.data);return;
      case 'interrupt':dropReply();discarding=undefined;lastActivity=Time.ticks;endReply();if(speaker)openMicrophone();return;
      case 'pong':send(pongMessage(event.id));return;
      case 'search':if(event.active)work={kind:'search',at:Time.ticks};else if(work?.kind==='search')work.done=Time.ticks;return;
      case 'user':case 'assistant':{
        lastActivity=Time.ticks;if(event.type==='user')stats.u++;else stats.g++;const sentence=turns.apply(event);
        if(event.type==='user'){discarding=undefined;if(reply)endReply();if(!speaker&&microphone)heardAt=Time.ticks;}
        else{
          // Face and head follow the words of the reply: one gesture per reply.
          // TEMPORARY diagnostics (11 Nov 2026): what Robottino answered, on the USB log only.
          if(typeof trace==='function')trace(`[robottino] said "${String(event.text).slice(0,120).replace(/[\r\n"]/g,' ')}"\n`);
          // The user's last sentence gave no command, but Robottino says it moved its head: the robot does what it said.
          if(unheard!==undefined&&Time.delta(unheard)<10000&&replySee(event.text)){unheard=undefined;if(typeof trace==='function')trace('[robottino] see from reply\n');hooks.see?.();}
          if(unheard!==undefined){const fix=Time.delta(unheard)<10000?replyHeadCommand(event.text):null;unheard=undefined;if(fix){if(typeof trace==='function')trace(`[robottino] head from reply ${fix.direction}\n`);hooks.head?.(fix);}}
          // A voice tag of the reply ([laughs], [sighs]…: event.mood, src/robot-tools.ts) sets the face for the whole reply.
          if(event.mood)tagged=event.mood;
          reply=(reply+event.text).slice(-400);faceFromReply();const next=replyMood(reply);
          if(next){setMood(tagged??next.expression,gestured?null:next.gesture);if(next.gesture)gestured=true;}
        }
        if(!sentence)return;
        // With the rover answering, its sentences go to the rover first (15 Nov 2026): the head does not also turn.
        const timer=timerCommand(sentence),see=!timer&&event.type==='user'&&seeCommand(sentence);
        // «Esplora la stanza», «basta esplorare» (explore.js, 23 Nov 2026): taken by mod.js, with the rover or, without
        // it, standing still while the owner carries the robot. Before the faces: «basta» is also «basta facce».
        const roaming=timer||see||event.type!=='user'?null:exploreCommand(sentence);
        if(roaming&&hooks.explore?.(roaming)){unheard=unfaced=undefined;if(typeof trace==='function')trace(`[robottino] heard explore ${roaming}\n`);return;}
        const look=timer||see?null:faceCommand(sentence);
        const wheels=timer||see||look||event.type!=='user'||!hooks.roverReady?.()?null:roverCommand(sentence);
        const head=timer||see||look||wheels?null:headCommand(sentence);
        // TEMPORARY diagnostics (11 Nov 2026, «non si sposta a destra»): what the robot heard and what it made of it,
        // on the USB log only (never stored).
        if(typeof trace==='function')trace(`[robottino] heard "${String(sentence).slice(0,60).replace(/[\r\n"]/g,' ')}" head=${head?.direction??'-'} face=${look?.expression??'-'}${see?' see':''}\n`);
        unheard=event.type==='user'&&!timer&&!see&&!look&&!head&&!wheels?Time.ticks:undefined;
        // The sentence is always the user's (with OpenAI it is complete only when the reply starts): the reply read so far counts too.
        unfaced=!timer&&!see&&!look&&!head&&!wheels?Time.ticks:undefined;if(event.type==='assistant')faceFromReply();
        if(timer)hooks.timer?.(timer);else if(see)hooks.see?.();else if(look)hooks.face?.(look);else if(wheels)hooks.rover?.(wheels);else if(head)hooks.head?.(head);else if(isMemoryPhrase(sentence))send(memoryMessage(sentence));return;
      }
      // The agent's tools (src/robot-tools.ts): mod.js does it with all of its checks and says whether it could; the
      // answer goes back with the same id. A tool used on this sentence: the robot does not also act on the reply's
      // words («Ecco, guardo a destra»), which would do it twice.
      case 'tool':{
        unheard=undefined;unfaced=undefined;
        const id=event.id,session=pending;
        const answer=result=>{if(!closed&&pending===session)send(toolResultMessage(id,result));};
        let done;try{done=hooks.tool?hooks.tool(event.command):{ok:false,code:'closed'};}catch{done={ok:false,code:'closed'};}
        Promise.resolve(done).then(answer,()=>answer({ok:false,code:'closed'}));return;
      }
      // The Worker has the tools too (src/voice-stream.ts): the robot's clock-time reminders, for the greeting. Sent only
      // then: a Worker without the tools would close the call on a message it does not know.
      case 'tools':workerTools=event.notice;if(hooks.tool){if(event.room){let room=null;try{room=roomMessage(hooks.room?.());}catch{}if(room)send(room);}let items=[];try{items=hooks.agenda?.()??[];}catch{}send(agendaMessage(items));}return;
      case 'memory':hooks.memory?.(event);return;
      case 'error':stop('provider_error');return;
    }
  };
  async function start(){
    if(!closed||starting)return false;
    resetStats();
    const token=Preference.get('robottino','deviceToken');
    if(Preference.get('robottino','verified')!==true)throw Error('hardware_unverified');
    if(typeof token!=='string'||token.length<32)throw Error('missing_credential');
    if(typeof robot.audio?.acquireExclusive!=='function')throw Error('audio_unavailable');
    starting=true;cancelStart=false;
    try{releaseAudio=await acquireAudio();}finally{starting=false;}
    if(cancelStart){cancelStart=false;try{releaseAudio();}catch{}releaseAudio=undefined;return false;}
    closed=false;connected=false;workerTools=false;speakerVolume=1;rates=undefined;turns=new VoiceTurns();dropReply();lastFrameAt=undefined;lastPlayback=undefined;lastActivity=Time.ticks;
    const current={};pending=current;
    try{await robot.connectivity.network?.ready;}catch{stop('network');return false;}
    if(closed||pending!==current)return false;
    radio??=lowLatency(); // before the connection opens: the TLS handshake is quicker too
    // The TLS handshake keeps the robot busy: it starts once a head command has been confirmed (9 Nov 2026).
    for(let waited=0;waited<1500&&hooks.motionBusy?.();waited+=20)await new Promise(resolve=>Timer.set(resolve,20));
    if(closed||pending!==current)return false;
    // A failure here must still give the speaker back to the host.
    try{socket=new Client({host:'robottino-stackchan.example.workers.dev',port:443,path:'/api/robot/voice?audio=ima&lips=1'+(alaw?'&mic=alaw':'')+faceQuery()+(hooks.tool?'&tools=1':'')+(hooks.roverReady?.()?'&rover=1':'')+(hooks.explore?'&explore=1':''),headers:['Authorization','Bearer '+token]});}catch{stop('error');return false;}
    socket.callback=(type,value)=>{
      if(closed)return;
      try{
        if(type===Client.handshake){connected=true;lastActivity=Time.ticks;}
        else if(type===Client.receive){
          const size=typeof value==='string'?value.length:value instanceof ArrayBuffer?value.byteLength:Infinity;
          if(size>MAX_EVENT)stats.x++;else if(typeof value==='string')handle(value);else if(rates){const began=Time.ticks;queueFrame(value);stats.f=Math.max(stats.f,Time.ticks-began);} // binary: IMA frame (see SPEAKER)
        }
        else if(type===Client.disconnect)stop('closed');
      }catch(error){fault('ws',error);stop('error');}
    };
    timer=Timer.repeat(()=>{
      if(closed)return;
      if(++statTicks%5===0){report();micReport();}
      if(!rates&&Time.delta(lastActivity)>10000)stop('connect_timeout');
      // Not while exploring (owner, 23 Nov 2026: «quando è in esplorazione non deve esserci il timer dei 30 secondi
      // di silenzio»): the owner carries the robot around and says nothing.
      else if(!exploring&&Time.delta(lastActivity)>30000)stop('silence');
    },1000);
    return true;
  }
  // TEMPORARY speaker check without the network (K151 bring-up, 9 Nov 2026): a recorded phrase, already
  // in the Worker's IMA frames (each behind a 2-byte length), takes exactly the path of a reply: frames
  // 1.2 s ahead, the same driver, at the given volume. Resolves when the phrase has been played.
  async function selfTest(sound,{volume=1}={}){
    if(!closed||starting)return false;
    resetStats();
    if(typeof robot.audio?.acquireExclusive!=='function')throw Error('audio_unavailable');
    starting=true;cancelStart=false;
    try{releaseAudio=await acquireAudio();}finally{starting=false;}
    if(cancelStart){cancelStart=false;try{releaseAudio();}catch{}releaseAudio=undefined;return false;}
    closed=false;testing=true;speakerVolume=volume;connected=false;turns=new VoiceTurns();dropReply();lastFrameAt=undefined;lastActivity=Time.ticks;
    rates={inputRate:16000,outputRate:16000};
    const startedAt=Time.ticks;let at=0,sentMs=0;
    timer=Timer.repeat(()=>{
      if(closed)return;
      try{
        while(at+2<=sound.length&&sentMs-Time.delta(startedAt)<1200){
          const head=new Uint8Array(sound.read(at,at+2)),size=head[0]|head[1]<<8,frame=sound.read(at+2,at+2+size);at+=2+size;
          const bytes=new Uint8Array(frame);sentMs+=(size-2-bytes[1])/IMA_CHUNK_BYTES*IMA_CHUNK_SAMPLES/16;
          const began=Time.ticks;queueFrame(frame);stats.f=Math.max(stats.f,Time.ticks-began);
        }
        if(Time.delta(startedAt)>sentMs+10000)stop('test');
      }catch(error){failLater('test',error);}
    },100);
    return new Promise(resolve=>{testDone=resolve;});
  }
  // For the head lights: idle, connecting (until the provider is ready), listening, thinking (your words
  // were heard, the reply has not started yet) or speaking.
  const phase=()=>{
    if(closed)return starting?'connecting':'idle';
    if(speaker)return 'speaking';
    if(testing)return 'idle';
    if(!rates||!microphone)return 'connecting';
    const kind=working();if(kind)return kind==='search'?'searching':'looking';
    return heardAt!==undefined&&Time.delta(heardAt)<THINK_MS?'thinking':'listening';
  };
  // No head command now (mod.js): the conversation is starting (the host lends the audio, the connection opens, the
  // provider is not ready yet), or microphone or speaker have just been opened or closed.
  const busy=()=>{
    if(starting||(!closed&&!rates))return true;
    if(audioChangedAt===undefined)return false;
    const since=Time.delta(audioChangedAt);
    if(since>=0&&since<audioWindow)return true;
    audioChangedAt=undefined;return false;
  };
  // «Cos'è questo?»: a piece of the robot's picture goes among the microphone audio when the connection has room for
  // it (true), waits when it has not (false), and a closed conversation ends the picture (error). pictureFailed tells
  // the server that no picture will come, so Robottino says it could not see.
  const PICTURE_BACKLOG=4096;
  const picture=piece=>{if(closed||!connected||!socket)throw Error('closed');if((socket.bufferedAmount??0)>PICTURE_BACKLOG)return false;socket.write(piece);return true;};
  const pictureFailed=()=>send(JSON.stringify({type:'see.failed'}));
  // «Cos'è questo?» for the head lights (mod.js): 'start' when the picture is asked for, 'sent' when it has gone to
  // the server, 'end' when it could not be taken.
  const look=state=>{if(closed)return;if(state==='start')work={kind:'look',at:Time.ticks};else if(work?.kind==='look'){if(state==='sent')work.sent=Time.ticks;else work=undefined;}};
  // A timer or reminder that ends during the call: the agent says it (only to a Worker with the tools). True if sent.
  const notice=text=>{if(closed||!connected||!workerTools)return false;send(noticeMessage(text));return true;};
  // «Esplora» (explore.js): the server is told when it starts and ends, so that the pictures meanwhile are described as
  // discoveries; `say` asks the agent for a sentence of its own (the start from the iPhone, the end of the round).
  // still: no rover, the owner carries the robot (the opening words say so).
  const explore=(on,say=false,still=false,reason)=>{if(closed||!connected)return false;exploring=!!on;lastActivity=Time.ticks;send(JSON.stringify({type:'explore',on:!!on,say:!!say,still:!!still,...(reason?{reason}:{} )}));return true;};
  const person=name=>{
    if(closed||!connected||!exploring)return false;
    send(JSON.stringify({type:'explore',on:true,identityOnly:true,name:typeof name==='string'?name:null}));
    return true;
  };
  return {start,selfTest,notice,explore,person,stop:()=>stop('user'),interrupt,busy,picture,pictureFailed,look,get active(){return !closed;},get speaking(){return !closed&&!!speaker;},get phase(){return phase();}};
}
