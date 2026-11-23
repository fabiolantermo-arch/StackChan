// Head lights (owner, 12 Nov 2026: «luci rosse quando c'è un errore, blu quando parla, verde quando ascolta, gialle
// quando cerca su web», the other cases chosen to stay apart from those four; brightness «Media», 9 Nov 2026). The K151 has a bar of
// 12 RGB LEDs driven by the host through the PY32 (`robot.lighting`, LED named 'head', RGB565). Off at
// rest; a light only while the robot does something with you, so whenever its microphone or camera is in
// use a light is on. Every colour change is one I2C write per LED: colours are written only on a change.
export const LIGHT_LEVEL=.25; // «Media»: about a quarter of full brightness
// blink: the host's blink period (on for half, off for half), in ms. alternate: a second colour that takes the dark
// half (written from here at each half period: the host's blink can only go dark).
export const LIGHTS={
  listening:{color:[0,255,40]},            // green, steady: listening to you
  speaking:{color:[0,50,255]},             // blue, steady: speaking
  angry:{color:[255,0,0],alternate:[255,170,0],blink:1000}, // red and yellow in turn, half a second each: speaking with the angry face (owner, 12 Nov 2026)
  searching:{color:[255,170,0]},           // yellow, steady: searching the web for the answer
  looking:{color:[0,220,220]},             // turquoise, steady: «cos'è questo?», the picture is being taken and read
  thinking:{color:[255,255,255],blink:1200},// white, slow blink: connecting, or your words were heard and the reply is coming
  live:{color:[150,0,255]},                // purple, steady: the iPhone is connected (Live, camera, following, Test)
  watching:{color:[40,40,40]},             // faint white, steady: the camera is on to follow a face, nothing else is happening
  pairing:{color:[255,90,0],blink:1000},    // orange blink: the pairing code is on the screen
  reminder:{color:[255,30,120],blink:1000}, // pink blink: a reminder, until the head is touched (yellow is the web search now)
  error:{color:[255,0,0],blink:600}         // red: three blinks, then off
};
export const ERROR_FLASH_MS=1800; // three blinks of 600 ms
// The light for the robot's state, the most important first.
export function lightFor({voice='idle',pairing=false,reminder=false,live=false,error=false,angry=false,watching=false}={}){
  if(error)return 'error';
  if(pairing)return 'pairing';
  // Angry only while it speaks: green stays the sign that it is your turn.
  if(voice==='speaking')return angry?'angry':'speaking';
  if(voice==='searching')return 'searching';
  if(voice==='looking')return 'looking';
  if(voice==='listening')return 'listening';
  if(voice==='connecting'||voice==='thinking')return 'thinking';
  if(reminder)return 'reminder';
  if(live)return 'live';
  if(watching)return 'watching'; // the camera is in use: a light is on, as for every use of camera or microphone
  return 'off';
}
export class HeadLights{
  // The host turns the LEDs off when it starts them, so they begin off.
  constructor(lighting,name='head'){this.lighting=lighting?.led?.[name]?lighting:undefined;this.name=name;this.shown='off';this.errorUntil=undefined;this.since=0;this.half=0;}
  get available(){return !!this.lighting;}
  flashError(now){if(Number.isFinite(now))this.errorUntil=now+ERROR_FLASH_MS;}
  update(state,now){
    const error=this.errorUntil!==undefined&&now<this.errorUntil;if(!error)this.errorUntil=undefined;
    return this.show(lightFor({...state,error}),now);
  }
  show(name,now=0){
    if(!this.lighting)return false;
    const light=LIGHTS[name];
    if(name===this.shown){
      // Two colours in turn: one write at each half period, nothing in between.
      if(!light?.alternate)return false;
      const half=Math.floor((now-this.since)/(light.blink/2))%2;if(half===this.half)return false;
      try{const [r,g,b]=(half?light.alternate:light.color).map(value=>Math.round(value*LIGHT_LEVEL));this.lighting.lightOn(this.name,r,g,b);this.half=half;return true;}
      catch{this.lighting=undefined;return false;}
    }
    try{
      if(!light)this.lighting.lightOff(this.name);
      else{
        const [r,g,b]=light.color.map(value=>Math.round(value*LIGHT_LEVEL));
        // The host's blink keeps the old colour for its first half period: start it from dark.
        if(light.alternate)this.lighting.lightOn(this.name,r,g,b);
        else if(light.blink){this.lighting.lightOff(this.name);this.lighting.lightBlink(this.name,r,g,b,light.blink);}
        else this.lighting.lightOn(this.name,r,g,b);
      }
      this.shown=name;this.since=now;this.half=0;return true;
    }catch{this.lighting=undefined;return false;} // a failing LED driver never stops the robot: lights stay as they are
  }
  close(){const lighting=this.lighting;this.shown='off';this.errorUntil=undefined;try{lighting?.lightOff(this.name);}catch{}}
}
