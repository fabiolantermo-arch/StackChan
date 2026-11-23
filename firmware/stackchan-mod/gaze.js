// «Chiamata con lo sguardo» (owner, 21 Nov 2026: «un interruttore nella scheda robot per far partire la chiamata dopo
// 10 secondi che mi guarda fisso»). Pure: what the robot's own camera sees in, «open the conversation now» out.
// With the switch on (preference gazeCall, off unless chosen), a face seen for GAZE.callMs opens a conversation, as
// the long touch does. The face may be missed for up to GAZE.gapMs (the recogniser skips pictures) without starting
// over. After a conversation, however it began, the face must first go away for GAZE.awayMs (or GAZE.againMs pass):
// a call ended while still looking at the robot must not open the next one ten seconds later. The recogniser finds
// faces seen from the front: that is the «guardare fisso».
// A module of its own (21 Nov 2026): written inside mod.js, its ten new names made the MOD's main function too big
// for the robot's JavaScript stack («stack overflow (-1)», XS abort at every start).
export const GAZE={callMs:10000,gapMs:1500,awayMs:3000,againMs:120000};
export class GazeCall{
  constructor(on=false,limits=GAZE){this.limits=limits;this.on=on===true;this.since=undefined;this.away=false;this.againAt=0;}
  set(on){this.on=on===true;this.since=undefined;this.away=false;}
  // One turn of the robot's cycle. watching: the camera is looking; seenMs: since the face was last seen; talking: a
  // conversation is open; busy: anything else that must not be interrupted. true: open the conversation now.
  tick(now,{watching=false,seenMs=Infinity,talking=false,busy=false}={}){
    const L=this.limits;
    if(!this.on){this.since=undefined;return false;}
    if(talking){this.since=undefined;this.away=true;this.againAt=now+L.againMs;return false;}
    if(this.away){if((watching&&seenMs>=L.awayMs)||now>=this.againAt)this.away=false;else{this.since=undefined;return false;}}
    if(!watching||!(seenMs<L.gapMs)||busy){this.since=undefined;return false;}
    if(this.since===undefined)this.since=now;
    if(now-this.since<L.callMs)return false;
    this.since=undefined;this.away=true;this.againAt=now+L.againMs;return true;
  }
}
