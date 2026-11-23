// Presence sensor: M5Stack's PIR unit (AS312) wakes the robot when it sleeps (owner, 15 Nov 2026: «attivazione se in
// standby con sensore AS312»). PREPARED, NEVER TRIED WITH THE REAL UNIT.
//
// The unit goes on Port B of the CoreS3 (the red one: GND, 5 V, G9, G8). Its one signal is on the yellow wire, G8 here
// (M5Stack's own example reads the same wire, pin 36 on the first Core); G9 is not connected in the unit. The AS312
// holds its output high for about 2 s after each movement it sees and takes a few seconds to settle after power-on.
// The pin is read with the chip's pull-down, so with no unit plugged in it reads 0 and nothing ever happens.
//
// «Standby» is the robot asleep (mod.js: 30 s with nobody in sight, eyes closed, head at rest). A movement then wakes it
// as a voice does (live-device.js selfWake): eyes open, the look around starts again, awake for another half minute.
// Not in the first sleptMs of sleep: the head has just gone to rest and the wheels have just stopped, and a sensor
// riding on the robot sees the room move with them. The signal must stay high for steadyMs (a glitch is not a person).
export const PIR={pin:8,sleptMs:5000,steadyMs:200};

export class Presence{
  #l;#highSince;
  // For mod.js (23 Nov 2026): the last movement felt (ms) and whether nobody has moved for long (K.NOBODY_MS).
  movedAt=undefined;nobody=false;felt=false;
  constructor(limits=PIR){this.#l={...PIR,...limits};}
  // Once a robot cycle. level: the sensor's signal (1 = movement); asleepMs: for how long the robot has slept, or
  // undefined when it is awake. true once for each wake-up.
  tick(now,{level=0,asleepMs}={}){
    const l=this.#l;
    if(!level||!(asleepMs>=l.sleptMs)){this.#highSince=undefined;return false;}
    this.#highSince??=now;
    if(now-this.#highSince<l.steadyMs)return false;
    this.#highSince=undefined;return true;
  }
}

// The pin itself: Digital is the host's embedded:io/digital. read() is 0 when anything goes wrong.
export function createPir({Digital,pin=PIR.pin,log}){
  let line;
  const say=text=>{try{log?.(`[robottino] presence ${text}\n`);}catch{}};
  return {
    open(){
      if(line)return true;
      try{line=new Digital({pin,mode:Digital.InputPullDown});say(`listening on G${pin}`);return true;}
      catch(error){line=undefined;say(`pin unavailable ${String(error?.message??error).slice(0,40)}`);return false;}
    },
    read(){try{return line?.read()?1:0;}catch{return 0;}},
    close(){const l=line;line=undefined;try{l?.close();}catch{}}
  };
}
