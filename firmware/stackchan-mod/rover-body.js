// What the rover under Robottino does by itself (owner, 14 Nov 2026: «Fai 1 2 5 6 7» from the list «cosa possiamo fare
// con il rover»). Only turns on the spot: the rover has no sensor for the edge of the desk.
//   1 a voice heard from one side (sound-ear.js, while nobody is in sight): the body turns toward that side;
//   2 following a face, the head near the end of its turn for a moment: the body turns the same way, a little at a
//     time, and the head (which keeps following) comes back toward the middle;
//   5 lifted, shaken or fallen (motion-sense.js, state other than «down»): the wheels stop at once and nothing moves
//     for a while after the robot is standing quietly again. This also holds for the spoken and the iPhone commands.
// PREPARED, NEVER TRIED WITH THE REAL ROVER: how far a turn goes and which way is which are to be measured; the one
// number to change if the body turns the wrong way is yawToTurn.
//
// Signs: the head's yaw is positive toward the robot's left (live-device.js selfWake: side 1 is the robot's left and
// the look around starts at a higher yaw). A turn of the rover is its z (rover-wire.js wheelSpeeds), positive toward
// the right by M5Stack's library; so the body turns toward a positive yaw with a negative z.
export const BODY={followYaw:55*Math.PI/180,followHoldMs:700,turnSpeed:30,turnMs:400,voiceTurnMs:700,restMs:1500,safeAfterMs:2000,yawToTurn:-1};

export class RoverBody{
  #limits;#blockedUntil=0;#nextAt=0;#wideSince;#voiceSide=0;
  constructor(limits=BODY){this.#limits={...BODY,...limits};}
  // A voice from that side (1 the robot's left, −1 its right, 0 not known): one turn toward it, at the next chance.
  voice(side){const s=Math.sign(Number(side)||0);if(s)this.#voiceSide=s;}
  // Once a robot cycle. ready: the rover answers; moving: a move is going; unsafe: lifted, shaken or fallen;
  // allowed: the head may move by itself now (motions on, no calibration, dance, touch or iPhone); following: a face is
  // in sight right now; yaw: where the head is (radians). Gives {stop:true}, {z,ms,why} or nothing.
  tick(now,{ready=false,moving=false,unsafe=false,allowed=false,following=false,yaw=0}={}){
    const l=this.#limits;
    if(unsafe){this.#blockedUntil=now+l.safeAfterMs;this.#voiceSide=0;this.#wideSince=undefined;return moving?{stop:true}:undefined;}
    // No rover answering: nothing is kept for later (a voice heard now must not turn the body minutes after).
    if(!ready){this.#voiceSide=0;this.#wideSince=undefined;return;}
    if(now<this.#blockedUntil)return;
    if(!allowed){this.#voiceSide=0;this.#wideSince=undefined;return;}
    if(moving||now<this.#nextAt)return;
    if(this.#voiceSide){
      const side=this.#voiceSide;this.#voiceSide=0;this.#wideSince=undefined;this.#nextAt=now+l.voiceTurnMs+l.restMs;
      return {z:l.yawToTurn*side*l.turnSpeed,ms:l.voiceTurnMs,why:'voice'};
    }
    if(following&&Math.abs(yaw)>=l.followYaw){
      this.#wideSince??=now;
      if(now-this.#wideSince<l.followHoldMs)return;
      this.#wideSince=undefined;this.#nextAt=now+l.turnMs+l.restMs;
      return {z:l.yawToTurn*Math.sign(yaw)*l.turnSpeed,ms:l.turnMs,why:'face'};
    }
    this.#wideSince=undefined;
  }
  // Commands from the voice or the iPhone may go now (not lifted, shaken or fallen, nor just after).
  free(now){return now>=this.#blockedUntil;}
}
