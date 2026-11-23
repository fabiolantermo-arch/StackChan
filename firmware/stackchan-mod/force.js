// «Effetto Forza» (owner, 19 Nov 2026: «proviamo effetto forza»): a hand pushed quickly toward the distance sensor
// (VL53L0X, tof-wire.js) is a push, and the robot recoils as if pushed by the Force. Pure: readings in, a push out.
//
// A push is the distance falling from FORCE.from or more to FORCE.to or less within FORCE.windowMs: a hand that comes
// slowly, someone sitting down in front, an object standing still are never a push. After a push the next one needs
// the hand to go back beyond FORCE.from (a hand held close pushes once) and FORCE.coolMs to pass.
// Below the sensor's 30 mm it reads «nothing in range»: that is a hand very close, not far away.
//
// Measured on the robot (19 Nov 2026, 08:21, the owner's hand): a slow approach goes about 70 mm/s, a quick one
// 600 to 450 mm in less than half a second; the sensor gives a reading every 50 ms.
// The owner's own pushes at the first try (19 Nov 2026, 23:26, «non va»): 130 to 250 mm/s through 25 to 18 cm, so
// with 0.3 mm/s and 400 ms only one push in ten was taken. Now 120 mm/s within 700 ms: still above the slow approach.
// The scared sound said with the recoil (owner, 21 Nov 2026: «deve anche fare un verso di spavento»): Robottino's own
// voice saying «Aaah!» (made like the other recordings, see prepare-phrase.mjs).
export const FORCE_SOUND='spavento.bin';
// The scared «Aaah!» waits (owner, 23 Nov 2026: «togli il verso di esclamazione quando alzo il robottino»): the hands
// that pick the robot up pass in front of the distance sensor first and read as a push (seen at 17:20:28, the robot
// in the air a second later). So the sound comes FORCE_SOUND_WAIT.ms after the push, and only if the motion sensor
// has not felt the robot handled meanwhile (motion-sense.js handledAt, from FORCE_SOUND_WAIT.beforeMs before the
// push). The head must have been still once after the wait, so that its own recoil is not taken for a hand; if it is
// never still, after maxMs the sound is played. The face and the head's recoil stay at once.
export const FORCE_SOUND_WAIT={ms:700,maxMs:1500,beforeMs:300};
// at: the push; sense: {state,handledAt,stillAt} of motion-sense.js, or nothing without the sensor.
// 'wait', 'play' or 'drop'.
export const forceSoundNow=(at,now,sense,L=FORCE_SOUND_WAIT)=>{
  if(sense&&(sense.state!=='down'||sense.handledAt>=at-L.beforeMs))return 'drop';
  if(now-at<L.ms)return 'wait';
  if(sense&&sense.stillAt<at+L.ms&&now-at<L.maxMs)return 'wait';
  return 'play';
};
// videoSpeed: while the iPhone watches the robot's video for hand gestures, a push must be this fast (mm/ms) (23 Nov 2026,
// owner: «ha scambiato la vittoria con la forza»: two fingers shown to the camera came in at 172 and 331 mm/s; his
// Force pushes that minute went 645 to 1404 mm/s). A first try asked for the hand at 10 cm instead: «non mi riconosce più
// la mano aperta per la forza».
// from/to (23 Nov 2026, 20:38, owner: «l'ho avvicinata vicino al robot, ma continua a non partire»): his hand stopped at
// 23-30 cm, where 18 cm was asked; now from 29 to 25 cm (the pushes measured on 19 Nov started at 29-32 cm).
// gapMs: when the robot stops reading for a while (2.2 s for a conversation that opened, 20:37:44), the last distance
// before the gap still counts as where the push began, for this long: the hand came from 65 to 13 cm in that gap.
// minDrop: the hand must come at least this much closer (mm): from 29 cm, the slow hand of 19 Nov (90 mm/s) was
// quick enough for its first 5 cm. minSpeed 0.13 (was 0.12): measured from 29 cm, that slow hand made 122 mm/s, the
// slowest real push of that evening 138.
// leanMs, leanGrow: with the K210 seeing a face at the push, it is the owner leaning in only if the face grew by this much
// within this time (mod.js).
export const FORCE={from:290,to:250,minDrop:60,leanMs:1500,leanGrow:1.2,videoSpeed:0.5,windowMs:700,gapMs:2500,coolMs:1500,minSpeed:0.13,maxSpeed:1.2,minDeg:12,maxDeg:30};

// mm for a reading of the sensor: below its range a hand is touching it, beyond it nothing is there.
export const forceMm=reading=>{
  if(!reading||!Number.isFinite(reading.mm))return undefined;
  if(reading.mm<30)return 0;
  return Math.min(reading.mm,2000);
};

// «Nothing in range» right after a close reading comes from tof-wire.js as the last close distance (near:true): the
// hand still against the sensor, never a hand gone far that would re-arm the push.
export class ForcePush{
  constructor(limits=FORCE){this.limits=limits;this.seen=[];this.armed=true;this.lastAt=-Infinity;this.soundAt=undefined;} // soundAt: a push whose sound waits (forceSoundNow)
  // One reading at time now (ms, the robot's clock). Returns {deg,speed,mm} for a push, otherwise undefined.
  feed(reading,now){
    const L=this.limits,mm=forceMm(reading);
    if(mm===undefined||!Number.isFinite(now))return undefined;
    // real: a distance the sensor measured. «Nothing in range» re-arms (the hand went away) but never starts a push:
    // something there all at once, from nothing, came in from the side or the head turned onto it (21 Nov 2026,
    // «come mai fa la faccia spaventata ogni tanto»: 2.8 to 4.2 m/s «pushes» from nothing in range, with the head
    // turning).
    const before=this.seen.at(-1);this.seen=this.seen.filter(s=>now-s.at<=L.windowMs);
    if(!this.seen.length&&before&&now-before.at<=L.gapMs)this.seen=[before]; // no reading since: the robot was busy (FORCE.gapMs)
    this.seen.push({mm,at:now,real:mm<2000});
    if(mm>=L.from)this.armed=true;
    if(!this.armed||mm>L.to||now-this.lastAt<L.coolMs)return undefined;
    const start=this.seen.find(s=>s.mm>=L.from&&s.real);if(!start||now<=start.at)return undefined;
    const speed=(start.mm-mm)/(now-start.at);
    if(speed<L.minSpeed||start.mm-mm<L.minDrop)return undefined;
    this.armed=false;this.lastAt=now;this.seen=[];
    const k=Math.min(1,(speed-L.minSpeed)/(L.maxSpeed-L.minSpeed));
    return {deg:Math.round(L.minDeg+k*(L.maxDeg-L.minDeg)),speed:Math.round(speed*1000),mm};
  }
  reset(){this.seen=[];this.armed=true;}
}

// The head's recoil, as a gesture of mod.js (steps relative to where the head is; pitch negative is up, so back):
// thrown back at once, held a moment, then home again slowly.
export const forceSteps=deg=>[{yaw:0,pitch:-deg,durationMs:200},{yaw:0,pitch:-deg,durationMs:500},{yaw:0,pitch:0,durationMs:700}];

// «Saluto» with the distance sensor (owner, 19 Nov 2026: «fai riconoscere il saluto, deve salutare con "ciao eccomi"»).
// The hand stays in the beam and moves faster than the sensor reads (about 10 readings a second), so the distance jumps
// up and down from one reading to the next. Measured with the owner's hand (19 Nov 2026, 23:52, every reading): waving
// at 30 to 40 cm, 11 to 23 mm between one reading and the next on average (each wave reaching 20 or more), the
// direction changing at most readings; the hand held still at 28 cm, 3 to 5 mm. WAVE.shakeN readings in a row within
// WAVE.near, within WAVE.shakeMs, averaging WAVE.shakeMm or more from one to the next and changing direction
// WAVE.shakeTurns times or more (a hand coming closer, even quickly, goes one way only).
// Not a wave (21 Nov 2026, «controlla come mai mi continua a salutare»: 7 hellos in two minutes with nobody waving):
// something farther or darker than a hand reads noisier, 11 to 18 mm on average at 55 to 60 cm, and someone moving
// at 25 cm 11 to 15 mm; so only within 45 cm, from 18 mm and with 5 turns (17 still took two of them; 20 missed one of the three waves: a narrow margin). The «crossing the beam» wave (hand in and out of the beam),
// never seen in the owner's waves, took a body at the edge of the beam flickering in and out of range: removed.
// (Before, 23:44 to 23:51, swings were looked for in a smoothed distance: the smoothing removed the wave itself.)
// stillMs (for mod.js): the head must have been still that long, so never at a stop of the head's search (1.6 s).
// Not a wave either (23 Nov 2026, «lui continua a dire ciao, eccomi»): with the owner sitting still at about 40 cm
// the log showed 375 to 437 mm, up and down at every line, four hellos in 20 s with the robot still and nobody waving.
// That shaking goes back and forth: two readings apart it is nearly where it was. A waving hand is not: in the owner's
// three waves the mean change two readings apart is 0,89 to 1,31 times the change from one to the next (the logged
// sitting owner: 0,6 or less). So also lag2 ≥ WAVE.lag2 × the mean change. And never while the robot is handled (mod.js:
// motion-sense.js handledAt). The log lines of the distance only show changes of 2 cm: the 12 readings of each hello
// are now on the log (WaveWatch.last) to check this on the robot.
// coolMs (23 Nov 2026, «e continua a dire ciao, eccomi», after the rules above): one hello every 2 minutes at most.
// A greeting is for someone arriving; until the readings of the false ones (on the log) say what they are, a wrong one
// at least does not come back every few seconds.
export const WAVE={near:450,coolMs:120000,shakeN:12,shakeMs:2000,shakeMm:18,shakeTurns:5,stillMs:2500,lag2:.75};
export class WaveWatch{
  constructor(limits=WAVE){this.limits=limits;this.reset();this.lastAt=-Infinity;}
  reset(){this.recent=[];}
  // One reading at time now (ms). Returns {shake} (mm on average between readings) for a wave.
  feed(reading,now){
    const L=this.limits,mm=forceMm(reading);
    if(mm===undefined||!Number.isFinite(now))return undefined;
    if(!(mm>0&&mm<=L.near)){this.recent=[];return undefined;}
    this.recent.push({mm,at:now});if(this.recent.length>L.shakeN)this.recent.shift();
    const r=this.recent;
    if(r.length<L.shakeN||now-r[0].at>L.shakeMs||now-this.lastAt<L.coolMs)return undefined;
    let sum=0,turns=0,prev=0;
    for(let k=1;k<r.length;k++){const d=r[k].mm-r[k-1].mm;sum+=Math.abs(d);if(d&&prev&&Math.sign(d)!==Math.sign(prev))turns++;if(d)prev=d;}
    const mean=sum/(r.length-1);
    if(mean<L.shakeMm||turns<L.shakeTurns)return undefined;
    let two=0;for(let k=2;k<r.length;k++)two+=Math.abs(r[k].mm-r[k-2].mm);
    const lag2=two/(r.length-2);
    if(L.lag2&&lag2<L.lag2*mean)return undefined;
    this.last=r.map(item=>item.mm).join(',');
    this.recent=[];this.lastAt=now;return {shake:Math.round(mean),lag2:Math.round(lag2)};
  }
}
