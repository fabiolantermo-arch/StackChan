// Detector-independent controller; input boxes are normalized camera coordinates.
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
/**
 * Head range while following a face, in radians: about 46° sideways (the K151 driver allows ±128°)
 * and 30° up, like the upstream UP pose. Upstream convention: negative p looks up; the K151 servo
 * angle is -p, limited to 5..85°, so p=0 (straight ahead) is already near the lower stop and the
 * head never looks down.
 */
export const FOLLOW_YAW=.8,FOLLOW_UP=.52;
// Following with the robot's own camera may turn the head as far as any command (calibration.js HEAD_LIMITS):
// 90° sideways and 85° up (owner, 9 Nov 2026). Every pose is limited again by the calibration.
export const AIM_YAW=Math.PI/2,AIM_UP=85*Math.PI/180;
// One head speed for everything (calibration.js HEAD_SPEED): 3 rad/s, about 170° a second.
export const FOLLOW_SPEED=3;
/**
 * Following with the robot's own camera (Live «Segui il mio viso», 9 Nov 2026). The camera turns with the
 * head, and the iPhone's answer arrives late (network and analysis, about half a second). So the robot keeps
 * the head pose of each frame it sends, and the face is at about that pose + (0.5 − x) · field of view: the
 * goal does not run away however late the answer is. Positive yaw turns to the robot's left (upstream
 * convention), the image is as the robot sees it, so a face on the left of the frame turns the head left.
 * GC0308 camera of the CoreS3, measured on the robot (9 Nov 2026, scene shift after known head turns, 80×60 frames):
 * 58° × 45° against the commanded angles (it had been guessed at 62° × 48°, so every step went about 6% too far);
 * sideways the same command moves a little more to the right (63° measured turning left, 53° turning right: servo
 * play). 80% of the way per answer, and offsets under about 3° are ignored, so the head rests on a still face.
 */
export const CAMERA_FOV={x:1.01,y:.79},AIM_GAIN=.8,AIM_DEADBAND=.05,AIM_HOLD_MS=1500;
export class TargetTracker {
  constructor(){this.target=null;this.sequence=-1;this.yaw=0;this.pitch=0;this.lastTick=undefined;this.enabled=false;}
  accept(box,now=Date.now()){
    if(!Number.isFinite(now)||!box||typeof box.id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(box.id)||!['x','y','confidence','sequence'].every(k=>Number.isFinite(box[k]))||box.x<0||box.x>1||box.y<0||box.y>1||box.confidence<.65||box.confidence>1||!Number.isSafeInteger(box.sequence)||box.sequence<=this.sequence||box.sequence<0)return false;
    if(this.target&&now<this.target.time)return false;
    if(this.target&&now-this.target.time<1000&&box.id!==this.target.id)return false;
    this.sequence=box.sequence;this.target={...box,time:now};return true;
  }
  aim(x,y,pose,now=Date.now()){
    if(!Number.isFinite(now)||![x,y].every(v=>Number.isFinite(v)&&v>=0&&v<=1)||!pose||![pose.y,pose.p].every(Number.isFinite))return false;
    if(this.target&&now<this.target.time)return false;
    const yaw=clamp(pose.y+(.5-x)*CAMERA_FOV.x*AIM_GAIN,-AIM_YAW,AIM_YAW),pitch=clamp(pose.p-(.5-y)*CAMERA_FOV.y*AIM_GAIN,-AIM_UP,0);
    this.target={aim:true,x,y,yaw,pitch,time:now};return true;
  }
  tick(now=Date.now()){
    if(!Number.isFinite(now)||(this.lastTick!==undefined&&now<this.lastTick)){this.stop();return {active:false,gazeX:0,gazeY:0};}
    const dt=this.lastTick!==undefined?clamp((now-this.lastTick)/1000,0,.2):.1;this.lastTick=now;
    if(!this.target||now-this.target.time>(this.target.aim?AIM_HOLD_MS:1000))return {active:false,gazeX:0,gazeY:0};
    const gx=(this.target.x-.5)*2,gy=(this.target.y-.5)*2;
    if(!this.enabled)return {active:true,gazeX:gx,gazeY:gy,rotation:null};
    const step=FOLLOW_SPEED*dt;
    if(this.target.aim){
      const dy=this.target.yaw-this.yaw,dp=this.target.pitch-this.pitch;
      if(Math.abs(dy)>AIM_DEADBAND)this.yaw+=clamp(dy,-step,step);
      if(Math.abs(dp)>AIM_DEADBAND)this.pitch+=clamp(dp,-step,step);
    }else{
      this.yaw+=clamp(-gx*FOLLOW_YAW-this.yaw,-step,step);
      this.pitch+=clamp(Math.min(0,gy*FOLLOW_UP)-this.pitch,-step,step);
    }
    return {active:true,gazeX:gx,gazeY:gy,rotation:this.enabled?{y:this.yaw,p:this.pitch,r:0}:null};
  }
  clearTarget(){this.target=null;this.sequence=-1;}
  stop(){this.enabled=false;this.clearTarget();}
}
/**
 * Following with the small image (10 Nov 2026). The robot's connection sends 5.7 KB and then waits for the network
 * (host setting), so a whole 160×120 grey frame takes about a second on the hotspot: the head got one answer a
 * second. Once the iPhone has found the face, the robot knows its direction (head pose of that frame + place in
 * the image) and sends only a 120×90 window around where the face must be now, shrunk to 80×60 (live-wire.js
 * windowChunks): 4.8 KB, one send. The iPhone answers within that window and the robot puts the answer back in
 * whole-image coordinates, so app and relay stay as they are.
 * - step 3 is the 120×90 window (faces from about 40 cm to 1 m), step 4 the whole frame halved (nearer faces).
 *   The iPhone does not say how big the face is: when the first small frames after a whole one get no answer, the
 *   other step is tried, and when neither works only whole frames go for 10 s. A step that worked is kept; a
 *   failure is forgotten after 4 s (the person may simply have gone away).
 * - The iPhone answers only when it sees a face (or wants a search step), and one answer at a time: while an answer
 *   travels to the robot and its confirmation back (about half a second on the hotspot) it skips the frames that
 *   reach it. So every answer starts the wait again: the face is lost when the first small frame sent after the last
 *   answer has waited 1.5 s with none (it reached the iPhone after the confirmation, so it was looked at), and the
 *   next frame is whole again. Measured on the robot (10 Nov 2026): with 1 s counted from the last small frame sent
 *   before the answer, the lock fell every three or four frames although every answer had found the face, and three
 *   frames in eight were whole ones.
 * - An answer at the very edge (0 or 1: a face cut by the image, or one of the app's search steps) is not a place
 *   to remember: the next frame is whole. The head turns to that edge: of the whole image, or of the window put
 *   back in the whole image (the face left the window on that side, so it is still close: about 17° instead of 23°).
 *   Until 10 Nov 2026 an edge answer on a window moved nothing, and the app's first search step after losing a
 *   face was always wasted (the frames were windows then).
 * - No guessing ahead while the face is seen (10 Nov 2026). Aiming where the face's speed between two sightings
 *   would carry it was tried in a simulation of this loop (answers about 0.7 s old, one a second): a face going
 *   steadily one way was followed about 1° closer, but one swaying ±10° in 3 s was thrown out of the image (the
 *   speed is old when the face turns back). Where a face that left the image has gone is the iPhone's guess
 *   (RobotFaceFollowMemory: it answers with the edge the face went out from).
 * - While the robot listens in a conversation it never sends the whole frame (the microphone comes first). With no
 *   face found it sends small frames only, one of each kind in turn: the whole image halved (a face within about
 *   40 cm), then a 120×90 window (a face from 40 cm to 1 m) in the middle of the image, or around the place where
 *   the face was last seen. Until 10 Nov 2026 only the halved image went: sitting at the desk, farther than 40 cm,
 *   the owner was never found during a conversation. An answer in a search frame starts the usual following.
 * Times are the ticks of live-device.js (milliseconds that may start again from the bottom: a negative wait
 * counts as over).
 */
export const FRAME_WIDTH=160,FRAME_HEIGHT=120,LOCK_WAIT_MS=1500,LOCK_AGE_MS=3000,RETRY_MS=4000,WIDE_MS=10000,WINDOW_MARGIN=.1;
const over=(now,then,ms)=>{const waited=now-then;return waited<0||waited>=ms;};
export class FaceLock {
  constructor(){this.clear();}
  clear(){this.face=undefined;this.at=undefined;this.since=undefined;this.hits=0;this.failed=0;this.failedAt=undefined;this.step=3;this.wideFrom=undefined;this.near=false;}
  #drop(){this.face=undefined;this.since=undefined;this.hits=0;}
  /**
   * What to send from a frame taken now with the head at pose: undefined for the whole 160×120 image, or the
   * window of a small one ({x0,y0,step}, locked when it is sent because the face should be there).
   */
  plan(pose,now,listening=false){
    const known=!!pose&&[pose.y,pose.p].every(Number.isFinite);
    // Listening, no face to follow: the halved whole image and a search window, in turn (near: the halved one went last).
    const search=()=>{
      if(!this.near)return {x0:0,y0:0,step:4,locked:false};
      const x=this.face&&known?.5-(this.face.y-pose.y)/CAMERA_FOV.x:.5,y=this.face&&known?.5+(this.face.p-pose.p)/CAMERA_FOV.y:.5;
      return {x0:clamp(Math.round(x*FRAME_WIDTH)-60,0,FRAME_WIDTH-120),y0:clamp(Math.round(y*FRAME_HEIGHT)-45,0,FRAME_HEIGHT-90),step:3,locked:false};
    };
    if(this.wideFrom!==undefined&&over(now,this.wideFrom,WIDE_MS))this.wideFrom=undefined;
    if(this.face&&this.since!==undefined&&over(now,this.since,LOCK_WAIT_MS)){
      // The small frames went unanswered. Never an answer at this size: the other one next time, then whole frames.
      if(this.hits)this.failed=0;
      else if(++this.failed>=2){this.failed=0;this.step=3;this.wideFrom=now;}
      else{this.step=this.step===3?4:3;this.failedAt=now;}
      this.#drop();
    }
    if(this.failed&&!this.face&&over(now,this.failedAt,RETRY_MS)){this.failed=0;this.step=3;}
    if(this.face&&over(now,this.at,LOCK_AGE_MS))this.#drop();
    if(!this.face||this.wideFrom!==undefined||!known)return listening?search():undefined;
    if(this.step===4)return {x0:0,y0:0,step:4,locked:true};
    const x=.5-(this.face.y-pose.y)/CAMERA_FOV.x,y=.5+(this.face.p-pose.p)/CAMERA_FOV.y;
    if(!(x>=WINDOW_MARGIN&&x<=1-WINDOW_MARGIN&&y>=WINDOW_MARGIN&&y<=1-WINDOW_MARGIN))return listening?search():undefined;
    return {x0:clamp(Math.round(x*FRAME_WIDTH)-60,0,FRAME_WIDTH-120),y0:clamp(Math.round(y*FRAME_HEIGHT)-45,0,FRAME_HEIGHT-90),step:3,locked:true};
  }
  // A frame left at time now with this window (undefined: the whole image). The first small one after an answer
  // starts the wait for the next answer. A search frame (small, not locked) only takes its turn.
  sent(window,now){
    if(window&&!window.locked){this.near=window.step===4;return;}
    if(!window?.locked||!this.face)return;
    this.since??=now;
  }
  /**
   * The iPhone's answer for a frame: x,y (0…1) in the image that frame carried, its window and head pose.
   * Returns where to aim in the whole image of that frame: the face, or the edge it went out from.
   */
  answer(frame,x,y,now){
    const window=frame.window,partial=window?.step===3;
    const place=partial?{x:(window.x0+x*120)/FRAME_WIDTH,y:(window.y0+y*90)/FRAME_HEIGHT}:{x,y};
    if(x<=0||x>=1||y<=0||y>=1){this.#drop();return place;}
    this.face={y:frame.pose.y+(.5-place.x)*CAMERA_FOV.x,p:frame.pose.p-(.5-place.y)*CAMERA_FOV.y};this.at=now;
    // The small frames sent before this answer do not wait for one: the iPhone was busy with this answer when they
    // reached it. The next one sent starts the wait.
    this.since=undefined;
    if(window?.locked){this.hits++;this.failed=0;}
    return place;
  }
}
