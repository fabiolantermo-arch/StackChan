// Lifted, shaken, fallen: what the robot makes of its motion sensor. Pure arithmetic: no sensor, no motors.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HELD_PHRASES,SHAKEN_PHRASES,FALLEN_PHRASES,pickPhrase,MotionSense,bodyTilt,SENSOR_UP,G,HELD_TILT,HELD_MS,FALLEN_TILT,FALLEN_MS,DOWN_MS,MOVING_G,SHAKE_G,SHAKE_MS,SHAKE_AGAIN_MS} from './motion-sense.js';
const DEG=Math.PI/180;
// Gravity as the sensor in the head reads it: the head up by headUp degrees, the body leaning back by lean degrees
// (the same turn, about the same axis) or to a side by side degrees; strength in g.
const gravity=({headUp=0,lean=0,side=0,strength=1}={})=>{
  const a=(headUp+lean)*DEG+SENSOR_UP,s=side*DEG; // the sensor reads SENSOR_UP more than the head's pitch
  return {x:Math.sin(s)*G*strength,y:Math.cos(a)*Math.cos(s)*G*strength,z:Math.sin(a)*Math.cos(s)*G*strength};
};
const still={x:0,y:0,z:0};
// Feeds one reading every 100 ms and collects what is said.
const run=(sense,from,ms,reading)=>{
  const said=[];
  for(let now=from;now<from+ms;now+=100){const r=typeof reading==='function'?reading(now):reading,event=sense.update(r.a,r.turn??still,r.head??{},now);if(event)said.push([event,now-from]);}
  return said;
};
test('the tilt of the body: zero wherever the head looks, and the lean of the body when it leans',()=>{
  for(const headUp of [0,25,52,85]){
    assert.ok(bodyTilt(gravity({headUp}),-headUp*DEG)<1e-6,`head up ${headUp}°: the body stands`);
    assert.ok(Math.abs(bodyTilt(gravity({headUp,lean:20}),-headUp*DEG)-20*DEG)<1e-6);
    assert.ok(Math.abs(bodyTilt(gravity({headUp,side:30}),-headUp*DEG)-30*DEG)<.02);
  }
  assert.ok(bodyTilt({x:0,y:-G,z:0},0)>170*DEG,'upside down');
  assert.equal(bodyTilt({x:0,y:0,z:0},0),undefined,'no reading, no tilt');
});
test('standing on the desk, head anywhere, for a minute: nothing is said',()=>{
  const sense=new MotionSense();let n=0;
  const said=run(sense,0,60000,()=>{const headUp=[0,25,52,85][Math.floor(n++/50)%4];return {a:gravity({headUp,strength:1+.02*Math.sin(n)}),turn:{x:1,y:-2,z:1},head:{pitch:-headUp*DEG}};});
  assert.deepEqual(said,[]);assert.equal(sense.state,'down');
});
test('the head looking up 60° is not a fall (the host\'s own rule would say fallen backwards)',()=>{
  const sense=new MotionSense();
  assert.deepEqual(run(sense,0,5000,{a:gravity({headUp:60}),head:{pitch:-60*DEG}}),[]);
});
test('lifted: the body tilts, and after a moment the robot is held; put down upright and quiet, it is down again',()=>{
  const sense=new MotionSense();run(sense,0,1000,{a:gravity({headUp:25}),head:{pitch:-25*DEG}});
  const up=run(sense,1000,2000,{a:gravity({headUp:25,side:25}),head:{pitch:-25*DEG}});
  assert.deepEqual(up.map(([event])=>event),['held']);assert.ok(up[0][1]>=HELD_MS&&up[0][1]<=HELD_MS+100,`after ${up[0][1]} ms`);
  const down=run(sense,3000,5000,{a:gravity({headUp:25}),head:{pitch:-25*DEG}});
  assert.deepEqual(down.map(([event])=>event),['down']);assert.ok(down[0][1]>=DOWN_MS&&down[0][1]<=DOWN_MS+100);
});
test('a tilt that lasts less than the wait (a push on the screen, a knock) is not a lift',()=>{
  const sense=new MotionSense();
  const said=run(sense,0,6000,now=>({a:gravity({side:now%2000<HELD_MS-100?25:0})}));
  assert.deepEqual(said,[]);
});
test('carried without tilting (a walk with the robot in the hand): pushed about without pause, and that is enough',()=>{
  const sense=new MotionSense();let n=0;
  const said=run(sense,0,3000,()=>({a:gravity({strength:1+(n++%2?MOVING_G+.05:-(MOVING_G+.03))}),turn:{x:40,y:0,z:0}}));
  assert.equal(said[0]?.[0],'held');assert.ok(said[0][1]<=900);
});
test('a hand that only touches the head is not a lift: the head turns on its motors, the body stays where it is (seen on the robot, 14 Nov 2026)',()=>{
  // Owner: «appena la tocco mi dice che bella vista da quassù, anche senza sollevarla». As read then: the turn up to
  // 179°/s, gravity off by 0,03 g, the body tilted 9° at most.
  const sense=new MotionSense();run(sense,0,1000,{a:gravity({headUp:52}),head:{pitch:-52*DEG}});
  let n=0;const touched=()=>{const k=n++;return {a:gravity({headUp:52,lean:k%2?9:-6,strength:1+(k%2?.03:-.03)}),turn:{x:179,y:120,z:60},head:{pitch:-52*DEG}};};
  assert.deepEqual(run(sense,1000,10000,touched),[],'ten seconds of touching and pushing the head: nothing');
  assert.equal(sense.state,'down');
});
test('the head moving by itself is not a hand: its jolts are not counted, and the tilt allows for the move under way',()=>{
  const sense=new MotionSense();
  // The head turns and nods all the time: the sensor feels it, with still:false, and the pose is up to 30° behind.
  const said=run(sense,0,20000,now=>({a:gravity({headUp:25+28*Math.sin(now/300),strength:1.2}),turn:{x:90,y:60,z:0},head:{pitch:-25*DEG,slack:30*DEG,still:false}}));
  assert.deepEqual(said,[]);assert.equal(sense.state,'down');
});
test('fallen on a side: said after half a second; picked up it is held, and down only once it stands quiet',()=>{
  const sense=new MotionSense();run(sense,0,1000,{a:gravity()});
  const fall=run(sense,1000,3000,{a:gravity({side:85})});
  assert.deepEqual(fall.map(([event])=>event),['held','fallen'],'through held on its way down');assert.ok(fall[1][1]>=FALLEN_MS&&fall[1][1]<=FALLEN_MS+100);
  assert.deepEqual(run(sense,4000,20000,{a:gravity({side:85})}),[],'lying there: nothing more');assert.equal(sense.state,'fallen');
  const pick=run(sense,24000,1000,{a:gravity({side:30}),turn:{x:40,y:0,z:0}});assert.deepEqual(pick.map(([event])=>event),['held']);
  const stand=run(sense,25000,4000,{a:gravity()});assert.deepEqual(stand.map(([event])=>event),['down']);
});
test('upside down and flat on its back are falls too',()=>{
  for(const a of [{x:0,y:-G,z:0},gravity({lean:90}),gravity({lean:-90}),gravity({side:-90})]){
    const sense=new MotionSense(),said=run(sense,0,2000,{a});assert.equal(said.at(-1)[0],'fallen');
  }
});
test('held and tilted for a long time (carried in a hand) never becomes down by itself',()=>{
  const sense=new MotionSense();run(sense,0,1000,{a:gravity({side:30})});
  assert.deepEqual(run(sense,1000,60000,{a:gravity({side:30})}),[]);assert.equal(sense.state,'held');
});
test('shaken: three hard jolts in a little more than a second, once, and again only after a pause',()=>{
  const sense=new MotionSense();
  const jolt=now=>({a:gravity({strength:(now/100)%2?1+SHAKE_G+.2:.3})});
  const first=run(sense,0,1000,jolt);assert.equal(first.filter(([event])=>event==='shaken').length,1);
  const more=run(sense,1000,SHAKE_AGAIN_MS-1500,jolt);assert.equal(more.filter(([event])=>event==='shaken').length,0,'not again at once');
  const later=run(sense,SHAKE_AGAIN_MS+500,1000,jolt);assert.equal(later.filter(([event])=>event==='shaken').length,1);
});
test('one knock on the desk, or two far apart, is not a shake',()=>{
  const sense=new MotionSense();
  const said=run(sense,0,10000,now=>({a:gravity({strength:now%(SHAKE_MS+400)===0?2:1})}));
  assert.deepEqual(said,[]);
});
test('motors off (the head hangs where it was left): no tilt is judged, a shake still is; what was held is let go',()=>{
  const sense=new MotionSense();
  assert.deepEqual(run(sense,0,5000,{a:gravity({headUp:70}),head:{pitch:0,posed:false}}),[],'the head hanging back is not a fall');
  run(sense,5000,1000,{a:gravity({side:30})});assert.equal(sense.state,'held');
  assert.deepEqual(run(sense,6000,300,{a:gravity({side:30}),head:{posed:false}}).map(([event])=>event),['down']);
  let n=0;const shaken=run(sense,7000,1000,()=>({a:gravity({strength:n++%2?2:.2}),head:{posed:false}}));
  assert.ok(shaken.some(([event])=>event==='shaken'));
});
test('motors off and turned over (23 Nov 2026: «non lo riconosce più quando lo capovolgo»): fallen after half a second; stood up again, down',()=>{
  const sense=new MotionSense();
  // The two the owner did: 97° and 117° from where the body stands (gravity as the robot read it, head left 20° up).
  for(const lean of [97,117,180]){
    const s=new MotionSense(),said=run(s,0,1500,{a:gravity({headUp:20,lean}),head:{pitch:-20*DEG,posed:false}});
    assert.deepEqual(said,[['fallen',FALLEN_MS]],`turned ${lean}°`);
    assert.deepEqual(run(s,1500,300,{a:gravity({headUp:20}),head:{pitch:-20*DEG,posed:false}}).map(([event])=>event),['down']);
  }
  // The head hanging far up with the body standing (motors off) is not over; nor a robot lying a little.
  assert.deepEqual(run(sense,0,3000,{a:gravity({headUp:80}),head:{pitch:-20*DEG,posed:false}}),[]);
  // Picked up while still shaking: stays fallen until it is still.
  run(sense,3000,1000,{a:gravity({headUp:20,lean:150}),head:{pitch:-20*DEG,posed:false}});assert.equal(sense.state,'fallen');
  assert.deepEqual(run(sense,4000,300,{a:gravity({headUp:20,strength:1.4}),head:{pitch:-20*DEG,posed:false}}),[]);assert.equal(sense.state,'fallen');
});
test('a reading with nothing in it changes nothing and breaks nothing',()=>{
  const sense=new MotionSense();
  assert.equal(sense.update(undefined,undefined,{},0),undefined);assert.equal(sense.update({x:0,y:0,z:0},still,{},100),undefined);
  assert.equal(sense.update(gravity(),undefined,{},200),undefined,'no turn reading: gravity alone');assert.equal(sense.state,'down');
});

test('the phrases the owner chose (three for lifted, four for shaken, one for fallen), each with its recording in the MOD',async()=>{
  const {readFileSync,existsSync}=await import('node:fs');
  const manifest=JSON.parse(readFileSync(new URL('./manifest.json',import.meta.url),'utf8')).resources['*'];
  assert.deepEqual(HELD_PHRASES.map(([,words])=>words),['Ehi, dove mi porti?','Uh, sto volando!','Oh, che bella vista da quassù!']);
  assert.deepEqual(SHAKEN_PHRASES.map(([,words])=>words),['Ehi, piano, piano!','Oh, mi gira la testa!','Aiuto, il terremoto!','Ma che succede?']);
  assert.equal(manifest.filter(name=>/\.bin$/.test(name)&&!/risata|avviso|prova-voce|sbadiglio|ciao-eccomi|oh-uffa|spavento/.test(name)).length,8,'no recording in the MOD that is never said');
  assert.deepEqual(FALLEN_PHRASES.map(([,words])=>words),['Aiuto, rimettimi in piedi!']);
  for(const [file,words] of [...HELD_PHRASES,...SHAKEN_PHRASES,...FALLEN_PHRASES]){
    assert.ok(words.length<=40,'short enough for the screen');
    assert.ok(manifest.includes('./assets/'+file),file+' is in the manifest');
    const path=new URL('./assets/'+file,import.meta.url);assert.ok(existsSync(path),file);
    // The same format as the laugh: WAV PCM16 mono 16 kHz, plain header, one to three seconds.
    const wav=readFileSync(path);assert.equal(wav.toString('latin1',0,4),'RIFF');assert.equal(wav.toString('latin1',36,40),'data');
    assert.equal(wav.readUInt16LE(22),1);assert.equal(wav.readUInt32LE(24),16000);assert.equal(wav.readUInt16LE(34),16);
    const seconds=wav.readUInt32LE(40)/32000;assert.ok(seconds>=1&&seconds<=3,`${file}: ${seconds} s`);
  }
});
test('one phrase at random, never the same twice running',()=>{
  const seen=new Set();let last;
  for(let i=0;i<200;i++){const phrase=pickPhrase(SHAKEN_PHRASES,last,(i*.37)%1);assert.notEqual(phrase,last);seen.add(phrase);last=phrase;}
  assert.equal(seen.size,SHAKEN_PHRASES.length,'all of them come up');
  assert.equal(pickPhrase(SHAKEN_PHRASES,undefined,0),SHAKEN_PHRASES[0]);assert.equal(pickPhrase(SHAKEN_PHRASES,undefined,.999),SHAKEN_PHRASES.at(-1));
  const only=[['a.bin','A']];assert.equal(pickPhrase(only,only[0],.5),only[0],'a single phrase is said again');
});

test('the mouth of every phrase: worked out from its recording, as the file in the MOD says, open on the words and closed at the end',async()=>{
  const {readFileSync}=await import('node:fs');
  const {mouthTrack,phraseSamples,mouthsModule,MOUTH_STEP_MS}=await import('./prepare-phrase.mjs');
  const {PHRASE_MOUTHS,PHRASE_MOUTH_MS}=await import('./phrase-mouths.js');
  assert.equal(PHRASE_MOUTH_MS,MOUTH_STEP_MS);
  assert.equal(readFileSync(new URL('./phrase-mouths.js',import.meta.url),'utf8'),await mouthsModule(),'phrase-mouths.js is what prepare-phrase.mjs writes from the recordings now in assets/');
  const {WAKE_HELLO}=await import('./wake-up.js');
  const {HAND_SOUNDS}=await import('./live-wire.js');
  const phrases=[...HELD_PHRASES,...SHAKEN_PHRASES,...FALLEN_PHRASES,[WAKE_HELLO],[HAND_SOUNDS.thumbsDown]]; // and «Ciao, eccomi!» of waking up, «Oh-oh-oh, uffa.» of the thumb down
  assert.deepEqual(Object.keys(PHRASE_MOUTHS).sort(),phrases.map(([file])=>file).sort(),'one for each phrase, none for a phrase taken out');
  for(const [file] of phrases){
    const wav=readFileSync(new URL('./assets/'+file,import.meta.url)),track=PHRASE_MOUTHS[file];
    assert.equal(track,mouthTrack(phraseSamples(wav)));assert.match(track,/^[0-4]+0$/,'steps 0…4, closed at the end');
    const seconds=wav.readUInt32LE(40)/32000;assert.ok(Math.abs(track.length*PHRASE_MOUTH_MS/1000-seconds)<=.3,`${file}: as long as the recording`);
    const open=[...track].filter(step=>step!=='0').length/track.length;assert.ok(open>.5,`${file}: the mouth is open for most of the phrase (${open})`);
    assert.ok(track.includes('4'),`${file}: wide open on the loudest part`);
  }
  // Silence gives a closed mouth; a loud tone an open one.
  assert.equal(mouthTrack(new Int16Array(3200)),'0');
  assert.match(mouthTrack(Int16Array.from({length:3200},(_,i)=>Math.round(20000*Math.sin(i/3)))),/^4+0$/);
});

test('shaken hard in the hand is not a fall: thrown about, the sensor says nothing of the tilt (seen on the robot, 14 Nov 2026)',()=>{
  const sense=new MotionSense();run(sense,0,1000,{a:gravity()});
  // Ten seconds of shaking: every reading far from 1 g and pointing anywhere, upside down too.
  let n=0;const wild=()=>{const k=n++,strength=k%2?1.9:.2;return {a:{x:Math.sin(k*1.7)*G*strength,y:Math.cos(k*2.3)*G*strength,z:Math.sin(k*.9)*G*strength},turn:{x:300,y:200,z:100}};};
  const said=run(sense,1000,10000,wild).map(([event])=>event);
  assert.equal(said.includes('fallen'),false,'never taken for a fall');
  assert.ok(said.filter(event=>event==='shaken').length>=3,'and the shakes are felt, again and again');
  assert.equal(sense.state,'held','handled, all the while');
  // Put down: standing again.
  assert.deepEqual(run(sense,11000,3000,{a:gravity()}).map(([event])=>event),['down']);
});
test('a real fall, with its knock: said once the robot lies still',()=>{
  const sense=new MotionSense();run(sense,0,1000,{a:gravity()});
  const knock=run(sense,1000,300,{a:gravity({side:85,strength:2.2})}).map(([event])=>event);assert.equal(knock.includes('fallen'),false,'not during the knock');
  const lying=run(sense,1300,1500,{a:gravity({side:85})});assert.equal(lying.at(-1)[0],'fallen');assert.ok(lying.at(-1)[1]<=700,`said ${lying.at(-1)[1]} ms after it lies still`);
  // A knock while it lies there does not stand it up.
  assert.deepEqual(run(sense,2800,500,{a:gravity({side:85,strength:1.8})}).filter(([event])=>event!=='shaken'),[]);assert.equal(sense.state,'fallen');
});
