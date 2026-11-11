// Mouth is driven by FaceState audio energy, never by an independent oscillator.
export const PORTRAIT_FRAMES=['neutral','happy','sad','blink','talk-small','talk-open'];
// `blinking` comes from the face's own irregular schedule; without it, a fixed 4.7 s cadence.
/** Face styles and the prefix of their six 320×240 frames (same ids in app, relay and robot). */
export const FACE_STYLES={portrait:"girl-",white:"white-",redhead:"red-"};
// Mouth poses (9 Nov 2026): the robot draws the serene face once and changes only a small picture of the
// mouth over it (prepare-mouth-poses.swift), instead of swapping the whole 320×240 picture: a full-screen
// redraw at every syllable, in three positions only, made the lips move in jerks. Pose = openness .18, .35
// (talk-small), .58, .80 (talk-open), as the iPhone app fades them; the Worker sends the same poses.
export const MOUTH_POSES=[0,.18,.35,.58,.8];
export const mouthPose=open=>!(open>=.09)?0:open<.265?1:open<.465?2:open<.69?3:4;
/** Where the mouth pictures go in each face, and which picture each pose uses: the white robot is a drawing
 *  with sharp outlines, where a fade would show two mouths, so it keeps its two drawn mouths. */
export const MOUTH_BOXES={portrait:{left:126,top:172,width:72,height:54},white:{left:78,top:65,width:162,height:118},redhead:{left:116,top:171,width:98,height:62}};
export const MOUTH_IMAGES={portrait:[0,1,2,3,4],white:[0,2,2,4,4],redhead:[0,1,2,3,4]};
/** Talking over the angry and sad faces (prepare-mood-mouths.swift, 11 Nov 2026: «deve parlare con la faccia
 *  arrabbiata», then «deve parlare con la faccia triste»): their own four mouths, made from that picture, every face
 *  all four (the smoothest the poses allow). */
export const MOOD_MOUTH_BOXES={
  angry:{portrait:{left:130,top:176,width:70,height:50},white:{left:132,top:156,width:56,height:40},redhead:{left:130,top:176,width:70,height:50}},
  sad:{portrait:{left:128,top:180,width:70,height:50},white:{left:132,top:142,width:56,height:40},redhead:{left:128,top:178,width:70,height:50}},
};
export const ANGRY_MOUTH_BOXES=MOOD_MOUTH_BOXES.angry;
/** The picture under the mouth (neutral, happy, sad, angry, blink) and the mouth pose over it (0 = none). A blink
 *  shows the whole blinking picture: its mouth area is not the serene one. */
export function portraitView(state={},time=0,blinking){
  // Angry (emotion 1, upstream's ANGRY; only from a spoken face command, robot only) and sad (emotion 2): they stay
  // while talking, with their own mouths, and do not blink (the blinking picture is the serene face).
  if(state.emotion===1||state.emotion===2){const mood=state.emotion===1?'angry':'sad',mouth=mouthPose(Number.isFinite(state.mouth?.open)?state.mouth.open:0);return {base:mood,mouth,mood};}
  const phase=time%4700;
  if(Math.min(state.eyes?.left?.open??1,state.eyes?.right?.open??1)<.25 || (blinking??(phase>=4490&&phase<4610)))return {base:'blink',mouth:0};
  const mouth=mouthPose(Number.isFinite(state.mouth?.open)?state.mouth.open:0);
  if(mouth)return {base:'neutral',mouth};
  return {base:state.emotion===3?'happy':'neutral',mouth:0};
}
