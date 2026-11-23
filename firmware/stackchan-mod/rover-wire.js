// The M5Stack RoverC Pro (K036-B) under Robottino (owner, 14 Nov 2026: «Ho comprato il rover di M5Stack standard»,
// then «Procedi con integrazione del roverc pro di m5»). PREPARED, NEVER TRIED WITH THE REAL ROVER.
//
// The rover: four N20 motors on mecanum wheels and a gripper on a servo, driven by its own STM32 that listens on I2C at
// address 0x38 (M5Stack's protocol page for K036-B). Registers, 8-bit address then data:
//   0x00…0x03  speed of motor 1…4, int8 (sign = direction, 0 = stop); M5Stack's own library (M5-RoverC setSpeed,
//              checked 15 Nov 2026) writes the four in one write from 0x00, each kept within −100…100 and sent as it is
//   0x10…0x11  angle of servo 1…2, 0…180 (M5-RoverC setServoAngle: one byte at 0x10 + servo, read 15 Nov 2026)
// The gripper is servo 1 (owner, 15 Nov 2026: «la pinza ora funziona?», «sì»). Only the two angles of M5Stack's own
// example (examples/RunningRoverC: 90 and 10) are ever sent, so the servo is never pushed past what M5Stack itself
// does. WHICH OF THE TWO OPENS IS A GUESS, to be seen on the real rover: swap GRIP.open and GRIP.closed if it is the
// other way round. The servo holds its angle by itself; nothing has to be stopped afterwards.
// «Chiudi poco» (owner, 15 Nov 2026: «aggiungi chiudi poco e chiudi tutto», after «come capisce dimensione oggetto?»: it
// does not, the gripper has no sensor): half way between the two, for an object too large for the full closing.
// The rover has NO watchdog of its own: a speed stays until another one is written. So the robot stops it itself
// after every move (ROVER_LIMITS.moveMs at most), writes a stop when it opens the line, when it closes it and after a
// failed write; and a move is never «done» if the write failed.
//
// The wire: the rover's own Grove I2C socket to the robot's Port A (CoreS3: data G2, clock G1, Moddable's
// device.i2c.default). The rover has its own battery; the robot's 5 V does not go to it (see firmware.md).
// The messages are pure (bytes out); the line itself (createRover) gets the host's I2C class from mod.js, so a pretend
// rover can stand in for it in the tests.
export const ROVER_ADDRESS=0x38;
export const ROVER_PINS={data:2,clock:1};
export const ROVER_HZ=100000;
const MOTORS=0x00;
// Safety, the same spirit as the head (firmware.md): never faster than maxSpeed (% of full speed), never longer than
// moveMs, then stopped by the robot. Not to be raised without the owner asking.
export const ROVER_LIMITS={maxSpeed:50,moveMs:3000};
// A stop that the rover did not take (external review, 17 Nov 2026, R1) is tried again: ten times close together,
// then once every two seconds, for as long as the zero has not been written. The rover has no watchdog of its own.
export const STOP_RETRY={fastMs:100,fast:10,slowMs:2000};

// A speed in %: whole numbers, −limit…limit, nothing that is not a number.
export const clampSpeed=(value,limit=100)=>{const cap=Math.max(0,Math.min(100,Math.round(Number(limit)||0)));const v=Math.round(Number(value));return Number.isFinite(v)?Math.max(-cap,Math.min(cap,v)):0;};
// The four wheels for a move: y forward, x sideways to the right, z turning on the spot (signs to be checked on the
// real rover). The same mixing as M5Stack's own library (M5-RoverC setSpeed): turning takes room from the rest, then
// every wheel is kept within the limit.
export function wheelSpeeds({x=0,y=0,z=0}={},limit=100){
  x=clampSpeed(x,limit);y=clampSpeed(y,limit);z=clampSpeed(z,limit);
  if(z){x=Math.trunc(x*(100-Math.abs(z))/100);y=Math.trunc(y*(100-Math.abs(z))/100);}
  return [y+x-z,y-x+z,y-x-z,y+x+z].map(v=>clampSpeed(v,limit));
}
// One write: the first register, then the four speeds as int8, −100…100 as they are, exactly as M5Stack's library
// (until 15 Nov 2026 they were scaled to −127…127, which made 30 % into 38 on the wire).
export function motorMessage(speeds){return Uint8Array.from([MOTORS,...speeds.map(v=>clampSpeed(v)&0xff)]);}
export const stopMessage=()=>Uint8Array.from([MOTORS,0,0,0,0]);
export const GRIP={register:0x10,open:90,half:50,closed:10};
// The gripper's moves by name, as the wheels' MOVES: what the voice and the iPhone may ask.
export const GRIP_MOVES={gripOpen:'open',gripHalf:'half',gripClose:'closed'};
export const gripMessage=name=>{const key=GRIP_MOVES[name];return key?Uint8Array.of(GRIP.register,GRIP[key]):null;};
// Moves by name, at the given speed (%): what the menu and, one day, the voice may ask.
export const MOVES={forward:{y:1},back:{y:-1},right:{x:1},left:{x:-1},turnRight:{z:1},turnLeft:{z:-1}};

// I2C: the host's embedded:io/i2c. timer: {set(fn,ms),clear(id)}. log(text): one line on the USB log.
export function createRover({I2C,timer,log,pins=ROVER_PINS,hz=ROVER_HZ,limits=ROVER_LIMITS,allowForward=()=>true}){
  let line,state='closed',moveTimer,failure,unstopped=false,advancing=false,retryTimer,retries=0;
  const say=text=>{try{log?.(`[robottino] rover ${text}\n`);}catch{}};
  const send=bytes=>{if(!line)return false;try{line.write(bytes);return true;}catch(error){failure=String(error?.message??error).slice(0,40);return false;}};
  const halt=()=>{if(moveTimer!==undefined){timer.clear(moveTimer);moveTimer=undefined;}const ok=send(stopMessage());if(ok)advancing=false;return ok;};
  const shut=()=>{const old=line;line=undefined;try{old?.close();}catch{}};
  // The zero reached the rover: nothing is owed any more.
  const stopped=()=>{if(retryTimer!==undefined){timer.clear(retryTimer);retryTimer=undefined;}if(unstopped)say('stop confirmed');unstopped=false;advancing=false;retries=0;};
  // The zero did NOT reach the rover: the wheels may still be turning. Until 17 Nov 2026 nothing tried again and
  // `moving` said false (it only looked at the move's timer), so a STOP could be confirmed with the wheels turning.
  // One try on the line as it is, one on a line opened again (a bus that came back), then the next try is booked.
  const retry=()=>{
    retryTimer=undefined;if(!unstopped)return;retries++;
    let ok=send(stopMessage());
    if(!ok){shut();try{line=new I2C({...pins,hz,address:ROVER_ADDRESS,timeout:50});ok=send(stopMessage());}catch(error){line=undefined;failure=String(error?.message??error).slice(0,40);}}
    if(ok){stopped();return;}
    retryTimer=timer.set(retry,retries<STOP_RETRY.fast?STOP_RETRY.fastMs:STOP_RETRY.slowMs);
  };
  const owed=()=>{if(unstopped)return;unstopped=true;retries=0;say('STOP NOT CONFIRMED, trying again');retryTimer=timer.set(retry,STOP_RETRY.fastMs);};
  const fail=()=>{const ok=halt();state='error';say(`write failed ${failure??''}`);if(ok)stopped();else owed();};
  return {
    // Opens the line and stops the wheels: true only if the rover answered. Nothing moves before this.
    open(){
      if(state==='ready')return true;
      shut();failure=undefined;
      try{line=new I2C({...pins,hz,address:ROVER_ADDRESS,timeout:50});}
      catch(error){line=undefined;state='error';failure=String(error?.message??error).slice(0,40);say(`cannot open ${failure}`);return false;}
      if(!send(stopMessage())){shut();state='error';say(`not found ${failure??''}`);return false;}
      stopped();state='ready';say('ready');return true;
    },
    // A move for ms (at most limits.moveMs), then the robot stops it. false (and stopped) if the write failed.
    move(direction,ms=1000){
      if(state!=='ready')return false;
      if(Number(direction?.y)>0&&!allowForward()){if(!halt())fail();return false;}
      const time=Math.max(50,Math.min(limits.moveMs,Number(ms)||0));
      if(moveTimer!==undefined){timer.clear(moveTimer);moveTimer=undefined;}
      if(!send(motorMessage(wheelSpeeds(direction,limits.maxSpeed)))){fail();return false;}
      advancing=Number(direction?.y)>0;
      moveTimer=timer.set(()=>{moveTimer=undefined;if(!halt())fail();},time);
      return true;
    },
    go(name,speed=30,ms=1000){const unit=MOVES[name];if(!unit)return false;return this.move({x:(unit.x??0)*speed,y:(unit.y??0)*speed,z:(unit.z??0)*speed},ms);},
    // The gripper: gripOpen, gripHalf or gripClose. false (wheels stopped, as after any failed write) if the rover did not take it.
    grip(name){
      if(state!=='ready')return false;
      const bytes=gripMessage(name);if(!bytes)return false;
      // A failed write of the gripper stops everything only with the wheels turning (review, 23 Nov 2026: until then
      // one failed grip left the whole rover «in error», wheels included, until a restart).
      if(!send(bytes)){if(moveTimer!==undefined||unstopped)fail();else say(`grip failed ${failure??''}`);return false;}
      say(`grip ${GRIP_MOVES[name]}`);return true;
    },
    // true only when the wheels are known to be still: the zero was written now or, after a failed write (state
    // 'error'), when it was written then and nothing moved since. With a stop still owed it tries at once.
    stop(){
      if(unstopped){if(retryTimer!==undefined){timer.clear(retryTimer);retryTimer=undefined;}retry();return !unstopped;}
      if(state==='error')return moveTimer===undefined;
      if(state!=='ready')return false;if(!halt()){fail();return false;}return true;
    },
    // Gives the line back. A stop still owed (or one that fails now, with the wheels turning) goes on being tried.
    close(){const turning=moveTimer!==undefined;if(line){if(halt())stopped();else if(turning)owed();}shut();state='closed';},
    get state(){return state;},
    // Turning, or not known to be still: a stop that was not confirmed counts as moving.
    get moving(){return moveTimer!==undefined||unstopped;},
    get advancing(){return advancing&&(moveTimer!==undefined||unstopped);},
    get unstopped(){return unstopped;},
    get failure(){return failure;}
  };
}
