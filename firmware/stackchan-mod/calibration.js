// Head calibration (K151, 9 Nov 2026). The host turns a head rotation into servo positions with fixed
// centres (yaw 460, pitch 620; 0.32 steps per 0.1°) and its own pitch range (5…85°). On this robot the
// pitch servo refused the host's rest position: its reply carries an "angle limit" flag that the host
// mistakes for an echo and drops (protocols/scservo.ts), so the command is never confirmed and the MOD
// blocks the motors. The MOD widens the host's limits (manifest "config", raw 0…1000) and applies its own:
// the centre and both end stops of each axis, measured with the motors off by moving the head by hand.
// Every pose goes through toHost() before it reaches the host.
export const ZERO={yaw:460,pitch:620}; // host centres (platform m5stackchan_cores3)
const STEP=16/5/10,TENTH=1800/Math.PI;  // servo steps per 0.1° and 0.1° per radian, as the host computes them
export const MARGIN=12; // servo steps (about 4°) kept away from each measured end stop
// Until the head is calibrated: exactly the host's own limits (yaw ±128°, pitch 5…85°).
export const HOST_LIMITS={yaw:{center:460,lo:51,hi:869,sign:1},pitch:{center:620,lo:636,hi:892,sign:1}};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
// The host's 0.1° value that lands on servo offset d: trunc(trunc(rotation·TENTH)·STEP) = d.
const tenthsFor=d=>{let a=Math.round(d/STEP);while(Math.trunc(a*STEP)<d)a++;while(Math.trunc(a*STEP)>d)a--;return a;};
const radians=a=>(a+.5*Math.sign(a))/TENTH||0; // half a tenth inside, so the host's trunc gives back a
// Servo positions → the rotation the host must receive to reach them.
export function hostRotation(raw){return {y:radians(tenthsFor(raw.yaw-ZERO.yaw)),p:-radians(tenthsFor(raw.pitch-ZERO.pitch))||0,r:0};}
// The host's reading (rotation from the servo positions, truncated to 0.1°) → servo positions, ±0 steps.
export function rawFromHost(rotation){
  const back=a=>a>=0?Math.ceil(a*STEP-1e-9):Math.floor(a*STEP+1e-9);
  return {yaw:ZERO.yaw+back(Math.round(rotation.y*TENTH)),pitch:ZERO.pitch+back(Math.round(-rotation.p*TENTH))};
}
// The robot's own safety limits for every pose (radians): 90° sideways and up to 85° (the host's own top), never
// below straight ahead (the K151 head cannot look down). Owner's request, 9 Nov 2026: «a destra e a sinistra di
// 90 gradi, e in alto anche». The measured range (calibration) is always the narrower limit.
export const HEAD_LIMITS={yaw:Math.PI/2,up:85*Math.PI/180};
export function safeRotation(rotation){return {y:clamp(rotation.y,-HEAD_LIMITS.yaw,HEAD_LIMITS.yaw),p:clamp(rotation.p,-HEAD_LIMITS.up,0),r:0};}
// A servo refused a position inside the measured range: its own memory holds a narrower limit (set at the
// factory). That end of the range moves NARROW steps (about 2.5°) back towards the centre. Undefined when the
// refused position is the centre itself, or when the range would come closer than MIN_REACH steps (about 6°).
export const NARROW=8,MIN_REACH=20;
export function narrowRange(cal,raw){
  const next={yaw:{...cal.yaw},pitch:{...cal.pitch}};let changed=false;
  for(const axis of ['yaw','pitch']){
    const a=next[axis],value=raw[axis];if(value===a.center)continue;
    if(value>a.center){const hi=Math.min(a.hi,value)-NARROW;if(hi<a.center+MIN_REACH)return undefined;a.hi=hi;}
    else{const lo=Math.max(a.lo,value)+NARROW;if(lo>a.center-MIN_REACH)return undefined;a.lo=lo;}
    changed=true;
  }
  return changed?next:undefined;
}
// The K151's yaw servo turns the other way from the convention of the MOD and the app (positive yaw = the robot's
// left, as upstream). Seen on the robot on 9 Nov 2026: the owner's joystick moved the head the wrong way and face
// following turned away from the face (face on the right of the frame, head turned left). The yaw is reversed
// here, between the MOD's rotation and the servo positions, so every motion (commands, following, imitation,
// dances) keeps the same convention; the measured range (lo, hi) is in servo positions and does not change.
export const YAW_SERVO=-1;
// A head rotation of the MOD (radians from the calibrated centre; negative pitch = look up) → servo
// positions inside the calibrated range → the rotation for the host.
export function servoPositions(rotation,cal=HOST_LIMITS){
  if(![rotation?.y,rotation?.p].every(Number.isFinite))throw Error('invalid_pose');
  const axis=(value,a)=>clamp(Math.round(a.center+a.sign*value*TENTH*STEP),a.lo,a.hi);
  return {yaw:axis(YAW_SERVO*rotation.y,cal.yaw),pitch:axis(-rotation.p,cal.pitch)};
}
export function toHost(rotation,cal=HOST_LIMITS){return hostRotation(servoPositions(rotation,cal));}
// Servo positions → the MOD's head rotation (radians from the calibrated centre; negative pitch = up).
export function rotationFromRaw(raw,cal=HOST_LIMITS){
  const back=(v,a)=>a.sign*(v-a.center)/(TENTH*STEP);
  return {y:YAW_SERVO*back(raw.yaw,cal.yaw)||0,p:-back(raw.pitch,cal.pitch)||0,r:0};
}
// Where a pose really lands: inside the robot's limits and the calibrated range.
export function reachable(rotation,cal=HOST_LIMITS){return rotationFromRaw(servoPositions(safeRotation(rotation),cal),cal);}
// One head speed for every motion (owner, 9 Nov 2026: «in certi momenti va veloce e in altri piano, scegli una
// velocità media», then «aumenta al massimo la velocità dei servomotori»): 3 rad/s, about 170° a second, the fastest
// the K151 micro servos follow with the head on them, so where the head should be stays where it really is. Measured
// from where the head is, never less than MIN_MOVE seconds: one tick of the main loop, so a stream of small steps
// (face following) ends each step as the next one starts.
export const HEAD_SPEED=3,MIN_MOVE=.1;
export function moveTime(from,to,minimum=MIN_MOVE){
  const d=Math.hypot(to.y-from.y,to.p-from.p);
  return Number.isFinite(d)?Math.max(minimum,d/HEAD_SPEED):NaN;
}
const position=v=>Number.isInteger(v)&&v>=0&&v<=1000;
// Measured by hand: the head straight (twice: at the start and at the end), fully up, fully down,
// fully to the left and to the right. Returns {calibration} or {error}.
export function fromMeasurements({center,again,up,down,left,right}){
  const all=[center,again,up,down,left,right];
  if(!all.every(m=>m&&position(m.yaw)&&position(m.pitch)))return {error:'reading'};
  if(Math.abs(center.yaw-again.yaw)>15||Math.abs(center.pitch-again.pitch)>15)return {error:'center_moved'};
  const pitchSpan=Math.abs(up.pitch-down.pitch),yawSpan=Math.abs(left.yaw-right.yaw);
  if(pitchSpan<2*MARGIN+40)return {error:'pitch_range'};
  if(yawSpan<2*MARGIN+100)return {error:'yaw_range'};
  const range=(a,b)=>({lo:Math.min(a,b)+MARGIN,hi:Math.max(a,b)-MARGIN});
  const yaw=range(left.yaw,right.yaw),pitch=range(up.pitch,down.pitch);
  const middle=(a,b)=>Math.round((a+b)/2);
  const centre={yaw:middle(center.yaw,again.yaw),pitch:middle(center.pitch,again.pitch)};
  // Straight ahead must lie between the end stops (it may be close to the lower one).
  if(centre.yaw<Math.min(left.yaw,right.yaw)||centre.yaw>Math.max(left.yaw,right.yaw))return {error:'yaw_center'};
  if(centre.pitch<Math.min(up.pitch,down.pitch)-5||centre.pitch>Math.max(up.pitch,down.pitch)+5)return {error:'pitch_center'};
  return {calibration:{
    yaw:{center:clamp(centre.yaw,yaw.lo,yaw.hi),lo:yaw.lo,hi:yaw.hi,sign:1}, // left/right keep the host's direction
    pitch:{center:clamp(centre.pitch,pitch.lo,pitch.hi),lo:pitch.lo,hi:pitch.hi,sign:up.pitch>down.pitch?1:-1}
  }};
}
// Version 2 (9 Nov 2026): the check after the measurements reaches 90° and 85°. A calibration saved before was
// checked only up to 46° and 30°, so it is not used: the owner measures once more.
export const CAL_VERSION=2;
export function storeCalibration(cal){return JSON.stringify({v:CAL_VERSION,yaw:cal.yaw,pitch:cal.pitch});}
// A stored calibration (Preference string) → the calibration, or undefined if missing, damaged or older.
export function parseCalibration(text){
  try{
    const value=JSON.parse(text),ok=a=>a&&[a.center,a.lo,a.hi].every(position)&&a.lo<a.hi&&a.center>=a.lo&&a.center<=a.hi&&(a.sign===1||a.sign===-1);
    return value?.v===CAL_VERSION&&ok(value.yaw)&&ok(value.pitch)?{yaw:{...value.yaw},pitch:{...value.pitch}}:undefined;
  }catch{return undefined;}
}
// A servo command whose confirmation is lost is repeated once (mod.js setHeadPose). Until 10 Nov 2026 the repeat
// left at once: in a conversation the same command was judged lost twice within a quarter of a second, and the
// motors were blocked («Errore nella danza remota», at the start of the robot's reply). Whatever held up the first
// confirmation was still there for the second. So the one repeat waits for a quiet moment: 20 ms timers, each
// saying how late it fired. Three in a row on time (JavaScript is free again), or 400 ms in all, and the repeat
// goes: with two commands of at most a quarter of a second each, still inside the 1.2 s pose watchdog of mod.js.
export const RETRY_STEP_MS=20,RETRY_CALM_LATE_MS=15,RETRY_CALM_STEPS=3,RETRY_MAX_MS=400;
export class CalmWait {
  constructor(now){this.from=now;this.last=now;this.calm=0;this.late=0;}
  // One RETRY_STEP_MS timer fired at time now: true when the repeat can go. quiet false: the robot is in the middle of
  // something that holds JavaScript up (microphone and speaker changing, the camera switching, a connection opening),
  // so this is not a quiet moment even if this one timer was on time.
  step(now,quiet=true){
    const gap=now-this.last,waited=now-this.from;this.last=now;
    if(!Number.isFinite(gap)||gap<0||waited<0)return true; // no usable clock: no more waiting, the watchdog decides
    const late=gap-RETRY_STEP_MS;if(late>this.late)this.late=late;
    this.calm=quiet&&late<=RETRY_CALM_LATE_MS?this.calm+1:0;
    return this.calm>=RETRY_CALM_STEPS||waited>=RETRY_MAX_MS;
  }
  get waited(){const waited=this.last-this.from;return Number.isFinite(waited)&&waited>0?waited:0;}
}
