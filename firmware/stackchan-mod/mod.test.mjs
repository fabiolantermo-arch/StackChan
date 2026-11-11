// Exercises the real MOD against a capability fake. Does not emulate hardware/Piu/BLE.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {SourceTextModule,SyntheticModule,createContext} from 'node:vm';
import {HEAD_SPEED,MIN_MOVE} from './calibration.js';
import {CAMERA_FOV} from './tracker.js';
// The host's servo arithmetic (host/modules/motion/m5stackchan-servo.ts): rotation → servo positions and back.
const STEP=16/5/10,TENTH=1800/Math.PI;
const hostRaw=rotation=>({yaw:460+Math.trunc(Math.trunc(rotation.y*TENTH)*STEP),pitch:620+Math.trunc(Math.trunc(-rotation.p*TENTH)*STEP)});
// Where the head went, back in the MOD's terms (radians from the host centres), within one servo step (0.1°).
// The MOD's own rotation back from what reached the host (the K151 yaw servo is reversed: calibration.js YAW_SERVO).
const logical=rotation=>{const raw=hostRaw(rotation);return {y:-(raw.yaw-460)/(TENTH*STEP)||0,p:-(raw.pitch-620)/(TENTH*STEP)||0,r:0};};
// A measured head for the tests: the host centres, pitch never below straight ahead.
const HEAD_CAL=JSON.stringify({v:2,yaw:{center:460,lo:51,hi:869,sign:1},pitch:{center:620,lo:620,hi:892,sign:1}});
async function launch({withCredential=true,withPairing=false,withVoice=false,torqueFails=false,delayOpen=false,withTouchPanel=true,delayTorque=false,poseMode='normal',partialSubscribeFailure=false,withLive=false,verified=false,withLights=false,headCal,refuse,torqueLost=0}={}){
  let now=1000,wall; // ticks (Time.ticks) and, separately, the time of day from the network (Date.now)
  class Clock extends Date { static now(){return wall??now;} }
  const screen={_rotation:0,rotationWrites:0,commands:[],get rotation(){return this._rotation;},set rotation(v){this._rotation=v;this.rotationWrites++;},command(id,data){this.commands.push([id,[...data]]);}};
  const context=createContext({console,Date:Clock,Math,Number,Map,Set,Uint8Array,screen});
  const buttons=new Map(),listeners=new Map(),poses=[],removed=[],touchListeners=new Set(),touches=[],styles=[],preferences=[],titles=[],sensitivity=[],references=[];let headZones=[0,0,0];
  let voiceHooks,voiceStarts=0;const voiceFake={active:false,speaking:false,phase:'idle',interrupts:0,interrupt(){this.interrupts++;this.speaking=false;return true;},async start(){voiceStarts++;this.active=true;return true;},stop(){this.active=false;voiceHooks?.ended('user');}};
  let pairingHooks,pairingStarts=0,hellos=0,liveHooks,liveFake,faceStyle="portrait",faceCalls=[],timerId=0,holdShort=false,liveConnects=0,liveBusy=false,netBusy=false;const timeouts=new Map();
  let tick,stopped=false,sessionClosed=false,faceStopped=false,openNow,dancing=false,finishTorque,finishPose,torqueCalls=0,confirmPose;
  const face={behavior:{getStyle(){return faceStyle;},setStyle(_face,value){faceStyle=value;styles.push(value);},setTarget(){},setDanceActive(value){dancing=value;},reactToTouch(source,event){touches.push({source,event});return true;},showPanel(_face,panel){panels.push(panel);this.panel=panel;},hidePanel(){panels.push(null);this.panel=undefined;},setPanelTitle(_face,title){titles.push(title);},get panelOpen(){return panels.length>0&&panels.at(-1)!==null;}},stop(){faceStopped=true;}};
  const panels=[];
  const session={subscribe(type,cb){if(partialSubscribeFailure&&type==='tracking.update')throw Error('subscribe failed');listeners.set(type,cb);return()=>listeners.delete(type);},close(){sessionClosed=true;}};
  const balloons=[];
  // The servos as the host reads them: positions 0…1000, answered (or not) at each reading.
  const headPose={body:{rotation:{y:0,p:0,r:0}}},torqueArgs=[];let servo={yaw:460,pitch:620},servoAnswers=true,lookAts=0,lookAways=0,lostReplies=0;
  // The host application's behaviour, where the ☰ button bubbles `onDrawerToggle`.
  class HostController{constructor(){this.hostToggles=0;}onDrawerToggle(){this.hostToggles++;}}
  const controller=new HostController();let drawerOpens=0,drawerCloses=0;
  const robot={ui:{application:{behavior:controller},openDrawer(){drawerOpens++;},closeDrawer(){drawerCloses++;},setFace(){},showBalloon(text){balloons.push(text);},drawer:{addDrawerButton(b){buttons.set(b.key,b.callback);},removeDrawerButton(k){removed.push(k);buttons.delete(k);}}},
    input:withTouchPanel?{touchPanel:{get sample(){return headZones;},configure(options){if('sensitivityLevel' in options)sensitivity.push(options.sensitivityLevel);if('referenceReset' in options)references.push(options.referenceReset);},subscribe(callback){touchListeners.add(callback);return()=>touchListeners.delete(callback);}}}:{},
    audio:{playAudio(buffer){touches.push({audio:buffer.name});return Promise.resolve(true);}},
    face:{setEyeOpen(side,value){faceCalls.push(['eye',side,value]);},setMouthOpen(value){faceCalls.push(['mouth',value]);},setEmotion(value){faceCalls.push(['emotion',value]);}},
    motion:{pose:headPose,lookAt(){lookAts++;if(servoAnswers){headPose.body.rotation.y=Math.trunc((servo.yaw-460)/STEP)/TENTH;headPose.body.rotation.p=-(Math.trunc((servo.pitch-620)/STEP)/TENTH);}},lookAway(){lookAways++;},
      setTorque(enable){torqueArgs.push(enable);torqueCalls++;if(torqueLost>0){torqueLost--;return Promise.reject(Error('scservo command timed out after 120ms'));}if(torqueFails)return Promise.reject(Error('offline'));if(delayTorque)return new Promise(resolve=>{finishTorque=resolve;});return Promise.resolve();},setPose(pose,duration,confirmed){confirmPose=confirmed;poses.push({rotation:logical(pose.rotation),host:pose.rotation,duration});if(lostReplies>0){lostReplies--;return Promise.reject(Error('scservo command timed out after 120ms'));}if(refuse?.(hostRaw(pose.rotation)))return Promise.reject(Error('scservo command timed out after 120ms'));if(poseMode==='throw')throw Error('sync error');if(poseMode==='reject')return Promise.reject(Error('offline'));if(poseMode==='pending')return new Promise(resolve=>{finishPose=resolve;});return Promise.resolve();}},
    connectivity:{localPeer:{open(){return delayOpen?new Promise(resolve=>{openNow=()=>resolve(session);}):Promise.resolve(session);}}}};
  // The host's lighting capability on the K151 (LED bar 'head'): records what reaches the LED driver.
  const lightCalls=[];
  if(withLights)robot.lighting={led:{head:{}},lightOn(name,r,g,b){lightCalls.push(['on',name,r,g,b]);},lightBlink(name,r,g,b,period){lightCalls.push(['blink',name,r,g,b,period]);},lightOff(name){lightCalls.push(['off',name]);}};
  const fake=(exports)=>new SyntheticModule(Object.keys(exports),function(){for(const [key,value]of Object.entries(exports))this.setExport(key,value);},{context});
  const cache=new Map();
  cache.set('Resource',fake({default:class Resource {constructor(name){this.name=name;} get byteLength(){return 6400;} slice(a,b){return b===undefined?{name:this.name}:{name:this.name,a,b};}}}));
  cache.set('modules',fake({default:{has:name=>name==='robottino-voice-device'?withVoice:name==='robottino-pairing-device'?withPairing:withLive,importNow:()=>({connecting:()=>netBusy,createVoiceDevice:(_robot,hooks)=>{voiceHooks=hooks;return voiceFake;},createLiveDevice:(_robot,hooks)=>{liveHooks=hooks;liveConnects++;return liveFake={busy:()=>liveBusy,connect:async()=>{},close(){hooks.disconnected();},hello(){hellos++;}};},createPairing:(_robot,hooks)=>{const fakePairing={active:false,code:undefined,async start(){pairingStarts++;this.active=true;return true;},stop(){this.active=false;}};const shown=hooks.code;pairingHooks={...hooks,code(c){fakePairing.code=c;shown(c);}};return fakePairing;}})}}));
  const stored=new Map(),credential=withCredential?'test-device-credential-0123456789abcdef':undefined;
  cache.set('preference',fake({default:{get:(_domain,key)=>stored.has(key)?stored.get(key):key==='deviceToken'?credential:key==='headCal'?(headCal===undefined?(verified?HEAD_CAL:undefined):headCal??undefined):verified,set:(_domain,key,value)=>{stored.set(key,value);preferences.push([key,value]);}}}));
  // Timers of 20 ms run at once; so do those of 310 ms (the head sensor's reference reset).
  cache.set('timer',fake({default:{repeat(cb){tick=cb;return 0;},set(cb,ms){const id=++timerId;timeouts.set(id,{cb,ms});if((ms===20&&!holdShort)||ms===310)void Promise.resolve().then(()=>{if(timeouts.delete(id))cb();});return id;},clear(id){if(id===0)stopped=true;else{assert.ok(timeouts.has(id));timeouts.delete(id);}}}}));
  const timeFake={get ticks(){return now;},delta(a,b){return (b-a)|0;}};cache.set('time',fake({default:timeFake}));
  cache.set('robottino-face',fake({createExpressiveFace:()=>face}));
  const filenames={'robottino-clock':'clock.js','robottino-tracker':'tracker.js','robottino-dance':'dance.js','mediapipe-tracking-message':'vendor/tracking-message.js','robottino-voice-wire':'voice-wire.js','robottino-live-wire':'live-wire.js','robottino-reminders':'reminders.js','robottino-wifi-switch':'wifi-switch.js','robottino-portrait-state':'portrait-state.js','robottino-lights':'lights.js','robottino-calibration':'calibration.js'};
  const module=new SourceTextModule(await readFile(new URL('./mod.js',import.meta.url),'utf8'),{context});
  await module.link(async name=>{
    if(!cache.has(name))cache.set(name,new SourceTextModule(await readFile(new URL(filenames[name],import.meta.url),'utf8'),{context}));
    return cache.get(name);
  });await module.evaluate();module.namespace.onContextCreated(robot);
  const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};await flush();
  return{context,stored,titles,sensitivity,references,headZones(value){headZones=value;},connectingNow(value){netBusy=value;},cameraSwitching(value){liveBusy=value;},clock:()=>now,loseReplies(n){lostReplies=n;},holdShortTimers(value){holdShort=value;},wallTime:value=>{wall=value;},timeFake,lightCalls,torqueArgs,moveHead(raw){servo=raw;},servoAnswers(value){servoAnswers=value;},lookAts:()=>lookAts,lookAways:()=>lookAways,headPose,controller,drawerOpens:()=>drawerOpens,drawerCloses:()=>drawerCloses,get pairingHooks(){return pairingHooks;},pairingStarts:()=>pairingStarts,hellos:()=>hellos,stored,face,robot,faceCalls,voiceFake,get voiceHooks(){return voiceHooks;},balloons,voiceStarts:()=>voiceStarts,get liveHooks(){return liveHooks;},get live(){return liveFake;},timeouts,liveConnects:()=>liveConnects,styles,preferences,buttons,listeners,poses,removed,touchListeners,touches,flush,time:value=>{now=value;},finishTorque:()=>finishTorque?.(),finishPose:()=>finishPose?.(),confirmPose:()=>confirmPose?.(),torqueCalls:()=>torqueCalls,dancing:()=>dancing,tick:()=>tick(),screen,panels,open:()=>openNow(),close:()=>module.namespace.onUnload(),status:()=>({stopped,sessionClosed,faceStopped})};
}
// Motors on from the menu. With the head calibrated the robot first turns it straight ahead (9 Nov 2026): that
// move is checked here and left out, so each test counts only its own motions.
async function arm(h){
  const before=h.poses.length;h.buttons.get('robottino:motion')();await h.flush();
  const centre=h.poses.splice(before);
  for(const pose of centre)assert.ok(Math.abs(pose.rotation.y)<.01&&Math.abs(pose.rotation.p)<.01,'straight ahead');
  return centre.length;
}
test('keeps motors off until torque activation succeeds',async()=>{
  const h=await launch();h.listeners.get('target.update')({payload:{id:'a',x:.8,y:.3,confidence:1,sequence:1}});
  h.tick();assert.equal(h.poses.length,0);
  h.buttons.get('robottino:motion')();await h.flush();h.tick();await h.flush();assert.equal(h.poses.length,1);h.close();
});
test('never sends poses when torque cannot be enabled',async()=>{
  const h=await launch({torqueFails:true});h.buttons.get('robottino:motion')();await h.flush();
  h.listeners.get('target.update')({payload:{id:'a',x:.8,y:.3,confidence:1,sequence:1}});h.tick();assert.equal(h.poses.length,0);h.close();
});
test('stop removes subscriptions, timer zero, and only its own drawer entries',async()=>{
  const h=await launch();h.buttons.get('robottino:stop')();
  assert.equal(h.listeners.size,0);assert.equal(h.buttons.size,0);assert.equal(h.removed.length,9);
  assert.deepEqual(h.status(),{stopped:true,sessionClosed:true,faceStopped:true});h.close();
});
test('a late BLE open after stop is closed without starting listeners',async()=>{
  const h=await launch({delayOpen:true});h.close();h.open();await h.flush();
  assert.equal(h.listeners.size,0);assert.equal(h.status().sessionClosed,true);
});
test('head touch reaches the portrait without moving motors and unsubscribes on stop',async()=>{
  const h=await launch();assert.equal(h.touchListeners.size,1);
  for(const cb of h.touchListeners)cb({gesture:'forwardSwipe',intensity:3});
  assert.equal(h.touches.length,1);assert.equal(h.touches[0].source,'head');assert.equal(h.poses.length,0);
  h.close();assert.equal(h.touchListeners.size,0);
});
test('missing head sensor does not prevent the rest of the MOD from loading',async()=>{
  const h=await launch({withTouchPanel:false});assert.equal(h.buttons.size,6);assert.equal(h.touchListeners.size,0);h.close();
});
test('dance requires motion activation, excludes tracking, and cancellation holds position',async()=>{
  const h=await launch({verified:true});h.buttons.get('robottino:dance')();h.tick();assert.equal(h.poses.length,0);
  await arm(h);h.buttons.get('robottino:dance')();assert.equal(h.dancing(),true);
  h.listeners.get('target.update')({payload:{id:'a',x:1,y:1,confidence:1,sequence:1}});
  h.time(1700);h.tick();await h.flush();assert.ok(h.poses[0].rotation.y>0);
  h.buttons.get('robottino:dance')();assert.equal(h.dancing(),false);
  const count=h.poses.length;h.time(1800);h.tick();assert.equal(h.poses.length,count);h.close();
});
test('disabling motors cancels an active dance',async()=>{
  const h=await launch();h.buttons.get('robottino:motion')();await h.flush();h.buttons.get('robottino:dance')();
  h.buttons.get('robottino:motion')();assert.equal(h.dancing(),false);h.tick();assert.equal(h.poses.length,0);h.close();
});
test('cancelling activation ignores a late torque acknowledgement',async()=>{
  const h=await launch({delayTorque:true});h.buttons.get('robottino:motion')();await h.flush();
  h.buttons.get('robottino:motion')();h.finishTorque();await h.flush();
  h.listeners.get('target.update')({payload:{id:'a',x:1,y:1,confidence:1,sequence:1}});h.tick();await h.flush();
  assert.equal(h.poses.length,0);h.close();
});
test('close before queued activation prevents even the torque call',async()=>{
  const h=await launch();h.buttons.get('robottino:motion')();h.close();await h.flush();assert.equal(h.torqueCalls(),0);
});
test('activation watchdog locks movement and ignores late acknowledgement',async()=>{
  const h=await launch({delayTorque:true});h.buttons.get('robottino:motion')();await h.flush();
  h.time(2300);h.tick();h.finishTorque();await h.flush();
  h.listeners.get('target.update')({payload:{id:'a',x:1,y:1,confidence:1,sequence:1}});h.tick();await h.flush();assert.equal(h.poses.length,0);
  h.buttons.get('robottino:motion')();await h.flush();
  assert.equal(h.torqueCalls(),1);h.close();
});
test('a missing pose acknowledgement blocks all later motion and serializes calls',async()=>{
  const h=await launch({poseMode:'pending'});h.buttons.get('robottino:motion')();await h.flush();
  h.listeners.get('target.update')({payload:{id:'a',x:1,y:1,confidence:1,sequence:1}});h.tick();await h.flush();
  h.time(1100);h.tick();await h.flush();assert.equal(h.poses.length,1);
  h.time(2300);h.tick();h.finishPose();await h.flush();h.buttons.get('robottino:motion')();await h.flush();
  h.listeners.get('target.update')({payload:{id:'a',x:0,y:0,confidence:1,sequence:2}});h.tick();await h.flush();
  assert.equal(h.poses.length,1);assert.equal(h.torqueCalls(),1);h.close();
});
// 10 Nov 2026, «Movimento non confermato» while the robot spoke and followed a face: the servos had confirmed, but
// every promise turn waited in the host's message queue (0.8 s before the command even left, more after it).
test('the pose command leaves in the same turn of the loop, not a promise turn later',async()=>{
  const h=await launch({poseMode:'pending'});h.buttons.get('robottino:motion')();await h.flush();
  h.listeners.get('target.update')({payload:{id:'a',x:1,y:1,confidence:1,sequence:1}});h.tick();
  assert.equal(h.poses.length,1,'sent before any promise has run');h.close();
});
test('servos that confirm in time are not a fault, however late the promise settles; following goes on from the confirmation',async()=>{
  const h=await launch({poseMode:'pending'});h.buttons.get('robottino:motion')();await h.flush();
  h.listeners.get('target.update')({payload:{id:'a',x:1,y:1,confidence:1,sequence:1}});h.tick();await h.flush();
  assert.equal(h.poses.length,1);h.time(1100);h.confirmPose();
  // The promise of the first pose never settles here; every later pose is confirmed by the servos at once.
  for(const at of [1200,1300,2300,3000,4000,7000]){h.time(at);h.tick();await h.flush();h.confirmPose();}
  assert.ok(!h.balloons.some(text=>/bloccati/.test(text)),'no block: the servos confirmed each pose within 1.2 s');
  assert.ok(h.poses.length>=2,'the next pose left after the confirmation, before the first promise had settled');
  h.close();
});
test('a confirmation that comes after 1.2 s is too late: blocked as before',async()=>{
  const h=await launch({poseMode:'pending'});h.buttons.get('robottino:motion')();await h.flush();
  h.listeners.get('target.update')({payload:{id:'a',x:1,y:1,confidence:1,sequence:1}});h.tick();await h.flush();
  h.time(2300);h.tick();await h.flush();
  assert.ok(h.balloons.some(text=>/Movimento non confermato/.test(text)));
  h.confirmPose();h.finishPose();await h.flush();h.buttons.get('robottino:motion')();await h.flush();
  h.listeners.get('target.update')({payload:{id:'a',x:0,y:0,confidence:1,sequence:2}});h.time(2400);h.tick();await h.flush();
  assert.equal(h.poses.length,1,'nothing after the block');h.close();
});
test('a confirmation left over from the pose before does not vouch for the next one',async()=>{
  const h=await launch({poseMode:'pending'});h.buttons.get('robottino:motion')();await h.flush();
  h.listeners.get('target.update')({payload:{id:'a',x:1,y:1,confidence:1,sequence:1}});h.tick();await h.flush();
  const first=h.confirmPose;h.confirmPose();h.finishPose();await h.flush();
  h.listeners.get('target.update')({payload:{id:'a',x:0,y:0,confidence:1,sequence:2}});h.time(1200);h.tick();await h.flush();
  assert.equal(h.poses.length,2);
  h.time(2500);h.tick();await h.flush();
  assert.ok(h.balloons.some(text=>/Movimento non confermato/.test(text)),'the second pose was never confirmed');h.close();
});
for(const poseMode of ['reject','throw'])test(`a ${poseMode} from the pose driver fails closed`,async()=>{
  const h=await launch({poseMode});h.buttons.get('robottino:motion')();await h.flush();
  h.listeners.get('target.update')({payload:{id:'a',x:1,y:1,confidence:1,sequence:1}});h.tick();await h.flush();
  h.buttons.get('robottino:motion')();await h.flush();h.time(1100);h.tick();await h.flush();
  assert.equal(h.poses.length,1);assert.equal(h.torqueCalls(),1);h.close();
});
test('failure during the second BLE subscription releases the first listener',async()=>{
  const h=await launch({partialSubscribeFailure:true});assert.equal(h.listeners.size,0);assert.equal(h.status().sessionClosed,true);h.close();
});

test('phone connection excludes tracking and head motion requires local activation',async()=>{
  const h=await launch({withLive:true});h.liveHooks.connected();
  await assert.rejects(()=>h.liveHooks.motion({yaw:1,pitch:1}),/motion_unavailable/);
  h.buttons.get('robottino:motion')();await h.flush();
  h.listeners.get('target.update')({payload:{id:'a',x:1,y:1,confidence:1,sequence:1}});h.tick();assert.equal(h.poses.length,0);
  await h.liveHooks.motion({yaw:10,pitch:-5});assert.equal(h.poses.length,1);
  assert.ok(Math.abs(h.poses[0].rotation.y-Math.PI/18)<.00001);
  h.time(3000);await h.liveHooks.motion({yaw:-10,pitch:5});assert.equal(hostRaw(h.poses[1].host).pitch,636,'never below straight ahead: here the host rest, the head is not calibrated');
  const [a,b]=h.poses.map(pose=>pose.rotation);
  assert.ok(Math.abs(h.poses[1].duration-Math.hypot(b.y-a.y,b.p-a.p)/HEAD_SPEED)<.02,'the one head speed, 3 rad/s, from where the head is: '+h.poses[1].duration);
  h.liveHooks.disconnected();await assert.rejects(()=>h.liveHooks.motion({yaw:1,pitch:1}),/motion_unavailable/);h.close();
});

test('carezza muove solo dopo calibrazione e attivazione, poi ripristina la posa',async()=>{
  const h=await launch({verified:true});for(const cb of h.touchListeners)cb({gesture:'forwardSwipe',intensity:3});await h.flush();assert.equal(h.poses.length,0);
  await arm(h);for(const cb of h.touchListeners)cb({gesture:'forwardSwipe',intensity:3});await h.flush();assert.equal(h.poses.length,1);assert.ok(h.poses[0].rotation.p<0,"the K151 head lifts toward the hand: it cannot dip below straight ahead");
  h.time(4000);h.tick();await h.flush();assert.equal(h.poses.length,2);assert.equal(h.poses[1].rotation.p,0);h.close();
});
test('carezza non muove con hardware non verificato e stop impedisce il ritorno',async()=>{
  const h=await launch();h.buttons.get('robottino:motion')();await h.flush();for(const cb of h.touchListeners)cb({gesture:'forwardSwipe',intensity:3});await h.flush();assert.equal(h.poses.length,0);h.close();
  const v=await launch({verified:true});await arm(v);for(const cb of v.touchListeners)cb({gesture:'forwardSwipe',intensity:3});await v.flush();v.buttons.get('robottino:motion')();v.time(4100);v.tick();await v.flush();assert.equal(v.poses.length,1);v.close();
});

test('remote face style is stored and applied without enabling motors',async()=>{
 const h=await launch({withLive:true,verified:true});h.liveHooks.connected();h.liveHooks.faceStyle('white');
 assert.deepEqual(h.styles,['white']);assert.deepEqual(h.preferences,[['faceStyle','white']]);assert.equal(h.poses.length,0);
 assert.throws(()=>h.liveHooks.faceStyle('invalid'));h.close();
});

test('both faces play Sami on accepted touch; live calls take priority',async()=>{
 const h=await launch({withLive:true,verified:true});const tap=()=>{for(const cb of h.touchListeners){cb({gesture:'press',intensity:3});cb({gesture:'release',tap:{durationMs:100}});}};tap();await h.flush();assert.equal(h.touches.filter(v=>v.audio==='sami-risata.bin').length,1);
 h.liveHooks.faceStyle('white');h.time(2000);tap();await h.flush();assert.equal(h.touches.filter(v=>v.audio).length,2);
 h.robot.audio.media={state:'playing'};h.time(5000);tap();await h.flush();assert.equal(h.touches.filter(v=>v.audio).length,2);h.close();
});

test('reconnects the cloud link with bounded backoff and stops retrying after stop',async()=>{
  const h=await launch({withLive:true});assert.equal(h.liveConnects(),1);
  h.liveHooks.disconnected();assert.equal(h.timeouts.size,1);
  const [[id,first]]=[...h.timeouts];assert.equal(first.ms,1000,'the phone often comes back at once');h.timeouts.delete(id);first.cb();await h.flush();
  assert.equal(h.liveConnects(),2);
  h.liveHooks.disconnected();const [[id2,second]]=[...h.timeouts];assert.equal(second.ms,2000);h.timeouts.delete(id2);second.cb();await h.flush();
  h.liveHooks.online();h.liveHooks.disconnected();const [[,third]]=[...h.timeouts];assert.equal(third.ms,1000);
  h.close();assert.equal(h.timeouts.size,0);
});
test('manual reconnect ignores the replaced link and never schedules duplicate retries',async()=>{
  const h=await launch({withLive:true});const old=h.liveHooks;
  h.buttons.get('robottino:live')();await h.flush();assert.equal(h.liveConnects(),2);assert.equal(h.timeouts.size,0);
  old.disconnected();assert.equal(h.timeouts.size,0);
  h.liveHooks.disconnected();h.liveHooks.disconnected();assert.equal(h.timeouts.size,1);h.close();
});

test('«Segui il mio viso»: with the iPhone connected the head turns toward the face found in the robot camera',async()=>{
  const h=await launch({withLive:true,verified:true});h.liveHooks.connected();
  assert.throws(()=>h.liveHooks.follow(true),/motion_unavailable/,'needs the motions switched on locally');
  await arm(h);h.liveHooks.follow(true);
  const pose=h.liveHooks.headPose();assert.deepEqual({...pose},{y:0,p:0});
  assert.equal(h.liveHooks.aim({x:.25,y:.5,pose}),true,'a face on the left of the frame');
  h.tick();await h.flush();assert.equal(h.poses.length,1);const first=h.poses[0].rotation;
  assert.ok(Math.abs(first.y-.25*CAMERA_FOV.x*.8)<.005,'turns to its left, all the way to the aim in one tick at 3 rad/s (the one head speed, servo steps): '+first.y);assert.equal(first.p,0);
  await assert.rejects(()=>h.liveHooks.motion({yaw:1,pitch:1}),/motion_unavailable/,'the manual head control waits');
  assert.throws(()=>h.liveHooks.dance([{yaw:10,pitch:0,durationMs:500,expression:'happy'}]),/motion_unavailable/);
  for(let i=0;i<10;i++){h.time(1000+100*(i+1));h.tick();await h.flush();}
  const goal=.25*CAMERA_FOV.x*.8;assert.ok(Math.abs(h.poses.at(-1).rotation.y-goal)<.06,'stops near the face: '+h.poses.at(-1).rotation.y);
  h.liveHooks.follow(false);const count=h.poses.length;h.time(2300);h.tick();await h.flush();assert.equal(h.poses.length,count,'stopped: no more motion');
  assert.equal(h.liveHooks.aim({x:.25,y:.5,pose}),false,'answers after the stop move nothing');
  h.close();
});
test('remote dance needs local motion activation, plays steps in order and stops with the link',async()=>{
  const h=await launch({withLive:true,verified:true});h.liveHooks.connected();
  const steps=[{yaw:10,pitch:0,durationMs:500,expression:'happy'},{yaw:-10,pitch:0,durationMs:500,expression:'blink'}];
  assert.throws(()=>h.liveHooks.dance(steps),/motion_unavailable/);
  await arm(h);
  h.liveHooks.dance(steps);assert.throws(()=>h.liveHooks.dance(steps),/motion_unavailable/);
  await assert.rejects(()=>h.liveHooks.motion({yaw:1,pitch:1}),/motion_unavailable/);
  h.tick();await h.flush();assert.equal(h.poses.length,1);assert.ok(Math.abs(h.poses[0].rotation.y-Math.PI/18)<1e-6);
  assert.ok(h.faceCalls.some(([kind,value])=>kind==='emotion'&&value===3));
  h.time(1200);h.tick();await h.flush();assert.equal(h.poses.length,1,'waits for the step duration');
  h.time(1500);h.tick();await h.flush();assert.equal(h.poses.length,2);assert.ok(h.faceCalls.some(([kind,,value])=>kind==='eye'&&value===0));
  h.time(2000);h.tick();await h.flush();assert.equal(h.poses.length,2);
  h.liveHooks.dance(steps);h.tick();await h.flush();assert.equal(h.poses.length,3);
  h.liveHooks.disconnected();h.time(2600);h.tick();await h.flush();
  assert.equal(h.poses.length,4,'disconnect cancels the dance, then one pose only:');
  assert.ok(Math.abs(h.poses[3].rotation.y)<1e-9&&Math.abs(h.poses[3].rotation.p)<1e-9,'the head back straight ahead (owner, 9 Nov 2026)');
  h.time(3000);h.tick();await h.flush();assert.equal(h.poses.length,4,'once');h.close();
});

test('a head reading stuck above 0 (no host gestures): the robot reads the zones itself (10 Nov 2026)',async()=>{
  const h=await launch({withVoice:true,verified:true});
  const at=async(ms,zones)=>{h.time(ms);h.headZones(zones);h.tick();await h.flush();};
  await at(1000,[0,0,0]);await at(1100,[1,0,0]);
  for(let t=1200;t<=10000;t+=100)await at(t,[1,0,0]);
  assert.equal(h.voiceStarts(),0,'a stuck zone starts nothing');
  // A finger over the stuck zone for 1.5 s, then away: the conversation starts.
  // The host sees the finger as a swipe (its position is skewed by the stuck zone): no petting, the press goes on.
  await at(10100,[1,3,1]);const touchesBefore=h.touches.length;for(const cb of h.touchListeners)cb({gesture:'forwardSwipe',intensity:3});await h.flush();
  assert.equal(h.touches.length,touchesBefore,'no petting reaction from a skewed swipe');
  for(let t=10200;t<=11600;t+=100)await at(t,[1,3,1]);
  assert.equal(h.voiceStarts(),0,'given on release');
  await at(11700,[1,0,0]);assert.equal(h.voiceStarts(),1);assert.equal(h.voiceFake.active,true);
  // A quick touch while it is open: a smile, no laugh over the conversation.
  const smiles=h.touches.length;await at(14000,[1,2,0]);await at(14200,[1,0,0]);
  assert.equal(h.touches.length,smiles+1,'the tap smiles');assert.equal(h.touches.filter(t=>t.audio).length,0);
  await at(25000,[1,0,0]);
  const saved=h.stored.get('touchDiag');
  assert.match(String(saved),/S.*L/,'stuck and long press recorded for the diagnostics: '+saved);
  // All zones at 0: back to the host's own gestures, nothing more from the robot's reading.
  await at(26000,[0,0,0]);await at(26100,[0,3,0]);await at(27500,[0,0,0]);assert.equal(h.voiceStarts(),1);
  h.close();
});

test('head sensor: the host level 3 (level 1 laughed by itself even with the guards, 10 Nov 2026 night), its reference taken again at start',async()=>{
  const h=await launch({withVoice:true,verified:true});
  assert.deepEqual(h.sensitivity,[3],'set once at start');assert.deepEqual(h.references,[true,false],'reference reset at start, then sensing again');
  h.close();assert.deepEqual(h.sensitivity,[3,3]);
});
test('phantom touches (10 Nov 2026, level 1 after a restart): a reading above 0 from the start never acts, and the reference is reset after 4 s',async()=>{
  const h=await launch({withVoice:true,verified:true});const send=event=>h.touchListeners.forEach(listener=>listener(event));
  const sounds=()=>h.touches.filter(t=>t.audio).length;
  // as on the robot: the zones read 2 from the first reading and the host says press
  h.headZones([2,2,2]);h.tick();await h.flush();send({gesture:'press',intensity:2});
  let at=h.clock();const run=async ms=>{for(const end=at+ms;at<end;){at+=100;h.time(at);h.tick();await h.flush();}};
  await run(3000);assert.equal(h.voiceStarts(),0,'no conversation by itself');
  assert.deepEqual(h.references,[true,false],'not yet');
  await run(1200);assert.deepEqual(h.references,[true,false,true,false],'held above 0 for 4 s: the chip takes its reference again');
  // the reading goes back to 0; the release of the phantom touch does nothing
  h.headZones([0,0,0]);send({gesture:'release',intensity:0,tap:{durationMs:100}});await run(500);
  assert.equal(sounds(),0);assert.equal(h.voiceStarts(),0);
  // from a clean reading a real hand works: hold for the conversation
  h.headZones([2,3,2]);send({gesture:'press',intensity:3});await run(1100);assert.equal(h.voiceStarts(),1);
  h.close();
});
test('a touch must begin from a clean reading and be read by the sensor: one that starts while the robot is busy does nothing',async()=>{
  const h=await launch({withVoice:true,verified:true});const send=event=>h.touchListeners.forEach(listener=>listener(event));
  const sounds=()=>h.touches.filter(t=>t.audio).length;
  let at=h.clock();const run=async ms=>{for(const end=at+ms;at<end;){at+=100;h.time(at);h.tick();await h.flush();}};
  await run(500);
  // never read above 0: nothing
  send({gesture:'press',intensity:0});await run(1200);send({gesture:'release',intensity:0});await run(500);
  assert.equal(h.voiceStarts(),0,'no conversation');assert.equal(sounds(),0,'no laugh');
  // while a connection opens (the robot is busy) the reading is not trusted, nor for 300 ms after
  h.connectingNow(true);await run(300);h.connectingNow(false);await run(100);
  h.headZones([3,3,3]);send({gesture:'press',intensity:3});await run(1200);h.headZones([0,0,0]);send({gesture:'release',intensity:0});await run(500);
  assert.equal(h.voiceStarts(),0,'a touch that began right after the busy moment');
  // a touch that starts weak and grows (the hand coming down) counts
  h.headZones([1,0,0]);send({gesture:'press',intensity:1});h.headZones([2,3,1]);await run(1100);
  assert.equal(h.voiceStarts(),1,'held 1.1 s with a real hand: the conversation starts');
  h.close();
});
test('a pat with the hand lasts longer than a fingertip tap: released before the long press (0.9 s) it laughs, 0.5 s or 0.75 s alike',async()=>{
  const h=await launch({withVoice:true,verified:true});const send=event=>h.touchListeners.forEach(listener=>listener(event));
  const sounds=()=>h.touches.filter(t=>t.audio).length;
  h.time(2000);send({gesture:'press',intensity:3});h.time(2500);send({gesture:'release',intensity:0});await h.flush();
  assert.equal(sounds(),1,'0.5 s: a pat');
  h.time(12000);send({gesture:'press',intensity:3});h.time(12750);send({gesture:'release',intensity:0});await h.flush();
  assert.equal(sounds(),2,'0.75 s (owner, 10 Nov 2026 evening): still a pat');assert.equal(h.voiceStarts(),0);
  h.close();
});
test('the big menu shows the head sensor zones in its title while it is open (diagnostics, 10 Nov 2026)',async()=>{
  const h=await launch({withVoice:true,verified:true});
  const at=(ms,zones)=>{h.time(ms);h.headZones(zones);h.tick();};
  at(1000,[0,2,0]);assert.equal(h.titles.length,0,'menu closed: nothing');
  h.buttons.get('robottino:menu')();assert.equal(h.panels.at(-1).title,'Menu di Robottino');
  at(1100,[0,2,0]);assert.equal(h.titles.length,0,'no change: the title stays');
  at(1200,[1,3,0]);assert.equal(h.titles.at(-1),'Menu · sensore testa 1 3 0');
  at(1300,[0,0,0]);assert.equal(h.titles.at(-1),'Menu · sensore testa 0 0 0');
  h.panels.at(-1).items.find(i=>i.label==='Chiudi').action();at(1400,[0,1,0]);assert.equal(h.titles.length,2,'closed again: nothing');
  h.close();
});

test('long press on the head toggles the conversation; only a short tap smiles and laughs',async()=>{
  const h=await launch({withVoice:true,verified:true});const [touch]=h.touchListeners;
  touch({gesture:'press',intensity:3});h.time(1500);h.tick();assert.equal(h.voiceStarts(),0);
  h.time(2000);h.tick();await h.flush();assert.equal(h.voiceStarts(),1);assert.equal(h.voiceFake.active,true);
  touch({gesture:'release'});assert.equal(h.touches.length,0,'long press does not smile');
  touch({gesture:'press',intensity:3});h.time(2100);touch({gesture:'release',tap:{durationMs:100}});
  assert.equal(h.touches.length,1);assert.equal(h.touches.filter(t=>t.audio).length,0,'no laugh over the conversation');
  h.time(4200);touch({gesture:'press',intensity:3});h.time(5200);h.tick();assert.equal(h.voiceFake.active,false,'second long press ends it');
  touch({gesture:'release'});touch({gesture:'press',intensity:3});h.time(5300);touch({gesture:'release',tap:{durationMs:100}});await h.flush();
  assert.ok(h.touches.some(t=>t.audio==='sami-risata.bin'),'laugh returns once the conversation is over');
  h.close();
});

test('a tap while Robottino talks interrupts it instead of laughing',async()=>{
  const h=await launch({withVoice:true,verified:true});const [touch]=h.touchListeners;
  touch({gesture:'press',intensity:3});h.time(2000);h.tick();await h.flush();
  h.voiceFake.speaking=true;touch({gesture:'release'});touch({gesture:'press',intensity:3});h.time(2100);touch({gesture:'release',tap:{durationMs:100}});
  assert.equal(h.voiceFake.interrupts,1);assert.equal(h.touches.length,0,'no smile while interrupting');h.close();
});
test('a laugh the host never finishes does not silence the head for good, and the reason is noted',async()=>{
  const h=await launch({withVoice:true,verified:true});const [touch]=h.touchListeners,tap=()=>{touch({gesture:'press',intensity:3});touch({gesture:'release',tap:{durationMs:100}});};
  let calls=0;h.robot.audio.playAudio=()=>{calls++;return new Promise(()=>{});};
  h.time(1000);tap();await h.flush();assert.equal(calls,1);
  h.time(5000);tap();await h.flush();assert.equal(calls,1,'still playing');assert.match(h.stored.get('voiceDiag'),/L:occ$/);
  h.time(9500);tap();await h.flush();assert.equal(calls,2,'tried again after 8 s');
  h.robot.audio.playAudio=()=>Promise.resolve(false);h.time(20000);tap();await h.flush();assert.match(h.stored.get('voiceDiag'),/L:no$/,'the host refused it');
  h.time(22000);h.face.behavior.onLongTouch();await h.flush();h.time(25000);tap();await h.flush();assert.match(h.stored.get('voiceDiag'),/L:voce$/,'no laugh while a conversation holds the speaker');
  h.close();
});
test('«Prova voce»: one phrase through the laugh path, then exactly the path of a call',async()=>{
  const h=await launch({withVoice:true,verified:true});const passes=[];
  h.voiceFake.selfTest=async(sound,options)=>{passes.push({sound,options});};h.robot.audio.volume=.5;
  const next=async()=>{await h.flush();for(const [id,t] of [...h.timeouts])if(t.ms===1500){h.timeouts.delete(id);t.cb();}await h.flush();};
  h.buttons.get('robottino:voicetest')();assert.equal(h.drawerCloses(),1,'the side menu closes first');
  await h.flush();assert.equal(h.touches.at(-1).audio,'prova-voce.bin','1: the path of the laugh');assert.match(h.balloons.at(-1),/^Prova 1 di 2: .*volume 0,5$/);
  await next();assert.equal(passes.length,1);assert.equal(passes[0].options.volume,1,'2: the call path, full volume like a call');assert.equal(h.balloons.at(-2),'Prova 2 di 2: voce della chiamata');
  assert.equal(passes[0].sound.length,6400);assert.deepEqual(passes[0].sound.read(10,20),{name:'prova-voce-ima.bin',a:10,b:20},'the IMA frames the Worker would send');
  await h.flush();assert.equal(h.balloons.at(-1),'Prova finita: la 2 gracchia o va a scatti?');
  h.voiceFake.active=true;h.buttons.get('robottino:voicetest')();assert.equal(h.balloons.at(-1),'Chiudi prima la conversazione.');
  h.voiceHooks.stats('m0 v0',true);assert.equal(h.stored.get('voiceTest'),'m0 v0');assert.equal(h.stored.get('voiceStats'),undefined,'call counters untouched');
  h.close();
});
test('the host side menu closes with ☰ and with every Robottino button in it',async()=>{
  const h=await launch({withVoice:true,verified:true});
  h.controller.onDrawerToggle();h.panels.at(-1).items.find(i=>i.label==='Menu host').action();assert.equal(h.drawerOpens(),1);
  const panels=h.panels.length,before=h.drawerCloses();h.controller.onDrawerToggle();assert.equal(h.drawerCloses(),before+1,'☰ closes the side menu');assert.equal(h.panels.length,panels,'and does not open the big menu on that press');
  h.controller.onDrawerToggle();assert.ok(h.face.behavior.panelOpen,'the next ☰ opens the big menu again');
  const closes=h.drawerCloses();h.buttons.get('robottino:dance')();assert.equal(h.drawerCloses(),closes+1,'a Robottino button closes it too');
  h.close();
});
test('once the robot listens, «Mi collego…» goes away and no «Ti ascolto» covers the face',async()=>{
  const h=await launch({withVoice:true,verified:true}),shown=[];let hidden=0;
  h.face.behavior.showMessage=(_face,text,options)=>shown.push([text,options]);h.face.behavior.hideMessage=()=>hidden++;
  h.face.behavior.onLongTouch();await h.flush();assert.deepEqual(shown.at(-1),['Mi collego…',undefined]);
  const count=shown.length;h.voiceHooks.listening();assert.equal(shown.length,count,'no new message');assert.equal(hidden,1);h.close();
});
test('spoken timers alert on screen with a sound, and Claude Code reactions are fixed lines',async()=>{
  const h=await launch({withVoice:true,withLive:true,verified:true,headCal:null});const [touch]=h.touchListeners;
  touch({gesture:'press',intensity:3});h.time(2000);h.tick();await h.flush();
  h.voiceHooks.timer({action:'set',seconds:60,label:'pasta'});assert.equal(h.balloons.at(-1),'Timer di 1 minuto impostato: pasta.');
  h.voiceHooks.mood({expression:'sad',gesture:'shake'});assert.deepEqual(h.faceCalls.at(-1),['emotion',2]);assert.equal(h.poses.length,0,'no gesture with motors off');
  h.voiceFake.stop();h.time(62000);h.tick();await h.flush();
  assert.equal(h.balloons.at(-1),'Tempo scaduto: pasta!');assert.ok(h.touches.some(t=>t.audio==='avviso.bin'));assert.deepEqual(h.faceCalls.at(-1),['emotion',3]);
  h.time(68000);h.tick();assert.deepEqual(h.faceCalls.at(-1),['emotion',0],'back to neutral after 5 s');
  h.liveHooks.reaction('attention');assert.equal(h.balloons.at(-1),'Claude Code ti chiede un permesso.');
  h.liveHooks.reaction('rm -rf');assert.equal(h.balloons.at(-1),'Claude Code ti chiede un permesso.','unknown reactions are ignored');
  h.close();
});

test('the white robot keeps a closed smile for a happy mood (its happy frame has an open mouth)',async()=>{
  const h=await launch({withVoice:true,verified:true});const [touch]=h.touchListeners;
  touch({gesture:'press',intensity:3});h.time(2000);h.tick();await h.flush();
  h.voiceHooks.mood({expression:'happy',gesture:null});assert.deepEqual(h.faceCalls.at(-1),['emotion',3]);
  h.face.behavior.setStyle(h.face,'white');h.voiceHooks.mood({expression:'happy',gesture:null});assert.deepEqual(h.faceCalls.at(-1),['emotion',0]);
  h.close();
});

test('without its credential the robot shows a pairing code instead of the live link, then connects',async()=>{
  const h=await launch({withLive:true,withPairing:true,withCredential:false,verified:true});
  assert.equal(h.liveConnects(),0,'no live link without a credential');assert.equal(h.pairingStarts(),1);
  h.pairingHooks.code('123456');assert.match(h.balloons.at(-1),/Abbina robot e scrivi 123 456/);
  h.stored.set('deviceToken','saved-device-credential-0123456789abcdef');h.pairingHooks.ended('paired');
  assert.equal(h.liveConnects(),1,'connects right after pairing');
  h.pairingHooks.ended('expired');assert.match(h.balloons.at(-1),/Codice scaduto/);
  assert.ok(h.buttons.has('robottino:pair'));h.close();
});
test('a second «Abbina con l’app» while the code is shown keeps the same code instead of cancelling it',async()=>{
  const h=await launch({withLive:true,withPairing:true,withCredential:false,verified:true});
  h.pairingHooks.code('123456');h.pairingHooks.diag('code');const before=h.pairingStarts();
  h.buttons.get('robottino:pair')();await h.flush();
  assert.equal(h.pairingStarts(),before,'not started again');assert.match(h.balloons.at(-1),/Abbina robot e scrivi 123 456/,'the same code shown again');
  assert.match(h.stored.get('pairDiag'),/code again$/);h.close();
});
test('without the large panel, safety switches turn on only with a second press within 5 s, and off at once with motors',async()=>{
  const h=await launch({withLive:true,verified:false});delete h.face.behavior.showPanel;
  h.buttons.get('robottino:verified')();assert.equal(h.stored.get('verified'),undefined,'first press only asks');assert.match(h.balloons.at(-1),/Premi di nuovo entro 5 secondi/);
  h.time(7000);h.buttons.get('robottino:verified')();assert.equal(h.stored.get('verified'),undefined,'too late: asks again');
  h.time(8000);h.buttons.get('robottino:verified')();assert.equal(h.stored.get('verified'),true);assert.ok(h.hellos()>=1,'the phone sees the new state');
  h.buttons.get('robottino:calibrated')();h.buttons.get('robottino:calibrated')();assert.equal(h.stored.get('calibrated'),true);
  h.buttons.get('robottino:calibrated')();assert.equal(h.stored.get('calibrated'),false,'switching off needs no confirmation');assert.match(h.balloons.at(-1),/Movimenti spenti/);
  h.close();
});

test('re-sends the CoreS3 panel settings every 2 s: same rotation and the target init sequence without reset',async()=>{
  const h=await launch();
  h.time(2000);h.tick();assert.equal(h.screen.rotationWrites,0);
  h.time(3100);h.tick();assert.equal(h.screen.rotationWrites,1);assert.equal(h.screen.rotation,0);
  const ids=h.screen.commands.map(([id])=>id);
  assert.deepEqual(ids,[0xC8,0xC0,0xC1,0xB0,0xF6,0x3A,0xB6,0xE0,0xE1,0x11,0x29,0x21],'target init sequence without the 0x01 panel reset');
  assert.deepEqual(h.screen.commands[4],[0xF6,[0x00,0x01,0x01]]);assert.deepEqual(h.screen.commands[5],[0x3A,[0x55]]);assert.deepEqual(h.screen.commands[9],[0x11,[]]);
  h.time(3500);h.tick();assert.equal(h.screen.rotationWrites,1,'not more often than every 2 s');
  h.time(5200);h.tick();assert.equal(h.screen.rotationWrites,2);h.close();
});

test('large menu: every function on one screen in two columns; a safety switch still asks before turning on',async()=>{
  const h=await launch({withPairing:true,withLive:true,withVoice:true});
  h.buttons.get('robottino:menu')();let menu=h.panels.at(-1);
  assert.equal(menu.title,'Menu di Robottino');assert.equal(menu.columns,2);
  assert.deepEqual([...menu.items].map(i=>i.label),['Parla','Movimenti: no','Hardware: no','Calibrazione: no','Live iPhone','Abbina app','Menu host','Chiudi']);
  const item=label=>h.panels.at(-1).items.find(i=>i.label===label);
  item('Hardware: no').action();const question=h.panels.at(-1);
  assert.match(question.title,/modello, firmware e collegamenti/);assert.deepEqual([...question.items].map(i=>i.label),['Sì, confermo','Annulla']);
  assert.equal(h.stored.get('verified'),undefined,'the question alone changes nothing');
  question.items[1].action();assert.equal(h.panels.at(-1).title,'Menu di Robottino','Annulla goes back');assert.equal(h.stored.get('verified'),undefined);
  item('Hardware: no').action();h.panels.at(-1).items[0].action();
  assert.equal(h.stored.get('verified'),true);assert.equal(h.panels.at(-1),null,'menu closes');assert.equal(h.balloons.at(-1),'Hardware verificato: attivato.');
  h.buttons.get('robottino:menu')();item('Hardware: sì').action();assert.equal(h.stored.get('verified'),false,'turning off needs no question');assert.match(h.balloons.at(-1),/disattivato/);
  assert.ok(item('Hardware: no'),'menu refreshed');
  item('Parla').action();await h.flush();assert.equal(h.voiceStarts(),1);assert.equal(h.panels.at(-1),null,'the menu closes and the conversation starts');
  h.buttons.get('robottino:menu')();assert.ok(item('Chiudi voce'));
  item('Menu host').action();assert.equal(h.drawerOpens(),1,'the host drawer stays reachable');assert.equal(h.panels.at(-1),null);
  h.buttons.get('robottino:menu')();item('Chiudi').action();assert.equal(h.panels.at(-1),null);h.close();
});

test('«Rete» in the big menu: with two networks known, the other one becomes the main network for the next start (owner, 10 Nov 2026)',async()=>{
  const h=await launch({withVoice:true});
  h.buttons.get('robottino:menu')();assert.ok(![...h.panels.at(-1).items].some(i=>i.label.startsWith('Rete')),'one network or none: no button');
  h.panels.at(-1).items.find(i=>i.label==='Chiudi').action();
  for(const [key,value] of [['net0ssid','Casa'],['net0pass','password-casa'],['net1ssid','iPhone di Ada'],['net1pass','password-hotspot']])h.stored.set(key,value);
  h.buttons.get('robottino:menu')();const item=[...h.panels.at(-1).items].find(i=>i.label.startsWith('Rete'));
  assert.equal(item.label,'Rete: Casa');item.action();
  assert.equal(h.stored.get('net0ssid'),'iPhone di Ada');assert.equal(h.stored.get('net1ssid'),'Casa');
  assert.equal(h.stored.get('ssid'),'iPhone di Ada','the host slot too');assert.equal(h.stored.get('password'),'password-hotspot');
  assert.match(h.balloons.at(-1),/Rete scelta: iPhone di Ada.*riaccendi/);
  assert.ok(!h.balloons.at(-1).includes('password'),'the password is never shown');
  h.buttons.get('robottino:menu')();assert.equal([...h.panels.at(-1).items].find(i=>i.label.startsWith('Rete')).label,'Rete: iPhone di ');h.close();
});
test('the host ☰ opens and closes the large menu while Robottino runs, and is given back on close',async()=>{
  const h=await launch({withPairing:true});
  h.controller.onDrawerToggle();assert.equal(h.panels.at(-1)?.title,'Menu di Robottino');assert.equal(h.controller.hostToggles,0,'the small drawer does not open');
  h.controller.onDrawerToggle();assert.equal(h.panels.at(-1),null,'a second tap closes it');
  h.panels.length=0;h.controller.onDrawerToggle();
  assert.equal(h.panels.at(-1).items.some(i=>/Ferma/.test(i.label)),false,'no stop button in the large menu (owner, 10 Nov 2026)');
  assert.equal(h.removed.includes('robottino:menu'),false);
  h.buttons.get('robottino:stop')();
  assert.ok(h.removed.includes('robottino:menu'),'stopped');assert.equal(Object.hasOwn(h.controller,'onDrawerToggle'),false,'host behaviour restored');
  h.controller.onDrawerToggle();assert.equal(h.controller.hostToggles,1);
});

test('host menu: a safety switch asks the large explicit question; «Menu grande» opens the panel',async()=>{
  const h=await launch({withLive:true,verified:false});
  h.buttons.get('robottino:verified')();const question=h.panels.at(-1);
  assert.match(question.title,/modello, firmware e collegamenti/);assert.equal(h.stored.get('verified'),undefined);
  question.items[1].action();assert.equal(h.panels.at(-1),null,'Annulla from the host menu just closes');assert.equal(h.stored.get('verified'),undefined);
  h.buttons.get('robottino:verified')();h.panels.at(-1).items[0].action();
  assert.equal(h.stored.get('verified'),true);assert.equal(h.panels.at(-1),null);assert.ok(h.hellos()>=1);
  h.buttons.get('robottino:verified')();assert.equal(h.stored.get('verified'),false,'off at once');
  h.buttons.get('robottino:menu')();assert.equal(h.panels.at(-1).title,'Menu di Robottino');
  h.close();assert.ok(h.removed.includes('robottino:menu'));
});

test('a long touch on the screen starts and ends the conversation like the head sensor',async()=>{
  const h=await launch({withVoice:true,verified:true});
  h.face.behavior.onLongTouch();await h.flush();assert.equal(h.voiceStarts(),1);assert.equal(h.panels.length,0,'no menu');
  h.time(4000);h.face.behavior.onLongTouch();await h.flush();assert.equal(h.voiceFake.active,false,'a later long touch ends it');h.close();
});

test('one gesture felt by both the screen and the head sensor toggles the conversation once',async()=>{
  const h=await launch({withVoice:true,verified:true});
  for(const cb of h.touchListeners)cb({gesture:'press',intensity:3});h.time(1950);h.tick();await h.flush();assert.equal(h.voiceStarts(),1,'head long press starts');
  h.time(2500);h.face.behavior.onLongTouch();await h.flush();assert.equal(h.voiceFake.active,true,'the screen release of the same touch is ignored');
  for(const cb of h.touchListeners)cb({gesture:'release'});
  h.time(6000);h.face.behavior.onLongTouch();await h.flush();assert.equal(h.voiceFake.active,false,'a new long touch later ends it');h.close();
});

test('restores the panel every 500 ms during a conversation, every 2 s otherwise',async()=>{
  const h=await launch({withVoice:true,verified:true});
  h.time(3100);h.tick();assert.equal(h.screen.rotationWrites,1);
  h.time(3200);h.face.behavior.onLongTouch();await h.flush();assert.equal(h.voiceFake.active,true);
  h.time(3500);h.tick();assert.equal(h.screen.rotationWrites,1);
  h.time(3650);h.tick();assert.equal(h.screen.rotationWrites,2,'500 ms while talking');
  h.time(4200);h.tick();assert.equal(h.screen.rotationWrites,3);
  h.voiceFake.active=false;h.time(4800);h.tick();assert.equal(h.screen.rotationWrites,3,'back to 2 s');
  h.time(6300);h.tick();assert.equal(h.screen.rotationWrites,4);h.close();
});
test('the conversation error names the real cause instead of blaming a Live call',async()=>{
  for(const [reason,text] of [['audio busy',/aspetta la fine del suono/],['audio_unavailable',/non disponibile in questo firmware/],['socket_failed',/Non riesco ad avviare/]]){
    const h=await launch({withVoice:true,verified:true});h.voiceFake.start=async()=>{throw Error(reason);};
    h.face.behavior.onLongTouch();await h.flush();
    assert.match(h.balloons.at(-1),text,reason);h.close();
  }
});
test('head lights follow the robot: off at rest, Live, conversation, reminder until touched, errors, off on stop',async()=>{
  const h=await launch({withVoice:true,withLive:true,withPairing:true,verified:true,withLights:true,headCal:null});
  const last=()=>h.lightCalls.at(-1);
  h.tick();assert.equal(h.lightCalls.length,0,'off at rest: nothing written');
  h.liveHooks.connected();h.tick();assert.deepEqual(last(),['on','head',38,0,64],'purple: the iPhone is connected');
  h.face.behavior.onLongTouch();await h.flush(); // a long touch starts the conversation
  h.voiceFake.phase='connecting';h.tick();assert.deepEqual(last(),['blink','head',0,35,64,1200]);
  h.voiceFake.phase='listening';h.tick();assert.deepEqual(last(),['on','head',0,35,64],'light blue: listening');
  h.voiceFake.phase='thinking';h.tick();assert.deepEqual(last(),['blink','head',0,35,64,1200],'slow blink: thinking');
  h.voiceFake.phase='speaking';h.tick();assert.deepEqual(last(),['on','head',64,43,23],'warm white: speaking');
  h.voiceFake.phase='idle';h.tick();assert.deepEqual(last(),['on','head',38,0,64]);
  const writes=h.lightCalls.length;h.tick();h.tick();assert.equal(h.lightCalls.length,writes,'no I2C traffic without a change');
  h.liveHooks.reaction('attention');h.tick();assert.deepEqual(last(),['blink','head',64,48,0,1000],'yellow: needs you');
  h.time(60000);h.tick();assert.deepEqual(last(),['blink','head',64,48,0,1000],'still lit a minute later');
  for(const cb of h.touchListeners)cb({gesture:'press',intensity:3});h.tick();assert.deepEqual(last(),['on','head',38,0,64],'a touch on the head puts it out');
  h.voiceHooks.ended('network');h.tick();assert.deepEqual(last(),['blink','head',64,0,0,600],'red: network error');
  h.time(61799);h.tick();assert.deepEqual(last(),['blink','head',64,0,0,600]);
  h.time(61800);h.tick();assert.deepEqual(last(),['on','head',38,0,64],'three blinks, then the light of the state');
  h.voiceHooks.ended('user');h.tick();assert.deepEqual(last(),['on','head',38,0,64],'closing a conversation is not an error');
  h.buttons.get('robottino:pair')();h.tick();assert.deepEqual(last(),['blink','head',64,23,0,1000],'orange: pairing code on the screen');
  h.close();assert.deepEqual(last(),['off','head'],'off when Robottino stops');
});
test('without the LED capability the MOD runs as before',async()=>{
  const h=await launch({withLive:true});h.liveHooks.connected();h.tick();assert.equal(h.robot.lighting,undefined);h.close();
});
// Runs the calibration check: its pauses are timers, its poses promises.
const drain=async h=>{for(let n=0;n<300;n++){await h.flush();const due=[...h.timeouts];if(!due.length)break;for(const [id,timer] of due){h.timeouts.delete(id);h.time(h.clock()+timer.ms);timer.cb();}}await h.flush();}; // time passes as each timer fires
test('guided head calibration: motors off, six positions by hand, a slow check, then saved with motions on',async()=>{
  const h=await launch({verified:true,headCal:null});
  assert.equal(h.stored.get('calibrated'),false,'the old switch without measurements is turned off');
  h.buttons.get('robottino:dance')();assert.match(h.balloons.at(-1),/calibrazione della testa/,'no dance before the head is measured');
  h.buttons.get('robottino:calibrated')();await h.flush();
  assert.deepEqual(h.torqueArgs,[false],'motors off, to move the head by hand');assert.match(h.panels.at(-1).title,/1 di 6/);
  // A head like this robot's could be: straight ahead is also nearly the lowest point.
  const positions=[[470,702],[468,930],[470,690],[790,700],[150,700],[466,698]];let now=1000;
  for(const [yaw,pitch] of positions){h.moveHead({yaw,pitch});for(let i=0;i<2;i++){now+=100;h.time(now);h.tick();}h.panels.at(-1).items[0].action();}
  assert.equal(h.poses.length,0,'nothing moved while measuring');assert.equal(h.lookAts(),h.lookAways(),'every reading let go of the gaze at once');
  assert.match(h.panels.at(-1).title,/Togli le mani/);await h.flush();assert.deepEqual(h.torqueArgs,[false,true]);
  await drain(h);
  assert.deepEqual(h.poses.map(pose=>{const raw=hostRaw(pose.host);return [raw.yaw,raw.pitch];}),[[468,702],[468,798],[468,894],[468,918],[468,830],[468,702],[324,702],[180,702],[324,702],[468,702],[612,702],[756,702],[612,702],[468,702]], // yaw mirrored: the K151 servo is reversed
    'every position a command can reach: up to 85° (here the measured top, 918), 90° to each side, never below straight ahead');
  const steps=h.poses.slice(1).map((pose,i)=>[pose,h.poses[i]]);
  for(const [pose,before] of steps)assert.ok(Math.abs(pose.duration-Math.max(MIN_MOVE,Math.hypot(pose.rotation.y-before.rotation.y,pose.rotation.p-before.rotation.p)/HEAD_SPEED))<.02,'at the one head speed: '+pose.duration);
  assert.match(h.panels.at(-1).title,/senza urti/);h.panels.at(-1).items[0].action();
  assert.deepEqual(JSON.parse(h.stored.get('headCal')),{v:2,yaw:{center:468,lo:162,hi:778,sign:1},pitch:{center:702,lo:702,hi:918,sign:1}});
  assert.equal(h.stored.get('calibrated'),true);assert.equal(h.balloons.at(-1),'Calibrazione salvata. Movimenti attivi.');
  h.buttons.get('robottino:dance')();assert.equal(h.dancing(),true,'dance allowed once calibrated');
  h.time(now+60000);h.tick();await h.flush();assert.equal(hostRaw(h.poses.at(-1).host).pitch,702,'later poses use the measurements');
  h.close();
});
test('calibration: a reading that never arrives is not taken; ☰ cancels and turns the motors off',async()=>{
  const h=await launch({verified:true,headCal:null});h.buttons.get('robottino:calibrated')();await h.flush();
  h.servoAnswers(false);h.time(1100);h.tick();h.time(1200);h.tick();
  h.panels.at(-1).items[0].action();assert.match(h.panels.at(-1).title,/^Non leggo la posizione.*1 di 6/);
  h.controller.onDrawerToggle();await h.flush();
  assert.deepEqual(h.torqueArgs,[false,false]);assert.equal(h.balloons.at(-1),'Calibrazione annullata: movimenti spenti.');
  assert.ok(Number.isFinite(h.headPose.body.rotation.y)&&Number.isFinite(h.headPose.body.rotation.p),'the host pose is left with numbers');
  h.close();
  const unverified=await launch({headCal:null});unverified.buttons.get('robottino:calibrated')();assert.match(unverified.balloons.at(-1),/Hardware: sì/);assert.equal(unverified.torqueCalls(),0);unverified.close();
  const live=await launch({verified:true,headCal:null,withLive:true});live.liveHooks.connected();live.buttons.get('robottino:calibrated')();assert.match(live.balloons.at(-1),/Live/);live.close();
});
test('motions turn on by themselves at start once hardware and head calibration are confirmed',async()=>{
  const h=await launch({verified:true});h.time(2900);h.tick();await h.flush();assert.equal(h.torqueCalls(),0);
  h.time(3000);h.tick();await h.flush();assert.deepEqual(h.torqueArgs,[true]);assert.equal(h.balloons.at(-1),'Movimenti attivi.');h.close();
  const unmeasured=await launch({verified:true,headCal:null});unmeasured.time(3500);unmeasured.tick();await unmeasured.flush();assert.equal(unmeasured.torqueCalls(),0,'not before the head is measured');unmeasured.close();
  const unverified=await launch();unverified.time(3500);unverified.tick();await unverified.flush();assert.equal(unverified.torqueCalls(),0);unverified.close();
  const manual=await launch({verified:true});manual.buttons.get('robottino:motion')();await manual.flush();manual.buttons.get('robottino:motion')();await manual.flush();
  manual.time(3500);manual.tick();await manual.flush();assert.equal(manual.torqueCalls(),1,'switched off by hand: stays off');manual.close();
});
test('calibration check: where the servo refuses a position, that end of the range shrinks until it is accepted',async()=>{
  // Like the K151 pitch servo: its own memory stops at 780, below the end stop measured by hand.
  const h=await launch({verified:true,headCal:null,refuse:raw=>raw.pitch>780});h.buttons.get('robottino:calibrated')();await h.flush();
  const positions=[[470,702],[468,930],[470,690],[790,700],[150,700],[466,698]];let now=1000;
  for(const [yaw,pitch] of positions){h.moveHead({yaw,pitch});for(let i=0;i<2;i++){now+=100;h.time(now);h.tick();}h.panels.at(-1).items[0].action();}
  await h.flush();await drain(h);
  const pitches=h.poses.map(pose=>hostRaw(pose.host).pitch);
  assert.deepEqual(pitches.slice(1,8),[798,798,790,790,782,782,774],'refused at 798, 790 and 782 (each tried twice: the host reports a refusal as a lost reply); accepted at 774');
  assert.ok(!h.balloons.some(text=>/bloccati/.test(text)),'a refusal inside the check does not block the motors');
  assert.match(h.panels.at(-1).title,/ridotto un poco i limiti/);h.panels.at(-1).items[0].action();
  assert.equal(JSON.parse(h.stored.get('headCal')).pitch.hi,774);
  assert.match(h.stored.get('calDiag'),/refused:468,782/);h.close();
  // Refused even at the centre: nothing to shrink, the motors are blocked as for any unconfirmed command.
  const stuck=await launch({verified:true,headCal:null,refuse:raw=>raw.pitch>=700});stuck.buttons.get('robottino:calibrated')();await stuck.flush();
  now=1000;for(const [yaw,pitch] of positions){stuck.moveHead({yaw,pitch});for(let i=0;i<2;i++){now+=100;stuck.time(now);stuck.tick();}stuck.panels.at(-1).items[0].action();}
  await stuck.flush();await drain(stuck);
  assert.match(stuck.panels.at(-1).title,/calibrazione non salvata/);assert.equal(stuck.stored.get('calibrated'),false);stuck.close();
});
test('head control from the iPhone: 90° sideways and 85° up, never down; a link lost after the move is not a fault',async()=>{
  const h=await launch({withLive:true,verified:true});h.liveHooks.connected();await arm(h);
  await h.liveHooks.motion({yaw:90,pitch:-85});
  const wide=h.poses.at(-1).rotation;assert.ok(Math.abs(wide.y-Math.PI/2)<.004&&Math.abs(wide.p+85*Math.PI/180)<.004,'the robot limits: 90° sideways, 85° up');
  h.time(11000);await h.liveHooks.motion({yaw:-90,pitch:10});assert.ok(Math.abs(h.poses.at(-1).rotation.y+Math.PI/2)<.004&&h.poses.at(-1).rotation.p===0,'across the whole range in one move, never down');
  const across=Math.hypot(Math.PI,85*Math.PI/180)/HEAD_SPEED;assert.ok(Math.abs(h.poses.at(-1).duration-across)<.03,'the one head speed, 3 rad/s: '+h.poses.at(-1).duration);
  const late=h.liveHooks.motion({yaw:0,pitch:0});h.liveHooks.disconnected();await assert.rejects(late,/motion_cancelled/);
  assert.ok(!h.balloons.some(text=>/bloccati/.test(text)),'the servos confirmed the pose: no fault');h.close();
});
test('Italian time: the robot shows Rome time, with summer time, once the host has the time from the network',async()=>{
  const h=await launch({headCal:null});h.tick();assert.equal(h.timeFake.timezone,undefined,'no network time yet: nothing set');
  h.wallTime(Date.UTC(2026,10,9,19,45));h.time(61100);h.tick();
  assert.equal(h.timeFake.timezone,3600);assert.equal(h.timeFake.dst,0,'November: winter time, 20:45');
  assert.deepEqual(h.preferences.filter(([key])=>key==='timezone'),[['timezone','paris']],'the host starts at +1 next time');
  h.wallTime(Date.UTC(2027,5,1,12));h.time(122000);h.tick();assert.equal(h.timeFake.dst,3600,'June: summer time');h.close();
});
test('motors on: the head turns straight ahead at the one head speed, from where the servos say it is',async()=>{
  const h=await launch({verified:true});h.moveHead({yaw:460+144,pitch:620+64}); // 45° to one side and 20° up (fixture centre 460/620)
  h.time(3000);h.tick();await drain(h); // the automatic start, 2 s after boot
  assert.deepEqual(h.torqueArgs,[true]);assert.equal(h.poses.length,1,'one move');
  const [centre]=h.poses;assert.ok(Math.abs(centre.rotation.y)<.003&&Math.abs(centre.rotation.p)<.003,'straight ahead');
  assert.ok(Math.abs(centre.duration-Math.hypot(Math.PI/4,20*Math.PI/180)/HEAD_SPEED)<.03,'from 45° and 20° up at 3 rad/s: '+centre.duration);
  assert.equal(h.lookAts(),1,'one reading of the servos');assert.match(h.stored.get('calDiag'),/centre:60[345],68[345]/);h.close();
  const blind=await launch({verified:true});blind.servoAnswers(false);blind.buttons.get('robottino:motion')();await drain(blind);
  assert.ok(Math.abs(blind.poses[0].duration-Math.PI/2/HEAD_SPEED)<.01,'no reading: timed as from 90° to the side, never faster than usual');
  assert.ok(Number.isFinite(blind.headPose.body.rotation.y)&&Number.isFinite(blind.headPose.body.rotation.p),'the host pose is left with numbers');
  assert.match(blind.stored.get('calDiag'),/centre:noread/);blind.close();
  const unmeasured=await launch({verified:true,headCal:null});unmeasured.buttons.get('robottino:motion')();await drain(unmeasured);assert.equal(unmeasured.poses.length,0,'no measurements: the head is not moved');unmeasured.close();
});
test('a servo reply lost once is tried again with the same position; lost twice blocks the motors',async()=>{
  const h=await launch({withLive:true,verified:true});h.liveHooks.connected();await arm(h);
  h.loseReplies(1);await h.liveHooks.motion({yaw:20,pitch:0});
  assert.equal(h.poses.length,2,'the same position sent again');assert.deepEqual(h.poses[0].host,h.poses[1].host);
  assert.ok(!h.balloons.some(text=>/bloccati/.test(text)),'confirmed the second time: no fault');assert.match(h.stored.get('calDiag'),/retry/);
  h.time(5000);h.loseReplies(2);await assert.rejects(()=>h.liveHooks.motion({yaw:-20,pitch:0}),/timed out/);
  assert.equal(h.poses.length,4,'only one more try');assert.equal(h.balloons.at(-1),'Errore comando remoto: movimenti bloccati.');
  assert.match(h.stored.get('calDiag'),/lost w\d+ e\d+ g\d+/,'the times of the two tries are kept for the USB log');h.close();
});
// Fires the one 20 ms timer that is waiting (the tests hold them with holdShortTimers), `late` ms after it was due.
const shortStep=async(h,late=0)=>{
  const due=[...h.timeouts].filter(([,timer])=>timer.ms===20);assert.equal(due.length,1,'one short timer waiting');
  const [id,timer]=due[0];h.timeouts.delete(id);h.time(h.clock()+20+late);timer.cb();await h.flush();
};
test('the repeat of a lost servo command waits for a quiet moment; it is not sent once the motions are switched off (10 Nov 2026)',async()=>{
  const h=await launch({withLive:true,verified:true});h.liveHooks.connected();await arm(h);
  h.holdShortTimers(true);h.loseReplies(1);
  let done=false;const first=h.liveHooks.motion({yaw:20,pitch:0}).then(()=>{done=true;});await h.flush();
  assert.equal(h.poses.length,1,'the repeat does not leave at once');assert.equal(h.liveHooks.motionBusy(),true,'the command is still waiting');
  await shortStep(h);await shortStep(h);await shortStep(h,200);
  assert.equal(h.poses.length,1,'a late timer: JavaScript is still busy, the count starts again');
  await shortStep(h);await shortStep(h);assert.equal(h.poses.length,1);await shortStep(h);
  assert.equal(h.poses.length,2,'three timers on time in a row: the repeat goes');await first;assert.equal(done,true);
  assert.deepEqual(h.poses[0].host,h.poses[1].host);assert.match(h.stored.get('calDiag'),/retry e\d+ g\d+/);
  assert.ok(!h.balloons.some(text=>/bloccati/.test(text)),'confirmed the second time: no fault');
  // STOP from the iPhone while the repeat waits: it is not sent, and the command stays unconfirmed.
  h.time(h.clock()+5000);h.loseReplies(1);
  const second=assert.rejects(()=>h.liveHooks.motion({yaw:-20,pitch:0}),/timed out/);await h.flush();
  assert.equal(h.poses.length,3);h.liveHooks.stop(true);
  await shortStep(h);await shortStep(h);await shortStep(h);await second;
  assert.equal(h.poses.length,3,'motions switched off meanwhile: no repeat');
  assert.equal(h.balloons.at(-1),'Errore comando remoto: movimenti bloccati.');h.close();
});
test('a quiet moment that never comes: the repeat goes after 400 ms, inside the 1.2 s pose check',async()=>{
  const h=await launch({withLive:true,verified:true});h.liveHooks.connected();await arm(h);
  h.holdShortTimers(true);h.loseReplies(1);const from=h.clock();
  const moved=h.liveHooks.motion({yaw:20,pitch:0});await h.flush();
  let steps=0;while(h.poses.length<2&&steps<20){await shortStep(h,60);steps++;}
  assert.equal(steps,5,'five timers of 80 ms');assert.equal(h.clock()-from,400);await moved;
  assert.ok(!h.balloons.some(text=>/bloccati/.test(text)));h.close();
});
test('the repeat of a lost command also waits for microphone and speaker to have settled (10 Nov 2026)',async()=>{
  const h=await launch({withVoice:true,withLive:true,verified:true});await arm(h);
  let busy=false;const [touch]=h.touchListeners,t0=h.clock();
  touch({gesture:'press',intensity:3});h.time(t0+600);h.tick();h.time(t0+1100);h.tick();await h.flush();touch({gesture:'release'});
  assert.equal(h.voiceFake.active,true);h.voiceFake.busy=()=>busy;h.liveHooks.connected();
  h.holdShortTimers(true);h.loseReplies(1);
  const moved=h.liveHooks.motion({yaw:20,pitch:0});await h.flush();assert.equal(h.poses.length,1);
  busy=true; // the reply starts and the speaker opens while the repeat waits
  for(let i=0;i<6;i++)await shortStep(h);
  assert.equal(h.poses.length,1,'timers on time, but the audio is changing: not a quiet moment');
  busy=false;await shortStep(h);await shortStep(h);assert.equal(h.poses.length,1);await shortStep(h);
  assert.equal(h.poses.length,2,'settled, three timers on time: the repeat goes');await moved;
  assert.ok(!h.balloons.some(text=>/bloccati/.test(text)));h.close();
});
test('while the conversation starts or changes between microphone and speaker no head command leaves, from the iPhone either (10 Nov 2026)',async()=>{
  const h=await launch({withVoice:true,withLive:true,verified:true});await arm(h);
  let busy=true;const [touch]=h.touchListeners,t0=h.clock();
  touch({gesture:'press',intensity:3});h.time(t0+600);h.tick();h.time(t0+1100);h.tick();await h.flush();touch({gesture:'release'});
  assert.equal(h.voiceFake.active,true);h.voiceFake.busy=()=>busy;
  for(let t=t0+1200;t<=t0+2000;t+=100){h.time(t);h.tick();await h.flush();}
  assert.equal(h.poses.length,0,'the conversation is starting: the look up waits');
  busy=false;h.time(t0+2100);h.tick();await h.flush();assert.equal(h.poses.length,1,'then it goes');
  h.voiceHooks.mood({expression:'happy',gesture:'nod'});busy=true; // the reply: the speaker opens
  for(let t=t0+2200;t<=t0+2900;t+=100){h.time(t);h.tick();await h.flush();}
  assert.equal(h.poses.length,1,'the nod waits for the speaker to have started');
  busy=false;for(let t=t0+3000;t<=t0+4500;t+=100){h.time(t);h.tick();await h.flush();}
  assert.equal(h.poses.length,5,'then the whole nod, four steps');
  h.liveHooks.connected();busy=true;
  await assert.rejects(()=>h.liveHooks.motion({yaw:10,pitch:0}),/motion_unavailable/,'the iPhone is told to try again');
  assert.equal(h.poses.length,5);assert.ok(!h.balloons.some(text=>/bloccati/.test(text)),'refused, not a fault');
  busy=false;h.time(t0+6000);await h.liveHooks.motion({yaw:10,pitch:0});assert.equal(h.poses.length,6);h.close();
});
test('a reply gesture starts 300 ms after the face changes, not together with it',async()=>{
  const h=await launch({withVoice:true,verified:true});await arm(h);const [touch]=h.touchListeners,t0=h.clock();
  touch({gesture:'press',intensity:3});h.time(t0+600);h.tick();h.time(t0+1100);h.tick();await h.flush();touch({gesture:'release'});
  h.time(t0+1200);h.tick();await h.flush();assert.equal(h.poses.length,1,'looking up');
  h.voiceHooks.mood({expression:'happy',gesture:'nod'});
  h.time(t0+1300);h.tick();await h.flush();h.time(t0+1400);h.tick();await h.flush();assert.equal(h.poses.length,1,'not yet');
  h.time(t0+1500);h.tick();await h.flush();assert.equal(h.poses.length,2,'300 ms later, the first step');h.close();
});
test('a conversation starts only once the servos have confirmed the command they are waiting for, and after 1.5 s in any case',async()=>{
  const start=async()=>{
    const h=await launch({withVoice:true,withLive:true,verified:true,poseMode:'pending'});h.liveHooks.connected();
    h.buttons.get('robottino:motion')();await h.flush();h.finishPose();await h.flush();
    const [touch]=h.touchListeners,t0=h.clock();touch({gesture:'press',intensity:3});h.time(t0+600);h.tick();
    h.holdShortTimers(true);const moved=h.liveHooks.motion({yaw:20,pitch:0});moved.catch(()=>{});await h.flush();
    assert.equal(h.liveHooks.motionBusy(),true,'a head command waits for the servos');
    h.time(t0+1100);h.tick();await h.flush();touch({gesture:'release'});
    assert.equal(h.voiceStarts(),0,'the audio does not change meanwhile');assert.ok(h.balloons.some(text=>/Mi collego/.test(text)));
    return {h,moved};
  };
  const {h,moved}=await start();
  await shortStep(h);await shortStep(h);assert.equal(h.voiceStarts(),0);
  h.finishPose();await moved;await shortStep(h);assert.equal(h.voiceStarts(),1,'confirmed: the conversation starts');h.close();
  const stuck=await start();let steps=0;
  while(!stuck.h.voiceStarts()&&steps<100){await shortStep(stuck.h);steps++;}
  assert.equal(steps,75,'servos silent: the conversation starts anyway after a second and a half');stuck.h.close();
});
test('a calibration from before the 90° check is not used: the owner is asked to measure again',async()=>{
  const old=JSON.stringify({yaw:{center:493,lo:204,hi:743,sign:1},pitch:{center:621,lo:621,hi:868,sign:1}});
  const h=await launch({verified:true,headCal:old});
  assert.equal(h.stored.get('calibrated'),false);assert.match(h.balloons.join(' '),/rifai la calibrazione/);
  h.time(3500);h.tick();await h.flush();assert.equal(h.torqueCalls(),0,'motions stay off until measured again');h.close();
});
test('the iPhone learns at once when a conversation starts and ends (face following during a conversation)',async()=>{
  const h=await launch({withVoice:true,withLive:true,verified:true,headCal:null});const [touch]=h.touchListeners;
  assert.equal(h.liveHooks.conversation(),false);
  touch({gesture:'press',intensity:3});h.time(2000);h.tick();await h.flush();assert.equal(h.voiceFake.active,true);
  const before=h.hellos();h.time(2100);h.tick();assert.equal(h.liveHooks.conversation(),true);assert.equal(h.hellos(),before+1);
  h.time(2200);h.tick();assert.equal(h.hellos(),before+1,'only when it changes');
  h.voiceFake.active=false;h.time(2300);h.tick();assert.equal(h.hellos(),before+2);assert.equal(h.liveHooks.conversation(),false);h.close();
});
test('the iPhone leaving stops following but keeps the motions on; only its STOP switches them off',async()=>{
  const h=await launch({withLive:true,verified:true});h.liveHooks.connected();await arm(h);
  h.liveHooks.follow(true);h.liveHooks.disconnected();
  assert.equal(h.liveHooks.motionEnabled(),true,'the iPhone left: motions stay as the owner set them');
  h.liveHooks.connected();h.liveHooks.follow(true);h.liveHooks.stop(false);
  assert.equal(h.liveHooks.motionEnabled(),true,'the link closed: following stops, motions stay on');
  assert.equal(h.liveHooks.aim({x:.2,y:.5,pose:{y:0,p:0}}),false,'no more following');
  h.liveHooks.stop(true);assert.equal(h.liveHooks.motionEnabled(),false,'the STOP command switches them off');h.close();
});
test('leaving the Live brings the head straight; while the camera switches no head command starts',async()=>{
  const h=await launch({withLive:true,verified:true});h.liveHooks.connected();await arm(h);
  await h.liveHooks.motion({yaw:40,pitch:-20});await h.flush();assert.equal(h.poses.length,1);
  h.cameraSwitching(true);
  await assert.rejects(()=>h.liveHooks.motion({yaw:10,pitch:0}),/motion_unavailable/,'the host is busy with the camera');
  h.liveHooks.disconnected();h.time(1500);h.tick();await h.flush();assert.equal(h.poses.length,1,'the head waits while the camera stops');
  h.cameraSwitching(false);h.time(1600);h.tick();await h.flush();
  assert.equal(h.poses.length,2);const home=h.poses[1].rotation;assert.ok(Math.abs(home.y)<1e-9&&Math.abs(home.p)<1e-9,'then straight ahead');
  h.liveHooks.connected();await h.liveHooks.motion({yaw:-30,pitch:0});await h.flush();h.liveHooks.connected();
  h.time(3000);h.tick();await h.flush();assert.equal(h.poses.length,3,'back in the Live: no return home');h.close();
});
test('a conversation: the head looks up at the owner once the connection is open, nods around there, then comes back straight',async()=>{
  const h=await launch({withVoice:true,verified:true});await arm(h);
  h.connectingNow(true);const [touch]=h.touchListeners;const t0=h.clock();
  touch({gesture:'press',intensity:3});h.time(t0+600);h.tick();h.time(t0+1100);h.tick();await h.flush();touch({gesture:'release'});
  assert.equal(h.voiceFake.active,true,'long press: a conversation');h.time(t0+1150);h.tick();await h.flush();
  assert.equal(h.poses.length,0,'not while the connection opens (TLS handshake)');
  h.connectingNow(false);h.time(t0+1300);h.tick();await h.flush();
  assert.equal(h.poses.length,1);const up=h.poses[0].rotation;assert.ok(Math.abs(up.y)<1e-9&&Math.abs(up.p+25*Math.PI/180)<.01,'straight and 25° up: '+JSON.stringify(up));
  h.voiceHooks.mood({expression:'happy',gesture:'nod'});
  for(let t=t0+1400;t<=t0+3000;t+=100){h.time(t);h.tick();await h.flush();}
  const nod=h.poses.slice(1).map(pose=>pose.rotation.p*180/Math.PI);
  assert.ok(nod.length>=3&&nod.every(p=>p<=-24&&p>=-32),'the nod goes around the raised head, never back down: '+nod.map(p=>p.toFixed(1)));
  h.voiceFake.active=false;h.time(t0+3100);h.tick();await h.flush();h.time(t0+3200);h.tick();await h.flush();
  const last=h.poses.at(-1).rotation;assert.ok(Math.abs(last.y)<1e-9&&Math.abs(last.p)<1e-9,'conversation over: straight again');h.close();
});
test('at rest the head stays still: no glances on its own (owner, 9 Nov 2026)',async()=>{
  const h=await launch({withLive:true,verified:true});await arm(h);
  assert.equal(h.liveHooks.motionBusy(),false,'nothing waits for the servos');
  for(let i=1;i<=900;i++){h.time(1000+100*i);h.tick();if(i%50===0)await h.flush();}
  await h.flush();assert.equal(h.poses.length,0,'90 seconds with the motions on and nobody: not one pose');h.close();
});
test('following a still face sends the pose once, not 10 times a second',async()=>{
  const h=await launch({withLive:true,verified:true});h.liveHooks.connected();await arm(h);h.liveHooks.follow(true);
  const pose=h.liveHooks.headPose();assert.equal(h.liveHooks.aim({x:.5,y:.5,pose}),true,'a face in the middle');
  for(let i=1;i<=10;i++){h.time(1000+100*i);h.tick();await h.flush();}
  assert.ok(h.poses.length<=1,'at most one pose for a face that does not move: '+h.poses.length);
  assert.equal(h.liveHooks.aim({x:.1,y:.5,pose:h.liveHooks.headPose()}),true,'the face moves to the side');
  const before=h.poses.length;for(let i=11;i<=15;i++){h.time(1000+100*i);h.tick();await h.flush();}
  assert.ok(h.poses.length-before>=1&&h.poses.length-before<=3,'the head turns at once at 3 rad/s, then rests: '+(h.poses.length-before));
  assert.ok(Math.abs(h.poses.at(-1).rotation.y-.4*CAMERA_FOV.x*.8)<=.05,'and stops on the face, within the 3° dead band: '+h.poses.at(-1).rotation.y);h.close();
});
test('K151 direction, as seen on the robot (9 Nov 2026): a face on the right of the frame raises the yaw servo position',async()=>{
  // On the robot a face at x 0.84 made the head turn away while the yaw servo position went down; the servo position
  // must go up for the head to turn towards that face.
  const h=await launch({withLive:true,verified:true});h.liveHooks.connected();await arm(h);h.liveHooks.follow(true);
  assert.equal(h.liveHooks.aim({x:.84,y:.45,pose:h.liveHooks.headPose()}),true);
  for(let i=1;i<=5;i++){h.time(1000+100*i);h.tick();await h.flush();}
  assert.ok(hostRaw(h.poses.at(-1).host).yaw>460,'towards the face: '+hostRaw(h.poses.at(-1).host).yaw);h.close();
});

// A long run in simulated time (10 Nov 2026): the real mod.js in a conversation, against a model of the servo line
// as the host drives it. The servos answer 25 ms after a command and the host gives up after 120 ms; the host's loop
// runs the timers that are due before it delivers what has arrived, so when JavaScript is held up across those
// 120 ms an answer that did arrive counts as lost. In the model JavaScript is held up when the conversation starts
// and each time microphone and speaker change (in bursts, for a third of a second), now and then for other reasons
// (`stray`, times a second), and some answers never come (`deaf`). The holds are a guess at what happens on the
// robot, not a measure: the run checks the rules of the MOD under thousands of orderings, not the cause.
const mulberry=seed=>()=>{seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;};
async function soak({seed,minutes,app=false,deaf=0,stray=0}){
  const h=await launch({withVoice:true,withLive:true,verified:true}),random=mulberry(seed),between=(a,b)=>Math.round(a+random()*(b-a));
  await arm(h);
  const stats={commands:0,lost:0,repeats:0,saved:0,faults:0,longestWait:0,replies:0,answers:0,error:0},violations=[];
  const wrong=text=>{if(violations.length<12)violations.push(`${h.clock()} ms: ${text}`);};
  let waiting,repeatOf,lastLost,commandAt=0,faulted=false,busyUntil=Infinity,head={y:0,p:0},following=false;
  h.voiceFake.busy=()=>h.clock()<busyUntil;h.holdShortTimers(true);
  h.robot.motion.setPose=pose=>new Promise((resolve,reject)=>{
    const raw=hostRaw(pose.rotation),at=h.clock();
    if(faulted)wrong('a command after the motions were blocked');
    if(waiting)wrong('two commands on the servo line at once');
    if(raw.yaw<51||raw.yaw>869||raw.pitch<620||raw.pitch>892)wrong('a command outside the measured limits');
    if(repeatOf){
      if(raw.yaw!==repeatOf.raw.yaw||raw.pitch!==repeatOf.raw.pitch)wrong('the repeat is not the same command');
      stats.repeats++;stats.longestWait=Math.max(stats.longestWait,at-repeatOf.lostAt);
    }else{
      if(at<busyUntil)wrong('a new command while the audio is changing');
      stats.commands++;commandAt=at;
    }
    waiting={resolve,reject,at,raw,rotation:logical(pose.rotation),repeat:!!repeatOf,answers:random()>=deaf};repeatOf=undefined;
  });
  // The host's timers: the 100 ms loop, the 20 ms timers of the MOD (held by the harness, fired here when due).
  let loopAt=0;const short=new Map(),events=[],later=(at,run)=>{events.push({at,run});};
  const settle=async()=>{
    await h.flush();
    for(const [id,timer] of h.timeouts)if(timer.ms===20&&!short.has(id))short.set(id,h.clock()+20);
    for(const id of [...short.keys()])if(!h.timeouts.has(id))short.delete(id);
    if(!faulted){
      const text=h.balloons.find(text=>/bloccati/.test(text));
      if(text){
        faulted=true;stats.faults++;stats.fault=text;following=false;
        if(/non confermato/.test(text)){if(h.clock()-commandAt<1200)wrong('the pose watchdog fired before 1.2 s');}
        else if(!lastLost?.repeat)wrong('motions blocked after one lost answer: '+text);
      }
    }
    if(faulted)repeatOf=undefined;
    else if(repeatOf&&!h.liveHooks.motionBusy())wrong('a lost answer was dropped: no repeat and no fault');
  };
  // One turn of the host's loop at the present time: first the timers that are due, the oldest first, then the
  // answer of the servos if it has arrived.
  const serve=async()=>{
    for(;;){
      const now=h.clock();let first;const due=(at,run)=>{if(at<=now&&(!first||at<first.at))first={at,run};};
      if(waiting)due(waiting.at+120,()=>{
        const lost=waiting;waiting=undefined;stats.lost++;lastLost=lost;if(!lost.repeat)repeatOf={raw:lost.raw,lostAt:now};
        lost.reject(Error('scservo command timed out after 120ms'));
      });
      due(loopAt,()=>{loopAt=now+100;h.tick();});
      for(const [id,at] of short)due(at,()=>{const timer=h.timeouts.get(id);h.timeouts.delete(id);short.delete(id);timer.cb();});
      if(!first)break;
      const lostRepeat=waiting?.repeat&&first.at===waiting.at+120;
      first.run();await settle();
      if(lostRepeat&&!faulted)wrong('a command lost twice did not block the motions');
    }
    if(waiting?.answers&&h.clock()-waiting.at>=25){
      const done=waiting;waiting=undefined;head=done.rotation;if(done.repeat)stats.saved++;done.resolve();await settle();
    }
  };
  // The conversation. A change of microphone or speaker holds JavaScript up at once and once or twice more in the
  // next third of a second; busy() of the voice says so for 350 ms, as voice-device.js does.
  const audioChange=phase=>{
    h.voiceFake.phase=phase;h.voiceFake.speaking=phase==='speaking';busyUntil=h.clock()+350;
    for(let i=1+Math.floor(random()*2);i>0;i--)later(h.clock()+between(60,320),()=>between(60,200));
    return between(80,250);
  };
  const listen=()=>{later(h.clock()+between(2000,6000),reply);return audioChange('listening');};
  // The reply: its text first (mood and gesture), its sound up to half a second later.
  const reply=()=>{
    stats.replies++;h.voiceHooks.mood({expression:random()<.5?'happy':'neutral',gesture:random()<.7?'nod':undefined});
    later(h.clock()+between(0,500),()=>{later(h.clock()+between(2000,5000),listen);return audioChange('speaking');});
  };
  const [touch]=h.touchListeners,t0=h.clock();
  touch({gesture:'press',intensity:3});h.time(t0+600);h.tick();h.time(t0+1100);h.tick();await h.flush();touch({gesture:'release'});
  assert.equal(h.voiceFake.active,true);loopAt=h.clock()+100;await settle();
  later(h.clock()+between(20,150),()=>between(300,2500)); // the connection opens: the longest hold seen on the robot
  later(h.clock()+between(2600,3500),listen);
  if(stray){const next=()=>{later(h.clock()+Math.round(-Math.log(1-random())/stray*1000),()=>{next();return between(130,300);});};next();}
  // The app in the foreground follows the face with the robot's camera: an image leaves about every 0.75 s (never
  // while a servo command waits) and its answer comes back half a second later. The face swings 29° either side.
  if(app){
    const face=at=>.5*Math.sin(2*Math.PI*at/20000);
    const shot=()=>{
      later(h.clock()+between(600,900),shot);if(faulted)return;
      if(!following){try{h.liveHooks.connected();h.liveHooks.follow(true);following=true;}catch{}return;}
      if(h.liveHooks.motionBusy())return;
      const pose=h.liveHooks.headPose(),angle=face(h.clock());
      later(h.clock()+between(450,700),()=>{
        const x=.5-(angle-pose.y)/CAMERA_FOV.x;if(faulted||x<0||x>1)return;
        h.liveHooks.aim({x,y:.5,pose});stats.answers++;stats.error+=Math.abs(face(h.clock())-head.y);
      });
    };
    later(h.clock()+4000,shot);
  }
  let end=h.clock()+minutes*60000;
  while(h.clock()<end){
    let next=Math.min(loopAt,...short.values(),...events.map(event=>event.at));
    if(waiting)next=Math.min(next,waiting.at+(waiting.answers?25:120));
    if(next>h.clock())h.time(next);
    await serve();
    const event=events.filter(event=>event.at<=h.clock()).sort((a,b)=>a.at-b.at)[0];
    if(event){events.splice(events.indexOf(event),1);const hold=event.run();await settle();if(hold)h.time(h.clock()+hold);}
    if(faulted&&end>h.clock()+10000)end=h.clock()+10000; // ten more seconds: nothing may leave after a fault
  }
  h.close();
  stats.error=stats.answers?Math.round(stats.error/stats.answers*180/Math.PI*10)/10:undefined;
  return {stats,violations};
}
test('ten simulated minutes of conversation: a head command never leaves while microphone and speaker change, and the one lost to a change is recovered by its repeat',async t=>{
  let lost=0,commands=0;
  for(const seed of [1,2,3]){
    const {stats,violations}=await soak({seed,minutes:10});t.diagnostic(`seed ${seed} ${JSON.stringify(stats)}`);
    assert.deepEqual(violations,[]);assert.equal(stats.faults,0,'no hold outside the changes of the audio: nothing is lost twice');
    assert.equal(stats.saved,stats.lost,'every lost answer recovered by the one repeat');assert.ok(stats.longestWait<=600,'the repeat within 400 ms of a quiet moment not found, plus one hold');
    assert.ok(stats.commands>stats.replies,'the look up and the nods did leave');lost+=stats.lost;commands+=stats.commands;
  }
  assert.ok(lost>0,'the run did meet commands caught by a change of the audio');t.diagnostic(`commands ${commands}, lost and recovered ${lost}`);
});
for(const app of [false,true])test(`simulated conversations ${app?'with the app following the face':'on their own'}, servos that do not always answer and JavaScript held up at random: never a third try, never a command after a fault, a fault only after two lost answers`,async t=>{
  let faults=0,saved=0,commands=0;
  for(let seed=11;seed<=22;seed++){
    const {stats,violations}=await soak({seed,minutes:5,app,deaf:.01,stray:.2});t.diagnostic(`seed ${seed} ${JSON.stringify(stats)}`);
    assert.deepEqual(violations,[]);assert.ok(stats.repeats<=stats.lost&&stats.saved<=stats.repeats);
    if(app&&!stats.faults)assert.ok(stats.answers>200&&stats.error<15,'the head keeps following the face: '+stats.error+'° off on average');
    faults+=stats.faults;saved+=stats.saved;commands+=stats.commands;
  }
  assert.ok(saved>0);t.diagnostic(`commands ${commands}, recovered by the repeat ${saved}, runs ended by a fault ${faults} of 12`);
});
test('spoken head commands turn the head 20° at a time from where it is, through the same checks as every gesture (11 Nov 2026)',async()=>{
  const talk=async h=>{const [touch]=h.touchListeners,t0=h.clock();touch({gesture:'press',intensity:3});h.time(t0+600);h.tick();h.time(t0+1100);h.tick();await h.flush();touch({gesture:'release'});for(let i=0;i<10;i++){h.time(h.clock()+100);h.tick();await h.flush();}};
  const h=await launch({withVoice:true,verified:true});await arm(h);await talk(h);
  const deg=value=>Math.round(value*180/Math.PI);
  assert.deepEqual(h.poses.map(pose=>[deg(pose.rotation.y),deg(pose.rotation.p)]),[[0,-25]],'the conversation looks up first');
  const run=async direction=>{
    const before=h.poses.length;h.voiceHooks.head({direction});
    for(let i=0;i<12;i++){h.time(h.clock()+100);h.tick();await h.flush();}
    const added=h.poses.slice(before).map(pose=>[deg(pose.rotation.y),deg(pose.rotation.p)]);
    return added.at(-1);
  };
  assert.deepEqual(await run('right'),[20,-25],'the user’s right, facing the robot: positive yaw (the robot’s own left)');
  assert.deepEqual(await run('right'),[40,-25],'from where it is');
  assert.deepEqual(await run('left'),[-20,-25],'from the right, «sinistra» ends on the left of straight ahead, said once');
  assert.deepEqual(await run('left'),[-40,-25]);assert.deepEqual(await run('right'),[20,-25],'and back the same way');
  assert.deepEqual(await run('up'),[20,-45],'negative pitch looks up');
  assert.deepEqual(await run('down'),[20,-25]);
  assert.deepEqual(await run('down'),[20,-5]);
  assert.deepEqual(await run('down'),[20,0],'never below straight ahead');
  assert.deepEqual(await run('center'),[0,0]);
  const full=async direction=>{const before=h.poses.length;h.voiceHooks.head({direction,full:true});for(let i=0;i<12;i++){h.time(h.clock()+100);h.tick();await h.flush();}const pose=h.poses.slice(before).at(-1);return [deg(pose.rotation.y),deg(pose.rotation.p)];};
  const right=await full('right');assert.ok(right[0]>40&&right[0]<=90&&right[1]===0,'«tutto a destra»: to the end of the range, stopped by the calibration');
  const up=await full('up');assert.equal(up[0],right[0]);assert.ok(up[1]<-40&&up[1]>=-85,'«tutto in alto»');
  assert.deepEqual(await full('down'),[right[0],0],'«tutto in basso»: straight, never below');
  await run('center');
  const before=h.poses.length;await run('shake');assert.equal(h.poses.length-before,4,'«muovi la testa»: the four steps of a shake');
  assert.ok(!h.balloons.some(text=>/bloccati|non posso/i.test(text)));
  for(let i=0;i<6;i++){h.time(h.clock()+100);h.tick();await h.flush();}
  h.voiceHooks.head({direction:'left'});h.voiceHooks.head({direction:'right'});
  assert.equal(h.balloons.at(-1),'Ora non posso muovere la testa.','a second command while the first still runs is refused, not queued');
  for(let i=0;i<12;i++){h.time(h.clock()+100);h.tick();await h.flush();}
  assert.deepEqual([deg(h.poses.at(-1).rotation.y),deg(h.poses.at(-1).rotation.p)],[-20,0],'only the first one moved');
  // 11 Nov 2026: «sinistra» said while Robottino nodded at its previous answer was refused.
  for(let i=0;i<6;i++){h.time(h.clock()+100);h.tick();await h.flush();}
  const said=h.balloons.length;h.voiceHooks.mood({expression:'happy',gesture:'nod'});
  for(let i=0;i<5;i++){h.time(h.clock()+100);h.tick();await h.flush();}
  h.voiceHooks.head({direction:'right'});for(let i=0;i<14;i++){h.time(h.clock()+100);h.tick();await h.flush();}
  assert.equal(h.balloons.length,said,'no «non posso»: the command takes the nod’s place');
  assert.deepEqual([deg(h.poses.at(-1).rotation.y),deg(h.poses.at(-1).rotation.p)],[20,0],'from where the head was before the nod');h.close();
});
test('spoken head commands also move the head with the iPhone connected; following a face waits 5 s and starts again (owner, 11 Nov 2026: «Sì, anche nel Live»)',async()=>{
  const talk=async h=>{const [touch]=h.touchListeners,t0=h.clock();touch({gesture:'press',intensity:3});h.time(t0+600);h.tick();h.time(t0+1100);h.tick();await h.flush();touch({gesture:'release'});for(let i=0;i<10;i++){h.time(h.clock()+100);h.tick();await h.flush();}};
  const h=await launch({withVoice:true,withLive:true,verified:true});await arm(h);await talk(h);
  const deg=value=>Math.round(value*180/Math.PI);const step=async(n=1)=>{for(let i=0;i<n;i++){h.time(h.clock()+100);h.tick();await h.flush();}};
  h.liveHooks.connected();await step(3);
  // Live without following: a reply gesture still waits, a spoken command moves.
  let before=h.poses.length;h.voiceHooks.head({direction:'right'});await step(12);
  const moved=h.poses.slice(before);assert.ok(moved.length>=1,'the head moves with the iPhone connected');const after=moved.at(-1).rotation;
  assert.ok(!h.balloons.some(text=>/non posso/i.test(text)));
  // Following a face: the command goes even while a following pose is on its way, and following waits.
  h.liveHooks.follow(true);const pose=h.liveHooks.headPose();
  assert.equal(h.liveHooks.aim({x:.25,y:.5,pose}),true);h.tick();await h.flush();
  before=h.poses.length;h.voiceHooks.head({direction:'up'});await step(12);
  const up=h.poses.slice(before).at(-1).rotation;assert.equal(deg(up.p),deg(after.p)-20,'one step up, from where the head was asked to be');
  assert.equal(h.liveHooks.aim({x:.9,y:.5,pose:h.liveHooks.headPose()}),false,'following waits after the command');
  const held=h.poses.length;await step(25);assert.equal(h.poses.length,held,'no following pose for 5 s');
  await step(15);assert.equal(h.liveHooks.aim({x:.9,y:.5,pose:h.liveHooks.headPose()}),true,'then following starts again');
  await step(5);assert.ok(h.poses.length>held,'and the head follows the face again');
  assert.ok(!h.balloons.some(text=>/non posso/i.test(text)));h.close();
});
test('«cos’è questo?» in mod.js: the picture goes from the camera to the conversation; when it cannot, the server is told (11 Nov 2026)',async()=>{
  const h=await launch({withVoice:true,withLive:true,verified:true});const [touch]=h.touchListeners,t0=h.clock();
  touch({gesture:'press',intensity:3});h.time(t0+600);h.tick();h.time(t0+1100);h.tick();await h.flush();touch({gesture:'release'});
  const sent=[];let failed=0;h.voiceFake.picture=piece=>{sent.push(piece);return true;};h.voiceFake.pictureFailed=()=>{failed++;};
  h.voiceHooks.see();await h.flush();assert.equal(failed,1,'this Live device takes no pictures: said at once');
  h.live.snapshot=async sink=>{sink('a');sink('b');return true;};h.voiceHooks.see();await h.flush();assert.deepEqual(sent,['a','b']);assert.equal(failed,1);
  h.live.snapshot=async()=>false;h.voiceHooks.see();await h.flush();assert.equal(failed,2,'camera busy or too slow');
  h.live.snapshot=async()=>{throw Error('x');};h.voiceHooks.see();await h.flush();assert.equal(failed,3);h.close();
});
test('the conversation lifts the head also when the iPhone connects just after it starts (owner, 11 Nov 2026: «a volte non alza più la testa»)',async()=>{
  const talk=async h=>{const [touch]=h.touchListeners,t0=h.clock();touch({gesture:'press',intensity:3});h.time(t0+600);h.tick();h.time(t0+1100);h.tick();await h.flush();touch({gesture:'release'});for(let i=0;i<10;i++){h.time(h.clock()+100);h.tick();await h.flush();}};
  const h=await launch({withVoice:true,withLive:true,verified:true});await arm(h);
  // The robot is busy opening the conversation's connection: the look up waits. Meanwhile the app, which follows the
  // face during a conversation, connects.
  h.connectingNow(true);const before=h.poses.length;await talk(h);assert.equal(h.voiceFake.active,true);assert.equal(h.poses.length,before,'still waiting');
  h.liveHooks.connected();h.connectingNow(false);
  for(let i=0;i<6;i++){h.time(h.clock()+100);h.tick();await h.flush();}
  const deg=value=>Math.round(value*180/Math.PI);
  assert.deepEqual(h.poses.slice(before).map(pose=>[deg(pose.rotation.y),deg(pose.rotation.p)]),[[0,-25]],'looks up at the owner all the same');h.close();
});
test('the head moving is not a touch: a long press felt while it moves, or just after, does not close the conversation (11 Nov 2026)',async()=>{
  const h=await launch({withVoice:true,verified:true});await arm(h);const send=event=>h.touchListeners.forEach(listener=>listener(event));
  let at=h.clock();const run=async ms=>{for(const end=at+ms;at<end;){at+=100;h.time(at);h.tick();await h.flush();}};
  await run(2000);
  h.headZones([3,3,3]);send({gesture:'press',intensity:3});await run(1100);h.headZones([0,0,0]);send({gesture:'release',intensity:0});await run(1500);
  assert.equal(h.voiceFake.active,true,'a real long touch starts the conversation');
  h.voiceHooks.head({direction:'up',full:true});await run(300);
  // the move is under way: the sensor reads 1 on one zone and the host calls it a press
  h.headZones([1,0,0]);send({gesture:'press',intensity:1});await run(1200);h.headZones([0,0,0]);send({gesture:'release',intensity:0});await run(500);
  assert.equal(h.voiceFake.active,true,'still talking: the movement was not a touch');
  // 11 Nov 2026, «tutto su»: the real head arrives later than reckoned; a zone reads 1 from 1.6 s after the command
  h.voiceHooks.head({direction:'center'});await run(1000);h.voiceHooks.head({direction:'up',full:true});await run(1600);
  h.headZones([0,1,0]);send({gesture:'press',intensity:1});await run(1200);h.headZones([0,0,0]);send({gesture:'release',intensity:0});await run(300);
  assert.equal(h.voiceFake.active,true,'still talking 1.6 s after a long move');
  await run(2500);
  h.headZones([3,3,3]);send({gesture:'press',intensity:3});await run(1100);h.headZones([0,0,0]);send({gesture:'release',intensity:0});await run(500);
  assert.equal(h.voiceFake.active,false,'once the head is still, a real long touch closes it');h.close();
});

test('spoken face commands change the face over the reply’s own mood: the smile for 5 s, sad and angry until told (11 Nov 2026)',async()=>{
  const h=await launch({withVoice:true,verified:true});const [touch]=h.touchListeners,t0=h.clock();
  touch({gesture:'press',intensity:3});h.time(t0+600);h.tick();h.time(t0+1100);h.tick();await h.flush();touch({gesture:'release'});
  const run=async ms=>{for(const end=h.clock()+ms;h.clock()<end;){h.time(h.clock()+100);h.tick();await h.flush();}};
  h.voiceHooks.face({expression:'sad'});assert.deepEqual(h.faceCalls.at(-1),['emotion',2]);
  h.voiceHooks.mood({expression:'neutral',gesture:null});assert.deepEqual(h.faceCalls.at(-1),['emotion',2],'the reply does not take the face away');
  await run(20000);assert.deepEqual(h.faceCalls.at(-1),['emotion',2],'sad stays until told (owner, 11 Nov 2026)');
  h.voiceHooks.mood({expression:'happy',gesture:null});assert.deepEqual(h.faceCalls.at(-1),['emotion',2]);
  h.voiceHooks.face({expression:'normal'});assert.deepEqual(h.faceCalls.at(-1),['emotion',0],'«torna normale»');
  h.voiceHooks.face({expression:'sad'});h.voiceHooks.face({expression:'happy'});assert.deepEqual(h.faceCalls.at(-1),['emotion',3],'«torna felice»: a smile');
  await run(5200);assert.deepEqual(h.faceCalls.at(-1),['emotion',0],'then serene');
  h.face.behavior.setStyle(h.face,'white');h.voiceHooks.face({expression:'happy'});assert.deepEqual(h.faceCalls.at(-1),['emotion',3],'an explicit smile, the white robot too');
  await run(5200);assert.deepEqual(h.faceCalls.at(-1),['emotion',0]);
  h.voiceHooks.face({expression:'angry'});assert.deepEqual(h.faceCalls.at(-1),['emotion',1],'angry: upstream emotion 1');
  await run(8000);assert.deepEqual(h.faceCalls.at(-1),['emotion',1],'angry stays too');
  h.voiceHooks.ended('user');assert.deepEqual(h.faceCalls.at(-1),['emotion',0],'the end of the conversation clears it');
  h.voiceHooks.mood({expression:'sad',gesture:null});assert.deepEqual(h.faceCalls.at(-1),['emotion',2],'and the reply moods work again');h.close();
});

test('the automatic start tries the torque command once more when the servos’ reply was lost, never more (11 Nov 2026)',async()=>{
  const once=await launch({verified:true,torqueLost:1});once.time(3000);once.tick();await once.flush();
  assert.equal(once.torqueCalls(),1);assert.ok(!once.balloons.includes('Motori non disponibili.'),'not given up yet');
  once.time(4900);once.tick();await once.flush();assert.equal(once.torqueCalls(),1,'2 s later');
  once.time(5000);once.tick();await once.flush();assert.equal(once.torqueCalls(),2);assert.equal(once.balloons.at(-1),'Movimenti attivi.');once.close();
  const twice=await launch({verified:true,torqueLost:5});twice.time(3000);twice.tick();await twice.flush();twice.time(5000);twice.tick();await twice.flush();
  assert.equal(twice.torqueCalls(),2);assert.equal(twice.balloons.at(-1),'Motori non disponibili.','a second loss: motors stay off');
  twice.time(9000);twice.tick();await twice.flush();assert.equal(twice.torqueCalls(),2,'no third try');twice.close();
  const offline=await launch({verified:true,torqueFails:true});offline.time(3000);offline.tick();await offline.flush();offline.time(6000);offline.tick();await offline.flush();
  assert.equal(offline.torqueCalls(),1,'another error is not retried');assert.equal(offline.balloons.at(-1),'Motori non disponibili.');offline.close();
  const manual=await launch({torqueLost:1});manual.buttons.get('robottino:motion')('event');await manual.flush();manual.time(6000);manual.tick();await manual.flush();
  assert.equal(manual.torqueCalls(),1,'a press by hand is never repeated');assert.equal(manual.balloons.at(-1),'Motori non disponibili.');manual.close();
});

test('a face asked for by voice stays until Robottino has finished the sentence it says with it (11 Nov 2026)',async()=>{
  const h=await launch({withVoice:true,verified:true});const [touch]=h.touchListeners,t0=h.clock();
  touch({gesture:'press',intensity:3});h.time(t0+600);h.tick();h.time(t0+1100);h.tick();await h.flush();touch({gesture:'release'});
  const run=async ms=>{for(const end=h.clock()+ms;h.clock()<end;){h.time(h.clock()+100);h.tick();await h.flush();}};
  h.voiceHooks.face({expression:'angry'});h.voiceFake.speaking=true;
  await run(6000);assert.deepEqual(h.faceCalls.at(-1),['emotion',1],'still talking after 5 s: still angry');
  h.voiceFake.speaking=false;await run(2000);assert.deepEqual(h.faceCalls.at(-1),['emotion',1],'the sentence is over: still angry, until told');
  h.voiceHooks.face({expression:'happy'});h.voiceFake.speaking=true;await run(6000);assert.deepEqual(h.faceCalls.at(-1),['emotion',3],'the smile lasts while it talks');
  h.voiceFake.speaking=false;await run(200);assert.deepEqual(h.faceCalls.at(-1),['emotion',0],'then back to normal');h.close();
});
