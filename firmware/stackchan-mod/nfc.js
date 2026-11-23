// Schede NFC (owner, 21 Nov 2026: «Sì, preparalo», after the study in docs/NFC-it.md). The robot's own reader
// (ST25R3916 on the internal I2C bus, the host's `device.sensor.RFID`, already in the host on the robot) is asked
// every NFC.pollMs whether a card is there. PREPARED, NEVER TRIED ON THE ROBOT.
// - Off unless chosen (preference nfc); no reader and no radio field until switched on.
// - Every question holds JavaScript (the driver waits on the I2C bus, about 20–25 ms read from its code, never
//   measured): never while the robot is busy (conversation, call, speech, calibration...), at most once a second.
// - The radio field stays on while the reader is on and the robot is free, and goes off while it is busy (the driver
//   would switch it on by itself after missed questions, so `sample()` is never called with the field meant to be
//   off). First try on the robot (21 Nov 2026, 13:51): with the field switched on for each question only, one
//   question took up to 80 ms (the driver's field start-up waits on the bus) and no card was read in 48 questions.
// - Only the card's serial number (UID): enough to use a card as a button. It is easy to copy: a card must never
//   unlock anything protected (pairing, Wi-Fi, tokens).
// - A module of its own with one name in mod.js: the MOD's main function is at the limit of the JavaScript stack.
export const NFC={pollMs:1000,failLimit:3,retryMs:60000,reportMs:60000};
const finder=()=>globalThis.device?.sensor?.RFID;
const reason=error=>String(error?.message??error).slice(0,60);
export class NfcCards{
  constructor(on=false,{open,clock,log,limits=NFC}={}){
    this.limits=limits;
    this.open=open??(()=>{const RFID=finder();if(typeof RFID!=='function')throw Error('no_rfid');return new RFID();});
    this.clock=clock??(()=>Date.now());
    this.log=log??(text=>{if(typeof trace==='function')trace(text);});
    this.reader=undefined;this.field=false;this.state='off';this.card=undefined;
    this.set(on);
  }
  // The host offers the reader (only the StackChan CoreS3 platform does).
  get available(){return typeof finder()==='function';}
  set(on){
    this.on=on===true;this.drop();this.card=undefined;this.nextAt=0;this.fails=0;this.polls=0;this.worstMs=0;this.reportAt=0;
    this.state=this.on?'idle':'off';
    return this.state;
  }
  // One turn of the robot's cycle. Returns {uid,type} when a card arrives (once per card: a card held still is not
  // repeated), {problem:'missing'|'failed'} once when the reader is not there or stops answering, else undefined.
  tick(now,{busy=false}={}){
    const L=this.limits;
    if(!this.on||this.state==='missing')return;
    if(busy){if(this.field)this.fieldOff();return;}
    if(now<this.nextAt)return;
    this.nextAt=now+L.pollMs;
    if(!this.reader){
      const before=this.state;
      try{const reader=this.open();this.reader=reader;reader.configure({antenna:false});}
      catch(error){
        this.drop();this.state=/not found|no_rfid/.test(reason(error))?'missing':'failed';this.nextAt=now+L.retryMs;
        this.log(`[robottino] nfc open failed ${reason(error)}\n`);
        return before===this.state?undefined:{problem:this.state};
      }
      // Opening takes its own time (the driver's start-up): the first question waits for the next turn.
      this.state='ready';this.fails=0;this.reportAt=now+L.reportMs;this.log('[robottino] nfc ready\n');
      return;
    }
    const reader=this.reader,started=this.clock();let sample,failed=false;
    try{if(!this.field){this.field=true;reader.configure({antenna:true});}sample=reader.sample();}catch{failed=true;}
    const took=this.clock()-started;this.polls++;if(took>this.worstMs)this.worstMs=took;
    if(now>=this.reportAt){
      this.log(`[robottino] nfc polls ${this.polls} worst ${this.worstMs} ms\n`);
      this.reportAt=now+L.reportMs;this.polls=0;this.worstMs=0;
    }
    if(failed){
      if(++this.fails<L.failLimit)return;
      this.drop();this.state='failed';this.card=undefined;this.nextAt=now+L.retryMs;
      this.log('[robottino] nfc failed: reader closed, again in 60 s\n');
      return {problem:'failed'};
    }
    this.fails=0;
    if(sample?.present===true&&typeof sample.uidHex==='string'){
      this.card=sample.uidHex;this.log(`[robottino] nfc card ${sample.uidHex} ${sample.type??'-'}\n`);
      return {uid:sample.uidHex,type:sample.type};
    }
    if(sample?.present===false&&this.card!==undefined){this.card=undefined;this.log('[robottino] nfc removed\n');}
  }
  close(){this.set(false);}
  fieldOff(){this.field=false;try{this.reader?.configure({antenna:false});}catch{}}
  // The reader closed with its field off; a failure here must not stop the robot.
  drop(){
    const reader=this.reader;this.reader=undefined;this.field=false;if(!reader)return;
    try{reader.configure({antenna:false});}catch{}
    try{reader.close();}catch{}
  }
}
