// Which side a voice comes from (owner, 14 Nov 2026: «girarsi verso la voce quando non ti vede»). The host compares
// its two microphones (firmware/host/face/sound-side-core.c) and says, for each piece of sound: how loud it was, by
// how many samples the second microphone heard it after the first (negative: before), and how alike the two were.
// This file decides when that means «somebody is speaking, on that side». Pure arithmetic: no microphone here.
//
// MEASURED ON THE ROBOT with the owner (14 Nov 2026, 13:41, «Prova orecchie», once): he spoke for about eight seconds
// from his left, from the middle and from his right, half a metre away. The two channels are two real microphones
// and hear the same sound (alike 0,95-0,99; his voice 250-1000, the silent room 20-40). But the delay hardly changes:
// median +0,06 samples from his left, −0,13 from the middle, −0,19…−0,25 from his right, single readings ±0,1-0,2
// around that (once +0,50 and −1,13). From side to side about 0,3 samples, 6 mm of the sound's way: the microphones
// are almost in the same place as far as left and right go. So: no angle; «left or right» only from the median of
// about a second of voice, and the middle cannot be told from the sides with any certainty. A wrong side costs
// little (mod.js only starts the look around from that side). The readings of that test are replayed in
// sound-ear.test.mjs. To be measured again before trusting the two numbers below.
export const EAR_MIN_LEVEL=120;    // quieter than this is never taken for a voice
export const EAR_OVER_ROOM=3;      // and it must be this many times louder than the room
export const EAR_MIN_QUALITY=.85;  // the two microphones must hear the same sound
export const EAR_MAX_LAG=1.5;      // a longer delay than these microphones give is an echo or a mistake
export const EAR_NEED=6,EAR_WINDOW_MS=1200,EAR_AGAIN_MS=3000; // six good pieces in little more than a second
// «Guardalo e parla» (mod.js): the conversation starts after half a second of voice (owner, 14 Nov 2026, 19:56: «porta
// a mezzo secondo il riconoscimento vocale per far partire la chiamata»): five pieces, one per turn of the robot's
// 100 ms cycle, within a second.
export const LOOK_NEED=5,LOOK_WINDOW_MS=1000;
// The delay from the middle, and how far from it before a side is said.
export const EAR_MIDDLE=-.10,EAR_SIDE_LAG=.07;
// The number the host gives for a piece of sound (face-finder.js soundSide), read into `out` with nothing made.
export const readSound=(value,out)=>{
  if(!(value>0))return undefined;
  out.level=value&65535;out.quality=((value>>>16)&255)/255;out.lag=(Math.floor(value/16777216)-128)/16;
  return out;
};
// The robot's side for a delay: 1 its left (the head's yaw grows that way), −1 its right, 0 not known. Seen from the
// front, the owner's left is the robot's right: there the delay was the highest.
export const sideOf=lag=>lag>=EAR_MIDDLE+EAR_SIDE_LAG?-1:lag<=EAR_MIDDLE-EAR_SIDE_LAG?1:0;
// The side to try first when the delay is too near the middle to say: whichever side of the middle it falls on.
// A guess and no more. Seen on the robot (14 Nov 2026, 15:57): the owner spoke from 61° to the robot's right and
// the delay was −0,13, the middle's own value, so the side was «not known»; the look around then began upwards,
// as it does for a lost face, and he was found at the fourth stop («invece di girarsi a sinistra verso di me ha
// guardato in alto»). With a guess the look around stays at his height and goes to one side first; when the guess
// is wrong it comes back the other way before it looks up. (Here the guess would have been wrong: these two
// microphones, almost in the same place, tell little. mod.js writes on the log where the face was then found, to
// learn from: `ear check`.)
export const guessOf=lag=>lag>=EAR_MIDDLE?-1:1;
export class SoundEar{
  room=40; // how loud the room is when nobody speaks: followed at once when it gets quieter, slowly when louder
  #times=[];#lags=[];#saidAt;#need;#window;
  constructor(need=EAR_NEED,windowMs=EAR_WINDOW_MS){this.#need=need;this.#window=windowMs;}
  // Returns {side, guess, lag, level} once a voice has been heard for long enough, otherwise nothing.
  update(level,lag,quality,now){
    const loud=level>=Math.max(EAR_MIN_LEVEL,this.room*EAR_OVER_ROOM);
    // A steady noise that starts (a fan) becomes the room in ten to twenty seconds; a voice does not in a sentence.
    this.room+=(level-this.room)*(level<this.room?.2:.003);
    const times=this.#times,lags=this.#lags;
    while(times.length&&now-times[0]>this.#window){times.shift();lags.shift();}
    if(!loud||!(quality>=EAR_MIN_QUALITY)||!(Math.abs(lag)<=EAR_MAX_LAG))return undefined;
    times.push(now);lags.push(lag);if(times.length>16){times.shift();lags.shift();}
    if(times.length<this.#need||now-this.#saidAt<EAR_AGAIN_MS)return undefined;
    const sorted=lags.slice().sort((a,b)=>a-b),middle=sorted.length>>1,median=sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
    this.#saidAt=now;times.length=0;lags.length=0;
    return {side:sideOf(median),guess:guessOf(median),lag:median,level};
  }
}
