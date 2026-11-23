// The LEGO hub's messages (lego-wire.js): the bytes as LEGO Wireless Protocol 3.0 gives them. No hub needed.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {powerMessage,floatMessage,brakeMessage,speedMessage,batteryRequest,switchOffMessage,parseLego,isTechnicHub,clampPower,PORTS,LEGO_SERVICE} from './lego-wire.js';
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join(' ');

test('motor commands: length first, hub 0, Port Output Command, execute at once with feedback',()=>{
  assert.equal(hex(powerMessage(PORTS.A,50)),'08 00 81 00 11 51 00 32');
  assert.equal(hex(powerMessage(PORTS.B,-50)),'08 00 81 01 11 51 00 ce','backwards: two\'s complement');
  assert.equal(hex(floatMessage(PORTS.A)),'08 00 81 00 11 51 00 00');
  assert.equal(hex(brakeMessage(PORTS.B)),'08 00 81 01 11 51 00 7f');
  assert.equal(hex(speedMessage(PORTS.A,30,60)),'09 00 81 00 11 07 1e 3c 00');
  assert.equal(hex(batteryRequest()),'05 00 01 06 05');
  assert.equal(hex(switchOffMessage()),'04 00 02 01');
});
test('the robot\'s ceiling: never beyond the limit, nothing that is not a number',()=>{
  assert.equal(clampPower(80,40),40);assert.equal(clampPower(-80,40),-40);assert.equal(clampPower(12.6),13);
  assert.equal(clampPower('x'),0);assert.equal(clampPower(500),100);assert.equal(clampPower(50,-5),0);
  assert.equal(hex(powerMessage(PORTS.A,100,40)),'08 00 81 00 11 51 00 28');
  assert.equal(hex(speedMessage(PORTS.A,100,100,40)),'09 00 81 00 11 07 28 28 00','the motor\'s own max power too');
});
test('what the hub says: a motor attached and detached, the battery, the end of a command, errors',()=>{
  // Hub Attached I/O: port A, attached, type 0x002E (Technic L, 88013), hardware and software versions.
  assert.deepEqual(parseLego(Uint8Array.from([0x0f,0,0x04,0x00,0x01,0x2e,0x00,0,0,0,0x10,0,0,0,0x10])),{type:'attached',port:0,device:0x2e,motor:true,name:'technic-l',virtual:false});
  assert.deepEqual(parseLego(Uint8Array.from([0x0f,0,0x04,0x32,0x01,0x3c,0x00,0,0,0,0x10,0,0,0,0x10])),{type:'attached',port:0x32,device:0x3c,motor:false,name:'unknown',virtual:false},'an internal sensor of the hub');
  assert.deepEqual(parseLego(Uint8Array.from([0x05,0,0x04,0x01,0x00])),{type:'detached',port:1});
  assert.deepEqual(parseLego(Uint8Array.from([0x06,0,0x01,0x06,0x06,0x5a])),{type:'battery',percent:90});
  assert.deepEqual(parseLego(Uint8Array.from([0x05,0,0x82,0x00,0x0a])),{type:'feedback',ports:[{port:0,completed:true,discarded:false,idle:true}]});
  assert.deepEqual(parseLego(Uint8Array.from([0x05,0,0x05,0x81,0x06])),{type:'hubError',command:0x81,code:6});
  assert.deepEqual(parseLego(Uint8Array.from([0x05,0,0x04])),{type:'error'},'length does not match');
  assert.deepEqual(parseLego(new Uint8Array(2)),{type:'error'});
  assert.equal(parseLego(Uint8Array.from([0x04,0,0x03,0x00])).type,'other');
});
test('the Technic Hub is told from its advertisement: LEGO\'s company id and system type 0x80',()=>{
  assert.equal(isTechnicHub(0x0397,Uint8Array.from([0x00,0x80,0x06,0x00,0x41,0x00])),true);
  assert.equal(isTechnicHub(0x0397,Uint8Array.from([0x00,0x41,0x06,0x00])),false,'a City hub');
  assert.equal(isTechnicHub(0x004c,Uint8Array.from([0x00,0x80])),false,'not LEGO');
  assert.equal(LEGO_SERVICE.length,36);
});

// A pretend LEGO hub behind a pretend Bluetooth client with the host's shape (bleclient: startScanning, onDiscovered,
// connect, onConnected, discoverPrimaryService, onServices, discoverCharacteristic, onCharacteristics,
// enableNotifications, writeWithoutResponse, onCharacteristicNotification, onDisconnected, close).
import {createLegoHub,LEGO_LIMITS} from './lego-wire.js';
function pretend({technic=true,motors=[0x2e,0x2e]}={}){
  const writes=[],timers=new Map(),states=[],logs=[];let id=0,client,scanning=false,closedClient=false,disconnected=false;
  const characteristic={notifications:false,enableNotifications(){this.notifications=true;queueMicrotask(()=>client.onCharacteristicNotificationEnabled(this));},writeWithoutResponse(buffer){writes.push(Array.from(new Uint8Array(buffer)));}};
  const device={closed:false,discoverPrimaryService(uuid){queueMicrotask(()=>client.onServices([{uuid,discoverCharacteristic(){queueMicrotask(()=>client.onCharacteristics([characteristic]));}}]));},close(){this.closed=true;}};
  class BLEClient{constructor(){client=this;queueMicrotask(()=>this.onReady());}startScanning(){scanning=true;}stopScanning(){scanning=false;}connect(found){queueMicrotask(()=>this.onConnected(device));}close(){closedClient=true;}}
  const hub=createLegoHub({BLEClient,uuid:strings=>strings[0],timer:{set(fn,ms){const n=++id;timers.set(n,{fn,ms});return n;},clear(n){timers.delete(n);}},log:text=>logs.push(text),changed:state=>states.push(state)});
  const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
  const advertise=()=>client.onDiscovered({scanResponse:{completeName:'Technic Hub',manufacturerSpecific:{identifier:0x0397,data:Uint8Array.from([0,technic?0x80:0x41,6,0,0x41,0])}}});
  const notify=bytes=>client.onCharacteristicNotification(characteristic,Uint8Array.from(bytes).buffer);
  const attach=(port,type)=>notify([0x0f,0,0x04,port,0x01,type,0x00,0,0,0,0x10,0,0,0,0x10]);
  const fire=ms=>{for(const [n,t] of [...timers])if(t.ms===ms){timers.delete(n);t.fn();}};
  return {hub,writes,states,logs,timers,flush,advertise,notify,attach,fire,device,characteristic,get scanning(){return scanning;},get clientClosed(){return closedClient;},disconnect:()=>client.onDisconnected(device),motors};
}
const hexes=list=>list.map(bytes=>bytes.map(b=>b.toString(16).padStart(2,'0')).join(' '));
test('the link: scan, the Technic Hub found, service, characteristic, notifications; ready once two motors are attached',async()=>{
  const p=pretend();assert.equal(p.hub.start(),true);await p.flush();
  assert.equal(p.scanning,true);assert.equal(p.hub.state,'scanning');
  p.advertise();await p.flush();assert.equal(p.scanning,false);assert.equal(p.characteristic.notifications,true);
  assert.deepEqual(hexes(p.writes),['05 00 01 06 05'],'first: the battery');
  assert.equal(p.hub.drive(30,30),false,'no motor known yet: nothing moves');
  p.attach(0x32,0x3c);p.attach(1,0x2e);assert.equal(p.hub.state,'connecting');p.attach(0,0x2e);
  assert.equal(p.hub.state,'ready');assert.deepEqual(p.hub.motors,['A','B']);
  p.notify([0x06,0,0x01,0x06,0x06,77]);assert.equal(p.hub.battery,77);
});
test('driving: within the ceiling, stopped by the robot itself at the end; a lost link stops it and looks again',async()=>{
  const p=pretend();p.hub.start();await p.flush();p.advertise();await p.flush();p.attach(0,0x2e);p.attach(1,0x2e);p.writes.length=0;
  assert.equal(p.hub.drive(100,-100,10000),true);
  assert.deepEqual(hexes(p.writes),['08 00 81 00 11 51 00 3c','08 00 81 01 11 51 00 c4'],`never beyond ${LEGO_LIMITS.maxPower}%`);
  assert.equal(p.hub.driving,true);assert.ok([...p.timers.values()].some(t=>t.ms===LEGO_LIMITS.driveMs),'at most driveMs');
  p.fire(LEGO_LIMITS.driveMs);assert.deepEqual(hexes(p.writes.slice(2)),['08 00 81 00 11 51 00 00','08 00 81 01 11 51 00 00'],'then stopped');
  assert.equal(p.hub.driving,false);
  p.hub.drive(20,20,500);p.writes.length=0;p.hub.stop(true);assert.deepEqual(hexes(p.writes),['08 00 81 00 11 51 00 7f','08 00 81 01 11 51 00 7f'],'stop with the brake');
  // A motor pulled out: the other stops, and nothing drives with one motor.
  p.hub.drive(20,20,500);p.writes.length=0;p.notify([0x05,0,0x04,0x01,0x00]);
  assert.equal(p.hub.state,'connecting');assert.equal(p.hub.drive(20,20),false);
  // The link lost: looks again after retryMs.
  p.disconnect();assert.equal(p.hub.state,'lost');assert.equal(p.hub.drive(20,20),false);
  p.fire(LEGO_LIMITS.retryMs);assert.equal(p.hub.state,'scanning');
});
test('another hub is not taken; nobody for a minute: it stops looking; close gives the Bluetooth back',async()=>{
  const p=pretend({technic:false});p.hub.start();await p.flush();p.advertise();await p.flush();
  assert.equal(p.hub.state,'scanning','a City hub is not the Technic Hub');
  p.fire(LEGO_LIMITS.scanMs);assert.equal(p.hub.state,'not_found');assert.equal(p.scanning,false);
  p.hub.close();assert.equal(p.hub.state,'closed');assert.equal(p.clientClosed,true);assert.equal(p.hub.start(),false,'closed for good');
});
test('a write that fails is a failure: the drive says so and the motors are told to stop',async()=>{
  const p=pretend();p.hub.start();await p.flush();p.advertise();await p.flush();p.attach(0,0x2e);p.attach(1,0x2e);
  let fail=true;const write=p.characteristic.writeWithoutResponse;p.characteristic.writeWithoutResponse=function(buffer){if(fail){fail=false;throw Error('busy');}return write.call(this,buffer);};
  p.writes.length=0;assert.equal(p.hub.drive(30,30,500),false);assert.equal(p.hub.driving,false);
  assert.ok(p.logs.some(line=>/write failed busy/.test(line)));
});
