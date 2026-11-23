// The ST VL53L0X distance sensor (M5Stack «ToF» unit) on the robot's Port A, for the rover to follow the owner
// (owner, 15 Nov 2026: «inizia a programmare il VL53L0X per potermi seguire»). PREPARED, NEVER TRIED WITH THE REAL
// SENSOR. It shares Port A with the rover (I2C, different addresses: rover 0x38, this 0x29) through a Grove hub.
//
// Ported from Pololu's VL53L0X Arduino library (github.com/pololu/vl53l0x-arduino, VL53L0X.cpp, read on 15 Nov 2026),
// which is based on ST's API (STSW-IMG005). Its licence asks for these notices to be kept:
//   Copyright (c) 2017-2022 Pololu Corporation. MIT licence: permission is granted, free of charge, to use, copy,
//   modify, merge, publish, distribute, sublicense and/or sell copies, provided the copyright notice and this
//   permission notice are included; THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
//   Parts derived from ST's API: Copyright © 2016, STMicroelectronics International N.V. All rights reserved.
//   Redistribution and use in source and binary forms, with or without modification, are permitted provided that
//   source keeps this copyright notice, the conditions and the disclaimer; the name of STMicroelectronics may not be
//   used to endorse products; THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS «AS IS», WITHOUT ANY WARRANTY, and
//   in no event shall STMicroelectronics be liable for any damages arising from its use.
// Same sequence as the library's init() (DataInit, StaticInit with the reference SPADs and the default tuning
// settings, GPIO set to «new sample ready», timing budget recalculated, VHV and phase calibration), 2V8 I/O. Only
// what Robottino needs: continuous timed ranging, read without waiting (poll) from the robot's cycle.
export const TOF_ADDRESS=0x29;
// Readings outside this window are not a person in front of the robot (8190/8191 and 65535 mean «nothing»).
export const TOF_RANGE={min:30,max:2000};
// «Nothing in range» (8190) right after a reading nearer than TOF_NEAR_MM is a hand or a thing still against the
// sensor, not the way gone free (code check, 19 Nov 2026: the hand at 3 cm read «nothing» once). The reading then
// keeps the last near distance, not valid, with near:true and the sensor's own value in raw, for TOF_NEAR_HOLD_MS after
// the last true near reading: the Force effect does not take it for a hand gone far, the rover stops for it as for an
// obstacle. After that it is «nothing in range» again (code review, 19 Nov 2026: held for ever, a hand taken away in
// front of an empty room kept a phantom obstacle at a few cm and the rover refused every move forward).
export const TOF_NEAR_MM=250,TOF_NEAR_HOLD_MS=500;
const REG={SYSRANGE_START:0x00,SYSTEM_SEQUENCE_CONFIG:0x01,SYSTEM_INTERMEASUREMENT_PERIOD:0x04,SYSTEM_INTERRUPT_CONFIG_GPIO:0x0A,
  SYSTEM_INTERRUPT_CLEAR:0x0B,RESULT_INTERRUPT_STATUS:0x13,RESULT_RANGE_STATUS:0x14,MSRC_CONFIG_CONTROL:0x60,
  FINAL_RANGE_CONFIG_MIN_COUNT_RATE_RTN_LIMIT:0x44,PRE_RANGE_CONFIG_VCSEL_PERIOD:0x50,PRE_RANGE_CONFIG_TIMEOUT_MACROP_HI:0x51,
  FINAL_RANGE_CONFIG_VCSEL_PERIOD:0x70,FINAL_RANGE_CONFIG_TIMEOUT_MACROP_HI:0x71,MSRC_CONFIG_TIMEOUT_MACROP:0x46,
  IDENTIFICATION_MODEL_ID:0xC0,OSC_CALIBRATE_VAL:0xF8,GLOBAL_CONFIG_SPAD_ENABLES_REF_0:0xB0,GLOBAL_CONFIG_REF_EN_START_SELECT:0xB6,
  DYNAMIC_SPAD_NUM_REQUESTED_REF_SPAD:0x4E,DYNAMIC_SPAD_REF_EN_START_OFFSET:0x4F,GPIO_HV_MUX_ACTIVE_HIGH:0x84,
  VHV_CONFIG_PAD_SCL_SDA__EXTSUP_HV:0x89};
// The library's DefaultTuningSettings (vl53l0x_tuning.h), register then value, in order.
const TUNING=[0xFF,0x01,0x00,0x00,0xFF,0x00,0x09,0x00,0x10,0x00,0x11,0x00,0x24,0x01,0x25,0xFF,0x75,0x00,0xFF,0x01,0x4E,0x2C,
  0x48,0x00,0x30,0x20,0xFF,0x00,0x30,0x09,0x54,0x00,0x31,0x04,0x32,0x03,0x40,0x83,0x46,0x25,0x60,0x00,0x27,0x00,0x50,0x06,
  0x51,0x00,0x52,0x96,0x56,0x08,0x57,0x30,0x61,0x00,0x62,0x00,0x64,0x00,0x65,0x00,0x66,0xA0,0xFF,0x01,0x22,0x32,0x47,0x14,
  0x49,0xFF,0x4A,0x00,0xFF,0x00,0x7A,0x0A,0x7B,0x00,0x78,0x21,0xFF,0x01,0x23,0x34,0x42,0x00,0x44,0xFF,0x45,0x26,0x46,0x05,
  0x40,0x40,0x0E,0x06,0x20,0x1A,0x43,0x40,0xFF,0x00,0x34,0x03,0x35,0x44,0xFF,0x01,0x31,0x04,0x4B,0x09,0x4C,0x05,0x4D,0x04,
  0xFF,0x00,0x44,0x00,0x45,0x20,0x47,0x08,0x48,0x28,0x67,0x00,0x70,0x04,0x71,0x01,0x72,0xFE,0x76,0x00,0x77,0x00,0xFF,0x01,
  0x0D,0x01,0xFF,0x00,0x80,0x01,0x01,0xF8,0xFF,0x01,0x8E,0x01,0x00,0x01,0xFF,0x00,0x80,0x00];

// The timing arithmetic of the library (pure, exported for the tests).
export const decodeVcselPeriod=reg=>((reg+1)<<1)&0xFF;
export const calcMacroPeriod=pclks=>Math.floor((2304*pclks*1655+500)/1000);
export const decodeTimeout=reg=>((((reg&0xFF)<<((reg>>8)&0xFF))&0xFFFF)+1)&0xFFFF;
export function encodeTimeout(mclks){
  if(!(mclks>0))return 0;
  let ls=mclks-1,ms=0;
  while(ls>0xFF){ls=Math.floor(ls/2);ms++;}
  return ((ms<<8)|(ls&0xFF))&0xFFFF;
}
export const mclksToMicroseconds=(mclks,pclks)=>Math.floor((mclks*calcMacroPeriod(pclks)+500)/1000);
export const microsecondsToMclks=(us,pclks)=>{const macro=calcMacroPeriod(pclks);return Math.floor((us*1000+Math.floor(macro/2))/macro);};
const OVERHEAD={start:1910,end:960,msrc:660,tcc:590,dss:690,pre:660,final:550};

// I2C: the host's embedded:io/i2c class (the same as the rover's). now(): milliseconds, for the waits of the start.
export function createTof({I2C,now,log,pins={data:2,clock:1},hz=100000,periodMs=50,waitMs=250}){
  let line,state='closed',stop=0,budget=0,last,failure,nearAt; // nearAt: the last true reading nearer than TOF_NEAR_MM
  const say=text=>{try{log?.(`[robottino] tof ${text}\n`);}catch{}};
  const write=bytes=>line.write(Uint8Array.from(bytes));
  const read=(reg,count)=>{write([reg]);return new Uint8Array(line.read(count));};
  const w8=(reg,value)=>write([reg,value&0xFF]);
  const w16=(reg,value)=>write([reg,(value>>8)&0xFF,value&0xFF]);
  const w32=(reg,value)=>write([reg,(value>>>24)&0xFF,(value>>>16)&0xFF,(value>>>8)&0xFF,value&0xFF]);
  const r8=reg=>read(reg,1)[0];
  const r16=reg=>{const b=read(reg,2);return (b[0]<<8)|b[1];};
  // Waits (only in open(): a few tens of ms) never longer than waitMs.
  // Also at most 20000 tries, in case the clock does not move while JavaScript waits.
  const until=test=>{const end=now()+waitMs;for(let tries=0;!test();tries++){if(now()>end||tries>20000)return false;}return true;};
  const enables=()=>{const c=r8(REG.SYSTEM_SEQUENCE_CONFIG);return {tcc:(c>>4)&1,dss:(c>>3)&1,msrc:(c>>2)&1,pre:(c>>6)&1,final:(c>>7)&1};};
  const timeouts=e=>{
    const prePclks=decodeVcselPeriod(r8(REG.PRE_RANGE_CONFIG_VCSEL_PERIOD));
    const msrcMclks=r8(REG.MSRC_CONFIG_TIMEOUT_MACROP)+1,msrcUs=mclksToMicroseconds(msrcMclks,prePclks);
    const preMclks=decodeTimeout(r16(REG.PRE_RANGE_CONFIG_TIMEOUT_MACROP_HI)),preUs=mclksToMicroseconds(preMclks,prePclks);
    const finalPclks=decodeVcselPeriod(r8(REG.FINAL_RANGE_CONFIG_VCSEL_PERIOD));
    let finalMclks=decodeTimeout(r16(REG.FINAL_RANGE_CONFIG_TIMEOUT_MACROP_HI));
    if(e.pre)finalMclks=(finalMclks-preMclks)&0xFFFF;
    return {msrcUs,preMclks,preUs,finalPclks,finalUs:mclksToMicroseconds(finalMclks,finalPclks)};
  };
  const getBudget=()=>{
    const e=enables(),t=timeouts(e);let us=OVERHEAD.start+OVERHEAD.end;
    if(e.tcc)us+=t.msrcUs+OVERHEAD.tcc;
    if(e.dss)us+=2*(t.msrcUs+OVERHEAD.dss);else if(e.msrc)us+=t.msrcUs+OVERHEAD.msrc;
    if(e.pre)us+=t.preUs+OVERHEAD.pre;
    if(e.final)us+=t.finalUs+OVERHEAD.final;
    return us;
  };
  const setBudget=target=>{
    const e=enables(),t=timeouts(e);let used=OVERHEAD.start+OVERHEAD.end;
    if(e.tcc)used+=t.msrcUs+OVERHEAD.tcc;
    if(e.dss)used+=2*(t.msrcUs+OVERHEAD.dss);else if(e.msrc)used+=t.msrcUs+OVERHEAD.msrc;
    if(e.pre)used+=t.preUs+OVERHEAD.pre;
    if(!e.final)return true;
    used+=OVERHEAD.final;if(used>target)return false;
    let mclks=microsecondsToMclks(target-used,t.finalPclks);if(e.pre)mclks+=t.preMclks;
    w16(REG.FINAL_RANGE_CONFIG_TIMEOUT_MACROP_HI,encodeTimeout(mclks));budget=target;return true;
  };
  const refCalibration=vhv=>{
    w8(REG.SYSRANGE_START,0x01|vhv);
    if(!until(()=>(r8(REG.RESULT_INTERRUPT_STATUS)&0x07)!==0))return false;
    w8(REG.SYSTEM_INTERRUPT_CLEAR,0x01);w8(REG.SYSRANGE_START,0x00);return true;
  };
  const spadInfo=()=>{
    w8(0x80,0x01);w8(0xFF,0x01);w8(0x00,0x00);
    w8(0xFF,0x06);w8(0x83,r8(0x83)|0x04);w8(0xFF,0x07);w8(0x81,0x01);
    w8(0x80,0x01);w8(0x94,0x6b);w8(0x83,0x00);
    if(!until(()=>r8(0x83)!==0x00))return null;
    w8(0x83,0x01);const tmp=r8(0x92);
    w8(0x81,0x00);w8(0xFF,0x06);w8(0x83,r8(0x83)&~0x04);w8(0xFF,0x01);w8(0x00,0x01);w8(0xFF,0x00);w8(0x80,0x00);
    return {count:tmp&0x7f,aperture:((tmp>>7)&1)===1};
  };
  const init=()=>{
    if(r8(REG.IDENTIFICATION_MODEL_ID)!==0xEE){failure='not a VL53L0X';return false;}
    w8(REG.VHV_CONFIG_PAD_SCL_SDA__EXTSUP_HV,r8(REG.VHV_CONFIG_PAD_SCL_SDA__EXTSUP_HV)|0x01); // 2V8 I/O
    w8(0x88,0x00);
    w8(0x80,0x01);w8(0xFF,0x01);w8(0x00,0x00);stop=r8(0x91);w8(0x00,0x01);w8(0xFF,0x00);w8(0x80,0x00);
    w8(REG.MSRC_CONFIG_CONTROL,r8(REG.MSRC_CONFIG_CONTROL)|0x12);
    w16(REG.FINAL_RANGE_CONFIG_MIN_COUNT_RATE_RTN_LIMIT,Math.round(0.25*(1<<7))); // 0.25 MCPS, Q9.7
    w8(REG.SYSTEM_SEQUENCE_CONFIG,0xFF);
    const spad=spadInfo();if(!spad){failure='spad info timeout';return false;}
    const map=read(REG.GLOBAL_CONFIG_SPAD_ENABLES_REF_0,6);
    w8(0xFF,0x01);w8(REG.DYNAMIC_SPAD_REF_EN_START_OFFSET,0x00);w8(REG.DYNAMIC_SPAD_NUM_REQUESTED_REF_SPAD,0x2C);w8(0xFF,0x00);
    w8(REG.GLOBAL_CONFIG_REF_EN_START_SELECT,0xB4);
    const first=spad.aperture?12:0;let enabled=0;
    for(let i=0;i<48;i++){
      if(i<first||enabled===spad.count)map[i>>3]&=~(1<<(i%8));
      else if((map[i>>3]>>(i%8))&1)enabled++;
    }
    write([REG.GLOBAL_CONFIG_SPAD_ENABLES_REF_0,...map]);
    for(let i=0;i<TUNING.length;i+=2)w8(TUNING[i],TUNING[i+1]);
    w8(REG.SYSTEM_INTERRUPT_CONFIG_GPIO,0x04);w8(REG.GPIO_HV_MUX_ACTIVE_HIGH,r8(REG.GPIO_HV_MUX_ACTIVE_HIGH)&~0x10);w8(REG.SYSTEM_INTERRUPT_CLEAR,0x01);
    budget=getBudget();
    w8(REG.SYSTEM_SEQUENCE_CONFIG,0xE8);
    setBudget(budget);
    w8(REG.SYSTEM_SEQUENCE_CONFIG,0x01);if(!refCalibration(0x40)){failure='vhv calibration timeout';return false;}
    w8(REG.SYSTEM_SEQUENCE_CONFIG,0x02);if(!refCalibration(0x00)){failure='phase calibration timeout';return false;}
    w8(REG.SYSTEM_SEQUENCE_CONFIG,0xE8);
    return true;
  };
  // Continuous timed ranging (the library's startContinuous with a period).
  const start=()=>{
    w8(0x80,0x01);w8(0xFF,0x01);w8(0x00,0x00);w8(0x91,stop);w8(0x00,0x01);w8(0xFF,0x00);w8(0x80,0x00);
    let period=periodMs;const osc=r16(REG.OSC_CALIBRATE_VAL);if(osc!==0)period*=osc;
    w32(REG.SYSTEM_INTERMEASUREMENT_PERIOD,period>>>0);w8(REG.SYSRANGE_START,0x04);
  };
  const halt=()=>{try{w8(REG.SYSRANGE_START,0x01);w8(0xFF,0x01);w8(0x00,0x00);w8(0x91,0x00);w8(0x00,0x01);w8(0xFF,0x00);}catch{}};
  const shut=()=>{const old=line;line=undefined;try{old?.close();}catch{}};
  return {
    // Opens the line, sets the sensor up and starts measuring: true only if it answered as a VL53L0X all the way.
    open(){
      if(state==='ready')return true;
      shut();failure=undefined;last=undefined;nearAt=undefined;
      try{line=new I2C({...pins,hz,address:TOF_ADDRESS,timeout:50});}
      catch(error){line=undefined;state='error';failure=String(error?.message??error).slice(0,40);say(`cannot open ${failure}`);return false;}
      try{if(!init()){shut();state='error';say(`not ready: ${failure}`);return false;}start();}
      catch(error){shut();state='error';failure=String(error?.message??error).slice(0,40);say(`not found ${failure}`);return false;}
      state='ready';say(`ready, budget ${budget} us`);return true;
    },
    // From the robot's cycle: a new distance if the sensor has one (the library's readRangeContinuousMillimeters
    // without its wait). The last good one stays in `distance` with its time; nothing is a person beyond TOF_RANGE.
    poll(){
      if(state!=='ready')return undefined;
      try{
        if((r8(REG.RESULT_INTERRUPT_STATUS)&0x07)===0)return undefined;
        const raw=r16(REG.RESULT_RANGE_STATUS+10);w8(REG.SYSTEM_INTERRUPT_CLEAR,0x01);
        const at=now(),near=raw>TOF_RANGE.max&&nearAt!==undefined&&at-nearAt<=TOF_NEAR_HOLD_MS&&Number.isFinite(last?.mm);
        if(near)last={mm:last.mm,at,valid:false,near:true,raw};
        else{last={mm:raw,at,valid:raw>=TOF_RANGE.min&&raw<=TOF_RANGE.max};nearAt=raw<=TOF_NEAR_MM?at:undefined;}
        return last;
      }catch(error){failure=String(error?.message??error).slice(0,40);state='error';say(`read failed ${failure}`);return undefined;}
    },
    close(){if(line&&state==='ready')halt();shut();state='closed';last=undefined;nearAt=undefined;},
    get state(){return state;},
    get last(){return last;},
    get failure(){return failure;}
  };
}
