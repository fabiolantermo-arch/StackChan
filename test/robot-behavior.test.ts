import {expect,it} from 'vitest';
import {TargetTracker,CAMERA_FOV,AIM_GAIN,FOLLOW_SPEED,AIM_YAW} from '../firmware/stackchan-mod/tracker.js';
import {portraitView} from '../firmware/stackchan-mod/portrait-state.js';
// What the robot shows: the picture, or the mouth pose drawn over the serene face.
const portraitFrame=(state:any,time:number)=>{const view=portraitView(state,time);return view.mouth?`mouth-${view.mouth}`:view.base;};
import {TouchReaction} from '../firmware/stackchan-mod/touch-reaction.js';
it('rejects invalid, replayed and low confidence detections',()=>{
  const t=new TargetTracker();
  expect(t.accept({x:NaN,y:0,confidence:1,sequence:1},0)).toBe(false);
  expect(t.accept({x:.5,y:.5,confidence:.3,sequence:1},0)).toBe(false);
  expect(t.accept({id:'a',x:.5,y:.5,confidence:1,sequence:1},0)).toBe(true);
  expect(t.accept({id:'a',x:.5,y:.5,confidence:1,sequence:1},1)).toBe(false);
});
it('starts without motor commands and holds still when target is stale',()=>{
  const t=new TargetTracker();t.accept({id:'a',x:1,y:0,confidence:1,sequence:1},100);
  expect(t.tick(100).rotation).toBeNull();t.enabled=true;
  const rotation=t.tick(200).rotation!;expect(Math.abs(rotation.y)).toBeLessThanOrEqual(FOLLOW_SPEED*.1+1e-9);
  expect(t.tick(1200).active).toBe(false);
});
it('does not switch targets suddenly and stays within conservative angles',()=>{
  const t=new TargetTracker();t.enabled=true;
  for(let i=0;i<100;i++){t.accept({id:'a',x:1,y:1,confidence:1,sequence:i},i*100);const r=t.tick(i*100).rotation!;expect(Math.abs(r.y)).toBeLessThanOrEqual(.8);expect(r.p).toBeLessThanOrEqual(0);expect(r.p).toBeGreaterThanOrEqual(-.52);}
  expect(t.accept({id:'b',x:0,y:0,confidence:1,sequence:101},9950)).toBe(false);
});
it('follows a face in the robot camera from the head pose of that frame, within the limits',()=>{
  const t=new TargetTracker();t.enabled=true;
  expect(t.aim(.5,.5,{y:NaN,p:0},0)).toBe(false);expect(t.aim(1.2,.5,{y:0,p:0},0)).toBe(false);
  // Face on the left and high in a frame taken with the head already turned 0.2 rad left: the goal adds to that pose.
  expect(t.aim(.25,.25,{y:.2,p:0},1000)).toBe(true);
  const goal={y:.2+.25*CAMERA_FOV.x*AIM_GAIN,p:-.25*CAMERA_FOV.y*AIM_GAIN};
  let r:any;for(let i=1;i<=15;i++)r=t.tick(1000+i*100).rotation;
  expect(r.y).toBeCloseTo(goal.y,1);expect(r.p).toBeCloseTo(goal.p,1);expect(r.p).toBeLessThan(0); // negative pitch looks up
  const still=new TargetTracker();still.enabled=true;still.aim(.52,.49,{y:0,p:0},0);expect(still.tick(100).rotation).toEqual({y:0,p:0,r:0}); // a centred face: no jitter
  const far=new TargetTracker();far.enabled=true;far.aim(0,1,{y:1.4,p:0},0);for(let i=1;i<=40;i++)far.tick(i*100);
  expect(far.yaw).toBeCloseTo(AIM_YAW,6);expect(AIM_YAW).toBeCloseTo(Math.PI/2,9); // never past 90° to the sideexpect(far.pitch).toBeLessThanOrEqual(0);expect(far.pitch).toBeGreaterThanOrEqual(-.52);
  expect(far.tick(1400+1600).active).toBe(false); // nobody seen for 1.5 s: holds where it is
});
it('keeps the mouth still without speech and follows real mouth energy',()=>{
  for(const time of [0,1000,2000,4000])expect(portraitFrame({},time)).toBe('neutral');
  expect(portraitFrame({mouth:{open:.3}},1000)).toBe('mouth-2'); // talk-small
  expect(portraitFrame({mouth:{open:.8}},1000)).toBe('mouth-4'); // talk-open
  expect(portraitView({emotion:3,mouth:{open:.58}},1000)).toEqual({base:'neutral',mouth:3});
  expect(portraitFrame({mouth:{open:NaN}},1000)).toBe('neutral');
});
it('handles a natural blink and emotions without autonomous lip motion',()=>{
  expect(portraitFrame({},4500)).toBe('blink');
  expect(portraitFrame({eyes:{left:{open:0},right:{open:0}}},1000)).toBe('blink');
  expect(portraitFrame({emotion:3},1000)).toBe('happy');
  expect(portraitFrame({emotion:2},1000)).toBe('sad');
});
it('temporarily smiles at touch while preserving speech and the latest base expression',()=>{
  const reaction=new TouchReaction();
  expect(reaction.accept('head',{gesture:'forwardSwipe'},1000)).toBe(true);
  const talking={emotion:2,mouth:{open:.8}};
  expect(reaction.apply(talking,1100).emotion).toBe(3);
  expect(portraitFrame(reaction.apply(talking,1100),1000)).toBe('mouth-4');
  expect(talking.emotion).toBe(2);
  const latest={emotion:1};expect(reaction.apply(latest,4100)).toBe(latest);
});
it('ignores release/noise, debounces touches and clears on stop',()=>{
  const reaction=new TouchReaction();
  expect(reaction.accept('head',{gesture:'release'},1000)).toBe(false);
  expect(reaction.accept('head',{gesture:'unknown'},1000)).toBe(false);
  expect(reaction.accept('screen',null,1000)).toBe(true);
  expect(reaction.accept('screen',null,1200)).toBe(false);
  expect(reaction.accept('head',{gesture:'press'},1500)).toBe(true);
  reaction.clear();expect(reaction.apply({emotion:2},1600).emotion).toBe(2);
});
