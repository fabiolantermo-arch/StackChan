import {FACE_STYLES} from 'robottino-portrait-state';
import Timer from 'timer';
import Modules from 'modules';
import Preference from 'preference';
import Time from 'time';
import Resource from 'Resource';
import {MotionClock,italianSummerTime,ITALY_OFFSET} from 'robottino-clock';
import {TargetTracker} from 'robottino-tracker';
import {DanceController} from 'robottino-dance';
import {createExpressiveFace} from 'robottino-face';
import {parseTrackingPayload,MEDIAPIPE_BLE_SERVICE,MEDIAPIPE_BLE_MESSAGE_TYPE} from 'mediapipe-tracking-message';
import {LongPress,HeadSensorWatch,GESTURES} from 'robottino-voice-wire';
import {Reminders} from 'robottino-reminders';
import {launchWithNetworks,loadNetworks,saveNetworks} from 'robottino-wifi-switch';
import {HeadLights} from 'robottino-lights';
import {toHost,fromMeasurements,parseCalibration,storeCalibration,rawFromHost,rotationFromRaw,reachable,moveTime,safeRotation,narrowRange,servoPositions,HEAD_LIMITS,CalmWait,RETRY_STEP_MS} from 'robottino-calibration';
let running;
// Runs before the host connects to Wi-Fi: the host's own splash/Settings step runs unchanged,
// then the visible network (home first, else the iPhone hotspot) goes into its single slot.
export const onLaunch=Modules.has('app-default-behavior/on-launch')?()=>launchWithNetworks({
  hostLaunch:()=>Modules.importNow('app-default-behavior/on-launch').onLaunch(),
  preference:Preference,timer:Timer,
  scan:Modules.has('wifi-scan')?options=>Modules.importNow('wifi-scan').scanWiFiNetworks(options):undefined,
  log:event=>trace(`[robottino] wifi ${event}\n`)
}):undefined;
// A startup failure keeps the host's own error path (rethrow), but leaves the
// message in Preference so it can be read over USB from the nvs partition.
export function onContextCreated(robot){
  try{Preference.delete('robottino','startupError');}catch{}
  try{return startRobottino(robot);}
  catch(error){try{Preference.set('robottino','startupError',String(error?.stack??error).slice(0,240));}catch{}throw error;}
}
function startRobottino(robot){
  running?.close();
  const face=createExpressiveFace(),tracker=new TargetTracker(),dance=new DanceController();robot.ui.setFace(face);
  // Messages use the face's own large-print bubble; the host balloon is the fallback.
  const say=(text,options)=>{if(typeof face.behavior?.showMessage==='function')face.behavior.showMessage(face,text,options);else robot.ui.showBalloon(text);};
  const unsay=()=>{if(typeof face.behavior?.hideMessage==='function')face.behavior.hideMessage(face);};
  // TEMPORARY K151 voice diagnostics: last head-touch and conversation events, read over USB from nvs.
  // Robottino's buttons in the host's side menu close it, as the host's own buttons do: «Prova voce»
  // left it open over half the face with no way out (9 Nov 2026).
  let hostDrawerOpen=false;
  const closeHostDrawer=()=>{hostDrawerOpen=false;try{robot.ui.closeDrawer?.();}catch{}};
  const drawerAction=callback=>(...args)=>{closeHostDrawer();return callback(...args);};
  const voiceLog=[];const voiceDiag=entry=>{if(typeof trace==='function')trace(`[robottino] voice ${entry}\n`);voiceLog.push(entry);if(voiceLog.length>12)voiceLog.shift();try{Preference.set('robottino','voiceDiag',voiceLog.join(' ').slice(-200));}catch{}};
  const savedStyle=Preference.get("robottino","faceStyle");if(savedStyle!=="portrait"&&Object.hasOwn(FACE_STYLES,savedStyle??""))face.behavior.setStyle(face,savedStyle);
  const clock=new MotionClock(()=>Time.ticks,(a,b)=>Time.delta(a,b));
  // Italian time (owner's request, 9 Nov 2026): the host starts on its own preset (Tokyo, +9) and never applies
  // summer time. Rome: UTC+1, +1 hour of summer time (clock.js); checked again every minute. Only once the
  // host has the time from the network, so the host's own setting is saved as Paris (+1) for the next start.
  const applyItalianTime=()=>{
    const utc=Date.now();if(!(utc>Date.UTC(2025,0,1)))return;
    const dst=italianSummerTime(utc)?3600:0;
    if(Time.timezone!==ITALY_OFFSET)Time.timezone=ITALY_OFFSET;if(Time.dst!==dst)Time.dst=dst;
    try{if(Preference.get('time','timezone')!=='paris')Preference.set('time','timezone','paris');}catch{}
  };
  let timeCheckedAt;
  // Head lights (lights.js): set from the robot's state every 100 ms; a reminder stays lit until the head is touched.
  const lights=new HeadLights(robot.lighting);let reminderLit=false;
  const lightError=()=>lights.flashError(clock.now());
  // Head calibration (calibration.js): every pose goes through toHost(), with the measured centre and end
  // stops, or the host's own limits until the head has been measured. «Calibrazione fatta» now means
  // measured: the switch left on from before the measurements existed is turned off once.
  // A calibration saved before version 2 (checked only up to 46° and 30°) is not used: the owner measures again.
  let headCal=parseCalibration(Preference.get('robottino','headCal')),calibrating,autoArmAt,autoArmTries=0;
  const staleCal=!headCal&&typeof Preference.get('robottino','headCal')==='string';
  if(!headCal&&Preference.get('robottino','calibrated')===true){try{Preference.set('robottino','calibrated',false);}catch{}}
  // The robot's safety limits first (90° sideways, 0…85° up, never down), then the measured range. One speed for
  // every motion (calibration.js HEAD_SPEED), timed from where the head should be now: the last pose sent, part of
  // the way there while that move still runs. A servo reply lost on the line (the host waits 120 ms) is tried once
  // more with the same position, still confirmed by the servos: only a second failure is an error (9 Nov 2026,
  // «Errore comando remoto» with every position inside the checked range). The one repeat waits for a quiet moment
  // (calibration.js CalmWait, 10 Nov 2026: in a conversation both tries were judged lost within a quarter of a
  // second, «Errore nella danza remota»); it is not sent when the motions were stopped or blocked meanwhile.
  let headMove={from:{y:0,p:0},to:{y:0,p:0},start:0,duration:0};
  // Moving, or less than 150 ms since it stopped: the camera waits before taking a following frame (live-device.js).
  const SETTLE_MS=150;
  // For the head sensor the move lasts longer (11 Nov 2026: «tutto su», 60°, reckoned 0.35 s at the one head speed;
  // the real head was still arriving 1.3 s later, the sensor read 1 on one zone and the conversation was closed as by
  // a long touch): after a long move (LONG_MOVE s reckoned, about 43° and more) no touch counts until
  // HEAD_TOUCH_AFTER_MS after its reckoned end; after the short ones (nods, one 20° step) as before.
  const HEAD_TOUCH_AFTER_MS=2000,LONG_MOVE=.25;
  const headShaking=()=>{const now=clock.now();return Number.isFinite(now)&&now<headMove.start+headMove.duration*1000+(headMove.duration>=LONG_MOVE?HEAD_TOUCH_AFTER_MS:SETTLE_MS);};
  const headMoving=()=>{const now=clock.now();return Number.isFinite(now)&&now<headMove.start+headMove.duration*1000+SETTLE_MS;};
  const headNow=now=>{
    const m=headMove,t=m.duration>0?(now-m.start)/(m.duration*1000):1,k=Number.isFinite(t)?Math.max(0,Math.min(1,t)):1;
    return {y:m.from.y+(m.to.y-m.from.y)*k,p:m.from.p+(m.to.p-m.from.p)*k};
  };
  // TEMPORARY diagnostics (10 Nov 2026): the longest gap between two turns of the 100 ms loop while a servo command
  // waited. With the times of the two tries it tells a robot that was busy from a servo that did not answer.
  let loopGap=0,poseSentAt;
  // The servos have confirmed the pose in hand (10 Nov 2026). Set at the moment the host hears them (third argument
  // of setPose, host of 10 Nov evening; with an older host, when its promise settles). The 1.2 s check looks at
  // this, not at the end of the promise chain: with the robot speaking and following a face every promise turn waits
  // in the host's message queue, up to 0.4 s each, and a pose confirmed in time was reported as not confirmed.
  let poseConfirmed=false;
  // Runs now, not one promise turn later (same reason): the command leaves for the servos in the same turn of the loop.
  const soon=run=>{try{return Promise.resolve(run());}catch(error){return Promise.reject(error);}};
  const calmRetry=()=>new Promise(resolve=>{
    const wait=new CalmWait(clock.now());
    const step=()=>{if(closed||wait.step(clock.now(),headQuiet()))resolve(wait);else Timer.set(step,RETRY_STEP_MS);};
    Timer.set(step,RETRY_STEP_MS);
  });
  // onConfirmed (optional): called once, at the moment the servos confirm this pose.
  const setHeadPose=(rotation,minimum,onConfirmed)=>{
    const cal=calibrating?.trial??headCal,target=reachable(rotation,cal),now=clock.now(),from=headNow(now),duration=moveTime(from,target,minimum);
    if(!Number.isFinite(duration))throw Error('invalid_pose');
    const move={from,to:target,start:now,duration};headMove=move;
    const pose={rotation:toHost(safeRotation(rotation),cal)},revision=motionRevision,armed=tracker.enabled;
    // TEMPORARY diagnostics (10 Nov 2026, «Movimento non confermato» with nothing lost): when the command really
    // left for the host (h, after the request) and, for a pose confirmed in 250 ms or more, how long the host took.
    const send=()=>{
      const at=clock.now();poseSentAt=at;poseConfirmed=false;let heard;
      const confirm=()=>{if(headMove===move)poseConfirmed=true;if(heard===undefined){heard=clock.now();if(onConfirmed){const done=onConfirmed;onConfirmed=undefined;try{done();}catch{}}}};
      const result=robot.motion.setPose(pose,duration,confirm);
      // c: when the servos confirmed, e: when the promise settled (both after the command left).
      Promise.resolve(result).then(()=>{confirm();const took=clock.now()-at;if(took>=250&&typeof trace==='function')trace(`[robottino] pose slow h${Math.round(at-now)} c${Math.round(heard-at)} e${Math.round(took)} g${Math.round(loopGap)}\n`);},()=>{});
      return result;
    };
    loopGap=0;poseSentAt=undefined;poseConfirmed=false;
    return soon(send).catch(async error=>{
      if(closed||!/timed out/.test(String(error?.message??error)))throw error;
      // e: how long the lost try took (120–135 ms when JavaScript was on time), g: longest loop gap meanwhile.
      calDiag(`retry e${Math.round(clock.now()-now)} g${Math.round(loopGap)}`);
      const wait=await calmRetry();
      // Motions switched off or blocked meanwhile (menu, STOP from the iPhone, a fault): the repeat does not go and
      // the command stays unconfirmed. The calibration sends its poses with the motions off: compare, do not require.
      if(closed||revision!==motionRevision||tracker.enabled!==armed)throw error;
      const again=clock.now();loopGap=0;if(headMove===move)move.start=again;
      try{return await send();}
      catch(second){calDiag(`lost w${Math.round(wait.waited)} e${Math.round(clock.now()-again)} g${Math.round(loopGap)}`);throw second;}
    });
  };
  // TEMPORARY (K151 bring-up): the calibration steps in nvs robottino/calDiag and on the USB log.
  const calLog=[];const calDiag=entry=>{calLog.push(entry);if(calLog.length>12)calLog.shift();if(typeof trace==='function')trace(`[robottino] calibration ${entry}\n`);try{Preference.set('robottino','calDiag',calLog.join(' ').slice(-200));}catch{}};
  let session,timer,unsubscribe,unsubscribeTouch,closed=false,posePending=false;
  let live,remoteActive=false,cameraFollow=false,touchMotion,homeAfterLive=false,lookUpWanted=false;
  const LOOK_UP=25*Math.PI/180;
  let socketModule;try{socketModule=Modules.importNow('robottino-socket');}catch{}
  let arming=false,motionRevision=0,motionFault=false,pendingPose,poseStarted=0,armingStarted=0;
  let remoteDance;
  const reminders=new Reminders();let alertUntil;
  // Spoken face commands (owner, 11 Nov 2026): the face goes back to normal after 5 s.
  const FACE_HOLD_MS=5000;let faceHoldUntil;
  const showExpression=name=>{
    robot.face.setEyeOpen('left',name==='blink'?0:1);robot.face.setEyeOpen('right',name==='blink'?0:1);
    robot.face.setMouthOpen(name==='talk-open'?.8:name==='talk-small'?.3:0);robot.face.setEmotion(name==='happy'?3:name==='sad'?2:0);
  };
  const stopDance=()=>{if(remoteDance){const quiet=remoteDance.quiet;remoteDance=undefined;if(!quiet)showExpression('neutral');}dance.stop();tracker.clearTarget();face.behavior.setDanceActive(false);};
  const failMotion=(message,error)=>{calDiag('fail:'+message.slice(0,22)+(error===undefined?'':':'+String(error?.message??error).slice(0,40)));touchMotion=undefined;cameraFollow=false;pendingPose=undefined;posePending=false;motionFault=true;motionRevision++;arming=false;stopDance();tracker.stop();say(message);lightError();};
  const canTouchMove=()=>!closed&&!remoteActive&&!dance.active&&tracker.enabled&&!motionFault&&!posePending&&Preference.get('robottino','verified')===true&&Preference.get('robottino','calibrated')===true;
  const touchPose=(rotation,after)=>{
    const token={};pendingPose=token;posePending=true;poseConfirmed=false;poseStarted=clock.now();
    if(!Number.isFinite(poseStarted)){failMotion('Temporizzazione non valida: movimenti bloccati.');return;}
    void soon(()=>{if(closed||pendingPose!==token)return;return setHeadPose(rotation);})
      .then(()=>{if(!closed&&pendingPose===token&&touchMotion){tracker.yaw=rotation.y;tracker.pitch=rotation.p;after();}})
      .catch(error=>{if(!closed&&pendingPose===token)failMotion('Errore del movimento: nuovi movimenti bloccati.',error);})
      .finally(()=>{if(pendingPose===token){pendingPose=undefined;posePending=false;}});
  };
  const onPet=()=>{
    if(!canTouchMove()||touchMotion||Math.abs(tracker.yaw)>.12||Math.abs(tracker.pitch)>.12)return;
    const now=clock.now();if(!Number.isFinite(now))return;
    const origin={y:tracker.yaw,p:tracker.pitch,r:0};
    const target={y:origin.y,p:Math.max(-.15,Math.min(.15,origin.p-.04)),r:0};
    touchMotion={origin,restoreAt:now+3000};tracker.clearTarget();touchPose(target,()=>{});
  };
  // Small local head gestures (reply mood, alerts, idle glances): same limits and checks as dances. They start a
  // moment later: the face is redrawn and the sound starts first (10 Nov 2026).
  const GESTURE_DELAY_MS=300;
  const POSE_DONE_MS=5000;
  // TEMPORARY diagnostics (11 Nov 2026): why a gesture was refused, on the USB log.
  // A spoken head command (`voice`) also goes while the iPhone is connected (owner, 11 Nov 2026: «Sì, anche nel Live»);
  // every other local gesture still waits for the iPhone to let go.
  const gestureBlock=(voice=false)=>closed?'closed':remoteActive&&!voice?'remote':!tracker.enabled?'motors_off':motionFault?'fault':posePending?'pose_pending':dance.active?'dance':remoteDance&&!(voice&&remoteDance.quiet&&!remoteDance.voice)?'gesture':touchMotion?'touch':Preference.get('robottino','verified')!==true?'unverified':Preference.get('robottino','calibrated')!==true?'uncalibrated':'';
  // Where the head was before a reply's gesture began, while one runs: a spoken command starts from there, not from
  // the middle of a nod.
  const restPose=()=>remoteDance?.quiet&&!remoteDance.voice&&remoteDance.origin?remoteDance.origin:{y:headMove.to.y*180/Math.PI,p:headMove.to.p*180/Math.PI};
  const gesture=(steps,voice=false)=>{
    const blocked=gestureBlock(voice);
    if(blocked){if(typeof trace==='function')trace(`[robottino] gesture refused ${blocked}\n`);return false;}
    const now=clock.now();if(!Number.isFinite(now))return false;
    // Around where the head is (9 Nov 2026: with the head raised to look at the owner, a nod used to bring it down).
    const base=voice?restPose():{y:headMove.to.y*180/Math.PI,p:headMove.to.p*180/Math.PI};
    // A spoken command takes the place of a reply's own little gesture still running (11 Nov 2026: «sinistra» said while
    // Robottino nodded at its previous answer was refused, «Ora non posso muovere la testa»); never of another spoken
    // command, and never of a dance.
    remoteDance={steps:steps.map(step=>({...step,yaw:step.yaw+base.y,pitch:Math.min(0,step.pitch+base.p)})),index:-1,nextAt:now+GESTURE_DELAY_MS,quiet:true,voice,origin:base};return true;
  };
  // Spoken head commands (voice-wire.js headCommand, owner 11 Nov 2026): one step of VOICE_TURN° from where the head
  // is, or back to straight ahead. Right and left are the user's, facing the robot (owner, 11 Nov 2026: «destra e
  // sinistra sono invertite»): «a destra» is positive yaw, the robot's own left. The step goes as a local gesture: the same checks, limits and calibration as every pose.
  // A side always ends on that side of straight ahead (11 Nov 2026: with the head 20° to the right, «sinistra» only
  // brought it back to the middle and had to be said twice): at least VOICE_TURN° that way, or one step more.
  const VOICE_TURN=20,VOICE_STEP_MS=700,FOLLOW_PAUSE_MS=5000;let followPausedUntil=0;
  // full («tutto a destra»): as far as the head goes; setHeadPose stops it at the calibrated end of the range.
  // A pose already on its way (following a face sends one every few hundred ms) only delays a spoken command: it
  // waits for that pose, up to VOICE_WAIT_MS, then goes (voiceRetry, in the loop).
  const VOICE_WAIT_MS=1500;let voiceRetry;
  const voiceLook=(direction,full=false,until)=>{
    if(cameraFollow)followPausedUntil=Math.max(followPausedUntil,clock.now()+FOLLOW_PAUSE_MS);
    if(posePending&&!gestureBlock(true).replace('pose_pending','')){
      const now=clock.now();until??=now+VOICE_WAIT_MS;
      if(now<until){voiceRetry={direction,full,until};return true;}
    }
    if(direction==='shake')return gesture(GESTURES.shake,true);
    const base=restPose();
    const target=direction==='center'?{y:0,p:0}:full?{y:direction==='right'?90:direction==='left'?-90:base.y,p:direction==='up'?-85:direction==='down'?0:base.p}:{y:Math.max(-80,Math.min(80,direction==='right'?Math.max(base.y+VOICE_TURN,VOICE_TURN):direction==='left'?Math.min(base.y-VOICE_TURN,-VOICE_TURN):base.y)),p:Math.max(-80,Math.min(0,base.p+(direction==='up'?-VOICE_TURN:direction==='down'?VOICE_TURN:0)))};
    // TEMPORARY diagnostics (11 Nov 2026, «non sente in su»): where the head was asked to go, on the USB log only.
    if(typeof trace==='function')trace(`[robottino] look ${direction} ${Math.round(base.y)},${Math.round(base.p)} -> ${Math.round(target.y)},${Math.round(target.p)}\n`);
    const moved=gesture([{yaw:target.y-base.y,pitch:target.p-base.p,durationMs:VOICE_STEP_MS}],true);
    // Following a face, the head would turn straight back to it: following waits FOLLOW_PAUSE_MS from the command
    // (set above, so no new following pose starts meanwhile), then starts again from where the head now is.
    if(moved&&cameraFollow){followPausedUntil=clock.now()+FOLLOW_PAUSE_MS;tracker.clearTarget();}
    return moved;
  };
  // The white robot's happy frame has an open mouth: in a silent mood it keeps its closed smile (neutral).
  const setMood=expression=>robot.face.setEmotion(expression==='happy'&&face.behavior.getStyle?.()!=='white'?3:expression==='sad'?2:0);
  const alert=(text,expression='happy',steps=GESTURES.nod,sound='avviso.bin')=>{
    say(text);setMood(expression);alertUntil=clock.now()+5000;if(sound)playSound(sound);gesture(steps);
  };
  // Claude Code hooks reach the robot as fixed reactions (no free text from the network).
  const reactions={
    attention:()=>{alert('Claude Code ti chiede un permesso.','neutral',GESTURES.tilt);reminderLit=true;},
    done:()=>alert('Claude Code ha finito.','happy',GESTURES.nod),
    success:()=>alert('Test superati!','happy',GESTURES.nod,'sami-risata.bin'),
    failure:()=>alert('Qualcosa non va: controlla Claude Code.','sad',GESTURES.shake)
  };
  let touchSoundPlaying=false,touchSoundAt,touchSoundId=0;
  // Long press on the head starts or ends a conversation; a short tap keeps the smile and laugh.
  let voice;const longPress=new LongPress(900);
  // Nothing that holds JavaScript up for long is going on: the host is not starting or stopping the camera (about a
  // second, live-device.js), no connection is being opened (TLS handshake), the conversation is not starting and has
  // not just changed between microphone and speaker (voice-device.js busy(), 10 Nov 2026). Otherwise no head command
  // leaves, and the repeat of a lost one waits too (calmRetry).
  const headQuiet=()=>!(live?.busy?.()||socketModule?.connecting?.()||voice?.busy?.());
  // The head sensor's three zones read straight from the host (voice-wire.js HeadSensorWatch, 10 Nov 2026): a
  // reading stuck above 0 silences the host's gestures, so the robot then recognises the long press and the tap
  // itself. TEMPORARY diagnostics: every change of the zones on the USB log; the last ones in nvs robottino/touchDiag
  // (seconds since start:zones; S/E stuck start/end, L/T long press/tap of the robot's own reading, h+letter the
  // host's gestures), written at most every 10 s and only after something happened.
  const headWatch=new HeadSensorWatch(),touchLog=[];let touchLogDirty=false,touchLogSavedAt;
  const touchDiag=(entry,save=false)=>{touchLog.push(entry);if(touchLog.length>16)touchLog.shift();if(save)touchLogDirty=true;};
  const saveTouchDiag=now=>{
    if(!touchLogDirty||now-touchLogSavedAt<10000)return;
    touchLogDirty=false;touchLogSavedAt=now;try{Preference.set('robottino','touchDiag',touchLog.join(' ').slice(-200));}catch{}
  };
  const voiceMessages={user:'Conversazione chiusa.',silence:'Conversazione chiusa dopo 30 secondi di silenzio.',closed:'Conversazione terminata.',connect_timeout:'Servizio vocale non raggiungibile.',network:'Rete non disponibile.',provider_error:'Il servizio vocale ha segnalato un errore.',error:'Conversazione interrotta.'};
  // One long touch on the screen is also felt by the head sensor (K151, 9 Nov 2026): a second
  // start/stop within 2 s is the same gesture and is ignored.
  let lastToggleAt;
  const ensureVoice=()=>{
    if(voice)return true;
    if(!Modules.has('robottino-voice-device')){say('Conversazione non disponibile in questo firmware.');return false;}
    const {createVoiceDevice}=Modules.importNow('robottino-voice-device');
    voice=createVoiceDevice(robot,{
      motionBusy:()=>posePending,
      stats(text,test){try{Preference.set('robottino',test?'voiceTest':'voiceStats',String(text).slice(0,120));}catch{}},
      faceStyle:()=>face.behavior.getStyle?.(),
      // No «Ti ascolto» banner over the face (owner's choice, 9 Nov 2026): «Mi collego…» just goes away.
      listening(){voiceDiag('listen');if(!closed)unsay();},
      ended(reason){voiceDiag('end:'+reason);faceHoldUntil=undefined;if(!closed&&reason!=='test'){setMood('neutral');say(voiceMessages[reason]??'Conversazione terminata.');if(['connect_timeout','network','provider_error','error'].includes(reason))lightError();}},
      // A face asked for by voice stays (the smile FACE_HOLD_MS, sad and angry until told): the reply's own mood does
      // not replace it meanwhile.
      mood(value){if(closed)return;if(faceHoldUntil===undefined)setMood(value.expression);if(value.gesture)gesture(GESTURES[value.gesture]);},
      face(command){
        if(closed)return;
        // An explicit smile: the happy picture of every face, the white robot's open-mouth one too. Angry is emotion 1
        // (portrait-state.js), with its own pictures since 11 Nov 2026.
        // Sad and angry stay until the user says to go back («torna felice», «torna normale»: owner, 11 Nov 2026) or
        // the conversation ends; the smile stays FACE_HOLD_MS.
        if(command.expression==='normal'){faceHoldUntil=undefined;setMood('neutral');return;}
        robot.face.setEmotion(command.expression==='happy'?3:command.expression==='angry'?1:2);faceHoldUntil=command.expression==='happy'?clock.now()+FACE_HOLD_MS:Infinity;
      },
      head(command){if(!closed&&!voiceLook(command.direction,command.full===true))say('Ora non posso muovere la testa.');},
      // «Cos'è questo?»: one picture from the robot's camera goes to the server over the conversation (live-device.js
      // snapshot); when it cannot be taken the server is told, and Robottino says it could not see.
      see(){
        if(closed)return;
        const failed=()=>{try{voice?.pictureFailed?.();}catch{}};
        if(typeof trace==='function')trace('[robottino] see\n');
        if(typeof live?.snapshot!=='function'){failed();return;}
        void live.snapshot(piece=>voice.picture(piece)).then(ok=>{if(typeof trace==='function')trace(`[robottino] see ${ok?'sent':'failed'}\n`);if(!ok)failed();},failed);
      },
      timer(command){if(closed)return;const line=reminders.apply(command,clock.now());if(line)say(line);},
      memory(event){if(!closed&&event.confirmation)say('Per cancellare tutti i ricordi usa l’app iPhone: Studio → Ricordi.');}
    });
    return true;
  };
  // TEMPORARY (K151 bring-up, 9 Nov 2026): the same short phrase twice. 1: the laugh's own path at the host
  // volume; 2: exactly the path of a call (IMA frames from the Worker's encoder, ElevenLabs level, fed 1.2 s
  // ahead like the network, the laugh's driver at full volume). The earlier test found the crackle: the
  // amplifier clips near full scale.
  let voiceTesting=false;
  const pause=ms=>new Promise(resolve=>Timer.set(resolve,ms));
  const testVoice=()=>{
    if(closed)return;
    try{
      if(!ensureVoice())return;
      if(voice.active||voiceTesting){say('Chiudi prima la conversazione.');return;}
      if(typeof robot.audio?.playAudio!=='function'){say('Prova voce non disponibile.');return;}
      // The same phrase as a WAV for the host (pass 1) and in IMA frames, as the Worker sends it (pass 2).
      const sound=new Resource('prova-voce.bin'),ima=new Resource('prova-voce-ima.bin'),phrase={length:ima.byteLength,read:(start,end)=>ima.slice(start,end)};
      const host=Number(robot.audio.volume),level=Number.isFinite(host)&&host>0&&host<=1?host:0.5,shown=String(Math.round(level*100)/100).replace('.',',');
      voiceTesting=true;voiceDiag('test');
      void Promise.resolve()
        .then(()=>{say(`Prova 1 di 2: suono della risata, volume ${shown}`,{sticky:true});return robot.audio.playAudio(sound.slice(0));})
        .then(()=>pause(1500))
        .then(()=>{say('Prova 2 di 2: voce della chiamata',{sticky:true});return voice.selfTest(phrase,{volume:1});})
        .then(()=>{if(!closed)say('Prova finita: la 2 gracchia o va a scatti?');})
        .catch(error=>{
          const reason=String(error?.message??error);voiceDiag('err:'+reason.slice(0,40));lightError();
          if(!closed)say(reason==='audio busy'?'Audio occupato: aspetta la fine del suono, poi riprova.':'Prova voce non riuscita.');
        })
        .finally(()=>{voiceTesting=false;});
    }catch(error){voiceTesting=false;voiceDiag('throw:'+String(error?.message??error).slice(0,40));say('Prova voce non disponibile.');}
  };
  const afterPose=(run,waited=0)=>{
    if(closed||voice?.active)return;
    if(posePending&&waited<1500){Timer.set(()=>afterPose(run,waited+20),20);return;}
    run();
  };
  const toggleVoice=()=>{
    if(closed)return;
    const toggledAt=clock.now();if(Number.isFinite(lastToggleAt)&&Number.isFinite(toggledAt)&&toggledAt-lastToggleAt<2000){voiceDiag('dup');return;}lastToggleAt=toggledAt;
    voiceDiag(voice?.active?'tog:stop':'tog:start');
    if(voice?.active){voice.stop();return;}
    try{
      if(!ensureVoice())return;
      say('Mi collego…');
      // The audio drivers change and the connection opens only once the servos have confirmed the command they are
      // waiting for (at most 1.2 s, the pose watchdog): starting meanwhile made that confirmation look lost.
      afterPose(()=>{
        voiceDiag('start');
        void voice.start().catch(error=>{
          const reason=String(error?.message??error);voiceDiag('err:'+reason.slice(0,40));lightError();
          say(reason==='hardware_unverified'?'Conversazione bloccata finché l’hardware non è verificato.':reason==='missing_credential'?'Abbina prima il robot: dal menu scegli «Abbina con l’app».':reason==='audio busy'?'Audio occupato: aspetta la fine del suono o chiudi la chiamata Live, poi riprova.':reason==='audio_unavailable'?'Audio non disponibile in questo firmware.':'Non riesco ad avviare la conversazione. Riprova.');
        });
      });
    }catch(error){voiceDiag('throw:'+String(error?.message??error).slice(0,40));say('Conversazione non disponibile in questo firmware.');}
  };
  const playTouchSound=()=>playSound('sami-risata.bin');
  const playSound=name=>{
    if(closed||typeof robot.audio?.playAudio!=='function')return;
    // TEMPORARY diagnostics: why a sound did not play («Ora non funziona più la risata», 9 Nov 2026).
    if(voice?.active){voiceDiag('L:voce');return;} // the speaker belongs to the conversation
    // A sound the host never finishes must not silence the laugh for good: retry after 8 s.
    const now=clock.now();
    if(touchSoundPlaying&&!(Number.isFinite(now)&&Number.isFinite(touchSoundAt)&&now-touchSoundAt>=8000)){voiceDiag('L:occ');return;}
    // Do not interrupt music, radio, recording, or a live call.
    if(robot.audio.microphone?.recording){voiceDiag('L:mic');return;}
    const media=robot.audio.media?.state, radio=robot.audio.webRadio?.state;
    if((media&&!['idle','ended','error'].includes(media))||(radio&&!['idle','error'].includes(radio))){voiceDiag('L:media');return;}
    touchSoundPlaying=true;touchSoundAt=now;const id=++touchSoundId;
    void Promise.resolve().then(()=>{if(!closed)return robot.audio.playAudio(new Resource(name).slice(0));})
      .then(played=>{if(played===false)voiceDiag('L:no');},error=>{voiceDiag('L:err:'+String(error?.message??error).slice(0,20));})
      .finally(()=>{if(id===touchSoundId)touchSoundPlaying=false;});
  };
  // TEMPORARY hardware diagnostics (first K151 bring-up): read back over USB from nvs.
  face.behavior.onFaceError=(error,frame)=>{try{Preference.set('robottino','faceError',`${frame}: ${String(error?.stack??error)}`.slice(0,200));}catch{}};
  // K151 screen: when audio starts the panel has lost settings (red/blue swapped after a laugh,
  // black screen when a conversation starts; hardware, 9 Nov 2026; cause inside the host not
  // found). Every 2 s re-send the CoreS3 target's own init sequence except the 0x01 panel reset:
  // the colour order through the driver (same rotation → MADCTL), then power, gamma, pixel
  // format, sleep out, display on and inversion. Same values: nothing visible changes.
  const PANEL_INIT=[[0xC8,0xFF,0x93,0x42],[0xC0,0x12,0x12],[0xC1,0x03],[0xB0,0xE0],[0xF6,0x00,0x01,0x01],[0x3A,0x55],[0xB6,0x08,0x82,0x27],
    [0xE0,0x00,0x0C,0x11,0x04,0x11,0x08,0x37,0x89,0x4C,0x06,0x0C,0x0A,0x2E,0x34,0x0F],[0xE1,0x00,0x0B,0x11,0x05,0x13,0x09,0x33,0x67,0x48,0x07,0x0E,0x0B,0x2E,0x33,0x0F],[0x11],[0x29],[0x21]];
  // Sound and conversation make the panel lose its settings (backlight stays on): restore faster then.
  let lastScreenCheck=clock.now();
  const restoreScreenColours=()=>{try{const s=globalThis.screen;if(!s||!Number.isInteger(s.rotation))return;s.rotation=s.rotation;if(typeof s.command!=='function')return;for(const [id,...data] of PANEL_INIT)s.command(id,Uint8Array.from(data));}catch{}};
  let diagAt=clock.now()+8000;
  const writeDiag=()=>{try{const c=face.container;Preference.set('robottino','faceDiag',`f=${face.x},${face.y},${face.width}x${face.height} v=${face.visible} p=${c?.x},${c?.y},${c?.width}x${c?.height} t=${face.time} fr=${face.behavior.frame}`.slice(0,200));}catch(error){try{Preference.set('robottino','faceDiag','err '+String(error).slice(0,180));}catch{}}};
  const close=()=>{if(closed)return;try{headSensitivity(3);}catch{}closed=true;lights.close();endCalibration();voice?.stop();pairing?.stop();liveRevision++;cancelReconnect();live?.close();motionRevision++;arming=false;pendingPose=undefined;stopDance();tracker.stop();if(timer!==undefined)Timer.clear(timer);unsubscribe?.();unsubscribeTouch?.();session?.close();face.behavior.dispose?.(face);face.stop();robot.ui.drawer.removeDrawerButton('robottino:motion');robot.ui.drawer.removeDrawerButton('robottino:stop');robot.ui.drawer.removeDrawerButton('robottino:dance');robot.ui.drawer.removeDrawerButton('robottino:live');robot.ui.drawer.removeDrawerButton('robottino:pair');robot.ui.drawer.removeDrawerButton('robottino:verified');robot.ui.drawer.removeDrawerButton('robottino:calibrated');robot.ui.drawer.removeDrawerButton('robottino:menu');robot.ui.drawer.removeDrawerButton('robottino:voicetest');try{restoreToggle?.();}catch{}};
  running={close};
  // The cloud closes the device whenever the phone leaves or the 10-minute
  // session ends: reconnect with bounded backoff until the MOD is stopped.
  // First retry after 1 s: the phone often reconnects right away (a face choice, the Test page).
  let liveRevision=0,reconnectTimer,reconnectDelay=1000;
  const cancelReconnect=()=>{if(reconnectTimer!==undefined)Timer.clear(reconnectTimer);reconnectTimer=undefined;};
  const scheduleReconnect=revision=>{
    if(closed||revision!==liveRevision||reconnectTimer!==undefined)return;
    const delay=reconnectDelay;reconnectDelay=Math.min(60000,reconnectDelay*2);
    reconnectTimer=Timer.set(()=>{reconnectTimer=undefined;if(!closed&&revision===liveRevision)connectLive();},delay);
  };
  // First pairing: without its credential the robot shows a code to type in the iPhone app.
  let pairing;
  const hasCredential=()=>{const token=Preference.get('robottino','deviceToken');return typeof token==='string'&&token.length>=32;};
  const pairingMessages={expired:'Codice scaduto: dal menu scegli «Abbina con l’app».',network:'Rete non disponibile: abbinamento rimandato.',closed:'Abbinamento interrotto: dal menu scegli «Abbina con l’app».',store_failed:'Credenziale non salvata: riprova dal menu.',error:'Abbinamento non riuscito: riprova dal menu.'};
  // TEMPORARY (K151 bring-up): the last pairing steps in nvs robottino/pairDiag.
  const pairLog=[];const pairDiag=entry=>{pairLog.push(entry);if(pairLog.length>12)pairLog.shift();try{Preference.set('robottino','pairDiag',pairLog.join(' ').slice(-200));}catch{}};
  const showCode=code=>say(`Abbina il robot: nell’app iPhone apri Robot → Abbina robot e scrivi ${code.slice(0,3)} ${code.slice(3)}`,{sticky:true});
  const startPairing=()=>{
    if(closed||!Modules.has('robottino-pairing-device'))return;
    // A second press (or a touch felt twice) must not cancel the code being typed: show it again.
    if(pairing?.active){pairDiag('again');if(pairing.code)showCode(pairing.code);return;}
    if(!pairing){
      const {createPairing}=Modules.importNow('robottino-pairing-device');
      pairing=createPairing(robot,{
        diag:pairDiag,
        code(code){if(!closed)showCode(code);},
        ended(reason){if(closed)return;if(reason==='paired'){say('Robot abbinato: mi collego.');connectLive();}else if(reason==='user')unsay();else{say(pairingMessages[reason]??pairingMessages.error);lightError();}}
      });
    }
    say('Preparo il codice di abbinamento…');
    void pairing.start().catch(()=>{say(pairingMessages.error);lightError();});
  };
  const connectLive=()=>{
    if(!Modules.has('robottino-live-device'))return;
    if(!hasCredential()){startPairing();return;}
    cancelReconnect();
    const revision=++liveRevision;
    try{
    live?.close();
    const {createLiveDevice}=Modules.importNow('robottino-live-device');
    live=createLiveDevice(robot,{
      online(){if(revision===liveRevision)reconnectDelay=1000;},
      connected(){if(calibrating)cancelCalibration();touchMotion=undefined;remoteActive=true;cameraFollow=false;homeAfterLive=false;stopDance();tracker.clearTarget();},
      // The iPhone left: what it started stops (following, dance), the head stays where it is and the motions stay as
      // the owner set them (9 Nov 2026: they were switched off at every end of Live or Test, so following was refused).
      // Only the iPhone's explicit STOP switches them off.
      // Leaving the Live (owner, 9 Nov 2026): the head goes back straight ahead, as at the start.
      disconnected(){remoteActive=false;cameraFollow=false;homeAfterLive=true;stopDance();tracker.clearTarget();scheduleReconnect(revision);},
      stop(emergency){cameraFollow=false;stopDance();if(emergency)tracker.stop();else tracker.clearTarget();},
      // «Segui il mio viso»: the robot camera's frames go to the iPhone, which answers where the face is.
      follow(enabled){
        if(!enabled){if(cameraFollow){cameraFollow=false;tracker.clearTarget();}return;}
        if(closed||!remoteActive||!tracker.enabled||motionFault||posePending||remoteDance||dance.active)throw Error('motion_unavailable');
        cameraFollow=true;tracker.clearTarget();
      },
      headPose:()=>({y:tracker.yaw,p:tracker.pitch}),
      aim(value){return !closed&&cameraFollow&&clock.now()>=followPausedUntil&&tracker.enabled&&!motionFault&&tracker.aim(value.x,value.y,value.pose,clock.now());},
      reaction(kind){if(!closed)reactions[kind]?.();},
      faceStyle(style){if(!Object.hasOwn(FACE_STYLES,style))throw Error("invalid_style");Preference.set("robottino","faceStyle",style);face.behavior.setStyle(face,style);},
      motionEnabled:()=>tracker.enabled&&!motionFault,
      // A head command waiting for the servos' confirmation: the camera waits, so the replies on the servo line are
      // read at once (9 Nov 2026: with the camera busy, a reply read late looked lost and the 1.2 s check fired).
      motionBusy:()=>posePending,
      headMoving,
      conversation:()=>!!voice?.active,
      listening:()=>voice?.phase==='listening', // following sends small frames meanwhile: the microphone comes first
      speaking:()=>!!voice?.speaking, // following sends nothing meanwhile: the voice comes first
      dance(steps){
        if(closed||!remoteActive||!tracker.enabled||motionFault||posePending||dance.active||remoteDance||cameraFollow)throw Error('motion_unavailable');
        const now=clock.now();if(!Number.isFinite(now))throw Error('invalid_clock');
        remoteDance={steps,index:-1,nextAt:now};
      },
      async motion(value){
        if(closed||!remoteActive||!tracker.enabled||motionFault||posePending||remoteDance||cameraFollow||!headQuiet())throw Error('motion_unavailable');
        // 90° sideways and up to 85° from the iPhone (owner, 9 Nov 2026), at the one head speed: the servos confirm
        // the command at once and the head gets there in up to about 7 s.
        const rotation=safeRotation({y:value.yaw*Math.PI/180,p:value.pitch*Math.PI/180});
        const token={};pendingPose=token;posePending=true;poseConfirmed=false;poseStarted=clock.now();
        if(!Number.isFinite(poseStarted)){failMotion('Temporizzazione non valida: movimenti bloccati.');throw Error('invalid_clock');}
        let superseded=false;
        try{await setHeadPose(rotation);superseded=pendingPose!==token;}
        catch(error){if(!closed&&pendingPose===token)failMotion('Errore comando remoto: movimenti bloccati.',error);throw error;}
        finally{if(pendingPose===token){pendingPose=undefined;posePending=false;}}
        if(closed||superseded||motionFault)throw Error('motion_cancelled');
        // The servos confirmed the pose: that is where the head is, even if the iPhone left meanwhile (not a fault).
        tracker.yaw=rotation.y;tracker.pitch=rotation.p;
        if(!remoteActive)throw Error('motion_cancelled');
      }
    });
    void live.connect().catch(()=>{say('Live: connessione non disponibile.');lightError();scheduleReconnect(revision);});
    }catch{say('Live: moduli del firmware host non compatibili. Volto e comandi locali restano disponibili.');lightError();}
  };
  if(Modules.has('robottino-live-device')){
    robot.ui.drawer.addDrawerButton({key:'robottino:live',label:'Collega Live iPhone',callback:drawerAction(connectLive)});
    connectLive();
  }
  // A short touch on the head: it interrupts Robottino while it talks; otherwise it smiles and laughs.
  const headTap=()=>{if(voice?.speaking)voice.interrupt();else if(face.behavior.reactToTouch('head',{gesture:'press'}))playTouchSound();};
  // Shared upstream sensor is owned/started by the host. Remove only our listener.
  const touchPanel=robot.input?.touchPanel;
  // Head sensor (Si12T) sensitivity. Measured on the K151 on 10 Nov 2026 evening with «Prova sensore testa», cable in:
  // nothing on the head reads 0 at every level, also while the robot laughs; the whole palm reads 3 on all zones up
  // to level 6 (more than 3% of capacitance change); one fingertip reads 0 even at level 0 (less than 0.40%): the
  // sensor feels a hand, not a fingertip, and no setting changes that. So that a few fingers are enough, the MOD
  // sets level 1 (thresholds 0.55 / 0.70 / 0.85% instead of the host's 0.95 / 1.20 / 1.45% at level 3) and acts only
  // on a touch that reached 2 on some zone (HEAD_GATE: 0.70%), so a weak 1 now and then does nothing. Level 0 stays
  // out: in the morning the three zones went to 3 for seconds with nobody touching (a hand nearby is enough) and the
  // robot laughed and started conversations by itself. The host's level 3 is put back when the robot is stopped.
  // 19:10 of the same evening: after a restart, at level 1 the three zones read 2 and 3 for more than a minute and a
  // half with nobody touching, and conversations started by themselves. Level 1 is kept only together with three
  // guards (host of 10 Nov night, whose driver can reset the chip's reference):
  // - the reference is reset at start and whenever a reading stays above 0 for HEAD_REF_MS (nobody holds
  //   the head that long: a long press acts after 0.9 s), so a phantom state is cleared instead of lasting;
  // - a touch counts only if it began from a clean reading: all zones at 0 for HEAD_CLEAN_MS, since start, since
  //   the last reset and since the last moment the robot was busy switching camera, connection or audio;
  // - it must reach HEAD_GATE on some zone.
  // 20:40 of the same evening: with the three guards, at level 1 the three zones still jumped from 0 to 2 together
  // for a tenth of a second at a time, with nobody near, and each clean jump was taken for a pat: the robot laughed
  // by itself. Level 1 is given up: the host's level 3, any reading counts. The guards stay (they cost nothing).
  const HEAD_LEVEL=3,HEAD_GATE=1,HEAD_REF_MS=4000,HEAD_CLEAN_MS=300,HEAD_RESET_MS=310;
  let headCleanSince,headArmed=false,headBusySince,headResetUntil,headStarting=true;
  const headReference=on=>{try{touchPanel?.configure?.({referenceReset:on});}catch{}};
  // The chip keeps taking its reference for HEAD_RESET_MS, then senses again. After the reset made at start the
  // reading counts as clean at once (the next turn of the loop corrects it if a zone is above 0).
  const headReset=()=>{
    headReference(true);headResetUntil=true;headCleanSince=undefined;headBusySince=undefined;headArmed=false;
    if(typeof trace==='function')trace('[robottino] head reference reset\n');
    Timer.set(()=>{headReference(false);headResetUntil=undefined;if(headStarting){headStarting=false;if(!closed)headCleanSince=clock.now()-HEAD_CLEAN_MS;}},HEAD_RESET_MS);
  };
  // One turn of the loop with the zones just read: keeps the guards up to date.
  const headGuard=(now,levels)=>{
    const touched=Math.max(...levels)>0;
    if(headResetUntil!==undefined)return;
    if(!touched||!headQuiet()){headBusySince=undefined;}
    // The head moving is felt as a touch (11 Nov 2026, 14:19: right after «tutto in alto» a long press of strength 1
    // closed the conversation with nobody touching): no reading is clean while it moves, nor until it has settled.
    if(touched||!headQuiet()||headShaking()){headCleanSince=undefined;}else if(headCleanSince===undefined)headCleanSince=now;
    if(headShaking())headArmed=false; // a press already under way when the head starts moving does not count either
    if(touched){
      if(headBusySince===undefined)headBusySince=now;
      else if(now-headBusySince>=HEAD_REF_MS){
        headReset();
        // If a hand was really there, the reference now includes it: once more a little later, with the zones at 0.
        Timer.set(()=>{if(!closed&&headResetUntil===undefined&&Math.max(0,...(touchPanel?.sample??[]))===0)headReset();},3000);
      }
    }
  };
  const headClean=now=>headResetUntil===undefined&&headCleanSince!==undefined&&now-headCleanSince>=HEAD_CLEAN_MS;
  let headPeak=0;
  const headSensitivity=level=>{try{touchPanel?.configure?.({sensitivityType:0,sensitivityLevel:level});}catch{}};
  headSensitivity(HEAD_LEVEL);
  let headPressAt;
  if(touchPanel)headReset(); // at start: whatever the chip took as its reference, it takes it again now
  if(typeof touchPanel?.subscribe==='function')unsubscribeTouch=touchPanel.subscribe(event=>{
    if(!closed){
      // TEMPORARY diagnostics (9 Nov 2026, «tenendo il dito sul sensore superiore non parte la chiamata»): every head
      // gesture on the USB log (no flash write), to see whether the touches arrive and whether a hold becomes a swipe.
      if(typeof trace==='function')trace(`[robottino] head ${event?.gesture} pos=${event?.position} i=${event?.intensity}${event?.tap?' tap='+event.tap.durationMs:''}\n`);
      reminderLit=false; // touching the head puts out the reminder light
      if(calibrating)return; // the head is being held by hand: no smile, laugh or gesture
      const touchedAt=clock.now(),strength=Number.isFinite(event?.intensity)?event.intensity:0;
      if(event?.gesture==='press'){headPressAt=touchedAt;headPeak=strength;headArmed=headClean(touchedAt);if(!headArmed)voiceDiag('unclean');}
      else{
        headPeak=Math.max(headPeak,strength);
        // r: how long the touch lasted, p: the strongest reading on a zone meanwhile (below HEAD_GATE it does nothing).
        if(event?.gesture==='release'){voiceDiag('r'+(headPressAt===undefined?'?':Math.round(touchedAt-headPressAt))+'p'+headPeak);headPressAt=undefined;}
      }
      touchDiag('h'+String(event?.gesture??'?').charAt(0),true);
      if(event?.gesture!=='press'&&event?.gesture!=='release'&&headPressAt===undefined)headArmed=headClean(touchedAt); // the host always says press first
      const felt=headArmed&&headPeak>=HEAD_GATE,gesture=felt?longPress.touch(event,touchedAt):(longPress.touch(event,touchedAt),null);
      // With a zone stuck above 0 the host's finger position is skewed by it: a still finger can look like a swipe.
      // Then no petting, and the robot's own reading of the zones decides (main loop).
      const stuck=headWatch.stuck;
      if(gesture==='swipe'&&!stuck)headWatch.cancel();
      // The smile fires on release of a short tap, so a long press never also laughs.
      // A tap while Robottino talks interrupts it; otherwise it smiles and laughs.
      if(gesture==='tap')headTap();
      if(gesture==='swipe'&&!stuck){if(face.behavior.reactToTouch('head',event))playTouchSound();onPet();}
    }
  });
  // Movement is OFF on every launch. Enable only after hardware calibration.
  // Motors on, at start or from the menu: the head turns straight ahead at the one head speed, from where the
  // servos say it is (owner, 9 Nov 2026: «all'avvio deve posizionarsi con la testa dritta rivolta in avanti»).
  // The servo positions are read as during the calibration; without a reading the move is timed as from 90° to
  // the side, so it is never faster than usual. The reading and the move share the usual 1200 ms watchdog.
  const readPosition=async()=>{
    const rotation=headRotation();
    if(!rotation||typeof robot.motion?.lookAt!=='function'||typeof robot.motion?.lookAway!=='function')return undefined;
    rotation.y=NaN;rotation.p=NaN;
    try{robot.motion.lookAt([1,0,0]);}catch{}
    try{robot.motion.lookAway();}catch{}
    for(let waited=0;;waited+=50){
      if(Number.isFinite(rotation.y)&&Number.isFinite(rotation.p))return rawFromHost(rotation);
      if(waited>=500||closed)break;
      await pause(50);
    }
    if(!Number.isFinite(rotation.y))rotation.y=0;if(!Number.isFinite(rotation.p))rotation.p=0;
    return undefined;
  };
  const centreHead=()=>{
    if(closed||!headCal||calibrating||!tracker.enabled||motionFault||posePending||Preference.get('robottino','verified')!==true||Preference.get('robottino','calibrated')!==true)return;
    const token={};pendingPose=token;posePending=true;poseConfirmed=false;poseStarted=clock.now();
    void readPosition().then(raw=>{
      if(closed||pendingPose!==token||!tracker.enabled||motionFault)return;
      const from=raw?rotationFromRaw(raw,headCal):{y:HEAD_LIMITS.yaw,p:0},now=clock.now();
      calDiag('centre:'+(raw?`${raw.yaw},${raw.pitch}`:'noread'));
      headMove={from,to:from,start:now,duration:0};
      return setHeadPose({y:0,p:0,r:0}).then(()=>{if(!closed&&pendingPose===token){tracker.yaw=0;tracker.pitch=0;}});
    }).catch(error=>{if(!closed&&pendingPose===token)failMotion('Errore del movimento: nuovi movimenti bloccati.',error);})
      .finally(()=>{if(pendingPose===token){pendingPose=undefined;posePending=false;}});
  };
  // auto: the automatic start. Its torque command is tried once more, 2 s later, when the servos' reply was lost
  // (11 Nov 2026, 14:58: «[scservo] timeout id=1» at start, while servo 1 often answers late then): never more.
  const toggleMotion=auto=>{
    if(closed)return;
    autoArmAt=undefined; // a choice made by hand wins over the automatic start
    if(calibrating){say('Finisci prima la calibrazione.');return;}
    if(arming){motionRevision++;arming=false;say('Attivazione annullata.');return;}
    if(tracker.enabled){touchMotion=undefined;stopDance();tracker.enabled=false;say('Movimenti disattivati.');return;}
    if(motionFault){say('Comando non confermato. Verifica il robot e riavvia il modulo.');return;}
    if(posePending){say('Attendi la conferma del movimento precedente.');return;}
    armingStarted=clock.now();if(!Number.isFinite(armingStarted)){failMotion('Temporizzazione non valida: movimenti bloccati.');return;}
    arming=true;const revision=++motionRevision;
    void Promise.resolve().then(()=>{
      if(closed||revision!==motionRevision)return;
      return robot.motion.setTorque(true);
    }).then(()=>{
      if(!closed&&revision===motionRevision){tracker.enabled=true;say('Movimenti attivi.');centreHead();}
    }).catch(error=>{
      if(closed||revision!==motionRevision)return;
      tracker.enabled=false;
      if(auto===true&&autoArmTries<2&&/timed out/.test(String(error?.message??error))){calDiag('autoarm again');autoArmAt=clock.now()+2000;return;}
      say('Motori non disponibili.');
    })
      .finally(()=>{if(revision===motionRevision)arming=false;});
  };
  robot.ui.drawer.addDrawerButton({key:'robottino:motion',label:'Attiva/disattiva movimenti',callback:drawerAction(toggleMotion)});
  const toggleDance=()=>{
    if(closed)return;
    if(dance.active){stopDance();return;}
    // Before the head is measured the host's rest position can be one the pitch servo refuses (K151, 9 Nov 2026).
    if(Preference.get('robottino','verified')!==true||Preference.get('robottino','calibrated')!==true){say('Prima fai la calibrazione della testa: Menu → Calibrazione.');return;}
    if(!tracker.enabled){say('Prima verifica calibrazione e attiva i movimenti.');return;}
    if(posePending){say('Attendi la fine del movimento in corso.');return;}
    tracker.clearTarget();dance.start(clock.now(),{y:tracker.yaw,p:tracker.pitch});face.behavior.setDanceActive(dance.active);
  };
  robot.ui.drawer.addDrawerButton({key:'robottino:dance',label:'Danza breve / ferma danza',callback:drawerAction(toggleDance)});
  robot.ui.drawer.addDrawerButton({key:'robottino:stop',label:'Ferma Robottino',callback:drawerAction(close)});
  if(Modules.has('robottino-pairing-device'))robot.ui.drawer.addDrawerButton({key:'robottino:pair',label:'Abbina con l’app',callback:drawerAction(startPairing)});
  // Safety switches, set by hand after the physical checks. Turning on needs a second press
  // within 5 s; turning off is immediate and also turns the motors off.
  let confirming;
  const switchOff=(key,label)=>{Preference.set('robottino',key,false);confirming=undefined;touchMotion=undefined;stopDance();tracker.enabled=false;say(label+': disattivato. Movimenti spenti.');live?.hello?.();};
  const switchOn=(key,label)=>{confirming=undefined;Preference.set('robottino',key,true);say(label+': attivato.');live?.hello?.();};
  const safetySwitch=(key,label,message)=>()=>{
    if(closed)return;
    const now=clock.now(),on=Preference.get('robottino',key)===true;
    if(on){switchOff(key,label);return;}
    // «Calibrazione fatta» is turned on only at the end of the guided head calibration.
    if(key==='calibrated'&&typeof face.behavior?.showPanel==='function'){startCalibration();return;}
    // With the large-print panel the host menu asks the same explicit question (no 5 s race).
    if(typeof face.behavior?.showPanel==='function'){askSwitch(key,label,message,closeMenu);return;}
    if(confirming?.key!==key||!(now-confirming.at<5000)){confirming={key,at:now};say(message+' Premi di nuovo entro 5 secondi per confermare.');return;}
    switchOn(key,label);
  };
  robot.ui.drawer.addDrawerButton({key:'robottino:verified',label:'Hardware verificato (sì/no)',callback:safetySwitch('verified','Hardware verificato','Confermi di aver controllato modello, firmware e collegamenti?')});
  robot.ui.drawer.addDrawerButton({key:'robottino:calibrated',label:'Calibrazione fatta (sì/no)',callback:safetySwitch('calibrated','Calibrazione','Confermi che la testa è calibrata e si muove senza urti?')});
  // Large-print menu, opened by a long touch on the screen: the host drawer's font is too
  // small to read and a missed tap lands on the face. Turning a safety switch on asks an
  // explicit question with «Sì, confermo» / «Annulla»; turning it off is immediate.
  const switches=[{key:'verified',short:'Hardware',label:'Hardware verificato',message:'Confermi di aver controllato modello, firmware e collegamenti?'},{key:'calibrated',short:'Calibrazione',label:'Calibrazione fatta',message:'Confermi che la testa è calibrata e si muove senza urti?'}];
  const closeMenu=()=>face.behavior.hidePanel?.(face);
  const askSwitch=(key,label,message,back)=>face.behavior.showPanel(face,{title:message,items:[{label:'Sì, confermo',action:()=>{if(closed)return;switchOn(key,label);closeMenu();}},{label:'Annulla',action:back}]});
  // Guided head calibration (owner's request, 9 Nov 2026). With the motors off the owner moves the head by
  // hand and presses «Fatto» at each position; then the robot tries the measured range slowly and asks for
  // confirmation. Only then are the measurements saved and «Calibrazione fatta» turned on.
  const CAL_STEPS=[
    ['center','Calibrazione 1 di 6. Metti la testa dritta con la mano: guarda avanti, né in su né in giù. Tienila ferma e premi Fatto.'],
    ['up','2 di 6. Alza la testa piano fino in fondo, senza forzare. Tienila lì e premi Fatto.'],
    ['down','3 di 6. Abbassa la testa piano fino in fondo, senza forzare. Tienila lì e premi Fatto.'],
    ['left','4 di 6. Gira la testa piano tutta da una parte, senza forzare. Tienila lì e premi Fatto.'],
    ['right','5 di 6. Ora girala piano tutta dall’altra parte. Tienila lì e premi Fatto.'],
    ['again','6 di 6. Rimetti la testa dritta, come all’inizio. Tienila ferma e premi Fatto.']
  ];
  const calibrationErrors={reading:'Una misura non è valida.',center_moved:'Le due posizioni dritte sono diverse.',pitch_range:'La testa si è mossa poco in su e in giù.',yaw_range:'La testa si è girata poco ai lati.',yaw_center:'La posizione dritta non sta tra i due lati.',pitch_center:'La posizione dritta non sta tra su e giù.'};
  // The check after the measurements covers every position a command can reach (degrees, negative pitch = up):
  // straight, all the way up (85°), straight, all the way to each side (90°), straight; clamped to the measured range.
  const CAL_CHECK=[[0,0],[0,-30],[0,-60],[0,-85],[0,-40],[0,0],[45,0],[90,0],[45,0],[0,0],[-45,0],[-90,0],[-45,0],[0,0]];
  const headRotation=()=>robot.motion?.pose?.body?.rotation;
  // One reading of the servo positions without any motion: the host reads them while it has a gaze point,
  // and letting go of the gaze at once leaves no motion behind (host motion-controller.ts). The rotation is
  // marked NaN before each reading, so a reading that never arrives is not taken for a fresh one.
  const readHead=now=>{
    const rotation=headRotation();if(!rotation)return;
    if(calibrating.asked&&Number.isFinite(rotation.y)&&Number.isFinite(rotation.p))calibrating.last={...rawFromHost(rotation),at:now};
    rotation.y=NaN;rotation.p=NaN;calibrating.asked=true;
    try{robot.motion.lookAt([1,0,0]);}catch{}
    try{robot.motion.lookAway();}catch{}
  };
  const endCalibration=()=>{
    const was=calibrating;calibrating=undefined;
    const rotation=headRotation();if(rotation){if(!Number.isFinite(rotation.y))rotation.y=0;if(!Number.isFinite(rotation.p))rotation.p=0;}
    return was;
  };
  const cancelCalibration=()=>{
    if(!endCalibration())return;calDiag('cancel');closeMenu();stopDance();tracker.enabled=false;motionRevision++;arming=false;
    void Promise.resolve().then(()=>robot.motion.setTorque(false)).catch(()=>{});
    say('Calibrazione annullata: movimenti spenti.');
  };
  const showCalibrationStep=(note='')=>{
    if(!calibrating)return;const [key,text]=CAL_STEPS[calibrating.step];
    face.behavior.showPanel(face,{title:note+text,items:[{label:'Fatto',action:()=>takeReading(key)},{label:'Annulla',action:cancelCalibration}]});
  };
  const startCalibration=()=>{
    if(closed||calibrating)return;
    if(typeof face.behavior?.showPanel!=='function'||typeof robot.motion?.lookAt!=='function'||typeof robot.motion?.lookAway!=='function'||!headRotation()){say('Calibrazione non disponibile in questo firmware.');return;}
    if(Preference.get('robottino','verified')!==true){say('Prima conferma «Hardware: sì» dal menu.');return;}
    if(remoteActive){say('Chiudi prima il collegamento Live dall’iPhone, poi apri Calibrazione.');return;}
    if(voice?.active){say('Chiudi prima la conversazione.');return;}
    if(motionFault){say('Un movimento non è stato confermato: spegni e riaccendi il robot, poi apri Calibrazione.');return;}
    if(posePending||arming){say('Attendi la fine del movimento in corso.');return;}
    touchMotion=undefined;stopDance();tracker.enabled=false;const revision=++motionRevision;
    calibrating={phase:'off',step:0,readings:{}};calDiag('start');
    face.behavior.showPanel(face,{title:'Spengo i motori: tra un attimo potrai muovere la testa con la mano.',items:[{label:'Annulla',action:cancelCalibration}]});
    void Promise.resolve().then(()=>robot.motion.setTorque(false)).then(()=>{
      if(closed||!calibrating||revision!==motionRevision)return;
      calibrating.phase='measure';showCalibrationStep();
    },()=>{if(closed||!calibrating||revision!==motionRevision)return;endCalibration();closeMenu();say('Motori non disponibili: calibrazione annullata.');lightError();});
  };
  const takeReading=key=>{
    if(closed||calibrating?.phase!=='measure')return;
    const now=clock.now(),last=calibrating.last;
    if(!last||!(now-last.at<=600)){calDiag(key+':noread');showCalibrationStep('Non leggo la posizione dei motori: riprova. ');return;}
    calibrating.readings[key]={yaw:last.yaw,pitch:last.pitch};calDiag(`${key}:${last.yaw},${last.pitch}`);
    if(++calibrating.step<CAL_STEPS.length){showCalibrationStep();return;}
    const {calibration,error}=fromMeasurements(calibrating.readings);
    if(error){
      calDiag('err:'+error);calibrating.phase='retry';
      face.behavior.showPanel(face,{title:(calibrationErrors[error]??'Misure non valide.')+' Rifacciamo le misure?',items:[
        {label:'Rifai',action:()=>{if(!calibrating)return;calibrating.phase='measure';calibrating.step=0;calibrating.readings={};showCalibrationStep();}},
        {label:'Annulla',action:cancelCalibration}]});
      return;
    }
    calibrating.trial=calibration;calDiag('cal:'+JSON.stringify(calibration));checkCalibration();
  };
  // Each check position is a real command with the usual confirmation and 1200 ms watchdog. A servo that refuses a
  // position inside the measured range has a narrower limit in its own memory (the K151 pitch servo did, 9 Nov
  // 2026): that end of the range moves back towards the centre and the position is tried again. A refusal at the
  // centre, or more than 16, block the motors like any failed command.
  const runCalibrationCheck=async revision=>{
    let refusals=0;
    for(let i=0;i<CAL_CHECK.length;){
      if(closed||!calibrating||revision!==motionRevision||motionFault)return;
      const [yaw,pitch]=CAL_CHECK[i],rotation={y:yaw*Math.PI/180,p:pitch*Math.PI/180,r:0};
      const token={};pendingPose=token;posePending=true;poseConfirmed=false;poseStarted=clock.now();let refused,duration=0;
      try{const sent=setHeadPose(rotation);duration=headMove.duration;await sent;}catch(error){refused=error??Error('refused');}
      finally{if(pendingPose===token){pendingPose=undefined;posePending=false;}}
      if(closed||!calibrating||revision!==motionRevision||motionFault)return;
      if(!refused){tracker.yaw=rotation.y;tracker.pitch=rotation.p;i++;await pause(Math.round(duration*1000)+400);continue;}
      const raw=servoPositions(safeRotation(rotation),calibrating.trial),narrower=++refusals<=16?narrowRange(calibrating.trial,raw):undefined;
      calDiag(`refused:${raw.yaw},${raw.pitch}`);
      if(!narrower){failMotion('Il motore rifiuta le posizioni vicino al centro: movimenti bloccati.',refused);finishCalibrationCheck();return;}
      calibrating.trial=narrower;calibrating.narrowed=true;await pause(300);
    }
    finishCalibrationCheck();
  };
  const checkCalibration=()=>{
    if(!calibrating)return;calibrating.phase='arming';
    face.behavior.showPanel(face,{title:'Togli le mani dalla testa: tra 2 secondi la provo piano, in su e tutta da una parte e dall’altra.',items:[{label:'Annulla',action:cancelCalibration}]});
    arming=true;armingStarted=clock.now();const revision=++motionRevision;
    void Promise.resolve().then(()=>{if(closed||!calibrating||revision!==motionRevision)return;return robot.motion.setTorque(true);})
      .then(()=>{
        if(closed||!calibrating||revision!==motionRevision)return;
        tracker.yaw=0;tracker.pitch=0;headMove={from:{y:0,p:0},to:{y:0,p:0},start:clock.now(),duration:0};calibrating.phase='check'; // the last measurement left the head straight
        void pause(2000).then(()=>runCalibrationCheck(revision)).catch(error=>{if(!closed&&calibrating&&!motionFault){failMotion('Errore nella prova della testa: movimenti bloccati.',error);finishCalibrationCheck();}});
      })
      .catch(()=>{if(!closed&&calibrating&&revision===motionRevision){endCalibration();closeMenu();say('Motori non disponibili: calibrazione non salvata.');lightError();}})
      .finally(()=>{if(revision===motionRevision)arming=false;});
  };
  const finishCalibrationCheck=()=>{
    if(!calibrating)return;
    if(motionFault){calDiag('check:fault');endCalibration();face.behavior.showPanel(face,{title:'Un movimento non è stato confermato: calibrazione non salvata. Spegni e riaccendi il robot, poi riprova.',items:[{label:'Chiudi',action:closeMenu}]});return;}
    calibrating.phase='confirm';calDiag('check:ok');
    const note=calibrating.narrowed?'Dove il motore non arrivava ho ridotto un poco i limiti. ':'';
    face.behavior.showPanel(face,{title:note+'La testa si è mossa senza urti e ora guarda dritta?',items:[{label:'Sì, salva',action:saveCalibration},{label:'No, rifai le misure',action:()=>{if(!calibrating)return;calDiag('redo');endCalibration();startCalibration();}},{label:'Annulla',action:cancelCalibration}]});
  };
  const saveCalibration=()=>{
    if(closed||calibrating?.phase!=='confirm')return;const calibration=calibrating.trial;
    try{Preference.set('robottino','headCal',storeCalibration(calibration));Preference.set('robottino','calibrated',true);}
    catch{endCalibration();closeMenu();say('Calibrazione non salvata: riprova.');lightError();return;}
    headCal=calibration;endCalibration();calDiag('saved');closeMenu();tracker.enabled=true;say('Calibrazione salvata. Movimenti attivi.');live?.hello?.();
  };
  // Every Robottino function on one screen (owner's request, 9 Nov 2026): the same functions as
  // the host drawer, which stays reachable through «Menu host» for the host's own settings.
  // TEMPORARY diagnostics (10 Nov 2026): while the big menu is open its title shows the head sensor's three zones,
  // so the owner can see without a cable whether a touch on the head is felt at all.
  let mainMenu=null;
  // Home Wi-Fi or iPhone hotspot (owner, 10 Nov 2026): the robot keeps two networks and at each start uses the main
  // one if it sees it, else the other. This button makes the other one the main network; it is used from the next
  // start (the host connects only when it starts). Passwords never leave the robot.
  const networkName=()=>{const first=loadNetworks(Preference)[0]?.ssid;return typeof first==='string'?first.slice(0,10):'—';};
  const switchNetwork=()=>{
    const list=loadNetworks(Preference);
    if(list.length<2){say('Conosco una sola rete Wi-Fi: invia l’altra dall’app (scheda Robot).');return;}
    const next=[list[1],list[0]];
    try{saveNetworks(Preference,next);Preference.set('wifi','ssid',next[0].ssid);Preference.set('wifi','password',next[0].password);}
    catch{say('Non riesco a salvare la rete scelta.');return;}
    say(`Rete scelta: ${next[0].ssid}. Spegni e riaccendi il robot per usarla.`);
  };
  const openMenu=()=>{
    if(closed||typeof face.behavior?.showPanel!=='function')return;
    if(calibrating){cancelCalibration();return;}
    const run=fn=>()=>{if(closed)return;closeMenu();fn();};
    const items=[
      {label:voice?.active?'Chiudi voce':'Parla',action:run(toggleVoice)},
      {label:`Movimenti: ${tracker.enabled?'sì':'no'}`,action:run(toggleMotion)},
      ...switches.map(({key,short,label,message})=>({label:`${short}: ${Preference.get('robottino',key)===true?'sì':'no'}`,action:()=>{
        if(closed)return;
        if(Preference.get('robottino',key)===true){switchOff(key,label);openMenu();return;}
        if(key==='calibrated'){closeMenu();startCalibration();return;}
        askSwitch(key,label,message,openMenu);
      }}))
    ];
    if(loadNetworks(Preference).length>=2)items.push({label:`Rete: ${networkName()}`,action:run(switchNetwork)});
    if(Modules.has('robottino-live-device'))items.push({label:'Live iPhone',action:run(connectLive)});
    if(Modules.has('robottino-pairing-device'))items.push({label:'Abbina app',action:run(startPairing)});
    if(typeof robot.ui.openDrawer==='function')items.push({label:'Menu host',action:()=>{closeMenu();hostDrawer();}});
    items.push({label:'Chiudi',action:closeMenu});
    face.behavior.showPanel(face,{title:'Menu di Robottino',items,columns:2});mainMenu=face.behavior.panel??null;
  };
  // A long touch on the screen starts or ends a conversation, like the head sensor (owner's
  // choice, 9 Nov 2026: the head sensor is hard to use with the USB cable connected).
  face.behavior.onLongTouch=()=>{if(calibrating)return;voiceDiag('screen');reminderLit=false;toggleVoice();};
  if(typeof face.behavior?.showPanel==='function')robot.ui.drawer.addDrawerButton({key:'robottino:menu',label:'Menu grande',callback:drawerAction(openMenu)});
  if(Modules.has('robottino-voice-device'))robot.ui.drawer.addDrawerButton({key:'robottino:voicetest',label:'Prova voce (senza rete)',callback:drawerAction(testVoice)});
  // The host's ☰ bubbles `onDrawerToggle` up to the application behaviour: while Robottino runs
  // it opens (or closes) the large menu instead. Restored on close; «Menu host» opens the drawer and
  // the next ☰ closes it.
  const controller=robot.ui.application?.behavior;let restoreToggle,hostDrawer=()=>{hostDrawerOpen=true;robot.ui.openDrawer?.();};
  if(controller&&typeof controller.onDrawerToggle==='function'&&typeof face.behavior?.showPanel==='function'){
    const own=Object.hasOwn(controller,'onDrawerToggle'),previous=controller.onDrawerToggle;
    controller.onDrawerToggle=function(...args){
      if(closed)return previous.apply(this,args);
      if(calibrating){cancelCalibration();return;}
      // With the host's side menu open, ☰ closes it, as it did before Robottino took the button.
      const wasOpen=hostDrawerOpen;closeHostDrawer();if(wasOpen)return;
      if(face.behavior.panelOpen)closeMenu();else openMenu();
    };
    restoreToggle=()=>{if(own)controller.onDrawerToggle=previous;else delete controller.onDrawerToggle;};
  }
  autoArmAt=clock.now()+2000;
  if(staleCal)say('Ora la testa arriva a 90°: rifai la calibrazione dal menu (☰ → Calibrazione).');
  let talking=false; // the iPhone learns at once when a conversation starts or ends (face following, 9 Nov 2026)
  // TEMPORARY diagnostics (9 Nov 2026, motions blocked in a conversation): the loop runs every 100 ms; a longer gap
  // means the robot was busy elsewhere. Logged on USB only (no flash write), with what was going on.
  let lastLoopAt;
  timer=Timer.repeat(()=>{
    if(closed)return;
    const now=clock.now();
    if(lastLoopAt!==undefined&&now-lastLoopAt>400&&typeof trace==='function')trace(`[robottino] stall ${Math.round(now-lastLoopAt)} voice=${voice?.phase??'-'} live=${remoteActive?1:0} follow=${cameraFollow?1:0} cam=${live?.busy?.()?1:0} net=${socketModule?.connecting?.()?1:0} pose=${posePending?1:0}\n`);
    if(lastLoopAt!==undefined&&now-lastLoopAt>loopGap)loopGap=now-lastLoopAt;
    lastLoopAt=now;
    if(!Number.isFinite(now)){if(!motionFault)failMotion('Temporizzazione non valida: movimenti bloccati.');return;}
    if(diagAt!==undefined&&now>=diagAt){diagAt=undefined;writeDiag();}
    lights.update({voice:voice?.phase,pairing:!!pairing?.active,reminder:reminderLit,live:remoteActive},now);
    if(!!voice?.active!==talking){
      talking=!talking;try{live?.hello?.();}catch{}
      // A conversation: the head looks at the owner (straight, 25° up: sitting close, the face is above the robot);
      // at its end it goes back straight (owner, 9 Nov 2026).
      if(talking)lookUpWanted=true;else{lookUpWanted=false;homeAfterLive=true;}
    }
    if(!(now-timeCheckedAt<60000)){timeCheckedAt=now;applyItalianTime();}
    if(calibrating?.phase==='measure')readHead(now);
    else if(calibrating?.phase==='check'&&motionFault)finishCalibrationCheck(); // a pose watchdog fired during the check
    // Motions on by default (owner's request, 9 Nov 2026): at start, once hardware and head calibration are confirmed.
    // Not while the first connections open (TLS handshake): the straightening move would wait for its replies.
    if(autoArmAt!==undefined&&now>=autoArmAt&&headQuiet()){
      autoArmAt=undefined;
      if(headCal&&!calibrating&&!tracker.enabled&&!motionFault&&Preference.get('robottino','verified')===true&&Preference.get('robottino','calibrated')===true){autoArmTries++;calDiag('autoarm');toggleMotion(true);}
    }
    if(now-lastScreenCheck>=(voice?.active||touchSoundPlaying?500:2000)){lastScreenCheck=now;restoreScreenColours();}
    if(headArmed&&headPeak>=HEAD_GATE&&longPress.tick(now)){voiceDiag('long');toggleVoice();}
    if(touchPanel&&!closed){
      const read=headWatch.update(touchPanel.sample,now);
      if(read.changed){
        const zones=read.levels.join(',');touchDiag(`${(now/1000).toFixed(1)}:${zones}`,touchLogSavedAt===undefined);
        if(typeof trace==='function')trace(`[robottino] head zones ${zones}\n`);
      }
      if(read.changed&&mainMenu&&face.behavior.panel===mainMenu)face.behavior.setPanelTitle?.(face,`Menu · sensore testa ${read.levels.join(' ')}`);
      if(read.stuck){touchDiag(read.stuck==='start'?'S':'E',true);if(typeof trace==='function')trace(`[robottino] head reading ${read.stuck==='start'?'stuck':'free again'}\n`);}
      if(headPressAt!==undefined)headPeak=Math.max(headPeak,...read.levels);
      headGuard(now,read.levels);
      if(read.gesture&&!calibrating){
        touchDiag(read.gesture==='long'?'L':'T',true);reminderLit=false;
        if(read.gesture==='long'){voiceDiag('long*');toggleVoice();}else headTap();
      }
      saveTouchDiag(now);
    }
    for(const fired of reminders.due(now)){alert(fired.text);reminderLit=true;}
    if(alertUntil!==undefined&&now>=alertUntil){alertUntil=undefined;if(!voice?.active)setMood('neutral');}
    // At least FACE_HOLD_MS, and until Robottino has finished the sentence it says with that face.
    if(faceHoldUntil!==undefined&&now>=faceHoldUntil&&!voice?.speaking){faceHoldUntil=undefined;setMood('neutral');}
    if(arming&&now-armingStarted>=1200)failMotion('Attivazione non confermata: movimenti bloccati.');
    if(posePending){
      // TEMPORARY diagnostics: how long it waited, when the command left for the host (h, - if it never did), the
      // longest loop gap meanwhile and what was going on.
      // Not confirmed by the servos within 1.2 s: blocked, as before. Confirmed, but the robot's own bookkeeping has
      // not finished after POSE_DONE_MS: something is stuck, and a pose never left pending without a word.
      const waited=now-poseStarted,note=`w${Math.round(waited)} h${poseSentAt===undefined?'-':Math.round(poseSentAt-poseStarted)} g${Math.round(loopGap)} v=${voice?.phase??'-'} f=${cameraFollow?1:0} q=${headQuiet()?1:0}`;
      if(!poseConfirmed&&waited>=1200)failMotion('Movimento non confermato: nuovi movimenti bloccati.',note);
      else if(poseConfirmed&&waited>=POSE_DONE_MS)failMotion('Movimento non concluso: nuovi movimenti bloccati.',note);
      return;
    }
    // Camera switching, a connection opening, the conversation starting or changing between microphone and speaker
    // (headQuiet): no head command now, it waits for the next turn.
    if(!headQuiet())return;
    if(lookUpWanted){
      // With the iPhone connected too (11 Nov 2026: with the app open, which follows the face during a conversation, the
      // head stayed down and the camera could not find the face above it; owner: «a volte non alza più la testa»).
      if(!tracker.enabled||motionFault){lookUpWanted=false;}
      else if(!dance.active&&!remoteDance&&!touchMotion&&!calibrating){
        lookUpWanted=false;
        const token={};pendingPose=token;posePending=true;poseConfirmed=false;poseStarted=now;const look={y:0,p:-LOOK_UP,r:0};
        void soon(()=>{if(closed||pendingPose!==token)return;return setHeadPose(look);})
          .then(()=>{if(!closed&&pendingPose===token){tracker.yaw=look.y;tracker.pitch=look.p;}})
          .catch(error=>{if(!closed&&pendingPose===token)failMotion('Errore del movimento: nuovi movimenti bloccati.',error);})
          .finally(()=>{if(pendingPose===token){pendingPose=undefined;posePending=false;}});
        return;
      }
    }
    if(homeAfterLive&&!remoteActive){
      homeAfterLive=false;
      const away=Math.abs(headMove.to.y)>.002||Math.abs(headMove.to.p)>.002;
      if(away&&tracker.enabled&&!motionFault&&!dance.active&&!remoteDance&&!touchMotion&&!calibrating){
        const token={};pendingPose=token;posePending=true;poseConfirmed=false;poseStarted=now;
        void soon(()=>{if(closed||pendingPose!==token)return;return setHeadPose({y:0,p:0,r:0});})
          .then(()=>{if(!closed&&pendingPose===token){tracker.yaw=0;tracker.pitch=0;}})
          .catch(error=>{if(!closed&&pendingPose===token)failMotion('Errore del movimento: nuovi movimenti bloccati.',error);})
          .finally(()=>{if(pendingPose===token){pendingPose=undefined;posePending=false;}});
        return;
      }
    }
    if(touchMotion){
      if(!canTouchMove()){touchMotion=undefined;return;}
      if(now>=touchMotion.restoreAt){const origin=touchMotion.origin;touchPose(origin,()=>{touchMotion=undefined;});}
      return;
    }
    if(voiceRetry&&!posePending){const retry=voiceRetry;voiceRetry=undefined;if(!voiceLook(retry.direction,retry.full,retry.until))say('Ora non posso muovere la testa.');}
    if(remoteDance){
      if(now<remoteDance.nextAt)return;
      const step=remoteDance.steps[++remoteDance.index];
      if(!step){stopDance();return;}
      remoteDance.nextAt=now+step.durationMs;if(step.expression)showExpression(step.expression);
      const rotation={y:step.yaw*Math.PI/180,p:step.pitch*Math.PI/180,r:0};
      const token={};pendingPose=token;posePending=true;poseConfirmed=false;poseStarted=now;
      void soon(()=>{if(closed||pendingPose!==token||!remoteDance)return;return setHeadPose(rotation);})
        .then(()=>{if(!closed&&pendingPose===token){tracker.yaw=rotation.y;tracker.pitch=rotation.p;}})
        .catch(error=>{if(!closed&&pendingPose===token)failMotion('Errore nella danza remota: movimenti bloccati.',error);})
        .finally(()=>{if(pendingPose===token){pendingPose=undefined;posePending=false;}});
      return;
    }
    // While the iPhone is connected the head moves only on its commands, or to follow a face with the robot camera.
    if(remoteActive&&!cameraFollow)return;
    if(cameraFollow&&now<followPausedUntil)return; // a spoken head command is being held (voiceLook)
    const value=dance.active?{active:true,gazeX:0,gazeY:0,rotation:dance.sample(now)}:tracker.tick(now);
    // No glances on its own at rest (owner, 9 Nov 2026: «anche con conversazione spenta si muove»): the head moves
    // only when commanded, following a face, for conversation gestures and reminders, or when touched.
    face.behavior.setDanceActive(dance.active);face.behavior.setTarget(value.gazeX,value.gazeY);
    if(value.rotation){tracker.yaw=value.rotation.y;tracker.pitch=value.rotation.p;}
    // Only a pose that changes goes to the servos: the same pose 10 times a second while following a still face
    // (9 Nov 2026) only loaded the servo line, where a reply now and then goes missing.
    const unchanged=value.rotation&&(()=>{const goal=reachable(value.rotation,calibrating?.trial??headCal);return Math.abs(goal.y-headMove.to.y)<.002&&Math.abs(goal.p-headMove.to.p)<.002;})();
    if(value.active&&value.rotation&&!posePending&&!unchanged){
      posePending=true;poseConfirmed=false;
      const token={};pendingPose=token;poseStarted=now;
      // Following a face: once the servos have confirmed, the next frame and the next pose need not wait for the
      // end of the promise chain (several turns of the host's message queue, up to 0.3 s more with the robot busy:
      // `pose slow c235 e502`, 10 Nov 2026). A failure still arrives through the chain below, for this same token.
      void soon(()=>{
        if(closed||pendingPose!==token)return;
        return setHeadPose(value.rotation,undefined,()=>{if(pendingPose===token)posePending=false;});
      }).catch(error=>{if(!closed&&pendingPose===token)failMotion('Errore del movimento: nuovi movimenti bloccati.',error);})
        .finally(()=>{if(pendingPose===token){pendingPose=undefined;posePending=false;}});
    }
  },100);
  void (async()=>{
    const peer=robot.connectivity.localPeer;if(!peer){say('Inseguimento: trasporto BLE non disponibile.');return;}
    const opened=await peer.open({transport:'ble',service:MEDIAPIPE_BLE_SERVICE,displayName:'Robottino'});
    if(closed){opened.close();return;}session=opened;
    const subscriptions=[];unsubscribe=()=>{for(const off of subscriptions)off();subscriptions.length=0;};
    subscriptions.push(session.subscribe('target.update',message=>{if(!closed&&!dance.active)tracker.accept(message?.payload,clock.now());}));
    let sequence=0;
    subscriptions.push(session.subscribe(MEDIAPIPE_BLE_MESSAGE_TYPE,message=>{
      if(closed)return;
      const parsed=parseTrackingPayload(message?.payload);if(!parsed?.face)return;
      if(!dance.active)tracker.accept({id:'mediapipe-face',x:Math.max(0,Math.min(1,.5-parsed.face.yaw/1.1)),y:Math.max(0,Math.min(1,.5-parsed.face.pitch/.6)),confidence:1,sequence:++sequence},clock.now());
      if(parsed.faceParts){robot.face.setEyeOpen('left',parsed.faceParts.eyeOpen.left);robot.face.setEyeOpen('right',parsed.faceParts.eyeOpen.right);robot.face.setMouthOpen(parsed.faceParts.mouthOpen);}
      if(parsed.emotion)robot.face.setEmotion(parsed.emotion==='happy'?3:0);
    }));
  })().catch(()=>{unsubscribe?.();session?.close();session=undefined;if(!closed)say('Inseguimento non disponibile.');});
}
export function onUnload(){running?.close();running=undefined;}
