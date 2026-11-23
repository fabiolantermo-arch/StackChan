// Mouth is driven by FaceState audio energy, never by an independent oscillator.
export const PORTRAIT_FRAMES=['neutral','happy','sad','blink','talk-small','talk-open'];
// `blinking` comes from the face's own irregular schedule; without it, a fixed 4.7 s cadence.
/** Face styles and the prefix of their six 320×240 frames (same ids in app, relay and robot). */
export const FACE_STYLES={portrait:"girl-",white:"white-",redhead:"red-",curly:"curly-"};
// Mouth poses (9 Nov 2026): the robot draws the serene face once and changes only a small picture of the
// mouth over it (prepare-mouth-poses.swift), instead of swapping the whole 320×240 picture: a full-screen
// redraw at every syllable, in three positions only, made the lips move in jerks. Pose = openness .18, .35
// (talk-small), .58, .80 (talk-open), as the iPhone app fades them; the Worker sends the same poses.
export const MOUTH_POSES=[0,.18,.35,.58,.8];
export const mouthPose=open=>!(open>=.09)?0:open<.265?1:open<.465?2:open<.69?3:4;
// Eight openings (12 Nov 2026: «la bocca… è a scatti»): the four poses and the step between each two, so that a change
// of the mouth is half as big. Level 2n is pose n; the Worker still sends poses, the robot passes through the steps.
export const MOUTH_LEVELS=[0,.09,.18,.265,.35,.465,.58,.69,.8];
export const mouthLevel=open=>!(open>=.045)?0:open<.135?1:open<.2225?2:open<.3075?3:open<.4075?4:open<.5225?5:open<.635?6:open<.745?7:8;
/** Where the mouth pictures go in each face, and which picture each pose uses: the white robot is a drawing
 *  with sharp outlines, where a fade would show two mouths, so it keeps its two drawn mouths. */
export const MOUTH_BOXES={portrait:{left:126,top:172,width:72,height:54},white:{left:78,top:65,width:162,height:118},redhead:{left:132,top:175,width:66,height:50},curly:{left:106,top:164,width:108,height:75}};
/** The mouth picture of each level (0 = none). The curly redhead (23 Nov 2026, prepare-curly.swift) has five mouths,
 *  drawn for her: 10, 25, 40, 60 and 80 per cent open. */
export const MOUTH_IMAGES={portrait:[0,1,2,3,4,5,6,7,8],white:[0,2,2,2,2,4,4,4,4],redhead:[0,1,2,3,4,5,6,7,8],curly:[0,1,2,2,3,3,4,4,5]};
/** The angry and sad faces have four mouths: one for every two levels. */
export const moodMouthImage=level=>Math.ceil(level/2);
/** Talking over the angry and sad faces (prepare-mood-mouths.swift, 11 Nov 2026: «deve parlare con la faccia
 *  arrabbiata», then «deve parlare con la faccia triste»): their own four mouths, made from that picture, every face
 *  all four (the smoothest the poses allow). */
export const MOOD_MOUTH_BOXES={
  angry:{portrait:{left:130,top:176,width:70,height:50},white:{left:132,top:156,width:56,height:40},redhead:{left:136,top:178,width:56,height:40},curly:{left:140,top:187,width:56,height:40}},
  sad:{portrait:{left:128,top:180,width:70,height:50},white:{left:132,top:142,width:56,height:40},redhead:{left:136,top:181,width:56,height:40},curly:{left:140,top:186,width:56,height:40}},
  // Scared (owner, 14 Nov 2026: «quando la capovolgo deve fare la faccia spaventata»): only the redhead has the
  // picture (red-scared.png, since 16 Nov 2026 from the owner's new pictures: prepare-redhead.swift) and its four
  // mouths; the other faces show their sad one instead.
  // The redhead's boxes are smaller since 16 Nov 2026: her face is 0.8 times the size it had (the whole hair in the screen).
  // The curly redhead has it too (her surprised picture, 23 Nov 2026).
  scared:{redhead:{left:135,top:181,width:56,height:40},curly:{left:140,top:187,width:56,height:40}},
};
/** The scared face: the host's emotion 6 (its COLD, which Robottino never used). */
export const SCARED=6;
// The eyes opening when Robottino wakes up (wake-up.js): pictures <style>wake-0…3 of this box, drawn over the serene
// face (prepare-wake-eyes.swift prints the boxes). The white robot has none: its eyes open at once.
export const WAKE_BOXES={portrait:{left:93,top:103,width:138,height:48},redhead:{left:116,top:122,width:96,height:32},curly:{left:86,top:96,width:148,height:78}};
export const WAKE_STEPS=4;
// The red dot that blinks in the top right corner during a conversation (owner, 14 Nov 2026: «durante la chiamata fai
// apparire un puntino rosso lampeggiante sullo schermo in alto a destra»): pictures <style>call-dot of this box, made
// by prepare-call-dot.swift on the corner of each face; half a second on, half off.
export const CALL_DOT={left:298,top:8,size:14,blinkMs:500};
// The hand of a gesture the robot has taken (owner, 23 Nov 2026: «una piccola iconcina con la mano… in alto a
// sinistra»): pictures <style>hand-<name> of this box, made by prepare-hand-icons.swift on the corner of each face,
// shown for ms after the gesture.
// The open hand (palm, «Fermo.») since 23 Nov 2026, with the owner's pictures; also shown when the Force pushes the head.
export const HAND_ICON={left:4,top:4,size:36,ms:2500,names:['thumbsUp','thumbsDown','wave','victory','palm']};
export const ANGRY_MOUTH_BOXES=MOOD_MOUTH_BOXES.angry;
// The shapes of the lips (owner, 16 Nov 2026: «nuove espressioni per migliorare movimenti labbra»): while Robottino
// speaks, the Worker sends with every mouth pose the shape of the letter said at that moment (src/robot-audio.ts
// LipTrack): 1 lips pressed (m, b, p), 2 round (o), 3 narrow and forward (u), 4 wide with the teeth (e, i), 5 teeth
// on the lower lip (f, v). Pictures <style>lips-<n> and <style>lips-<n>h (half way from the serene mouth, shown for
// an instant on the way to a shape), of this box, drawn over the serene face (prepare-redhead.swift prints the box).
// Only the redhead has them: the other faces keep the mouth that follows the loudness alone.
export const LIPS=5;
export const LIPS_BOXES={redhead:{left:128,top:175,width:72,height:50}};
// The pictures in between (17 Nov 2026: «rendi più realistico il movimento della bocca»): <style>lips-<a><b>, half way
// between two shapes shown whole (1, 2, 3, 5) or between one of them and a talking mouth (6 = talk-small, 7 =
// talk-open); the lower number first. The wide shape 4 only ever shows its half-way picture: it has none.
export const LIPS_WHOLE=[1,2,3,5];
export const LIPS_PICTURES=new Set([1,2,3,4,5].flatMap(n=>[`${n}`,`${n}h`]).concat(LIPS_WHOLE.flatMap((a,i)=>[...LIPS_WHOLE.slice(i+1).map(b=>`${a}${b}`),`${a}6`,`${a}7`])));
/** The picture to pass through on the way from one mouth to another, or undefined when the two are close enough.
 *  from, to: '' (the mouth of the loudness, at `level` of MOUTH_LEVELS) or a shape's picture ('2', '2h'). */
export function lipsBetween(from,to,level=0){
  const whole=name=>name.length===1&&LIPS_WHOLE.includes(Number(name));
  if(from&&to)return whole(from)&&whole(to)&&from!==to?(from<to?from+to:to+from):undefined;
  const shape=from||to;if(!shape||!whole(shape))return undefined;
  return level<=0?shape+'h':level<=5?shape+'6':shape+'7';
}
/** The picture under the mouth (neutral, happy, sad, angry, blink) and the mouth pose over it (0 = none). A blink
 *  shows the whole blinking picture: its mouth area is not the serene one. */
export function portraitView(state={},time=0,blinking,style){
  // Angry (emotion 1, upstream's ANGRY; only from a spoken face command, robot only) and sad (emotion 2): they stay
  // while talking, with their own mouths, and do not blink (the blinking picture is the serene face).
  // Scared (emotion 6, only when the robot is turned over): the same, for the face that has the picture; else sad.
  if(state.emotion===1||state.emotion===2||state.emotion===SCARED){const mood=state.emotion===1?'angry':state.emotion===SCARED&&MOOD_MOUTH_BOXES.scared[style]?'scared':'sad',mouth=mouthLevel(Number.isFinite(state.mouth?.open)?state.mouth.open:0);return {base:mood,mouth,mood};}
  const phase=time%4700;
  if(Math.min(state.eyes?.left?.open??1,state.eyes?.right?.open??1)<.25 || (blinking??(phase>=4490&&phase<4610)))return {base:'blink',mouth:0};
  // A shape of the lips (state.lips: the picture's name, '2', '2h', '26'…; from the letters of the reply): over the serene face, like the
  // talking mouths; not over the angry, sad and scared faces, which keep their own mouths, and not during a blink.
  if(typeof state.lips==='string'&&LIPS_PICTURES.has(state.lips)&&LIPS_BOXES[style])return {base:'neutral',mouth:0,lips:state.lips};
  const mouth=mouthLevel(Number.isFinite(state.mouth?.open)?state.mouth.open:0);
  if(mouth)return {base:'neutral',mouth};
  return {base:state.emotion===3?'happy':'neutral',mouth:0};
}
