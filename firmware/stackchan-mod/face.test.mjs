// Real face module + real state/reaction helpers, with Piu capability fakes.
// Does not replace a native renderer/texture-memory test on hardware.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createContext,SourceTextModule,SyntheticModule} from 'node:vm';
async function setup(){
  let now=1000;class Clock extends Date {static now(){return now;}}
  class Behavior {}
  class Content {constructor(_data,options){Object.assign(this,options);}}
  class Container extends Content {
    constructor(data,options){super(data,options);this.time=1000;this.children=[];this.events=[];this.behavior=options.Behavior?new options.Behavior():undefined;this.behavior?.onCreate?.(this);}
    add(content){this.children.push(content);}remove(content){this.children=this.children.filter(c=>c!==content);}insert(content,before){const i=this.children.indexOf(before);this.children.splice(i<0?this.children.length:i,0,content);}start(){this.running=true;}stop(){this.running=false;}bubble(event){this.events.push(event);}
  }
  class Label extends Content {}
  class Column extends Content {}
  class Text extends Content {}
  class Style {constructor(options){Object.assign(this,options);}}
  class Texture {constructor(name){assert.ok(existsSync(new URL('./assets/'+name,import.meta.url)));this.name=name;}}
  class Skin {constructor(options){Object.assign(this,options);}}
  const context=createContext({Behavior,Date:Clock,Map,Set,Math,Number,String});
  const piu=new SyntheticModule(['Column','Container','Content','Label','Skin','Style','Text','Texture'],function(){this.setExport('Column',Column);this.setExport('Text',Text);this.setExport('Container',Container);this.setExport('Content',Content);this.setExport('Label',Label);this.setExport('Style',Style);this.setExport('Skin',Skin);this.setExport('Texture',Texture);},{context});
  const modules=new Map([['piu/MC',piu]]);
  const paths={'robottino-portrait-state':'portrait-state.js','robottino-touch-reaction':'touch-reaction.js'};
  const face=new SourceTextModule(await readFile(new URL('./face.js',import.meta.url),'utf8'),{context});
  await face.link(async name=>{if(!modules.has(name))modules.set(name,new SourceTextModule(await readFile(new URL(paths[name],import.meta.url),'utf8'),{context}));return modules.get(name);});
  await face.evaluate();const view=face.namespace.createExpressiveFace();
  const mouth=()=>{const m=view.children[0].children[0];return m.visible?m.skin.texture.name:null;};
  return{view,time:value=>{now=value;view.time=value;view.behavior.onTimeChanged(view);},frame:()=>view.children[0].skin.texture.name,mouth,box:()=>({...view.children[0].children[0].coordinates})};
}
test('touch smile yields to speech and restores the latest base expression',async()=>{
  const h=await setup();assert.equal(h.frame(),'girl-neutral.png');
  assert.equal(h.view.behavior.preservePositionOnSwap,false,'host keeps the full-screen position');
  h.view.behavior.reactToTouch('head',{gesture:'press'});h.time(1100);assert.equal(h.frame(),'girl-happy.png');assert.equal(h.view.children.length,1);
  h.view.behavior.onFaceUpdate(h.view,{emotion:2,mouth:{open:.8}});h.time(1200);assert.equal(h.frame(),'girl-neutral.png','the touch smile is still on: talking over the serene face');assert.equal(h.mouth(),'girl-mouth-8.png');
  h.view.behavior.onFaceUpdate(h.view,{emotion:2,mouth:{open:0}});h.time(4100);assert.equal(h.frame(),'girl-sad.png');assert.equal(h.mouth(),null);assert.equal(h.view.children.length,1);
  h.view.behavior.onFaceUpdate(h.view,{emotion:1,mouth:{open:0}});h.time(4200);assert.equal(h.frame(),'girl-angry.png','emotion 1: the angry picture (11 Nov 2026)');
});
test('dance preserves mouth and blink; disposal prevents any restart or late touch',async()=>{
  const h=await setup();h.view.behavior.setDanceActive(true);h.time(1100);assert.equal(h.frame(),'girl-happy.png');
  h.view.behavior.onFaceState(h.view,{mouth:{open:.3}});h.time(1200);assert.equal(h.frame(),'girl-neutral.png');assert.equal(h.mouth(),'girl-mouth-3.png','just under talk-small');
  h.view.behavior.rehydrate(h.view,{eyes:{left:{open:0},right:{open:0}}});h.time(1300);assert.equal(h.frame(),'girl-blink.png');assert.equal(h.mouth(),null,'the blinking picture has its own mouth');
  h.view.behavior.dispose(h.view);const events=h.view.events.length;
  h.view.behavior.onDisplaying(h.view);h.view.behavior.reactToTouch('head',{gesture:'press'});h.time(3500);
  assert.equal(h.view.running,false);assert.equal(h.view.active,false);assert.equal(h.view.events.length,events);assert.equal(h.frame(),'girl-blink.png');
});
test('white robot head supports emotion and talking frames',async()=>{
 const h=await setup();h.view.behavior.setStyle(h.view,'white');assert.equal(h.frame(),'white-neutral.png');
 h.view.behavior.setStyle(h.view,'redhead');assert.equal(h.frame(),'red-neutral.png');h.view.behavior.setStyle(h.view,'white');
 assert.throws(()=>h.view.behavior.setStyle(h.view,'toString'));
 h.view.behavior.onFaceUpdate(h.view,{emotion:3});h.time(1100);assert.equal(h.frame(),'white-happy.png');
 h.view.behavior.onFaceUpdate(h.view,{mouth:{open:.8}});h.time(1200);assert.equal(h.frame(),'white-neutral.png');assert.equal(h.mouth(),'white-mouth-4.png');
});
test('the mouth is a small picture over the serene face, in eight openings, changed as soon as the host reports it',async()=>{
  const h=await setup(),{MOUTH_POSES,mouthPose,MOUTH_LEVELS,mouthLevel,MOUTH_IMAGES,moodMouthImage}=await import('./portrait-state.js'),seen=[];
  assert.deepEqual(MOUTH_POSES.map(mouthPose),[0,1,2,3,4],'the poses the Worker sends come back unchanged');
  // 12 Nov 2026 («la bocca… è a scatti»): eight levels, two a pose; each pose is the even level.
  assert.deepEqual(MOUTH_LEVELS.map(mouthLevel),[0,1,2,3,4,5,6,7,8]);assert.deepEqual(MOUTH_POSES.map(mouthLevel),[0,2,4,6,8]);
  for(const images of Object.values(MOUTH_IMAGES))assert.equal(images.length,MOUTH_LEVELS.length);
  assert.deepEqual(MOUTH_LEVELS.map((_,level)=>moodMouthImage(level)),[0,1,1,2,2,3,3,4,4],'the angry and sad faces keep their four mouths');
  for(const open of [0,.18,.35,.58,.8,1,.05]){h.view.behavior.onFaceUpdate(h.view,{mouth:{open}});seen.push(h.mouth());}
  assert.deepEqual(seen,[null,'girl-mouth-2.png','girl-mouth-4.png','girl-mouth-6.png','girl-mouth-8.png','girl-mouth-8.png','girl-mouth-1.png'],'no wait for the 66 ms tick');
  h.view.behavior.onFaceUpdate(h.view,{mouth:{open:.03}});assert.equal(h.mouth(),null,'closed');
  h.view.behavior.onFaceUpdate(h.view,{mouth:{open:.58}});assert.equal(h.frame(),'girl-neutral.png','the face itself is not redrawn');
  assert.deepEqual(h.box(),{left:126,top:172,width:72,height:54});
  h.view.behavior.setStyle(h.view,'redhead');assert.equal(h.mouth(),'red-mouth-6.png');assert.deepEqual(h.box(),{left:132,top:175,width:66,height:50});
  h.view.behavior.setStyle(h.view,'white');assert.equal(h.mouth(),'white-mouth-4.png','the white robot keeps its two drawn mouths');
  h.view.behavior.onFaceUpdate(h.view,{mouth:{open:.18}});assert.equal(h.mouth(),'white-mouth-2.png');
});

test('white head and screen touch smile without overlays',async()=>{
 const h=await setup();h.view.behavior.setStyle(h.view,'white');h.view.behavior.reactToTouch('head',{gesture:'press'});h.time(1100);
 assert.equal(h.frame(),'white-happy.png');assert.equal(h.view.children.length,1);h.time(4100);assert.equal(h.frame(),'white-neutral.png');
 h.view.behavior.reactToTouch('head',{gesture:'press'});h.time(4200);assert.equal(h.frame(),'white-happy.png');assert.equal(h.view.children.length,1);
 assert.throws(()=>h.view.behavior.setStyle(h.view,'blue'));
});

test('robot messages use a large Open Sans bubble with Latin-1 text and can be replaced or hidden',async()=>{
  const h=await setup();h.time(1100);
  h.view.behavior.showMessage(h.view,'Abbina il robot: nell’app apri Robot → Abbina robot e scrivi «123 456»…');
  assert.equal(h.view.children.length,2);const bubble=h.view.children[1],text=bubble.contents[0];
  assert.equal(text.style.font,'OpenSans-Regular-24');assert.equal(bubble.bottom,6);
  assert.equal(text.string,'Abbina il robot: nell\'app apri Robot > Abbina robot e scrivi "123 456"...');
  h.view.behavior.showMessage(h.view,'Mi collego.');assert.equal(h.view.children.length,2);assert.equal(h.view.children[1].contents[0].string,'Mi collego.');
  h.view.behavior.hideMessage(h.view);assert.equal(h.view.children.length,1);
  h.time(1200);assert.equal(h.frame(),'girl-neutral.png','portrait stays the first child');
});

test('a long screen touch opens the large menu, a short one never laughs; buttons run their action',async()=>{
  const h=await setup();h.time(1100);let opened=0,laughs=0;h.view.behavior.onLongTouch=()=>opened++;h.view.behavior.onLocalTouch=()=>laughs++;
  h.view.behavior.onTouchBegan(h.view,0,0,0,2000);h.view.behavior.onTouchEnded(h.view,0,0,0,2900);
  assert.equal(opened,1);assert.equal(laughs,0);assert.deepEqual(h.view.events,[],'no face touch reaction');
  h.view.behavior.onTouchBegan(h.view,0,0,0,5000);h.view.behavior.onTouchEnded(h.view,0,0,0,5200);assert.equal(opened,1);assert.equal(laughs,0,'a short screen tap never laughs');assert.deepEqual([...h.view.events],['onFaceTouch']);
  const pressed=[];h.view.behavior.showPanel(h.view,{title:'Menu di Robottino',items:[{label:'Hardware verificato: no',action:()=>pressed.push('hw')},{label:'Chiudi',action:()=>pressed.push('close')}]});
  const panel=h.view.children.at(-1),column=panel.contents[0];
  assert.equal(column.contents[0].string,'Menu di Robottino');assert.equal(column.contents[0].style.font,'OpenSans-Regular-20');
  assert.equal(column.contents[1].contents[0].string,'Hardware verificato: no');assert.ok(column.contents[1].active);
  column.contents[1].behavior.onTouchEnded(column.contents[1]);column.contents[2].behavior.onTouchEnded(column.contents[2]);
  assert.deepEqual(pressed,['hw','close']);
  h.view.behavior.showMessage(h.view,'Hardware verificato: attivato.');assert.equal(h.view.children.at(-1),panel,'messages stay below the open menu');
  h.view.behavior.hidePanel(h.view);assert.ok(!h.view.children.includes(panel));
});

test('informative messages disappear after 8 s, sticky ones stay',async()=>{
  const h=await setup();h.time(1100);
  h.view.behavior.showMessage(h.view,'Hardware verificato: attivato.');assert.equal(h.view.children.length,2);
  h.time(8000);assert.equal(h.view.children.length,2);h.time(9200);assert.equal(h.view.children.length,1,'gone after 8 s');
  h.view.behavior.showMessage(h.view,'Abbina il robot: scrivi 123 456',{sticky:true});h.time(30000);assert.equal(h.view.children.length,2,'pairing code stays');
  assert.equal(h.view.behavior.stickyMessage(),true,'the pairing code is known to be there');
  h.view.behavior.hideMessage(h.view);assert.equal(h.view.behavior.stickyMessage(),false);
  // «La forza!!!» (19 Nov 2026): a short message, as long as the scared face.
  h.view.behavior.showMessage(h.view,'La forza!!!',{ms:2000});assert.equal(h.view.behavior.stickyMessage(),false);
  h.time(31500);assert.equal(h.view.children.length,2);h.time(32100);assert.equal(h.view.children.length,1,'gone after 2 s');
  // A passing message over the pairing code: the code comes back when it goes (code review, 19 Nov 2026).
  h.view.behavior.showMessage(h.view,'Abbina il robot: scrivi 123 456',{sticky:true});
  h.view.behavior.showMessage(h.view,'Rover: il sensore di distanza non risponde più.');assert.equal(h.view.children.at(-1).contents[0].string,'Rover: il sensore di distanza non risponde più.');
  h.view.behavior.showMessage(h.view,'La forza!!!',{ms:2000});
  h.time(34200);assert.equal(h.view.children.at(-1).contents[0].string,'Abbina il robot: scrivi 123 456','the code is back');assert.equal(h.view.behavior.stickyMessage(),true);
  h.view.behavior.hideMessage(h.view);h.time(50000);assert.equal(h.view.children.length,1,'hidden on purpose: it stays hidden');
});

test('a two-column panel shows up to 12 smaller buttons on one screen',async()=>{
  const h=await setup();h.time(1100);const pressed=[];
  const items=Array.from({length:13},(_,i)=>({label:'Voce '+i,action:()=>pressed.push(i)}));
  h.view.behavior.showPanel(h.view,{title:'Menu di Robottino',items,columns:2});
  const panel=h.view.children.at(-1),[title,...buttons]=panel.contents;
  assert.equal(title.string,'Menu di Robottino');assert.equal(buttons.length,12,'at most 12');assert.equal(h.view.behavior.panelOpen,true);
  assert.deepEqual([buttons[0].coordinates?.left??buttons[0].left,buttons[1].coordinates?.left??buttons[1].left],[10,163]);
  const last=buttons[11],top=last.coordinates?.top??last.top,height=last.coordinates?.height??last.height;assert.ok(top+height<=240,'fits the 240-pixel screen');
  assert.equal(buttons[0].contents[0].style.font,'OpenSans-Regular-16');
  buttons[11].behavior.onTouchEnded(buttons[11]);assert.deepEqual(pressed,[11]);
  h.view.behavior.hidePanel(h.view);assert.equal(h.view.behavior.panelOpen,false);
});
test('the open panel can change its title without rebuilding the buttons (head sensor zones in the menu)',async()=>{
  const h=await setup();h.time(1100);
  h.view.behavior.showPanel(h.view,{title:'Menu di Robottino',items:[{label:'Chiudi'}],columns:2});
  const panel=h.view.children.at(-1),[title,button]=panel.contents;
  h.view.behavior.setPanelTitle(h.view,'Menu · sensore testa 0 3 1');
  assert.equal(title.string,'Menu · sensore testa 0 3 1');assert.equal(h.view.children.at(-1),panel,'same panel');assert.equal(panel.contents[1],button,'same buttons');
  h.view.behavior.hidePanel(h.view);assert.doesNotThrow(()=>h.view.behavior.setPanelTitle(h.view,'x'),'no panel: nothing happens');
});
test('every face shows its own angry picture for emotion 1, and goes back to neutral (11 Nov 2026)',async()=>{
  const h=await setup();let t=1100;
  for(const [style,prefix] of [['white','white-'],['redhead','red-'],['portrait','girl-']]){
    h.view.behavior.setStyle(h.view,style);
    h.view.behavior.onFaceUpdate(h.view,{emotion:1,mouth:{open:0}});h.time(t+=100);assert.equal(h.frame(),prefix+'angry.png',style);
    h.view.behavior.onFaceUpdate(h.view,{emotion:0,mouth:{open:0}});h.time(t+=100);assert.equal(h.frame(),prefix+'neutral.png',style);
  }
});

test('scared (emotion 6, the robot turned over): the redhead has her scared picture and its four mouths, the other faces show the sad one (14 Nov 2026)',async()=>{
  // Owner: «quando la capovolgo deve fare la faccia spaventata. Ho creato scared-source.png» (the redhead's).
  const {SCARED,MOOD_MOUTH_BOXES}=await import('./portrait-state.js');assert.equal(SCARED,6);
  const h=await setup();let t=1100;
  h.view.behavior.setStyle(h.view,'redhead');
  h.view.behavior.onFaceUpdate(h.view,{emotion:SCARED,mouth:{open:0}});h.time(t+=40);assert.equal(h.frame(),'red-scared.png');assert.equal(h.mouth(),null,'closed: the scared picture alone');
  for(const [open,pose] of [[.18,1],[.35,2],[.58,3],[.8,4]]){
    h.view.behavior.onFaceUpdate(h.view,{emotion:SCARED,mouth:{open}});h.time(t+=40);
    assert.equal(h.frame(),'red-scared.png','she keeps the scared face while she calls for help');assert.equal(h.mouth(),`red-scared-mouth-${pose}.png`);assert.deepEqual(h.box(),{left:135,top:181,width:56,height:40});
  }
  h.view.behavior.rehydrate(h.view,{eyes:{left:{open:0},right:{open:0}},emotion:SCARED});h.time(t+=40);assert.equal(h.frame(),'red-scared.png','no blink over the scared face');
  h.view.behavior.onFaceUpdate(h.view,{emotion:0,mouth:{open:0},eyes:{left:{open:1},right:{open:1}}});h.time(t+=40);assert.equal(h.frame(),'red-neutral.png','and back to the serene one');
  // The faces with no scared picture: their sad one, with the sad mouths.
  for(const [style,prefix] of [['portrait','girl-'],['white','white-']]){
    h.view.behavior.setStyle(h.view,style);
    h.view.behavior.onFaceUpdate(h.view,{emotion:SCARED,mouth:{open:0}});h.time(t+=40);assert.equal(h.frame(),prefix+'sad.png',style);
    h.view.behavior.onFaceUpdate(h.view,{emotion:SCARED,mouth:{open:.8}});h.time(t+=40);assert.equal(h.mouth(),prefix+'sad-mouth-4.png',style);assert.deepEqual(h.box(),MOOD_MOUTH_BOXES.sad[style]);
  }
  // Every picture the scared face needs is in the MOD and is the right size.
  const {readFileSync}=await import('node:fs'),manifest=JSON.parse(readFileSync(new URL('./manifest.json',import.meta.url),'utf8')).resources['*-color'];
  const size=name=>{const png=readFileSync(new URL(`./assets/${name}.png`,import.meta.url));return [png.readUInt32BE(16),png.readUInt32BE(20)];};
  assert.ok(manifest.includes('./assets/red-scared'));assert.deepEqual(size('red-scared'),[320,240]);
  for(let n=1;n<=4;n++){assert.ok(manifest.includes(`./assets/red-scared-mouth-${n}`));assert.deepEqual(size(`red-scared-mouth-${n}`),[56,40]);}
});
test('the shapes of the lips: the redhead shows the picture of the letter over her serene face, the other faces and the angry, sad and scared ones keep their mouths (16 Nov 2026)',async()=>{
  // Owner: «nuove espressioni per migliorare movimenti labbra»: m/b/p, o, u, e/i, f/v.
  const h=await setup(),{LIPS,LIPS_BOXES,LIPS_PICTURES,lipsBetween}=await import('./portrait-state.js');let t=1100;
  assert.equal(LIPS,5);assert.deepEqual(Object.keys(LIPS_BOXES),['redhead']);
  h.view.behavior.setStyle(h.view,'redhead');h.view.behavior.onFaceUpdate(h.view,{emotion:3,mouth:{open:.58},eyes:{left:{open:1},right:{open:1}}});h.time(t+=40);
  assert.equal(h.mouth(),'red-mouth-6.png');
  h.view.behavior.setLips(h.view,'2h');assert.equal(h.mouth(),'red-lips-2h.png','at once, not at the next tick');assert.deepEqual(h.box(),LIPS_BOXES.redhead);assert.equal(h.frame(),'red-neutral.png');
  h.view.behavior.setLips(h.view,'2');assert.equal(h.mouth(),'red-lips-2.png');
  // Pressed lips in a silence, with a happy mood: over the serene face, never over the smiling picture.
  h.view.behavior.onFaceUpdate(h.view,{emotion:3,mouth:{open:0},eyes:{left:{open:1},right:{open:1}}});h.view.behavior.setLips(h.view,'1');
  assert.equal(h.mouth(),'red-lips-1.png');assert.equal(h.frame(),'red-neutral.png');
  h.view.behavior.setLips(h.view,'');assert.equal(h.mouth(),null);assert.equal(h.frame(),'red-happy.png','no shape: as before');
  for(const name of LIPS_PICTURES){h.view.behavior.setLips(h.view,name);assert.equal(h.mouth(),`red-lips-${name}.png`);}assert.equal(LIPS_PICTURES.size,24);
  h.view.behavior.setLips(h.view,'9');assert.equal(h.mouth(),null,'an unknown shape is no shape');
  // The picture to pass through: between two whole shapes, between a whole shape and the mouth of the loudness.
  assert.equal(lipsBetween('2','5'),'25');assert.equal(lipsBetween('5','2'),'25');assert.equal(lipsBetween('2','2'),undefined);assert.equal(lipsBetween('2','4h'),undefined);assert.equal(lipsBetween('2h','3'),undefined);
  assert.equal(lipsBetween('','3',0),'3h');assert.equal(lipsBetween('3','',4),'36');assert.equal(lipsBetween('','1',8),'17');assert.equal(lipsBetween('','4h',6),undefined);assert.equal(lipsBetween('','',3),undefined);
  for(const [a,b,l] of [['1','2',0],['','5',3],['3','',7],['','2',0]])assert.ok(LIPS_PICTURES.has(lipsBetween(a,b,l)));
  // The angry face keeps its own mouths.
  h.view.behavior.setLips(h.view,'2');h.view.behavior.onFaceUpdate(h.view,{emotion:1,mouth:{open:.58}});h.time(t+=40);assert.equal(h.frame(),'red-angry.png');assert.equal(h.mouth(),'red-angry-mouth-3.png');
  // The other faces have no such pictures: the mouth of the loudness.
  h.view.behavior.onFaceUpdate(h.view,{emotion:0,mouth:{open:.58},eyes:{left:{open:1},right:{open:1}}});
  h.view.behavior.setStyle(h.view,'portrait');h.view.behavior.setLips(h.view,'4');assert.equal(h.mouth(),'girl-mouth-6.png');
  h.view.behavior.setStyle(h.view,'white');assert.equal(h.mouth(),'white-mouth-4.png');
  // Every picture is in the MOD and as large as its box.
  const {readFileSync}=await import('node:fs'),manifest=JSON.parse(readFileSync(new URL('./manifest.json',import.meta.url),'utf8')).resources['*-color'];
  for(const picture of LIPS_PICTURES){
    const name=`red-lips-${picture}`,png=readFileSync(new URL(`./assets/${name}.png`,import.meta.url));
    assert.ok(manifest.includes('./assets/'+name),name);assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[LIPS_BOXES.redhead.width,LIPS_BOXES.redhead.height],name);
  }
});
test('every small picture of a face is as large as the box it is drawn in (16 Nov 2026: the redhead\'s new pictures, her face smaller)',async()=>{
  const {readFileSync}=await import('node:fs'),{MOUTH_BOXES,MOUTH_IMAGES,MOOD_MOUTH_BOXES,WAKE_BOXES,WAKE_STEPS,FACE_STYLES}=await import('./portrait-state.js');
  const size=name=>{const png=readFileSync(new URL(`./assets/${name}.png`,import.meta.url));return {width:png.readUInt32BE(16),height:png.readUInt32BE(20)};};
  const fits=(name,box)=>assert.deepEqual(size(name),{width:box.width,height:box.height},name);
  for(const [style,prefix] of Object.entries(FACE_STYLES)){
    fits(prefix+'neutral',{width:320,height:240});
    for(const n of new Set(MOUTH_IMAGES[style].filter(Boolean)))fits(`${prefix}mouth-${n}`,MOUTH_BOXES[style]);
    for(const [mood,boxes] of Object.entries(MOOD_MOUTH_BOXES))if(boxes[style]){fits(prefix+mood,{width:320,height:240});for(let n=1;n<=4;n++)fits(`${prefix}${mood}-mouth-${n}`,boxes[style]);}
    if(WAKE_BOXES[style])for(let n=0;n<WAKE_STEPS;n++)fits(`${prefix}wake-${n}`,WAKE_BOXES[style]);
  }
});
test('the angry and sad faces talk with their own mouths and do not blink; the others talk over the serene face as before (11 Nov 2026)',async()=>{
  const h=await setup();let t=1100;
  const boxes={angry:{portrait:{left:130,top:176,width:70,height:50},white:{left:132,top:156,width:56,height:40},redhead:{left:136,top:178,width:56,height:40}},
    sad:{portrait:{left:128,top:180,width:70,height:50},white:{left:132,top:142,width:56,height:40},redhead:{left:136,top:181,width:56,height:40}}};
  for(const [emotion,mood] of [[1,'angry'],[2,'sad']])for(const [style,prefix] of [['portrait','girl-'],['white','white-'],['redhead','red-']]){
    h.view.behavior.setStyle(h.view,style);
    for(const [open,pose] of [[.18,1],[.35,2],[.58,3],[.8,4]]){
      h.view.behavior.onFaceUpdate(h.view,{emotion,mouth:{open}});h.time(t+=40);
      assert.equal(h.frame(),`${prefix}${mood}.png`,`${style} keeps the ${mood} face while talking`);assert.equal(h.mouth(),`${prefix}${mood}-mouth-${pose}.png`);assert.deepEqual(h.box(),boxes[mood][style]);
    }
    h.view.behavior.onFaceUpdate(h.view,{emotion,mouth:{open:0}});h.time(t+=40);assert.equal(h.mouth(),null,`closed: the ${mood} picture alone`);
  }
  h.view.behavior.rehydrate(h.view,{eyes:{left:{open:0},right:{open:0}},emotion:1});h.time(t+=40);assert.equal(h.frame(),'red-angry.png','no blink over the angry face');
  h.view.behavior.rehydrate(h.view,{eyes:{left:{open:0},right:{open:0}},emotion:2});h.time(t+=40);assert.equal(h.frame(),'red-sad.png','no blink over the sad face');
  h.view.behavior.onFaceUpdate(h.view,{emotion:3,mouth:{open:.8},eyes:{left:{open:1},right:{open:1}}});h.time(t+=40);assert.equal(h.frame(),'red-neutral.png','happy and talking: the serene face, as before');assert.equal(h.mouth(),'red-mouth-8.png');
});
test('waking up: the eyes are a small picture over the serene face, step by step; no blinking meanwhile; the white robot opens at once (14 Nov 2026)',async()=>{
  const h=await setup(),{WAKE_BOXES,WAKE_STEPS}=await import('./portrait-state.js');
  const eyes=()=>{const e=h.view.children[0].children[1];return e.visible?e.skin.texture.name:null;},box=()=>({...h.view.children[0].children[1].coordinates});
  h.view.behavior.setWake(h.view,0);assert.equal(h.frame(),'girl-neutral.png');assert.equal(eyes(),'girl-wake-0.png');assert.deepEqual(box(),WAKE_BOXES.portrait);
  // A blink falls in the middle: the face stays serene with the closed eyes over it.
  h.time(4500);assert.equal(h.frame(),'girl-neutral.png');assert.equal(eyes(),'girl-wake-0.png');
  // The yawn: the mouth over the same face, eyes still closed.
  h.view.behavior.onFaceUpdate(h.view,{mouth:{open:.8}});assert.equal(h.mouth(),'girl-mouth-8.png');assert.equal(eyes(),'girl-wake-0.png');
  for(let step=1;step<WAKE_STEPS;step++){h.view.behavior.setWake(h.view,step);assert.equal(eyes(),`girl-wake-${step}.png`);}
  h.view.behavior.setWake(h.view,undefined);assert.equal(eyes(),null,'awake: the face as always');
  h.view.behavior.setStyle(h.view,'redhead');h.view.behavior.setWake(h.view,2);assert.equal(eyes(),'red-wake-2.png');assert.deepEqual(box(),WAKE_BOXES.redhead);
  h.view.behavior.setStyle(h.view,'white');h.view.behavior.onFaceUpdate(h.view,{mouth:{open:0}});
  h.view.behavior.setWake(h.view,1);assert.equal(eyes(),null);assert.equal(h.frame(),'white-blink.png','closed eyes until the last step');
  h.view.behavior.setWake(h.view,WAKE_STEPS-1);assert.equal(h.frame(),'white-neutral.png');
  h.view.behavior.setWake(h.view,7);assert.equal(eyes(),null,'a step that does not exist: the face as always');
});
test('the pictures of the opening eyes are in the MOD, the size of their box',async()=>{
  const {WAKE_BOXES,WAKE_STEPS,FACE_STYLES}=await import('./portrait-state.js'),manifest=JSON.parse(await readFile(new URL('./manifest.json',import.meta.url),'utf8'));
  for(const [style,box] of Object.entries(WAKE_BOXES))for(let step=0;step<WAKE_STEPS;step++){
    const name=`${FACE_STYLES[style]}wake-${step}`,png=await readFile(new URL(`./assets/${name}.png`,import.meta.url));
    assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[box.width,box.height],name);
    assert.ok(manifest.resources['*-color'].includes(`./assets/${name}`),name);
  }
});
test('the hand of a gesture in the top left corner for 2.5 s, on the corner of each face (23 Nov 2026: «una piccola iconcina con la mano… in alto a sinistra»)',async()=>{
  const h=await setup(),{HAND_ICON,FACE_STYLES}=await import('./portrait-state.js');
  const hand=()=>{const d=h.view.children[0].children[3];return d.visible?d.skin.texture.name:null;};
  assert.equal(hand(),null);
  h.time(1000);assert.equal(h.view.behavior.setHand(h.view,'thumbsUp'),true);assert.equal(hand(),'girl-hand-thumbsUp.png');
  assert.deepEqual({...h.view.children[0].children[3].coordinates},{left:HAND_ICON.left,top:HAND_ICON.top,width:HAND_ICON.size,height:HAND_ICON.size});
  h.time(2000);h.view.behavior.setHand(h.view,'victory');assert.equal(hand(),'girl-hand-victory.png','another gesture: its hand');
  h.view.behavior.setStyle(h.view,'redhead');assert.equal(hand(),'red-hand-victory.png','the other face: its own corner');
  h.time(4400);assert.equal(hand(),'red-hand-victory.png');h.time(4600);assert.equal(hand(),null,'2.5 s later: gone');
  assert.equal(h.view.behavior.setHand(h.view,'ok'),false,'no icon for a hand the robot does not take');assert.equal(hand(),null);
  h.time(5000);assert.equal(h.view.behavior.setHand(h.view,'palm'),true,'the open hand (23 Nov 2026, the owner\'s pictures)');assert.equal(hand(),'red-hand-palm.png');
  const manifest=JSON.parse(await readFile(new URL('./manifest.json',import.meta.url),'utf8'));
  for(const prefix of Object.values(FACE_STYLES))for(const name of HAND_ICON.names){
    assert.ok(manifest.resources['*-color'].includes(`./assets/${prefix}hand-${name}`),prefix+name);
    const png=await readFile(new URL(`./assets/${prefix}hand-${name}.png`,import.meta.url));
    assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[HAND_ICON.size,HAND_ICON.size],'as large as its box');
  }
});
test('during a conversation a red dot blinks in the top right corner, on the corner of each face (14 Nov 2026)',async()=>{
  const h=await setup(),{CALL_DOT,FACE_STYLES}=await import('./portrait-state.js');
  const dot=()=>{const d=h.view.children[0].children[2];return d.visible?d.skin.texture.name:null;};
  assert.equal(dot(),null,'no conversation: no dot');
  h.view.behavior.setCallDot(h.view,true);h.time(1000);assert.equal(dot(),'girl-call-dot.png');
  assert.deepEqual({...h.view.children[0].children[2].coordinates},{left:CALL_DOT.left,top:CALL_DOT.top,width:CALL_DOT.size,height:CALL_DOT.size});
  h.time(1500);assert.equal(dot(),null,'half a second off');h.time(2000);assert.equal(dot(),'girl-call-dot.png','and on again');
  h.view.behavior.setStyle(h.view,'redhead');assert.equal(dot(),'red-call-dot.png','the other face: its own corner');
  h.view.behavior.setCallDot(h.view,false);assert.equal(dot(),null,'the conversation ends: gone');
  const manifest=JSON.parse(await readFile(new URL('./manifest.json',import.meta.url),'utf8'));
  for(const prefix of Object.values(FACE_STYLES)){
    assert.ok(manifest.resources['*-color'].includes(`./assets/${prefix}call-dot`),prefix);
    const png=await readFile(new URL(`./assets/${prefix}call-dot.png`,import.meta.url));
    assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[CALL_DOT.size,CALL_DOT.size],prefix);
  }
});
test('the curly redhead (23 Nov 2026: «una nuova mascotte… deve essere selezionabile dall\'app»): her own pictures, five talking mouths, her own scared face, all in the MOD',async()=>{
  const {FACE_STYLES,MOUTH_BOXES,MOUTH_IMAGES,MOOD_MOUTH_BOXES,WAKE_BOXES,PORTRAIT_FRAMES}=await import('./portrait-state.js');
  assert.equal(FACE_STYLES.curly,'curly-');assert.deepEqual(MOUTH_IMAGES.curly,[0,1,2,2,3,3,4,4,5]);
  const h=await setup();let t=1100;
  h.view.behavior.setStyle(h.view,'curly');h.time(t+=40);assert.equal(h.frame(),'curly-neutral.png');
  h.view.behavior.onFaceUpdate(h.view,{emotion:0,mouth:{open:.8}});h.time(t+=40);assert.equal(h.mouth(),'curly-mouth-5.png','the widest is 80 per cent open');assert.deepEqual(h.box(),MOUTH_BOXES.curly);
  h.view.behavior.onFaceUpdate(h.view,{emotion:6,mouth:{open:0}});h.time(t+=40);assert.equal(h.frame(),'curly-scared.png','she has her own scared face');
  h.view.behavior.onFaceUpdate(h.view,{emotion:6,mouth:{open:.58}});h.time(t+=40);assert.equal(h.mouth(),'curly-scared-mouth-3.png');assert.deepEqual(h.box(),MOOD_MOUTH_BOXES.scared.curly);
  h.view.behavior.onFaceUpdate(h.view,{emotion:3,mouth:{open:0}});h.time(t+=40);assert.equal(h.frame(),'curly-happy.png');
  const manifest=JSON.parse(await readFile(new URL('./manifest.json',import.meta.url),'utf8')).resources['*-color'];
  const needed=['neutral','happy','sad','blink','angry','scared',...[1,2,3,4,5].map(n=>`mouth-${n}`),...['angry','sad','scared'].flatMap(m=>[1,2,3,4].map(n=>`${m}-mouth-${n}`)),...[0,1,2,3].map(n=>`wake-${n}`)];
  for(const name of needed)assert.ok(manifest.includes(`./assets/curly-${name}`),name);
  assert.ok(WAKE_BOXES.curly,'her eyes open slowly when she wakes up');
  assert.ok(PORTRAIT_FRAMES.every(f=>!f.startsWith('talk')||!manifest.includes(`./assets/curly-${f}`)),'the talking frames stay out of the MOD: only the mouths go over the serene face');
});
