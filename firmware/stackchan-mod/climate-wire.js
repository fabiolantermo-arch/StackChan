// Temperature, humidity and pressure from M5Stack's ENV III unit (owner, 15 Nov 2026: «implementa lettura temperatura
// umidità con sensore SHT30+QMP6988»). PREPARED, NEVER TRIED WITH THE REAL UNIT. On Port A with the rover and the
// distance sensor, through a Grove hub (a plain hub: the PaHUB would take 0x70, the QMP6988's address).
//   SHT30 at 0x44: temperature and humidity. One measurement «high repeatability, no clock stretching» (0x24 0x00), read
//     at least 20 ms later: 6 bytes, temperature and humidity with a CRC each (Sensirion's CRC-8, 0x31, start 0xFF).
//     Formulas of the datasheet, the same as M5Stack's SHT3X.cpp: T = −45 + 175·raw/65535, RH = 100·raw/65535.
//   QMP6988 at 0x70: pressure (and its own temperature). Ported from M5Stack's M5Unit-ENV library (QMP6988.cpp, read on
//     15 Nov 2026): reset, the 25 calibration bytes from 0xA0, normal mode, filter 4, pressure ×8, temperature ×1; the
//     compensation in 64-bit integers (BigInt here) exactly as there.
//   M5Unit-ENV: MIT licence, Copyright (c) 2021 M5Stack. Permission is granted, free of charge, to use, copy, modify,
//   merge, publish, distribute, sublicense and/or sell copies, provided the copyright notice and this permission notice
//   are included; THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
// The robot reads it every CLIMATE_EVERY_MS, without waiting in between (trigger now, read on a later poll).
export const SHT30_ADDRESS=0x44,QMP6988_ADDRESS=0x70;
export const CLIMATE_EVERY_MS=30000;
const SHT_WAIT_MS=20;

// Sensirion CRC-8 (polynomial 0x31, start 0xFF).
export function crc8(bytes){let crc=0xFF;for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=crc&0x80?((crc<<1)^0x31)&0xFF:(crc<<1)&0xFF;}return crc;}
// SHT30's 6 bytes → {t,h} or null when a CRC is wrong.
export function sht30Reading(b){
  if(!b||b.length<6||crc8([b[0],b[1]])!==b[2]||crc8([b[3],b[4]])!==b[5])return null;
  return {t:-45+175*((b[0]<<8)|b[1])/65535,h:100*((b[3]<<8)|b[4])/65535};
}
// QMP6988 calibration: the 25 bytes from 0xA0 → the library's integer coefficients (ik).
export function qmpCoefficients(a){
  const s16=v=>(v<<16)>>16,word=i=>s16((a[i]<<8)|a[i+1]);
  const a0=((((a[18]<<12)|(a[19]<<4)|(a[24]&0x0f))<<12)>>12),b00=((((a[0]<<12)|(a[1]<<4)|((a[24]&0xf0)>>4))<<12)>>12);
  const B=BigInt;
  return {a0:B(a0),b00:B(b00),
    a1:B(3608*word(20)-1731677965),a2:B(16889*word(22)-87619360),
    bt1:2982n*B(word(2))+107370906n,bt2:329854n*B(word(4))+108083093n,bp1:19923n*B(word(6))+1133836764n,
    b11:2406n*B(word(8))+118215883n,bp2:3079n*B(word(10))-181579595n,b12:6846n*B(word(12))+85590281n,
    b21:13836n*B(word(14))+79333336n,bp3:2915n*B(word(16))+157155561n};
}
// The library's convTx02e and getPressure02e (BigInt: same truncations, arithmetic shifts as gcc's).
export function qmpTemperature(ik,dt){
  const d=BigInt(dt);const wk1=ik.a1*d;let wk2=(ik.a2*d)>>14n;wk2=(wk2*d)>>10n;wk2=((wk1+wk2)/32767n)>>19n;
  return Number(BigInt.asIntN(16,(ik.a0+wk2)>>4n));
}
export function qmpPressure(ik,dp,tx){
  const p=BigInt(dp),t=BigInt(tx);
  let wk1=ik.bt1*t,wk2=(ik.bp1*p)>>5n;wk1+=wk2;
  wk2=(ik.bt2*t)>>1n;wk2=(wk2*t)>>8n;let wk3=wk2;
  wk2=(ik.b11*t)>>4n;wk2=(wk2*p)>>1n;wk3+=wk2;
  wk2=(ik.bp2*p)>>13n;wk2=(wk2*p)>>1n;wk3+=wk2;
  wk1+=wk3>>14n;
  wk2=ik.b12*t;wk2=(wk2*t)>>22n;wk2=(wk2*p)>>1n;wk3=wk2;
  wk2=(ik.b21*t)>>6n;wk2=(wk2*p)>>23n;wk2=(wk2*p)>>1n;wk3+=wk2;
  wk2=(ik.bp3*p)>>12n;wk2=(wk2*p)>>23n;wk2=wk2*p;wk3+=wk2;
  wk1+=wk3>>15n;wk1/=32767n;wk1>>=11n;wk1+=ik.b00;
  return Number(BigInt.asIntN(32,wk1));
}
// QMP6988's 6 raw bytes from 0xF7 (pressure then temperature, 24 bits each) → {p (Pa), t (°C)}.
export function qmpReading(ik,b){
  const raw=i=>((b[i]<<16)|(b[i+1]<<8)|b[i+2])-8388608;
  const tx=qmpTemperature(ik,raw(3));return {t:tx/256,p:qmpPressure(ik,raw(0),tx)/16};
}

export function createClimate({I2C,now,log,pins={data:2,clock:1},hz=100000,everyMs=CLIMATE_EVERY_MS}){
  let sht,qmp,ik,state='closed',failure,last,asked,nextAt=0;
  const say=text=>{try{log?.(`[robottino] climate ${text}\n`);}catch{}};
  const shut=()=>{for(const line of [sht,qmp])try{line?.close();}catch{}sht=qmp=undefined;};
  const read=(line,reg,count)=>{line.write(Uint8Array.of(reg));return new Uint8Array(line.read(count));};
  const pause=ms=>{const end=now()+ms;for(let i=0;now()<end&&i<200000;i++);};
  const openQmp=()=>{
    try{
      const line=new I2C({...pins,hz,address:QMP6988_ADDRESS,timeout:50});
      if(read(line,0xD1,1)[0]!==0x5C){line.close();return;}
      line.write(Uint8Array.of(0xE0,0xE6));pause(20);line.write(Uint8Array.of(0xE0,0x00));
      const cal=new Uint8Array(25);for(let i=0;i<25;i++)cal[i]=read(line,0xA0+i,1)[0];
      ik=qmpCoefficients(cal);
      // Normal mode, temperature ×1, pressure ×8 (CTRL_MEAS 0xF4 = 001 100 11), filter 4 (0xF1 = 2).
      line.write(Uint8Array.of(0xF4,(1<<5)|(4<<2)|0x03));line.write(Uint8Array.of(0xF1,0x02));
      qmp=line;
    }catch(error){say(`no pressure sensor ${String(error?.message??error).slice(0,30)}`);}
  };
  return {
    // true when the SHT30 answers (temperature and humidity); the QMP6988 (pressure) is a bonus.
    open(){
      if(state==='ready')return true;
      shut();failure=undefined;last=undefined;asked=undefined;
      try{sht=new I2C({...pins,hz,address:SHT30_ADDRESS,timeout:50});sht.write(Uint8Array.of(0x30,0xA2));pause(2);} // soft reset
      catch(error){shut();state='error';failure=String(error?.message??error).slice(0,40);say(`not found ${failure}`);return false;}
      openQmp();state='ready';nextAt=0;say(`ready${qmp?' with pressure':''}`);return true;
    },
    // From the robot's cycle: asks for a measurement every everyMs, reads it 20 ms or more later. A new reading or nothing.
    poll(at=now()){
      if(state!=='ready')return undefined;
      try{
        if(asked===undefined){if(at<nextAt)return undefined;sht.write(Uint8Array.of(0x24,0x00));asked=at;return undefined;}
        if(at-asked<SHT_WAIT_MS)return undefined;
        asked=undefined;nextAt=at+everyMs;
        const th=sht30Reading(new Uint8Array(sht.read(6)));
        if(!th){say('crc');return undefined;}
        let p;if(qmp&&ik)try{p=qmpReading(ik,read(qmp,0xF7,6)).p;}catch{}
        last={t:th.t,h:th.h,...(Number.isFinite(p)&&p>30000&&p<110000?{p}:{}),at};return last;
      }catch(error){failure=String(error?.message??error).slice(0,40);state='error';say(`read failed ${failure}`);shut();return undefined;}
    },
    close(){shut();state='closed';last=undefined;asked=undefined;},
    get state(){return state;},get last(){return last;},get failure(){return failure;},get pressure(){return !!qmp;}
  };
}
