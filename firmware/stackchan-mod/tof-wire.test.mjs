// The VL53L0X driver (tof-wire.js) against a pretend sensor at register level: the start sequence, continuous ranging,
// and the library's timing arithmetic. Never tried with the real sensor.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTof,TOF_ADDRESS,TOF_RANGE,TOF_NEAR_HOLD_MS,decodeTimeout,encodeTimeout,calcMacroPeriod,mclksToMicroseconds,microsecondsToMclks,decodeVcselPeriod} from './tof-wire.js';

function pretend({model=0xEE,stuck=false,missing=false}={}){
  const regs=new Uint8Array(256),writes=[],lines=[];let pointer=0,ready=false,range=0;
  regs[0xC0]=model;regs[0x91]=0x3C;regs[0x92]=0x85;regs[0x50]=0x06;regs[0x70]=0x04;regs[0x46]=0x25;regs[0x51]=0x00;regs[0x52]=0x96;regs[0x71]=0x01;regs[0x72]=0xFE;
  regs.set([0xFF,0xFF,0xFF,0xFF,0xFF,0xFF],0xB0);
  class I2C{
    constructor(options){if(missing)throw Error('i2c');this.options=options;lines.push(this);}
    write(bytes){
      const b=[...bytes];pointer=b[0];writes.push(b);
      for(let i=1;i<b.length;i++)regs[(pointer+i-1)&0xFF]=b[i];
      // A calibration or ranging start makes a result ready, unless the pretend sensor is stuck.
      // Register 0x00 is SYSRANGE_START only on the main page (0xFF and 0x80 at 0); elsewhere the paging sequences use it.
      if(b[0]===0x00&&b.length===2&&(b[1]&0x01)&&regs[0xFF]===0&&regs[0x80]===0&&!stuck)ready=true;
      if(b[0]===0x0B&&b.length===2)ready=false;
    }
    read(count){
      const out=new Uint8Array(count);
      for(let i=0;i<count;i++){
        const reg=(pointer+i)&0xFF;
        out[i]=reg===0x83?(stuck?0:0x10):reg===0x13?(ready?0x07:0x00):reg===0x1E?(range>>8):reg===0x1F?(range&0xFF):regs[reg];
      }
      return out.buffer;
    }
    close(){this.closed=true;}
  }
  return {I2C,regs,writes,lines,measure(mm){range=mm;ready=true;}};
}
const clock=()=>{let t=0;return ()=>(t+=1);};

test('the library\'s timing arithmetic',()=>{
  assert.equal(decodeVcselPeriod(0x06),14);assert.equal(decodeVcselPeriod(0x04),10);
  assert.equal(calcMacroPeriod(14),Math.floor((2304*14*1655+500)/1000));
  for(const mclks of [1,2,255,256,257,1000,5000,40000])assert.equal(decodeTimeout(encodeTimeout(mclks))>=mclks-((mclks>>8)||0)&&decodeTimeout(encodeTimeout(mclks))<=mclks,true,`round trip ${mclks}`);
  assert.equal(encodeTimeout(0),0);assert.equal(decodeTimeout(0x0096),0x97);
  const us=mclksToMicroseconds(500,14);assert.ok(Math.abs(microsecondsToMclks(us,14)-500)<=1);
});
test('open: the start sequence as the library, then continuous timed ranging; a distance when the sensor has one',()=>{
  const p=pretend(),tof=createTof({I2C:p.I2C,now:clock()});
  assert.equal(tof.open(),true);assert.equal(tof.state,'ready');
  assert.equal(p.lines[0].options.address,TOF_ADDRESS);assert.deepEqual([p.lines[0].options.data,p.lines[0].options.clock],[2,1],'Port A, shared with the rover');
  assert.ok(p.writes.some(w=>w[0]===0x89&&(w[1]&1)),'2V8 I/O');
  assert.ok(p.writes.some(w=>w[0]===0x44&&w[1]===0&&w[2]===32),'signal rate limit 0.25 MCPS');
  assert.ok(p.writes.some(w=>w[0]===0xB0&&w.length===7),'reference SPAD map written back');
  assert.deepEqual(p.writes.at(-1),[0x00,0x04],'timed continuous mode');
  assert.ok(p.writes.some(w=>w[0]===0x04&&w.length===5),'the period');
  assert.equal(tof.poll(),undefined,'nothing new yet');
  p.measure(812);const d=tof.poll();assert.equal(d.mm,812);assert.equal(d.valid,true);assert.deepEqual(p.writes.at(-1),[0x0B,0x01],'interrupt cleared');
  assert.equal(tof.poll(),undefined);
  p.measure(8190);assert.equal(tof.poll().valid,false,'nothing in front');p.measure(10);assert.equal(tof.poll().valid,false);
  // «Nothing in range» right after a near reading: still near, the last near distance kept (code check, 19 Nov 2026).
  p.measure(8190);let n=tof.poll();assert.deepEqual([n.mm,n.valid,n.near,n.raw],[10,false,true,8190]);
  p.measure(8190);n=tof.poll();assert.equal(n.near,true,'still near for a moment');
  p.measure(400);n=tof.poll();assert.deepEqual([n.mm,n.valid,n.near],[400,true,undefined]);
  p.measure(8190);n=tof.poll();assert.equal(n.near,undefined,'after a far reading it is far');assert.equal(n.mm,8190);
  assert.ok(TOF_RANGE.max>=1500);
  tof.close();assert.equal(p.lines[0].closed,true);assert.equal(tof.state,'closed');
});
test('not a VL53L0X, no answer or a calibration that never ends: not ready, the line given back',()=>{
  for(const options of [{model:0x00},{stuck:true},{missing:true}]){
    const p=pretend(options),tof=createTof({I2C:p.I2C,now:clock(),waitMs:50});
    assert.equal(tof.open(),false,JSON.stringify(options));assert.equal(tof.state,'error');assert.ok(tof.failure);
    if(p.lines[0])assert.equal(p.lines[0].closed,true);
    assert.equal(tof.poll(),undefined);
  }
});

test('«still near» lasts only a moment after the last true near reading (code review, 19 Nov 2026)',()=>{
  let t=0;const p=pretend(),tof=createTof({I2C:p.I2C,now:()=>t});assert.equal(tof.open(),true);
  t=1000;p.measure(120);assert.equal(tof.poll().mm,120);
  t=1050;p.measure(8190);assert.equal(tof.poll().near,true,'the hand still against it');
  t=1000+TOF_NEAR_HOLD_MS;p.measure(8190);assert.equal(tof.poll().near,true);
  t=1001+TOF_NEAR_HOLD_MS;p.measure(8190);const n=tof.poll();assert.equal(n.near,undefined,'taken away, nothing in front: far');assert.equal(n.mm,8190);
  t=3000;p.measure(8190);assert.equal(tof.poll().near,undefined,'and it stays far');
});
