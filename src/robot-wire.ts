// conversation: the robot is in a voice conversation (the iPhone, if open, then follows the face, 9 Nov 2026).
export type RobotCaps={hardwareVerified:boolean;calibrated:boolean;motion:boolean;camera:boolean;audio:boolean;screen:boolean;simulated?:boolean;conversation?:boolean;rover?:boolean;roverFollow?:boolean;gazeCall?:boolean;forceFollow?:boolean;exploring?:boolean;climate?:Climate};
// The ENV III on the robot (15 Nov 2026): °C, % and Pa, only plausible numbers pass.
export type Climate={t:number;h:number;p?:number};
export function climate(value:any):Climate|undefined{
  if(!value||!Number.isFinite(value.t)||value.t<-40||value.t>85||!Number.isFinite(value.h)||value.h<0||value.h>100)return undefined;
  const p=Number.isFinite(value.p)&&value.p>30000&&value.p<110000?{p:Math.round(value.p)}:{};
  return {t:Math.round(value.t*10)/10,h:Math.round(value.h),...p};
}
export const actions=['camera.start','camera.stop','call.start','call.stop','screen.start','screen.stop','motion','mirror','face.style','dance','track.start','track.stop','track','rover','volume','motions','roverFollow','gazeCall','gesture','sight','hand','explore','stop'] as const;
// Hand gestures the iPhone saw in the robot's video (15 Nov 2026: «riconosci i gesti»): only the name goes to the robot,
// which decides what to do (firmware live-wire.js HAND_GESTURES, app RobotHandGesture.Kind).
export const HAND_GESTURES=['thumbsUp','thumbsDown','palm','wave','victory'] as const;
// What else the iPhone saw in the robot's video (15 Nov 2026): the owner or a stranger, a smile or a serious face, a
// thing shown to the camera. Only the kind goes to the robot, with a few words for the two that need them: the
// owner's name and the thing's name (letters, spaces and apostrophes, 24 at most; firmware live-wire.js SIGHT_KINDS).
export const SIGHT_KINDS=['person','stranger','smile','serious','object'] as const;
export const SIGHT_TEXT=/^[A-Za-zÀ-ÖØ-öø-ÿ' ]{1,24}$/;
export const sightText=(kind:unknown,text:unknown)=>kind==='person'||kind==='object'?typeof text==='string'&&SIGHT_TEXT.test(text)&&text.trim().length>0:text===undefined;
// The rover under the robot, from the iPhone's keys (14 Nov 2026): the robot's own directions (firmware live-wire.js
// ROVER_REMOTE_MOVES) and a short move each; the app sends the next while a key is held, and the robot stops it by itself.
export const ROVER_MOVES=['forward','back','left','right','turnLeft','turnRight','stop','gripOpen','gripHalf','gripClose'] as const; // the last three: the rover's gripper open, half closed, closed
export const ROVER_MS={min:200,max:1500} as const;
// Speaker volume from the iPhone's Robot tab (15 Nov 2026): a whole level 1…10, mapped to the amplifier by the robot
// (firmware live-wire.js VOLUME, never above its 252).
export const VOLUME_LEVELS={min:1,max:10} as const;
export const HEAD_LIMITS={yaw:90,up:85} as const; // degrees, head control from the iPhone (owner, 9 Nov 2026: 90° to each side, up to the host's 85°)
export const expressions=['neutral','happy','sad','blink','talk-small','talk-open'] as const;
export type DanceStep={yaw:number;pitch:number;durationMs:number;expression:typeof expressions[number]};
// Same limits as the iPhone Studio: ±10°, 300–5000 ms per step, 32 steps, 60 s total.
export function danceSteps(value:any):DanceStep[]|null {
  if(!Array.isArray(value)||value.length<1||value.length>32)return null;
  let total=0;const steps:DanceStep[]=[];
  for(const s of value){
    if(!s||typeof s!=='object'||![s.yaw,s.pitch].every(n=>Number.isFinite(n)&&Math.abs(n)<=10)||!Number.isInteger(s.durationMs)||s.durationMs<300||s.durationMs>5000||!expressions.includes(s.expression))return null;
    total+=s.durationMs;steps.push({yaw:s.yaw,pitch:s.pitch,durationMs:s.durationMs,expression:s.expression});
  }
  return total<=60000?steps:null;
}
export type Action=typeof actions[number];
export function caps(value:any):RobotCaps|null {
  if(!value||!['hardwareVerified','calibrated','motion','camera','audio','screen'].every(k=>typeof value[k]==='boolean'))return null;
  return {hardwareVerified:value.hardwareVerified,calibrated:value.calibrated,motion:value.motion,camera:value.camera,audio:value.audio,screen:value.screen,simulated:value.simulated===true,conversation:value.conversation===true,rover:value.rover===true,roverFollow:value.roverFollow===true,gazeCall:value.gazeCall===true,forceFollow:value.forceFollow===true,exploring:value.exploring===true,...(climate(value.climate)?{climate:climate(value.climate)}:{})};
}
export function command(value:any):boolean {
  if(!value||value.type!=='command'||typeof value.id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(value.id)||!actions.includes(value.action))return false;
  if(value.action==='face.style' && !['portrait','white','redhead','curly'].includes(value.style))return false;
  // camera.start may say that the iPhone can show JPEG pictures (media kind 8, 14 Nov 2026): a boolean or nothing.
  if(value.action==='camera.start'&&value.jpeg!==undefined&&typeof value.jpeg!=='boolean')return false;
  if(value.action==='dance' && !danceSteps(value.steps))return false;
  if(value.action==='volume'&&!(Number.isInteger(value.level)&&value.level>=VOLUME_LEVELS.min&&value.level<=VOLUME_LEVELS.max))return false;
  // The «Movimenti» switch of the Robot tab (15 Nov 2026): on or off, nothing else.
  // «Chiamata con lo sguardo» (21 Nov 2026) too.
  if((value.action==='motions'||value.action==='roverFollow'||value.action==='gazeCall'||value.action==='explore')&&typeof value.on!=='boolean')return false;
  if(value.action==='gesture'&&!HAND_GESTURES.includes(value.name))return false;
  if(value.action==='sight'&&!(SIGHT_KINDS.includes(value.kind)&&sightText(value.kind,value.text)))return false;
  if(value.action==='rover'&&!(ROVER_MOVES.includes(value.move)&&Number.isInteger(value.ms)&&value.ms>=ROVER_MS.min&&value.ms<=ROVER_MS.max))return false;
  // Head control from the iPhone (owner's choice, 9 Nov 2026): up to 46° sideways and 30° up, never below
  // straight ahead, the robot's own safety limits (yaw ±0.8 rad, pitch −0.52…0). Mirror and dances stay ±10°.
  if(value.action==='motion'&&!(Number.isFinite(value.yaw)&&Math.abs(value.yaw)<=HEAD_LIMITS.yaw&&Number.isFinite(value.pitch)&&value.pitch<=0&&value.pitch>=-HEAD_LIMITS.up))return false;
  if(value.action==='mirror'&&!['yaw','pitch'].every(k=>Number.isFinite(value[k])&&Math.abs(value[k])<=10))return false;
  if(value.action==='mirror'&&(!['leftEye','rightEye','mouth'].every(k=>Number.isFinite(value[k])&&value[k]>=0&&value[k]<=1)||typeof value.followHead!=='boolean'))return false;
  // Face following: where the iPhone found the face in one robot camera frame (0…1, y from the top).
  if(value.action==='track'&&(!Number.isInteger(value.frameId)||value.frameId<1||value.frameId>0xffffffff||!['x','y'].every(k=>Number.isFinite(value[k])&&value[k]>=0&&value[k]<=1)))return false;
  // The Force following the hand (23 Nov 2026): where the iPhone sees the hand across the robot camera's picture, 0…1.
  if(value.action==='hand'&&!(Number.isFinite(value.x)&&value.x>=0&&value.x<=1))return false;
  return true;
}
// RB, version1, kind (1 camera RGB565LE, 2 screen RGB565LE 160x120, 3 call audio: bytes B1 08 then 8 kHz mono µ-law,
// 4 camera piece and 5 full-resolution screen piece: frame32BE, offset32BE, bytes; 6 grey camera piece; 8 camera JPEG),
// sequence32BE, width16BE, height16BE, payload. Media is never stored.
export const JPEG_MIN=100,JPEG_MAX=24000;
export function packet(buffer:ArrayBuffer){
  if(buffer.byteLength<12||buffer.byteLength>153612)return null;
  const view=new DataView(buffer),kind=view.getUint8(3),sequence=view.getUint32(4),width=view.getUint16(8),height=view.getUint16(10);
  if(view.getUint16(0)!==0x5242||view.getUint8(2)!==1||!sequence)return null;
  if(kind===3){if(width||height||buffer.byteLength<14||buffer.byteLength>6412||(buffer.byteLength-12)%2)return null;}
  else if(kind===4||kind===5){
    if(!width||!height||width>320||height>240||buffer.byteLength<22||buffer.byteLength>32788)return null;
    const frame=view.getUint32(12),offset=view.getUint32(16),length=buffer.byteLength-20;
    if(!frame||offset%2||length%2||offset+length>width*height*2)return null;
  }
  // 6: grey camera piece for face following (9 Nov 2026), one byte per pixel, up to 160×120, robot to iPhone.
  else if(kind===6){
    if(!width||!height||width>160||height>120||buffer.byteLength<21||buffer.byteLength>4116)return null;
    const frame=view.getUint32(12),offset=view.getUint32(16),length=buffer.byteLength-20;
    if(!frame||offset+length>width*height)return null;
  }
  // 8: one camera picture as a JPEG, whole (14 Nov 2026), robot to iPhone: up to 320×240 and 24 KB, and it must begin
  // as a JPEG does. Sent by the robot only when the iPhone asked for it with camera.start.
  else if(kind===8){
    if(!width||!height||width>320||height>240||buffer.byteLength<12+JPEG_MIN||buffer.byteLength>12+JPEG_MAX||view.getUint16(12)!==0xffd8)return null;
  }
  else if(![1,2].includes(kind)||!width||!height||width>(kind===1?320:160)||height>(kind===1?240:120)||buffer.byteLength!==12+width*height*2)return null;
  return {kind,sequence,width,height};
}
