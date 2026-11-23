import {FACE_STYLES,MOUTH_POSES,SCARED} from 'robottino-portrait-state';
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
import {Reminders,ClockReminders} from 'robottino-reminders';
// import {createLegoHub} from 'robottino-lego-wire'; // LEGO switched off (14 Nov 2026), see legoOpen below
import {launchWithNetworks,loadNetworks,saveNetworks} from 'robottino-wifi-switch';
import {HeadLights} from 'robottino-lights';
import {createK210} from 'robottino-k210';
import {createRover,GRIP_MOVES} from 'robottino-rover-wire';
import {RoverBody} from 'robottino-rover-body';
import {RoverFollow,obstacleAhead} from 'robottino-rover-follow';
import {createTof} from 'robottino-tof-wire';
import {ForcePush,forceSteps,forceMm,WaveWatch,FORCE,FORCE_SOUND,WAVE,forceSoundNow} from 'robottino-force';
import {ForceFollow,FORCE_FOLLOW} from 'robottino-force-follow';
import {Explore} from 'robottino-explore';
import {GazeCall} from 'robottino-gaze';
import {NfcCards} from 'robottino-nfc';
import {createClimate} from 'robottino-climate-wire';
import {Presence,createPir} from 'robottino-presence';
import {VOLUME,volumeAmp,validVolume,HAND_SOUNDS} from 'robottino-live-wire';
import {MotionSense,HELD_PHRASES,SHAKEN_PHRASES,FALLEN_PHRASES,pickPhrase,HELD_SPEAK_MS,HELD_SPEAK_TILT,HELD_AFTER_FALL_MS,PHRASE_WAIT_MS} from 'robottino-motion-sense';
import {PHRASE_MOUTHS,PHRASE_MOUTH_MS} from 'robottino-phrase-mouths';
import {SoundEar,readSound,LOOK_NEED,LOOK_WINDOW_MS} from 'robottino-sound-ear';
import {createSdLog} from 'robottino-sd-log';
import {WAKE_YAWN,WAKE_HELLO,WAKE_FADE_MS,WAKE_YAWN_AT,WAKE_HELLO_GAP_MS,WAKE_LIMIT_MS,YAWN_MOUTH,WAKE_EYES_MS,wakeEyes,wakeBrightness} from 'robottino-wake-up';
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
// The fixed numbers of startRobottino, in one object (21 Nov 2026). Each name declared in that function, and each name
// of this module it uses, takes one slot of the robot's JavaScript stack when the function is called, and the stack
// (768 slots, the host's creation.stack) must also hold the making of the face: at 446 names the robot started, at 447
// it stopped at every start («stack overflow (-1)!»). scripts/mod-frame.mjs counts them; a test keeps the count low.
// So: a new fixed number goes here (K.NAME), and new behaviour in a module of its own with one name in the function.
// What each number means is said where it is used.
const K={
  REMINDER_LIGHT_MS:10000,
  SETTLE_MS:150,
  HEAD_TOUCH_AFTER_MS:2000,
  LONG_MOVE:.25,
  ARRIVE_SPEED:3,
  CAMERA_SETTLE_MS:330,
  // The same for the K210 (23 Nov 2026): its picture reaches the robot about 0.1 s after it is taken, the robot
  // camera's later; following used a third of its faces.
  K210_SETTLE_MS:200,
  // The Live connection waits this long at most for the motors to start (connectLive, 23 Nov 2026).
  LIVE_AFTER_ARM_MS:8000,
  CAMERA_UNCONFIRMED_MS:550,
  CAMERA_AFTER_MS:230,
  CAMERA_WIDE:.3,
  CAMERA_WIDE_MS:300,
  FOLLOW_MOVE_S:.22,
  FOLLOW_MOVE_SPEED:2.5,
  FOLLOW_GENTLE:false,
  ALONE_SLEEP_MS:30000,
  REMOTE_HEAD_MS:30000,
  REMOTE_ROVER_MS:8000,
  POWER_HOLD_MS:6000,
  POSED_AFTER_MS:3000,
  PHRASE_START_MS:120,
  EAR_SLEEP_AFTER_MS:2000,
  EAR_PAUSE_MS:5000,
  EAR_AFTER_VOICE_MS:2000,
  // No wave for this long after the motion sensor felt a hand moving the robot (force.js WAVE, 23 Nov 2026).
  HANDLED_MS:3000,
  // Nobody in the room: no movement felt by the presence sensor for this long (presenceTurn, 23 Nov 2026).
  NOBODY_MS:180000,
  LOOK_SEEN_MS:1500,
  LOOK_GONE_MS:3000,
  ROVER_SPEED:30,
  ROVER_CAMERA_MS:250,
  OBSTACLE_SENSOR_SAID:'Rover: il sensore di ostacoli non risponde, non vado avanti.',
  CLIMATE_RETRY_MS:120000,
  TOF_ALONE_RETRY_MS:120000,
  TOF_RETRY_MS:5000,
  // The rover after a failed write (rover-wire.js state 'error'): opened again by itself this often, in a quiet moment
  // (review, 23 Nov 2026: until then it stayed off until a restart or the menu).
  ROVER_RETRY_MS:5000,
  // Forward only with the head (where the distance sensor is) turned at most this much from the front (review, 23 Nov
  // 2026): looking to one side, the sensor does not see what the wheels go into. As rover-follow.js turnYaw.
  FORWARD_YAW:20*Math.PI/180,
  HAND_SAME_MS:2500,
  HAND_STOP_MS:10000,
  FACE_HOLD_MS:5000,
  GESTURE_DELAY_MS:300,
  POSE_DONE_MS:5000,
  VOICE_TURN:20,
  VOICE_STEP_MS:700,
  FOLLOW_PAUSE_MS:5000,
  VOICE_WAIT_MS:1500,
  TOOL_SAME_MS:6000,
  HEAD_LEVEL:3,
  HEAD_GATE:1,
  HEAD_REF_MS:4000,
  HEAD_CLEAN_MS:300,
  HEAD_RESET_MS:310,
  PARK_WAIT_MS:3000,
};
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
  // The log on the microSD card (sd-log.js; owner, 14 Nov 2026: «usala per i registri senza cavo»). Every line the
  // robot writes with `trace`, the host's own too, also goes to the card; at each start the end of the run before is
  // shown on the USB log. `trace` is a global of the host: it is replaced by one that does both, and put back when
  // Robottino closes. The card is the host's (stackchan-sdcard, withSDCard); with no such module nothing changes.
  const usbTrace=typeof trace==='function'?trace:undefined;let sdLog;
  try{
    const card=Modules.has('stackchan-sdcard')?Modules.importNow('stackchan-sdcard'):undefined,withCard=card?.withSDCard;
    if(usbTrace&&typeof withCard==='function'&&typeof ArrayBuffer.fromString==='function'){
      const log=createSdLog({withCard,now:()=>clock.now(),date:()=>new Date(),encode:text=>ArrayBuffer.fromString(text),decode:buffer=>String.fromArrayBuffer(buffer),usb:text=>usbTrace(text+'\n')});
      if(log.start()){
        globalThis.trace=text=>{usbTrace(text);try{log.line(text);}catch{}};
        sdLog=log;trace('[robottino] sd log on\n');
      }
    }else usbTrace?.(`[robottino] sd log off: ${card?'this host does not give the card\'s files to a mod (needs host 14f)':'no card module in the host'}\n`);
  }catch(error){try{usbTrace?.(`[robottino] sd log off: ${String(error?.message??error).slice(0,60)}\n`);}catch{}}
  // Italian time (owner's request, 9 Nov 2026): the host starts on its own preset (Tokyo, +9) and never applies
  // summer time. Rome: UTC+1, +1 hour of summer time (clock.js); checked again every minute. Only once the
  // host has the time from the network, so the host's own setting is saved as Paris (+1) for the next start.
  // Volume at 100% (owner, 14 Nov 2026, 19:27: «alza il volume al 100%, si sente basso»). The call already plays at
  // the driver's full level (voice-device.js); the host's own volume (sounds and recorded phrases, 0…1, its default 0.5,
  // saved by the host) goes to 1, and the K151's amplifier (AW88298, set by the host to 250 of 256 in setup-target.js)
  // to 252 (owner, 19:33, at 256: «è un po' distorta, proviamo con 252»; at 252: «va ancora bene»; 253 tried at
  // 19:36, then «riporta 252»). Distorted again (15 Nov 2026: «abbassa un po il volume distorce ancora»): the
  // amplifier now follows the level chosen in the iPhone's Robot tab, 1…10 (live-wire.js VOLUME), saved on the robot;
  // with nothing saved yet, 9 (246), a little lower. Never above 252.
  try{if(robot.audio&&robot.audio.volume!==1)robot.audio.volume=1;}catch(error){if(typeof trace==='function')trace(`[robottino] volume: ${error}\n`);}
  const savedVolume=(()=>{try{const level=Preference.get('robottino','volume');return validVolume(level)?level:VOLUME.default;}catch{return VOLUME.default;}})();
  // true only if the amplifier took the level (and, when asked, the level is saved for the next start).
  const setVolume=(level,save)=>{
    if(!validVolume(level)||!globalThis.amp)return false;
    try{const value=volumeAmp(level);if(globalThis.amp.volume!==value)globalThis.amp.volume=value;if(typeof trace==='function')trace(`[robottino] amplifier ${globalThis.amp.volume} (level ${level})\n`);}
    catch(error){if(typeof trace==='function')trace(`[robottino] amplifier: ${error}\n`);return false;}
    if(save)try{Preference.set('robottino','volume',level);}catch{return false;}
    return true;
  };
  setVolume(savedVolume,false);
  const applyItalianTime=()=>{
    const utc=Date.now();if(!(utc>Date.UTC(2025,0,1)))return;
    const dst=italianSummerTime(utc)?3600:0;
    if(Time.timezone!==ITALY_OFFSET)Time.timezone=ITALY_OFFSET;if(Time.dst!==dst)Time.dst=dst;
    try{if(Preference.get('time','timezone')!=='paris')Preference.set('time','timezone','paris');}catch{}
  };
  let timeCheckedAt,clockCheckedAt,callDotOn=false;
  // Head lights (lights.js): set from the robot's state every 100 ms; a reminder stays lit until the head is touched.
  const lights=new HeadLights(robot.lighting);let reminderLit=false,reminderLitAt,reminderInCall=false;
  // The reminder light (pink blink) went out only with a touch of the head, which is switched off while the camera
  // follows (owner, 14 Nov 2026, 19:57: «ora sta lampeggiando di viola», after the 19:56 reminder): it also goes out when
  // a conversation starts and after REMINDER_LIGHT_MS (owner, 20:00: «le luci viole falle spegnere dopo 10 secondi
  // che mi ha detto che è scattato il promemoria»).
  
  const lightReminder=()=>{reminderLit=true;reminderLitAt=clock.now();reminderInCall=!!voice?.active;};
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
  
  // For the head sensor the move lasts longer (11 Nov 2026: «tutto su», 60°, reckoned 0.35 s at the one head speed;
  // the real head was still arriving 1.3 s later, the sensor read 1 on one zone and the conversation was closed as by
  // a long touch): after a long move (LONG_MOVE s reckoned, about 43° and more) no touch counts until
  // HEAD_TOUCH_AFTER_MS after its reckoned end; after the short ones (nods, one 20° step) as before.
  
  const arriving=()=>headMove.arrive??headMove.duration;
  const headShaking=()=>{const now=clock.now();return Number.isFinite(now)&&now<headMove.start+arriving()*1000+(arriving()>=K.LONG_MOVE?K.HEAD_TOUCH_AFTER_MS:K.SETTLE_MS);};
  const headMoving=()=>{const now=clock.now();return Number.isFinite(now)&&now<headMove.start+arriving()*1000+K.SETTLE_MS;};
  // For the camera of following alone (live-device.js): the head has arrived and the picture is still. Measured on the
  // robot with the camera itself (14 Nov 2026: 98 moves of 5°-32° with nobody in front, each frame compared with the
  // one before): the servos confirm a command 24-153 ms after it (median 41), and the picture goes on changing long
  // after that: the last frame with the bulk of the motion came 231 ms after the confirmation (median; 335 ms for 95
  // moves in 100). The wait reckoned until then (headMoving: 250-340 ms from the command) ended at about that median:
  // half of the frames taken «with the head still» showed it moving, and each of them sent the head past the face.
  // Counted from the confirmation, which is when the servos have the command; without one (an older host), from the
  // command.
  // A move asked to last longer (the gentle ones of following, FOLLOW_GENTLE) ends later by as much. Measured the same
  // way (14 Nov 2026, 11:24: 239 moves of 5°-78° made by the robot alone, the same move asked in 0.1, 0.16, 0.22 and
  // 0.3 s): the picture is still, 95 times in 100, 275-360 ms after the last confirmation for the moves asked in 0.1 s,
  // 300-390 for 0.16 s, 405-435 for 0.22 s, 480-495 for 0.3 s. So CAMERA_AFTER_MS after the time asked, which for the
  // tenth of a second of the one head speed is the third of a second above. With CAMERA_AFTER_MS at 110, as first
  // written, a move asked in 0.22 s was looked at after 330 ms, still moving one time in four: «non funziona».
  
  // A wide move sent in one command takes longer (the 32° ones of the first measurement were still at up to 485 ms
  // after the confirmation): CAMERA_WIDE_MS more for every radian beyond CAMERA_WIDE. The stops of the look around,
  // 39° and more apart, go in two or three commands (tracker.js, 0.6 rad a tick), and the wait counts from the last:
  // measured at 39° and 78° (same measurement, 12 moves at the one head speed), still 305 ms after it, 95 in 100.
  
  // settle: the K210's pictures come sooner after they are taken than the robot camera's (K.K210_SETTLE_MS).
  const headSettled=(settle=K.CAMERA_SETTLE_MS)=>{
    const now=clock.now(),move=headMove,size=Math.hypot(move.to.y-move.from.y,move.to.p-move.from.p);
    const wait=Math.max(settle+Math.max(0,size-K.CAMERA_WIDE)*K.CAMERA_WIDE_MS,move.duration*1000+K.CAMERA_AFTER_MS);
    return Number.isFinite(now)&&(move.confirmed!==undefined?now>=move.confirmed+wait:now>=move.start+wait+K.CAMERA_UNCONFIRMED_MS-K.CAMERA_SETTLE_MS);
  };
  // The moves the robot makes by itself to follow a face or to look for one (owner, 14 Nov 2026: «è possibile rendere i
  // movimenti un pochino più fluidi?»). At the one head speed every correction was asked in a tenth of a second: the
  // servos cannot do it, they go flat out and stop with a jerk (measured with the camera the same morning: the picture
  // is still about 0.23 s after the servos confirm the command). So these moves are asked in the time they take
  // anyway, at a steady speed: at least FOLLOW_MOVE_S, and no faster than FOLLOW_MOVE_SPEED for the wide ones. Commands
  // (voice, iPhone, gestures, dances) keep the one head speed the owner asked for.
  // Off an hour later: asked in 0.22 s the move ends later than the wait measured for the sharp one, the camera looked
  // while the head still moved and the owner said «non funziona». On again the same day (11:34) with the wait measured
  // for these moves (CAMERA_AFTER_MS above), so that each correction takes about 0.12 s more than a sharp one; and OFF
  // again at 11:45 (FOLLOW_GENTLE false): the owner, trying it, «mi sembra peggiorato rispetto a prima». The slower
  // following is what he sees, not the softer move. Not to be switched on again unless he asks; then one thing at a
  // time, and the halfway measured (0.16 s and 3.5 rad/s, 0.06 s more a correction) before this one.
  // Only when the robot follows by itself: with the iPhone finding the face the camera still waits the time reckoned
  // (headMoving), which was not measured for a gentle move.
  
  // Nobody in sight for ALONE_SLEEP_MS (owner, 14 Nov 2026: «se per 30 secondi non vede nessuno, deve fermarsi e chiudere
  // gli occhi»): the head stops where it is, no more looking around, and the eyes close. The camera goes on looking:
  // the first face opens the eyes and the head follows again. A conversation, the iPhone or a reminder wake it too.
  let asleep=false;
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
  // speed (optional, rad/s): a gentler move than the one head speed, for the moves the robot makes by itself.
  const setHeadPose=(rotation,minimum,onConfirmed,speed)=>{
    const cal=calibrating?.trial??headCal,target=reachable(rotation,cal),now=clock.now(),from=headNow(now);
    const duration=Math.max(moveTime(from,target,minimum),speed>0?Math.hypot(target.y-from.y,target.p-from.p)/speed:0);
    if(!Number.isFinite(duration))throw Error('invalid_pose');
    // arrive: when the head is taken to be there for the camera and the head sensor. The servos are asked for the
    // move in `duration` (calibration.js HEAD_SPEED, 6 rad/s since 13 Nov 2026), but what they do with the head on
    // them has not been measured: the wait is still reckoned at ARRIVE_SPEED, as when that was the one speed.
    const move={from,to:target,start:now,duration,arrive:Math.max(duration,Math.hypot(target.y-from.y,target.p-from.p)/K.ARRIVE_SPEED)};headMove=move;
    const pose={rotation:toHost(safeRotation(rotation),cal)},revision=motionRevision,armed=tracker.enabled;
    // TEMPORARY diagnostics (10 Nov 2026, «Movimento non confermato» with nothing lost): when the command really
    // left for the host (h, after the request) and, for a pose confirmed in 250 ms or more, how long the host took.
    const send=()=>{
      const at=clock.now();poseSentAt=at;poseConfirmed=false;let heard;
      const confirm=()=>{if(headMove===move)poseConfirmed=true;if(heard===undefined){heard=clock.now();move.confirmed=heard;if(onConfirmed){const done=onConfirmed;onConfirmed=undefined;try{done();}catch{}}}};
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
  // The iPhone app connected (remoteActive) no longer takes the robot over (owner, 15 Nov 2026, now that the app
  // connects by itself whenever it is open: «rendiamo il robot completamente autonomo quando l'app è collegata»): the
  // robot goes on following a face, sleeping, following with the rover and taking spoken commands. The iPhone DRIVES
  // only while it really commands: for REMOTE_HEAD_MS after a head command or its STOP, for REMOTE_ROVER_MS after a
  // rover key, and for as long as its «Segui il mio viso» or a dance of its own is going. While it drives, everything
  // is as it was with the iPhone connected: nothing moves unless the iPhone, or a spoken command, asks for it.
  let remoteHoldUntil=0,videoHold=false;
  const remoteHold=ms=>{remoteHoldUntil=Math.max(remoteHoldUntil,clock.now()+ms);};
  const remoteDriving=()=>remoteActive&&(cameraFollow||!!remoteDance||clock.now()<remoteHoldUntil);
  // …or the iPhone is in a call with the robot: microphone and speaker are the call's.
  const remoteBusy=()=>remoteDriving()||!!live?.calling;
  // Following a face by the robot alone (13 Nov 2026, live-device.js self): the robot finds the face with its own
  // camera and turns the head to it, with no iPhone. Always, while the robot is on and its motions are (owner, 13 Nov
  // 2026: «sempre quando il robot è acceso, non solo durante la chiamata»), except while the iPhone has the head
  // (Live open without «Segui il mio viso»). The camera stays on through a whole conversation: switched off and on at
  // every change of turn (13 Nov 2026, first try) it kept the robot busy just when the audio changed. OFF unless switched on on the robot
  // (preference selfFollow true): the face finder of 13 Nov 2026 does not find the owner's real face (live-device.js).
  // The camera is asked for again 5 s after a refusal.
  let selfSwitching=false,selfRetryAt=0,voiceReady=false; // voiceReady: the conversation's connection and audio are up
  const followingFace=()=>cameraFollow||!!live?.selfActive;
  const selfFollowWanted=()=>{
    // Not while a gesture or a dance moves the head: they are over in a moment, and switching the camera off and on
    // for each of them (13 Nov 2026) kept the robot busy in the middle of a conversation. The camera stays on; the
    // head simply does what it was told first.
    if(closed||!tracker.enabled||motionFault||calibrating)return false;
    // A conversation opening: its connection needs the internal RAM the camera holds (13 Nov 2026: 0 KB left at that
    // moment with the camera on). The camera comes back when the conversation is ready and stays for all of it.
    if(voice?.active&&!voiceReady)return false;
    // Nobody in the room (owner, 23 Nov 2026: «usa il sensore di presenza per capire se c'è qualcuno; se non c'è
    // nessuno, smetti di inseguire i visi»): the presence sensor has felt no movement for K.NOBODY_MS, and no
    // conversation is on. The camera goes off (its memory too) and comes back at the first movement (presenceTurn).
    if(presence.nobody&&!voice?.active)return false;
    return true; // whether following alone is on at all is live-device.js selfAvailable
  };
  const LOOK_UP=25*Math.PI/180;
  // Where the head goes when the motors start, and when the power button is pressed (owner, 14 Nov 2026: «quando si
  // accende, fallo partire da una posizione circa 20 gradi in su», then «intercetta il pulsante di spegnimento… torni
  // a una posizione uguale a quella di partenza»): straight, 20° up (pitch − is up). Before, straight ahead.
  const START_PITCH=-20*Math.PI/180;
  // The power button (owner, 14 Nov 2026: «intercetta il pulsante di spegnimento e fa in modo tale che torni a una
  // posizione uguale a quella di partenza, a 20 gradi in su, guardando dritto»). The host reads the power chip
  // (AXP2101) every 100 ms and gives a short 1 → 0 on button.power for each press; held down, the chip cuts the power
  // after about 4 s (its register 0x27 is 0 on this host: 4 s), and it reports the long press after about 1.5 s, so the
  // head has well over two seconds to get there. A short press is reported too (the host then opens its own mod
  // manager): the head goes there all the same and, if the robot stays on, is free again after POWER_HOLD_MS.
  let powerHeldUntil;
  const poweringOff=()=>powerHeldUntil!==undefined&&clock.now()<powerHeldUntil;
  let socketModule;try{socketModule=Modules.importNow('robottino-socket');}catch{}
  // TEMPORARY diagnostics (14 Nov 2026, the Wi-Fi dropping again and again): every 5 s what the chip knows of its Wi-Fi
  // (the host's face-finder module, wifiInfo: strength, channel, drops so far, the reason and strength of the last).
  let wifiProbe,wifiShownAt=0,memoryShownAt,heldShownAt;try{if(Modules.has('robottino-face-finder')){const found=Modules.importNow('robottino-face-finder');if(typeof found?.wifiInfo==='function')wifiProbe=found;}}catch{wifiProbe=undefined;}
  // Lifted, shaken, fallen (owner, 14 Nov 2026: «reagire se viene sollevato o scosso; fermare i motori se cade»). The
  // host reads its motion sensor every 100 ms once started (robot.input.imu; with the host's own behaviour replaced by
  // this MOD nobody else starts it), and motion-sense.js judges the readings: the sensor is in the head, so the head's
  // own pitch is taken out first. Needs the host of 14 Nov 2026 (imu-last-sample.patch: `sample`); with an older one
  // nothing is started.
  // - the head goes on moving all the same (owner, 14 Nov 2026, after trying it: «devi comunque attivare i movimenti,
  //   anche se reagisce al sollevamento e alla caduta»). At first no head command left while the robot was held or
  //   fallen («fermare i motori se cade»): taken out. `carried` only keeps the robot awake while it is handled.
  //   The head stops only for the two seconds of a phrase (speaking, in headQuiet), as he asked next.
  // - what shows and sounds (owner, 14 Nov 2026): lifted, one of its recorded phrases, at random and never the same
  //   twice running, and then the happy face for a few seconds; shaken, the angry face and one of the phrases for a
  //   shake; turned over or lying down, the scared face and its recorded call for help. Only spoken, nothing written on the screen, and
  //   the mouth moves with the words (phrase-mouths.js). Nothing at all in a conversation: face and speaker are the
  //   conversation's.
  // - one phrase at a time (phraseWaiting): the one for being lifted waits a moment and is dropped by a fall, so that
  //   a robot being turned over says only the call for help; a phrase that finds the speaker busy waits for it.
  const imu=robot.input?.imu;let sense,carried=false,posedSince,motionFace=false,imuShownAt=0;
  const imuSeen={tilt:0,off:0,turn:0,movingOff:0,movingTurn:0}; // TEMPORARY: the largest readings since the last log line
  try{if(imu&&typeof imu.start==='function'&&'sample' in imu){imu.start();sense=new MotionSense();}}catch{sense=undefined;}
   // the motors have held the head for this long: it is where the robot thinks
  let lastPhrase,phraseWaiting,speaking;
  // The mouth while a recorded phrase is said: the recording's own loudness, step by step (phrase-mouths.js), from
  // PHRASE_START_MS after the sound was asked for (the host's start; not measured). mouthStep is called from the
  // robot's cycle and, in between, from its own timer, so the lips move every PHRASE_MOUTH_MS and not every 100 ms.
  
  const mouthStep=()=>{
    const said=speaking;if(!said)return;
    const now=clock.now(),step=Math.floor((now-said.from)/PHRASE_MOUTH_MS);
    if(closed||voice?.active||!(step<said.track.length)){
      speaking=undefined;try{robot.face.setMouthOpen(0);}catch{}
      if(!closed&&!voice?.active)said.after?.(now);
      return;
    }
    const open=step<0?0:MOUTH_POSES[said.track.charCodeAt(step)-48]??0;
    if(open!==said.open){said.open=open;try{robot.face.setMouthOpen(open);}catch{}}
  };
  const mouthTimer=()=>{try{mouthStep();}catch{}if(speaking&&!closed)Timer.set(mouthTimer,PHRASE_MOUTH_MS);};
  // after (optional): called when the phrase is over.
  const sayPhrase=(list,after)=>{
    const phrase=pickPhrase(list,lastPhrase);lastPhrase=phrase;
    if(playSound(phrase[0])!==true)return;
    const track=PHRASE_MOUTHS[phrase[0]];
    if(!track){after?.(clock.now());return;}
    const idle=!speaking;speaking={track,after,open:0,from:clock.now()+K.PHRASE_START_MS};
    if(idle)Timer.set(mouthTimer,PHRASE_MOUTH_MS);
  };
  // One phrase waits at a time, and the more urgent one stays: the call for help of a fall (3) over the phrase for a
  // shake (2) over the one for being lifted (1). Without this a robot being shaken lost its phrase every time its
  // state changed on the way (lifted, then shaken while «dove mi porti?» was still being said).
  const phraseLater=(list,delay,rank)=>{
    if(phraseWaiting&&phraseWaiting.rank>rank)return;
    const now=clock.now();phraseWaiting={list,rank,held:rank===1,at:now+delay,until:now+delay+PHRASE_WAIT_MS};
  };
  const motionEvent=event=>{
    if(typeof trace==='function')trace(`[robottino] motion ${event}\n`);
    const quiet=!!voice?.active||!!calibrating; // the face and the speaker belong to something else
    if(event==='held'||event==='fallen'){
      carried=true;
      if(quiet){phraseWaiting=undefined;return;}
      // Turned over or lying down: the scared face (owner, 14 Nov 2026), the sad one for a face that has no scared picture.
      if(event==='fallen'){robot.face.setEmotion(SCARED);motionFace=true;faceHoldUntil=Infinity;phraseLater(FALLEN_PHRASES,0,3);}
      // Picked up after a fall it is on its way to standing: the phrase only if it stays in the hand.
      else phraseLater(HELD_PHRASES,motionFace?HELD_AFTER_FALL_MS:HELD_SPEAK_MS,1);
    }else if(event==='down'){
      carried=false;if(phraseWaiting&&phraseWaiting.rank!==2)phraseWaiting=undefined; // standing: a shake just felt is still answered
      if(motionFace){motionFace=false;faceHoldUntil=undefined;if(!quiet)setMood('neutral');}
    }else if(event==='shaken'&&!quiet&&sense.state!=='fallen'){
      // Also right after a fall, once it has been picked up: the sad face gives way to the angry one.
      motionFace=false;robot.face.setEmotion(1);faceHoldUntil=clock.now()+K.FACE_HOLD_MS;phraseLater(SHAKEN_PHRASES,0,2);
    }
  };
  // Called from the robot's cycle: says the phrase that is waiting, once its moment has come and the speaker is free.
  const phraseTurn=now=>{
    mouthStep();
    const waiting=phraseWaiting;if(!waiting||now<waiting.at)return;
    if(now>=waiting.until||voice?.active){phraseWaiting=undefined;return;}
    if(touchSoundPlaying||(waiting.held&&sense.tilt>=HELD_SPEAK_TILT))return; // the speaker is busy, or it is falling over
    phraseWaiting=undefined;
    if(!waiting.held){sayPhrase(waiting.list);return;}
    // Lifted: the usual face while it speaks (the happy picture has no mouths for talking, as with the spoken
    // «sorridi»), then the happy one for a few seconds, the white robot too. After a fall the sad face goes first.
    if(motionFace){motionFace=false;faceHoldUntil=undefined;setMood('neutral');}
    sayPhrase(waiting.list,ended=>{if(!motionFace){robot.face.setEmotion(3);faceHoldUntil=ended+K.FACE_HOLD_MS;}});
  };
  // The robot's ears (owner, 14 Nov 2026: «girarsi verso la voce quando non ti vede»). The host says which of its two
  // microphones hears a sound first (face-finder soundSide, sound-side-core.c) and sound-ear.js when that is a voice
  // and from which side: only «left or right», and not for sure, because the two microphones are almost in the same
  // place (measured with the owner at 13:41, see sound-ear.js).
  // - Asleep (nobody in sight for 30 s, eyes closed, head at rest) both microphones are open. A voice for about half
  //   a second: the robot wakes and the look around starts from the side of the voice (live-device.js selfWake).
  //   Nothing leaves the robot and nothing is kept; whenever the microphones are open a light is on (watching).
  //   Any lasting sound louder than the room wakes it, not only a voice. Preference earWake false switches it off.
  // - The microphones open only once the head has stopped at its place of rest, and close before it moves again: the
  //   head stays still while they are open (ear in headQuiet), so the robot never hears its own motors.
  // - A conversation, a sound of the robot, the iPhone: the microphones are closed first (earClose): microphone and
  //   speaker are never open together, and the conversation and the Live call open the microphone themselves.
  // - «Prova orecchie», the menu entry that wrote every reading on the USB log to measure the microphones, did its
  //   work on 14 Nov 2026 (13:41) and was taken out at the owner's word («rimuovi dal menu prova orecchie»); it is in
  //   the history of this file (commit b8579c3) if the microphones are ever to be measured again.
  // - «Guardalo e parla» (owner, 14 Nov 2026, 19:33: «dobbiamo trovare una wake word o qualcosa per far partire la
  //   conversazione senza schiacciare lo schermo, perché se si muove è un problema»; chosen «soluzione 1»): awake, with
  //   a face in sight (seen within LOOK_SEEN_MS), the microphones are open too; a voice for about half a second while
  //   the face is there starts the conversation, as the long touch does. Here the head goes on following: what the
  //   microphones hear while the head moves, and for a moment after (headSettled), is not listened to. Preference
  //   lookToTalk false switches it off.
  
  let earMode,lookToTalk=true;try{lookToTalk=Preference.get('robottino','lookToTalk')!==false;}catch{}
  let earHeardAt,earHeardLag=0,earHeardSide=0,ear,earBest=0,earPieces=0,earHeard,earShownAt=0,earNotBefore=0,asleepSince,soundProbe;const earSound={level:0,quality:0,lag:0};
  try{if(Modules.has('robottino-face-finder')&&Modules.has('embedded:io/audio/in')){const found=Modules.importNow('robottino-face-finder');if(typeof found?.soundSide==='function')soundProbe=found;}}catch{soundProbe=undefined;}
  let earWake=true;try{earWake=Preference.get('robottino','earWake')!==false;}catch{}
  const earClose=()=>{const microphone=ear;ear=undefined;earMode=undefined;if(microphone)earNotBefore=clock.now()+K.EAR_PAUSE_MS;try{microphone?.close();}catch{}};
  const earOpen=(look=false)=>{
    const found=Modules.importNow('embedded:io/audio/in'),AudioIn=found?.default??found,probe=soundProbe;
    earBest=0;earPieces=0;earHeard=look?new SoundEar(LOOK_NEED,LOOK_WINDOW_MS):new SoundEar();
    // As every microphone callback (firmware.md): read what is there, no size asked, and no error may leave it.
    const microphone=new AudioIn({sampleRate:16000,channels:2,bitsPerSample:16,onReadable(){
      try{const data=this.read();if(!data)return;const value=probe.soundSide(data);earPieces++;if((value&65535)>(earBest&65535))earBest=value;}catch{}
    }});
    ear=microphone;earShownAt=clock.now();
    if(microphone.channels!==2||microphone.sampleRate!==16000||microphone.bitsPerSample!==16)throw Error('audio_format');
    microphone.start();
  };
  // «Chiamata con lo sguardo» (gaze.js; owner, 21 Nov 2026): one name here only, the MOD's main function is at the
  // limit of the robot's JavaScript stack.
  const gaze=new GazeCall((()=>{try{return Preference.get('robottino','gazeCall')===true;}catch{return false;}})());
  // Schede NFC (nfc.js; owner, 21 Nov 2026: «Sì, preparalo»; never tried on the robot): off unless chosen in the big
  // menu (preference nfc); one name here only, for the same reason. For now a card is only shown and logged.
  const nfc=new NfcCards((()=>{try{return Preference.get('robottino','nfc')===true;}catch{return false;}})(),{clock:()=>clock.now()});
  // Called from the robot's cycle.
  const earTurn=now=>{
    if(earMode==='duplex')return; // the duplex trial (testDuplex) holds the microphones
    // To learn what the delay between the microphones is worth: after a voice woke the robot, where the face was
    // then found (once, within half a minute). The pairs stay on the card's log.
    if(earHeardAt!==undefined){
      if(now-earHeardAt>30000)earHeardAt=undefined;
      else if(live?.selfSeenMs<500){
        if(typeof trace==='function')trace(`[robottino] ear check lag ${earHeardLag.toFixed(2)} looked ${earHeardSide>0?'left':'right'} face at yaw ${Math.round(tracker.yaw*57.3)} pitch ${Math.round(tracker.pitch*57.3)} after ${Math.round((now-earHeardAt)/100)/10} s\n`);
        earHeardAt=undefined;
      }
    }
    // Looking at someone: is there anything that says not to listen now?
    // Only with the app's «Chiamata se mi guardi per 10 secondi» on (owner, 23 Nov 2026: «anche se la chiamata, se mi
    // guardi, è disattivata, parte lo stesso»: it was this, a voice heard with a face in sight).
    const lookBusy=()=>closed||asleep||!lookToTalk||!gaze.on||!soundProbe||wake||calibrating||poweringOff()||touchSoundPlaying||speaking||voice?.active||remoteBusy()||!live?.selfActive;
    if(!ear&&!lookBusy()&&now>=earNotBefore&&live.selfSeenMs<K.LOOK_SEEN_MS){
      try{earOpen(true);earMode='look';if(typeof trace==='function')trace('[robottino] ear listening (face in sight)\n');}
      catch(error){earClose();earNotBefore=now+60000;if(typeof trace==='function')trace(`[robottino] ear failed ${String(error?.message??error).slice(0,60)}\n`);}
      return;
    }
    if(ear&&earMode==='look'){
      if(lookBusy()||!(live.selfSeenMs<K.LOOK_GONE_MS)){earClose();earNotBefore=Math.min(earNotBefore,now+500);return;}
      const value=earBest;earBest=0;
      if(posePending||!headSettled()||rover?.moving||now<roverQuietUntil)return; // the head or the wheels are moving: their own motors
      if(readSound(value,earSound)){
        const {level,lag,quality}=earSound,room=earHeard.room,heard=earHeard.update(level,lag,quality,now);
        if(heard&&live.selfSeenMs<K.LOOK_SEEN_MS){
          if(typeof trace==='function')trace(`[robottino] look to talk: voice level ${heard.level} room ${Math.round(room)}\n`);
          earClose();voiceDiag('look');toggleVoice();
        }
      }
      if(now-earShownAt>=30000&&typeof trace==='function'){earShownAt=now;trace(`[robottino] ear look pieces ${earPieces} room ${Math.round(earHeard.room)}\n`);}
      return;
    }
    if(!ear){
      // Asleep, the head arrived at its rest, nothing else using speaker or microphone: listen.
      if(!earWake||!soundProbe||!asleep||closed||asleepSince===undefined||now-asleepSince<K.EAR_SLEEP_AFTER_MS||now<earNotBefore)return;
      if(posePending||!headSettled()||touchSoundPlaying||speaking||voice?.active||remoteBusy())return;
      try{earOpen();earMode='asleep';if(typeof trace==='function')trace('[robottino] ear listening (asleep)\n');}
      catch(error){earClose();earNotBefore=now+60000;if(typeof trace==='function')trace(`[robottino] ear failed ${String(error?.message??error).slice(0,60)}\n`);}
      return;
    }
    if(!asleep||voice?.active||remoteBusy()){earClose();return;} // woken by something else: the microphones close
    const value=earBest;earBest=0;
    if(readSound(value,earSound)){
      const {level,lag,quality}=earSound,room=earHeard.room,heard=earHeard.update(level,lag,quality,now);
      if(heard){
        // A voice: the microphones close first, then the look around starts from that side.
        // The side when it is clear, a guess when it is not (sound-ear.js guessOf): either way the look around goes
        // to one side at the height the head is at, not upwards as for a lost face.
        const toward=heard.side||heard.guess;
        if(typeof trace==='function')trace(`[robottino] ear voice side ${heard.side} guess ${heard.guess} lag ${heard.lag.toFixed(2)} level ${heard.level} room ${Math.round(room)}\n`);
        earClose();earHeardAt=now;earHeardLag=heard.lag;earHeardSide=toward;
        try{live?.selfWake?.(toward);}catch{}
        // With the rover on, the body turns that way too (rover-body.js), but only for a side heard clearly: the head may
        // look on a guess, the whole body does not (rover check, 15 Nov 2026).
        roverBody.voice(heard.side);
        // Following with the rover, the body's search starts at once, toward that side when it is clear.
        if(roverFollowing)roverFollow.toward(heard.side);
        return;
      }
    }
    if(now-earShownAt>=30000&&typeof trace==='function'){earShownAt=now;trace(`[robottino] ear asleep pieces ${earPieces} room ${Math.round(earHeard.room)}\n`);}
  };
  // The K210 camera on the Grove serial line, PORT.C (k210.js). PREPARED, NEVER TRIED: the camera had not arrived
  // (14 Nov 2026). Off unless it is switched on on the robot (preference k210 true, «K210» in the large menu). It only
  // listens and writes what it hears on the USB log every 5 s; the head does not follow it yet.
  let k210;
  const k210Open=()=>{
    if(k210)return;
    try{
      if(!Modules.has('embedded:io/serial'))return;
      const found=Modules.importNow('embedded:io/serial');
      k210=createK210({Serial:found?.default??found,now:()=>clock.now(),log:line=>{if(typeof trace==='function')trace(`[robottino] ${line}\n`);}});
    }catch{k210=undefined;}
  };
  const k210Close=()=>{const camera=k210;k210=undefined;try{camera?.close();}catch{}};
  try{if(Preference.get('robottino','k210')===true)k210Open();}catch{}
  // The LEGO Technic Hub 88012 with two motors 88013 over Bluetooth (lego-wire.js createLegoHub; owner, 14 Nov 2026:
  // «inizia ad implementare il collegamento bluetooth per hub lego»). PREPARED, NEVER TRIED WITH A REAL HUB. Off unless
  // switched on (preference lego, «LEGO» in the large menu): the Bluetooth stack takes about 50 KB of internal RAM.
  // Not with the Bluetooth face following (bleTracking): one Bluetooth role at a time.
  // SWITCHED OFF, COMMENTED OUT (owner, 14 Nov 2026: «Ho comprato il rover di M5Stack standard, quindi non mi serve più
  // l'integrazione con Lego. Per ora commenta tutto e togli la voce del menu»). lego-wire.js and its tests stay in the
  // repository but are not in the MOD (manifest.json). To bring it back: uncomment here, in close(), in the menu and
  // the import, put the manifest line back, and the two tests in mod.test.mjs.
//   let lego;
//   const legoSay={scanning:'LEGO: cerco l’hub…',lost:'LEGO: hub scollegato, lo cerco di nuovo.',not_found:'LEGO: nessun hub trovato. Accendilo e riaccendi LEGO dal menu.',error:'LEGO: Bluetooth non disponibile.'};
//   const legoOpen=()=>{
//     if(lego||closed)return false;
//     if(Preference.get('robottino','bleTracking')===true){say('LEGO: prima spegni l’inseguimento Bluetooth.');return false;}
//     if(!Modules.has('bleclient')||!Modules.has('btutils')){say('LEGO: Bluetooth non disponibile in questo host.');return false;}
//     try{
//       const found=Modules.importNow('bleclient'),BLEClient=found?.default??found,{uuid}=Modules.importNow('btutils');
//       lego=createLegoHub({BLEClient,uuid,timer:{set:(fn,ms)=>Timer.set(fn,ms),clear:id=>Timer.clear(id)},log:text=>{if(typeof trace==='function')trace(text);},
//         changed:state=>{if(closed||!lego)return;if(state==='ready')say(`LEGO: hub collegato, motori ${lego.motors.join(' e ')}.`);else if(legoSay[state])say(legoSay[state]);}});
//       if(!lego.start()){lego=undefined;return false;}
//       return true;
//     }catch(error){lego=undefined;if(typeof trace==='function')trace(`[robottino] lego failed ${String(error?.message??error).slice(0,60)}\n`);say('LEGO: Bluetooth non disponibile.');return false;}
//   };
//   const legoClose=()=>{const hub=lego;lego=undefined;try{hub?.close();}catch{}};
//   try{if(Preference.get('robottino','lego')===true)legoOpen();}catch{}
  // The M5Stack RoverC Pro under the robot (rover-wire.js createRover; owner, 14 Nov 2026: «Procedi con integrazione
  // del roverc pro di m5»). PREPARED, NEVER TRIED WITH THE REAL ROVER. A Grove cable from the rover to Port A (I2C,
  // G2/G1). Off unless switched on (preference rover, «Rover» in the large menu): on means the robot looks for it once,
  // and keeps it only if it answers. Every move is stopped by the robot itself (ROVER_LIMITS).
  let rover;
  const roverOpen=()=>{
    if(rover||closed)return false;
    if(!Modules.has('embedded:io/i2c')){say('Rover: I2C non disponibile in questo host.');return false;}
    try{
      const found=Modules.importNow('embedded:io/i2c');
      const line=createRover({I2C:found?.default??found,allowForward:()=>roverForwardReady(),timer:{set:(fn,ms)=>Timer.set(fn,ms),clear:id=>Timer.clear(id)},log:text=>{if(typeof trace==='function')trace(text);}});
      if(!line.open()){line.close();say('Rover: non risponde sulla porta A. Controlla il cavo e che sia acceso.');return false;}
      rover=line;return true;
    }catch(error){if(typeof trace==='function')trace(`[robottino] rover failed ${String(error?.message??error).slice(0,60)}\n`);say('Rover: I2C non disponibile.');return false;}
  };
  const roverClose=()=>{const line=rover;rover=undefined;try{line?.close();}catch{}roverFollowing=false;tofClose();tofWas=false;tofLost=false;};
  // What the body does by itself (rover-body.js: 1 toward a voice, 2 after a face, 5 stop when lifted) and the moves
  // asked by the voice (agent tool muovi_rover) or the iPhone (Live): all at ROVER_SPEED, all stopped by the robot.
  // While the wheels turn and for half a second after, the microphones' look-to-talk does not listen (their noise).
  
  const roverBody=new RoverBody();let roverQuietUntil=0;
  // For the camera (live-device.js): a move that turns the body carries the picture with it, and for ROVER_CAMERA_MS
  // after it the picture still moves. A move of following that goes straight (rover-follow.js `look`, 16 Nov 2026)
  // does not: the camera goes on looking during it, which is what lets the drive go on without stopping.
  let roverLook=false,roverBlurUntil=0;
  // roverCut: why the last move was cut short by the robot itself ('obstacle', 'lifted'), for the agent's tool.
  let roverCut;
  const roverBegan=(now,ms,look=false)=>{roverCut=undefined;roverQuietUntil=now+ms+500;roverLook=look;if(!look)roverBlurUntil=now+ms+K.ROVER_CAMERA_MS;};
  const roverHalted=now=>{roverQuietUntil=now+500;if(!roverLook)roverBlurUntil=now+K.ROVER_CAMERA_MS;};
  // How fast the robot is turning about the vertical, for rover-follow.js (16 Nov 2026: one turn as wide as the angle,
  // measured, instead of pieces reckoned by the clock). The motion sensor is in the head: with the head still, what
  // its gyroscope reads about the vertical (the direction of gravity as the same reading gives it, so the head's
  // pitch does not matter) is the body's turn on the rover. Degrees a second from the host, radians here; no sign,
  // the way is the one the wheels were told. Nothing while the head moves (that is the head's own turn, up to
  // 317°/s) or without the sensor: rover-follow.js then reckons by the clock. `at` is when this reading was first
  // seen (the host takes one every 100 ms).
  let spinSeen,spinAt=0;
  const roverSpin=now=>{
    if(!imu||posePending||headMoving())return;
    let reading;try{reading=imu.sample;}catch{return;}
    const a=reading?.accelerometer,g=reading?.gyroscope;if(!a||!g)return;
    const key=`${g.x},${g.y},${g.z},${a.x}`;if(key!==spinSeen){spinSeen=key;spinAt=now;}
    const pull=Math.hypot(a.x,a.y,a.z),rate=Math.abs(g.x*a.x+g.y*a.y+g.z*a.z)/pull*Math.PI/180;
    return pull>0&&Number.isFinite(rate)?{rate,at:spinAt}:undefined;
  };
  
  const roverUnsafe=()=>!!sense&&sense.state!=='down';
  // move: one of rover-wire.js MOVES (the robot's own left and right) or 'stop'. 'ok' or why not, as a tool code.
  // Forward only with the distance sensor (on the head: it turns with it) looking where it should (review, 23 Nov
  // 2026; owner chose «A»): every forward move needs a reading taken with the head still, at most 300 ms old. Only
  // while exploring the head must also be straight (within 5°): its vertical scan leaves it up to 50° up, where the
  // sensor reads the ceiling. The Force, following with the rover, the voice and the iPhone drive with the head up or
  // down as it is (20° up at rest, toward a face, tilted back after a push), but turned at most FORWARD_YAW to a side.
  const roverForwardReady=(now=clock.now())=>{
    const pose=headMove.to,level=Math.abs(pose.y)<=5*Math.PI/180&&Math.abs(pose.p)<=5*Math.PI/180;
    if((explore.walk.active?!level:Math.abs(pose.y)>K.FORWARD_YAW)||posePending||!headSettled()){headMove.frontAt=undefined;return false;}
    headMove.frontAt??=now;
    // A distance taken while the head was moving (or, exploring, tilted) cannot authorise forward travel.
    if(tofWas){const last=tof?.last;return tof?.state==='ready'&&last&&last.at>=headMove.frontAt&&now-last.at<=300;}
    return true;
  };
  const roverMove=(move,ms)=>{
    // A stop still owed to the rover (rover-wire.js, 17 Nov 2026) is tried whatever the state.
    if(move==='stop'&&(rover?.unstopped||rover?.state==='error'))return rover.stop()?'ok':'rover_error';
    if(!rover||rover.state!=='ready')return 'no_rover';
    if(move==='stop')return rover.stop()?'ok':'rover_error';
    // The gripper (rover-wire.js GRIP): no wheels turn, so it also works with the robot in a hand.
    if(Object.hasOwn(GRIP_MOVES,move))return rover.grip(move)?'ok':'rover_error';
    const now=clock.now();
    if(roverUnsafe()||!roverBody.free(now))return 'lifted';
    // Obstacle sensor (rover-follow.js obstacleAhead): never forward with something right in front. The other moves
    // go where the sensor does not look.
    if(move==='forward'&&tofWas&&tof?.state!=='ready')return 'obstacle_sensor';
    if(move==='forward'&&!roverForwardReady(now))return 'head_not_level';
    if(move==='forward'&&obstacleAhead(tof?.last,now))return 'obstacle';
    if(!rover.go(move,K.ROVER_SPEED,ms))return 'rover_error';
    roverBegan(now,ms);roverFollow.release();
    if(typeof trace==='function')trace(`[robottino] rover ${move} ${ms} ms\n`);
    return 'ok';
  };
  try{if(Preference.get('robottino','rover')===true)roverOpen();}catch{}
  // «Inseguimento con rover» (rover-follow.js, owner 15 Nov 2026): the VL53L0X distance sensor (tof-wire.js) on Port A
  // with the rover, through a Grove hub. Off unless switched on from the iPhone's Robot tab (preference roverFollow);
  // on only with the rover and the sensor both answering. While it is on, the body's own face turns (rover-body.js 2)
  // give way to it; the stop when lifted and the wait after it stay.
  let tof,tofWas=false,roverFollowing=false;const roverFollow=new RoverFollow(); // tofWas: the sensor has answered since the rover was switched on
  const tofOpen=()=>{
    if(tof?.state==='ready')return true;
    if(!Modules.has('embedded:io/i2c'))return false;
    try{
      const found=Modules.importNow('embedded:io/i2c');
      // The robot's own clock (Time.ticks), the one roverTurn gives to rover-follow.js: a reading's age is then a true age.
      // (Code review, 15 Nov 2026: with the time of day here, Date.now, every reading looked fresh for ever.)
      const line=createTof({I2C:found?.default??found,now:()=>clock.now(),log:text=>{if(typeof trace==='function')trace(text);}});
      if(!line.open()){line.close();return false;}
      tof=line;tofWas=true;return true;
    }catch(error){if(typeof trace==='function')trace(`[robottino] tof failed ${String(error?.message??error).slice(0,60)}\n`);return false;}
  };
  const tofClose=()=>{const line=tof;tof=undefined;try{line?.close();}catch{}};
  // true when done: off always; on only with the rover ready and the distance sensor answering.
  const setRoverFollow=on=>{
    tofLost=false;
    if(!on){
      // It always stops; «done» only if the choice is also saved (otherwise it would come back on at the next start).
      // The distance sensor stays open: it is still the obstacle sensor.
      let saved=true;roverFollowing=false;try{Preference.set('robottino','roverFollow',false);}catch{saved=false;}
      // The wheels' stop is looked at too (R1, 17 Nov 2026; code review, 19 Nov 2026): «off» only once they have stopped.
      let stopped=true;try{if(rover?.moving||rover?.unstopped)stopped=rover.stop()===true;}catch{stopped=false;}
      say(!stopped?'Inseguimento spento, ma il rover non conferma lo stop: riprovo.':saved?'Inseguimento con rover: spento.':'Inseguimento spento, ma non salvato: al riavvio si riaccende.');live?.hello?.();return saved&&stopped;
    }
    if(rover?.state!=='ready'){say('Inseguimento: prima accendi il rover dal menu.');return false;}
    if(!tofOpen()){say('Inseguimento: il sensore di distanza non risponde sulla porta A.');return false;}
    // It follows with the head too (owner, 15 Nov 2026: «oltre a seguirmi con il rover deve seguirmi con la testa»): the
    // head's own face following is what turns the body; motions off are switched on, as the iPhone's switch does.
    if(!tracker.enabled&&!arming&&!setMotions(true)){say('Inseguimento: prima rifai la calibrazione della testa.');return false;}
    try{Preference.set('robottino','roverFollow',true);}catch{return false;}
    roverFollowing=true;say('Inseguimento con rover: acceso.');live?.hello?.();return true;
  };
  // With the rover on, the distance sensor is looked for at once: it is also the obstacle sensor (owner, 15 Nov 2026:
  // «possiamo fare sensore ostacoli»), whether following is on or not. Following switched on before a restart: on
  // again if the rover and the sensor answer.
  try{if(rover?.state==='ready'&&tofOpen()&&Preference.get('robottino','roverFollow')===true)roverFollowing=true;}catch{}
  // Temperature, humidity and pressure from the ENV III unit on Port A (climate-wire.js; owner, 15 Nov 2026). Looked for
  // at start and, while missing, every CLIMATE_RETRY_MS; read every 30 s. The iPhone gets them in the robot's status
  // (live-device.js hello) whenever they change by 0.1 °C or 1 %.
  let climate,climateTriedAt=-Infinity,climateSent;
  const climateTurn=now=>{
    if(climate?.state!=='ready'){
      if(now-climateTriedAt<K.CLIMATE_RETRY_MS||!Modules.has('embedded:io/i2c'))return;climateTriedAt=now;
      try{const found=Modules.importNow('embedded:io/i2c');const line=createClimate({I2C:found?.default??found,now:()=>clock.now(),log:text=>{if(typeof trace==='function')trace(text);}});
        if(line.open())climate=line;else{line.close();climate=undefined;}}catch{climate=undefined;}
      return;
    }
    const r=climate.poll();if(!r)return;
    if(typeof trace==='function')trace(`[robottino] climate ${r.t.toFixed(1)} C ${r.h.toFixed(0)} %${r.p?` ${(r.p/100).toFixed(1)} hPa`:''}\n`);
    if(!climateSent||Math.abs(r.t-climateSent.t)>=.1||Math.abs(r.h-climateSent.h)>=1){climateSent=r;live?.hello?.();}
  };
  // The distance sensor alone, with no rover switched on (owner, 19 Nov 2026: «tof collegato, provali»): looked for at
  // start and, while missing, every TOF_ALONE_RETRY_MS, like the climate unit; read at every turn; on the log when the
  // distance changes by 2 cm or more. With the rover on, the sensor belongs to roverTurn (obstacles, following).
  let tofAloneTriedAt=-Infinity,tofLogged,tofLoggedAt=-Infinity;
  const tofTurn=now=>{
    if(rover)return;
    if(tof?.state!=='ready'){
      if(tof){tofClose();tofLogged=undefined;if(typeof trace==='function')trace('[robottino] tof lost\n');}
      if(now-tofAloneTriedAt<K.TOF_ALONE_RETRY_MS||!Modules.has('embedded:io/i2c'))return;tofAloneTriedAt=now;tofOpen();return;
    }
    tofReading(tof.poll(),now);
  };
  // Every new distance, with the rover on or not (code check, 19 Nov 2026: with the rover on the Force effect was
  // deaf): the Force effect, and the log when the distance changes by 2 cm or more.
  const tofReading=(r,now)=>{
    if(!r)return;
    forceFollowTurn(r,now);
    // The sensor turns with the head and travels with the rover: while either moves, and until the head has settled,
    // what it sees moving is the room, not a hand (21 Nov 2026, «come mai fa la faccia spaventata ogni tanto»: the
    // false pushes came with the head turning). Neither the Force nor the wave then, and they start again from fresh.
    // The Force's «Aaah!» waits a moment: not if the robot is being picked up (force.js forceSoundNow).
    if(forcePush.soundAt!==undefined){const said=forceSoundNow(forcePush.soundAt,now,sense);if(said!=='wait'){forcePush.soundAt=undefined;if(said==='play'&&!voice?.active&&!speaking)playSound(FORCE_SOUND);else if(typeof trace==='function')trace(`[robottino] force sound ${said==='play'?'skipped: busy':'dropped: handled'}\n`);}}
    if(explore.walk.active||explore.wanted!==undefined||posePending||!headSettled()||rover?.moving){forcePush.reset();waveWatch.reset();}
    else{const push=forcePush.feed(r,now);
    // Not a hand (23 Nov 2026, owner: «ogni tanto parte il verso… anche se non ho messo la mano»): with the head
    // following him, the sensor has the owner in front, and leaning in reads like a push (58 to 16 cm in half a second).
    // A hand pushing in front of the robot hides the K210's view; a face the K210 sees at that moment is his own.
    // Since 23 Nov 2026, 20:55, only a face that has grown in the K210's picture (FORCE.leanGrow, within the last
    // FORCE.leanMs): leaning in brings the face closer; a hand pushed next to it does not («force push 1108 mm/s to
    // 93 mm ignored: a face in sight», his real Force). A face just come into sight, with nothing to compare, still counts.
    const seenFace=k210?.face();
    if(seenFace&&Number.isFinite(seenFace.w)){faceSizes.push({at:now,w:seenFace.w});while(faceSizes.length&&now-faceSizes[0].at>FORCE.leanMs)faceSizes.shift();}
    const leaning=seenFace&&(()=>{const before=faceSizes.find(f=>now-f.at>=FORCE.leanMs/3);return !before||seenFace.w>=before.w*FORCE.leanGrow;})();
    if(push&&leaning){if(typeof trace==='function')trace(`[robottino] force push ${push.speed} mm/s to ${push.mm} mm ignored: a face in sight, closer\n`);waveWatch.reset();}
    // A hand shown slowly to the iPhone's gestures (force.js FORCE.videoSpeed; push.speed is in mm/s).
    else if(push&&live?.videoOn&&push.speed<FORCE.videoSpeed*1000){if(typeof trace==='function')trace(`[robottino] force push ${push.speed} mm/s to ${push.mm} mm ignored: a hand shown to the iPhone\n`);waveWatch.reset();}
    else if(push){forceRecoil(push,now);waveWatch.reset();}
    // «Saluto» (force.js WaveWatch), only with the head still for WAVE.stillMs: looking around, the head stops 1.6 s at
    // each place, long enough for an edge of something to read like a waving hand (21 Nov 2026: 5 hellos to nobody).
    else if(now-headMove.start<WAVE.stillMs||sense&&(sense.state!=='down'||now-sense.handledAt<K.HANDLED_MS))waveWatch.reset(); // nor in the hands
    else{const wave=waveWatch.feed(r,now);if(wave){if(typeof trace==='function')trace(`[robottino] wave seen by the distance sensor, shaking ${wave.shake} mm, two apart ${wave.lag2} mm: ${waveWatch.last}\n`);waveHello(now);}}}
    const mm=r.valid||r.near?r.mm:0;
    if(tofLogged===undefined||(Math.abs(mm-tofLogged)>=20&&now-tofLoggedAt>=200)){
      tofLogged=mm;tofLoggedAt=now;if(typeof trace==='function')trace(`[robottino] tof ${r.valid?r.mm+' mm':r.near?`still close, ${r.mm} mm kept (${r.raw})`:'nothing in range ('+r.mm+')'}\n`);
    }
  };
  // «Effetto Forza» (force.js; owner, 19 Nov 2026: «proviamo effetto forza»): a hand pushed quickly toward the distance
  // sensor throws the head back with the scared face, then the head comes home. In a conversation too (owner, 19 Nov
  // 2026: «fallo funzionare anche in conversazione»): the scared face lasts its 2 s even while Robottino speaks
  // (forceFaceUntil), then the conversation's own face comes back; a reply's gesture under way wins. The head moves
  // as a local gesture, with all its checks (motions on, calibration, iPhone not driving, no phrase being said): when
  // one is refused only the face reacts. Face following waits a moment, or it would turn the head straight back.
  const forcePush=new ForcePush(),waveWatch=new WaveWatch(),faceSizes=[];let forceFaceUntil;
  // A wave, seen by the iPhone in the robot's video or by the distance sensor (owner, 19 Nov 2026: «fai riconoscere il
  // saluto, deve salutare con "ciao eccomi"»): a smile and «Ciao, eccomi!» (the wake-up's recording, only when a sound
  // may be played: in a conversation the smile alone). Asleep, it wakes the robot as a voice does. The same wave from
  // the two within HAND_SAME_MS is one.
  const waveHello=now=>{
    if(closed)return false;
    if(handGesture?.name==='wave'&&now-handGesture.at<K.HAND_SAME_MS)return true;
    if(asleep)try{live?.selfWake?.(0);}catch{}
    robot.face.setEmotion(3);faceAngry=false;faceHoldUntil=now+K.FACE_HOLD_MS;
    if(!voice?.active&&!speaking)sayRecorded(WAKE_HELLO,PHRASE_MOUTHS[WAKE_HELLO]);
    handGesture={name:'wave',at:now};try{face.behavior.setHand?.(face,'wave');}catch{}return true;
  };
  const forceRecoil=(push,now)=>{
    if(closed||explore.walk.active||explore.wanted!==undefined)return;
    if(typeof trace==='function')trace(`[robottino] force push ${push.speed} mm/s to ${push.mm} mm, head back ${push.deg} deg\n`);
    if(asleep)try{live?.selfWake?.(0);}catch{}
    robot.face.setEmotion(SCARED);faceAngry=false;faceHoldUntil=forceFaceUntil=now+2000; // no «La forza!!!» on the screen (owner, 19 Nov 2026: «togli messaggio la forza»)
    // With a scared «Aaah!» (owner, 21 Nov 2026), when a sound may be played (never in a conversation, never over another
    // sound). playSound, not sayRecorded: a phrase with a moving mouth would hold the head, and the head must recoil.
    // Not at once since 23 Nov 2026: picked up, the robot read the hands as a push (force.js FORCE_SOUND_WAIT).
    forcePush.soundAt=now;try{face.behavior.setHand?.(face,'palm');}catch{} // the open hand in the corner (owner's «mano-aperta-forza»)
    if(followingFace()){followPausedUntil=Math.max(followPausedUntil,now+2500);tracker.clearTarget();}
    forceFollowStart(push.mm,now); // before the head's gesture: the gesture would hold the rover's own moves
    gesture(forceSteps(push.deg));
  };
  // With the rover: the Force follows the hand (force-follow.js; owner, 23 Nov 2026: «una volta che si aggancia, deve poi
  // seguire la mia mano… avanti e indietro, destra e sinistra»). Before, 19 Nov 2026, the rover only went back while
  // the hand stayed close, 3 s at most. Every move is short (FORCE_FOLLOW.stepMs) and renewed while it lasts; the rover
  // stops by itself when nothing renews it. The head stays still meanwhile (the sensor turns with it). The iPhone is told
  // (status forceFollow) so that it sends where the hand is across the picture (command hand).
  const forceFollow=new ForceFollow();
  // The robot's own gestures (remoteDance.quiet: the Force's recoil itself) are not the iPhone driving: with the app
  // connected they used to end the Force at once («not allowed», found in the tests of 23 Nov 2026).
  const forceAllowed=()=>tracker.enabled&&!motionFault&&!calibrating&&!dance.active&&!(remoteActive&&(cameraFollow||clock.now()<remoteHoldUntil||remoteDance&&!remoteDance.quiet))&&!touchMotion;
  const forceFollowEnd=(now,why)=>{
    if(!forceFollow.active&&why!=='hand gone'&&why!=='time limit')return;forceFollow.stop();roverHoldUntil=Math.max(roverHoldUntil,now+1000);
    let stopped=false;try{stopped=roverMove('stop')==='ok';}catch{}
    if(typeof trace==='function')trace(`[robottino] force follow ends: ${why}${stopped?'':', stop not confirmed'}\n`);
    try{live?.hello?.();}catch{}
  };
  const forceFollowStart=(mm,now)=>{
    if(rover?.state!=='ready'||forceFollow.active||!forceAllowed())return;
    forceFollow.start(mm,now);if(typeof trace==='function')trace(`[robottino] force follow starts at ${mm} mm\n`);
    try{live?.hello?.();}catch{}
    forceFollowTurn({mm,valid:true},now);
  };
  const forceFollowTurn=(r,now)=>{
    if(!forceFollow.active)return;
    if(closed||rover?.state!=='ready'||!forceAllowed()){forceFollowEnd(now,'not allowed');return;}
    if(roverUnsafe()||!roverBody.free(now)){forceFollowEnd(now,'lifted');return;}
    followPausedUntil=Math.max(followPausedUntil,now+1000);
    const step=forceFollow.feed(forceMm(r),now);if(!step)return;
    if(step.end){forceFollowEnd(now,step.end);return;}
    // Forward needs a fresh reading with the head still (roverForwardReady): while the head is still coming back from
    // the push, the rover only waits (or slides), it does not let go of the hand.
    if(step.y>0&&!roverForwardReady(now))step.y=0;
    if(!step.x&&!step.y){if(roverMove('stop')!=='ok')forceFollowEnd(now,'rover_error');return;}
    if(!rover.move({x:step.x,y:step.y},FORCE_FOLLOW.stepMs)){forceFollowEnd(now,'rover_error');return;}
    roverBegan(now,FORCE_FOLLOW.stepMs,true);roverFollow.release(); // true: the camera keeps looking (the iPhone needs the hand in the picture)
    roverHoldUntil=Math.max(roverHoldUntil,now+FORCE_FOLLOW.stepMs+1000);
    if(typeof trace==='function')trace(`[robottino] force follow ${step.y>0?'forward':step.y<0?'back':''}${step.x?(step.x>0?' right':' left'):''} x ${step.x} y ${step.y}\n`);
  };
  // «Esplora» (explore.js; owner, 23 Nov 2026: «esplora la stanza e il robot con il rover deve girare e riconoscere gli
  // oggetti e pronunciare quello che vede», started by voice or by the iPhone's «Esplora» in Studio). With the rover
  // and the distance sensor (never forward blind: roverMove refuses with something in front) it goes round the room;
  // without them, or held in the hand, it stands still and the owner carries it (the same evening: «permetti la prova
  // dell'esplorazione anche senza il rover. Muovo io il robot, inquadro degli oggetti»). It needs a conversation,
  // which says what each picture shows (src/voice-stream.ts, robot-vision.ts EXPLORE_INSTRUCTIONS): from the iPhone
  // with no conversation going, one is opened first (wanted: when it was asked; up to 15 s for it to be ready).
  const explore={walk:new Explore(),wanted:undefined,view:undefined,announced:false, // wanted: when it was asked (a clock at 0 is a time too)
    start(why,now=clock.now()){
      if(closed||explore.walk.active)return explore.walk.active;
      face.behavior.clearHand?.(face);
      if(!voice?.active||!voiceReady){explore.wanted=now;if(!voice?.active)toggleVoice();return true;}
      const still=rover?.state!=='ready'||tof?.state!=='ready'||roverUnsafe();
      explore.wanted=undefined;explore.walk.start(now,still);explore.announced=true;if(typeof trace==='function')trace(`[robottino] explore starts (${why}${still?', still: carried by hand':''})\n`);
      try{voice.explore?.(true,why!=='voice',still);}catch{}
      if(tracker.enabled)try{tracker.lookAt(0,-.17,now);}catch{} // straight ahead, a little up: the room, not the desk
      live?.hello?.();return true;
    },
    end(why,now=clock.now()){
      const was=explore.announced||explore.walk.active||explore.wanted!==undefined;explore.announced=false;explore.wanted=undefined;if(!was)return;
      const moved=!explore.walk.still;explore.view=undefined;explore.walk.stop();if(moved)try{roverMove('stop');}catch{}roverHoldUntil=Math.max(roverHoldUntil,now+1000);
      try{voice?.explore?.(false,why!=='iphone'&&why!=='voice'&&why!=='conversation ended',false,why);}catch{}
      if(why==='iphone'||why==='voice')try{voice?.stop();}catch{}
      if(typeof trace==='function')trace(`[robottino] explore ends: ${why}\n`);live?.hello?.();
    },
    turn(now){
      if(explore.wanted!==undefined&&!explore.walk.active){if(voice?.active&&voiceReady)explore.start('iphone',now);else if(now-explore.wanted>15000){explore.wanted=undefined;say('Esplora: la conversazione non è partita.');live?.hello?.();}return;}
      if(!explore.walk.active)return;
      if(!voice?.active){explore.end('conversation ended',now);return;}
      if(!explore.walk.still&&(rover?.state!=='ready'||roverUnsafe())){explore.end(rover?.state!=='ready'?'no rover':'lifted',now);return;}
      followPausedUntil=Math.max(followPausedUntil,now+1000);
      if(explore.view){
        const view=explore.view;
        if(now-explore.walk.from>=explore.walk.limits.limitMs){explore.end('finished',now);return;}
        if(view.started&&!view.ready&&now-view.startedAt>4000){explore.end('head timeout',now);return;}
        if(!tracker.enabled||motionFault||calibrating){explore.end('head unavailable',now);return;}
        if(!view.started){
          if(posePending||headMoving()||!headQuiet()||voice.speaking)return;
          if(roverMove('stop')!=='ok'){explore.end('rover stop failed',now);return;}
          view.started=true;view.startedAt=now;view.token={};pendingPose=view.token;posePending=true;poseConfirmed=false;poseStarted=now;
          tracker.clearTarget();
          const rotation=reachable({y:0,p:view.pitch,r:0},headCal);
          void soon(()=>{if(closed||explore.view!==view||!explore.walk.active||pendingPose!==view.token||motionFault||!tracker.enabled)return;return setHeadPose(rotation);})
            .then(()=>{if(!closed&&explore.view===view&&explore.walk.active&&pendingPose===view.token){tracker.yaw=rotation.y;tracker.pitch=rotation.p;view.ready=true;}})
            .catch(error=>{if(!closed&&explore.view===view){failMotion('Errore scansione verticale: movimenti bloccati.',error);explore.end('head error');}})
            .finally(()=>{if(pendingPose===view.token){pendingPose=undefined;posePending=false;}});
          return;
        }
        if(!view.ready||posePending||!headSettled()||!wheelsStill()||voice.speaking)return;
        if(view.home&&!roverForwardReady(now)){view.waitSensorAt??=now;if(now-view.waitSensorAt>2000)explore.end('obstacle_sensor',now);return;}
        explore.view=undefined;
        if(view.home){explore.walk.until+=now-view.at;explore.walk.lastMove=undefined;}
        else{explore.walk.lookFrom=now;explore.picture();}
        return;
      }
      const step=explore.walk.step(now,{speaking:!!voice.speaking});if(!step)return;
      if(step.end){explore.end(step.end,now);return;}
      if(step.look){
        if(explore.walk.still)explore.picture();
        else explore.view={pitch:explore.walk.pitch,at:now,started:false,ready:false};
        return;
      }
      if(step.move==='forward'&&!roverForwardReady(now)){
        explore.view={pitch:0,at:now,started:false,ready:false,home:true};return;
      }
      let result=roverMove(step.move,step.ms);
      if(result==='obstacle'||result==='obstacle_sensor'){if(typeof trace==='function')trace('[robottino] explore: something in front\n');const away=explore.walk.blocked(now);result=away?roverMove(away.move,away.ms):'ok';}
      if(result!=='ok')explore.end(result,now);
    },
    picture(){
      if(!explore.walk.active||typeof live?.snapshot!=='function')return;
      const call=voice,round=explore.walk.from;
      try{call.look?.('start');}catch{}
      void live.snapshot(piece=>{
        if(closed||!explore.walk.active||explore.walk.from!==round||voice!==call)throw Error('explore_cancelled');
        return call.picture(piece);
      }).then(ok=>{if(!closed&&explore.walk.active&&explore.walk.from===round&&voice===call){if(typeof trace==='function')trace(`[robottino] explore look ${ok?'sent':'failed'}\n`);try{call.look?.(ok?'sent':'end');}catch{}}},()=>{try{call?.look?.('end');}catch{}});
    }};
  const climateNow=()=>climate?.state==='ready'&&climate.last?{t:Math.round(climate.last.t*10)/10,h:Math.round(climate.last.h),...(climate.last.p?{p:Math.round(climate.last.p)}:{})}:undefined;
  // Presence sensor (presence.js; owner, 15 Nov 2026: «attivazione se in standby con sensore AS312»): M5Stack's PIR unit
  // on Port B, signal on G8. While the robot sleeps a movement wakes it, as a voice does. Read with the pull-down: with
  // no unit plugged in it reads 0. Off with the preference pir false.
  let pir;const presence=new Presence();
  try{
    if(Preference.get('robottino','pir')!==false&&Modules.has('embedded:io/digital')){
      const found=Modules.importNow('embedded:io/digital'),line=createPir({Digital:found?.default??found,log:text=>{if(typeof trace==='function')trace(text);}});
      if(line.open())pir=line;
    }
  }catch{pir=undefined;}
  const presenceTurn=now=>{
    if(!pir||closed)return;
    // Who is in the room (23 Nov 2026): the last movement felt; nobody after K.NOBODY_MS without one (selfFollowWanted).
    // The first movement after a quiet half minute is on the log, to see the sensor work.
    const level=pir.read();presence.movedAt??=now;
    if(level){if(!(now-presence.movedAt<30000)&&typeof trace==='function')trace('[robottino] presence: movement\n');presence.movedAt=now;}
    // Only once the sensor has felt someone since the start: a unit unplugged or broken reads 0 for ever.
    if(level)presence.felt=true;
    const nobody=!!presence.felt&&now-presence.movedAt>=K.NOBODY_MS;
    if(nobody!==presence.nobody){presence.nobody=nobody;if(typeof trace==='function')trace(`[robottino] presence: ${nobody?'nobody for '+Math.round(K.NOBODY_MS/60000)+' min, faces not followed':'someone again, faces followed'}\n`);}
    if(!presence.tick(now,{level,asleepMs:asleep&&asleepSince!==undefined?now-asleepSince:undefined}))return;
    if(typeof trace==='function')trace('[robottino] presence: someone moved, waking\n');
    // As for a voice: the microphones close first, then the look around starts again (no side known).
    earClose();
    try{live?.selfWake?.(0);}catch{}
    if(roverFollowing)roverFollow.toward(0); // following with the rover: the body starts looking at once
  };
  const roverAllowed=()=>tracker.enabled&&!motionFault&&!calibrating&&!dance.active&&!remoteDance&&!remoteDriving()&&!touchMotion;
  // The body may go looking for a face it does not see (rover-follow.js search; owner, 15 Nov 2026: «se non mi vede il
  // rover deve girarsi finché non mi vede»): following on, the camera looking, awake (after 30 s with nobody the robot
  // sleeps and the wheels rest with it; a voice wakes both), and not in a conversation (the wheels over the voice).
  // «Mano aperta = fermati» (hand gestures, below): the rover's own moves wait until then.
  let roverHoldUntil=0;
  const roverMaySearch=()=>clock.now()>=roverHoldUntil&&roverFollowing&&tof?.state==='ready'&&rover?.state==='ready'&&!!live?.selfActive&&!asleep&&!voice?.active&&!wake;
  // For the camera (live-device.js): while the wheels turn the body, and a quarter of a second after, the picture moves.
  const wheelsStill=()=>(!rover?.moving||roverLook)&&clock.now()>=roverBlurUntil;
  // The distance sensor stopped answering while following is on (a read failed: tof-wire.js goes to «error»): said
  // once, the iPhone is told, and the sensor is looked for again every TOF_RETRY_MS, in a quiet moment.
  let tofLost=false,tofRetryAt=0;
  let handGesture,sightSaid;
  const roverTurn=now=>{
    // A failed write left the rover off (rover-wire.js): looked for again now and then. Opening it writes the stop
    // first, and only an answered stop makes it ready: also the best way to stop wheels whose stop is still owed.
    if(rover.state==='error'){
      if(!rover.errorSaid){rover.errorSaid=true;rover.retryAt=now+K.ROVER_RETRY_MS;say('Rover: non risponde, riprovo tra poco.');live?.hello?.();}
      else if(now>=rover.retryAt&&!posePending&&headQuiet()){rover.retryAt=now+K.ROVER_RETRY_MS;if(rover.open()){rover.errorSaid=false;say('Rover: di nuovo collegato.');live?.hello?.();}}
      return;
    }
    // The distance sensor is read at every turn while the rover is on (obstacles), not only when following.
    if(tof?.state==='ready')tofReading(tof.poll(),now);
    // Not found when the rover was switched on (a loose cable): looked for again now and then, in a quiet moment
    // (code review, 19 Nov 2026: it was never looked for again until a restart).
    else if(!tofWas&&!rover.moving&&!posePending&&now-tofAloneTriedAt>=K.TOF_ALONE_RETRY_MS){tofAloneTriedAt=now;if(tofOpen()){say('Rover: sensore di ostacoli trovato.');live?.hello?.();}}
    const following=roverFollowing&&tof?.state==='ready';
    if(tofWas&&tof?.state!=='ready'&&rover.state==='ready'){
      if(!tofLost){tofLost=true;tofRetryAt=now+K.TOF_RETRY_MS;if(typeof trace==='function')trace('[robottino] rover: distance sensor lost\n');say(roverFollowing?'Inseguimento: il sensore di distanza non risponde più.':'Rover: il sensore di distanza non risponde più.');live?.hello?.();}
      else if(now>=tofRetryAt&&!rover.moving&&!posePending&&headQuiet()){
        tofRetryAt=now+K.TOF_RETRY_MS;tofClose();
        if(tofOpen()){tofLost=false;say(roverFollowing?'Inseguimento con rover: di nuovo attivo.':'Rover: sensore di distanza di nuovo attivo.');live?.hello?.();}
      }
    }
    // An obstacle appears while the rover goes forward (voice, iPhone or following): stopped at once.
    // Exploring, the head that leaves straight (or a reading no longer fresh) stops the wheels at once; the other
    // forward moves are short and renewed only with a fresh reading (roverMove, rover-wire.js allowForward).
    if(rover.advancing&&explore.walk.active&&!roverForwardReady(now)){
      rover.stop();roverHalted(now);roverCut='head_not_level';return;
    }
    if(rover.advancing&&obstacleAhead(tof?.last,now)){
      const stopped=rover.stop();roverHalted(now);roverCut='obstacle';
      if(typeof trace==='function')trace(`[robottino] rover stopped: obstacle at ${tof.last.mm} mm${stopped?'':' (stop failed)'}\n`);
      say('Rover: ostacolo davanti, mi fermo.');return;
    }
    const action=roverBody.tick(now,{ready:rover.state==='ready',moving:rover.moving,unsafe:roverUnsafe(),
      allowed:roverAllowed()&&!following&&!forceFollow.active&&!explore.walk.active, // the rover following the hand after a Force push: no turns of its own
      following:!!live?.selfActive&&live.selfSeenMs<500,yaw:tracker.yaw});
    if(action?.stop){const stopped=rover.stop();roverCut='lifted';if(typeof trace==='function')trace(`[robottino] rover stopped: lifted${stopped?'':' (stop failed)'}\n`);return;}
    if(action){if(rover.move({z:action.z},action.ms)){roverBegan(now,action.ms);roverFollow.release();if(typeof trace==='function')trace(`[robottino] rover turn ${action.why} ${action.z>0?'right':'left'} ${action.ms} ms\n`);}return;}
    if(!following||explore.walk.active||now<roverHoldUntil)return; // exploring drives the wheels by itself
    if(!roverBody.free(now))return;
    const step=roverFollow.tick(now,{ready:rover.state==='ready',moving:rover.moving,unsafe:roverUnsafe(),allowed:roverAllowed(),
      seenMs:live?.selfActive?live.selfSeenMs:Infinity,yaw:tracker.yaw,distance:tof.last,search:roverMaySearch(),gone:live?.selfSide??0,still:!posePending&&!headMoving(),spin:roverSpin(now)});
    // The body has turned toward the face: the head turns back by as much (rover-follow.js `head`), so that the face is
    // in the middle of the picture again, and what the camera remembers of where the face was (live-device.js) moves
    // with it. Only where following may move the head now (as the hook `look`).
    const headBack=by=>{if(by&&!poweringOff()&&followingFace()&&now>=followPausedUntil&&!asleep&&tracker.lookAt(tracker.yaw+by,tracker.pitch,now))live?.selfTurned?.(by);};
    if(step?.stop){
      rover.stop();roverHalted(now);headBack(step.head);
      // For the first trial on the real rover: how far a turn really went and in how long gives FOLLOW.turnRate.
      if(step.why&&typeof trace==='function')trace(step.why==='turned'?`[robottino] rover follow turned ${Math.round(step.turned*180/Math.PI)} deg in ${step.ms} ms ${step.measured?'measured':'reckoned'}\n`:`[robottino] rover follow stopped: ${step.why} ${tof.last?.mm??'-'} mm\n`);
      return;
    }
    if(step&&rover.move({x:step.x,y:step.y,z:step.z},step.ms)){
      roverBegan(now,step.ms,step.look===true);
      // A move renewed every half second is one line on the log, not one for each renewal.
      if(!step.more&&typeof trace==='function')trace(`[robottino] rover follow ${step.why} ${tof.last?.mm??'-'} mm ${step.ms} ms${step.y?' at '+step.y:''}\n`);
    }
  };
  let arming=false,motionRevision=0,motionFault=false,pendingPose,poseStarted=0,armingStarted=0;
  let remoteDance;
  const reminders=new Reminders();let alertUntil;
  // Reminders at a clock time (reminders.js ClockReminders), set by the agent's tool; saved, so a restart keeps them.
  let clockReminders;try{clockReminders=new ClockReminders(Preference.get('robottino','clockReminders'));}catch{clockReminders=new ClockReminders();}
  const saveClockReminders=()=>{try{Preference.set('robottino','clockReminders',clockReminders.save());}catch(error){if(typeof trace==='function')trace(`[robottino] reminders not saved: ${error}\n`);}};
  // Spoken face commands (owner, 11 Nov 2026): the face goes back to normal after 5 s.
  let faceHoldUntil,faceAngry=false; // faceAngry: the angry face is on (head lights)
  const showExpression=name=>{
    robot.face.setEyeOpen('left',name==='blink'?0:1);robot.face.setEyeOpen('right',name==='blink'?0:1);
    robot.face.setMouthOpen(name==='talk-open'?.8:name==='talk-small'?.3:0);robot.face.setEmotion(name==='happy'?3:name==='sad'?2:0);
  };
  const stopDance=()=>{if(remoteDance){const quiet=remoteDance.quiet;remoteDance=undefined;if(!quiet)showExpression('neutral');}dance.stop();tracker.clearTarget();face.behavior.setDanceActive(false);};
  const failMotion=(message,error)=>{calDiag('fail:'+message.slice(0,22)+(error===undefined?'':':'+String(error?.message??error).slice(0,40)));touchMotion=undefined;cameraFollow=false;pendingPose=undefined;posePending=false;motionFault=true;motionRevision++;arming=false;stopDance();tracker.stop();say(message);lightError();};
  const canTouchMove=()=>!closed&&!poweringOff()&&!speaking&&!remoteDriving()&&!dance.active&&tracker.enabled&&!motionFault&&!posePending&&Preference.get('robottino','verified')===true&&Preference.get('robottino','calibrated')===true;
  const touchPose=(rotation,after)=>{
    const token={};pendingPose=token;posePending=true;poseConfirmed=false;poseStarted=clock.now();
    if(!Number.isFinite(poseStarted)){failMotion('Temporizzazione non valida: movimenti bloccati.');return;}
    void soon(()=>{if(closed||pendingPose!==token)return;return setHeadPose(rotation);})
      .then(()=>{if(!closed&&pendingPose===token&&touchMotion){tracker.yaw=rotation.y;tracker.pitch=rotation.p;after();}})
      .catch(error=>{if(!closed&&pendingPose===token)failMotion('Errore del movimento: nuovi movimenti bloccati.',error);})
      .finally(()=>{if(pendingPose===token){pendingPose=undefined;posePending=false;}});
  };
  const onPet=()=>{
    // Around straight ahead or around where the head starts (20° up): a caress lifts the head a little toward the hand.
    if(!canTouchMove()||touchMotion||Math.abs(tracker.yaw)>.12||tracker.pitch>.12||tracker.pitch<START_PITCH-.12)return;
    const now=clock.now();if(!Number.isFinite(now))return;
    const origin={y:tracker.yaw,p:tracker.pitch,r:0};
    const target={y:origin.y,p:Math.max(START_PITCH-.15,Math.min(.15,origin.p-.04)),r:0};
    touchMotion={origin,restoreAt:now+3000};tracker.clearTarget();touchPose(target,()=>{});
  };
  // Small local head gestures (reply mood, alerts, idle glances): same limits and checks as dances. They start a
  // moment later: the face is redrawn and the sound starts first (10 Nov 2026).
  
  
  // TEMPORARY diagnostics (11 Nov 2026): why a gesture was refused, on the USB log.
  // A spoken head command (`voice`) also goes while the iPhone is connected (owner, 11 Nov 2026: «Sì, anche nel Live»);
  // every other local gesture still waits for the iPhone to let go.
  const gestureBlock=(voice=false)=>closed?'closed':poweringOff()?'power':speaking?'phrase':remoteDriving()&&!voice?'remote':!tracker.enabled?'motors_off':motionFault?'fault':posePending?'pose_pending':dance.active?'dance':remoteDance&&!(voice&&remoteDance.quiet&&!remoteDance.voice)?'gesture':touchMotion?'touch':Preference.get('robottino','verified')!==true?'unverified':Preference.get('robottino','calibrated')!==true?'uncalibrated':'';
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
    remoteDance={steps:steps.map(step=>({...step,yaw:step.yaw+base.y,pitch:Math.min(0,step.pitch+base.p)})),index:-1,nextAt:now+K.GESTURE_DELAY_MS,quiet:true,voice,origin:base};return true;
  };
  // Spoken head commands (voice-wire.js headCommand, owner 11 Nov 2026): one step of VOICE_TURN° from where the head
  // is, or back to straight ahead. Right and left are the user's, facing the robot (owner, 11 Nov 2026: «destra e
  // sinistra sono invertite»): «a destra» is positive yaw, the robot's own left. The step goes as a local gesture: the same checks, limits and calibration as every pose.
  // A side always ends on that side of straight ahead (11 Nov 2026: with the head 20° to the right, «sinistra» only
  // brought it back to the middle and had to be said twice): at least VOICE_TURN° that way, or one step more.
  let followPausedUntil=0;
  // full («tutto a destra»): as far as the head goes; setHeadPose stops it at the calibrated end of the range.
  // A pose already on its way (following a face sends one every few hundred ms) only delays a spoken command: it
  // waits for that pose, up to VOICE_WAIT_MS, then goes (voiceRetry, in the loop).
  let voiceRetry,lookRefused=0;
  const voiceLook=(direction,full=false,until)=>{
    if(followingFace())followPausedUntil=Math.max(followPausedUntil,clock.now()+K.FOLLOW_PAUSE_MS);
    if(posePending&&!gestureBlock(true).replace('pose_pending','')){
      const now=clock.now();until??=now+K.VOICE_WAIT_MS;
      if(now<until){voiceRetry={direction,full,until};return true;}
    }
    if(direction==='shake')return gesture(GESTURES.shake,true);
    const base=restPose();
    const target=direction==='center'?{y:0,p:0}:full?{y:direction==='right'?90:direction==='left'?-90:base.y,p:direction==='up'?-85:direction==='down'?0:base.p}:{y:Math.max(-80,Math.min(80,direction==='right'?Math.max(base.y+K.VOICE_TURN,K.VOICE_TURN):direction==='left'?Math.min(base.y-K.VOICE_TURN,-K.VOICE_TURN):base.y)),p:Math.max(-80,Math.min(0,base.p+(direction==='up'?-K.VOICE_TURN:direction==='down'?K.VOICE_TURN:0)))};
    // TEMPORARY diagnostics (11 Nov 2026, «non sente in su»): where the head was asked to go, on the USB log only.
    if(typeof trace==='function')trace(`[robottino] look ${direction} ${Math.round(base.y)},${Math.round(base.p)} -> ${Math.round(target.y)},${Math.round(target.p)}\n`);
    const moved=gesture([{yaw:target.y-base.y,pitch:target.p-base.p,durationMs:K.VOICE_STEP_MS}],true);
    // Following a face, the head would turn straight back to it: following waits FOLLOW_PAUSE_MS from the command
    // (set above, so no new following pose starts meanwhile), then starts again from where the head now is.
    if(moved&&followingFace()){followPausedUntil=clock.now()+K.FOLLOW_PAUSE_MS;tracker.clearTarget();}
    return moved;
  };
  // The white robot's happy frame has an open mouth: in a silent mood it keeps its closed smile (neutral).
  // Angry (emotion 1) comes only from a voice tag of the reply ([angry]: src/robot-tools.ts), for that reply.
  const setMood=expression=>robot.face.setEmotion(expression==='happy'&&face.behavior.getStyle?.()!=='white'?3:expression==='sad'?2:expression==='angry'?1:0);
  const alert=(text,expression='happy',steps=GESTURES.nod,sound='avviso.bin')=>{
    say(text);setMood(expression);alertUntil=clock.now()+5000;if(sound)playSound(sound);gesture(steps);
  };
  // Claude Code hooks reach the robot as fixed reactions (no free text from the network).
  const reactions={
    attention:()=>{alert('Claude Code ti chiede un permesso.','neutral',GESTURES.tilt);lightReminder();},
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
  // robotQuiet: the camera, the network and the conversation's audio are not in the middle of a change; the head
  // sensor's touches are judged by this alone (a touch counts also while the robot listens asleep or says a phrase).
  const robotQuiet=()=>!(live?.busy?.()||socketModule?.connecting?.()||voice?.busy?.());
  // Nor while Robottino says one of its recorded phrases for being lifted, shaken or fallen (speaking; owner, 14 Nov
  // 2026: «blocca temporaneamente i movimenti quando pronuncia le frasi di sollevamento, di scuotimento, eccetera»).
  // The microphones of «guardalo e parla» do not hold the head (what they hear while it moves is not listened to).
  const headQuiet=()=>!(speaking||(ear&&earMode!=='look')||live?.busy?.()||socketModule?.connecting?.()||voice?.busy?.());
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
  // The agent's tools (src/robot-tools.ts, voice-device.js 'tool'), 14 Nov 2026: the same paths as the spoken commands
  // (voiceLook, gesture with the voice's rights, the faces, the photo, the timers), with an answer that says whether the
  // robot really did it: a move is «done» only when its steps have gone through with no motion fault.
  // The robot still recognises the spoken commands by itself, at once: the same command from the agent within
  // TOOL_SAME_MS is that one, and is answered without doing it twice.
  let spoken;
  // result: how it went ('ok' or the refusal's code), so that the agent's tool for the same thing says the same.
  const spokenNow=(key,result='ok')=>{spoken={key,at:clock.now(),result};};
  const spokenAgain=key=>spoken?.key===key&&clock.now()-spoken.at<K.TOOL_SAME_MS;
  const refusal=()=>{const why=gestureBlock(true);return why==='motors_off'?(Preference.get('robottino','calibrated')!==true?'unverified':'motors_off'):['closed','power','phrase','fault'].includes(why)?why:'moving';};
  const motionDone=limit=>new Promise(resolve=>{
    const until=clock.now()+limit,refused=lookRefused,started=remoteDance;
    const check=()=>{
      if(closed)return resolve({ok:false,code:'closed'});
      if(motionFault)return resolve({ok:false,code:'fault'});
      if(lookRefused!==refused)return resolve({ok:false,code:'moving'});
      if(!voiceRetry&&!posePending&&(!remoteDance||remoteDance!==started&&!remoteDance.voice))return resolve({ok:true});
      if(clock.now()>=until)return resolve({ok:false,code:'timeout'});
      Timer.set(check,50);
    };
    Timer.set(check,50);
  });
  const toolDone=(command)=>{
    if(closed)return {ok:false,code:'closed'};
    switch(command.tool){
      case 'head':{
        // Already said by the user: as it went (a move still waiting for its pose is waited for).
        if(spokenAgain('head:'+command.direction))return spoken.result==='ok'?motionDone(5000):{ok:false,code:spoken.result};
        if(command.direction==='nod'){if(!gesture(GESTURES.nod,true))return {ok:false,code:refusal()};return motionDone(4000);}
        if(!voiceLook(command.direction,command.full))return {ok:false,code:refusal()};
        return motionDone(5000);
      }
      case 'rover':{
        // Asked by the voice (agent tool muovi_rover): done only once the robot has stopped the wheels again.
        if(remoteDriving()&&command.move!=='stop')return {ok:false,code:'remote'};
        // Already done from the user's own words (voiceHooks.rover): not twice.
        if(spokenAgain('rover:'+command.move))return spoken.result==='ok'?{ok:true}:{ok:false,code:spoken.result};
        const result=roverMove(command.move,command.ms);
        if(result!=='ok')return {ok:false,code:result};
        if(command.move==='stop'||Object.hasOwn(GRIP_MOVES,command.move))return {ok:true};
        // Cut short by the robot (an obstacle, lifted): not «done» (code review, 19 Nov 2026).
        return new Promise(resolve=>Timer.set(()=>resolve(!(rover?.state==='ready'&&!rover.moving)?{ok:false,code:'rover_error'}:roverCut==='obstacle'?{ok:false,code:'stopped_obstacle'}:roverCut==='lifted'?{ok:false,code:'lifted'}:{ok:true}),command.ms+150));
      }
      case 'face':
        if(!spokenAgain('face:'+command.expression))voiceHooks.face(command);
        return {ok:true};
      case 'dance':
        if(!gesture(GESTURES.dance,true))return {ok:false,code:refusal()};
        return motionDone(8000);
      case 'see':
        if(spokenAgain('see'))return {ok:true};
        if(typeof live?.snapshot!=='function')return {ok:false,code:'camera'};
        voiceHooks.see();return {ok:true};
      case 'timer':{
        if(command.action==='set'&&spokenAgain('timer'))return spoken.result==='ok'?{ok:true,text:'Fatto.'}:{ok:false,code:spoken.result};
        const before=reminders.items.length,line=reminders.apply(command,clock.now());
        if(line)say(line);
        return {ok:command.action!=='set'||reminders.items.length>before,code:'full',text:line??''};
      }
      case 'reminder':{
        if(command.action==='cancel'){const removed=clockReminders.cancel(command.at);if(removed)saveClockReminders();return removed?{ok:true}:{ok:false,code:'missing'};}
        const result=clockReminders.add(command.at,command.text,Date.now());
        if(result!=='ok')return {ok:false,code:result==='past'?'clock':result};
        saveClockReminders();say('Promemoria salvato: '+command.text);return {ok:true};
      }
    }
    return {ok:false,code:'closed'};
  };
  let voiceHooks;
  const ensureVoice=()=>{
    if(voice)return true;
    if(!Modules.has('robottino-voice-device')){say('Conversazione non disponibile in questo firmware.');return false;}
    const {createVoiceDevice}=Modules.importNow('robottino-voice-device');
    voice=createVoiceDevice(robot,voiceHooks={
      motionBusy:()=>posePending,
      // The microphone opens after Robottino's greeting, or after this long without one (voice-device.js, 14 Nov 2026).
      greetingMs:3000,
      stats(text,test){try{Preference.set('robottino',test?'voiceTest':'voiceStats',String(text).slice(0,120));}catch{}},
      faceStyle:()=>face.behavior.getStyle?.(),
      // The shape of the lips of the letter being said (16 Nov 2026): the face shows it if it has the pictures.
      lips(name){if(!closed)try{face.behavior.setLips?.(face,name);}catch{}},
      // No «Ti ascolto» banner over the face (owner's choice, 9 Nov 2026); no «Mi collego…» either (14 Nov 2026).
      listening(){voiceDiag('listen');voiceReady=true;if(!closed)unsay();},
      // The microphones of «guardalo e parla» wait K.EAR_AFTER_VOICE_MS after a conversation (21 Nov 2026, 12:38: the robot
      // restarted as a conversation ended, in the host's microphone task; a microphone opened while the conversation's
      // own microphone and speaker are still closing fails to start, and the host then uses the channel it has just
      // freed: audioin.c, i2s_channel_init_std_mode failing and i2s_channel_enable called all the same).
      ended(reason){earNotBefore=Math.max(earNotBefore,clock.now()+K.EAR_AFTER_VOICE_MS);voiceDiag('end:'+reason);voiceReady=false;faceHoldUntil=undefined;faceAngry=false;if(!closed&&reason!=='test'){setMood('neutral');say(voiceMessages[reason]??'Conversazione terminata.');if(['connect_timeout','network','provider_error','error'].includes(reason))lightError();}},
      // A face asked for by voice stays (the smile FACE_HOLD_MS, sad and angry until told): the reply's own mood does
      // not replace it meanwhile.
      // A happy reply does not put on the smiling face (owner, 16 Nov 2026: «è troppo sorridente, ogni volta che parla mi
      // sorride»): with the livelier voice nearly every reply was happy. The smile is only for «sorridi», a thumb up and
      // the other things asked for; angry and sad replies still show their faces, and the gesture still happens.
      mood(value){if(closed)return;if(faceHoldUntil===undefined)setMood(value.expression==='happy'?'neutral':value.expression);if(value.gesture)gesture(GESTURES[value.gesture]);},
      face(command){
        if(closed)return;
        spokenNow('face:'+command.expression);
        // An explicit smile: the happy picture of every face, the white robot's open-mouth one too. Angry is emotion 1
        // (portrait-state.js), with its own pictures since 11 Nov 2026.
        // Sad and angry stay until the user says to go back («torna felice», «torna normale»: owner, 11 Nov 2026) or
        // the conversation ends; the smile stays FACE_HOLD_MS, counted again from the end of what Robottino says.
        faceAngry=command.expression==='angry';
        if(command.expression==='normal'){faceHoldUntil=undefined;setMood('neutral');return;}
        robot.face.setEmotion(command.expression==='happy'?3:command.expression==='angry'?1:2);faceHoldUntil=command.expression==='happy'?clock.now()+K.FACE_HOLD_MS:Infinity;
      },
      // What happened is kept for the agent's tool (code review, 19 Nov 2026: a refused move was told to the agent as done).
      head(command){if(closed)return;const moved=voiceLook(command.direction,command.full===true);spokenNow('head:'+command.direction,moved?'ok':refusal());if(!moved)say('Ora non posso muovere la testa.');},
      // Spoken rover commands (voice-wire.js roverCommand, 15 Nov 2026), heard only while the rover answers: a 1 s move
      // at once; the agent's muovi_rover for the same move within TOOL_SAME_MS is then not done twice.
      roverReady:()=>!closed&&rover?.state==='ready',
      // «Esplora la stanza», «basta esplorare» (explore.js exploreCommand): true when it was taken.
      explore(command){if(closed)return false;if(command==='stop'){const was=explore.walk.active;explore.end('voice');return was;}return explore.start('voice');},
      rover(command){
        if(closed)return;
        // «Fermati» ends the exploration (and the talk, explore.end); another move of the wheels takes them over.
        if(command.move==='stop')explore.end('voice');
        else if(!Object.hasOwn(GRIP_MOVES,command.move)&&explore.walk.active&&!explore.walk.still)explore.end('taken');
        const result=remoteDriving()&&command.move!=='stop'?'remote':roverMove(command.move,command.move==='stop'?0:1000);
        spokenNow('rover:'+command.move,result);
        if(result==='lifted')say('Rover: prima rimettimi giù.');else if(result==='obstacle')say('Rover: ostacolo davanti.');else if(result==='obstacle_sensor')say(K.OBSTACLE_SENSOR_SAID);else if(result!=='ok'&&result!=='remote')say('Rover: non risponde.');
      },
      // «Cos'è questo?»: one picture from the robot's camera goes to the server over the conversation (live-device.js
      // snapshot); when it cannot be taken the server is told, and Robottino says it could not see.
      see(){
        if(closed)return;
        const failed=()=>{try{voice?.look?.('end');voice?.pictureFailed?.();}catch{}};
        if(typeof trace==='function')trace('[robottino] see\n');
        spokenNow('see');
        if(typeof live?.snapshot!=='function'){failed();return;}
        try{voice?.look?.('start');}catch{} // head lights: turquoise until the description starts
        void live.snapshot(piece=>voice.picture(piece)).then(ok=>{if(typeof trace==='function')trace(`[robottino] see ${ok?'sent':'failed'}\n`);if(ok){try{voice?.look?.('sent');}catch{}}else failed();},failed);
      },
      timer(command){if(closed)return;const before=reminders.items.length,line=reminders.apply(command,clock.now());if(command.action==='set')spokenNow('timer',reminders.items.length>before?'ok':'full');if(line)say(line);},
      tool(command){if(typeof trace==='function')trace(`[robottino] tool ${command.tool} ${command.direction??command.expression??command.action??''}\n`);return toolDone(command);},
      agenda(){return clockReminders.list;},
      room(){return climateNow();}, // the ENV III, for «che temperatura c’è?» in a conversation (21 Nov 2026)
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
  // TEMPORARY (owner, 14 Nov 2026, 20:20: «proviamo il 2»: microphone and speaker open together, the first step towards
  // stopping Robottino with the voice). The host opens them as two separate things on the same I2S wires, each with its
  // own clock and format (microphone Philips with MCLK, speaker MSB without): the 9 Nov call that kept both open crackled.
  // This trial changes nothing in the host: the two microphones as the ears open them, and the call's own speaker
  // (voice.selfTest, the same phrase as «Prova voce»). Round 1 opens the microphones first, round 2 the speaker first.
  // The owner listens for crackle; the log says how loud the microphones hear the room and the robot's own voice (the
  // echo that would have to be taken away).
  const testDuplex=()=>{
    if(closed)return;
    try{
      if(!ensureVoice())return;
      if(voice.active||voiceTesting){say('Chiudi prima la conversazione.');return;}
      if(!soundProbe){say('Prova non disponibile: l’host non sa misurare i microfoni.');return;}
      const ima=new Resource('prova-voce-ima.bin'),phrase={length:ima.byteLength,read:(start,end)=>ima.slice(start,end)};
      voiceTesting=true;voiceDiag('duplex');earClose();
      const sample={level:0,quality:0,lag:0};let stats,sampler;
      const listen=()=>{earOpen();earMode='duplex';stats={room:[],echo:[],phase:'room'};sampler=Timer.repeat(()=>{const value=earBest;earBest=0;if(readSound(value,sample))stats[stats.phase].push(sample.level);},100);};
      const stop=()=>{if(sampler!==undefined){Timer.clear(sampler);sampler=undefined;}earClose();};
      const report=round=>{
        const of=list=>list.length?`max ${Math.max(...list)} median ${list.slice().sort((a,b)=>a-b)[list.length>>1]} n ${list.length}`:'none';
        if(typeof trace==='function')trace(`[robottino] duplex ${round}: room ${of(stats.room)}; robot voice ${of(stats.echo)}; pieces ${earPieces}\n`);
      };
      void Promise.resolve()
        .then(()=>{say('Duplex 1 di 2: prima i microfoni, poi la voce. Gracchia?',{sticky:true});listen();return pause(1500);})
        .then(()=>{stats.phase='echo';return voice.selfTest(phrase,{volume:1});})
        .then(()=>{report('1 microphones first');stop();return pause(2000);})
        .then(()=>{
          say('Duplex 2 di 2: prima la voce, poi i microfoni. Gracchia?',{sticky:true});
          const playing=voice.selfTest(phrase,{volume:1});
          return pause(600).then(()=>{listen();stats.phase='echo';return playing;});
        })
        .then(()=>{report('2 speaker first');stop();if(!closed)say('Prova finita: gracchiava la 1, la 2, tutte e due o nessuna?');})
        .catch(error=>{stop();const reason=String(error?.message??error);voiceDiag('duplex:'+reason.slice(0,40));if(typeof trace==='function')trace(`[robottino] duplex failed ${reason.slice(0,80)}\n`);if(!closed)say('Prova duplex non riuscita.');})
        .finally(()=>{voiceTesting=false;});
    }catch(error){voiceTesting=false;earClose();voiceDiag('duplex-throw:'+String(error?.message??error).slice(0,40));say('Prova duplex non disponibile.');}
  };
  const afterPose=(run,waited=0)=>{
    if(closed||voice?.active)return;
    if(posePending&&waited<1500){Timer.set(()=>afterPose(run,waited+20),20);return;}
    run();
  };
  const toggleVoice=()=>{
    earClose(); // the microphone is the conversation's
    wakeStop('conversation');
    if(closed)return;
    const toggledAt=clock.now();if(Number.isFinite(lastToggleAt)&&Number.isFinite(toggledAt)&&toggledAt-lastToggleAt<2000){voiceDiag('dup');return;}lastToggleAt=toggledAt;
    voiceDiag(voice?.active?'tog:stop':'tog:start');
    if(voice?.active){voice.stop();return;}
    try{
      if(!ensureVoice())return;
      // No «Mi collego…» on the face (owner, 14 Nov 2026, 19:36: «togli il messaggio mi collego»): the head lights say it.
      // The audio drivers change and the connection opens only once the servos have confirmed the command they are
      // waiting for (at most 1.2 s, the pose watchdog): starting meanwhile made that confirmation look lost.
      afterPose(()=>{
        voiceDiag('start');voiceReady=false;
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
    earClose(); // microphone and speaker are never open together
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
    return true; // the sound was asked for (the recorded phrases move the mouth only then)
  };
  // TEMPORARY hardware diagnostics (first K151 bring-up): read back over USB from nvs.
  face.behavior.onFaceError=(error,frame)=>{try{if(typeof trace==='function')trace(`[robottino] face error ${frame}: ${error}\n`);}catch{}try{Preference.set('robottino','faceError',`${frame}: ${String(error?.stack??error)}`.slice(0,200));}catch{}};
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
  const close=()=>{if(closed)return;try{headSensitivity(3);}catch{}closed=true;wakeStop('closed');try{if(powerButton&&powerButton.onChanged!==powerPrevious)powerButton.onChanged=powerPrevious;}catch{}lights.close();try{nfc.close();}catch{}k210Close();/*legoClose();*/roverClose();try{climate?.close();}catch{}try{pir?.close();}catch{}pir=undefined;earClose();if(sdLog){try{sdLog.flush(true);}catch{}try{globalThis.trace=usbTrace;}catch{}}try{if(sense)imu.stop?.();}catch{}endCalibration();voice?.stop();pairing?.stop();liveRevision++;cancelReconnect();live?.close();motionRevision++;arming=false;pendingPose=undefined;stopDance();tracker.stop();if(timer!==undefined)Timer.clear(timer);unsubscribe?.();unsubscribeTouch?.();session?.close();face.behavior.dispose?.(face);face.stop();robot.ui.drawer.removeDrawerButton('robottino:motion');robot.ui.drawer.removeDrawerButton('robottino:stop');robot.ui.drawer.removeDrawerButton('robottino:dance');robot.ui.drawer.removeDrawerButton('robottino:live');robot.ui.drawer.removeDrawerButton('robottino:pair');robot.ui.drawer.removeDrawerButton('robottino:verified');robot.ui.drawer.removeDrawerButton('robottino:calibrated');robot.ui.drawer.removeDrawerButton('robottino:menu');robot.ui.drawer.removeDrawerButton('robottino:voicetest');try{restoreToggle?.();}catch{}};
  running={close};
  // The power button: the host's own handler first (its mod manager), then the head to where it starts.
  const powerButton=globalThis.button?.power,powerPrevious=powerButton?.onChanged;
  const powerPressed=()=>{
    if(closed)return;
    powerHeldUntil=clock.now()+K.POWER_HOLD_MS;
    try{if(typeof trace==='function')trace(`[robottino] power button: head to the start (motors ${tracker.enabled?'on':'off'})\n`);}catch{}
    wakeStop('power button');stopDance();touchMotion=undefined;tracker.clearTarget();
    if(tracker.enabled&&!motionFault)tracker.lookAt(0,START_PITCH,clock.now());
  };
  if(powerButton&&typeof powerButton.read==='function')try{
    powerButton.onChanged=function(){
      try{powerPrevious?.call(this);}catch{}
      try{if(this.read()===1)powerPressed();}catch{}
    };
  }catch{}
  // Waking up when Robottino starts (wake-up.js; owner, 14 Nov 2026, in place of a start-up video): black screen, the
  // face appears with its eyes closed, yawns, opens its eyes and says «Ciao, eccomi!». Driven from the robot's cycle
  // (wakeTurn). The Live link waits for it (afterWake): opening it held the whole robot for 2.3 s (the encrypted
  // handshake) and the camera that starts with it another 0.5 s, which stopped the start-up video half way. Never later
  // than WAKE_LIMIT_MS. A conversation, the Live, the menu and closing end it at once, with the screen lit.
  let wake,wakeWaiting=[];
  const screenLight=globalThis.power; // the host's screen light (CoreS3: brightness 0…100); may be missing
  const setLight=value=>{try{if(screenLight&&'brightness' in screenLight)screenLight.brightness=value;}catch{}};
  const wakeDone=()=>{const waiting=wakeWaiting;wakeWaiting=undefined;for(const job of waiting??[])try{if(!closed)job();}catch{}};
  const afterWake=job=>{if(wakeWaiting)wakeWaiting.push(job);else job();};
  const wakeStop=reason=>{
    const w=wake;if(!w)return;wake=undefined;
    if(w.target!==undefined)setLight(w.target);
    try{face.behavior.setWake?.(face,undefined);}catch{}
    try{if(typeof trace==='function')trace(`[robottino] wake ${reason} in ${Math.round(clock.now()-w.at)} ms, screen light ${w.target===undefined?'not available':'from 0 to '+w.target}\n`);}catch{}
    wakeDone();
  };
  // The recorded sound `file` with the mouth following `track` (as sayPhrase); after() also when it cannot be played.
  const sayRecorded=(file,track,after)=>{
    if(playSound(file)!==true){after?.(clock.now());return;}
    if(!track){after?.(clock.now());return;}
    const idle=!speaking;speaking={track,after,open:0,from:clock.now()+K.PHRASE_START_MS};
    if(idle)Timer.set(mouthTimer,PHRASE_MOUTH_MS);
  };
  const wakeTurn=now=>{
    const w=wake;if(!w||closed)return;
    const elapsed=now-w.at;
    if(elapsed>=WAKE_LIMIT_MS){wakeStop('too long');return;}
    if(w.target!==undefined){const light=wakeBrightness(elapsed,w.target);if(light!==w.light){w.light=light;setLight(light);}}
    // No yawn any more (owner, 15 Nov 2026: «togli sbadiglio»): at the same moment the eyes start opening. The
    // recording (WAKE_YAWN, YAWN_MOUTH in wake-up.js) stays in the MOD; to bring it back:
    // w.phase='yawn';sayRecorded(WAKE_YAWN,YAWN_MOUTH,()=>{if(wake===w){w.phase='eyes';w.eyesAt=clock.now();}});
    if(w.phase==='dark'&&elapsed>=WAKE_YAWN_AT){w.phase='eyes';w.eyesAt=now;wakeLog(`eyes open, no yawn, light ${w.light}`);}
    if(w.phase==='eyes'){
      const since=now-w.eyesAt,step=wakeEyes(since);
      if(step!==w.step){w.step=step;try{face.behavior.setWake?.(face,step);}catch(error){wakeLog(`eyes ${step} failed ${error}`);}wakeLog(`eyes ${step??'open'}`);}
      if(since>=WAKE_EYES_MS){w.phase='pause';w.helloAt=now+WAKE_HELLO_GAP_MS;}
    }
    if(w.phase==='pause'&&now>=w.helloAt){w.phase='hello';wakeLog('hello');sayRecorded(WAKE_HELLO,PHRASE_MOUTHS[WAKE_HELLO],()=>{if(wake===w)wakeStop('done');});}
  };
  // TEMPORARY (first days of waking up, 14 Nov 2026, owner: «si sente l'audio ma non si mostra l'animazione»): each
  // step on the log, with the time from the start.
  const wakeLog=text=>{try{if(typeof trace==='function')trace(`[robottino] wake +${wake?Math.round(clock.now()-wake.at):'-'} ${text}\n`);}catch{}};
  const wakeStart=()=>{
    let target;try{const value=screenLight?.brightness;if(Number.isFinite(value)&&value>0)target=value;}catch{}
    wake={at:clock.now(),phase:'dark',target,step:0};
    if(target!==undefined){wake.light=0;setLight(0);}
    face.behavior.setWake?.(face,0);
    wakeLog(`start: face ${face.behavior.getStyle?.()}, light ${target??'not available'}, eyes ${face.behavior.wakeShown?.()??'?'}`);
  };
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
      // The app is in: nothing changes for the robot until it commands (remoteDriving above). Until 15 Nov 2026 this
      // stopped the wake-up, a calibration, a dance and the head, as if the iPhone had taken over.
      connected(){remoteActive=true;cameraFollow=false;remoteHoldUntil=0;},
      // A call with the iPhone is starting: the microphones of the sleep and of «guardalo e parla» close first.
      callStarting(){earClose();},
      // The iPhone left: what it started stops (following, dance), the head stays where it is and the motions stay as
      // the owner set them (9 Nov 2026: they were switched off at every end of Live or Test, so following was refused).
      // Only the iPhone's explicit STOP switches them off.
      // Leaving the Live (owner, 9 Nov 2026): the head goes back straight ahead, as at the start.
      // The link can also end by itself, with no iPhone on it (the Wi-Fi drops): then the head stays where it is.
      // It used to go straight at every drop, away from the face it was following (14 Nov 2026, 14:39: «ora non mi
      // sta più seguendo»: one drop of the home Wi-Fi, the head back to straight, the owner lost).
      // The iPhone left, or the link dropped: only what the iPhone was driving stops; the head goes back by itself only
      // if the iPhone had put it somewhere.
      disconnected(){const drove=remoteDriving();remoteActive=false;remoteHoldUntil=0;cameraFollow=false;homeAfterLive=drove;if(drove){stopDance();tracker.clearTarget();}scheduleReconnect(revision);},
      // false: the wheels' stop was not confirmed by the rover (review of 17 Nov 2026, R1): the iPhone must not be told «fermato».
      stop(emergency){cameraFollow=false;stopDance();explore.end('stop');let wheels=true;try{if(rover?.moving)wheels=rover.stop()===true;}catch{wheels=false;}if(emergency){remoteHold(K.REMOTE_HEAD_MS);followPausedUntil=Math.max(followPausedUntil,clock.now()+K.REMOTE_HEAD_MS);tracker.stop();}else tracker.clearTarget();return wheels;},
      // The iPhone's rover keys (Live): one short move each, the app sends the next while the key is held down.
      rover(move,ms){if(closed||!remoteActive)return false;if(!Object.hasOwn(GRIP_MOVES,move)){remoteHold(K.REMOTE_ROVER_MS);if(explore.walk.active&&!explore.walk.still||explore.wanted!==undefined)explore.end(move==='stop'?'stop':'taken');}const result=roverMove(move,ms);if(result==='obstacle')say('Rover: ostacolo davanti.');else if(result==='obstacle_sensor')say(K.OBSTACLE_SENSOR_SAID);return result==='ok';},
      // Hand gestures seen by the iPhone in the robot's video (owner, 15 Nov 2026: «riconosci i gesti»; he chose the
      // four): thumb up a happy face, thumb down a sad one (both for FACE_HOLD_MS, then the usual face); an open hand
      // held still stops the rover and a dance and holds the rover's own moves for HAND_STOP_MS; a wave is answered
      // with «Ciao, eccomi!» (the wake-up's recording, when a sound may be played) and a smile; two fingers start the
      // dance, with all the checks of a spoken «balla». true only when it was done; the same gesture again within
      // HAND_SAME_MS is one gesture.
      gesture(name){
        if(closed||!remoteActive||explore.walk.active||explore.wanted!==undefined)return false;
        const now=clock.now();
        if(handGesture?.name===name&&now-handGesture.at<K.HAND_SAME_MS)return true;
        // The hand that leads the Force (force-follow.js) is no gesture: an open hand held there would stop the rover («Fermo.»).
        if(forceFollow.active){if(typeof trace==='function')trace(`[robottino] hand gesture ${name} ignored: the Force follows the hand\n`);return true;}
        let done=false;
        switch(name){
          // With the face, its voice (owner, after trying them: «deve anche ridere o fare un verso di tristezza»): the
          // laugh, and «Oh-oh-oh, uffa.» with the mouth moving. Only when a sound may be played (never in a conversation).
          case 'thumbsUp':robot.face.setEmotion(3);faceAngry=false;faceHoldUntil=now+K.FACE_HOLD_MS;if(!voice?.active&&!speaking)playSound(HAND_SOUNDS.thumbsUp);done=true;break;
          case 'thumbsDown':robot.face.setEmotion(2);faceAngry=false;faceHoldUntil=now+K.FACE_HOLD_MS;if(!voice?.active&&!speaking)sayRecorded(HAND_SOUNDS.thumbsDown,PHRASE_MOUTHS[HAND_SOUNDS.thumbsDown]);done=true;break;
          case 'palm':
            roverHoldUntil=now+K.HAND_STOP_MS;stopDance();
            // A rover that does not take the stop is not «stopped».
            done=rover?.state==='ready'||rover?.unstopped?rover.stop():true;
            say(done?'Fermo.':'Rover: non risponde.');break;
          case 'wave':done=waveHello(now);break;
          case 'victory':done=gesture(GESTURES.dance,true);if(!done)say('Ora non posso ballare.');break;
        }
        // The small hand in the top left corner: whenever the gesture is taken, also when it cannot be done (owner, 23 Nov
        // 2026: «il gesto di vittoria l'ha riconosciuto, però non appare l'icona e non balla»; the motors were off).
        try{face.behavior.setHand?.(face,name);}catch{}
        if(done)handGesture={name,at:now};
        if(typeof trace==='function')trace(`[robottino] hand gesture ${name} ${done?'done':'refused'}\n`);
        return done;
      },
      // What else the iPhone saw in the robot's video (owner, 15 Nov 2026: «riconoscere chi sei, capire l'espressione,
      // riconoscere oggetti al volo»). The owner is greeted by name on the screen, with a smile and the «Ciao, eccomi!»
      // of waking up (the robot has no voice for a name outside a conversation); a stranger gets a written hello; a
      // smile is answered with a smile; a face that has not smiled for a while with a small tilt of the head, when the
      // head may move by itself; a thing shown to the camera is named on the screen. Nothing of this in a conversation
      // (the face, the screen and the voice are the conversation's). The same thing again within HAND_SAME_MS is once.
      sight(kind,text){
        if(closed||!remoteActive)return false;
        const now=clock.now(),key=kind+':'+(text??'');
        if(explore.walk.active && (kind==='person'||kind==='stranger')){
          return voice?.person?.(kind==='person'?text:undefined)===true;
        }
        if(voice?.active||(sightSaid?.key===key&&now-sightSaid.at<K.HAND_SAME_MS))return true;
        const smile=()=>{robot.face.setEmotion(3);faceAngry=false;faceHoldUntil=now+K.FACE_HOLD_MS;};
        switch(kind){
          // Nothing is written on the screen any more (owner, the same evening, after trying it: «togli i messaggi a
          // video tipo "Ciao Ada", "Vedo gli occhiali", "Vedo una tazza"»): the owner gets the smile and the hello,
          // a stranger the smile, a thing nothing on the robot (the iPhone shows what it saw).
          case 'person':smile();if(!speaking)sayRecorded(WAKE_HELLO,PHRASE_MOUTHS[WAKE_HELLO]);break;
          // A stranger: nothing (owner, the same evening: «ogni tanto ride anche se io non sorrido»; the likeness is
          // too easily wrong to answer it with a smile).
          case 'stranger':break;
          case 'smile':smile();break;
          case 'serious':gesture(GESTURES.tilt);break;
          case 'object':break;
          default:return false;
        }
        sightSaid={key,at:now};
        if(typeof trace==='function')trace(`[robottino] sight ${kind}\n`); // never the name or the thing: the log stays on the card
        return true;
      },
      // The speaker volume from the iPhone's Robot tab (15 Nov 2026).
      // On the screen, once the amplifier took it (owner, 15 Nov 2026: «fai apparire messaggio su robot con esempio
      // "volume 1/10"»).
      volume(level){if(closed)return false;const ok=setVolume(level,true);if(ok)try{say(`Volume ${level}/10`);}catch{}return ok;},
      // The «Movimenti» switch of the iPhone's Robot tab (15 Nov 2026).
      motions(on){if(closed)return false;return setMotions(on===true);},
      // «Inseguimento con rover» from the Robot tab (15 Nov 2026), and what the robot tells the iPhone about it.
      roverFollow(on){if(closed)return false;return setRoverFollow(on===true);},
      roverReady:()=>!closed&&rover?.state==='ready',
      roverFollowing:()=>!closed&&roverFollowing&&tof?.state==='ready',
      // «Chiamata con lo sguardo» from the Robot tab (21 Nov 2026), and its state for the iPhone.
      gazeCall(on){if(closed)return false;try{Preference.set('robottino','gazeCall',on===true);}catch{return false;}gaze.set(on);say(on===true?'Chiamata con lo sguardo: accesa.':'Chiamata con lo sguardo: spenta.');live?.hello?.();return true;},
      gazeCalling:()=>!closed&&gaze.on,
      // The Force following the hand (force-follow.js): the iPhone is told, and says where the hand is across the picture.
      forceFollowing:()=>!closed&&forceFollow.active,
      // «Esplora» from the iPhone's Studio: on or off; the iPhone is told whether it is going (status exploring).
      explore(on){if(closed)return false;if(!on){explore.end('iphone');return true;}return explore.start('iphone');},
      exploring:()=>!closed&&(explore.walk.active||explore.wanted!==undefined),
      handAt(x){if(closed||!forceFollow.active)return false;forceFollow.hand(x,clock.now());return true;},
      climate:()=>closed?undefined:climateNow(),
      // «Segui il mio viso»: the robot camera's frames go to the iPhone, which answers where the face is.
      follow(enabled){
        if(!enabled){if(cameraFollow){cameraFollow=false;tracker.clearTarget();}return;}
        if(closed||!remoteActive||calibrating||!tracker.enabled||motionFault||posePending||remoteDance||dance.active)throw Error('motion_unavailable');
        cameraFollow=true;tracker.clearTarget();
      },
      headPose:()=>({y:tracker.yaw,p:tracker.pitch}),
      // The K210 on the head (k210.js): its last picture's answer, while it sends them; following then takes its faces.
      k210:()=>k210?.frame(),
      k210Image:()=>k210?.image(),
      k210Settled:()=>headSettled(K.K210_SETTLE_MS)&&wheelsStill(),
      aim(value){return !closed&&!poweringOff()&&followingFace()&&clock.now()>=followPausedUntil&&tracker.enabled&&!motionFault&&tracker.aim(value.x,value.y,value.pose,clock.now(),value.gain);},
      // Following alone, no face in sight: the head goes back to where one was last seen (live-device.js).
      look(value){return !closed&&!asleep&&!poweringOff()&&followingFace()&&clock.now()>=followPausedUntil&&tracker.enabled&&!motionFault&&tracker.lookAt(value.y,value.p,clock.now());},
      reaction(kind){if(!closed)reactions[kind]?.();},
      faceStyle(style){if(!Object.hasOwn(FACE_STYLES,style))throw Error("invalid_style");Preference.set("robottino","faceStyle",style);face.behavior.setStyle(face,style);},
      motionEnabled:()=>tracker.enabled&&!motionFault,
      // A head command waiting for the servos' confirmation: the camera waits, so the replies on the servo line are
      // read at once (9 Nov 2026: with the camera busy, a reply read late looked lost and the 1.2 s check fired).
      motionBusy:()=>posePending,
      headMoving,headSettled:()=>headSettled()&&wheelsStill(),
      // The rover is looking for the face with the whole body: the head does not look around (live-device.js). How many
      // turns it has made, or nothing when the body is not searching.
      bodyQuick:()=>roverFollow.quick, // short pauses: the quick detectors only
      bodySearch:()=>!closed&&roverMaySearch()&&roverAllowed()&&!roverUnsafe()&&roverBody.free(clock.now())?roverFollow.steps:undefined,
      conversation:()=>!!voice?.active,
      listening:()=>voice?.phase==='listening', // following sends small frames meanwhile: the microphone comes first
      mediaPaused:()=>explore.walk.active&&!!voice?.speaking,
      speaking:()=>!!voice?.speaking, // following sends nothing meanwhile: the voice comes first
      // The conversation is opening or changing turn (connection, audio): following alone looks at no frame.
      starting:()=>voice?.phase==='connecting',
      dance(steps){
        if(closed||!remoteActive||calibrating||!tracker.enabled||motionFault||posePending||dance.active||remoteDance||cameraFollow)throw Error('motion_unavailable');
        const now=clock.now();if(!Number.isFinite(now))throw Error('invalid_clock');
        remoteDance={steps,index:-1,nextAt:now};
      },
      async motion(value){
        // The iPhone takes the head: from now and for REMOTE_HEAD_MS the robot's own following does not move it (also
        // when this one command has to be refused: the next one then finds the head free).
        if(!closed&&remoteActive&&!calibrating){remoteHold(K.REMOTE_HEAD_MS);followPausedUntil=Math.max(followPausedUntil,clock.now()+K.REMOTE_HEAD_MS);if(!posePending)tracker.clearTarget();}
        if(closed||!remoteActive||calibrating||!tracker.enabled||motionFault||posePending||remoteDance||cameraFollow||!headQuiet())throw Error('motion_unavailable');
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
    // Not while the motors start or a head move waits for its confirmation (23 Nov 2026, 19:21: the connection held
    // the robot for 2.2 s just after the automatic start of the motors, the first move was not confirmed in time and
    // the safety blocked the motions until the next restart). Waits for them, at most K.LIVE_AFTER_ARM_MS.
    const from=clock.now(),go=()=>{
      if(closed||revision!==liveRevision)return;
      if((arming||posePending)&&clock.now()-from<K.LIVE_AFTER_ARM_MS){Timer.set(go,250);return;}
      if(clock.now()>from&&typeof trace==='function')trace(`[robottino] live waited ${Math.round(clock.now()-from)} ms for the motors\n`);
      void live.connect().catch(()=>{say('Live: connessione non disponibile.');lightError();scheduleReconnect(revision);});
    };
    go();
    }catch{say('Live: moduli del firmware host non compatibili. Volto e comandi locali restano disponibili.');lightError();}
  };
  if(Modules.has('robottino-live-device')){
    robot.ui.drawer.addDrawerButton({key:'robottino:live',label:'Collega Live iPhone',callback:drawerAction(connectLive)});
    afterWake(connectLive);
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
  
  let headCleanSince,headArmed=false,headBusySince,headResetUntil,headStarting=true;
  const headReference=on=>{try{touchPanel?.configure?.({referenceReset:on});}catch{}};
  // The chip keeps taking its reference for HEAD_RESET_MS, then senses again. After the reset made at start the
  // reading counts as clean at once (the next turn of the loop corrects it if a zone is above 0).
  const headReset=()=>{
    headReference(true);headResetUntil=true;headCleanSince=undefined;headBusySince=undefined;headArmed=false;
    if(typeof trace==='function')trace('[robottino] head reference reset\n');
    Timer.set(()=>{headReference(false);headResetUntil=undefined;if(headStarting){headStarting=false;if(!closed)headCleanSince=clock.now()-K.HEAD_CLEAN_MS;}},K.HEAD_RESET_MS);
  };
  // One turn of the loop with the zones just read: keeps the guards up to date.
  const headGuard=(now,levels)=>{
    const touched=Math.max(...levels)>0;
    if(headResetUntil!==undefined)return;
    if(!touched||!robotQuiet()){headBusySince=undefined;}
    // The head moving is felt as a touch (11 Nov 2026, 14:19: right after «tutto in alto» a long press of strength 1
    // closed the conversation with nobody touching): no reading is clean while it moves, nor until it has settled.
    if(touched||!robotQuiet()||headShaking()){headCleanSince=undefined;}else if(headCleanSince===undefined)headCleanSince=now;
    if(headShaking())headArmed=false; // a press already under way when the head starts moving does not count either
    if(touched){
      if(headBusySince===undefined)headBusySince=now;
      else if(now-headBusySince>=K.HEAD_REF_MS){
        headReset();
        // If a hand was really there, the reference now includes it: once more a little later, with the zones at 0.
        Timer.set(()=>{if(!closed&&headResetUntil===undefined&&Math.max(0,...(touchPanel?.sample??[]))===0)headReset();},3000);
      }
    }
  };
  const headClean=now=>headResetUntil===undefined&&headCleanSince!==undefined&&now-headCleanSince>=K.HEAD_CLEAN_MS;
  let headPeak=0;
  const headSensitivity=level=>{try{touchPanel?.configure?.({sensitivityType:0,sensitivityLevel:level});}catch{}};
  headSensitivity(K.HEAD_LEVEL);
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
      const felt=headArmed&&headPeak>=K.HEAD_GATE,gesture=felt?longPress.touch(event,touchedAt):(longPress.touch(event,touchedAt),null);
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
      return setHeadPose({y:0,p:START_PITCH,r:0}).then(()=>{if(!closed&&pendingPose===token){tracker.yaw=0;tracker.pitch=START_PITCH;}});
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
    if(tracker.enabled){touchMotion=undefined;stopDance();tracker.enabled=false;parkHead();say('Movimenti disattivati.');live?.hello?.();return;}
    if(motionFault){say('Comando non confermato. Verifica il robot e riavvia il modulo.');return;}
    if(posePending){say('Attendi la conferma del movimento precedente.');return;}
    // Switched on by hand from the robot's menu: the iPhone's «off» no longer holds at the next start. Only once the
    // switching on really begins (a refused one changes nothing).
    if(auto!==true)try{if(Preference.get('robottino','motionsOff')===true)Preference.set('robottino','motionsOff',false);}catch{}
    armingStarted=clock.now();if(!Number.isFinite(armingStarted)){failMotion('Temporizzazione non valida: movimenti bloccati.');return;}
    arming=true;const revision=++motionRevision;
    void Promise.resolve().then(()=>{
      if(closed||revision!==motionRevision)return;
      return robot.motion.setTorque(true);
    }).then(()=>{
      // At the automatic start nothing is written (owner, 14 Nov 2026: «togli il messaggio movimenti attivi all'avvio»):
      // only when the motions are switched on by hand.
      if(!closed&&revision===motionRevision){tracker.enabled=true;if(auto!==true)say('Movimenti attivi.');centreHead();live?.hello?.();}
    }).catch(error=>{
      if(closed||revision!==motionRevision)return;
      tracker.enabled=false;
      if(auto===true&&autoArmTries<2&&/timed out/.test(String(error?.message??error))){calDiag('autoarm again');autoArmAt=clock.now()+2000;return;}
      say('Motori non disponibili.');
    })
      .finally(()=>{if(revision===motionRevision)arming=false;});
  };
  robot.ui.drawer.addDrawerButton({key:'robottino:motion',label:'Attiva/disattiva movimenti',callback:drawerAction(toggleMotion)});
  // Motions switched off (menu or the iPhone's switch): the head first goes back to where it starts, straight ahead and
  // 20° up (owner, 15 Nov 2026: «quando spengo i movimenti deve tornare alla posizione iniziale, verso davanti testa in
  // su di 20 gradi»), and stays there. Called with the motions already off, so nothing else sends a pose meanwhile
  // (the calibration sends its poses the same way). Not after a fault, nor for the safety switches, which stop at once.
  // The move waits for a quiet moment as every other head command (headQuiet, no pose waiting for its confirmation),
  // up to PARK_WAIT_MS, and is given up if the motions come back on meanwhile (code review, 15 Nov 2026).
  let parkAt;
  const parkHead=()=>{parkAt=clock.now();parkTurn(parkAt);};
  const parkTurn=now=>{
    if(parkAt===undefined)return;
    if(closed||!headCal||calibrating||motionFault||tracker.enabled||arming||!(now-parkAt<=K.PARK_WAIT_MS)){parkAt=undefined;return;}
    if(posePending||!headQuiet())return;
    parkAt=undefined;
    // A pose as the others (code review, 19 Nov 2026): pending, with the 1.2 s watchdog, so that switching the
    // movements on again, the camera and a connection opening wait for it instead of sending over it.
    const token={};pendingPose=token;posePending=true;poseConfirmed=false;poseStarted=now;
    void soon(()=>{if(closed||pendingPose!==token)return;return setHeadPose({y:0,p:START_PITCH,r:0});})
      .then(()=>{if(!closed&&pendingPose===token){tracker.yaw=0;tracker.pitch=START_PITCH;}})
      .catch(error=>{if(!closed&&pendingPose===token)failMotion('Errore del movimento: nuovi movimenti bloccati.',error);})
      .finally(()=>{if(pendingPose===token){pendingPose=undefined;posePending=false;}});
  };
  // The «Movimenti» switch of the iPhone's Robot tab (owner, 15 Nov 2026: «metti un interruttore per disabilitare i
  // movimenti»). Off: the head stops at once and stays still, also after a restart (Preference robottino/motionsOff,
  // so the automatic start at boot is skipped). On: as «Movimenti: sì» in the menu, and kept for the next start.
  // true means done (off) or switching on started; the iPhone reads the result in the robot's status.
  const setMotions=on=>{
    if(!on){
      try{Preference.set('robottino','motionsOff',true);}catch{return false;}
      autoArmAt=undefined;if(arming){motionRevision++;arming=false;}
      if(tracker.enabled){touchMotion=undefined;stopDance();tracker.enabled=false;parkHead();}
      say('Movimenti disattivati.');live?.hello?.();return true;
    }
    // Only as the automatic start: hardware verified and «Calibrazione fatta» on (the menu switch), never past them.
    // A refused switching on leaves the saved choice as it was (code review, 15 Nov 2026: it used to save «on» first).
    if(!(tracker.enabled||arming)&&(!headCal||calibrating||motionFault||posePending||Preference.get('robottino','verified')!==true||Preference.get('robottino','calibrated')!==true))return false;
    try{Preference.set('robottino','motionsOff',false);}catch{return false;}
    if(tracker.enabled||arming)return true;
    toggleMotion();return arming||tracker.enabled;
  };
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
    if(remoteDriving()){say('L’iPhone sta comandando il robot: aspetta mezzo minuto o chiudi l’app, poi apri Calibrazione.');return;}
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
    wakeStop('menu');
    if(closed||typeof face.behavior?.showPanel!=='function')return;
    if(calibrating){cancelCalibration();return;}
    const run=fn=>()=>{if(closed)return;closeMenu();fn();};
    const items=[
      {label:voice?.active?'Chiudi voce':'Parla',action:run(toggleVoice)},
      // «Menu host» here and «Movimenti» near the end, where «Menu host» was (owner, 19 Nov 2026: «sposta menu movimenti
      // al posto di menu host»).
      ...(typeof robot.ui.openDrawer==='function'?[{label:'Menu host',action:()=>{closeMenu();hostDrawer();}}]:[]),
      // «Hardware: sì» is not shown once it is on (owner, 15 Nov 2026: «se non serve togli la voce di menu hardware
      // verificato»): it stays the robot's safety check, and comes back in the menu whenever it is off (after a reset).
      // The host's small drawer keeps it as before.
      ...switches.filter(({key})=>key!=='verified'||Preference.get('robottino','verified')!==true).map(({key,short,label,message})=>({label:`${short}: ${Preference.get('robottino',key)===true?'sì':'no'}`,action:()=>{
        if(closed)return;
        if(Preference.get('robottino',key)===true){switchOff(key,label);openMenu();return;}
        if(key==='calibrated'){closeMenu();startCalibration();return;}
        askSwitch(key,label,message,openMenu);
      }}))
    ];
    if(loadNetworks(Preference).length>=2)items.push({label:`Rete: ${networkName()}`,action:run(switchNetwork)});
    if(Modules.has('embedded:io/serial'))items.push({label:`K210: ${k210?'sì':'no'}`,action:run(()=>{
      const on=!k210;try{Preference.set('robottino','k210',on);}catch{}
      if(on){k210Open();say(k210?'Camera K210: accesa. Ascolto sulla porta C.':'Camera K210: porta seriale non disponibile.');}
      else{k210Close();say('Camera K210: spenta.');}
    })});
//     items.push({label:`LEGO: ${lego?'sì':'no'}`,action:run(()=>{
//       if(lego){legoClose();try{Preference.set('robottino','lego',false);}catch{}say('LEGO: spento.');return;}
//       if(legoOpen()){try{Preference.set('robottino','lego',true);}catch{}}
//     })});

//     // Both motors forward at 30% for one second (then the robot stops them): only with the hub ready. The menu holds 12
//     // buttons, so it takes the place of the temporary duplex test (already done, 14 Nov 2026) and «Chiudi» stays.
//     if(lego?.state==='ready')items.push({label:'Prova motori LEGO',action:run(()=>{if(!lego?.drive(30,30,1000))say('LEGO: motori non pronti.');})});
    if(Modules.has('embedded:io/i2c'))items.push({label:`Rover: ${rover?'sì':'no'}`,action:run(()=>{
      // Off: following with the rover is off with it, for good (not back by itself at the next start), and the iPhone is told.
      if(rover){roverClose();try{Preference.set('robottino','rover',false);Preference.set('robottino','roverFollow',false);}catch{}say('Rover: spento.');live?.hello?.();return;}
      if(roverOpen()){try{Preference.set('robottino','rover',true);}catch{}say(tofOpen()?'Rover: collegato, con il sensore di ostacoli.':'Rover: collegato.');live?.hello?.();}
    })});
    // A small turn on the spot (no edge of the desk to fall from), then the robot stops it. The menu holds 12 buttons,
    // so it takes the place of the temporary duplex test and «Chiudi» stays.
    if(rover?.state==='ready')items.push({label:'Prova rover',action:run(()=>{const result=roverMove('turnRight',600);if(result!=='ok')say(result==='lifted'?'Rover: prima rimettimi giù.':'Rover: non risponde.');})});
    else if(Modules.has('robottino-voice-device')&&soundProbe)items.push({label:'Prova duplex',action:run(testDuplex)}); // TEMPORARY
    // «NFC: sì/no» (21 Nov 2026). The menu shows 12 buttons and four more follow: shown only while they all fit, so
    // «Chiudi» never goes (only with «Hardware: no», two networks and a test button together is there no room).
    if(nfc.available&&items.length<8)items.push({label:`NFC: ${nfc.on?'sì':'no'}`,action:run(()=>{
      const on=!nfc.on;try{Preference.set('robottino','nfc',on);}catch{}nfc.set(on);
      say(on?'NFC: acceso. Appoggia una scheda al robot.':'NFC: spento.');
    })});
    if(Modules.has('robottino-live-device'))items.push({label:'Live iPhone',action:run(connectLive)});
    if(Modules.has('robottino-pairing-device'))items.push({label:'Abbina app',action:run(startPairing)});
    items.push({label:`Movimenti: ${tracker.enabled?'sì':'no'}`,action:run(toggleMotion)});
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
    wakeTurn(now);
    if(diagAt!==undefined&&now>=diagAt){diagAt=undefined;writeDiag();}
    // The red dot on the screen while a conversation is open (face.js setCallDot).
    {const calling=!!voice?.active;if(calling!==callDotOn){callDotOn=calling;try{face.behavior.setCallDot?.(face,calling);}catch{}}}
    lights.update({voice:voice?.phase,pairing:!!pairing?.active,reminder:reminderLit,live:remoteDriving(),angry:faceAngry,watching:!!live?.selfActive||!!ear},now);
    if(!!voice?.active!==talking){
      talking=!talking;try{live?.hello?.();}catch{}
      // A conversation: the head looks at the owner (straight, 25° up: sitting close, the face is above the robot);
      // at its end it goes back straight (owner, 9 Nov 2026).
      // Following a face by itself, the robot is already looking at the owner: the head stays there when a conversation
      // opens (13 Nov 2026: put straight up, it lost the face it had) and when it ends.
      const following=!!live?.selfAvailable,seen=following&&live.selfSeenMs<10000;
      if(talking)lookUpWanted=!seen;else{lookUpWanted=false;homeAfterLive=!following;}
    }
    // The iPhone's video (Live page, hand gestures) gives the camera's memory back while a conversation opens, as
    // following alone does; it comes back when the conversation is ready (live-device.js videoSync).
    if(live?.videoSync&&!selfSwitching){
      const hold=!!voice?.active&&!voiceReady;
      if(hold!==videoHold){videoHold=hold;live.videoHeld=hold;selfSwitching=true;void Promise.resolve().then(()=>live.videoSync(selfFollowWanted()&&!!live.selfAvailable)).catch(()=>{}).finally(()=>{selfSwitching=false;});}
    }
    if(live?.selfAvailable&&!selfSwitching&&now>=selfRetryAt){
      const want=selfFollowWanted(),device=live;
      // On only when nothing else has the camera; off only when this conversation switched it on (not the iPhone's).
      if(want!==device.selfActive&&(want||!cameraFollow)){
        selfSwitching=true;if(typeof trace==='function')trace(`[robottino] self ${want?'on':'off'}\n`);
        void device.self(want).catch(error=>{
          // «cancelled»: the camera of the link that just ended was still closing (a Wi-Fi drop makes a new link): asked
          // again in a second, not in five (14 Nov 2026: fifteen seconds with no camera after one drop).
          selfRetryAt=clock.now()+(/cancelled/.test(String(error?.message??error))?1000:5000);if(typeof trace==='function')trace(`[robottino] self refused ${error?.message??error}\n`);}).finally(()=>{selfSwitching=false;});
      }
    }
    {
      const sleeping=!!live?.selfActive&&live.selfAloneMs>=K.ALONE_SLEEP_MS&&!voice?.active&&!remoteDriving()&&alertUntil===undefined&&!calibrating&&!dance.active&&!remoteDance&&!touchMotion&&!carried;
      if(sleeping!==asleep){
        asleep=sleeping;asleepSince=asleep?now:undefined;if(typeof trace==='function')trace(`[robottino] ${asleep?'asleep: nobody for 30 s':'awake'}\n`);
        // Asleep, the head goes back to where it rests (straight, LOOK_UP up: where a person sitting at the desk is) and
        // stays there (owner, 14 Nov 2026: «mi sono risieduto ed è rimasto con la testa in alto»: it had fallen asleep
        // looking at where he had stood). Whoever sits down again is then in front of the camera.
        if(asleep){tracker.clearTarget();if(tracker.enabled&&!motionFault)tracker.lookAt(0,-LOOK_UP,now);}
        try{robot.face.setEyeOpen('left',asleep?0:1);robot.face.setEyeOpen('right',asleep?0:1);}catch{}
      }
    }
    if(sense){
      try{
        const reading=imu.sample,move=headMove,arrived=now>=move.start+arriving()*1000+K.SETTLE_MS,still=arrived&&headSettled();
        if(tracker.enabled&&!motionFault&&!arming&&!calibrating)posedSince??=now;else posedSince=undefined;
        const event=sense.update(reading?.accelerometer,reading?.gyroscope,{pitch:headNow(now).p,slack:arrived?0:Math.abs(move.to.p-move.from.p),still,posed:posedSince!==undefined&&now-posedSince>=K.POSED_AFTER_MS},now);
        if(event)motionEvent(event);
        phraseTurn(now);
        // TEMPORARY (first days of the motion sensor): every 5 s the state and the largest readings, with the head still
        // and (after the bar) with the head moving, to set the thresholds of motion-sense.js from what the robot really
        // feels: tilt in degrees, gravity's error in hundredths of g, turn in degrees a second; then gravity as read
        // now (hundredths of g: across, up, back) and the head's pitch in degrees.
        const seen=imuSeen;
        if(still){if(sense.tilt>seen.tilt)seen.tilt=sense.tilt;if(sense.off>seen.off)seen.off=sense.off;if(sense.turn>seen.turn)seen.turn=sense.turn;}
        else{if(sense.off>seen.movingOff)seen.movingOff=sense.off;if(sense.turn>seen.movingTurn)seen.movingTurn=sense.turn;}
        if(now-imuShownAt>=5000&&typeof trace==='function'){
          imuShownAt=now;const a=reading?.accelerometer,g=value=>Math.round(value/9.80665*100);
          trace(`[robottino] imu ${sense.state} tilt ${Math.round(seen.tilt*57.3)} off ${Math.round(seen.off*100)}|${Math.round(seen.movingOff*100)} turn ${Math.round(seen.turn)}|${Math.round(seen.movingTurn)} g ${a?g(a.x)+','+g(a.y)+','+g(a.z):'-'} head ${Math.round(headNow(now).p*57.3)}${posedSince===undefined?' unposed':''}\n`);
          seen.tilt=seen.off=seen.turn=seen.movingOff=seen.movingTurn=0;
        }
      }catch{}
    }
    try{earTurn(now);}catch{}
    try{if(gaze.tick(now,{watching:!!live?.selfActive,seenMs:live?.selfActive?live.selfSeenMs:Infinity,talking:!!voice?.active,busy:closed||asleep||!!wake||!!calibrating||poweringOff()||!!touchSoundPlaying||!!speaking||remoteBusy()})){
      if(typeof trace==='function')trace('[robottino] gaze call: looked at for 10 s\n');earClose();voiceDiag('gaze');toggleVoice();
    }}catch{}
    // Every question to the NFC reader holds JavaScript (up to 80 ms measured on the robot with the field switched on
    // each time; the field now stays on): only with nothing going on that sound, the servos or the iPhone need.
    // Following a face alone and sleep do not count (21 Nov 2026: asleep after 30 s alone, the first try read nothing).
    try{const seen=nfc.tick(now,{busy:closed||!!wake||!!calibrating||poweringOff()||!!touchSoundPlaying||!!speaking||remoteBusy()||!!voice?.active||dance.active||posePending});
      if(seen)say(seen.uid?`Scheda NFC: ${seen.uid}`:seen.problem==='missing'?'NFC: lettore non trovato.':'NFC: il lettore non risponde. Riprovo tra un minuto.');
    }catch{}
    // The log goes to the card when nothing is waiting on the servos and Robottino is not speaking (the card shares
    // a pin with the screen and a write holds JavaScript for a moment).
    if(sdLog&&!posePending&&voice?.phase!=='speaking')try{sdLog.flush(sdLog.waiting>3000);}catch{}
    try{k210?.tick();}catch{}
    if(rover)try{roverTurn(now);}catch{}
    try{explore.turn(now);}catch{}
    try{climateTurn(now);}catch{}
    try{tofTurn(now);}catch{}
    try{presenceTurn(now);}catch{}
    try{parkTurn(now);}catch{}
    if(wifiProbe&&now-wifiShownAt>=5000&&typeof trace==='function'){wifiShownAt=now;try{trace(`[robottino] wifi ${wifiProbe.wifiInfo()}\n`);}catch{}}
    // TEMPORARY (14 Nov 2026, «verifica se è possibile aumentare la RAM»): the robot's two memories, every 30 s.
    if(typeof wifiProbe?.memoryInfo==='function'&&!(now-memoryShownAt<30000)&&typeof trace==='function'){memoryShownAt=now;try{trace(`[robottino] memory ${wifiProbe.memoryInfo()}\n`);}catch{}}
    if(!(now-timeCheckedAt<60000)){timeCheckedAt=now;applyItalianTime();}
    if(calibrating?.phase==='measure')readHead(now);
    else if(calibrating?.phase==='check'&&motionFault)finishCalibrationCheck(); // a pose watchdog fired during the check
    // Motions on by default (owner's request, 9 Nov 2026): at start, once hardware and head calibration are confirmed.
    // Not while the first connections open (TLS handshake): the straightening move would wait for its replies.
    if(autoArmAt!==undefined&&now>=autoArmAt&&headQuiet()){
      autoArmAt=undefined;
      if(headCal&&!calibrating&&!tracker.enabled&&!motionFault&&Preference.get('robottino','verified')===true&&Preference.get('robottino','calibrated')===true&&Preference.get('robottino','motionsOff')!==true){autoArmTries++;calDiag('autoarm');toggleMotion(true);}
    }
    // While Robottino wakes up, at every turn (owner, 14 Nov 2026: «quando ha gli occhi chiusi si vede il viso bluastro»):
    // the yawn is the first sound after the start, and the face is looked at closely then.
    if(now-lastScreenCheck>=(wake?100:voice?.active||touchSoundPlaying?500:2000)){lastScreenCheck=now;restoreScreenColours();}
    if(headArmed&&headPeak>=K.HEAD_GATE&&longPress.tick(now)){voiceDiag('long');toggleVoice();}
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
    // During a conversation the speaker is the call's: the agent says it instead (voice-device.js notice).
    // A conversation that starts after the light came on puts it out (one already going when it came on does not).
    if(reminderLit){if(!voice?.active)reminderInCall=false;if(voice?.active&&!reminderInCall||now-reminderLitAt>=K.REMINDER_LIGHT_MS)reminderLit=false;}
    for(const fired of reminders.due(now)){alert(fired.text);lightReminder();if(voice?.active)voice.notice?.(fired.text);}
    // Clock-time reminders, once a second, against the network's clock (reminders.js ClockReminders).
    if(!(now-clockCheckedAt<1000)){
      clockCheckedAt=now;const fired=clockReminders.due(Date.now());
      if(fired.length){saveClockReminders();for(const item of fired){if(typeof trace==='function')trace(`[robottino] reminder said, ${Math.round((Date.now()-item.item.at)/1000)} s after its time, ${voice?.active?'by the agent':'with the sound'}\n`);alert(item.text);lightReminder();if(voice?.active)voice.notice?.(item.text);}}
    }
    if(alertUntil!==undefined&&now>=alertUntil){alertUntil=undefined;if(!voice?.active)setMood('neutral');}
    // The smile stays FACE_HOLD_MS after Robottino has finished the sentence it says with it (12 Nov 2026: «quando
    // dico torna felice deve tornare con il viso felice»): while it talks the face is the serene one with the talking
    // mouth, so a smile counted from the command was over before anyone saw it. Sad and angry (Infinity) stay.
    if(faceHoldUntil!==undefined&&faceHoldUntil!==Infinity&&faceHoldUntil!==forceFaceUntil&&voice?.speaking)faceHoldUntil=Math.max(faceHoldUntil,now+K.FACE_HOLD_MS);
    if(faceHoldUntil!==undefined&&now>=faceHoldUntil&&(!voice?.speaking||faceHoldUntil===forceFaceUntil)){faceHoldUntil=undefined;setMood('neutral');}
    if(arming&&now-armingStarted>=1200)failMotion('Attivazione non confermata: movimenti bloccati.');
    if(posePending){
      // TEMPORARY diagnostics: how long it waited, when the command left for the host (h, - if it never did), the
      // longest loop gap meanwhile and what was going on.
      // Not confirmed by the servos within 1.2 s: blocked, as before. Confirmed, but the robot's own bookkeeping has
      // not finished after POSE_DONE_MS: something is stuck, and a pose never left pending without a word.
      const waited=now-poseStarted,note=`w${Math.round(waited)} h${poseSentAt===undefined?'-':Math.round(poseSentAt-poseStarted)} g${Math.round(loopGap)} v=${voice?.phase??'-'} f=${cameraFollow?1:0} q=${headQuiet()?1:0}`;
      if(!poseConfirmed&&waited>=1200)failMotion('Movimento non confermato: nuovi movimenti bloccati.',note);
      else if(poseConfirmed&&waited>=K.POSE_DONE_MS)failMotion('Movimento non concluso: nuovi movimenti bloccati.',note);
      return;
    }
    // Camera switching, a connection opening, the conversation starting or changing between microphone and speaker
    // (headQuiet): no head command now, it waits for the next turn.
    if(!headQuiet()){
      // TEMPORARY (14 Nov 2026, owner: «apre gli occhi però non si gira verso di me»; on the card: ten stops of the look
      // around chosen after a voice, and the head never moved): the head has somewhere to go and is being held: why.
      // (Not while it sleeps with its ears open: there the head is meant to stay still.)
      if(tracker.target&&!(asleep&&ear)&&!(now-heldShownAt<3000)&&typeof trace==='function'){heldShownAt=now;trace(`[robottino] head held: phrase=${speaking?1:0} ears=${ear?1:0} camera=${live?.busy?.()?1:0} net=${socketModule?.connecting?.()?1:0} audio=${voice?.busy?.()?1:0} asleep=${asleep?1:0}\n`);}
      return;
    }
    if(lookUpWanted){
      // With the iPhone connected too (11 Nov 2026: with the app open, which follows the face during a conversation, the
      // head stayed down and the camera could not find the face above it; owner: «a volte non alza più la testa»).
      // Following a face by itself, the robot is already looking at the owner (or for them): no fixed look up.
      if(!tracker.enabled||motionFault||live?.selfActive){lookUpWanted=false;}
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
    if(voiceRetry&&!posePending){const retry=voiceRetry;voiceRetry=undefined;if(!voiceLook(retry.direction,retry.full,retry.until)){lookRefused++;if(spoken?.key==='head:'+retry.direction)spoken.result=refusal();say('Ora non posso muovere la testa.');}}
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
    if(remoteDriving()&&!followingFace())return;
    if(followingFace()&&now<followPausedUntil)return; // a spoken head command is being held (voiceLook)
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
        const gentle=K.FOLLOW_GENTLE&&!dance.active&&!cameraFollow;
        return setHeadPose(value.rotation,gentle?K.FOLLOW_MOVE_S:undefined,()=>{if(pendingPose===token)posePending=false;},gentle?K.FOLLOW_MOVE_SPEED:undefined);
      }).catch(error=>{if(!closed&&pendingPose===token)failMotion('Errore del movimento: nuovi movimenti bloccati.',error);})
        .finally(()=>{if(pendingPose===token){pendingPose=undefined;posePending=false;}});
    }
  },100);
  // Face positions over Bluetooth (the upstream example this MOD grew from: a page with MediaPipe says where the face
  // is) only when switched on on the robot: preference bleTracking true (14 Nov 2026). Until then the session was
  // opened at every start and kept the robot's Bluetooth on for good: its advertising shares the one radio with the
  // Wi-Fi, and its memory comes out of the internal RAM, the one the conversation and the camera run short of. Neither
  // the app nor the robot's own following uses it.
  if(Preference.get('robottino','bleTracking')===true)void (async()=>{
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
  // Waking up (above, wakeTurn): off with the preference wakeUp false; without it, what waited goes now.
  if(Preference.get('robottino','wakeUp')!==false)try{wakeStart();}catch{wake=undefined;}
  if(!wake)wakeDone();
}
export function onUnload(){running?.close();running=undefined;}
