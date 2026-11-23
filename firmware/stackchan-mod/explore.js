// «Esplora» (owner, 23 Nov 2026: «cerca nel progetto LOI come funziona la modalità esplora. Facciamola partire con un
// comando dato a voce, esplora la stanza e il robot con il rover deve girare e riconoscere gli oggetti e pronunciare
// quello che vede»; then «nella scheda studio dell'app, sopra la sezione rover, metti un tastino esplora»). As Looi's
// explore.ts (apps/nsh/runtime, read only), with what Robottino has. PREPARED, NEVER TRIED WITH THE REAL ROVER.
//   - a stretch forward (forwardMs, at random within it), then a turn on the spot (turnMs), always to the same side
//     chosen at the start: stop after stop the way goes round the room (Looi: turning at random it looked back where it
//     had already been);
//   - after each turn the robot stands still and looks: one picture goes to the server over the conversation
//     (mod.js: live-device.js snapshot, the «cos'è questo?» path), a model that sees says what is in the middle of it as
//     a discovery (src/robot-vision.ts EXPLORE_INSTRUCTIONS) and Robottino says it; the robot waits until it has said it
//     (speaking seen, then not), at most lookMaxMs, and goes on if nothing is said within lookWaitMs;
//   - something in front (the distance sensor: mod.js roverMove answers 'obstacle'): back for backMs and a wide turn
//     (escapeMs), as Looi when it is stuck;
//   - without the rover (owner, the same evening: «permetti la prova dell'esplorazione anche senza il rover. Muovo io il
//     robot, inquadro degli oggetti e lui deve pronunciare e dire cosa sono»): `still`, the same rhythm with no move at
//     all, the owner carries the robot around: a pause (stillMs) after each sentence, then the next look;
//   - at most one picture every lookEveryMs: the server describes at most 6 pictures a minute and 100 a day, shared
//     with «cos'è questo?» (src/session.ts consume, a quota not to be raised): a look that comes sooner waits, still;
//   - the end: after limitMs, or when mod.js stops it (the user says «basta» or «fermati», the iPhone's button, the
//     conversation ends, lifted, a rover that does not answer).
// Every move is short (moveMs at most) and given again while its stretch lasts: the rover stops by itself when the
// robot stops giving it (rover-wire.js).
export const EXPLORE={limitMs:180000,openingMs:1500,forwardMs:[2500,4500],turnMs:[450,1150],backMs:700,escapeMs:[1300,1900],
  lookWaitMs:5000,lookMaxMs:15000,moveMs:1000,renewMs:500,stillMs:[500,800],lookEveryMs:10000};

export class Explore{
  constructor(limits=EXPLORE,random=Math.random){this.limits=limits;this.random=random;this.active=false;}
  start(now,still=false){
    Object.assign(this,{active:true,still,from:now,side:this.random()<.5?1:-1,phase:'opening',until:now+this.limits.openingMs,lookFrom:now,lookedAt:-Infinity,spoke:false,looks:0,lastMove:undefined,lastAt:-Infinity});
  }
  // Radians: level, 25 degrees up, 50 up, then back down, one height per rover stop.
  get pitch(){return [0,-25,-50,-25][Math.max(0,this.looks-1)%4]*Math.PI/180;}
  stop(){this.active=false;}
  get turn(){return this.side>0?'turnRight':'turnLeft';}
  // Something in front: back, then a wide turn.
  blocked(now){return this.active?this.#enter('back',now,this.limits.backMs):undefined;}
  // One turn of the robot. ctx: {speaking} (Robottino is saying something). Returns undefined, {end:why},
  // {move:name,ms} (a move of rover-wire.js MOVES, or 'stop'), or {look:true} (take the picture now).
  step(now,ctx={}){
    if(!this.active||!Number.isFinite(now))return undefined;
    const L=this.limits;
    if(now-this.from>=L.limitMs){this.active=false;return {end:'finished'};}
    if(ctx.speaking)this.spoke=true;
    switch(this.phase){
      case 'opening':
      case 'look':{
        // Waiting for the words: they started and ended, or never came, or took too long.
        const waited=now-this.lookFrom,done=this.spoke?!ctx.speaking:waited>=(this.phase==='opening'?L.openingMs:L.lookWaitMs);
        if(done||waited>=L.lookMaxMs)return this.still?this.#enter('turn',now,this.#pick(L.stillMs)):this.#enter('forward',now,this.#pick(L.forwardMs));
        return undefined;
      }
      case 'forward':return now>=this.until?this.#enter('turn',now,this.#pick(L.turnMs)):this.#move('forward',now);
      case 'back':return now>=this.until?this.#enter('escape',now,this.#pick(L.escapeMs)):this.#move('back',now);
      case 'escape':return now>=this.until?this.#enter('forward',now,this.#pick(L.forwardMs)):this.#move(this.turn,now);
      case 'turn':
        if(ctx.speaking)return undefined;
        if(now<this.until)return this.#move(this.turn,now);
        if(now-this.lookedAt<L.lookEveryMs)return undefined; // too soon for the server's quota: wait, still
        this.phase='look';this.lookFrom=this.lookedAt=now;this.spoke=false;this.looks++;this.lastMove=undefined;return {look:true};
    }
    return undefined;
  }
  #pick([low,high]){return Math.round(low+this.random()*(high-low));}
  #enter(phase,now,ms){
    this.phase=phase;this.until=now+ms;this.lastMove=undefined;
    if(phase==='forward'||phase==='back'||phase==='escape'||phase==='turn')return this.#move(phase==='forward'||phase==='back'?phase:this.turn,now);
    return undefined;
  }
  // A move for at most moveMs, given again renewMs later while its stretch lasts.
  #move(name,now){
    if(this.still)return undefined; // carried by the owner: only the time goes by
    if(this.lastMove===name&&now-this.lastAt<this.limits.renewMs)return undefined;
    this.lastMove=name;this.lastAt=now;
    return {move:name,ms:Math.max(200,Math.min(this.limits.moveMs,this.until-now+100))};
  }
}

// The words that start or stop it, said to Robottino (as Looi's explore-phrase.ts): «esplora (la stanza)»,
// «esploriamo», «vai/puoi/vuoi esplorare», «guardati intorno», «fai un giro/giretto» (at the end of the sentence or
// with a place), «vai in giro», «curiosa in giro». Not «mi piace esplorare posti nuovi», not «fai il giro del mondo»,
// not a negated one. 'stop': «basta esplorare», «smetti di esplorare», «ferma l'esplorazione».
const ASK=/(?:^|[^a-zàáèéìíòóùú])(?:esplora|esploriamo|(?:vai|andiamo|puoi|vuoi|prova) (?:a )?esplorare)(?![a-zàáèéìíòóùú])|\bguardati (?:intorno|attorno|in giro)|\bfai (?:un|il) gir(?:o|etto)(?=\s*(?:[.!,?]|$|(?:qui|qua|in giro|intorno|sulla \w+|per (?:la|il) \w+)\b))|\bvai in giro\b|\bcuriosa(?:re)? (?:un po'|in giro|intorno)|\b(?:explore|look around)\b/iu;
const NOT_ASK=/\b(smetti|smettila|basta|non|stop|ferma|fermati|finito|esplorato|esplorando|don't|stop)\b/iu;
const STOP=/\b(?:basta|smetti\w*|ferma\w*|stop|finisci\w*|termina\w*)\b.*\b(?:esplor\w*|giro|girare|explor\w*)\b|\b(?:esplor\w*|giro)\b.*\b(?:basta|finita|stop)\b/iu;
export function exploreCommand(text){
  const value=String(text??'').toLowerCase().replace(/[’`]/g,"'");
  if(!value.trim())return null;
  if(STOP.test(value))return 'stop';
  return ASK.test(value)&&!NOT_ASK.test(value)?'start':null;
}
