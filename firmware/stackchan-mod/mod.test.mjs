// Exercises the real MOD against a capability fake. Does not emulate hardware/Piu/BLE.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {SourceTextModule,SyntheticModule,createContext,runInContext} from 'node:vm';
import {HEAD_SPEED,MIN_MOVE} from './calibration.js';
import {CAMERA_FOV} from './tracker.js';
// The host's servo arithmetic (host/modules/motion/m5stackchan-servo.ts): rotation → servo positions and back.
const STEP=16/5/10,TENTH=1800/Math.PI;
const hostRaw=rotation=>({yaw:460+Math.trunc(Math.trunc(rotation.y*TENTH)*STEP),pitch:620+Math.trunc(Math.trunc(-rotation.p*TENTH)*STEP)});
// Where the head went, back in the MOD's terms (radians from the host centres), within one servo step (0.1°).
// The MOD's own rotation back from what reached the host (the K151 yaw servo is reversed: calibration.js YAW_SERVO).
const logical=rotation=>{const raw=hostRaw(rotation);return {y:-(raw.yaw-460)/(TENTH*STEP)||0,p:-(raw.pitch-620)/(TENTH*STEP)||0,r:0};};
// Where the head goes when the motors start (mod.js START_PITCH): straight, 20° up.
const START_PITCH=-20*Math.PI/180;
// A measured head for the tests: the host centres, pitch never below straight ahead.
const HEAD_CAL=JSON.stringify({v:2,yaw:{center:460,lo:51,hi:869,sign:1},pitch:{center:620,lo:620,hi:892,sign:1}});
async function launch({withCredential=true,withPairing=false,withVoice=false,torqueFails=false,delayOpen=false,withTouchPanel=true,delayTorque=false,poseMode='normal',partialSubscribeFailure=false,withLive=false,verified=false,withLights=false,headCal,refuse,torqueLost=0,bleTracking=true,k210,imu,ears,card,trace,wake=false,power,button,saved,amp,ble,rover,pir,device}={}){
  let now=1000,wall; // ticks (Time.ticks) and, separately, the time of day from the network (Date.now)
  class Clock extends Date { static now(){return wall??now;} }
  const screen={_rotation:0,rotationWrites:0,commands:[],get rotation(){return this._rotation;},set rotation(v){this._rotation=v;this.rotationWrites++;},command(id,data){this.commands.push([id,[...data]]);}};
  const context=createContext({console,Date:Clock,Math,Number,Map,Set,Uint8Array,screen,...(trace?{trace}:{}),...(power?{power}:{}),...(button?{button}:{}),...(amp?{amp}:{}),...(device?{device}:{})});
  // The host's text coding, which the log on the card needs (XS has it, Node does not).
  if(card)runInContext("ArrayBuffer.fromString=text=>{const bytes=new Uint8Array(text.length);for(let i=0;i<text.length;i++)bytes[i]=text.charCodeAt(i)&255;return bytes.buffer;};String.fromArrayBuffer=buffer=>{let text='';for(const code of new Uint8Array(buffer))text+=String.fromCharCode(code);return text;};",context);
  const buttons=new Map(),listeners=new Map(),poses=[],removed=[],touchListeners=new Set(),touches=[],styles=[],preferences=[],titles=[],sensitivity=[],references=[];let headZones=[0,0,0];
  let voiceHooks,voiceStarts=0;const voiceFake={active:false,speaking:false,phase:'idle',interrupts:0,interrupt(){this.interrupts++;this.speaking=false;return true;},async start(){voiceStarts++;this.active=true;return true;},stop(){this.active=false;voiceHooks?.ended('user');}};
  let pairingHooks,pairingStarts=0,hellos=0,liveHooks,liveFake,faceStyle="portrait",faceCalls=[],timerId=0,holdShort=false,liveConnects=0,liveOpens=0,liveBusy=false,netBusy=false;const timeouts=new Map();
  let tick,stopped=false,sessionClosed=false,faceStopped=false,openNow,dancing=false,finishTorque,finishPose,torqueCalls=0,confirmPose;
  const face={behavior:{setWake(_face,step){faceCalls.push(['wake',step]);},setHand(_face,name){faceCalls.push(['hand',name]);return true;},getStyle(){return faceStyle;},setStyle(_face,value){faceStyle=value;styles.push(value);},setTarget(){},setDanceActive(value){dancing=value;},reactToTouch(source,event){touches.push({source,event});return true;},showPanel(_face,panel){panels.push(panel);this.panel=panel;},hidePanel(){panels.push(null);this.panel=undefined;},setPanelTitle(_face,title){titles.push(title);},get panelOpen(){return panels.length>0&&panels.at(-1)!==null;}},stop(){faceStopped=true;}};
  const panels=[];
  // The host's serial port (the K210 camera's line): what was opened, and bytes fed by the test.
  const serials=[];class SerialFake{constructor(options){this.options=options;this.queue=[];this.channels=options.channels;this.sampleRate=options.sampleRate;this.bitsPerSample=options.bitsPerSample;serials.push(this);}read(buffer){if(!this.queue.length)return undefined;if(buffer===undefined)return new Uint8Array(this.queue.splice(0)).buffer;const out=new Uint8Array(buffer),n=Math.min(out.length,this.queue.length);out.set(this.queue.splice(0,n));return n;}feed(bytes){this.queue.push(...bytes);this.options.onReadable.call(this,bytes.length);}start(){this.started=true;}close(){this.closed=true;}}
  const session={subscribe(type,cb){if(partialSubscribeFailure&&type==='tracking.update')throw Error('subscribe failed');listeners.set(type,cb);return()=>listeners.delete(type);},close(){sessionClosed=true;}};
  const balloons=[];
  // The servos as the host reads them: positions 0…1000, answered (or not) at each reading.
  const headPose={body:{rotation:{y:0,p:0,r:0}}},torqueArgs=[];let servo={yaw:460,pitch:620},servoAnswers=true,lookAts=0,lookAways=0,lostReplies=0;
  // The host application's behaviour, where the ☰ button bubbles `onDrawerToggle`.
  class HostController{constructor(){this.hostToggles=0;}onDrawerToggle(){this.hostToggles++;}}
  const controller=new HostController();let drawerOpens=0,drawerCloses=0;
  const robot={ui:{application:{behavior:controller},openDrawer(){drawerOpens++;},closeDrawer(){drawerCloses++;},setFace(){},showBalloon(text){balloons.push(text);},drawer:{addDrawerButton(b){buttons.set(b.key,b.callback);},removeDrawerButton(k){removed.push(k);buttons.delete(k);}}},
    input:{...(imu?{imu}:{}),...(withTouchPanel?{touchPanel:{get sample(){return headZones;},configure(options){if('sensitivityLevel' in options)sensitivity.push(options.sensitivityLevel);if('referenceReset' in options)references.push(options.referenceReset);},subscribe(callback){touchListeners.add(callback);return()=>touchListeners.delete(callback);}}}:{})},
    audio:{volume:.5,playAudio(buffer){touches.push({audio:buffer.name});return Promise.resolve(true);}},
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
  cache.set('modules',fake({default:{has:name=>name==='embedded:io/i2c'?!!rover:name==='embedded:io/digital'?!!pir:name==='bleclient'||name==='btutils'?!!ble:name==='robottino-voice-device'?withVoice:name==='robottino-pairing-device'?withPairing:withLive,importNow:name=>name==='embedded:io/i2c'&&rover?{default:rover}:name==='embedded:io/digital'&&pir?{default:pir}:name==='bleclient'&&ble?{default:ble}:name==='btutils'&&ble?{uuid:strings=>strings[0]}:({default:SerialFake,...(card?{withSDCard:card.withCard}:{}),...(ears?{soundSide:()=>ears.value}:{}),connecting:()=>netBusy,createVoiceDevice:(_robot,hooks)=>{voiceHooks=hooks;return voiceFake;},createLiveDevice:(_robot,hooks)=>{liveHooks=hooks;liveConnects++;return liveFake={busy:()=>liveBusy,connect:async()=>{liveOpens++;},close(){hooks.disconnected();},hello(){hellos++;}};},createPairing:(_robot,hooks)=>{const fakePairing={active:false,code:undefined,async start(){pairingStarts++;this.active=true;return true;},stop(){this.active=false;}};const shown=hooks.code;pairingHooks={...hooks,code(c){fakePairing.code=c;shown(c);}};return fakePairing;}})}}));
  const stored=new Map([...(k210===undefined?[]:[['k210',k210]]),...(saved??[])]),credential=withCredential?'test-device-credential-0123456789abcdef':undefined;
  cache.set('preference',fake({default:{get:(_domain,key)=>stored.has(key)?stored.get(key):key==='k210'||key==='lego'||key==='rover'||key==='motionsOff'||key==='volume'||key==='roverFollow'||key==='gazeCall'||key==='nfc'?undefined:key==='wakeUp'?wake:key==='bleTracking'?bleTracking:key==='deviceToken'?credential:key==='headCal'?(headCal===undefined?(verified?HEAD_CAL:undefined):headCal??undefined):verified,set:(_domain,key,value)=>{stored.set(key,value);preferences.push([key,value]);}}}));
  // Timers of 20 ms run at once; so do those of 310 ms (the head sensor's reference reset).
  cache.set('timer',fake({default:{repeat(cb){tick=cb;return 0;},set(cb,ms){const id=++timerId;timeouts.set(id,{cb,ms});if((ms===20&&!holdShort)||ms===310)void Promise.resolve().then(()=>{if(timeouts.delete(id))cb();});return id;},clear(id){if(id===0)stopped=true;else{assert.ok(timeouts.has(id));timeouts.delete(id);}}}}));
  const timeFake={get ticks(){return now;},delta(a,b){return (b-a)|0;}};cache.set('time',fake({default:timeFake}));
  cache.set('robottino-face',fake({createExpressiveFace:()=>face}));
  const filenames={'robottino-wake-up':'wake-up.js','robottino-clock':'clock.js','robottino-tracker':'tracker.js','robottino-dance':'dance.js','mediapipe-tracking-message':'vendor/tracking-message.js','robottino-voice-wire':'voice-wire.js','robottino-live-wire':'live-wire.js','robottino-reminders':'reminders.js','robottino-lego-wire':'lego-wire.js','robottino-rover-wire':'rover-wire.js','robottino-rover-body':'rover-body.js','robottino-rover-follow':'rover-follow.js','robottino-tof-wire':'tof-wire.js','robottino-force':'force.js','robottino-force-follow':'force-follow.js','robottino-explore':'explore.js','robottino-gaze':'gaze.js','robottino-nfc':'nfc.js','robottino-climate-wire':'climate-wire.js','robottino-presence':'presence.js','robottino-wifi-switch':'wifi-switch.js','robottino-portrait-state':'portrait-state.js','robottino-lights':'lights.js','robottino-k210':'k210.js','robottino-motion-sense':'motion-sense.js','robottino-sound-ear':'sound-ear.js','robottino-sd-log':'sd-log.js','robottino-phrase-mouths':'phrase-mouths.js','robottino-calibration':'calibration.js'};
  const module=new SourceTextModule(await readFile(new URL('./mod.js',import.meta.url),'utf8'),{context});
  await module.link(async name=>{
    if(!cache.has(name))cache.set(name,new SourceTextModule(await readFile(new URL(filenames[name],import.meta.url),'utf8'),{context}));
    return cache.get(name);
  });await module.evaluate();module.namespace.onContextCreated(robot);
  const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};await flush();
  return{serials,get liveFake(){return liveFake;},context,stored,titles,sensitivity,references,headZones(value){headZones=value;},connectingNow(value){netBusy=value;},cameraSwitching(value){liveBusy=value;},clock:()=>now,loseReplies(n){lostReplies=n;},holdShortTimers(value){holdShort=value;},wallTime:value=>{wall=value;},timeFake,lightCalls,torqueArgs,moveHead(raw){servo=raw;},servoAnswers(value){servoAnswers=value;},lookAts:()=>lookAts,lookAways:()=>lookAways,headPose,controller,drawerOpens:()=>drawerOpens,drawerCloses:()=>drawerCloses,get pairingHooks(){return pairingHooks;},pairingStarts:()=>pairingStarts,hellos:()=>hellos,stored,face,robot,faceCalls,voiceFake,get voiceHooks(){return voiceHooks;},balloons,voiceStarts:()=>voiceStarts,get liveHooks(){return liveHooks;},get live(){return liveFake;},timeouts,liveConnects:()=>liveConnects,liveOpens:()=>liveOpens,styles,preferences,buttons,listeners,poses,removed,touchListeners,touches,flush,time:value=>{now=value;},finishTorque:()=>finishTorque?.(),finishPose:()=>finishPose?.(),confirmPose:()=>confirmPose?.(),torqueCalls:()=>torqueCalls,dancing:()=>dancing,tick:()=>tick(),screen,panels,open:()=>openNow(),close:()=>module.namespace.onUnload(),status:()=>({stopped,sessionClosed,faceStopped})};
}
// Motors on from the menu. With the head calibrated the robot first turns it straight ahead (9 Nov 2026): that
// move is checked here and left out, so each test counts only its own motions.
async function arm(h){
  const before=h.poses.length;h.buttons.get('robottino:motion')();await h.flush();
  const centre=h.poses.splice(before);
  // Straight, 20° up (owner, 14 Nov 2026: «fallo partire da una posizione circa 20 gradi in su»).
  for(const pose of centre)assert.ok(Math.abs(pose.rotation.y)<.01&&Math.abs(pose.rotation.p-START_PITCH)<.01,'straight, 20° up');
  return centre.length;
}
test('Bluetooth stays off unless face positions over Bluetooth are switched on on the robot (14 Nov 2026)',async()=>{
  // Until now the session was opened at every start: Bluetooth on for good next to the Wi-Fi, for nothing in use.
  const off=await launch({bleTracking:null});/* never set on the robot */assert.equal(off.listeners.size,0,'no session, no subscriptions');assert.equal(off.balloons.some(text=>/Inseguimento|BLE/.test(text)),false,'and no word about it: '+off.balloons.join(' | '));off.close();
  const never=await launch({bleTracking:false});assert.equal(never.listeners.size,0);never.close();
  const on=await launch({bleTracking:true});assert.ok(on.listeners.has('target.update'));assert.ok(on.listeners.has('tracking.update'));on.close();
});

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
test('the Live connection waits for the motors to start (23 Nov 2026, 19:21: it held the robot 2.2 s, the first move was not confirmed and the motions were blocked)',async()=>{
  const fire=x=>{for(const [id,timer] of [...x.timeouts])if(timer.ms===250){x.timeouts.delete(id);timer.cb();}};
  const lines=[],h=await launch({withLive:true,verified:true,delayTorque:true,trace:x=>lines.push(x)});await h.flush();const before=h.liveOpens();
  h.buttons.get('robottino:motion')();await h.flush();
  h.buttons.get('robottino:live')();await h.flush();
  for(let t=0;t<1000;t+=250){h.time(h.clock()+250);h.tick();fire(h);await h.flush();}
  assert.equal(h.liveOpens(),before,'motors starting: the connection waits');
  h.finishTorque();await h.flush();
  for(let t=0;t<3000&&h.liveOpens()===before;t+=250){h.time(h.clock()+250);h.tick();fire(h);await h.flush();h.confirmPose?.();h.finishPose?.();await h.flush();}
  assert.equal(h.liveOpens(),before+1,'motors on and the head straight: it connects');assert.ok(lines.some(x=>/live waited \d+ ms for the motors/.test(x)),'said on the log');
  // Motors that never start do not keep it out for ever.
  const late=await launch({withLive:true,verified:true,delayTorque:true});await late.flush();const first=late.liveOpens();
  late.buttons.get('robottino:motion')();await late.flush();late.buttons.get('robottino:live')();await late.flush();
  for(let t=0;t<9000;t+=250){late.time(late.clock()+250);late.tick();fire(late);await late.flush();}
  assert.equal(late.liveOpens(),first+1,'after 8 s it connects all the same');late.close();
  h.close();
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
  assert.ok(Math.abs(h.poses[1].duration-Math.max(MIN_MOVE,Math.hypot(b.y-a.y,b.p-a.p)/HEAD_SPEED))<.02,'the one head speed, from where the head is: '+h.poses[1].duration);
  h.liveHooks.disconnected();await assert.rejects(()=>h.liveHooks.motion({yaw:1,pitch:1}),/motion_unavailable/);h.close();
});

test('carezza muove solo dopo calibrazione e attivazione, poi ripristina la posa',async()=>{
  const h=await launch({verified:true});for(const cb of h.touchListeners)cb({gesture:'forwardSwipe',intensity:3});await h.flush();assert.equal(h.poses.length,0);
  await arm(h);for(const cb of h.touchListeners)cb({gesture:'forwardSwipe',intensity:3});await h.flush();assert.equal(h.poses.length,1);assert.ok(h.poses[0].rotation.p<0,"the K151 head lifts toward the hand: it cannot dip below straight ahead");
  h.time(4000);h.tick();await h.flush();assert.equal(h.poses.length,2);assert.ok(Math.abs(h.poses[1].rotation.p-START_PITCH)<1e-9,'back where it was');h.close();
});
test('carezza non muove con hardware non verificato e stop impedisce il ritorno',async()=>{
  const h=await launch();h.buttons.get('robottino:motion')();await h.flush();for(const cb of h.touchListeners)cb({gesture:'forwardSwipe',intensity:3});await h.flush();assert.equal(h.poses.length,0);h.close();
  const v=await launch({verified:true});await arm(v);for(const cb of v.touchListeners)cb({gesture:'forwardSwipe',intensity:3});await v.flush();v.buttons.get('robottino:motion')();v.time(4100);v.tick();await v.flush();
  // Off from the menu: no return of the caress, only the move back to the start pose (15 Nov 2026), straight and 20° up.
  assert.equal(v.poses.length,2);assert.ok(Math.abs(v.poses[1].rotation.y)<.01&&Math.abs(v.poses[1].rotation.p-START_PITCH)<.01,'the start pose');v.close();
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

test('waking up: black screen, the face fades in with closed eyes, opens its eyes without a yawn (15 Nov 2026), says hello; the Live link waits for it',async()=>{
  const lights=[];const power={_value:80,get brightness(){return this._value;},set brightness(value){this._value=value;lights.push(value);}};
  const h=await launch({withLive:true,wake:true,power});
  const wakes=()=>h.faceCalls.filter(([name])=>name==='wake').map(([,step])=>step);
  const sounds=()=>h.touches.filter(item=>item.audio).map(item=>item.audio);
  assert.deepEqual(lights,[0],'dark at once');assert.deepEqual(wakes(),[0],'eyes closed');assert.equal(h.liveConnects(),0,'the link waits');
  const run=async(from,to)=>{for(let t=from;t<=to;t+=50){h.time(t);h.tick();await h.flush();}};
  const start=h.clock();
  await run(start+50,start+1500);
  assert.ok(lights.length>4&&lights.at(-1)===80,'the light comes up to what it was: '+lights.join(','));assert.ok(lights.every((v,i)=>!i||v>=lights[i-1]),'never down on the way');
  assert.deepEqual(sounds(),[]);await run(start+1550,start+1750);assert.deepEqual(sounds(),[],'no yawn');
  for(let t=start+1800;t<=start+12000;t+=50){
    h.time(t);h.tick();for(const [id,timer] of [...h.timeouts])if(timer.ms===50){h.timeouts.delete(id);timer.cb();}await h.flush();
  }
  assert.equal(wakes()[0],0);assert.ok(wakes().includes(1)&&wakes().includes(3),'the eyes open step by step: '+wakes().join(','));
  assert.deepEqual(sounds(),['ciao-eccomi.bin'],'only «Ciao, eccomi!»');
  assert.equal(wakes().at(-1),undefined,'the face as always');assert.equal(h.liveConnects(),1,'and now the link');
  assert.equal(power._value,80);
});
test('waking up ends at once, with the screen lit, when something needs the robot; never more than 15 s',async()=>{
  const power={_value:60,get brightness(){return this._value;},set brightness(value){this._value=value;}};
  const h=await launch({withLive:true,wake:true,power});assert.equal(power._value,0);
  h.buttons.get('robottino:menu')?.();await h.flush();
  if(h.buttons.get('robottino:menu')){assert.equal(power._value,60,'lit again');assert.equal(h.liveConnects(),1);}
  const slow=await launch({withLive:true,wake:true,power:{_value:50,get brightness(){return this._value;},set brightness(value){this._value=value;}}});
  const at=slow.clock();slow.robot.audio.playAudio=()=>new Promise(()=>{});
  for(let t=at;t<=at+15100;t+=100){slow.time(t);slow.tick();await slow.flush();}
  assert.equal(slow.liveConnects(),1,'never later than 15 s');
  const off=await launch({withLive:true});assert.equal(off.liveConnects(),1,'switched off: the link opens at once');
  const closed=await launch({withLive:true,wake:true});closed.close();await closed.flush();assert.equal(closed.liveConnects(),0);
});
test('the power button: the host keeps its own handler, and the head goes straight, 20° up, and stays there (14 Nov 2026)',async()=>{
  // As the host gives it: a 1 → 0 pulse for each press (setup-target.js), its own handler already there (mod manager).
  const hostCalls=[];const power={value:0,read(){return this.value;},write(value){if(this.value===value)return;this.value=value;this.onChanged?.();},onChanged(){hostCalls.push(this.read());}};
  const h=await launch({withVoice:true,verified:true,button:{power}});await arm(h);
  const cycle=async ms=>{for(let t=0;t<ms;t+=100){h.time(h.clock()+100);h.tick();await h.flush();}};
  // The head somewhere else first: in a conversation, «guarda a destra» twice (40° to a side, 25° up).
  const [touch]=h.touchListeners,t0=h.clock();touch({gesture:'press',intensity:3});h.time(t0+600);h.tick();h.time(t0+1100);h.tick();await h.flush();touch({gesture:'release'});await cycle(1000);
  h.voiceHooks.head({direction:'right'});await cycle(1200);h.voiceHooks.head({direction:'right'});await cycle(1200);
  const before=h.poses.length;assert.ok(Math.abs(h.poses.at(-1).rotation.y)>.6,'40° to a side');
  power.write(1);power.write(0);assert.deepEqual(hostCalls,[1,0],'the host\'s handler still runs');
  await cycle(600);const last=h.poses.at(-1).rotation;
  assert.ok(Math.abs(last.y)<1e-6&&Math.abs(last.p-START_PITCH)<.01,`straight, 20° up: ${last.y} ${last.p}`);
  // Meanwhile nothing moves it away: no caress, no return of the caress.
  const count=h.poses.length;pet(h);await cycle(3000);assert.equal(h.poses.length,count,'held there');
  // Still on after a short press: free again after a while.
  await cycle(4000);pet(h);await cycle(300);assert.ok(h.poses.length>count,'free again');
  // Closing gives the button back to the host's handler.
  h.close();assert.equal(power.onChanged.name,'onChanged');power.write(1);assert.deepEqual(hostCalls.slice(-1),[1]);
});
test('the power button: following a face does not turn the head back to it before the power goes (code review, 19 Nov 2026)',async()=>{
  const power={value:0,read(){return this.value;},write(value){if(this.value===value)return;this.value=value;this.onChanged?.();},onChanged(){}};
  const h=await launch({withLive:true,verified:true,button:{power}});h.liveHooks.connected();await arm(h);h.liveHooks.follow(true);
  h.time(20000);assert.equal(h.liveHooks.aim({x:.25,y:.5,pose:h.liveHooks.headPose()}),true,'following before the press');
  power.write(1);power.write(0);
  assert.equal(h.liveHooks.aim({x:.25,y:.5,pose:h.liveHooks.headPose()}),false,'no new target while the power goes');
  h.close();
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

test('the camera of following alone waits a third of a second from the servos\' confirmation, the time measured on the robot (14 Nov 2026)',async()=>{
  // Measured with the camera itself: the bulk of a head move ends 231 ms after the confirmation (median; 335 ms for 95 in 100).
  const h=await launch({withLive:true,verified:true});h.liveHooks.connected();await arm(h);h.liveHooks.follow(true);
  h.time(20000);assert.equal(h.liveHooks.headSettled(),true,'long after the last move');
  assert.equal(h.liveHooks.aim({x:.25,y:.5,pose:h.liveHooks.headPose()}),true);h.tick();await h.flush();const sent=h.poses.length;assert.ok(sent>=1);
  // The servos of this test confirm at once (at 20000).
  assert.equal(h.liveHooks.headSettled(),false,'the command has just been confirmed: the head is on its way');
  h.time(20329);assert.equal(h.liveHooks.headSettled(),false,'still moving 329 ms after the confirmation');
  assert.equal(h.liveHooks.headMoving(),false,'the wait reckoned before was over by now (100 ms of move and 150 to settle)');
  h.time(20330);assert.equal(h.liveHooks.headSettled(),true,'330 ms after the confirmation the picture is still');
  h.close();
});
test.skip('SWITCHED OFF (FOLLOW_GENTLE false, 14 Nov 2026 11:45: with the wait measured the owner said «mi sembra peggiorato rispetto a prima») — following alone the head moves gently, and the camera waits until such a move is over: 230 ms after the time asked, as measured (14 Nov 2026)',async()=>{
  // Owner: «è possibile rendere i movimenti un pochino più fluidi?». Measured on the robot with the camera (239 moves):
  // asked in 0.22 s a move is over, 95 times in 100, 405-435 ms after the servos confirm it; looked at after 330 ms,
  // as the first time, it was still moving one time in four («non funziona»).
  const h=await launch({withLive:true,verified:true});await arm(h);
  Object.defineProperty(h.liveFake,'selfActive',{get:()=>true,configurable:true});Object.defineProperty(h.liveFake,'selfAloneMs',{get:()=>0,configurable:true});
  h.time(20000);h.tick();await h.flush();const before=h.poses.length;
  assert.equal(h.liveHooks.look({y:.15,p:0}),true);h.time(20100);h.tick();await h.flush();
  assert.equal(h.poses.length,before+1);assert.equal(h.poses.at(-1).duration,.22,'a small move: asked in 0.22 s, not in the tenth of a second of the one head speed');
  // The servos of this test confirm at once (at 20100).
  h.time(20100+330);assert.equal(h.liveHooks.headSettled(),false,'the third of a second of a sharp move is not enough');
  h.time(20100+449);assert.equal(h.liveHooks.headSettled(),false);
  h.time(20100+450);assert.equal(h.liveHooks.headSettled(),true,'0.22 s asked and 230 ms more: the picture is still');
  // A wide one (a stop of the look around): no faster than 2.5 rad/s.
  h.tick();await h.flush();const wide=h.poses.length;
  assert.equal(h.liveHooks.look({y:.15+.55,p:0}),true);h.time(20700);h.tick();await h.flush();
  assert.equal(h.poses.length,wide+1);assert.ok(Math.abs(h.poses.at(-1).duration-.55/2.5)<.005,'0.55 rad at 2.5 rad/s: '+h.poses.at(-1).duration);
  h.close();
});
test('nobody in sight for 30 s: the robot stops and closes its eyes; the first face, or a conversation, wakes it (14 Nov 2026)',async()=>{
  // Owner: «se per 30 secondi non vede nessuno, deve fermarsi e chiudere gli occhi».
  const h=await launch({withLive:true,withVoice:true,verified:true});await arm(h);
  let alone=0;Object.defineProperty(h.liveFake,'selfActive',{get:()=>true,configurable:true});Object.defineProperty(h.liveFake,'selfAloneMs',{get:()=>alone,configurable:true});
  const eyes=()=>h.faceCalls.filter(([n])=>n==='eye').map(([,side,value])=>side+value);
  h.time(30000);h.tick();await h.flush();const before=eyes().length;
  assert.equal(h.liveHooks.look({y:.1,p:-.3}),true,'awake: it looks around');
  alone=29900;h.time(30100);h.tick();await h.flush();assert.equal(eyes().length,before,'not yet 30 s');
  alone=30000;h.time(30200);h.tick();await h.flush();assert.deepEqual(eyes().slice(before),['left0','right0'],'30 s with nobody: the eyes close');
  assert.equal(h.liveHooks.look({y:.2,p:-.3}),false,'and the head stays where it is: no more looking around');
  h.time(31000);h.tick();await h.flush();assert.equal(eyes().length,before+2,'said once');
  alone=100;h.time(31100);h.tick();await h.flush();assert.deepEqual(eyes().slice(before+2),['left1','right1'],'a face: the eyes open');
  assert.equal(h.liveHooks.look({y:.1,p:-.3}),true);
  h.close();
});
test('«Segui il mio viso»: with the iPhone connected the head turns toward the face found in the robot camera',async()=>{
  const h=await launch({withLive:true,verified:true});h.liveHooks.connected();
  assert.throws(()=>h.liveHooks.follow(true),/motion_unavailable/,'needs the motions switched on locally');
  await arm(h);h.liveHooks.follow(true);
  const pose=h.liveHooks.headPose();assert.deepEqual({...pose},{y:0,p:START_PITCH});
  assert.equal(h.liveHooks.aim({x:.25,y:.5,pose}),true,'a face on the left of the frame');
  h.tick();await h.flush();assert.equal(h.poses.length,1);const first=h.poses[0].rotation;
  assert.ok(Math.abs(first.y-.25*CAMERA_FOV.x*.8)<.005,'turns to its left, all the way to the aim in one tick at 3 rad/s (the one head speed, servo steps): '+first.y);assert.ok(Math.abs(first.p-START_PITCH)<1e-9);
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
test('no «Mi collego…» when a conversation starts (14 Nov 2026), and no «Ti ascolto» covers the face',async()=>{
  const h=await launch({withVoice:true,verified:true}),shown=[];let hidden=0;
  h.face.behavior.showMessage=(_face,text,options)=>shown.push([text,options]);h.face.behavior.hideMessage=()=>hidden++;
  h.face.behavior.onLongTouch();await h.flush();assert.ok(!shown.some(([text])=>/Mi collego/.test(text)),'nothing written');
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

test('a happy reply does not put on the smiling face; angry and sad replies still show theirs (16 Nov 2026)',async()=>{
  // Owner: «è troppo sorridente, ogni volta che parla mi sorride».
  const h=await launch({withVoice:true,verified:true});const [touch]=h.touchListeners;
  touch({gesture:'press',intensity:3});h.time(2000);h.tick();await h.flush();
  for(const style of ['portrait','redhead','white','curly']){
    h.face.behavior.setStyle(h.face,style);
    h.voiceHooks.mood({expression:'happy',gesture:null});assert.deepEqual(h.faceCalls.at(-1),['emotion',0],style);
    h.voiceHooks.mood({expression:'sad',gesture:null});assert.deepEqual(h.faceCalls.at(-1),['emotion',2],style);
    h.voiceHooks.mood({expression:'angry',gesture:null});assert.deepEqual(h.faceCalls.at(-1),['emotion',1],style);
  }
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
  assert.deepEqual([...menu.items].map(i=>i.label),['Parla','Menu host','Hardware: no','Calibrazione: no','K210: no','Live iPhone','Abbina app','Movimenti: no','Chiudi']);
  const item=label=>h.panels.at(-1).items.find(i=>i.label===label);
  item('Hardware: no').action();const question=h.panels.at(-1);
  assert.match(question.title,/modello, firmware e collegamenti/);assert.deepEqual([...question.items].map(i=>i.label),['Sì, confermo','Annulla']);
  assert.equal(h.stored.get('verified'),undefined,'the question alone changes nothing');
  question.items[1].action();assert.equal(h.panels.at(-1).title,'Menu di Robottino','Annulla goes back');assert.equal(h.stored.get('verified'),undefined);
  item('Hardware: no').action();h.panels.at(-1).items[0].action();
  assert.equal(h.stored.get('verified'),true);assert.equal(h.panels.at(-1),null,'menu closes');assert.equal(h.balloons.at(-1),'Hardware verificato: attivato.');
  // Once on, «Hardware» is not in the big menu any more (15 Nov 2026); the host drawer still turns it off.
  h.buttons.get('robottino:menu')();assert.equal(item('Hardware: sì'),undefined,'not shown once on');
  h.buttons.get('robottino:verified')();assert.equal(h.stored.get('verified'),false,'turning off needs no question');assert.match(h.balloons.at(-1),/disattivato/);
  h.buttons.get('robottino:menu')();assert.ok(item('Hardware: no'),'back in the menu while off');
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
  // The app connected changes nothing (15 Nov 2026: the robot stays on its own); purple once the iPhone takes the head.
  h.liveHooks.connected();h.tick();assert.equal(h.lightCalls.length,0,'the iPhone is only connected: still off');
  await h.liveHooks.motion({yaw:10,pitch:-5}).catch(()=>{});h.tick();assert.deepEqual(last(),['on','head',38,0,64],'purple: the iPhone drives the head');
  h.face.behavior.onLongTouch();await h.flush(); // a long touch starts the conversation
  h.voiceFake.phase='connecting';h.tick();assert.deepEqual(last(),['blink','head',64,64,64,1200]);
  h.voiceFake.phase='listening';h.tick();assert.deepEqual(last(),['on','head',0,64,10],'green: listening');
  h.voiceFake.phase='thinking';h.tick();assert.deepEqual(last(),['blink','head',64,64,64,1200],'white slow blink: thinking');
  h.voiceFake.phase='speaking';h.tick();assert.deepEqual(last(),['on','head',0,13,64],'blue: speaking');
  h.voiceFake.phase='searching';h.tick();assert.deepEqual(last(),['on','head',64,43,0],'yellow: searching the web');
  h.voiceFake.phase='looking';h.tick();assert.deepEqual(last(),['on','head',0,55,55],'turquoise: looking');
  h.voiceFake.phase='idle';h.tick();assert.deepEqual(last(),['on','head',38,0,64]);
  const writes=h.lightCalls.length;h.tick();h.tick();assert.equal(h.lightCalls.length,writes,'no I2C traffic without a change');
  h.liveHooks.reaction('attention');h.tick();assert.deepEqual(last(),['blink','head',64,8,30,1000],'pink: needs you');
  h.time(h.clock()+5000);h.tick();assert.deepEqual(last(),['blink','head',64,8,30,1000],'still lit five seconds later');
  for(const cb of h.touchListeners)cb({gesture:'press',intensity:3});h.tick();assert.deepEqual(last(),['on','head',38,0,64],'a touch on the head puts it out');
  h.voiceHooks.ended('network');const failedAt=h.clock();h.tick();assert.deepEqual(last(),['blink','head',64,0,0,600],'red: network error');
  h.time(failedAt+1799);h.tick();assert.deepEqual(last(),['blink','head',64,0,0,600]);
  h.time(failedAt+1800);h.tick();assert.deepEqual(last(),['on','head',38,0,64],'three blinks, then the light of the state');
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
  const live=await launch({verified:true,headCal:null,withLive:true});live.liveHooks.connected();await live.liveHooks.motion({yaw:10,pitch:-5}).catch(()=>{});live.buttons.get('robottino:calibrated')();assert.match(live.balloons.at(-1),/iPhone sta comandando/,'not while the iPhone drives the head');live.close();
  const linked=await launch({verified:true,headCal:null,withLive:true});linked.liveHooks.connected();linked.buttons.get('robottino:calibrated')();assert.doesNotMatch(String(linked.balloons.at(-1)),/iPhone/,'the app only connected: the calibration opens');linked.close();
});
test('motions turn on by themselves at start once hardware and head calibration are confirmed',async()=>{
  const h=await launch({verified:true});h.time(2900);h.tick();await h.flush();assert.equal(h.torqueCalls(),0);
  h.time(3000);h.tick();await h.flush();assert.deepEqual(h.torqueArgs,[true]);assert.ok(!h.balloons.includes('Movimenti attivi.'),'nothing written at the start (owner, 14 Nov 2026)');h.close();
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
  const across=Math.hypot(Math.PI,85*Math.PI/180)/HEAD_SPEED;assert.ok(Math.abs(h.poses.at(-1).duration-across)<.03,'the one head speed: '+h.poses.at(-1).duration);
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
  const [centre]=h.poses;assert.ok(Math.abs(centre.rotation.y)<.003&&Math.abs(centre.rotation.p-START_PITCH)<.003,'straight, 20° up');
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
    assert.equal(h.voiceStarts(),0,'the audio does not change meanwhile');assert.ok(!h.balloons.some(text=>/Mi collego/.test(text)));
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

test('«Movimenti» switch from the iPhone (15 Nov 2026): off stops and holds after a restart, on switches them on again',async()=>{
  const h=await launch({verified:true,withLive:true});h.time(3000);h.tick();await h.flush();assert.equal(h.torqueCalls(),1,'on at start');
  h.liveHooks.connected();
  h.time(4000);await h.liveHooks.motion({yaw:40,pitch:-10});const before=h.poses.length;
  assert.equal(h.liveHooks.motions(false),true);assert.equal(h.balloons.at(-1),'Movimenti disattivati.');await h.flush();
  const park=h.poses.slice(before);assert.equal(park.length,1,'one move back');
  assert.ok(Math.abs(park[0].rotation.y)<.01&&Math.abs(park[0].rotation.p-START_PITCH)<.01,'straight ahead, 20° up');
  assert.deepEqual(h.preferences.filter(([key])=>key==='motionsOff').at(-1),['motionsOff',true]);
  assert.equal(h.liveHooks.motions(true),true);await h.flush();assert.equal(h.torqueCalls(),2);assert.equal(h.balloons.at(-1),'Movimenti attivi.');
  assert.deepEqual(h.preferences.filter(([key])=>key==='motionsOff').at(-1),['motionsOff',false]);h.close();
  const off=await launch({verified:true,saved:[['motionsOff',true]]});off.time(3000);off.tick();await off.flush();off.time(9000);off.tick();await off.flush();
  assert.equal(off.torqueCalls(),0,'switched off from the iPhone: no automatic start');
  off.buttons.get('robottino:motion')();await off.flush();assert.equal(off.torqueCalls(),1,'the menu still switches them on');
  assert.deepEqual(off.preferences.filter(([key])=>key==='motionsOff').at(-1),['motionsOff',false],'and the «off» no longer holds');off.close();
  const bare=await launch({withLive:true});bare.liveHooks.connected();assert.equal(bare.liveHooks.motions(true),false,'not calibrated: cannot switch on');bare.close();
  const unchecked=await launch({verified:true,withLive:true,saved:[['calibrated',false],['motionsOff',true]]});unchecked.liveHooks.connected();
  assert.equal(unchecked.liveHooks.motions(true),false,'«Calibrazione fatta» off in the menu: never switched on from the iPhone');await unchecked.flush();assert.equal(unchecked.torqueCalls(),0);
  assert.equal(unchecked.preferences.some(([key])=>key==='motionsOff'),false,'a refused switching on leaves the saved «off» as it was');unchecked.close();
});
test('the automatic start tries the torque command once more when the servos’ reply was lost, never more (11 Nov 2026)',async()=>{
  const once=await launch({verified:true,torqueLost:1});once.time(3000);once.tick();await once.flush();
  assert.equal(once.torqueCalls(),1);assert.ok(!once.balloons.includes('Motori non disponibili.'),'not given up yet');
  once.time(4900);once.tick();await once.flush();assert.equal(once.torqueCalls(),1,'2 s later');
  once.time(5000);once.tick();await once.flush();assert.equal(once.torqueCalls(),2);assert.ok(!once.balloons.includes('Movimenti attivi.')&&!once.balloons.includes('Motori non disponibili.'),'on, silently');once.close();
  const twice=await launch({verified:true,torqueLost:5});twice.time(3000);twice.tick();await twice.flush();twice.time(5000);twice.tick();await twice.flush();
  assert.equal(twice.torqueCalls(),2);assert.equal(twice.balloons.at(-1),'Motori non disponibili.','a second loss: motors stay off');
  twice.time(9000);twice.tick();await twice.flush();assert.equal(twice.torqueCalls(),2,'no third try');twice.close();
  const offline=await launch({verified:true,torqueFails:true});offline.time(3000);offline.tick();await offline.flush();offline.time(6000);offline.tick();await offline.flush();
  assert.equal(offline.torqueCalls(),1,'another error is not retried');assert.equal(offline.balloons.at(-1),'Motori non disponibili.');offline.close();
  const manual=await launch({torqueLost:1});manual.buttons.get('robottino:motion')('event');await manual.flush();manual.time(6000);manual.tick();await manual.flush();
  assert.equal(manual.torqueCalls(),1,'a press by hand is never repeated');assert.equal(manual.balloons.at(-1),'Motori non disponibili.');manual.close();
});

test('following alone, when switched on on the robot: the camera is asked for while the robot is on, through a conversation too, not while the iPhone has the head (13 Nov 2026)',async()=>{
  const h=await launch({withVoice:true,withLive:true,verified:true});const asked=[];let active=false,refuse=false;
  Object.assign(h.liveFake,{async self(on){asked.push(on);if(on&&refuse)throw Error('camera_busy');active=on;}});
  Object.defineProperty(h.liveFake,'selfActive',{get:()=>active});Object.defineProperty(h.liveFake,'selfAvailable',{get:()=>h.stored.get('selfFollow')===true});
  const run=async ms=>{for(const end=h.clock()+ms;h.clock()<end;){h.time(h.clock()+100);h.tick();await h.flush();}};
  h.stored.set('selfFollow',undefined); // as on the robot, where the preference was never written
  // A first conversation, started and ended, so that the robot has its voice device.
  {const [touch]=h.touchListeners,t0=h.clock();touch({gesture:'press',intensity:3});h.time(t0+600);h.tick();h.time(t0+1100);h.tick();await h.flush();touch({gesture:'release'});
   assert.equal(h.voiceFake.active,true);h.voiceFake.active=false;h.voiceFake.phase='idle';h.voiceHooks.ended('user');}
  await run(6000);assert.deepEqual(asked,[],'off unless the owner switches it on: the finder does not find a real face yet');
  h.stored.set('selfFollow',true);await run(300);assert.deepEqual(asked,[true],'on while the robot is on, with no conversation');assert.equal(active,true);
  // No iPhone is connected: the robot's own answers move the head.
  const before=h.poses.length;assert.equal(h.liveHooks.aim({x:.9,y:.5,pose:{y:0,p:-.4},gain:.8}),true);await run(600);assert.ok(h.poses.length>before,'the head turns to the face');
  // A conversation starting: the camera is given back until the conversation is ready.
  // A conversation opening: its connection needs the memory the camera holds, so the camera is given back until the
  // conversation is ready; then it stays for all of it, whatever the turn (13 Nov 2026: switched off and on at every
  // change of turn and at every gesture, the robot ran out of memory and restarted).
  h.voiceFake.active=true;h.voiceFake.phase='connecting';await run(400);assert.deepEqual(asked,[true,false]);
  h.voiceHooks.listening();h.voiceFake.phase='listening';await run(400);assert.deepEqual(asked,[true,false,true]);
  for(const phase of ['speaking','connecting','listening','thinking','connecting','speaking']){h.voiceFake.phase=phase;await run(300);}
  assert.deepEqual(asked,[true,false,true],'no switching between the turns of a conversation');assert.equal(h.liveHooks.starting(),false);
  // The iPhone opens the Live: the head is its own, until it asks to follow.
  // The iPhone app connects (15 Nov 2026: «rendiamo il robot completamente autonomo quando l'app è collegata»): nothing
  // changes, the camera stays and the robot's own answers still move the head.
  h.voiceFake.active=false;h.voiceFake.phase='idle';h.voiceHooks.ended('user');await run(300);const steady=asked.length;
  h.liveHooks.connected();await run(300);assert.equal(asked.length,steady,'the camera is not given up');assert.equal(h.liveHooks.aim({x:.9,y:.5,pose:{y:0,p:0},gain:.8}),true,'still following by itself');await run(700);
  // The iPhone takes the head (its joystick): for half a minute the robot's own answers move nothing; the camera stays on.
  await h.liveHooks.motion({yaw:20,pitch:-10}).catch(()=>{});await run(700);
  assert.equal(h.liveHooks.aim({x:.9,y:.5,pose:{y:0,p:0},gain:.8}),false,'the iPhone drives: an answer moves nothing');assert.equal(asked.length,steady,'and the camera is not switched');
  await run(31000);assert.equal(h.liveHooks.aim({x:.9,y:.5,pose:{y:0,p:0},gain:.8}),true,'half a minute after its last command the robot is on its own again');await run(700);
  // A refusal is asked again only 5 s later; switched off by the owner, never.
  h.liveHooks.disconnected();active=false;const count=asked.length;refuse=true;await run(1000);assert.equal(asked.length,count+1);await run(3500);assert.equal(asked.length,count+1);await run(1600);assert.equal(asked.length,count+2);
  refuse=false;h.stored.set('selfFollow',false);await run(6000);assert.equal(asked.length,count+2);assert.equal(active,false);h.close();
});
test('a face asked for by voice stays until Robottino has finished the sentence it says with it (11 Nov 2026)',async()=>{
  const h=await launch({withVoice:true,verified:true});const [touch]=h.touchListeners,t0=h.clock();
  touch({gesture:'press',intensity:3});h.time(t0+600);h.tick();h.time(t0+1100);h.tick();await h.flush();touch({gesture:'release'});
  const run=async ms=>{for(const end=h.clock()+ms;h.clock()<end;){h.time(h.clock()+100);h.tick();await h.flush();}};
  h.voiceHooks.face({expression:'angry'});h.voiceFake.speaking=true;
  await run(6000);assert.deepEqual(h.faceCalls.at(-1),['emotion',1],'still talking after 5 s: still angry');
  h.voiceFake.speaking=false;await run(2000);assert.deepEqual(h.faceCalls.at(-1),['emotion',1],'the sentence is over: still angry, until told');
  h.voiceHooks.face({expression:'happy'});h.voiceFake.speaking=true;await run(6000);assert.deepEqual(h.faceCalls.at(-1),['emotion',3],'the smile lasts while it talks');
  // 12 Nov 2026 («quando dico torna felice deve tornare con il viso felice»): the 5 s ran out while Robottino was
  // still saying «Ecco, sono tornata felice!», over the serene face with the talking mouth, and the smile was never
  // seen. The smile now stays 5 s after the sentence is over.
  h.voiceFake.speaking=false;await run(4000);assert.deepEqual(h.faceCalls.at(-1),['emotion',3],'the sentence is over: the smile is still there');
  await run(1400);assert.deepEqual(h.faceCalls.at(-1),['emotion',0],'5 s after the sentence: back to normal');
  // The real order: the command, a moment of silence, the reply, then the smile to be seen.
  h.voiceHooks.face({expression:'angry'});h.voiceHooks.face({expression:'happy'});await run(1500);h.voiceFake.speaking=true;await run(4000);h.voiceFake.speaking=false;
  await run(4500);assert.deepEqual(h.faceCalls.at(-1),['emotion',3],'«torna felice»: 10 s after the command the smile is still there');
  await run(1000);assert.deepEqual(h.faceCalls.at(-1),['emotion',0]);h.close();
});

// The K210 camera (k210.js), prepared before it arrived: a line that only listens, off until switched on on the robot.
test('K210 camera: the serial line stays closed until «K210» is switched on in the menu; then one pin to receive, and the choice is kept',async()=>{
  const {encodeFrame,K210_PINS,K210_BAUD}=await import('./k210.js');
  const h=await launch({withLive:true}),cycle=async(n=1)=>{for(let i=0;i<n;i++){h.time(h.clock()+100);h.tick();await h.flush();}};
  await cycle(5);assert.equal(h.serials.length,0,'never switched on: no pin is taken');
  const item=label=>h.panels.at(-1).items.find(i=>i.label===label);
  h.buttons.get('robottino:menu')();item('K210: no').action();
  assert.deepEqual(h.preferences.filter(([key])=>key==='k210'),[['k210',true]]);
  await cycle();assert.equal(h.serials.length,1);
  const {receive,transmit,port,baud}=h.serials[0].options;
  assert.equal(receive,K210_PINS[0]);assert.equal(transmit,undefined,'nothing is ever sent to the camera');assert.equal(port,2,'port 1 is the motors\' line');assert.equal(baud,K210_BAUD);
  // What the camera says moves nothing: for now it is only written on the log.
  const poses=h.poses.length;for(let i=0;i<10;i++){h.serials[0].feed(encodeFrame({seq:i,faces:1,x:.9,y:.1,w:.2,h:.3,score:.9,ms:50}));await cycle();}
  assert.equal(h.poses.length,poses,'the head does not follow the K210 yet');
  h.buttons.get('robottino:menu')();assert.ok(item('K210: sì'));item('K210: sì').action();
  assert.equal(h.serials[0].closed,true,'switched off: the pin is given back');assert.deepEqual(h.preferences.filter(([key])=>key==='k210').at(-1),['k210',false]);
  await cycle(40);assert.equal(h.serials.length,1,'and stays closed');
});
// LEGO switched off and commented out in mod.js (owner, 14 Nov 2026: the M5Stack rover replaces it). Even with the old
// choice still saved on the robot, no Bluetooth is opened and the menu has no LEGO button. The two tests below, commented
// out, come back with the code.
test('LEGO is switched off: no Bluetooth even with the old choice saved, and no LEGO in the menu',async()=>{
  let made=0;class BLEClient{constructor(){made++;}close(){}}
  const h=await launch({ble:BLEClient,bleTracking:false,saved:[['lego',true]]});await h.flush();
  assert.equal(made,0,'no Bluetooth');h.buttons.get('robottino:menu')();
  assert.ok(!h.panels.at(-1).items.some(i=>/LEGO/.test(i.label)),'no LEGO button');assert.ok(h.panels.at(-1).items.some(i=>i.label==='Chiudi'));
  h.close();
});
// // The LEGO Technic Hub (lego-wire.js) behind a pretend Bluetooth client: off unless switched on, never with the
// // Bluetooth face following, and the motors only from the menu once the hub is ready. Not tried with a real hub.
// function pretendBle(){
//   const made=[],writes=[];
//   const characteristic={enableNotifications(){queueMicrotask(()=>made.at(-1).onCharacteristicNotificationEnabled(this));},writeWithoutResponse(buffer){writes.push(Array.from(new Uint8Array(buffer)));}};
//   const device={discoverPrimaryService(uuid){queueMicrotask(()=>made.at(-1).onServices([{uuid,discoverCharacteristic(){queueMicrotask(()=>made.at(-1).onCharacteristics([characteristic]));}}]));},close(){}};
//   class BLEClient{constructor(){this.closed=false;made.push(this);queueMicrotask(()=>this.onReady?.());}startScanning(){this.scanning=true;}stopScanning(){this.scanning=false;}connect(){queueMicrotask(()=>this.onConnected(device));}close(){this.closed=true;}}
//   const client=()=>made.at(-1);
//   return {BLEClient,made,writes,
//     advertise:()=>client().onDiscovered({scanResponse:{completeName:'Technic Hub',manufacturerSpecific:{identifier:0x0397,data:Uint8Array.from([0,0x80,6,0,0x41,0])}}}),
//     attach:port=>client().onCharacteristicNotification(characteristic,Uint8Array.from([0x0f,0,0x04,port,0x01,0x2e,0x00,0,0,0,0x10,0,0,0,0x10]).buffer)};
// }
// test('LEGO: off unless switched on in the menu; then the hub is looked for, and the motors are tried only once it is ready',async()=>{
//   const ble=pretendBle(),h=await launch({ble:ble.BLEClient,bleTracking:false}),shown=[];
//   h.face.behavior.showMessage=(_face,text)=>shown.push(text);h.face.behavior.hideMessage=()=>{};
//   assert.equal(ble.made.length,0,'never switched on: no Bluetooth');
//   const item=label=>h.panels.at(-1).items.find(i=>i.label===label);
//   h.buttons.get('robottino:menu')();assert.equal(item('Prova motori LEGO'),undefined);item('LEGO: no').action();await h.flush();
//   assert.deepEqual(h.preferences.filter(([key])=>key==='lego'),[['lego',true]]);
//   assert.equal(ble.made.length,1);assert.ok(shown.includes('LEGO: cerco l’hub…'));
//   ble.advertise();await h.flush();ble.attach(0);ble.attach(1);await h.flush();
//   assert.ok(shown.includes('LEGO: hub collegato, motori A e B.'),shown.join(' | '));
//   h.buttons.get('robottino:menu')();assert.ok(item('Chiudi'));const before=ble.writes.length;item('Prova motori LEGO').action();await h.flush();
//   const power=ble.writes.slice(before).filter(bytes=>bytes[2]===0x81&&bytes[5]===0x51);
//   assert.deepEqual(power.map(bytes=>[bytes[3],bytes[7]]),[[0,30],[1,30]],'both motors forward at 30%');
//   h.buttons.get('robottino:menu')();item('LEGO: sì').action();await h.flush();
//   assert.equal(ble.made[0].closed,true,'switched off: Bluetooth closed');assert.deepEqual(h.preferences.filter(([key])=>key==='lego').at(-1),['lego',false]);
//   h.close();
// });
// test('LEGO: refused while the Bluetooth face following is on; switched on before, it starts with Robottino and closes with it',async()=>{
//   let ble=pretendBle(),h=await launch({ble:ble.BLEClient,bleTracking:true}),shown=[];
//   h.face.behavior.showMessage=(_face,text)=>shown.push(text);h.face.behavior.hideMessage=()=>{};
//   h.buttons.get('robottino:menu')();h.panels.at(-1).items.find(i=>i.label==='LEGO: no').action();await h.flush();
//   assert.equal(ble.made.length,0);assert.ok(shown.includes('LEGO: prima spegni l’inseguimento Bluetooth.'));
//   assert.equal(h.preferences.filter(([key])=>key==='lego').length,0,'the choice is not kept');h.close();
//   ble=pretendBle();h=await launch({ble:ble.BLEClient,bleTracking:false,saved:[['lego',true]]});await h.flush();
//   assert.equal(ble.made.length,1,'switched on before: it looks for the hub at once');
//   h.close();assert.equal(ble.made[0].closed,true);
// });
// The RoverC Pro (rover-wire.js) behind a pretend I2C line: off unless switched on, kept only if it answers, and the
// wheels move only from the menu, for a moment, then the robot stops them. Not tried with the real rover.
function pretendRover({answers=true}={}){
  const lines=[],writes=[];
  // fail: set true to make every write fail from now on (a bus that stops answering), false to bring it back.
  const self={lines,writes,fail:false};
  class I2C{constructor(options){if(options.address!==undefined&&options.address!==0x38)throw Error('nothing at this address');this.options=options;lines.push(this);}write(buffer){if(!answers||self.fail)throw Error('write failed');writes.push(Array.from(new Uint8Array(buffer)));}close(){this.closed=true;}}
  self.I2C=I2C;return self;
}
// Port A with the rover (0x38) and, through a Grove hub, the VL53L0X (0x29): one pretend bus, by address.
function pretendBus({tof=true,climate=false}={}){
  const rover=pretendRover(),regs=new Uint8Array(256),tofLines=[];let pointer=0,ready=false,tofBroken=false;
  regs[0xC0]=tof?0xEE:0x00;regs[0x92]=0x85;regs[0x50]=0x06;regs[0x70]=0x04;regs[0x46]=0x25;regs[0x52]=0x96;regs[0x71]=0x01;regs[0x72]=0xFE;
  class Tof{constructor(options){this.options=options;tofLines.push(this);}
    write(bytes){const b=[...new Uint8Array(bytes.buffer??bytes)];pointer=b[0];for(let i=1;i<b.length;i++)regs[(pointer+i-1)&0xFF]=b[i];if(b[0]===0&&b.length===2&&(b[1]&1)&&regs[0xFF]===0&&regs[0x80]===0)ready=true;if(b[0]===0x0B)ready=false;}
    read(count){if(tofBroken)throw Error('nack');const out=new Uint8Array(count);for(let i=0;i<count;i++){const reg=(pointer+i)&0xFF;out[i]=reg===0x83?0x10:reg===0x13?(ready?7:0):regs[reg];}return out.buffer;}
    close(){this.closed=true;}}
  // The ENV III's SHT30 (0x44) answers 22.3 °C and 41 % (climate-wire.js); no QMP6988 here.
  const sht=[0x63,0x9B,0,0x68,0xF5,0];
  class Sht{constructor(options){this.options=options;}write(){}read(){return Uint8Array.from(sht).buffer;}close(){}}
  class I2C{constructor(options){if(options.address===0x44){if(!climate)throw Error('nack');return new Sht(options);}return options.address===0x29?new Tof(options):new rover.I2C(options);}}
  // range(mm): the sensor has one new measurement; breakTof(on): it stops (or starts again) answering.
  return {I2C,rover,tofLines,setSht(bytes){sht.splice(0,6,...bytes);},range(mm){regs[0x1E]=mm>>8;regs[0x1F]=mm&0xFF;ready=true;},breakTof(on){tofBroken=on;}};
}
test('ENV III (15 Nov 2026): temperature and humidity read every 30 s go into the robot\'s status for the iPhone',async()=>{
  const {crc8}=await import('./climate-wire.js');
  const bus=pretendBus({climate:true});
  const h=await launch({withLive:true,verified:true,rover:bus.I2C});h.liveHooks.connected();
  assert.equal(h.liveHooks.climate(),undefined,'nothing read yet');
  // Fix the pretend SHT30's CRCs, then let the cycle ask and read.
  const word=v=>[v>>8,v&0xFF],t=word(Math.round((22.3+45)*65535/175)),hum=word(Math.round(41*65535/100));
  bus.setSht([...t,crc8(t),...hum,crc8(hum)]);
  for(let step=0;step<4;step++){h.time(h.clock()+100);h.tick();await h.flush();}
  assert.deepEqual(JSON.parse(JSON.stringify(h.liveHooks.climate())),{t:22.3,h:41});h.close();
});
test('«Inseguimento con rover» (15 Nov 2026): on only with the rover and the distance sensor answering; off closes the sensor',async()=>{
  const bus=pretendBus(),h=await launch({withLive:true,verified:true,rover:bus.I2C,saved:[['rover',true]]});h.liveHooks.connected();
  assert.equal(h.liveHooks.roverFollowing(),false,'off unless switched on');assert.equal(bus.tofLines.length,1,'the sensor is open with the rover: it is also the obstacle sensor');
  assert.equal(h.liveHooks.roverFollow(true),true);assert.equal(h.liveHooks.roverFollowing(),true);
  assert.equal(bus.tofLines[0].options.address,0x29);assert.deepEqual(h.preferences.filter(([key])=>key==='roverFollow').at(-1),['roverFollow',true]);
  assert.equal(h.balloons.at(-1),'Inseguimento con rover: acceso.');
  assert.equal(h.liveHooks.roverFollow(false),true);assert.equal(h.liveHooks.roverFollowing(),false);assert.notEqual(bus.tofLines[0].closed,true,'the sensor stays open for the obstacles');
  assert.deepEqual(h.preferences.filter(([key])=>key==='roverFollow').at(-1),['roverFollow',false]);h.close();
  const noSensor=pretendBus({tof:false}),n=await launch({withLive:true,verified:true,rover:noSensor.I2C,saved:[['rover',true]]});n.liveHooks.connected();
  assert.equal(n.liveHooks.roverFollow(true),false,'no VL53L0X: not on');assert.match(n.balloons.at(-1),/sensore di distanza non risponde/);n.close();
  const noRover=await launch({withLive:true,verified:true});noRover.liveHooks.connected();
  assert.equal(noRover.liveHooks.roverFollow(true),false,'no rover: not on');assert.match(noRover.balloons.at(-1),/accendi il rover/);noRover.close();
  const again=pretendBus(),r=await launch({withLive:true,verified:true,rover:again.I2C,saved:[['rover',true],['roverFollow',true]]});r.liveHooks.connected();
  assert.equal(r.liveHooks.roverFollowing(),true,'switched on before a restart: on again');r.close();
});
test('following with the rover and nobody in sight (15 Nov 2026: «se non mi vede il rover deve girarsi finché non mi vede»): the body turns, in one slow turn with the camera looking (16 Nov 2026), until a face or sleep',async()=>{
  const bus=pretendBus(),r=bus.rover,h=await launch({withLive:true,verified:true,rover:bus.I2C,saved:[['rover',true]]});await h.flush();
  // The rover's own stop timers (rover-wire.js) fire when their time has passed.
  const due=new Map();
  const cycle=async ms=>{for(let t=0;t<ms;t+=100){h.time(h.clock()+100);h.tick();for(const [id,timer] of [...h.timeouts])if(timer.ms===400||timer.ms===500){if(!due.has(id))due.set(id,h.clock()+timer.ms);else if(h.clock()>=due.get(id)){h.timeouts.delete(id);timer.cb();}}await h.flush();}};
  await arm(h);
  let alone=0,seen=Infinity;Object.defineProperty(h.liveFake,'selfActive',{get:()=>true,configurable:true});
  Object.defineProperty(h.liveFake,'selfAloneMs',{get:()=>alone,configurable:true});Object.defineProperty(h.liveFake,'selfSeenMs',{get:()=>seen,configurable:true});
  assert.equal(h.liveHooks.bodySearch(),undefined,'following off: the head looks around by itself');
  assert.equal(h.liveHooks.roverFollow(true),true);assert.equal(h.liveHooks.bodySearch(),0,'the body will look: the head stays');
  const turning=()=>r.writes.filter(w=>w.slice(1).some(v=>v!==0)).length;
  await cycle(2500);assert.equal(turning(),0,'just lost: it may come back');
  const before=r.writes.length;
  await cycle(900);assert.ok(turning()>=1,'3 s with nobody: the turn begins');assert.equal(h.liveHooks.bodyQuick(),true,'the quick detectors only');
  assert.equal(h.liveHooks.headSettled(),true,'a slow turn: the camera goes on looking');
  await cycle(7000);const turns=turning();assert.ok(turns>=15,`renewed all the while: ${turns}`);assert.equal(h.liveHooks.bodySearch(),1,'one turn, not steps');
  const moves=r.writes.filter(w=>w.slice(1).some(v=>v!==0));assert.ok(moves.every(w=>String(w)===String(moves[0])),'always the same way, at the same speed');
  assert.ok(moves[0].slice(1).every(v=>v===30||v===226),'slowly: '+moves[0]);
  assert.ok(r.writes.slice(before).every(w=>w.slice(1).some(v=>v!==0)),'and never a stop on the way');
  // A face: no more searching (the head, straight, and no distance yet: the body is still). It is at the right of the picture.
  seen=100;h.liveFake.selfSide=-1;await cycle(3000);assert.equal(turning(),turns,'found: the search is over');assert.equal(h.liveHooks.headSettled(),true);
  assert.ok(r.writes.at(-1).slice(1).every(v=>v===0),'stopped at the face');
  // Lost again, and nobody for 30 s: asleep, the wheels rest.
  seen=Infinity;await cycle(7000);const more=turning();assert.ok(more>turns,'lost again: it looks again');
  const after=r.writes.filter(w=>w.slice(1).some(v=>v!==0)).at(-1);assert.notEqual(String(after),String(moves[0]),'it left by the right of the picture: the body turns the other way now');
  assert.equal(String(after.slice(1).map(v=>(256-v)&0xFF)),String(moves[0].slice(1)),'the same turn, mirrored');
  alone=31000;await cycle(6000);const asleep=turning();await cycle(6000);assert.equal(turning(),asleep,'asleep: no turn');assert.equal(h.liveHooks.bodySearch(),undefined);
  h.close();
});
test('following with the rover: an old distance moves nothing, also with the time of day far from the robot\'s clock; a sensor that stops answering is said and found again (code review, 15 Nov 2026)',async()=>{
  const bus=pretendBus(),r=bus.rover,h=await launch({withLive:true,verified:true,rover:bus.I2C,saved:[['rover',true]]});await h.flush();
  h.wallTime(Date.UTC(2026,10,15,17)); // the network gave the time: Date.now is no longer the robot's ticks
  const due=new Map();
  const cycle=async ms=>{for(let t=0;t<ms;t+=100){h.time(h.clock()+100);h.wallTime(Date.UTC(2026,10,15,17)+h.clock());h.tick();for(const [id,timer] of [...h.timeouts])if(timer.ms===600){if(!due.has(id))due.set(id,h.clock()+600);else if(h.clock()>=due.get(id)){h.timeouts.delete(id);timer.cb();}}await h.flush();}};
  await arm(h);
  Object.defineProperty(h.liveFake,'selfActive',{get:()=>true,configurable:true});Object.defineProperty(h.liveFake,'selfAloneMs',{get:()=>0,configurable:true});Object.defineProperty(h.liveFake,'selfSeenMs',{get:()=>50,configurable:true});
  assert.equal(h.liveHooks.look({y:0,p:0}),true);await cycle(1500);
  assert.equal(h.liveHooks.roverFollow(true),true);
  const forward=()=>r.writes.filter(w=>w[0]===0&&w.slice(1).every(v=>v>0&&v<128)).length;
  await cycle(1000);assert.equal(forward(),0,'no measurement yet');
  bus.range(1500);await cycle(200);assert.equal(forward(),1,'a fresh 1.5 m: one step closer');
  await cycle(3000);assert.equal(forward(),1,'the sensor gives nothing new: that distance is old, no more steps');
  bus.range(1500);await cycle(200);assert.equal(forward(),2,'a new measurement: on again');
  // The sensor stops answering: following is off in the robot's status, said once; found again by itself.
  const hellos=h.hellos();bus.breakTof(true);await cycle(1000);
  assert.equal(h.liveHooks.roverFollowing(),false);assert.equal(h.balloons.filter(text=>/sensore di distanza non risponde più/.test(text)).length,1);assert.ok(h.hellos()>hellos,'the iPhone is told');
  await cycle(6000);assert.equal(h.liveHooks.roverFollowing(),false,'still not answering');
  bus.breakTof(false);await cycle(6000);assert.equal(h.liveHooks.roverFollowing(),true,'answers again: following is back');assert.match(h.balloons.at(-1),/di nuovo attivo/);
  // Rover off from the robot's menu: following is off for good, not back at the next start.
  h.buttons.get('robottino:menu')();h.panels.at(-1).items.find(i=>/^Rover:/.test(i.label)).action();await h.flush();
  assert.deepEqual(h.preferences.filter(([key])=>key==='roverFollow').at(-1),['roverFollow',false]);assert.equal(h.liveHooks.roverFollowing(),false);
  h.close();
});
test('following with the rover drives on without stopping while the sensor keeps saying far and the camera keeps looking; a turn sends the head back (16 Nov 2026: «ottimizza inseguimento con rover»)',async()=>{
  const bus=pretendBus(),r=bus.rover,h=await launch({withLive:true,verified:true,rover:bus.I2C,saved:[['rover',true]]});await h.flush();
  // The rover's own stop timers (rover-wire.js) fire when their time has passed, unless a renewal cleared them.
  const due=new Map();let mm=1400,feed=false;
  const cycle=async ms=>{for(let t=0;t<ms;t+=50){h.time(h.clock()+50);if(feed)bus.range(Math.round(mm));h.tick();for(const [id,timer] of [...h.timeouts])if(timer.ms>=150&&timer.ms<=600){if(!due.has(id))due.set(id,h.clock()+timer.ms);else if(h.clock()>=due.get(id)){h.timeouts.delete(id);timer.cb();}}await h.flush();}};
  await arm(h);
  Object.defineProperty(h.liveFake,'selfActive',{get:()=>true,configurable:true});Object.defineProperty(h.liveFake,'selfAloneMs',{get:()=>0,configurable:true});Object.defineProperty(h.liveFake,'selfSeenMs',{get:()=>50,configurable:true});
  const turned=[];h.liveFake.selfTurned=delta=>turned.push(delta);
  assert.equal(h.liveHooks.look({y:0,p:0}),true);await cycle(1500);
  assert.equal(h.liveHooks.roverFollow(true),true);
  const wheels=()=>r.writes.filter(w=>w[0]===0&&w.length===5),going=w=>w.slice(1).every(v=>v>0&&v<128),stopped=w=>w.slice(1).every(v=>v===0);
  await cycle(1500);assert.equal(h.liveHooks.headSettled(),true,'the head is still');assert.equal(wheels().filter(going).length,0,'no distance yet');
  feed=true;await cycle(300);const from=wheels().length;
  assert.ok(going(wheels().at(-1)),'1.4 m in front: forward');assert.equal(wheels().at(-1)[1],50,'far: at the rover\'s limit');
  assert.equal(h.liveHooks.headSettled(),true,'going straight: the camera goes on looking');
  await cycle(2000);const run=wheels().slice(from-1);
  assert.ok(run.length>=4,`renewed: ${run.length} writes in 2 s`);assert.ok(run.every(going),'and never a stop between them');
  assert.equal(h.liveHooks.headSettled(),true);
  // The place is reached (the band's far half): stopped there, by the sensor.
  mm=660;await cycle(200);assert.ok(stopped(wheels().at(-1)),'arrived: stopped at once');
  const after=wheels().length;await cycle(2000);assert.equal(wheels().length,after,'and still, at the right distance');
  // The face goes to the robot's left: the head follows it there, then the body turns that way and the head is sent
  // back by as much; the camera waits while the body turns; what it remembers of the face is moved with the head.
  assert.equal(h.liveHooks.look({y:.5,p:-.3}),true);await cycle(1500);
  const turn=wheels().slice(after).find(w=>!stopped(w));
  assert.ok(turn,'the body turns');assert.ok(turn[1]>0&&turn[1]<128&&turn[2]>127&&turn[3]===turn[1]&&turn[4]===turn[2],'on the spot, to the robot\'s left: '+turn);assert.equal(turn[1],50,'a wide turn, reckoned with the head arrived: at the rover\'s limit');
  assert.equal(turned.length>=1,true);assert.ok(turned[0]<0&&turned[0]>=-25*Math.PI/180-.01,'the head back toward the middle, by at most the widest turn: '+turned[0]);
  h.close();
});
test('a turn toward the face is measured with the gyroscope in the head: it ends when the body has turned the angle, not when the clock says (16 Nov 2026: «La rotazione possiamo evitare di farla a scatti»)',async()=>{
  // The pretend rover turns twice as fast as reckoned: 150° a second at 50 %. The gyroscope reads it about the
  // vertical, which with the head 27° up is partly along the sensor's y and partly along its z (motion-sense.js).
  const up=27*Math.PI/180,G=9.80665,bus=pretendBus(),r=bus.rover,imu=fakeImu(),log=[];
  const h=await launch({withLive:true,verified:true,imu,trace:t=>{log.push(t);},rover:bus.I2C,saved:[['rover',true]]});await h.flush();
  const due=new Map(),wheels=()=>r.writes.filter(w=>w[0]===0&&w.length===5),stopped=w=>w.slice(1).every(v=>v===0);let jitter=0,body=0,first;
  const cycle=async ms=>{for(let t=0;t<ms;t+=25){
    h.time(h.clock()+25);
    const last=wheels().at(-1),turning=!!last&&!stopped(last),rate=turning?150:0;if(turning)body+=150*.025;else if(body>0)first??=body; // first: what the first turn came to
    // A reading every 100 ms, never quite the same twice.
    if(h.clock()%100===0){jitter=(jitter+1)%7;imu.reading={accelerometer:{x:0,y:G*Math.cos(up),z:G*Math.sin(up)},gyroscope:{x:.01*jitter,y:rate*Math.cos(up),z:rate*Math.sin(up)}};}
    h.tick();for(const [id,timer] of [...h.timeouts])if(timer.ms>=150&&timer.ms<=600){if(!due.has(id))due.set(id,h.clock()+timer.ms);else if(h.clock()>=due.get(id)){h.timeouts.delete(id);timer.cb();}}await h.flush();}};
  await arm(h);
  Object.defineProperty(h.liveFake,'selfActive',{get:()=>true,configurable:true});Object.defineProperty(h.liveFake,'selfAloneMs',{get:()=>0,configurable:true});Object.defineProperty(h.liveFake,'selfSeenMs',{get:()=>50,configurable:true});
  const turned=[];h.liveFake.selfTurned=delta=>turned.push(delta);
  assert.equal(h.liveHooks.roverFollow(true),true);await cycle(1500);
  // The face 57° to the robot's left: the head goes there, then the body turns 46° (turnShare) in one move.
  assert.equal(h.liveHooks.look({y:1,p:-.3}),true);const from=wheels().length;await cycle(2500);
  const moves=wheels().slice(from),end=moves.findIndex(stopped);
  assert.ok(end>=1,'the turn, then its stop');assert.ok(moves.slice(0,end).every(w=>w[1]===50&&w[2]===206),'one turn to the robot\'s left at the rover\'s limit, renewed or not, never stopped on the way: '+moves.slice(0,end).join(' | '));
  assert.ok(first>=36&&first<=56,`the body turned ${first}° for 46°, though twice as fast as reckoned (by the clock it would have turned 50° and thought them 25°)`);
  assert.ok(turned.length>=1);assert.ok(turned[0]<0&&Math.abs(-turned[0]*180/Math.PI-first)<=14,`the head back by what the gyroscope measured: ${Math.round(-turned[0]*180/Math.PI)}° for ${first}°`);
  assert.match(log.find(line=>/rover follow turned/.test(line)),/turned \d+ deg in \d+ ms measured/,'on the log, for the first trial on the real rover');
  h.close();
});
test('obstacle sensor (15 Nov 2026: «possiamo fare sensore ostacoli»): never forward with something within 25 cm, a move forward stops when it appears; the other moves and a rover without the sensor as before',async()=>{
  const bus=pretendBus(),r=bus.rover,h=await launch({withLive:true,withVoice:true,verified:true,rover:bus.I2C,saved:[['rover',true]]});await h.flush();
  const cycle=async ms=>{for(let t=0;t<ms;t+=100){h.time(h.clock()+100);h.tick();await h.flush();}};
  const talk=async robot=>{const [touch]=robot.touchListeners,t0=robot.clock();touch({gesture:'press',intensity:3});robot.time(t0+600);robot.tick();robot.time(t0+1100);robot.tick();await robot.flush();touch({gesture:'release'});for(let t=0;t<1000;t+=100){robot.time(robot.clock()+100);robot.tick();await robot.flush();}};
  await talk(h);h.voiceHooks.head({direction:'center'});await cycle(1500);const moving=()=>r.writes.at(-1).slice(1).some(v=>v!==0);
  // Something 15 cm in front: no step forward, from the agent's tool and from the user's own words; back and turns go.
  bus.range(150);await cycle(100);
  assert.deepEqual(JSON.parse(JSON.stringify(await h.voiceHooks.tool({tool:'rover',move:'forward',ms:1000}))),{ok:false,code:'obstacle'});assert.equal(moving(),false);
  h.time(h.clock()+20000);bus.range(150);await cycle(100);h.voiceHooks.rover({move:'forward'});assert.equal(h.balloons.at(-1),'Rover: ostacolo davanti.');assert.equal(moving(),false);
  bus.range(150);await cycle(100);h.voiceHooks.rover({move:'back'});assert.equal(moving(),true,'backwards the sensor does not look: allowed');h.voiceHooks.rover({move:'stop'});
  // That reading grows old (the sensor gives nothing new): not an obstacle any more.
  h.time(h.clock()+20000);await cycle(500);h.voiceHooks.rover({move:'forward'});assert.equal(moving(),false,'an old reading cannot authorise travel');h.voiceHooks.rover({move:'stop'});
  // The way is free (1.5 m), the rover goes; something appears at 10 cm: stopped at once, and said.
  h.time(h.clock()+20000);bus.range(1500);await cycle(100);h.voiceHooks.rover({move:'forward'});assert.equal(moving(),true);
  bus.range(100);await cycle(100);assert.equal(moving(),false,'stopped');assert.equal(h.balloons.at(-1),'Rover: ostacolo davanti, mi fermo.');
  // A thing right against the sensor (under its 30 mm) is an obstacle too.
  h.time(h.clock()+20000);bus.range(12);await cycle(100);h.voiceHooks.rover({move:'forward'});assert.equal(moving(),false);assert.equal(h.balloons.at(-1),'Rover: ostacolo davanti.');
  // The agent's move forward cut short by an obstacle is not «done» (code review, 19 Nov 2026).
  h.time(h.clock()+20000);bus.range(1500);await cycle(100);let answer;void Promise.resolve(h.voiceHooks.tool({tool:'rover',move:'forward',ms:1000})).then(value=>{answer=value;});
  await h.flush();assert.equal(moving(),true);bus.range(100);await cycle(100);assert.equal(moving(),false);
  for(const [id,timer] of [...h.timeouts])if(timer.ms===1150){h.timeouts.delete(id);timer.cb();}await h.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(answer)),{ok:false,code:'stopped_obstacle'});
  // The sensor stops answering: no step forward blind; back still goes.
  bus.breakTof(true);bus.range(1500);await cycle(100);h.time(h.clock()+20000);await cycle(100);
  h.voiceHooks.rover({move:'forward'});assert.equal(moving(),false,'not forward without the obstacle sensor');assert.equal(h.balloons.at(-1),'Rover: il sensore di ostacoli non risponde, non vado avanti.');
  assert.deepEqual(JSON.parse(JSON.stringify(await h.voiceHooks.tool({tool:'rover',move:'forward',ms:1000}))),{ok:false,code:'obstacle_sensor'});
  h.voiceHooks.rover({move:'back'});assert.equal(moving(),true,'back goes');h.voiceHooks.rover({move:'stop'});
  h.close();
  // No distance sensor on the wire: the rover moves as before.
  const bare=pretendRover(),n=await launch({withVoice:true,verified:true,rover:bare.I2C,saved:[['rover',true]]});await n.flush();await talk(n);n.voiceHooks.head({direction:'center'});for(let i=0;i<15;i++){n.time(n.clock()+100);n.tick();await n.flush();}
  n.voiceHooks.rover({move:'forward'});assert.ok(bare.writes.at(-1).slice(1).some(v=>v!==0),'no sensor: forward as before');n.close();
});
test('hand gestures from the iPhone (15 Nov 2026: «riconosci i gesti»): thumbs change the face for a while and are answered with a laugh or a sad sound, an open hand stops the rover, a wave is greeted, two fingers dance; each once',async()=>{
  const r=pretendRover(),h=await launch({withLive:true,verified:true,rover:r.I2C,saved:[['rover',true]]});await h.flush();
  // The mouth of a recorded phrase moves on 50 ms timers: fired here, so that the phrase ends as on the robot.
  const cycle=async ms=>{for(let t=0;t<ms;t+=100){h.time(h.clock()+100);h.tick();for(const [id,timer] of [...h.timeouts])if(timer.ms===50){h.timeouts.delete(id);timer.cb();}await h.flush();}};
  await arm(h);await cycle(1000);
  assert.equal(h.liveHooks.gesture('thumbsUp'),false,'only while the iPhone is connected');
  h.liveHooks.connected();const emotions=()=>h.faceCalls.filter(([name])=>name==='emotion').map(([,value])=>value),sounds=()=>h.touches.filter(item=>item.audio).map(item=>item.audio);
  let before=emotions().length,heard=sounds().length;
  assert.equal(h.liveHooks.gesture('thumbsUp'),true);await h.flush();assert.deepEqual(emotions().slice(before),[3],'happy');assert.deepEqual(sounds().slice(heard),['sami-risata.bin'],'and it laughs');
  assert.equal(h.liveHooks.gesture('thumbsUp'),true);await h.flush();assert.deepEqual(emotions().slice(before),[3],'the same gesture again at once: one gesture');assert.equal(sounds().length,heard+1,'one laugh');
  await cycle(6000);assert.notEqual(emotions().at(-1),3,'after 5 s the usual face is back');
  before=emotions().length;heard=sounds().length;assert.equal(h.liveHooks.gesture('thumbsDown'),true);await h.flush();assert.equal(emotions().slice(before)[0],2,'sad');assert.deepEqual(sounds().slice(heard),['oh-uffa.bin'],'«Oh-oh-oh, uffa.»');await cycle(6000);
  // An open hand held still: the wheels stop, and it says so.
  assert.equal(h.liveHooks.rover('turnLeft',1000),true);assert.ok(r.writes.at(-1).slice(1).some(v=>v!==0),'turning');
  assert.equal(h.liveHooks.gesture('palm'),true);assert.deepEqual(r.writes.at(-1),[0,0,0,0,0],'stopped');assert.equal(h.balloons.at(-1),'Fermo.');
  // Two fingers: the dance, with the checks of a spoken «balla».
  await cycle(3000);const poses=h.poses.length;
  assert.equal(h.liveHooks.gesture('victory'),true);await cycle(1500);assert.ok(h.poses.length>poses,'dancing');
  // A wave: the recorded hello and a smile; while it says it, no dance (the head is still for a recorded phrase).
  await cycle(9000);heard=sounds().length;before=emotions().length;
  assert.equal(h.liveHooks.gesture('wave'),true);await h.flush();assert.deepEqual(sounds().slice(heard),['ciao-eccomi.bin'],'«Ciao, eccomi!»');assert.equal(emotions().slice(before)[0],3);
  assert.equal(h.liveHooks.gesture('victory'),false,'speaking: not now');assert.equal(h.balloons.at(-1),'Ora non posso ballare.');
  h.close();
  const still=await launch({withLive:true});still.liveHooks.connected();
  assert.equal(still.liveHooks.gesture('victory'),false,'motions off: no dance, and not acknowledged');assert.equal(still.balloons.at(-1),'Ora non posso ballare.');
  assert.deepEqual(still.faceCalls.filter(c=>c[0]==='hand').at(-1),['hand','victory'],'the icon all the same: the gesture was seen (23 Nov 2026)');
  assert.equal(still.liveHooks.gesture('palm'),true,'no rover: nothing to stop, still done');still.close();
});
test('what else the iPhone sees (15 Nov 2026: «riconoscere chi sei, capire l\'espressione, riconoscere oggetti»): the owner greeted by name, a smile answered, a thing named; nothing in a conversation',async()=>{
  const h=await launch({withLive:true,withVoice:true,verified:true});await h.flush();
  const cycle=async ms=>{for(let t=0;t<ms;t+=100){h.time(h.clock()+100);h.tick();for(const [id,timer] of [...h.timeouts])if(timer.ms===50){h.timeouts.delete(id);timer.cb();}await h.flush();}};
  await arm(h);await cycle(1000);
  assert.equal(h.liveHooks.sight('smile'),false,'only while the iPhone is connected');
  h.liveHooks.connected();const emotions=()=>h.faceCalls.filter(([name])=>name==='emotion').map(([,value])=>value),sounds=()=>h.touches.filter(item=>item.audio).map(item=>item.audio);
  let faces=emotions().length,heard=sounds().length;
  assert.equal(h.liveHooks.sight('person','Ada'),true);await h.flush();
  assert.equal(h.balloons.some(text=>/Ada/.test(String(text))),false,'nothing written on the screen (owner: «togli i messaggi a video»)');assert.equal(emotions().slice(faces)[0],3,'a smile');assert.deepEqual(sounds().slice(heard),['ciao-eccomi.bin'],'and the recorded hello');
  assert.equal(h.liveHooks.sight('person','Ada'),true);await h.flush();assert.equal(sounds().length,heard+1,'the same again at once: one greeting');
  await cycle(7000);faces=emotions().length;const said=h.balloons.length;
  assert.equal(h.liveHooks.sight('smile'),true);assert.equal(emotions().slice(faces)[0],3,'a smile for a smile');assert.equal(h.balloons.length,said,'nothing written');assert.equal(sounds().length,heard+1,'no sound');
  await cycle(7000);const written=h.balloons.length;assert.equal(h.liveHooks.sight('object','una tazza'),true);assert.equal(h.balloons.length,written,'a thing: taken, nothing written');
  faces=emotions().length;assert.equal(h.liveHooks.sight('stranger'),true);assert.equal(h.balloons.length,written);assert.equal(emotions().slice(faces).filter(value=>value===3).length,0,'a stranger: nothing at all');
  await cycle(7000);const poses=h.poses.length;assert.equal(h.liveHooks.sight('serious'),true);await cycle(1500);assert.ok(h.poses.length>poses,'a small tilt of the head');
  assert.equal(h.liveHooks.sight('wink'),false,'not a kind');
  // In a conversation the face, the screen and the voice are the conversation's: taken, nothing done.
  await cycle(5000);const [touch]=h.touchListeners,t0=h.clock();touch({gesture:'press',intensity:3});h.time(t0+600);h.tick();h.time(t0+1100);h.tick();await h.flush();touch({gesture:'release'});assert.equal(h.voiceFake.active,true);
  const quiet=h.balloons.length;faces=emotions().length;assert.equal(h.liveHooks.sight('object','una mela'),true);assert.equal(h.liveHooks.sight('smile'),true);
  assert.equal(emotions().slice(faces).filter(value=>value===3).length,0);
  h.close();
});
// Schede NFC (nfc.js, 21 Nov 2026): the host's reader (device.sensor.RFID) is not touched until «NFC» is switched on.
test('NFC: no reader until switched on in the menu; a card is shown once; switched off, the reader is closed with its field off',async()=>{
  const reader={made:0,samples:0,field:false,closed:0,card:undefined,seen:undefined};
  const device={sensor:{RFID:class{
    constructor(){reader.made++;}
    configure({antenna}){reader.field=antenna===true;}
    sample(){reader.samples++;if(reader.card!==reader.seen){const was=reader.seen;reader.seen=reader.card;if(reader.card)return {present:true,uidHex:reader.card,sak:0,type:'NTAG'};if(was)return {present:false};}}
    close(){reader.closed++;}
  }}};
  {
    const h=await launch({device}),shown=[],cycle=async ms=>{for(let t=0;t<ms;t+=100){h.time(h.clock()+100);h.tick();await h.flush();}};
    h.face.behavior.showMessage=(_face,text)=>shown.push(text);h.face.behavior.hideMessage=()=>{};
    await cycle(3000);assert.equal(reader.made,0,'never switched on: no reader, no radio field');
    const item=label=>h.panels.at(-1).items.find(i=>i.label===label);
    h.buttons.get('robottino:menu')();assert.ok(item('Chiudi'));item('NFC: no').action();
    assert.deepEqual(h.preferences.filter(([key])=>key==='nfc'),[['nfc',true]]);
    await cycle(3000);assert.equal(reader.made,1);assert.ok(reader.samples>=1&&reader.samples<=3,`about one a second, got ${reader.samples}`);
    assert.equal(reader.field,true,'field on while the robot is free');
    reader.card='04a1b2c3d4e5f6';await cycle(5000);
    assert.equal(shown.filter(text=>text==='Scheda NFC: 04a1b2c3d4e5f6').length,1,'shown once, not again while held');
    h.buttons.get('robottino:menu')();item('NFC: sì').action();
    assert.equal(reader.closed,1);assert.equal(reader.field,false,'switched off: field off');assert.deepEqual(h.preferences.filter(([key])=>key==='nfc').at(-1),['nfc',false]);
    const asked=reader.samples;await cycle(3000);assert.equal(reader.samples,asked,'switched off: nothing more asked');
    h.close();
  }
});

test('Rover: off unless switched on; kept only if it answers on Port A; «Prova rover» turns on the spot and the robot stops it',async()=>{
  const r=pretendRover(),h=await launch({rover:r.I2C}),shown=[];
  h.face.behavior.showMessage=(_face,text)=>shown.push(text);h.face.behavior.hideMessage=()=>{};
  assert.equal(r.lines.length,0,'never switched on: the port is not touched');
  const item=label=>h.panels.at(-1).items.find(i=>i.label===label);
  h.buttons.get('robottino:menu')();assert.equal(item('Prova rover'),undefined);item('Rover: no').action();await h.flush();
  assert.deepEqual({data:r.lines[0].options.data,clock:r.lines[0].options.clock,address:r.lines[0].options.address},{data:2,clock:1,address:0x38});
  assert.deepEqual(r.writes,[[0,0,0,0,0]],'first a stop');assert.deepEqual(h.preferences.filter(([key])=>key==='rover'),[['rover',true]]);
  assert.ok(shown.includes('Rover: collegato.'));
  h.buttons.get('robottino:menu')();assert.ok(item('Chiudi'));assert.equal(item('Prova duplex'),undefined);item('Prova rover').action();await h.flush();
  assert.equal(r.writes.length,2);assert.ok(r.writes[1].slice(1).some(v=>v!==0),'the wheels turn');
  const stop=[...h.timeouts].find(([,t])=>t.ms===600);assert.ok(stop,'stopped by the robot after 600 ms');h.timeouts.delete(stop[0]);stop[1].cb();
  assert.deepEqual(r.writes.at(-1),[0,0,0,0,0]);
  h.buttons.get('robottino:menu')();item('Rover: sì').action();await h.flush();
  assert.equal(r.lines[0].closed,true,'switched off: the port is given back');assert.deepEqual(h.preferences.filter(([key])=>key==='rover').at(-1),['rover',false]);
  h.close();
});
test('Rover: not answering, the choice is not kept; switched on before, it opens with Robottino and is stopped when it closes',async()=>{
  let r=pretendRover({answers:false}),h=await launch({rover:r.I2C}),shown=[];
  h.face.behavior.showMessage=(_face,text)=>shown.push(text);h.face.behavior.hideMessage=()=>{};
  h.buttons.get('robottino:menu')();h.panels.at(-1).items.find(i=>i.label==='Rover: no').action();await h.flush();
  assert.ok(shown.some(text=>/non risponde sulla porta A/.test(text)));assert.equal(r.lines[0].closed,true);
  assert.equal(h.preferences.filter(([key])=>key==='rover').length,0,'the choice is not kept');
  h.buttons.get('robottino:menu')();assert.ok(h.panels.at(-1).items.some(i=>i.label==='Rover: no'));h.close();
  r=pretendRover();h=await launch({rover:r.I2C,saved:[['rover',true]]});await h.flush();
  assert.equal(r.lines.length,1,'switched on before: opened at once');
  h.close();assert.deepEqual(r.writes.at(-1),[0,0,0,0,0]);assert.equal(r.lines[0].closed,true);
});
test('Rover by voice (muovi_rover): «done» only once the robot has stopped the wheels; refused without the rover or while lifted',async()=>{
  const r=pretendRover(),h=await launch({withVoice:true,verified:true,rover:r.I2C,saved:[['rover',true]]});await h.flush();
  const cycle=async ms=>{for(let t=0;t<ms;t+=100){h.time(h.clock()+100);h.tick();for(const [id,timer] of [...h.timeouts])if(timer.ms===50){h.timeouts.delete(id);timer.cb();}await h.flush();}};
  const talk=async robot=>{const [touch]=robot.touchListeners,t0=robot.clock();touch({gesture:'press',intensity:3});robot.time(t0+600);robot.tick();robot.time(t0+1100);robot.tick();await robot.flush();touch({gesture:'release'});for(let t=0;t<1000;t+=100){robot.time(robot.clock()+100);robot.tick();await robot.flush();}};
  await talk(h);
  let answer;void Promise.resolve(h.voiceHooks.tool({tool:'rover',move:'turnLeft',ms:600})).then(value=>{answer=value;});await h.flush();
  assert.equal(answer,undefined,'not before the wheels stop');assert.ok(r.writes.at(-1).slice(1).some(v=>v!==0),'turning');
  const fire=ms=>{const found=[...h.timeouts].find(([,t])=>t.ms===ms);assert.ok(found,`timer ${ms}`);h.timeouts.delete(found[0]);found[1].cb();};
  fire(600);assert.deepEqual(r.writes.at(-1),[0,0,0,0,0]);fire(750);await h.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(answer)),{ok:true});
  assert.deepEqual(JSON.parse(JSON.stringify(await h.voiceHooks.tool({tool:'rover',move:'stop',ms:0}))),{ok:true});
  // The user's own words first (voice-wire.js roverCommand, 15 Nov 2026): the robot moves at once; the agent's
  // muovi_rover for the same move right after is not done twice.
  assert.equal(h.voiceHooks.roverReady(),true);
  h.voiceHooks.head({direction:'center'});for(let i=0;i<15;i++){h.time(h.clock()+100);h.tick();await h.flush();}
  const writes=r.writes.length;h.voiceHooks.rover({move:'forward'});assert.equal(r.writes.length,writes+1,'moving at once');
  assert.deepEqual(JSON.parse(JSON.stringify(await h.voiceHooks.tool({tool:'rover',move:'forward',ms:1000}))),{ok:true});assert.equal(r.writes.length,writes+1,'not twice');
  // The gripper (15 Nov 2026): one byte to servo 1, done at once; from the user's own words and from the agent's tool, not twice.
  h.time(h.clock()+20000);let grips=()=>r.writes.filter(w=>w[0]===0x10).map(w=>w[1]);
  assert.deepEqual(JSON.parse(JSON.stringify(await h.voiceHooks.tool({tool:'rover',move:'gripClose',ms:0}))),{ok:true});assert.deepEqual(grips(),[10]);
  h.time(h.clock()+20000);h.voiceHooks.rover({move:'gripOpen'});assert.deepEqual(grips(),[10,90]);
  assert.deepEqual(JSON.parse(JSON.stringify(await h.voiceHooks.tool({tool:'rover',move:'gripOpen',ms:0}))),{ok:true});assert.deepEqual(grips(),[10,90],'already done from the words');
  h.time(h.clock()+20000);assert.deepEqual(JSON.parse(JSON.stringify(await h.voiceHooks.tool({tool:'rover',move:'gripHalf',ms:0}))),{ok:true});assert.deepEqual(grips(),[10,90,50],'«chiudi poco»: half way');
  h.close();
  // A spoken command the rover did not take: the agent's tool for it says so too, never «done» (code review, 15 Nov 2026).
  const broken=pretendRover(),b=await launch({withVoice:true,verified:true,rover:broken.I2C,saved:[['rover',true]]});await b.flush();await talk(b);
  broken.I2C.prototype.write=()=>{throw Error('write failed');};
  b.voiceHooks.rover({move:'gripOpen'});assert.match(b.balloons.at(-1),/Rover: non risponde/);
  assert.deepEqual(JSON.parse(JSON.stringify(await b.voiceHooks.tool({tool:'rover',move:'gripOpen',ms:0}))),{ok:false,code:'rover_error'});b.close();
  const n=await launch({withVoice:true,verified:true});await talk(n);assert.equal(n.voiceHooks.roverReady(),false,'no rover: the head keeps its words');
  assert.deepEqual(JSON.parse(JSON.stringify(await n.voiceHooks.tool({tool:'rover',move:'gripOpen',ms:0}))),{ok:false,code:'no_rover'});
  assert.deepEqual(JSON.parse(JSON.stringify(await n.voiceHooks.tool({tool:'rover',move:'forward',ms:1000}))),{ok:false,code:'no_rover'});n.close();
});
test('Rover, 5: lifted, a move going is stopped at once and new ones are refused until it stands quietly again',async()=>{
  const r=pretendRover(),imu=fakeImu(),h=await launch({verified:true,imu,rover:r.I2C,saved:[['rover',true]]});await h.flush();
  const cycle=async ms=>{for(let t=0;t<ms;t+=100){h.time(h.clock()+100);h.tick();await h.flush();}};
  await arm(h);await cycle(4000); // the sensor knows the robot standing first (as the other motion tests)
  h.buttons.get('robottino:menu')();h.panels.at(-1).items.find(i=>i.label==='Prova rover').action();await h.flush();const moving=r.writes.length;
  assert.ok(r.writes.at(-1).slice(1).some(v=>v!==0),'turning');
  imu.set({side:30});await cycle(1500);
  assert.ok(r.writes.length>moving&&r.writes.slice(moving).some(w=>w.every(v=>v===0)),'stopped when lifted');
  h.buttons.get('robottino:menu')();h.panels.at(-1).items.find(i=>i.label==='Prova rover').action();await h.flush();
  assert.ok(r.writes.at(-1).every(v=>v===0),'no new move while lifted');
  h.close();
});
test('Rover from the iPhone (Live): only while it is connected; its STOP and its leaving stop the wheels',async()=>{
  const r=pretendRover(),h=await launch({withLive:true,verified:true,rover:r.I2C,saved:[['rover',true]]});await h.flush();
  assert.equal(h.liveHooks.rover('forward',500),false,'iPhone not connected');
  await arm(h);h.liveHooks.connected();await h.liveHooks.motion({yaw:0,pitch:0});h.time(h.clock()+1500);
  assert.equal(h.liveHooks.rover('forward',500),true);assert.ok(r.writes.at(-1).slice(1).some(v=>v!==0));
  h.liveHooks.stop(true);assert.deepEqual(r.writes.at(-1),[0,0,0,0,0],'STOP');
  h.liveHooks.rover('turnRight',500);h.liveHooks.stop(false);assert.deepEqual(r.writes.at(-1),[0,0,0,0,0],'the iPhone left');
  h.close();
});
test('Rover: no button without I2C in the host',async()=>{
  const h=await launch({});h.buttons.get('robottino:menu')();
  assert.ok(!h.panels.at(-1).items.some(i=>/Rover/.test(i.label)));h.close();
});
test('K210 camera: switched on before, it listens from the start; closing Robottino gives the pin back',async()=>{
  const h=await launch({withLive:true,k210:true});
  h.time(h.clock()+100);h.tick();await h.flush();
  assert.equal(h.serials.length,1);
  h.buttons.get('robottino:stop')();assert.equal(h.serials[0].closed,true);
});

// Lifted, shaken, fallen (motion-sense.js): the motion sensor as the host gives it, its readings set by the test.
const G=9.80665,DEGREE=Math.PI/180;
const fakeImu=()=>{
  const imu={started:0,stopped:0,start(){this.started++;},stop(){this.stopped++;},reading:{accelerometer:{x:0,y:G*Math.cos(27*DEGREE),z:G*Math.sin(27*DEGREE)},gyroscope:{x:0,y:0,z:0}},get sample(){return this.reading;},
    // The body leaning to a side by `side` degrees, the head up by `headUp` degrees (20 by default: where the motors
    // start it, mod.js START_PITCH), gravity `strength` times itself.
    set({side=0,headUp=20,strength=1,turn=0}={}){const a=(headUp+7)*DEGREE,s=side*DEGREE;/* the sensor reads 7° more than the pitch: motion-sense.js SENSOR_UP */this.reading={accelerometer:{x:Math.sin(s)*G*strength,y:Math.cos(a)*Math.cos(s)*G*strength,z:Math.sin(a)*Math.cos(s)*G*strength},gyroscope:{x:turn,y:0,z:0}};}};
  return imu;
};
const pet=h=>{for(const cb of h.touchListeners)cb({gesture:'forwardSwipe',intensity:3});};
// What is said (recordings, through the speaker), what is written on the screen and what the face does, as a test sees them.
const motionRobot=async(options={})=>{
  const imu=fakeImu(),h=await launch({verified:true,imu,...options}),shown=[];
  h.face.behavior.showMessage=(_face,text)=>shown.push(text);h.face.behavior.hideMessage=()=>{};
  const {HELD_PHRASES,SHAKEN_PHRASES,FALLEN_PHRASES}=await import('./motion-sense.js'),files=list=>list.map(([file])=>file),all=[...HELD_PHRASES,...SHAKEN_PHRASES,...FALLEN_PHRASES];
  const cycle=async ms=>{for(let t=0;t<ms;t+=100){h.time(h.clock()+100);h.tick();await h.flush();}};
  const spoken=()=>h.touches.map(touch=>touch.audio).filter(file=>files(all).includes(file));
  const face=()=>h.faceCalls.filter(([name])=>name==='emotion').at(-1)?.[1];
  const mouths=()=>h.faceCalls.filter(([name])=>name==='mouth').map(([,open])=>open);
  // Nothing of what is said is ever written (owner: «le frasi devono essere solo pronunciate, non scritte a video»).
  const written=()=>shown.filter(text=>all.some(([,words])=>words===text)||/Aiuto|Grazie|porti|piano/i.test(text));
  return {imu,h,cycle,spoken,face,mouths,written,held:files(HELD_PHRASES),shaken:files(SHAKEN_PHRASES),fallen:files(FALLEN_PHRASES)};
};
test('lifted: one recorded phrase, spoken and not written, the mouth moving with it, then the happy face; the head goes on working',async()=>{
  const {imu,h,cycle,spoken,face,mouths,written,held}=await motionRobot();
  assert.equal(imu.started,1,'the MOD starts the sensor: nobody else does');
  await arm(h);await cycle(4000);assert.deepEqual(spoken(),[],'standing on the desk: nothing');
  const before=h.poses.length,closedBefore=mouths().length;
  imu.set({side:30});await cycle(500);assert.deepEqual(spoken(),[],'not at once: it may be a fall beginning');
  await cycle(800);assert.equal(spoken().length,1);assert.ok(held.includes(spoken()[0]),'one of the phrases for being lifted');
  assert.notEqual(face(),3,'while it speaks, the usual face (the happy one has no mouths for talking)');
  await cycle(1000);assert.ok(mouths().slice(closedBefore).some(open=>open>0),'the mouth opens with the words');
  await cycle(2500);assert.equal(mouths().at(-1),0,'and is closed when the phrase is over');assert.equal(face(),3,'then the happy face');
  assert.deepEqual(written(),[],'nothing on the screen');
  // Held in the hand tilted back, as one holds it to look at its face: it still speaks (it did not, at first).
  pet(h);await cycle(500);assert.equal(h.poses.length,before+1,'held: the head still answers (owner: «devi comunque attivare i movimenti»)');
  assert.equal(spoken().length,1,'said once, however long it is held');
  imu.set({});await cycle(9000);assert.equal(face(),0,'the happy face lasts a few seconds');assert.deepEqual(written(),[]);
  h.close();assert.equal(imu.stopped,1);
});
test('while a phrase is being said the head stays still, and moves again as soon as it is over (owner, 14 Nov 2026)',async()=>{
  const {imu,h,cycle,spoken,mouths}=await motionRobot();
  await arm(h);await cycle(4000);const before=h.poses.length;
  imu.set({side:30});await cycle(1300);assert.equal(spoken().length,1,'the phrase has begun');
  pet(h);await cycle(600);assert.equal(h.poses.length,before,'no head command while it speaks');
  assert.equal(h.balloons.some(text=>/bloccati/.test(text)),false,'and that is not a fault of the motors');
  await cycle(3000);assert.equal(mouths().at(-1),0,'the phrase is over');
  pet(h);await cycle(500);assert.equal(h.poses.length,before+1,'the head answers again');
});
test('held in the hands tilted back 40°, as one holds it to look at its face: it speaks all the same',async()=>{
  const {imu,h,cycle,spoken,held}=await motionRobot();
  await arm(h);await cycle(4000);
  imu.set({headUp:40});await cycle(1500);assert.equal(spoken().length,1);assert.ok(held.includes(spoken()[0]));
});
test('turned over: only the call for help, in its voice, the scared face and the mouth moving; no phrase for being lifted on top',async()=>{
  const {imu,h,cycle,spoken,face,mouths,written,fallen}=await motionRobot();
  await arm(h);await cycle(4000);const closedBefore=mouths().length;
  imu.set({side:85});await cycle(1500);
  assert.deepEqual(spoken(),fallen,'the call for help, alone');assert.equal(face(),6,'the scared face (emotion 6)');assert.ok(mouths().slice(closedBefore).some(open=>open>0),'and it speaks');
  await cycle(20000);assert.equal(face(),6,'scared for as long as it lies there');assert.deepEqual(spoken(),fallen,'said once');assert.deepEqual(written(),[],'spoken, not written');
  // Stood up again at once: on its way up it is «held» for a moment, and says nothing.
  imu.set({});await cycle(3000);assert.equal(face(),0);assert.deepEqual(spoken(),fallen,'no phrase for being lifted, no thanks');
});
test('picked up after a fall and kept in the hand: the phrase for being lifted comes after a while, with the usual face and then the happy one',async()=>{
  const {imu,h,cycle,spoken,face,held,fallen}=await motionRobot();
  await arm(h);await cycle(4000);
  imu.set({side:85});await cycle(3000);assert.deepEqual(spoken(),fallen);
  imu.set({side:30,turn:40});await cycle(3000);assert.deepEqual(spoken(),fallen,'not yet: it may be on its way to standing');assert.equal(face(),6);
  await cycle(1500);assert.equal(spoken().length,2);assert.ok(held.includes(spoken()[1]),'still in the hand: «dove mi porti?» or another');
  await cycle(4000);assert.equal(face(),3);
});
test('turned over slowly: if the phrase for being lifted has begun, the call for help waits for it and is said after',async()=>{
  const {imu,h,cycle,spoken,held,fallen}=await motionRobot();
  await arm(h);await cycle(4000);
  imu.set({side:40});await cycle(1500);assert.equal(spoken().length,1);assert.ok(held.includes(spoken()[0]));
  imu.set({side:85});await cycle(2000);assert.deepEqual(spoken().slice(1),fallen,'one after the other, never two at once');
});
test('shaken: the angry face for a while and one recorded phrase, spoken and not written, the mouth moving',async()=>{
  const {imu,h,cycle,spoken,face,mouths,written,shaken}=await motionRobot();
  await arm(h);await cycle(4000);const closedBefore=mouths().length;
  for(let i=0;i<8;i++){imu.set({strength:i%2?2:.2});await cycle(100);}
  imu.set({});await cycle(1000);
  assert.equal(spoken().filter(file=>shaken.includes(file)).length,1,'one phrase for a shake');assert.ok(h.faceCalls.some(([name,value])=>name==='emotion'&&value===1));
  assert.ok(mouths().slice(closedBefore).some(open=>open>0));assert.deepEqual(written(),[]);
  await cycle(9000);assert.equal(face(),0,'and back to the usual face');assert.equal(mouths().at(-1),0);
});
test('lifted and then shaken while «dove mi porti?» is still being said: the phrase for the shake is said right after, not lost',async()=>{
  const {imu,h,cycle,spoken,face,held,shaken}=await motionRobot();
  await arm(h);await cycle(4000);
  imu.set({side:30});await cycle(1300);assert.equal(spoken().length,1);assert.ok(held.includes(spoken()[0]));
  // Shaken hard: readings far from 1 g, pointing anywhere.
  for(let i=0;i<12;i++){imu.reading={accelerometer:{x:(i%2?17:-3),y:(i%3?-12:9),z:(i%2?4:15)},gyroscope:{x:300,y:100,z:0}};await cycle(100);}
  imu.set({side:30});await cycle(1500);
  assert.equal(spoken().length,2,'two phrases, one after the other');assert.ok(shaken.includes(spoken()[1]),'the second is for the shake');
  assert.ok(h.faceCalls.some(([name,value])=>name==='emotion'&&value===1),'with the angry face');
  assert.equal(h.faceCalls.some(([name,value])=>name==='emotion'&&(value===2||value===6)),false,'never the scared face of a fall');
});
test('fallen, picked up and shaken: the shake is answered (it was ignored until the robot stood on the desk again)',async()=>{
  const {imu,h,cycle,spoken,face,shaken,fallen}=await motionRobot();
  await arm(h);await cycle(4000);
  imu.set({side:85});await cycle(3000);assert.deepEqual(spoken(),fallen);
  imu.set({side:30});await cycle(500);
  for(let i=0;i<12;i++){imu.reading={accelerometer:{x:(i%2?17:-3),y:(i%3?-12:9),z:(i%2?4:15)},gyroscope:{x:300,y:100,z:0}};await cycle(100);}
  imu.set({side:30});await cycle(1000);
  assert.equal(spoken().length,2);assert.ok(shaken.includes(spoken()[1]));assert.equal(h.faceCalls.filter(([name])=>name==='emotion').some(([,value])=>value===1),true);
});
test('in a conversation the robot says and shows nothing of this',async()=>{
  const {imu,h,cycle}=await motionRobot({withVoice:true});
  await arm(h);await cycle(4000);
  h.buttons.get('robottino:menu')();h.panels.at(-1).items.find(i=>i.label==='Parla').action();await h.flush();assert.equal(h.voiceFake.active,true,'a conversation is on');
  const sounds=h.touches.length,faces=h.faceCalls.filter(([name])=>name==='emotion').length;
  imu.set({side:30});await cycle(3000);imu.set({side:85});await cycle(3000);
  assert.equal(h.touches.length,sounds,'no recorded phrase over the conversation');assert.equal(h.faceCalls.filter(([name])=>name==='emotion').length,faces,'the face is the conversation\'s');
});
test('motors off, or a host without the sensor\'s reading: nothing is judged and nothing breaks',async()=>{
  const imu=fakeImu(),h=await launch({verified:true,imu}),shown=[];h.face.behavior.showMessage=(_face,text)=>shown.push(text);
  const cycle=async(ms)=>{for(let t=0;t<ms;t+=100){h.time(h.clock()+100);h.tick();await h.flush();}};
  imu.set({headUp:70});await cycle(5000);assert.deepEqual(shown.filter(text=>/Aiuto|Dove/.test(text)),[],'motors off: the head hangs back, that is not a fall');
  // An older host: the sensor has no `sample`.
  const old={started:0,start(){this.started++;}},o=await launch({verified:true,imu:old});
  for(let t=0;t<2000;t+=100){o.time(o.clock()+100);o.tick();await o.flush();}
  assert.equal(old.started,0,'not even started');
});

test('the large menu has no «Prova orecchie» (owner, 14 Nov 2026: «rimuovi dal menu prova orecchie»), with a host that can tell the side too',async()=>{
  const h=await launch({withLive:true,verified:true,ears:{value:0}});h.buttons.get('robottino:menu')();
  assert.equal(h.panels.at(-1).items.some(i=>/orecchie/i.test(i.label)),false);
});
// Asleep, the robot listens: a voice wakes it and the look around starts from that side (owner, 14 Nov 2026).
const sleepingRobot=async(options={})=>{
  const ears={value:0},h=await launch({withLive:true,withVoice:true,verified:true,ears,...options}),wakes=[];await arm(h);
  let alone=0;Object.defineProperty(h.liveFake,'selfActive',{get:()=>true,configurable:true});Object.defineProperty(h.liveFake,'selfAloneMs',{get:()=>alone,configurable:true});
  h.liveFake.selfWake=side=>{wakes.push(side);alone=0;return true;};
  const cycle=async ms=>{for(let t=0;t<ms;t+=100){h.time(h.clock()+100);h.tick();await h.flush();}};
  const packed=(level,lag,quality)=>level+65536*Math.round(quality*255)+16777216*(Math.round(lag*16)+128);
  const microphones=()=>h.serials.filter(port=>port.options.channels===2);
  // One piece of sound for each turn of the robot's cycle.
  const sound=async(pieces,level,lag,quality=.97)=>{const microphone=microphones().at(-1);ears.value=packed(level,lag,quality);for(let i=0;i<pieces;i++){microphone.queue.push(1,2,3,4);microphone.options.onReadable.call(microphone);await cycle(100);}};
  return {h,ears,wakes,cycle,sound,microphones,sleep:async()=>{alone=30000;await cycle(100);},alone:value=>{alone=value;}};
};
test('nobody in the room (23 Nov 2026: «se non c\'è nessuno, smetti di inseguire i visi»): 3 minutes without a movement of the presence sensor and following stops; the first movement starts it again',async()=>{
  let level=1;class Digital{static InputPullDown=2;constructor(){}read(){return level;}close(){}}
  const lines=[],h=await launch({withLive:true,verified:true,pir:Digital,trace:x=>lines.push(x)});await arm(h);
  let active=false;const asked=[];
  Object.assign(h.liveFake,{async self(on){asked.push(on);active=on;}});
  Object.defineProperty(h.liveFake,'selfActive',{get:()=>active,configurable:true});Object.defineProperty(h.liveFake,'selfAvailable',{get:()=>true,configurable:true});
  const cycle=async ms=>{for(let t=0;t<ms;t+=100){h.time(h.clock()+100);h.tick();await h.flush();}};
  await cycle(1000);assert.equal(active,true,'someone: following on');
  level=0;await cycle(170000);assert.equal(active,true,'under 3 minutes: still on');
  await cycle(11000);assert.equal(active,false,'3 minutes without a movement: off');
  assert.ok(lines.some(x=>/presence: nobody for 3 min/.test(x)));
  level=1;await cycle(1000);assert.equal(active,true,'someone moves: on again');
  assert.ok(lines.some(x=>/presence: someone again/.test(x)));
  h.close();
  // A sensor that never felt anything (unplugged, broken): following is never stopped by it.
  level=0;const lone=await launch({withLive:true,verified:true,pir:Digital});await arm(lone);let on=false;
  Object.assign(lone.liveFake,{async self(value){on=value;}});Object.defineProperty(lone.liveFake,'selfActive',{get:()=>on,configurable:true});Object.defineProperty(lone.liveFake,'selfAvailable',{get:()=>true,configurable:true});
  for(let t=0;t<200000;t+=100){lone.time(lone.clock()+100);lone.tick();await lone.flush();}
  assert.equal(on,true,'never felt: still following after 3 minutes');lone.close();
});
test('presence sensor AS312 (15 Nov 2026: «attivazione se in standby con sensore AS312»): asleep, a movement wakes the robot; awake or with no unit, nothing',async()=>{
  const opened=[];let level=0;
  class Digital{static InputPullDown=2;constructor(options){opened.push(options);}read(){return level;}close(){this.closed=true;}}
  const lines=[],{h,wakes,cycle,sleep,microphones}=await sleepingRobot({pir:Digital,trace:text=>lines.push(text)});
  assert.equal(JSON.stringify(opened),'[{"pin":8,"mode":2}]','G8 of Port B, with the pull-down');
  level=1;await cycle(3000);assert.deepEqual(wakes,[],'awake: the camera is already looking');
  level=0;await sleep();await cycle(2000);level=1;await cycle(2000);assert.deepEqual(wakes,[],'just asleep: the robot\'s own last moves');
  await cycle(2000);assert.deepEqual(wakes,[0],'asleep for 5 s and someone moves: awake, no side known');
  assert.ok(lines.some(line=>/presence: someone moved, waking/.test(line)));
  assert.equal(microphones().filter(port=>!port.closed).length,0,'the microphones of the sleep are closed first');
  await cycle(5000);assert.deepEqual(wakes,[0],'awake again: once');
  h.close();
  // No unit (the pull-down reads 0), and a robot told not to use it.
  const quiet=await sleepingRobot({pir:Digital});level=0;await quiet.sleep();await quiet.cycle(20000);assert.deepEqual(quiet.wakes,[]);quiet.h.close();
  opened.length=0;const off=await sleepingRobot({pir:Digital,saved:[['pir',false]]});assert.equal(opened.length,0,'preference pir false: the pin is not touched');
  level=1;await off.sleep();await off.cycle(10000);assert.deepEqual(off.wakes,[]);off.h.close();
});
test('asleep, both microphones open once the head is at rest; a voice wakes the robot and the look around starts from its side',async()=>{
  const {h,wakes,cycle,sound,microphones,sleep}=await sleepingRobot();
  await cycle(3000);assert.equal(microphones().length,0,'awake: the microphones are closed');
  await sleep();await cycle(1000);assert.equal(microphones().length,0,'just asleep: the head is still going to its place of rest');
  await cycle(2000);assert.equal(microphones().length,1);const microphone=microphones()[0];
  assert.equal(microphone.started,true);assert.equal(microphone.options.sampleRate,16000);
  // The room, then a knock: nothing.
  await sound(10,30,0,.3);await sound(2,3000,.06);await sound(5,30,0,.3);assert.deepEqual(wakes,[]);
  // A voice from the owner's left (delay +0,06): the robot's right.
  await sound(6,500,.06);
  assert.deepEqual(wakes,[-1],'woken, toward the robot\'s right');assert.equal(microphone.closed,true,'the microphones close before the head moves');
  await cycle(1000);assert.equal(microphones().length,1,'awake again: not listening');
  // Asleep once more, a voice from his right: the robot's left.
  await sleep();await cycle(8000);assert.equal(microphones().length,2);
  await sound(10,30,0,.3);await sound(6,500,-.22);assert.deepEqual(wakes,[-1,1]);
});
test('a voice whose side cannot be told still sends the look around to one side, and where the face is then found is written down',async()=>{
  const lines=[],{h,wakes,cycle,sound,microphones,sleep,alone}=await sleepingRobot({trace:text=>lines.push(text)});
  await sleep();await cycle(3000);assert.equal(microphones().length,1);
  // As on the robot at 15:57: the delay of the middle (−0,13): the side is not known.
  await sound(10,30,0,.3);await sound(6,271,-.13);
  assert.deepEqual(wakes,[1],'a guess, not «no side»: the look around must not begin upwards');
  assert.ok(lines.some(line=>/ear voice side 0 guess 1 lag -0\.13/.test(line)),lines.filter(l=>/ear/.test(l)).join(''));
  // The face is found a few seconds later: the pair goes on the log, once.
  Object.defineProperty(h.liveFake,'selfSeenMs',{get:()=>100,configurable:true});await cycle(300);
  assert.equal(lines.filter(line=>/ear check lag -0\.13 looked left face at yaw -?\d+ pitch -?\d+ after [\d.]+ s/.test(line)).length,1,lines.filter(l=>/ear/.test(l)).join(''));
  await cycle(1000);assert.equal(lines.filter(line=>/ear check/.test(line)).length,1);
});
test('asleep and listening: a conversation, a touch that laughs or a call from the iPhone close the microphones first; the app only connecting does not',async()=>{
  {const {h,cycle,microphones,sleep}=await sleepingRobot();await sleep();await cycle(3000);const microphone=microphones()[0];assert.equal(microphone?.started,true);
   h.liveHooks.connected();await cycle(500);assert.notEqual(microphone.closed,true,'the app connected: the robot goes on listening in its sleep');h.close();}
  for(const what of ['conversation','laugh','call']){
    const {h,cycle,microphones,sleep}=await sleepingRobot();
    await sleep();await cycle(3000);const microphone=microphones()[0];assert.equal(microphone?.started,true,what);
    if(what==='conversation'){h.buttons.get('robottino:menu')();h.panels.at(-1).items.find(i=>i.label==='Parla').action();}
    else if(what==='laugh'){for(const cb of h.touchListeners){cb({gesture:'press',intensity:3});cb({gesture:'release',tap:{durationMs:100}});}}
    else h.liveHooks.callStarting();
    assert.equal(microphone.closed,true,what+': closed at once, not a cycle later');
    await cycle(1000);assert.equal(microphones().length,1,what+': and not opened again meanwhile');
  }
});
test('asleep and listening, then a face: the microphones close; a host that cannot tell the side never opens them',async()=>{
  const {cycle,microphones,sleep,alone}=await sleepingRobot();
  await sleep();await cycle(3000);assert.equal(microphones().length,1);
  alone(0);await cycle(200);assert.equal(microphones()[0].closed,true,'somebody is there: awake');
  const old=await sleepingRobot({ears:undefined});await old.sleep();await old.cycle(5000);assert.equal(old.microphones().length,0);
});

// The Wi-Fi drops with no iPhone on the link: the head stays on the face it was following (14 Nov 2026).
test('the link ends by itself, or the app was only connected: the head stays where it is; after the iPhone drove it and left, it goes straight as before',async()=>{
  const h=await launch({withLive:true,verified:true});await arm(h);
  const cycle=async ms=>{for(let t=0;t<ms;t+=100){h.time(h.clock()+100);h.tick();await h.flush();}};
  // The head somewhere (a caress lifts it a little), then the link drops.
  pet(h);await cycle(500);const poses=h.poses.length;assert.ok(poses>=1);
  h.liveHooks.disconnected();await cycle(2000); // (the caress itself brings the head back after 3 s: looked at before that)
  assert.equal(h.poses.length,poses,'no command to the head: it stays where it was');
  // The app connected and gone without a command (15 Nov 2026): the robot was on its own all along, nothing to undo.
  await cycle(4000);const quiet=h.poses.length;h.liveHooks.connected();await cycle(300);h.liveHooks.disconnected();await cycle(1500);
  assert.equal(h.poses.filter(pose=>Math.abs(pose.rotation.y)<.002&&Math.abs(pose.rotation.p)<.002).length,h.poses.slice(0,quiet).filter(pose=>Math.abs(pose.rotation.y)<.002&&Math.abs(pose.rotation.p)<.002).length,'only connected: no going back straight');
  // The iPhone drove the head and then left: straight ahead, as the owner asked on 9 Nov.
  pet(h);await cycle(300);h.liveHooks.connected();await h.liveHooks.motion({yaw:20,pitch:-10}).catch(()=>{});await cycle(300);h.liveHooks.disconnected();await cycle(1500);
  const straightAfter=h.poses.filter(pose=>Math.abs(pose.rotation.y)<.002&&Math.abs(pose.rotation.p)<.002).length;
  assert.ok(straightAfter>=1,'the iPhone left: the head goes back straight');
});
// The log on the microSD card (sd-log.js), with a pretend card.
const pretendCard=()=>{
  const files=new Map(),folders=new Set();let uses=0;
  const missing=path=>{throw Error('not found: '+path);};
  const root={status(path){return {isFile:()=>files.has(path),isDirectory:()=>folders.has(path),size:files.get(path)?.length??0};},createDirectory(path){assert.equal(typeof path,'string');folders.add(path);},delete(path){return files.delete(path);},move(from,to){if(!files.has(from))missing(from);files.set(to,files.get(from));files.delete(from);},
    openFile({path,mode}){if(mode==='w')files.set(path,new Uint8Array(0));else if(!files.has(path))missing(path);return {status:()=>({size:files.get(path).length}),read:(count,position)=>files.get(path).slice(position,position+count).buffer,write(buffer,position){const old=files.get(path),bytes=new Uint8Array(buffer),next=new Uint8Array(Math.max(old.length,position+bytes.length));next.set(old);next.set(bytes,position);files.set(path,next);},close(){}};}};
  return {files,withCard(operation){uses++;return operation(root);},uses:()=>uses,text:name=>Buffer.from(files.get('robot/'+name)??[]).toString('latin1'),put(name,text){folders.add('robot');files.set('robot/'+name,new Uint8Array(Buffer.from(text,'latin1')));}};
};
test('the log on the microSD: every line the robot writes also goes to the card, the run before is shown at the start, closing writes the rest',async()=>{
  const card=pretendCard(),usb=[];card.put('log0.txt','13:00:00.000 [robottino] from the run before\n');
  const h=await launch({withLive:true,verified:true,card,trace:text=>usb.push(text)});
  assert.ok(usb.some(line=>line==='[sd] 13:00:00.000 [robottino] from the run before\n'),'the end of the run before, on the USB log: '+usb.slice(0,4).join('|'));
  assert.ok(usb.some(line=>/\[robottino\] sd log on/.test(line)));
  assert.equal(card.text('log1.txt'),'13:00:00.000 [robottino] from the run before\n','and kept one place down on the card');
  const cycle=async ms=>{for(let t=0;t<ms;t+=100){h.time(h.clock()+100);h.tick();await h.flush();}};
  await arm(h);await cycle(6000);
  const written=card.text('log0.txt');
  assert.match(written,/\[robottino\] sd log on\n/);assert.match(written,/\[robottino\] calibration /,'what the robot writes on the USB log is on the card too');
  assert.equal(/\[sd\] /.test(written),false,'what was shown from the card is not written to it again');
  assert.ok(usb.some(line=>/\[robottino\] calibration /.test(line)),'and still on the USB log');
  // Closing Robottino writes what is waiting and gives the host its own `trace` back.
  h.context.trace('[test] last line\n');const before=card.text('log0.txt').length;
  h.buttons.get('robottino:stop')();
  assert.match(card.text('log0.txt'),/\[test\] last line\n$/);assert.ok(card.text('log0.txt').length>before);
  usb.length=0;h.context.trace('after close\n');assert.deepEqual(usb,['after close\n']);assert.equal(/after close/.test(card.text('log0.txt')),false);
});
test('no card module in the host, or no card: Robottino starts and works as before',async()=>{
  const broken={withCard(){throw Error('no card');}},usb=[];
  const h=await launch({withLive:true,verified:true,card:broken,trace:text=>usb.push(text)});
  assert.ok(usb.some(line=>/sd log not available: no card/.test(line)));
  await arm(h);pet(h);h.time(h.clock()+100);h.tick();await h.flush();assert.equal(h.poses.length,1);
});
test('the agent\'s tools: a head move is «done» only once made, refused with a reason, never twice with the spoken command (14 Nov 2026)',async()=>{
  const h=await launch({withVoice:true,verified:true});
  const cycle=async ms=>{for(let t=0;t<ms;t+=100){h.time(h.clock()+100);h.tick();for(const [id,timer] of [...h.timeouts])if(timer.ms===50){h.timeouts.delete(id);timer.cb();}await h.flush();}};
  await arm(h);
  const [touch]=h.touchListeners,t0=h.clock();touch({gesture:'press',intensity:3});h.time(t0+600);h.tick();h.time(t0+1100);h.tick();await h.flush();touch({gesture:'release'});await cycle(1000);
  let answer,before=h.poses.length;void Promise.resolve(h.voiceHooks.tool({tool:'head',direction:'right',full:false})).then(value=>{answer=value;});
  await h.flush();assert.equal(answer,undefined,'not before the head has moved');
  await cycle(1500);assert.deepEqual(JSON.parse(JSON.stringify(answer)),{ok:true});assert.ok(h.poses.length>before,'moved');
  // The same command just recognised from the user's words: answered, not done again.
  h.voiceHooks.head({direction:'left'});await cycle(1500);before=h.poses.length;
  answer=undefined;void Promise.resolve(h.voiceHooks.tool({tool:'head',direction:'left',full:false})).then(value=>{answer=value;});
  await cycle(500);assert.deepEqual(JSON.parse(JSON.stringify(answer)),{ok:true});
  assert.equal(h.poses.length,before,'not twice');
  // A dance: within ±10° of where the head is, «done» at its end.
  answer=undefined;void Promise.resolve(h.voiceHooks.tool({tool:'dance'})).then(value=>{answer=value;});
  await cycle(1000);assert.equal(answer,undefined,'still dancing');await cycle(4000);assert.deepEqual(JSON.parse(JSON.stringify(answer)),{ok:true});
  // A face: as the spoken one.
  assert.deepEqual(JSON.parse(JSON.stringify(await h.voiceHooks.tool({tool:'face',expression:'sad'}))),{ok:true});assert.deepEqual(h.faceCalls.at(-1),['emotion',2]);
  // A timer: the robot's own line goes back.
  const set=await h.voiceHooks.tool({tool:'timer',action:'set',seconds:60,label:'pasta'});assert.equal(set.ok,true);assert.equal(set.text,'Timer di 1 minuto impostato: pasta.');
  // Motors switched off: refused at once, with the reason.
  h.buttons.get('robottino:motion')();await cycle(300);
  assert.deepEqual(JSON.parse(JSON.stringify(await h.voiceHooks.tool({tool:'head',direction:'up',full:false}))),{ok:false,code:'motors_off'});
  // The user's own words refused (motors off), then the agent's tool for the same: refused too, not «done»
  // (code review, 19 Nov 2026).
  h.voiceHooks.head({direction:'down'});
  assert.deepEqual(JSON.parse(JSON.stringify(await h.voiceHooks.tool({tool:'head',direction:'down',full:false}))),{ok:false,code:'motors_off'});
  h.close();
  assert.deepEqual(JSON.parse(JSON.stringify(await h.voiceHooks.tool({tool:'dance'}))),{ok:false,code:'closed'});
});
test('reminders at a clock time: saved on the robot, kept across a restart, said at their minute (14 Nov 2026)',async()=>{
  const at=Date.UTC(2026,10,15,8,0);
  const talk=async h=>{const [touch]=h.touchListeners,t0=h.clock();touch({gesture:'press',intensity:3});h.time(t0+600);h.tick();h.time(t0+1100);h.tick();await h.flush();touch({gesture:'release'});};
  const h=await launch({withVoice:true,verified:true});await arm(h);await talk(h);
  assert.deepEqual(JSON.parse(JSON.stringify(await h.voiceHooks.tool({tool:'reminder',action:'add',at,text:'chiamare Marco'}))),{ok:false,code:'clock'},'no time from the network yet');
  h.wallTime(Date.UTC(2026,10,14,17,0));
  assert.deepEqual(JSON.parse(JSON.stringify(await h.voiceHooks.tool({tool:'reminder',action:'add',at,text:'chiamare Marco'}))),{ok:true});
  assert.equal(h.balloons.at(-1),'Promemoria salvato: chiamare Marco');
  assert.deepEqual(JSON.parse(h.stored.get('clockReminders')),[{at,text:'chiamare Marco'}]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.voiceHooks.agenda())),[{at,text:'chiamare Marco'}]);
  h.close();
  // After a restart the reminder is still there, and is said at its minute.
  const again=await launch({withVoice:true,verified:true,saved:[['clockReminders',h.stored.get('clockReminders')]]});await arm(again);await talk(again);
  again.wallTime(at-60000);again.time(again.clock()+1100);again.tick();assert.notEqual(again.balloons.at(-1),'Promemoria: chiamare Marco');
  again.wallTime(at+1000);again.time(again.clock()+1100);again.tick();assert.equal(again.balloons.at(-1),'Promemoria: chiamare Marco');
  assert.deepEqual(JSON.parse(again.stored.get('clockReminders')),[],'said once');
  assert.deepEqual(JSON.parse(JSON.stringify(await again.voiceHooks.tool({tool:'reminder',action:'cancel',at}))),{ok:false,code:'missing'});
  again.close();
});
test('the volume goes to 100% when the MOD starts: the host\'s sounds and the amplifier (14 Nov 2026)',async()=>{
  let ampLevel=250;const amp={get volume(){return ampLevel;},set volume(value){ampLevel=value;}};
  const h=await launch({amp});assert.equal(h.robot.audio.volume,1,'the host\'s volume');assert.equal(ampLevel,246,'the amplifier: level 9, 246 (252 distorted again on 15 Nov)');h.close();
});
test('volume from the iPhone (15 Nov 2026): levels 1…10 on the amplifier, never above 252, saved for the next start',async()=>{
  let ampLevel=250;const amp={get volume(){return ampLevel;},set volume(value){ampLevel=value;}};
  const h=await launch({amp,withLive:true});h.liveHooks.connected();
  assert.equal(h.liveHooks.volume(10),true);assert.equal(ampLevel,252,'the loudest: 252');
  assert.equal(h.liveHooks.volume(1),true);assert.equal(ampLevel,198);
  assert.deepEqual(h.preferences.filter(([key])=>key==='volume'),[['volume',10],['volume',1]]);
  for(const wrong of [0,11,5.5,'7',null])assert.equal(h.liveHooks.volume(wrong),false,`refused: ${wrong}`);
  assert.equal(ampLevel,198,'a refused level changes nothing');
  assert.deepEqual(h.balloons.filter(text=>text.startsWith('Volume')),['Volume 10/10','Volume 1/10'],'on the screen, only for the levels taken');h.close();
  let again=250;const amp2={get volume(){return again;},set volume(value){again=value;}};
  const h2=await launch({amp:amp2,saved:[['volume',4]]});assert.equal(again,216,'the saved level comes back at start');h2.close();
  const h3=await launch({withLive:true});h3.liveHooks.connected();assert.equal(h3.liveHooks.volume(5),false,'no amplifier: not done');h3.close();
});
test('«guardalo e parla»: with a face in sight the microphones listen, a voice starts the conversation; face gone, they close (14 Nov 2026)',async()=>{
  const {h,cycle,sound,microphones}=await sleepingRobot({saved:[['gazeCall',true]]});let seen=Infinity;
  Object.defineProperty(h.liveFake,'selfSeenMs',{get:()=>seen,configurable:true});
  await cycle(1000);assert.equal(microphones().length,0,'nobody in sight: closed');
  seen=100;await cycle(200);assert.equal(microphones().length,1,'a face: listening');const microphone=microphones()[0];
  // The room, a knock, someone far: nothing.
  await sound(10,30,0,.3);await sound(2,3000,.06);assert.equal(h.voiceStarts(),0);
  // The face goes: the microphones close; it comes back: they open again.
  seen=4000;await cycle(200);assert.equal(microphone.closed,true,'face gone: closed');
  seen=100;await cycle(800);assert.equal(microphones().length,2,'face back: listening again');
  // A voice with the face there: the conversation starts, the microphones close first.
  await sound(10,30,0,.3);await sound(6,500,.06);await cycle(1500);
  assert.equal(microphones()[1].closed,true);assert.equal(h.voiceStarts(),1,'the conversation started');
  h.close();
});
test('«guardalo e parla» waits 2 s after a conversation before listening again (21 Nov 2026: the robot restarted as a conversation ended, a microphone opened while the conversation\'s was still closing)',async()=>{
  const {h,cycle,sound,microphones}=await sleepingRobot({saved:[['gazeCall',true]]});let seen=Infinity;
  Object.defineProperty(h.liveFake,'selfSeenMs',{get:()=>seen,configurable:true});
  seen=100;await cycle(200);assert.equal(microphones().length,1,'a face: listening');
  await sound(10,30,0,.3);await sound(6,500,.06);await cycle(1500);assert.equal(h.voiceStarts(),1,'the conversation started');
  // A conversation longer than the usual pause of the microphones, then it ends with the owner still in front.
  await cycle(7000);const before=microphones().length;
  h.voiceFake.active=false;h.voiceHooks.ended('user');
  await cycle(1500);assert.equal(microphones().length,before,'1.5 s after the end: not yet');
  await cycle(1500);assert.equal(microphones().length,before+1,'after 2 s: listening again');
  h.close();
});
test('«guardalo e parla» only with the app\'s «Chiamata se mi guardi» on (23 Nov 2026: «anche se la chiamata, se mi guardi, è disattivata, parte lo stesso»)',async()=>{
  const {h,cycle,microphones}=await sleepingRobot();
  Object.defineProperty(h.liveFake,'selfSeenMs',{get:()=>100,configurable:true});await cycle(2000);assert.equal(microphones().length,0,'switch off: not listening');h.close();
});
test('«guardalo e parla» can be switched off (preference lookToTalk false)',async()=>{
  const {h,cycle,microphones}=await sleepingRobot({saved:[['lookToTalk',false],['gazeCall',true]]});
  Object.defineProperty(h.liveFake,'selfSeenMs',{get:()=>100,configurable:true});await cycle(2000);assert.equal(microphones().length,0);h.close();
});
test('the reminder light goes out after ten seconds, or when a conversation starts (14 Nov 2026, «ora sta lampeggiando di viola»)',async()=>{
  const h=await launch({withVoice:true,withLive:true,verified:true,withLights:true,headCal:null});
  const last=()=>h.lightCalls.at(-1),pink=['blink','head',64,8,30,1000];
  h.face.behavior.onLongTouch();await h.flush();h.voiceFake.active=false;h.tick(); // a conversation before, ended
  h.liveHooks.reaction('attention');h.tick();assert.deepEqual(last(),pink);
  h.time(h.clock()+9000);h.tick();assert.deepEqual(last(),pink,'still lit before ten seconds');
  h.time(h.clock()+1000);h.tick();h.tick();assert.notDeepEqual(last(),pink,'out after ten seconds');
  h.liveHooks.reaction('attention');h.tick();assert.deepEqual(last(),pink);
h.voiceFake.active=true;h.tick();h.tick();assert.notDeepEqual(last(),pink,'a conversation starts: out');
  // Lit during a conversation: it stays for that conversation.
  h.liveHooks.reaction('attention');h.tick();assert.deepEqual(last(),pink,'lit during the call');h.time(h.clock()+1000);h.tick();assert.deepEqual(last(),pink,'it stays for its ten seconds');
  h.close();
});
test('«Prova duplex» (temporary): the microphones and the call\'s speaker open together, both orders, and the echo is measured (14 Nov 2026)',async()=>{
  const lines=[],{h,cycle,microphones,ears}=await sleepingRobot({trace:text=>lines.push(text)});
  const played=[];h.voiceFake.selfTest=async(sound,options)=>{played.push({open:microphones().filter(m=>!m.closed).length,options});await new Promise(resolve=>setTimeout(resolve,50));};
  h.face.behavior.onLongTouch();await h.flush();h.voiceFake.active=false; // the voice module is there, no conversation
  h.buttons.get('robottino:menu')();const item=h.panels.at(-1).items.find(i=>i.label==='Prova duplex');assert.ok(item,'in the menu');
  ears.value=200+65536*250+16777216*128;item.action();
  for(let i=0;i<60;i++){for(const [id,timer] of [...h.timeouts])if(timer.ms===1500||timer.ms===2000||timer.ms===600){h.timeouts.delete(id);timer.cb();}await new Promise(resolve=>setTimeout(resolve,5));await cycle(100);}
  assert.equal(played.length,2,'two rounds');assert.equal(played[0].open,1,'round 1: the microphones already open');assert.equal(played[1].open,0,'round 2: the speaker first');
  assert.ok(lines.some(line=>/duplex 1 microphones first: room/.test(line))&&lines.some(line=>/duplex 2 speaker first/.test(line)),lines.filter(l=>/duplex/.test(l)).join(''));
  assert.ok(microphones().every(m=>m.closed),'all closed at the end');assert.match(h.balloons.at(-1),/Prova finita/);
  h.close();
});
test('«Effetto Forza» in a conversation too (19 Nov 2026: «fallo funzionare anche in conversazione»): scared face for 2 s, even while Robottino speaks; no message (owner: «togli messaggio la forza»)',async()=>{
  const bus=pretendBus(),h=await launch({withVoice:true,verified:true,rover:bus.I2C});const [touch]=h.touchListeners,shown=[];
  h.face.behavior.showMessage=(_face,text,options)=>shown.push([text,options]);h.face.behavior.hideMessage=()=>{};
  touch({gesture:'press',intensity:3});h.time(2000);h.tick();await h.flush();assert.equal(h.voiceFake.active,true);touch({gesture:'release'});
  h.voiceFake.speaking=true;
  const emotions=()=>h.faceCalls.filter(([name])=>name==='emotion').map(([,value])=>value);
  let t=2000;const step=async mm=>{bus.range(mm);t+=50;h.time(t);h.tick();await h.flush();};
  for(let i=0;i<8;i++)await step(400);
  const before=emotions().length;
  for(const mm of [380,350,320,290,260,230,200,170,150,150])await step(mm);
  assert.ok(!shown.some(([text])=>text==='La forza!!!'),'no message');
  assert.equal(emotions().slice(before).at(-1),6,'scared');
  for(let i=0;i<50;i++)await step(150);
  assert.equal(emotions().at(-1),0,'after 2 s the face comes back, though Robottino is still speaking');
  h.close();
});
test('«Saluto» seen by the distance sensor (19 Nov 2026: «fai riconoscere il saluto, deve salutare con "ciao eccomi"»): a smile and «Ciao, eccomi!», once',async()=>{
  const lines=[],bus=pretendBus(),h=await launch({withVoice:true,verified:true,rover:bus.I2C,trace:x=>lines.push(x)});
  const emotions=()=>h.faceCalls.filter(([name])=>name==='emotion').map(([,value])=>value),hellos=()=>h.touches.filter(t=>t.audio==='ciao-eccomi.bin').length;
  let t=h.clock();const step=async mm=>{bus.range(mm);t+=50;h.time(t);h.tick();await h.flush();};
  for(let i=0;i<80;i++)await step(850); // the head has been still for a while (WAVE.stillMs)
  const before=hellos();
  const wave=[400,417,374,351,390,388,372,404,373,353,376,365,356,351,372,349,341,372,362,351,353,347,321,326,360,341,327,353,335,321,330,360,355,327,356];
  for(const mm of wave)await step(mm);
  assert.equal(hellos(),before+1,'«Ciao, eccomi!»');assert.ok(lines.some(x=>x.includes('wave seen by the distance sensor')),'in the log');assert.equal(emotions().at(-1),3,'a smile');
  for(const mm of wave)await step(mm);
  assert.equal(hellos(),before+1,'waving on: one hello');
  h.close();
});
test('Force push with the rover follows the hand (23 Nov 2026: «se indietreggia la mano, avanza il rover… se avanza la mano, indietreggia il rover, destra e sinistra»): back at first, then the hand kept where it was, left and right from the iPhone, let go when the hand goes',async()=>{
  const lines=[],bus=pretendBus(),h=await launch({withLive:true,verified:true,rover:bus.I2C,saved:[['rover',true]],trace:x=>lines.push(x)});await h.flush();
  await arm(h);h.liveHooks.connected(); // the app connected, as when the iPhone says where the hand is
  let t=h.clock();const step=async mm=>{bus.range(mm);t+=50;h.time(t);h.tick();await h.flush();};
  const moves=()=>lines.filter(x=>x.includes('[robottino] force follow ')&&!x.includes('starts')&&!x.includes('ends')),last=()=>bus.rover.writes.at(-1);
  assert.equal(h.liveHooks.forceFollowing(),false);assert.equal(h.liveHooks.handAt(.3),false,'nothing to follow yet');
  for(let i=0;i<10;i++)await step(600);
  for(const mm of [600,560,500,440,380,320,260,200,150])await step(mm);
  assert.ok(lines.some(x=>x.includes('force push')),'a push');assert.ok(lines.some(x=>x.includes('force follow starts')));
  assert.equal(h.liveHooks.forceFollowing(),true,'the iPhone is told: '+lines.filter(x=>/force|rover/.test(x)).join(' / '));assert.ok(moves().at(0).includes(' back'),'first the recoil: '+moves().at(0));
  for(let i=0;i<10;i++)await step(200); // settled at 20 cm
  // The hand goes away: forward once the head is back from the push and still, with a fresh reading (review «A»,
  // 23 Nov 2026: until then the rover waits, it does not let go).
  const before=moves().length;for(let i=0;i<40;i++)await step(300);  assert.ok(moves().slice(before).some(x=>x.includes('forward')),'the hand away: forward');
  for(let i=0;i<6;i++)await step(140); // the hand comes nearer
  assert.ok(moves().at(-1).includes('back'),'the hand nearer: back');
  assert.equal(h.liveHooks.handAt(.15),true);for(let i=0;i<4;i++)await step(200);
  assert.ok(moves().at(-1).includes('left'),'the hand on the robot\'s left of the picture: to the left; '+moves().at(-1));
  // A gesture read meanwhile is no gesture: the open hand would stop the rover.
  assert.equal(h.liveHooks.gesture('palm'),true);assert.ok(lines.some(x=>x.includes('hand gesture palm ignored: the Force follows the hand')));
  for(let i=0;i<20;i++)await step(2000); // the hand goes
  assert.ok(lines.some(x=>x.includes('force follow ends: hand gone')));assert.deepEqual(last().slice(1),[0,0,0,0],'stopped');
  assert.equal(h.liveHooks.forceFollowing(),false);
  const after=moves().length;for(let i=0;i<10;i++)await step(700);assert.equal(moves().length,after,'no more');
  // Held there for long: 20 s at most, then stopped.
  for(const mm of [600,560,500,440,380,320,260,200,150])await step(mm);
  for(let i=0;i<420;i++)await step(200);
  assert.ok(lines.some(x=>x.includes('force follow ends: time limit')),'the time limit');assert.deepEqual(last().slice(1),[0,0,0,0]);
  h.close();
});
test('«Effetto Forza» not while the head moves (21 Nov 2026: «come mai fa la faccia spaventata ogni tanto»): the sensor turns with the head; once settled, a push is a push',async()=>{
  const lines=[],bus=pretendBus(),h=await launch({withVoice:true,verified:true,rover:bus.I2C,trace:x=>lines.push(x)});await arm(h);
  const scared=()=>h.faceCalls.filter(([name,value])=>name==='emotion'&&value===6).length;
  let t=h.clock();const step=async mm=>{bus.range(mm);t+=50;h.time(t);h.tick();await h.flush();};
  for(let i=0;i<40;i++)await step(600);
  // A conversation starts: the head looks up (a move), and the sensor sweeps onto something close.
  const [touch]=h.touchListeners,poses=h.poses.length;touch({gesture:'press',intensity:3});
  for(let i=0;i<60&&h.poses.length===poses;i++)await step(600);
  touch({gesture:'release'});
  const before=scared();assert.ok(h.poses.length>poses,'the head moved');
  for(const mm of [600,500,400,300,200,150])await step(mm);
  assert.equal(scared(),before,'no push while the head moves');
  for(let i=0;i<40;i++)await step(600); // settled
  for(const mm of [600,500,400,300,200,150])await step(mm);
  assert.equal(scared(),before+1,'once settled, a push');
  assert.ok(!h.touches.some(t=>t.audio==='spavento.bin'),'in a conversation no sound: the speaker is the conversation\'s');
  h.close();
});
test('«Effetto Forza» with a scared sound (21 Nov 2026: «deve anche fare un verso di spavento»), and the head still recoils',async()=>{
  const bus=pretendBus(),h=await launch({verified:true,rover:bus.I2C});await arm(h);
  let t=h.clock();const step=async mm=>{bus.range(mm);t+=50;h.time(t);h.tick();await h.flush();};
  for(let i=0;i<40;i++)await step(600);
  const poses=h.poses.length;
  for(const mm of [600,500,400,300,200,150])await step(mm);
  assert.deepEqual(h.touches.filter(x=>x.audio).map(x=>x.audio),[],'not at once (23 Nov 2026: the hands lifting the robot read as a push)');
  for(let i=0;i<20;i++)await step(150);
  assert.deepEqual(h.touches.filter(x=>x.audio).map(x=>x.audio),['spavento.bin'],'«Aaah!» a moment later');
  assert.ok(h.poses.length>poses,'the head goes back all the same');
  h.close();
});
test('«Effetto Forza» not when the owner leans in (23 Nov 2026: «ogni tanto parte il verso… anche se non ho messo la mano»: followed by the head, he came closer and his face grew in the K210\'s picture); a hand pushed next to his face (the face the same size, 20:50) or hiding it still pushes',async()=>{
  const {encodeFrame}=await import('./k210.js');
  for(const [face,grow] of [[true,true],[true,false],[false,false]]){
    const bus=pretendBus(),lines=[],h=await launch({withLive:true,verified:true,rover:bus.I2C,k210:true,trace:x=>lines.push(x)});await arm(h);
    let t=h.clock(),seq=0,w=.3;const camera=()=>h.serials.find(port=>port.options.baud===115200);
    const step=async mm=>{bus.range(mm);t+=50;h.time(t);h.tick();camera()?.feed(encodeFrame(face?{seq:seq++,faces:1,x:.5,y:.5,w,h:.4,score:.9,ms:69}:{seq:seq++,ms:69}));await h.flush();};
    for(let i=0;i<40;i++)await step(600);
    assert.ok(camera(),'the K210 line is open');
    for(const mm of [600,500,400,300,200,150]){if(grow)w+=.04;await step(mm);}
    for(let i=0;i<30;i++)await step(150);
    const sounds=h.touches.filter(x=>x.audio).map(x=>x.audio),label=`face ${face}, grows ${grow}`;
    if(grow){assert.deepEqual(sounds,[],label+': his own face coming closer, no «Aaah!»');assert.ok(lines.some(x=>/force push .* ignored: a face in sight, closer/.test(x)),label);}
    else assert.deepEqual(sounds,['spavento.bin'],label+': the Force');
    h.close();
  }
});
test('«Ha scambiato la vittoria con la forza» (23 Nov 2026): while the iPhone watches the video for gestures, a hand brought in slowly is a gesture, not the Force; a quick push still is («non mi riconosce più la mano aperta per la forza»)',async()=>{
  for(const [video,fast,force] of [[true,false,false],[true,true,true],[false,false,true]]){
    const near=150;
    const bus=pretendBus(),lines=[],h=await launch({withLive:true,verified:true,rover:bus.I2C,trace:x=>lines.push(x)});await arm(h);
    h.live.videoOn=video;
    let t=h.clock();const step=async mm=>{bus.range(mm);t+=50;h.time(t);h.tick();await h.flush();};
    for(let i=0;i<40;i++)await step(600);
    // Slow: 20 mm every 50 ms (400 mm/s at most over the window); fast: from 600 to 150 mm in 150 ms.
    for(const mm of fast?[600,400,250,near]:[600,580,560,540,520,500,480,460,440,420,400,380,360,340,320,300,280,260,240,220,200,180,160,near])await step(mm);
    for(let i=0;i<30;i++)await step(near);
    const sounds=h.touches.filter(x=>x.audio).map(x=>x.audio),label=`video ${video}, ${fast?'fast':'slow'}`;
    if(force)assert.deepEqual(sounds,['spavento.bin'],label);
    else{assert.deepEqual(sounds,[],label);assert.ok(lines.some(x=>/force push .* ignored: a hand shown to the iPhone/.test(x)),label);}
    h.close();
  }
});
test('«Togli il verso di esclamazione quando alzo il robottino» (23 Nov 2026): the hands that lift it read as a push, the robot is then moved: no «Aaah!»; standing untouched it comes',async()=>{
  for(const lifted of [true,false]){
    const bus=pretendBus(),imu=fakeImu(),lines=[],h=await launch({verified:true,rover:bus.I2C,imu,trace:x=>lines.push(x)});await arm(h);
    let t=h.clock();const step=async mm=>{bus.range(mm);t+=50;h.time(t);h.tick();await h.flush();};
    for(let i=0;i<40;i++)await step(600);
    for(const mm of [600,500,400,300,200,150])await step(mm);
    if(lifted)imu.set({turn:200,strength:1.1}); // picked up: turning and gravity off
    for(let i=0;i<40;i++)await step(150);
    assert.deepEqual(h.touches.filter(x=>x.audio).map(x=>x.audio),lifted?[]:['spavento.bin'],lifted?'lifted: no sound '+lines.filter(x=>/force/.test(x)).join(''):'untouched: the sound');
    if(lifted)assert.ok(lines.some(x=>/force sound dropped: handled/.test(x)),'said on the log');
    h.close();
  }
});
test('«Chiamata con lo sguardo» (21 Nov 2026: «far partire la chiamata dopo 10 secondi che mi guarda fisso»): off unless switched on; 10 s of a face opens the call once; again only after looking away',async()=>{
  const lines=[],h=await launch({withLive:true,withVoice:true,verified:true,saved:[['lookToTalk',false]],trace:x=>lines.push(x)});h.liveHooks.connected();await arm(h);
  let seen=Infinity;Object.defineProperty(h.liveFake,'selfActive',{get:()=>true,configurable:true});
  Object.defineProperty(h.liveFake,'selfAloneMs',{get:()=>0,configurable:true});Object.defineProperty(h.liveFake,'selfSeenMs',{get:()=>seen,configurable:true});
  const cycle=async ms=>{for(let t=0;t<ms;t+=100){h.time(h.clock()+100);h.tick();await h.flush();}};
  seen=100;await cycle(12000);assert.equal(h.voiceStarts(),0,'switched off: nothing '+lines.filter(x=>/voice|look|gaze/.test(x)).join(''));
  assert.equal(h.liveHooks.gazeCalling(),false);
  assert.equal(h.liveHooks.gazeCall(true),true);assert.equal(h.liveHooks.gazeCalling(),true);assert.deepEqual(h.preferences.filter(([key])=>key==='gazeCall').at(-1),['gazeCall',true]);
  await cycle(9000);assert.equal(h.voiceStarts(),0,'9 s: not yet');
  seen=2000;await cycle(300);seen=100;await cycle(9500);assert.equal(h.voiceStarts(),0,'the face went away for 2 s: the 10 s start again');
  await cycle(800);assert.equal(h.voiceStarts(),1,'10 s of the face: the conversation opens');
  // The conversation ends with the owner still looking: no new call 10 s later.
  h.voiceFake.active=false;await cycle(15000);assert.equal(h.voiceStarts(),1,'still looking after the call: nothing');
  seen=4000;await cycle(300);seen=100;await cycle(10500);assert.equal(h.voiceStarts(),2,'looked away, then 10 s again: a new call');
  h.voiceFake.active=false;assert.equal(h.liveHooks.gazeCall(false),true);seen=5000;await cycle(300);seen=100;await cycle(12000);assert.equal(h.voiceStarts(),2,'switched off again');
  h.close();
});
test('«Saluto» only with the head still for 2.5 s (21 Nov 2026: hellos to nobody while the head looked around, 1.6 s at each place)',async()=>{
  const lines=[],bus=pretendBus(),h=await launch({withVoice:true,verified:true,rover:bus.I2C,trace:x=>lines.push(x)});await arm(h);
  const waves=()=>lines.filter(x=>x.includes('wave seen by the distance sensor')).length;
  let t=h.clock();const step=async mm=>{bus.range(mm);t+=50;h.time(t);h.tick();await h.flush();};
  const wave=[400,417,374,351,390,388,372,404,373,353,376,365,356,351,372,349,341,372,362,351];
  for(let i=0;i<60;i++)await step(600);
  // The head moves (a conversation opens and it looks up), settles, and what it now points at reads like a wave.
  const [touch]=h.touchListeners,poses=h.poses.length;touch({gesture:'press',intensity:3});
  for(let i=0;i<60&&h.poses.length===poses;i++)await step(600);
  touch({gesture:'release'});assert.ok(h.poses.length>poses,'the head moved');
  for(let i=0;i<14;i++)await step(600);
  for(const mm of wave)await step(mm);
  assert.equal(waves(),0,'1.7 s after the head moved: not a wave');
  for(let i=0;i<40;i++)await step(600);
  for(const mm of [...wave,...wave])await step(mm);
  assert.equal(waves(),1,'the head still for long: a wave');
  h.close();
});
test('«Saluto» not while the robot is in the hands (23 Nov 2026: «lui continua a dire ciao, eccomi»), and again 3 s after',async()=>{
  const lines=[],bus=pretendBus(),imu=fakeImu(),h=await launch({withVoice:true,verified:true,rover:bus.I2C,imu,trace:x=>lines.push(x)});await arm(h);
  const waves=()=>lines.filter(x=>x.includes('wave seen by the distance sensor')).length;
  let t=h.clock();const step=async mm=>{bus.range(mm);t+=50;h.time(t);h.tick();await h.flush();};
  const wave=[400,417,374,351,390,388,372,404,373,353,376,365,356,351,372,349,341,372,362,351];
  for(let i=0;i<60;i++)await step(600);
  imu.set({turn:120});for(const mm of [...wave,...wave])await step(mm);
  assert.equal(waves(),0,'turned about in the hands: not a wave');
  imu.set();for(let i=0;i<70;i++)await step(600);
  for(const mm of [...wave,...wave])await step(mm);
  assert.equal(waves(),1,'put down and still: a wave again');
  assert.match(lines.find(x=>x.includes('wave seen'))??'',/two apart \d+ mm: \d+(,\d+){11}/,'the 12 readings on the log');
  h.close();
});
test('«Esplora» without the rover (23 Nov 2026: «muovo io il robot, inquadro degli oggetti e lui deve pronunciare e dire cosa sono»): from the iPhone a conversation opens, then a picture every few seconds and never a move; stopped from the iPhone',async()=>{
  const lines=[],h=await launch({withLive:true,withVoice:true,verified:true,trace:x=>lines.push(x)});await arm(h);h.liveHooks.connected();
  const told=[];let pictures=0;h.voiceFake.explore=(on,say,still)=>{told.push([on,say,still]);return true;};h.voiceFake.picture=()=>true;h.voiceFake.look=()=>{};
  h.live.snapshot=async()=>{pictures++;return true;};
  let t=h.clock();const run=async ms=>{for(const end=t+ms;t<end;){t+=100;h.time(t);h.tick();await h.flush();}};
  assert.equal(h.liveHooks.explore(true),true,'accepted: a conversation is opened for it');assert.equal(h.liveHooks.exploring(),true);
  await run(500);assert.equal(h.voiceStarts(),1);assert.deepEqual(told,[],'not before the conversation is ready');
  h.voiceHooks.listening();await run(300);
  assert.deepEqual(told,[[true,true,true]],'started, still: '+lines.filter(x=>x.includes('explore')).join(' / '));assert.ok(lines.some(x=>x.includes('explore starts (iphone, still: carried by hand)')));
  await run(40000);assert.ok(pictures>=3&&pictures<=5,'one picture every 10 s at most: '+pictures);
  assert.ok(!lines.some(x=>/rover (move|forward|turn)/.test(x)),'no move');
  assert.equal(h.liveHooks.explore(false),true);assert.equal(h.liveHooks.exploring(),false);assert.deepEqual(told.at(-1).slice(0,2),[false,false],'ended, no sentence of its own');
  assert.equal(h.voiceFake.active,false,'manual exploration stop closes speech and drops queued replies');
  const before=pictures;await run(20000);assert.equal(pictures,before,'stopped');h.close();
});

test('rover exploration photographs at alternating heights only after the wheels and head settle',async()=>{
  const bus=pretendBus(),lines=[],h=await launch({withLive:true,withVoice:true,verified:true,rover:bus.I2C,saved:[['rover',true]],trace:x=>lines.push(x)});
  await h.flush();await arm(h);h.liveHooks.connected();
  h.voiceFake.explore=()=>true;h.voiceFake.picture=()=>true;h.voiceFake.look=()=>{};
  const shots=[],due=new Map();let t=h.clock(),poseAt=-Infinity,writes=bus.rover.writes.length,forwards=0;
  const setPose=h.robot.motion.setPose;
  h.robot.motion.setPose=(...args)=>{poseAt=t;return setPose(...args);};
  h.live.snapshot=async()=>{
    const last=h.poses.at(-1),p=last?.rotation.p??0;
    assert.ok(t-poseAt>=300,'head settled before photograph');
    shots.push(Math.round(p*180/Math.PI));
    assert.deepEqual(bus.rover.writes.at(-1),[0,0,0,0,0],'wheels stopped before photograph');
    return true;
  };
  assert.equal(h.liveHooks.explore(true),true);h.voiceHooks.listening();
  for(const end=t+100000;t<end&&shots.length<5;){
    t+=100;bus.range(1200);h.time(t);
    for(const [id,timer] of [...h.timeouts]){
      if(!due.has(id))due.set(id,t+timer.ms);
      if(t>=due.get(id)){h.timeouts.delete(id);due.delete(id);timer.cb();}
    }
    h.tick();await h.flush();
    for(const write of bus.rover.writes.slice(writes)){
      if(write.length===5&&write[0]===0&&write.slice(1).every(v=>v>0&&v<128)){
        forwards++;
        assert.ok(Math.abs(h.poses.at(-1)?.rotation.p??0)<=5*Math.PI/180,'every forward segment has the head level');
        assert.ok(t-poseAt>=300,'head settled before every forward segment');
      }
    }
    writes=bus.rover.writes.length;
  }
  assert.deepEqual(shots,[0,-25,-50,-25,0],lines.filter(x=>/explore|error|Errore/.test(x)).join(' / '));
  assert.ok(forwards>=4,'forward travel resumes between scans');
  h.liveHooks.explore(false);h.close();
});

test('stopping exploration during a vertical move cancels the photograph and all later scan poses',async()=>{
  const bus=pretendBus(),h=await launch({withLive:true,withVoice:true,verified:true,rover:bus.I2C,saved:[['rover',true]]});
  await h.flush();await arm(h);h.liveHooks.connected();
  h.voiceFake.explore=()=>true;h.voiceFake.picture=()=>true;h.voiceFake.look=()=>{};
  let finish,shots=0;const due=new Map(),setPose=h.robot.motion.setPose;
  h.robot.motion.setPose=(...args)=>{setPose(...args);return new Promise(resolve=>{finish=resolve;});};
  h.live.snapshot=async()=>{shots++;return true;};
  let t=h.clock();h.liveHooks.explore(true);h.voiceHooks.listening();
  for(const end=t+20000;t<end&&!finish;){
    t+=100;bus.range(1200);h.time(t);
    for(const [id,timer] of [...h.timeouts]){if(!due.has(id))due.set(id,t+timer.ms);if(t>=due.get(id)){h.timeouts.delete(id);due.delete(id);timer.cb();}}
    h.tick();await h.flush();
  }
  assert.ok(finish,'scan head motion started');
  h.liveHooks.explore(false);finish();await h.flush();
  for(let i=0;i<20;i++){t+=100;h.time(t);h.tick();await h.flush();}
  assert.equal(shots,0);assert.equal(h.liveHooks.exploring(),false);assert.equal(h.voiceFake.active,false);h.close();
});

test('forward (not exploring) needs a fresh distance read with the head still, wherever the head looks (review «A», 23 Nov 2026)',async()=>{
  const bus=pretendBus(),h=await launch({withLive:true,verified:true,rover:bus.I2C,saved:[['rover',true]]});
  await h.flush();await arm(h);h.liveHooks.connected();
  const cycle=async ms=>{for(let i=0;i<ms;i+=100){h.time(h.clock()+100);h.tick();await h.flush();}};
  await h.liveHooks.motion({yaw:0,pitch:-25});bus.range(1500);await cycle(1000);
  assert.equal(h.liveHooks.rover('forward',500),false,'the reading was taken while the head moved');
  bus.range(1500);await cycle(100);
  assert.equal(h.liveHooks.rover('forward',500),true,'25° up, still, a new reading: forward as before');
  await h.liveHooks.motion({yaw:0,pitch:-35});
  assert.equal(h.liveHooks.rover('forward',500),false,'not while the head moves');h.close();
});

test('a long spoken answer before the scan pose starts does not consume its motion timeout',async()=>{
  const bus=pretendBus(),lines=[],h=await launch({withLive:true,withVoice:true,verified:true,rover:bus.I2C,saved:[['rover',true]],trace:x=>lines.push(x)});
  await h.flush();await arm(h);h.liveHooks.connected();h.voiceFake.explore=()=>true;h.voiceFake.picture=()=>true;h.voiceFake.look=()=>{};
  let shots=0,t=h.clock();const start=t,due=new Map();h.live.snapshot=async()=>{shots++;return true;};h.liveHooks.explore(true);h.voiceHooks.listening();
  for(;t<start+55000;){
    t+=100;h.voiceFake.speaking=(t-start)%10000>=100;bus.range(1200);h.time(t);
    for(const [id,timer] of [...h.timeouts]){if(!due.has(id))due.set(id,t+timer.ms);if(t>=due.get(id)){h.timeouts.delete(id);due.delete(id);timer.cb();}}
    h.tick();await h.flush();
    assert.equal(h.liveHooks.exploring(),true,lines.filter(x=>x.includes('explore ends')).join(' / '));
  }
  assert.ok(!lines.some(x=>x.includes('head timeout')));h.liveHooks.explore(false);h.close();
});
test('review of the rover (23 Nov 2026): the iPhone\'s STOP and its rover keys end the exploration, and the agent says why',async()=>{
  for(const [what,act] of [['stop',h=>h.liveHooks.stop(true)],['taken',h=>h.liveHooks.rover('back',500)]]){
    const bus=pretendBus(),lines=[],h=await launch({withLive:true,withVoice:true,verified:true,rover:bus.I2C,saved:[['rover',true]],trace:x=>lines.push(x)});
    await h.flush();await arm(h);h.liveHooks.connected();
    const told=[];h.voiceFake.explore=(...a)=>{told.push(a);return true;};h.voiceFake.picture=()=>true;h.voiceFake.look=()=>{};h.live.snapshot=async()=>true;
    let t=h.clock();const run=async ms=>{for(const end=t+ms;t<end;){t+=100;bus.range(1200);h.time(t);h.tick();await h.flush();}};
    assert.equal(h.liveHooks.explore(true),true);h.voiceHooks.listening();await run(3000);
    assert.equal(h.liveHooks.exploring(),true,what+': exploring with the rover: '+lines.filter(x=>x.includes('explore')).join(' / '));
    act(h);assert.equal(h.liveHooks.exploring(),false,what+': ended');
    assert.ok(lines.some(x=>x.includes(`explore ends: ${what}`)),what);assert.deepEqual(told.at(-1).slice(0,2),[false,true],what+': the agent says why');
    const writes=bus.rover.writes.length;await run(8000);
    assert.ok(bus.rover.writes.slice(writes).every(w=>w.slice(1).every(v=>v<=0)||w.slice(1).every(v=>v===0)||what==='taken'),what+': no forward of the exploration after it');
    assert.ok(!lines.slice(-200).some(x=>x.includes('explore look')),what+': no more pictures');h.close();
  }
});
test('review of the rover (23 Nov 2026): forward only with the head (where the sensor is) turned at most 20° to a side, also outside the exploration',async()=>{
  const bus=pretendBus(),h=await launch({withLive:true,verified:true,rover:bus.I2C,saved:[['rover',true]]});
  await h.flush();await arm(h);h.liveHooks.connected();
  const cycle=async ms=>{for(let i=0;i<ms;i+=100){h.time(h.clock()+100);h.tick();await h.flush();}};
  await h.liveHooks.motion({yaw:40,pitch:-20});await cycle(1000);bus.range(1500);await cycle(100);
  assert.equal(h.liveHooks.rover('forward',500),false,'head 40° to the side: the sensor does not look where the wheels go');
  assert.equal(h.liveHooks.rover('turnLeft',500),true,'turning is not forward');h.liveHooks.rover('stop',200);
  await h.liveHooks.motion({yaw:15,pitch:-20});await cycle(1000);bus.range(1500);await cycle(100);
  assert.equal(h.liveHooks.rover('forward',500),true,'15° to the side, 20° up: forward');h.close();
});
test('review of the rover (23 Nov 2026): after a failed write the rover is looked for again by itself and comes back',async()=>{
  const bus=pretendBus(),lines=[],h=await launch({withLive:true,verified:true,rover:bus.I2C,saved:[['rover',true]],trace:x=>lines.push(x)});
  await h.flush();await arm(h);h.liveHooks.connected();
  const cycle=async ms=>{for(let i=0;i<ms;i+=100){h.time(h.clock()+100);h.tick();await h.flush();}};
  await h.liveHooks.motion({yaw:0,pitch:-20});await cycle(1000);
  bus.rover.fail=true;assert.equal(h.liveHooks.rover('back',500),false,'the write fails');
  await cycle(300);assert.ok(h.balloons.some(b=>b.includes('riprovo')),'said: '+h.balloons.slice(-3).join(' / '));
  bus.rover.fail=false;await cycle(6000);
  assert.ok(h.balloons.some(b=>b.includes('di nuovo collegato')),'back: '+h.balloons.slice(-3).join(' / '));
  assert.equal(h.liveHooks.rover('back',500),true,'usable again without a restart');h.close();
});
