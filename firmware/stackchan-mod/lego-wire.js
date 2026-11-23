// The LEGO hub's language over Bluetooth (owner, 14 Nov 2026: «inizia ad implementare il collegamento bluetooth per hub
// lego 88012 e due motori 88013»). LEGO Wireless Protocol 3.0 (LWP3), published by LEGO: one GATT service with one
// characteristic, written without response and notified back; every message is
//   [length, hub id (always 0), message type, ...]
// with the length counting the whole message (one byte up to 127). The messages are pure (bytes in, bytes out); the
// link itself (createLegoHub, at the end) gets the host's Bluetooth class from mod.js, so that a pretend hub can stand in
// for it in the tests.
//
// The hardware: 88012 is the Technic Hub (Control+ / Powered Up, four ports A-D), 88013 the Technic Large Motor (L).
export const LEGO_SERVICE='00001623-1212-EFDE-1623-785FEABCD123';
export const LEGO_CHARACTERISTIC='00001624-1212-EFDE-1623-785FEABCD123';
export const LEGO_COMPANY=0x0397;            // the manufacturer id in the advertisement
export const TECHNIC_HUB=0x80;               // system type id of 88012 in the advertisement
export const PORTS={A:0,B:1,C:2,D:3};
export const PORT_NAMES=['A','B','C','D'];
// Device type ids of «Hub Attached I/O» that are motors this module may drive. 88013 (Technic L) is 0x2E.
export const DEVICES={0x2E:'technic-l',0x2F:'technic-xl',0x30:'technic-m-angular',0x31:'technic-l-angular',0x4B:'technic-m-grey',0x4C:'technic-l-grey',0x26:'boost-m',0x01:'simple'};
export const MOTOR_TYPES=new Set(Object.keys(DEVICES).map(Number));
const MSG={properties:0x01,actions:0x02,attached:0x04,error:0x05,feedback:0x82,command:0x81};

// One message with its length in front.
const message=(type,...payload)=>{const body=[0,type,...payload];return Uint8Array.from([body.length+1,...body]);};

// The power of a motor: −100…100 (%), whole numbers, never beyond `limit` (the robot's own ceiling).
export const clampPower=(power,limit=100)=>{const cap=Math.max(0,Math.min(100,Math.round(limit)));const value=Math.round(Number(power));return Number.isFinite(value)?Math.max(-cap,Math.min(cap,value)):0;};
const int8=value=>value&0xff;
// «Start Power» (Port Output Command 0x81, WriteDirectModeData 0x51, mode 0): the motor turns at that power until told
// otherwise. 0 lets it run free, 127 brakes. Startup 0x11: execute at once and report the end (feedback 0x82).
export function powerMessage(port,power,limit=100){return message(MSG.command,port,0x11,0x51,0x00,int8(clampPower(power,limit)));}
export function floatMessage(port){return message(MSG.command,port,0x11,0x51,0x00,0);}
export function brakeMessage(port){return message(MSG.command,port,0x11,0x51,0x00,127);}
// «Start Speed» (0x07): the motor keeps that speed with its own encoder, up to maxPower.
export function speedMessage(port,speed,maxPower=100,limit=100){return message(MSG.command,port,0x11,0x07,int8(clampPower(speed,limit)),clampPower(maxPower,limit),0);}
// Battery: ask once for an update of the property 0x06 (voltage in %).
export function batteryRequest(){return message(MSG.properties,0x06,0x05);}
export function batterySubscribe(){return message(MSG.properties,0x06,0x02);}
// Hub actions: 0x01 switch the hub off, 0x02 disconnect.
export function switchOffMessage(){return message(MSG.actions,0x01);}
export function disconnectMessage(){return message(MSG.actions,0x02);}

// What a notification from the hub says. Unknown messages are {type:'other'}; a broken one {type:'error'}.
export function parseLego(buffer){
  const bytes=buffer instanceof Uint8Array?buffer:new Uint8Array(buffer);
  if(bytes.length<3)return {type:'error'};
  let at=0,length=bytes[0];
  if(length&0x80){if(bytes.length<4)return {type:'error'};length=(length&0x7f)|(bytes[1]<<7);at=1;}
  if(length!==bytes.length)return {type:'error'};
  const type=bytes[at+2],body=bytes.subarray(at+3);
  switch(type){
    case MSG.attached:{
      if(body.length<2)return {type:'error'};
      const port=body[0],event=body[1];
      if(event===0)return {type:'detached',port};
      if(body.length<4)return {type:'error'};
      const device=body[2]|body[3]<<8;
      return {type:'attached',port,device,motor:MOTOR_TYPES.has(device),name:DEVICES[device]??'unknown',virtual:event===2};
    }
    case MSG.properties:
      if(body[0]===0x06&&body[1]===0x06&&body.length>=3)return {type:'battery',percent:body[2]};
      return {type:'other',message:type};
    case MSG.feedback:{
      // Pairs of [port, flags]: 0x02 completed, 0x04 discarded, 0x08 idle, 0x10 busy/full.
      const ports=[];for(let i=0;i+1<body.length;i+=2)ports.push({port:body[i],completed:!!(body[i+1]&0x02),discarded:!!(body[i+1]&0x04),idle:!!(body[i+1]&0x08)});
      return {type:'feedback',ports};
    }
    case MSG.error:return {type:'hubError',command:body[0],code:body[1]};
    default:return {type:'other',message:type};
  }
}
// Is this advertisement a Technic Hub? `data`: the manufacturer data after the company id, as the scan gives it.
export function isTechnicHub(company,data){
  const bytes=data instanceof Uint8Array?data:new Uint8Array(data??[]);
  return company===LEGO_COMPANY&&bytes.length>=2&&bytes[1]===TECHNIC_HUB;
}

// THE LINK. The robot's Bluetooth link to a LEGO Technic Hub 88012 with two Technic L motors 88013 (owner, 14 Nov 2026: «inizia
// ad implementare il collegamento bluetooth per hub lego 88012 e due motori 88013»). PREPARED, NEVER TRIED WITH A REAL
// HUB (the owner does not have it yet): tried only against a pretend hub (lego-hub.test.mjs).
//
// The robot is the Bluetooth client (central): it looks for an advertisement with LEGO's company id and the Technic
// Hub's system type (lego-wire.js isTechnicHub), connects, finds the LEGO service and its one characteristic, turns on
// its notifications and from then on writes LWP3 messages to it. The hub says which device is on each port (Hub
// Attached I/O): the first two motors, by port (A before B…), are left and right.
//
// Safety, the same as for the head (firmware.md): never more than LEGO_LIMITS.maxPower; every drive lasts at most
// LEGO_LIMITS.driveMs and then the motors are stopped by the robot itself (a command that is never followed by a stop
// cannot leave the motors running); stop() and a lost link stop them; nothing moves until the hub has said which ports
// have motors. Every write that fails is an error, never a success.
//
// Memory: the Bluetooth stack takes about 50 KB of the internal RAM (measured 14 Nov 2026, BLE server); with camera,
// detector and conversation that RAM is already short. So the link is opened only when switched on (mod.js, preference
// lego), and close() gives the Bluetooth back.

export const LEGO_LIMITS={maxPower:60,driveMs:3000,scanMs:60000,retryMs:5000};

// BLEClient: the host's class (module bleclient); uuid: btutils' uuid; timer: {set(fn,ms),clear(id)}; log(text);
// changed(state): idle, scanning, connecting, ready (motors known), lost, not_found, closed, error.
export function createLegoHub({BLEClient,uuid,timer,log=()=>{},changed=()=>{},limits=LEGO_LIMITS}){
  let client,device,characteristic,state='idle',motors=[],battery,driveTimer,scanTimer,retryTimer,closed=false;
  const set=next=>{if(state===next)return;state=next;try{changed(next);}catch{}};
  const say=text=>{try{log(`[robottino] lego ${text}\n`);}catch{}};
  const clear=id=>{if(id!==undefined)try{timer.clear(id);}catch{}};
  const write=bytes=>{
    if(!characteristic)return false;
    try{characteristic.writeWithoutResponse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));return true;}
    catch(error){say(`write failed ${String(error?.message??error).slice(0,40)}`);return false;}
  };
  const stopMotors=(brake=false)=>{
    clear(driveTimer);driveTimer=undefined;
    let ok=true;for(const port of motors)ok=write(brake?brakeMessage(port):floatMessage(port))&&ok;
    return ok;
  };
  const lost=reason=>{
    clear(driveTimer);driveTimer=undefined;characteristic=undefined;device=undefined;motors=[];
    if(closed)return;
    say(`lost: ${reason}`);set('lost');
    clear(retryTimer);retryTimer=timer.set(()=>{retryTimer=undefined;scan();},limits.retryMs);
  };
  const scan=()=>{
    if(closed||!client)return;
    try{client.startScanning({active:true,duplicates:false});}catch(error){say(`scan failed ${error}`);set('error');return;}
    set('scanning');say('looking for the hub');
    clear(scanTimer);scanTimer=timer.set(()=>{scanTimer=undefined;if(state!=='scanning')return;try{client.stopScanning();}catch{}say('no hub found');set('not_found');},limits.scanMs);
  };
  class Hub extends BLEClient{
    onReady(){scan();}
    onDiscovered(found){
      if(closed||state!=='scanning')return;
      const maker=found?.scanResponse?.manufacturerSpecific;
      if(!maker||!isTechnicHub(maker.identifier,maker.data))return;
      clear(scanTimer);scanTimer=undefined;
      try{this.stopScanning();}catch{}
      set('connecting');say(`hub found${found.scanResponse.completeName?': '+found.scanResponse.completeName:''}`);
      try{this.connect(found);}catch(error){lost(`connect ${error}`);}
    }
    onConnected(connected){if(closed){try{connected.close();}catch{}return;}device=connected;device.discoverPrimaryService(uuid([LEGO_SERVICE]));}
    onServices(services){
      const service=services?.[0];
      if(!service){say('no LEGO service');try{device?.close();}catch{}lost('service');return;}
      service.discoverCharacteristic(uuid([LEGO_CHARACTERISTIC]));
    }
    onCharacteristics(characteristics){
      const found=characteristics?.[0];
      if(!found){say('no LEGO characteristic');try{device?.close();}catch{}lost('characteristic');return;}
      characteristic=found;characteristic.enableNotifications();
    }
    onCharacteristicNotificationEnabled(){say('connected, waiting for the motors');write(batteryRequest());}
    onCharacteristicNotification(_characteristic,value){
      const event=parseLego(value);
      if(event.type==='attached'&&event.motor&&!event.virtual&&event.port<PORT_NAMES.length){
        if(!motors.includes(event.port)){motors.push(event.port);motors.sort((a,b)=>a-b);}
        say(`motor ${event.name} on port ${PORT_NAMES[event.port]}`);
        if(motors.length>=2)set('ready');
      }
      else if(event.type==='detached'&&motors.includes(event.port)){
        stopMotors();motors=motors.filter(port=>port!==event.port);say(`motor off port ${PORT_NAMES[event.port]??event.port}`);
        if(motors.length<2&&state==='ready')set('connecting');
      }
      else if(event.type==='battery')battery=event.percent;
      else if(event.type==='hubError')say(`hub error ${event.code} on command ${event.command}`);
    }
    onDisconnected(){lost('disconnected');}
  }
  return {
    start(){
      if(client||closed)return false;
      try{client=new Hub();}catch(error){say(`bluetooth not available ${String(error?.message??error).slice(0,40)}`);set('error');return false;}
      set('idle');return true;
    },
    // Both motors at once, −100…100 each (left, right), for `ms` at most, then the robot stops them. False: not done.
    drive(left,right,ms=1000){
      if(state!=='ready'||motors.length<2)return false;
      const time=Math.max(50,Math.min(limits.driveMs,Number(ms)||0));
      const ok=write(powerMessage(motors[0],left,limits.maxPower))&&write(powerMessage(motors[1],right,limits.maxPower));
      clear(driveTimer);
      if(!ok){stopMotors();return false;}
      driveTimer=timer.set(()=>{driveTimer=undefined;stopMotors();},time);
      return true;
    },
    stop:(brake=false)=>stopMotors(brake),
    close(){
      if(closed)return;
      stopMotors();closed=true;clear(scanTimer);clear(retryTimer);
      try{device?.close();}catch{}
      try{client?.close();}catch{}
      client=undefined;device=undefined;characteristic=undefined;motors=[];set('closed');
    },
    get state(){return state;},
    get motors(){return motors.map(port=>PORT_NAMES[port]);},
    get battery(){return battery;},
    get driving(){return driveTimer!==undefined;}
  };
}
