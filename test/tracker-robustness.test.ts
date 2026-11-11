import {it,expect} from 'vitest';
import {TargetTracker} from '../firmware/stackchan-mod/tracker.js';
import {MotionClock} from '../firmware/stackchan-mod/clock.js';
it('rejects unnamed, oversized and invalid targets and nonfinite timing',()=>{
  for(const id of [undefined,'',123,'x'.repeat(65),'../../bad']){
    const t=new TargetTracker();expect(t.accept({id,x:.5,y:.5,confidence:1,sequence:0},100)).toBe(false);
  }
  const t=new TargetTracker();expect(t.accept({id:'face',x:.5,y:.5,confidence:1,sequence:0},NaN)).toBe(false);
  expect(t.accept({id:'face',x:.5,y:.5,confidence:1,sequence:0},100)).toBe(true);
  expect(t.accept({id:'face',x:.5,y:.5,confidence:1,sequence:1},99)).toBe(false);
});
it('uses SDK wrap-aware deltas and fails closed on invalid/backwards timing',()=>{
  let ticks=2147483600;
  const clock=new MotionClock(()=>ticks,(a,b)=>(b-a)|0);
  expect(clock.now()).toBe(0);ticks=-2147483596;expect(clock.now()).toBe(100);
  ticks=-2147483496;expect(clock.now()).toBe(200);
  ticks--;expect(Number.isNaN(clock.now())).toBe(true);
  ticks=1000;expect(Number.isNaN(clock.now())).toBe(true);
});
it('turns toward the face: right is negative yaw, up is negative pitch, never down',()=>{
  const at=(x:number,y:number)=>{const t=new TargetTracker();t.enabled=true;for(let now=0;now<=3000;now+=100){t.accept({id:'face',x,y,confidence:1,sequence:now},now);t.tick(now);}return t;};
  const right=at(1,.5);expect(right.yaw).toBeCloseTo(-.8);expect(right.pitch).toBeCloseTo(0);
  const up=at(.5,0);expect(up.pitch).toBeCloseTo(-.52);expect(up.yaw).toBeCloseTo(0);
  const down=at(0,1);expect(down.pitch).toBe(0);expect(down.yaw).toBeCloseTo(.8);
});
it('fails closed if the clock moves backwards or becomes nonfinite',()=>{
  for(const bad of [NaN,Infinity,99]){
    const t=new TargetTracker();t.enabled=true;t.accept({id:'face',x:1,y:1,confidence:1,sequence:0},100);t.tick(100);
    expect(t.tick(bad).active).toBe(false);expect(t.enabled).toBe(false);expect(Number.isFinite(t.yaw)).toBe(true);
  }
});
