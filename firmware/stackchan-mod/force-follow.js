// «La Forza» that follows the hand (owner, 23 Nov 2026: «la forza deve funzionare come col robot Loi. In pratica, una
// volta che si aggancia, deve poi seguire la mia mano. Quindi se indietreggia la mano, avanza il rover… se avanza la
// mano, indietreggia il rover, destra e sinistra»; then «implementa movimenti con la forza avanti e indietro, destra e
// sinistra»). As in Looi (apps/nsh/runtime/hand-follow.ts, read only), with what the robot has: the VL53L0X distance
// sensor in front (tof-wire.js) for near and far, and the iPhone, when it watches the robot's video, for left and
// right (the hand's place across the picture, command `hand`). PREPARED, NEVER TRIED WITH THE REAL ROVER.
//
// After a push (force.js ForcePush) the robot is «hooked» to the hand:
//   - first, for settleMs, it only goes back (the recoil of before: the push brought the hand at its nearest);
//   - then the distance of that moment (within nearestMm…farthestMm) is the one it keeps: the hand comes nearer and the
//     rover goes back, the hand goes away and the rover comes forward, at a speed that grows with the difference;
//     within deadMm of it, still;
//   - the hand to one side of the picture (beyond sideDead from the middle, said by the iPhone less than sideFreshMs
//     ago) and the rover slides that way (its mecanum wheels go sideways: the sensor keeps looking where the hand is);
//     both at once when both are off;
//   - it lets go when the sensor no longer has the hand (beyond goneMm, or nothing in range) for goneMs, after maxMs
//     in all, or when mod.js stops it (lifted, the motions switched off, a fault). Every move is short (stepMs) and
//     renewed while it lasts, so a robot that stops thinking also stops the wheels (rover-wire.js).
// Left and right: in the robot camera's picture x below 0.5 is the robot's own left (live-device.js selfSide), and the
// rover's `x` is sideways to its right (rover-wire.js MOVES): a hand at x 0.2 is a slide to the left, x < 0.
// THE SIGNS OF THE ROVER'S SIDEWAYS MOVE ARE NOT CHECKED ON THE REAL ROVER (rover-wire.js says so too).
export const FORCE_FOLLOW={settleMs:400,nearestMm:150,farthestMm:320,deadMm:35,goneMm:480,goneMs:600,maxMs:20000,
  stepMs:450,renewMs:200,sideDead:.12,sideFreshMs:700,minSpeed:20,maxSpeed:45,gainPerMm:.25,sideSpeed:30,recoilSpeed:40};

export class ForceFollow{
  constructor(limits=FORCE_FOLLOW){this.limits=limits;this.active=false;}
  // A push hooks the hand: mm, where it came to.
  start(mm,now){Object.assign(this,{active:true,from:now,keep:undefined,seenAt:now,side:undefined,lastMove:undefined,lastAt:-Infinity});}
  // The iPhone saw the hand at x (0…1 across the robot camera's picture).
  hand(x,now){if(this.active&&Number.isFinite(x)&&x>=0&&x<=1)this.side={x,at:now};}
  stop(){this.active=false;}
  // One distance (mm, as force.js forceMm: 0 against the sensor, 2000 nothing in range, undefined no reading) at now.
  // Returns undefined (nothing new to do), {end:why}, or {x,y} speeds for the rover (both 0: stand still).
  feed(mm,now){
    if(!this.active||mm===undefined||!Number.isFinite(now))return undefined;
    const L=this.limits;
    if(now-this.from>=L.maxMs)return this.#end('time limit');
    if(mm>=L.goneMm){if(now-this.seenAt>=L.goneMs)return this.#end('hand gone');return this.#move({x:0,y:0},now);}
    this.seenAt=now;
    if(this.keep===undefined){
      if(now-this.from<L.settleMs)return this.#move({x:0,y:-L.recoilSpeed},now);
      this.keep=Math.max(L.nearestMm,Math.min(L.farthestMm,mm));
    }
    const off=mm-this.keep,y=Math.abs(off)<=L.deadMm?0:Math.sign(off)*Math.min(L.maxSpeed,L.minSpeed+(Math.abs(off)-L.deadMm)*L.gainPerMm);
    const side=this.side&&now-this.side.at<=L.sideFreshMs?this.side.x-.5:0,x=Math.abs(side)>L.sideDead?Math.sign(side)*L.sideSpeed:0;
    return this.#move({x:Math.round(x),y:Math.round(y)},now);
  }
  // Only a change, or the same move again when it is about to run out.
  #move(speeds,now){
    const same=this.lastMove&&this.lastMove.x===speeds.x&&this.lastMove.y===speeds.y;
    if(same&&now-this.lastAt<this.limits.renewMs)return undefined;
    this.lastMove=speeds;this.lastAt=now;return {...speeds};
  }
  #end(why){this.active=false;return {end:why};}
}
