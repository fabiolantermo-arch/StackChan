import {it,expect} from 'vitest';
import {DanceController} from '../firmware/stackchan-mod/dance.js';
import {TargetTracker,FOLLOW_SPEED} from '../firmware/stackchan-mod/tracker.js';
it('bounds angles and speed, finishes once and returns to its base pose',()=>{
  const never=new DanceController();never.start(0,{y:0,p:.3});expect(never.sample(100)?.p).toBe(0); // never below straight ahead
  const dance=new DanceController();expect(dance.start(0,{y:.52,p:-.2})).toBe(true);
  let last=.52;
  for(let now=100;now<=4300;now+=100){
    const pose=dance.sample(now);if(!pose)break;
    expect(Math.abs(pose.y)).toBeLessThanOrEqual(Math.PI/2);expect(pose.p).toBe(-.2);
    expect(Math.abs(pose.y-last)).toBeLessThanOrEqual(.0376);last=pose.y; // the dance's own pace (0.15 rad each way), well under the head speed
  }
  expect(dance.active).toBe(false);expect(last).toBeCloseTo(.52);expect(dance.sample(5000)).toBeNull();
});
it('cancels without sending a neutral jump and limits scheduler stalls',()=>{
  const dance=new DanceController();dance.start(1000,{y:0,p:0});
  expect(dance.start(1100,{y:0,p:0})).toBe(false);
  const pose=dance.sample(2400)!;expect(Math.abs(pose.y)).toBeLessThanOrEqual(.13);
  dance.stop();expect(dance.sample(2500)).toBeNull();
  dance.start(3000,{y:0,p:0});expect(dance.sample(2900)).toBeNull();expect(dance.active).toBe(false);
});
it('does not advance the virtual motor pose while tracking is disabled',()=>{
  const tracker=new TargetTracker();
  for(let i=0;i<10;i++){tracker.accept({id:'face',x:1,y:1,confidence:1,sequence:i},100+i*100);tracker.tick(100+i*100);}
  expect(tracker.yaw).toBe(0);expect(tracker.pitch).toBe(0);
  tracker.enabled=true;const pose=tracker.tick(1100).rotation!;
  expect(FOLLOW_SPEED).toBe(3);expect(Math.abs(pose.y)).toBeLessThanOrEqual(FOLLOW_SPEED*.1+1e-9); // one step of 0.1 s from straight ahead
});
