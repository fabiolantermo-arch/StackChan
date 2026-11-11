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
  h.view.behavior.onFaceUpdate(h.view,{emotion:2,mouth:{open:.8}});h.time(1200);assert.equal(h.frame(),'girl-neutral.png','the touch smile is still on: talking over the serene face');assert.equal(h.mouth(),'girl-mouth-4.png');
  h.view.behavior.onFaceUpdate(h.view,{emotion:2,mouth:{open:0}});h.time(4100);assert.equal(h.frame(),'girl-sad.png');assert.equal(h.mouth(),null);assert.equal(h.view.children.length,1);
  h.view.behavior.onFaceUpdate(h.view,{emotion:1,mouth:{open:0}});h.time(4200);assert.equal(h.frame(),'girl-angry.png','emotion 1: the angry picture (11 Nov 2026)');
});
test('dance preserves mouth and blink; disposal prevents any restart or late touch',async()=>{
  const h=await setup();h.view.behavior.setDanceActive(true);h.time(1100);assert.equal(h.frame(),'girl-happy.png');
  h.view.behavior.onFaceState(h.view,{mouth:{open:.3}});h.time(1200);assert.equal(h.frame(),'girl-neutral.png');assert.equal(h.mouth(),'girl-mouth-2.png','talk-small');
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
test('the mouth is a small picture over the serene face, in four openings, changed as soon as the host reports it',async()=>{
  const h=await setup(),{MOUTH_POSES,mouthPose}=await import('./portrait-state.js'),seen=[];
  assert.deepEqual(MOUTH_POSES.map(mouthPose),[0,1,2,3,4],'the poses the Worker sends come back unchanged');
  for(const open of [0,.18,.35,.58,.8,1,.05]){h.view.behavior.onFaceUpdate(h.view,{mouth:{open}});seen.push(h.mouth());}
  assert.deepEqual(seen,[null,'girl-mouth-1.png','girl-mouth-2.png','girl-mouth-3.png','girl-mouth-4.png','girl-mouth-4.png',null],'no wait for the 66 ms tick');
  h.view.behavior.onFaceUpdate(h.view,{mouth:{open:.58}});assert.equal(h.frame(),'girl-neutral.png','the face itself is not redrawn');
  assert.deepEqual(h.box(),{left:126,top:172,width:72,height:54});
  h.view.behavior.setStyle(h.view,'redhead');assert.equal(h.mouth(),'red-mouth-3.png');assert.deepEqual(h.box(),{left:116,top:171,width:98,height:62});
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

test('the angry and sad faces talk with their own mouths and do not blink; the others talk over the serene face as before (11 Nov 2026)',async()=>{
  const h=await setup();let t=1100;
  const boxes={angry:{portrait:{left:130,top:176,width:70,height:50},white:{left:132,top:156,width:56,height:40},redhead:{left:130,top:176,width:70,height:50}},
    sad:{portrait:{left:128,top:180,width:70,height:50},white:{left:132,top:142,width:56,height:40},redhead:{left:128,top:178,width:70,height:50}}};
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
  h.view.behavior.onFaceUpdate(h.view,{emotion:3,mouth:{open:.8},eyes:{left:{open:1},right:{open:1}}});h.time(t+=40);assert.equal(h.frame(),'red-neutral.png','happy and talking: the serene face, as before');assert.equal(h.mouth(),'red-mouth-4.png');
});
