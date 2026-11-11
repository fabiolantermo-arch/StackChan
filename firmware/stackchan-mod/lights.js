// Head lights (owner's choice, 9 Nov 2026: scheme «Discreta», brightness «Media»). The K151 has a bar of
// 12 RGB LEDs driven by the host through the PY32 (`robot.lighting`, LED named 'head', RGB565). Off at
// rest; a light only while the robot does something with you, so whenever its microphone or camera is in
// use a light is on. Every colour change is one I2C write per LED: colours are written only on a change.
export const LIGHT_LEVEL=.25; // «Media»: about a quarter of full brightness
// blink: the host's blink period (on for half, off for half), in ms.
export const LIGHTS={
  listening:{color:[0,140,255]},           // light blue, steady: listening to you
  thinking:{color:[0,140,255],blink:1200},  // light blue, slow blink: connecting, or waiting for the reply
  speaking:{color:[255,170,90]},           // warm white: speaking
  live:{color:[150,0,255]},                // purple, steady: the iPhone is connected (Live, camera, following, Test)
  pairing:{color:[255,90,0],blink:1000},    // orange blink: the pairing code is on the screen
  reminder:{color:[255,190,0],blink:1000},  // yellow blink: a reminder, until the head is touched
  error:{color:[255,0,0],blink:600}         // red: three blinks, then off
};
export const ERROR_FLASH_MS=1800; // three blinks of 600 ms
// The light for the robot's state, the most important first.
export function lightFor({voice='idle',pairing=false,reminder=false,live=false,error=false}={}){
  if(error)return 'error';
  if(pairing)return 'pairing';
  if(voice==='speaking')return 'speaking';
  if(voice==='listening')return 'listening';
  if(voice==='connecting'||voice==='thinking')return 'thinking';
  if(reminder)return 'reminder';
  if(live)return 'live';
  return 'off';
}
export class HeadLights{
  // The host turns the LEDs off when it starts them, so they begin off.
  constructor(lighting,name='head'){this.lighting=lighting?.led?.[name]?lighting:undefined;this.name=name;this.shown='off';this.errorUntil=undefined;}
  get available(){return !!this.lighting;}
  flashError(now){if(Number.isFinite(now))this.errorUntil=now+ERROR_FLASH_MS;}
  update(state,now){
    const error=this.errorUntil!==undefined&&now<this.errorUntil;if(!error)this.errorUntil=undefined;
    return this.show(lightFor({...state,error}));
  }
  show(name){
    if(!this.lighting||name===this.shown)return false;
    const light=LIGHTS[name];
    try{
      if(!light)this.lighting.lightOff(this.name);
      else{
        const [r,g,b]=light.color.map(value=>Math.round(value*LIGHT_LEVEL));
        // The host's blink keeps the old colour for its first half period: start it from dark.
        if(light.blink){this.lighting.lightOff(this.name);this.lighting.lightBlink(this.name,r,g,b,light.blink);}
        else this.lighting.lightOn(this.name,r,g,b);
      }
      this.shown=name;return true;
    }catch{this.lighting=undefined;return false;} // a failing LED driver never stops the robot: lights stay as they are
  }
  close(){const lighting=this.lighting;this.shown='off';this.errorUntil=undefined;try{lighting?.lightOff(this.name);}catch{}}
}
