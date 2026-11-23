// What the motion sensor says about the robot being handled (owner, 14 Nov 2026: «reagire se viene sollevato o
// scosso; fermare i motori se cade»). Pure arithmetic: the sensor is read by the host (robot.input.imu, a reading
// every 100 ms) and handed here by mod.js, which also does what the answer asks (stop the head, change the face).
//
// The sensor (BMI270) is in the HEAD, the CoreS3: when the head looks up, gravity turns in the sensor's own frame
// though the body has not moved (the host's own «fallen» takes a head looking up 50° for a fall backwards). So what
// counts here is the tilt of the BODY: the angle between gravity as measured and gravity as it should be with the
// head where it is. Turning the head left and right does not change gravity.
//
// The sensor's frame as the host sets it (order «zxy»; modules/input/imu-motion.ts): y up along the screen, z out of
// the back of the head (z grows when the screen turns to the ceiling), x across. With the head up by a:
// gravity = (0, cos a, sin a). Read on the robot at rest (14 Nov 2026, 12:48, host 14d): head straight, gravity
// (−0,02, 0,99, 0,06) g; head 25° up, (−0,01, 0,84, 0,53); 28° up, (−0,01, 0,81, 0,57). So the frame and the sign
// are these (PITCH_SIGN 1), and the sensor reads about 7° more «up» than the pitch the robot asks for (32° for 25°,
// 35° for 28°): SENSOR_UP. Seen only between 22° and 28° of pitch so far: to be read again on the log with the head
// higher (`tilt` must stay near 0 wherever the head looks).
//
// Three states: «down» (standing on the desk), «held» (lifted or carried), «fallen» (lying on a side or upside down).
//  - held: the body tilted more than HELD_TILT for HELD_MS, or pushed about without pause (a walk, a hand that
//    carries it) in MOVING_HITS of the last MOVING_OF readings taken with the head still;
//  - fallen: tilted more than FALLEN_TILT for FALLEN_MS;
//  - down again: upright within DOWN_TILT and quiet for DOWN_MS.
// And one event with no state: «shaken», SHAKE_HITS hard jolts within SHAKE_MS.
// Measured on the robot standing on the desk (same log, a minute): with the head still gravity is off by 0,01 g at
// most and the turn is 1°/s at most; while the head moves by itself, up to 0,07 g and 317°/s (the head's own turn),
// which is why a reading with the head moving is never taken for a hand. What a hand, a walk, a shake and a fall
// really read has NOT been measured yet (it needs the owner): the thresholds below are first values, with the
// `[robottino] imu …` line of mod.js to check them.
const DEG=Math.PI/180;
export const G=9.80665,PITCH_SIGN=1,SENSOR_UP=7*DEG;
export const HELD_TILT=15*DEG,HELD_MS=300,FALLEN_TILT=50*DEG,FALLEN_MS=500,DOWN_TILT=10*DEG,DOWN_MS=1500;
// «Moved»: gravity off by MOVING_G of itself. Not the turn: the sensor is in the head, and a hand that only touches
// the head turns it a little on its motors. Seen on the robot (14 Nov 2026, 14:05, owner: «appena la tocco mi dice
// che bella vista da quassù, anche senza sollevarla»): touched, the turn read up to 179°/s with gravity off by
// 0,03 g and the body tilted 9° at most, and five such readings made it «held». A real lift read 0,09-0,29 g off and
// 12°-37° of tilt. The turn still counts for «quiet again» (QUIET_TURN): nobody is touching it.
export const MOVING_G=.12,MOVING_HITS=5,MOVING_OF=8,QUIET_G=.05,QUIET_TURN=8;
// Turned over, the robot is «held» for a moment on its way to «fallen» (owner, 14 Nov 2026: «quando lo capovolgo
// vanno in conflitto due messaggi»): the phrase for being lifted waits HELD_SPEAK_MS, and is not said while the body
// is tilted as far as a fall (HELD_SPEAK_TILT: «fallen» follows within FALLEN_MS and takes its place). First tried at
// 35°: a robot held in the hands to look at its face is tilted back 30°-40°, and it said nothing («dopo che lo
// capovolgo, poi lo sollevo, non reagisce più»). Picked up after a fall it is «held» too, on its way to standing: the
// phrase then waits HELD_AFTER_FALL_MS, so that it is said only if the robot stays in the hand.
export const HELD_SPEAK_MS=800,HELD_SPEAK_TILT=FALLEN_TILT,HELD_AFTER_FALL_MS=3500,PHRASE_WAIT_MS=4000;
// Gravity can be read only from a sensor that is not being thrown about: a reading whose strength is off by STEADY_G
// or more says nothing of the tilt. Seen on the robot (14 Nov 2026, 13:28): shaken hard (up to 1,02 g off), the
// «tilt» read 100°-170° and after a few seconds the robot took itself for fallen, showed the sad face and ignored
// the shaking from then on (owner: «non funziona più lo scossone»). A real fall ends lying still, and is read then.
export const STEADY_G=.25;
// Turned over with the motors off (23 Nov 2026): the head may hang anywhere from straight to its top (about 45° up and
// more by hand), so only a body tilted beyond that is surely over: lying on its back or upside down.
export const UNPOSED_FALLEN_TILT=90*DEG; // seen on the robot turned over by the owner (23 Nov 2026, motors off): 97° and 117°
// Handled (23 Nov 2026, for the Force's sound and the wave, force.js): a reading with the head still (so not its own
// motors) whose gravity is off by HANDLED_G or that turns HANDLED_TURN degrees a second or more. Read with the motors
// off too (no tilt needed). On the robot lifted: 0,08-1,09 g off, 230-652°/s; standing untouched: 0,01 g, 0-2°/s.
export const HANDLED_G=.06,HANDLED_TURN=40;
export const SHAKE_G=.6,SHAKE_HITS=3,SHAKE_MS=1200,SHAKE_AGAIN_MS=3000;
const size=v=>Math.hypot(v.x,v.y,v.z);
// The angle between gravity as the sensor reads it and as it should read with the head at this pitch (− = up).
export const bodyTilt=(acceleration,pitch)=>{
  const length=size(acceleration);if(!(length>0))return undefined;
  const up=-pitch*PITCH_SIGN+SENSOR_UP,dot=(acceleration.y*Math.cos(up)+acceleration.z*Math.sin(up))/length;
  return Math.acos(Math.max(-1,Math.min(1,dot)));
};
export class MotionSense{
  state='down';
  // The last reading, for the log: gravity in g, how far it is from 1 g, the turn in degrees a second, the body's tilt.
  tilt=0;off=0;turn=0;
  // handledAt: the last reading of a hand moving the robot (HANDLED_G, HANDLED_TURN); stillAt: the last with the head still.
  handledAt=-Infinity;stillAt=-Infinity;
  #tiltSince;#fallSince;#quietSince;#moves=0;#jolts=[];#shakenAt;
  // acceleration (m/s²) and turn (degrees a second) as the host gives them; turn may be missing.
  // pitch: where the head is (radians, − = up). slack: how far the head may be from there (radians: the size of a
  // move still on its way; 0 when the head is still). still: the head is not moving, so what the sensor feels is
  // somebody's hand and not the robot's own motors. posed: the head is held by its motors where the robot thinks it
  // is; otherwise nothing can be said about the tilt (a head with its motors off hangs wherever it was left).
  // Returns 'held', 'fallen', 'down' when the state changes, 'shaken', or nothing.
  update(acceleration,turn,{pitch=0,slack=0,still=true,posed=true}={},now=0){
    const length=acceleration?size(acceleration):0;if(!(length>0))return undefined;
    const off=Math.abs(length/G-1),turning=turn?size(turn):0;
    this.off=off;this.turn=turning;
    if(still){this.stillAt=now;if(off>=HANDLED_G||turning>=HANDLED_TURN)this.handledAt=now;}
    // Shaken: hard jolts, whatever the head is doing (the head's own moves stay far below SHAKE_G).
    let shaken=false;
    if(off>=SHAKE_G){
      const jolts=this.#jolts;jolts.push(now);while(jolts.length&&now-jolts[0]>SHAKE_MS)jolts.shift();
      if(jolts.length>=SHAKE_HITS&&!(now-this.#shakenAt<SHAKE_AGAIN_MS)){this.#shakenAt=now;jolts.length=0;shaken=true;}
    }
    if(!posed){
      // Turned over with the motors off (owner, 23 Nov 2026: «non lo riconosce più quando lo capovolgo, prima diceva
      // qualcosa»): where the head is is not known, but a body turned over is tilted farther than any head can be
      // (UNPOSED_FALLEN_TILT with the head where it was last put). Only that: being lifted needs the head held.
      const flat=off<STEADY_G?bodyTilt(acceleration,pitch)??0:0;
      if(flat>=UNPOSED_FALLEN_TILT){
        this.tilt=flat;this.#fallSince??=now;this.#tiltSince=this.#quietSince=undefined;this.#moves=0;
        if(this.state!=='fallen'&&now-this.#fallSince>=FALLEN_MS){this.state='fallen';return 'fallen';}
        return shaken?'shaken':undefined;
      }
      if(this.state==='fallen'&&off>=STEADY_G)return shaken?'shaken':undefined; // being picked up: wait for it to be still
      // No tilt to speak of: whatever was held or fallen is forgotten, the timers start again.
      this.#tiltSince=this.#fallSince=this.#quietSince=undefined;this.#moves=0;this.tilt=0;
      const was=this.state;this.state='down';
      return shaken?'shaken':was!=='down'?'down':undefined;
    }
    const tilt=Math.max(0,(bodyTilt(acceleration,pitch)??0)-slack),steady=off<STEADY_G;this.tilt=tilt;
    if(steady&&tilt>=HELD_TILT)this.#tiltSince??=now;else this.#tiltSince=undefined;
    if(steady&&tilt>=FALLEN_TILT)this.#fallSince??=now;else this.#fallSince=undefined;
    // Moved by a hand: counted only on readings with the head still; a reading with the head moving says nothing.
    if(still){
      const moved=off>=MOVING_G;
      this.#moves=((this.#moves<<1)|(moved?1:0))&((1<<MOVING_OF)-1);
      if(tilt<DOWN_TILT&&off<QUIET_G&&turning<QUIET_TURN)this.#quietSince??=now;else this.#quietSince=undefined;
    }
    let hits=0;for(let bits=this.#moves;bits;bits>>=1)hits+=bits&1;
    const before=this.state;
    if(this.#fallSince!==undefined&&now-this.#fallSince>=FALLEN_MS)this.state='fallen';
    else if(this.state==='fallen'){if(steady&&tilt<FALLEN_TILT)this.state='held';} // being picked up: held until it stands quiet
    else if(this.state==='down'){if((this.#tiltSince!==undefined&&now-this.#tiltSince>=HELD_MS)||hits>=MOVING_HITS)this.state='held';}
    if(this.state==='held'&&before!=='down'&&this.#quietSince!==undefined&&now-this.#quietSince>=DOWN_MS)this.state='down';
    if(this.state!==before){if(this.state!=='down')this.#quietSince=undefined;else this.#moves=0;return this.state;}
    return shaken?'shaken':undefined;
  }
}
// What Robottino says when it is handled, chosen by the owner on 14 Nov 2026 from a list of the phrases recorded
// («lascia per sollevato 1, 2, 4. Per scosso tutte. Caduto solo 1»): lifted, three phrases; shaken, four (with «Ehi,
// piano, piano», first taken out and then wanted back); fallen, only the call for help on the screen, no «Grazie!»
// afterwards. Each phrase is a recording of Robottino's own voice (assets/<file>, made with prepare-phrase.mjs).
// They are only SPOKEN (owner, the same day: «le frasi devono essere solo pronunciate, non scritte a video»): the
// words here are what the recording says, for whoever reads the code, and never go on the screen. So the call for
// help of a fall was recorded too. A fourth one for being lifted, «Mettimi giù, per favore!», was recorded and left out.
export const HELD_PHRASES=[['dove-mi-porti.bin','Ehi, dove mi porti?'],['sto-volando.bin','Uh, sto volando!'],['che-vista.bin','Oh, che bella vista da quassù!']];
export const FALLEN_PHRASES=[['rimettimi-in-piedi.bin','Aiuto, rimettimi in piedi!']];
export const SHAKEN_PHRASES=[['ehi-piano.bin','Ehi, piano, piano!'],['gira-la-testa.bin','Oh, mi gira la testa!'],['terremoto.bin','Aiuto, il terremoto!'],['che-succede.bin','Ma che succede?']];
// One at random, never the one said last (random: a number from 0 to under 1).
export const pickPhrase=(list,last,random=Math.random())=>{
  const others=list.length>1?list.filter(phrase=>phrase!==last):list;
  return others[Math.min(others.length-1,Math.floor(random*others.length))];
};
