// SPDX-License-Identifier: MIT
// Source cadence: Copyright (c) 2026 M5Stack Technology CO LTD; license in vendor/LICENSE-m5stack.
// Inspired by M5Stack's DanceModifier::Happy cadence (500/800/.../500ms).
// Original controller for Moddable; reduced relative angles, no factory units/speed values.
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const YAW=Math.PI/2,UP=85*Math.PI/180; // the robot's head limits (calibration.js HEAD_LIMITS)
const steps=[[0,0],[500,0],[1300,.15],[2100,-.15],[2900,.15],[3700,-.15],[4200,0]];
export class DanceController {
  constructor(){this.active=false;}
  start(now,pose){
    if(this.active||!Number.isFinite(now)||!pose||![pose.y,pose.p].every(Number.isFinite))return false;
    this.base={y:clamp(pose.y,-YAW,YAW),p:clamp(pose.p,-UP,0),r:0};
    this.position={...this.base};this.started=now;this.last=now;this.active=true;return true;
  }
  sample(now){
    if(!this.active)return null;
    if(!Number.isFinite(now)||now<this.last){this.stop();return null;}
    const elapsed=Math.max(0,now-this.started),dt=clamp((now-this.last)/1000,0,.2);this.last=now;
    let offset=0;
    for(let i=1;i<steps.length;i++)if(elapsed<steps[i][0]){
      const a=steps[i-1],b=steps[i],t=clamp((elapsed-a[0])/(b[0]-a[0]),0,1);
      offset=a[1]+(b[1]-a[1])*t;break;
    }
    const target=clamp(this.base.y+offset,-YAW,YAW);
    this.position.y+=clamp(target-this.position.y,-3*dt,3*dt); // the one head speed (calibration.js HEAD_SPEED), above the dance's own pace
    if(elapsed>=4200 && Math.abs(this.position.y-this.base.y)<.001)this.active=false;
    // A stalled scheduler may leave a partially completed move: hold rather than loop forever.
    if(elapsed>=6000)this.active=false;
    return {...this.position};
  }
  stop(){this.active=false;}
}
