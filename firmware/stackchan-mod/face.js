import {Column,Container,Content,Label,Skin,Style,Text,Texture} from 'piu/MC';
// Robot messages in Open Sans 24 from the host's resources: the host balloon's
// 12-pixel bitmap font is too small to read. The font has Latin-1 only.
const messageStyle=new Style({font:'OpenSans-Regular-24',color:'#10202c',horizontal:'left'});
const messageSkin=new Skin({fill:'#eef6f6',stroke:'#1b3a52',borders:{left:2,right:2,top:2,bottom:2}});
// Large-print menu panel (Open Sans 20): full screen, one big button per row.
const panelSkin=new Skin({fill:'#051136'});
const panelTitleStyle=new Style({font:'OpenSans-Regular-20',color:'#ffffff',horizontal:'left'});
const buttonStyle=new Style({font:'OpenSans-Regular-20',color:'#10202c',horizontal:'center'});
const gridButtonStyle=new Style({font:'OpenSans-Regular-16',color:'#10202c',horizontal:'center'});
const LONG_TOUCH_MS=800,MESSAGE_MS=8000;
export function readableText(text){
  return String(text??'').replace(/[\u2018\u2019]/g,"'").replace(/[\u00ab\u00bb\u201c\u201d]/g,'"').replace(/\u2026/g,'...').replace(/\u2192/g,'>').replace(/[^\x20-\x7e\xa0-\xfe]/g,'');
}
import {portraitView,FACE_STYLES,MOUTH_BOXES,MOUTH_IMAGES,MOOD_MOUTH_BOXES,moodMouthImage,WAKE_BOXES,WAKE_STEPS,CALL_DOT,HAND_ICON,LIPS_BOXES} from 'robottino-portrait-state';
import {TouchReaction} from 'robottino-touch-reaction';
export function createExpressiveFace(){
  const skins=new Map();
  return new Container(null,{left:0,top:0,width:320,height:240,clip:true,active:true,skin:new Skin({fill:'#051136'}),Behavior:class extends Behavior{
    // Full-screen 320×240 portrait: the host must not move it to the previous face's spot.
    preservePositionOnSwap=false;
    onCreate(container){
      container.interval=66;this.state={};this.frame='';this.reaction=new TouchReaction();this.disposed=false;this.dancing=false;this.blinkAt=4490;this.blinkEnd=0;
      // The mouth is a small picture inside the portrait: changing it redraws only its box (MOUTH_BOXES).
      this.faceStyle='portrait';this.portrait=new Container(null,{left:0,top:0,width:320,height:240});container.add(this.portrait);
      this.mouth=new Content(null,{left:0,top:0,width:1,height:1,visible:false});this.portrait.add(this.mouth);this.mouthImage=0;
      // The eyes while Robottino wakes up (setWake): a small picture over the serene face, like the mouth.
      this.eyes=new Content(null,{left:0,top:0,width:1,height:1,visible:false});this.portrait.add(this.eyes);this.eyesImage='';this.wake=undefined;
      // The red dot of a conversation (setCallDot), blinking in the top right corner.
      this.dot=new Content(null,{left:CALL_DOT.left,top:CALL_DOT.top,width:CALL_DOT.size,height:CALL_DOT.size,visible:false});this.portrait.add(this.dot);this.callDot=false;this.dotImage='';
      // The hand of the last gesture (setHand), in the top left corner for HAND_ICON.ms.
      this.hand=new Content(null,{left:HAND_ICON.left,top:HAND_ICON.top,width:HAND_ICON.size,height:HAND_ICON.size,visible:false});this.portrait.add(this.hand);this.handName='';this.handUntil=0;this.handImage='';
      this.onTimeChanged(container);
    }
    onDisplaying(container){if(!this.disposed)container.start();}
    onUndisplaying(container){container.stop();}
    reactToTouch(source,event){if(this.disposed)return false;return this.reaction.accept(source,event);}
    getStyle(){return this.faceStyle;}
    // Informative messages disappear after 8 s; sticky ones (pairing code) stay
    // until replaced or hidden.
    // ms: how long an informative message stays (MESSAGE_MS unless said). A passing message over a sticky one (the
    // pairing code) gives the sticky one back when it goes (code review, 19 Nov 2026: the code vanished for good).
    showMessage(container,text,{sticky=false,ms=MESSAGE_MS}={}){
      const string=readableText(text);if(!string||this.disposed)return;
      const back=sticky?undefined:this.stickyMessage()?this.messageText:this.restoreText;
      this.hideMessage(container);this.restoreText=back;this.messageText=string;
      this.messageUntil=sticky?undefined:container.time+(Number.isFinite(ms)&&ms>0?ms:MESSAGE_MS);
      this.message=new Column(null,{left:6,right:6,bottom:6,skin:messageSkin,contents:[new Text(null,{left:8,right:8,top:4,bottom:6,style:messageStyle,string})]});
      if(this.panel)container.insert(this.message,this.panel);else container.add(this.message);
    }
    // A sticky message is on the screen (the pairing code): a passing message must not take its place.
    stickyMessage(){return !!this.message&&this.messageUntil===undefined;}
    hideMessage(container){this.messageUntil=undefined;this.restoreText=undefined;this.messageText=undefined;if(this.message){container.remove(this.message);this.message=undefined;}}
    setStyle(container,style){if(!Object.hasOwn(FACE_STYLES,style))throw Error("invalid_style");this.faceStyle=style;this.frame="";this.mouthImage=undefined;this.eyesImage=null;this.dotImage=null;this.onTimeChanged(container);}
    setDanceActive(active){this.dancing=active;}
    // Waking up (wake-up.js): step 0 (eyes closed) … WAKE_STEPS-1 (nearly open); undefined: the face as always. Meanwhile
    // the serene face, no blinking, the mouth as the face state says.
    // For the log: the eye picture on the screen now and whether the face is being drawn.
    wakeShown(){return `${this.eyes?.visible?this.eyesImage:'none'} over ${this.frame}${this.portrait?.container?'':' (not on screen)'}`;}
    setCallDot(container,on){this.callDot=!!on;if(!this.disposed)this.render(container);}
    setHand(container,name){if(!HAND_ICON.names.includes(name))return false;this.handName=name;this.handUntil=container.time+HAND_ICON.ms;if(!this.disposed)this.render(container);return true;}
    clearHand(container){this.handName=undefined;this.handUntil=0;if(!this.disposed)this.render(container);}
    callDotShown(){return !!this.dot?.visible;}
    // The shape of the lips of the letter being said (voice-device.js; 0: none, the mouth follows the loudness).
    setLips(container,name){const lips=name?String(name):undefined;if(lips===this.lips)return;this.lips=lips;if(!this.disposed)this.render(container);}
    setWake(container,step){this.wake=Number.isInteger(step)&&step>=0&&step<WAKE_STEPS?step:undefined;if(!this.disposed)this.render(container);}
    onTouchBegan(container,_id,_x,_y,ticks){this.touchStartedAt=Number.isFinite(ticks)?ticks:container.time;}
    // A long touch on the screen (about a second) opens the menu. The smile and laugh come
    // only from the head sensor (owner's choice, 9 Nov 2026): a short screen tap does nothing.
    onTouchEnded(container,_id,_x,_y,ticks){
      if(this.disposed)return;
      const end=Number.isFinite(ticks)?ticks:container.time,held=this.touchStartedAt===undefined?0:end-this.touchStartedAt;this.touchStartedAt=undefined;
      if(held>=LONG_TOUCH_MS&&typeof this.onLongTouch==='function'){this.onLongTouch();return;}
      container.bubble('onFaceTouch');
    }
    showPanel(container,{title,items=[],columns=1}={}){
      this.hidePanel(container);if(this.disposed)return;
      const button=(item,layout,style)=>new Container(null,{...layout,active:true,skin:messageSkin,
        contents:[new Label(null,{left:4,right:4,top:0,bottom:0,style,string:readableText(item.label)})],
        Behavior:class extends Behavior{onTouchEnded(){item.action?.();}}});
      const heading=layout=>(this.panelHeading=new Text(null,{...layout,style:panelTitleStyle,string:readableText(title)}));
      // Two columns: up to 12 buttons (Open Sans 16), the whole menu on one screen. The rows share the 208 px
      // under the title, up to 48 px each: as tall as they fit (owner, 10 Nov 2026: 30 px were too small).
      const shown=items.slice(0,12),pitch=Math.min(48,Math.floor(208/Math.max(1,Math.ceil(shown.length/2))));
      const contents=columns===2
        ?[heading({left:10,right:10,top:2}),...shown.map((item,i)=>button(item,{left:10+(i%2)*153,top:30+Math.floor(i/2)*pitch,width:147,height:pitch-4},gridButtonStyle))]
        :[new Column(null,{left:10,right:10,top:6,contents:[heading({left:0,right:0}),...items.slice(0,5).map(item=>button(item,{left:0,right:0,top:6,height:40},buttonStyle))]})];
      this.panel=new Container(null,{left:0,right:0,top:0,bottom:0,active:true,skin:panelSkin,contents});
      container.add(this.panel);
    }
    get panelOpen(){return !!this.panel;}
    // A new title on the open panel, without rebuilding its buttons (the menu shows the head sensor's zones).
    setPanelTitle(_container,title){if(this.panel&&this.panelHeading&&!this.disposed)this.panelHeading.string=readableText(title);}
    hidePanel(container){if(this.panel){container.remove(this.panel);this.panel=undefined;this.panelHeading=undefined;}}
    dispose(container){this.hidePanel(container);this.disposed=true;this.reaction.clear();container.active=false;container.stop();}
    // Portrait sprites face the viewer. Tracking turns the physical head;
    // independent iris steering needs additional artwork, not image stretching.
    setTarget(_x,_y){}
    // The host sends the face state 30 times a second: the mouth follows at once, not at the next 66 ms tick.
    onFaceUpdate(container,state){this.state=state;if(!this.disposed)this.render(container);}
    onFaceState(container,state){this.onFaceUpdate(container,state);}
    rehydrate(container,state){this.onFaceUpdate(container,state);}
    onTimeChanged(container){
      if(this.disposed)return;
      if(this.messageUntil!==undefined&&container.time>=this.messageUntil){const back=this.restoreText;this.hideMessage(container);if(back)this.showMessage(container,back,{sticky:true});}
      const state=this.dancing?{...this.state,emotion:3}:this.state;
      // Irregular blinks (every 2.5-6.5 s, sometimes double) look alive; a fixed rhythm looks mechanical.
      const time=container.time;
      if(time>=this.blinkAt&&time>=this.blinkEnd){this.blinkEnd=time+120;this.blinkAt=Math.random()<.15?this.blinkEnd+130:this.blinkEnd+2500+Math.random()*4000;}
      this.render(container);
    }
    render(container){
      const state=this.dancing?{...this.state,emotion:3}:this.state,time=container.time,style=this.faceStyle,prefix=FACE_STYLES[style];
      const waking=this.wake!==undefined,wakeBox=waking?WAKE_BOXES[style]:undefined;
      // Waking up: a face without the opening eyes (the white robot) shows its closed eyes until the last step.
      const view=waking?(wakeBox||this.wake>=WAKE_STEPS-1?portraitView({mouth:state.mouth},0,false,style):{base:'blink',mouth:0}):portraitView(this.lips?{...this.reaction.apply(state),lips:this.lips}:this.reaction.apply(state),time,time<this.blinkEnd,style);
      const frame=prefix+view.base,image=view.mood?moodMouthImage(view.mouth||0):MOUTH_IMAGES[style][view.mouth];
      const eyes=wakeBox?`${prefix}wake-${this.wake}`:'';
      const dot=this.callDot&&Math.floor(time/CALL_DOT.blinkMs)%2===0?`${prefix}call-dot`:'';
      if(dot!==this.dotImage){
        this.dotImage=dot;
        if(!dot)this.dot.visible=false;
        else try{
          if(!skins.has(dot))skins.set(dot,new Skin({texture:new Texture(`${dot}.png`),x:0,y:0,width:CALL_DOT.size,height:CALL_DOT.size}));
          this.dot.coordinates={left:CALL_DOT.left,top:CALL_DOT.top,width:CALL_DOT.size,height:CALL_DOT.size};this.dot.skin=skins.get(dot);this.dot.visible=true;
        }catch(error){this.dot.visible=false;this.callDot=false;this.onFaceError?.(error,dot);}
      }
      const hand=this.handName&&time<this.handUntil?`${prefix}hand-${this.handName}`:'';
      if(hand!==this.handImage){
        this.handImage=hand;
        if(!hand)this.hand.visible=false;
        else try{
          if(!skins.has(hand))skins.set(hand,new Skin({texture:new Texture(`${hand}.png`),x:0,y:0,width:HAND_ICON.size,height:HAND_ICON.size}));
          this.hand.coordinates={left:HAND_ICON.left,top:HAND_ICON.top,width:HAND_ICON.size,height:HAND_ICON.size};this.hand.skin=skins.get(hand);this.hand.visible=true;
        }catch(error){this.hand.visible=false;this.handName='';this.onFaceError?.(error,hand);}
      }
      if(eyes!==this.eyesImage){
        this.eyesImage=eyes;
        if(!eyes)this.eyes.visible=false;
        else try{
          if(!skins.has(eyes))skins.set(eyes,new Skin({texture:new Texture(`${eyes}.png`),x:0,y:0,width:wakeBox.width,height:wakeBox.height}));
          this.eyes.coordinates={left:wakeBox.left,top:wakeBox.top,width:wakeBox.width,height:wakeBox.height};this.eyes.skin=skins.get(eyes);this.eyes.visible=true;
        }catch(error){this.eyes.visible=false;this.onFaceError?.(error,eyes);}
      }
      if(frame!==this.frame){
        try{
          if(!skins.has(frame))skins.set(frame,new Skin({texture:new Texture(`${frame}.png`),x:0,y:0,width:320,height:240}));
          this.portrait.skin=skins.get(frame);this.frame=frame;
        }catch(error){this.frame=frame;this.onFaceError?.(error,frame);}
      }
      const name=view.lips?`${prefix}lips-${view.lips}`:image?`${prefix}${view.mood?view.mood+'-':''}mouth-${image}`:'';
      if(name===this.mouthImage)return;
      this.mouthImage=name;
      if(!name){this.mouth.visible=false;return;}
      const box=(view.lips?LIPS_BOXES:view.mood?MOOD_MOUTH_BOXES[view.mood]:MOUTH_BOXES)[style];
      try{
        if(!skins.has(name))skins.set(name,new Skin({texture:new Texture(`${name}.png`),x:0,y:0,width:box.width,height:box.height}));
        this.mouth.coordinates={left:box.left,top:box.top,width:box.width,height:box.height};this.mouth.skin=skins.get(name);this.mouth.visible=true;
      }catch(error){this.mouth.visible=false;this.onFaceError?.(error,name);}
    }
  }});
}
