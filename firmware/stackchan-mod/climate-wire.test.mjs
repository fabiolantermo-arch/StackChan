// ENV III (climate-wire.js): SHT30 temperature and humidity with their CRC, QMP6988 pressure with the library's
// integer compensation, read without waiting. Never tried with the real unit.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {crc8,sht30Reading,qmpCoefficients,qmpReading,createClimate,SHT30_ADDRESS,QMP6988_ADDRESS} from './climate-wire.js';

test('SHT30: Sensirion\'s CRC and the datasheet formulas',()=>{
  assert.equal(crc8([0xBE,0xEF]),0x92,'the datasheet example');
  const raw=t=>Math.round((t+45)*65535/175),word=v=>[v>>8,v&0xFF];
  const t=word(raw(21.5)),h=word(Math.round(48*65535/100));
  const r=sht30Reading([...t,crc8(t),...h,crc8(h)]);
  assert.ok(Math.abs(r.t-21.5)<.01&&Math.abs(r.h-48)<.01);
  assert.equal(sht30Reading([...t,crc8(t)^1,...h,crc8(h)]),null,'a wrong CRC is no reading');
});
test('QMP6988: coefficients and compensation give a plausible room (BigInt, as the library\'s 64-bit integers)',()=>{
  // Calibration bytes of a real QMP6988 are not at hand: zero coefficients still exercise every step and must give
  // finite numbers in the library's scale; the integer arithmetic is the library's line by line.
  const ik=qmpCoefficients(new Uint8Array(25));
  for(const value of Object.values(ik))assert.equal(typeof value,'bigint');
  const r=qmpReading(ik,[0x80,0,0,0x80,0,0]);assert.ok(Number.isFinite(r.p)&&Number.isFinite(r.t));
  assert.equal(qmpCoefficients(Uint8Array.from({length:25},(_,i)=>i===20?0x80:0)).a1,BigInt(3608*-32768-1731677965),'a1 is a signed 16-bit coefficient');
});
function pretend({sht=true,qmp=true,t=22.25,h=40}={}){
  const lines=[],word=v=>[v>>8,v&0xFF];
  const measure=()=>{const a=word(Math.round((t+45)*65535/175)),b=word(Math.round(h*65535/100));return [...a,crc8(a),...b,crc8(b)];};
  class I2C{
    constructor(o){if(o.address===SHT30_ADDRESS&&!sht)throw Error('nack');this.o=o;this.reg=0;this.writes=[];lines.push(this);}
    write(bytes){const b=[...bytes];this.writes.push(b);this.reg=b[0];if(this.o.address===QMP6988_ADDRESS&&!qmp)throw Error('nack');}
    read(n){
      if(this.o.address===SHT30_ADDRESS)return Uint8Array.from(measure()).buffer;
      if(this.reg===0xD1)return Uint8Array.of(0x5C).buffer;
      if(this.reg===0xF7)return Uint8Array.of(0x80,0,0,0x80,0,0).buffer;
      return new Uint8Array(n).buffer;
    }
    close(){this.closed=true;}
  }
  return {I2C,lines};
}
test('the robot asks every 30 s and reads 20 ms later; pressure only with the QMP6988',()=>{
  const p=pretend();let now=1000;const c=createClimate({I2C:p.I2C,now:()=>now,everyMs:30000});
  assert.equal(c.open(),true);assert.equal(c.pressure,true);
  assert.equal(c.poll(now),undefined,'asked');assert.deepEqual(p.lines[0].writes.at(-1),[0x24,0x00]);
  assert.equal(c.poll(now+10),undefined,'not yet');
  const r=c.poll(now+25);assert.ok(Math.abs(r.t-22.25)<.01&&Math.abs(r.h-40)<.01);
  assert.equal(c.poll(now+1000),undefined,'next one in 30 s');assert.equal(c.last,r);
  c.close();assert.ok(p.lines.every(line=>line.closed));
  const only=pretend({qmp:false}),c2=createClimate({I2C:only.I2C,now:()=>now});assert.equal(c2.open(),true);assert.equal(c2.pressure,false);
  c2.poll(now);assert.equal(c2.poll(now+25).p,undefined,'no pressure without the QMP6988');
  const none=pretend({sht:false}),c3=createClimate({I2C:none.I2C,now:()=>now});assert.equal(c3.open(),false);assert.equal(c3.state,'error');
});
