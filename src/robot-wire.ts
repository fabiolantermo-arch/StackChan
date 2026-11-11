// conversation: the robot is in a voice conversation (the iPhone, if open, then follows the face, 9 Nov 2026).
export type RobotCaps={hardwareVerified:boolean;calibrated:boolean;motion:boolean;camera:boolean;audio:boolean;screen:boolean;simulated?:boolean;conversation?:boolean};
export const actions=['camera.start','camera.stop','call.start','call.stop','screen.start','screen.stop','motion','mirror','face.style','dance','track.start','track.stop','track','stop'] as const;
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
  return {hardwareVerified:value.hardwareVerified,calibrated:value.calibrated,motion:value.motion,camera:value.camera,audio:value.audio,screen:value.screen,simulated:value.simulated===true,conversation:value.conversation===true};
}
export function command(value:any):boolean {
  if(!value||value.type!=='command'||typeof value.id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(value.id)||!actions.includes(value.action))return false;
  if(value.action==='face.style' && !['portrait','white','redhead'].includes(value.style))return false;
  if(value.action==='dance' && !danceSteps(value.steps))return false;
  // Head control from the iPhone (owner's choice, 9 Nov 2026): up to 46° sideways and 30° up, never below
  // straight ahead, the robot's own safety limits (yaw ±0.8 rad, pitch −0.52…0). Mirror and dances stay ±10°.
  if(value.action==='motion'&&!(Number.isFinite(value.yaw)&&Math.abs(value.yaw)<=HEAD_LIMITS.yaw&&Number.isFinite(value.pitch)&&value.pitch<=0&&value.pitch>=-HEAD_LIMITS.up))return false;
  if(value.action==='mirror'&&!['yaw','pitch'].every(k=>Number.isFinite(value[k])&&Math.abs(value[k])<=10))return false;
  if(value.action==='mirror'&&(!['leftEye','rightEye','mouth'].every(k=>Number.isFinite(value[k])&&value[k]>=0&&value[k]<=1)||typeof value.followHead!=='boolean'))return false;
  // Face following: where the iPhone found the face in one robot camera frame (0…1, y from the top).
  if(value.action==='track'&&(!Number.isInteger(value.frameId)||value.frameId<1||value.frameId>0xffffffff||!['x','y'].every(k=>Number.isFinite(value[k])&&value[k]>=0&&value[k]<=1)))return false;
  return true;
}
// RB, version1, kind (1 camera RGB565LE, 2 screen RGB565LE 160x120, 3 call audio: bytes B1 08 then 8 kHz mono µ-law,
// 4 camera piece and 5 full-resolution screen piece: frame32BE, offset32BE, bytes),
// sequence32BE, width16BE, height16BE, payload. Media is never stored.
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
  else if(![1,2].includes(kind)||!width||!height||width>(kind===1?320:160)||height>(kind===1?240:120)||buffer.byteLength!==12+width*height*2)return null;
  return {kind,sequence,width,height};
}
