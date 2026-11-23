// How Robottino wakes up when it starts (owner, 14 Nov 2026, in place of a start-up video: «fai tu un'animazione del
// volto della ragazza che passi da occhi chiusi a occhi aperti», «con dissolvenza dal nero iniziale», «deve
// sbadigliare e dire "ciao, eccomi" all'avvio»). Pure: the times and what to show at each moment; mod.js does it.
//
//  1. Black screen, then the face appears with its eyes closed: the screen's light goes up from off (the host's
//     power.brightness, 0…100) in WAKE_FADE_MS, faster at the end, as an eye adjusts.
//  2. A yawn (assets/sbadiglio.bin, «Uaaa… mmh»): the mouth opens slowly and wide, stays, closes for the «mmh».
//  3. The eyes open (the pictures <style>wake-N of prepare-wake-eyes.swift: 0 closed … 3 nearly open): halfway, a
//     sleepy droop, then open.
//  4. «Ciao, eccomi!» (assets/ciao-eccomi.bin), the mouth following the recording (phrase-mouths.js).
// The recordings are Robottino's own voice (ElevenLabs), made as the other phrases (prepare-phrase.mjs).
export const WAKE_YAWN='sbadiglio.bin',WAKE_HELLO='ciao-eccomi.bin';
export const WAKE_FADE_MS=1500,WAKE_YAWN_AT=1700,WAKE_HELLO_GAP_MS=300,WAKE_LIMIT_MS=15000;
// The mouth during the yawn, one digit for every 50 ms (as phrase-mouths.js: 0 closed … 4 wide open): opening for
// 0.25 s as the «Uaaa» begins, wide while it lasts (the first second of the recording), closed for the «mmh» (said
// with the mouth shut; it ends at 1.85 s).
export const YAWN_MOUTH='0123444444444444432100000000000000000';
// The eyes after the yawn: [ms from when they begin to open, picture]; undefined: open (the serene face).
export const WAKE_EYES=[[0,0],[250,1],[500,2],[850,1],[1250,2],[1450,3],[1600,undefined]];
// The eye picture at `elapsed` ms from when the eyes begin to open.
export function wakeEyes(elapsed){
  let step=0;for(const [at,picture] of WAKE_EYES)if(elapsed>=at)step=picture;
  return step;
}
export const WAKE_EYES_MS=WAKE_EYES.at(-1)[0];
// The screen's light at `elapsed` ms, towards `target` (what it was before: the host's own setting).
// The K151's screen light (the AXP2101's DLDO1, Moddable's m5stack_cores3 setup-target.js) has only nine steps,
// and the lowest ones give no light at all: the voltage is 0.5 V + 0.1 V a step, steps 20…28 for 1…100%, and the
// backlight lights from about 2.8 V (step 23, 37%). So the fade goes from WAKE_LIGHT_FIRST% (the first step that
// lights) up to the target, evenly; under it the screen is off. (First try, 14 Nov 2026: a curve from 1%, the screen
// stayed black for 0.9 s and then lit almost at once.)
export const WAKE_LIGHT_FIRST=37;
export function wakeBrightness(elapsed,target){
  if(!(elapsed>0))return 0;
  if(elapsed>=WAKE_FADE_MS||target<=WAKE_LIGHT_FIRST)return target;
  return Math.round(WAKE_LIGHT_FIRST+(target-WAKE_LIGHT_FIRST)*elapsed/WAKE_FADE_MS);
}
