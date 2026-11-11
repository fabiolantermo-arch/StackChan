// The host's servo driver (upstream scservo.ts with firmware/host/patches/servo-late-reply.patch) against a
// model of the robot's loop: timers are served before incoming data, so a program that was busy for longer than
// the 120 ms timeout used to report a servo as silent although its reply was already in the UART
// («Errore nella danza remota», 10 Nov 2026). Runs on the Mac only; skipped when work/ is not there.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import path from 'node:path';

const root=fileURLToPath(new URL('../../',import.meta.url));
const motion=path.join(root,'work/stack-chan-upstream/firmware/host/modules/motion');
const source=path.join(motion,'protocols/scservo.ts');
const available=existsSync(source);

// One simulated robot per test: wire (bytes on their way from the servos), fifo (bytes in the UART), timers.
const sim=globalThis.__servoSim={};
const reset=()=>Object.assign(sim,{now:0,seq:0,timers:[],wire:[],fifo:[],sent:[],log:[],silent:false,replyAfter:2});
globalThis.trace=text=>sim.log.push(String(text));

let SCServo;
const load=async()=>{
  if(SCServo)return SCServo;
  const {build}=await import('esbuild');
  const dir=mkdtempSync(path.join(tmpdir(),'robottino-servo-'));
  const fake=(name,code)=>{const file=path.join(dir,name);writeFileSync(file,code);return file;};
  const map={
    // Half-duplex line: what is written comes back as an echo, then the servo's reply.
    'embedded:io/serial':fake('serial.mjs',`const sim=globalThis.__servoSim;
      export default class Serial{constructor(o){this.format=o.format;this.onReadable=o.onReadable;sim.serial=this;}
        read(){return sim.fifo.length?sim.fifo.shift():undefined;}
        write(buffer){const bytes=Array.from(buffer);sim.sent.push(bytes);sim.wire.push({at:sim.now,bytes});
          if(!sim.silent){const id=bytes[2];sim.wire.push({at:sim.now+sim.replyAfter,bytes:[255,255,id,2,0,(~(id+2))&255]});}}}`),
    'mc/config':fake('config.mjs','export default {};'),
    'timer':fake('timer.mjs',`const sim=globalThis.__servoSim;
      export default {set(fn,ms=0){const t={at:sim.now+ms,seq:sim.seq++,fn};sim.timers.push(t);return t;},clear(t){const i=sim.timers.indexOf(t);if(i>=0)sim.timers.splice(i,1);}};`),
    'time':fake('time.mjs','const sim=globalThis.__servoSim;export default {get ticks(){return sim.now;}};'),
    'payload-buffer':path.join(motion,'payload-buffer.ts'),
    'servo-command-error':path.join(motion,'internal/servo-command-error.ts'),
    'single-wait-slot':path.join(motion,'internal/single-wait-slot.ts')
  };
  const out=path.join(dir,'scservo.mjs');
  await build({entryPoints:[source],bundle:true,format:'esm',outfile:out,logLevel:'silent',
    plugins:[{name:'host',setup(b){b.onResolve({filter:/.*/},args=>map[args.path]?{path:map[args.path]}:undefined);}}]});
  SCServo=(await import(pathToFileURL(out).href)).default;
  rmSync(dir,{recursive:true,force:true});
  return SCServo;
};

// One turn of the host's loop at the current time: timers first, then the data that has arrived.
const turn=()=>{
  for(const item of sim.wire.filter(w=>w.at<=sim.now)){sim.fifo.push(...item.bytes);sim.wire.splice(sim.wire.indexOf(item),1);}
  for(;;){
    const due=sim.timers.filter(t=>t.at<=sim.now).sort((a,b)=>a.at-b.at||a.seq-b.seq)[0];
    if(!due)break;
    sim.timers.splice(sim.timers.indexOf(due),1);due.fn();
  }
  if(sim.fifo.length)sim.serial.onReadable.call(sim.serial,sim.fifo.length);
};
const run=ms=>{for(let i=0;i<ms;i++){sim.now++;turn();}};
// The program is busy: time passes, bytes arrive in the UART, nothing is served.
const stall=ms=>{sim.now+=ms;};

let servos;
const setup=async()=>{reset();const Servo=await load();servos??=[new Servo({id:1}),new Servo({id:2})];return servos;};
const command=servo=>{const result={};servo.setTorque(true,error=>{result.done=true;result.error=error;});return result;};
const lines=word=>sim.log.filter(line=>line.includes(word));

test('a reply read on time is a success',{skip:!available},async()=>{
  const [pan]=await setup();
  const result=command(pan);run(10);
  assert.equal(result.done,true);assert.equal(result.error,undefined);
  assert.equal(lines('timeout').length,0);assert.equal(lines('late read').length,0);
});

test('a reply that arrived while the program was busy is read before giving up',{skip:!available},async()=>{
  const [pan,tilt]=await setup();
  for(const busy of [121,180,253,563]){
    for(const servo of [pan,tilt]){
      sim.log.length=0;
      const result=command(servo);stall(busy);turn();run(5);
      assert.equal(result.done,true,`busy ${busy} ms: the command ends`);
      assert.equal(result.error,undefined,`busy ${busy} ms: no timeout`);
      assert.equal(lines('timeout').length,0);assert.equal(lines('late read').length,1);
    }
  }
});

test('a servo that does not answer still times out after 120 ms, busy or not',{skip:!available},async()=>{
  const [pan]=await setup();sim.silent=true;
  let result=command(pan);run(119);
  assert.equal(result.done,undefined,'not before 120 ms');
  run(2);
  assert.match(String(result.error?.message),/timed out after 120ms/);
  assert.equal(lines('timeout id=1').length,1);
  // Busy and silent: only the echo was waiting. Still a timeout, never a success.
  run(30);sim.log.length=0;result=command(pan);stall(300);turn();run(5);
  assert.match(String(result.error?.message),/timed out after 120ms/);
  assert.equal(lines('timeout id=1').length,1);
});

test('after a late reply the next commands work, and a stale wake-up reads nothing',{skip:!available},async()=>{
  const [pan,tilt]=await setup();
  const first=command(pan);stall(200);turn();
  assert.equal(first.error,undefined);assert.equal(first.done,true);
  // The message announcing the bytes that poll() has already taken: the host delivers none when the UART is
  // empty; even if one arrived with an old count, nothing is read and the next packet is not shifted.
  sim.serial.onReadable.call(sim.serial,6);
  run(5);
  const second=command(tilt),third=command(pan);run(20);
  assert.equal(second.done,true);assert.equal(second.error,undefined);
  assert.equal(third.done,true);assert.equal(third.error,undefined);
  assert.equal(lines('timeout').length,0);assert.equal(lines('unknown packet').length,0);
});

test('TEMPORARY diagnostics: a slow command says how long it waited in the queue and on the line',{skip:!available},async()=>{
  const [pan]=await setup();
  const first=command(pan),second=command(pan);stall(250);turn();run(10);
  assert.equal(first.done,true);assert.equal(second.done,true);
  assert.match(lines('late read')[0],/late read id=1 bytes=\d+ after=250/);
  assert.match(lines('slow id=1')[0],/queued=0 total=250 ok/);
  assert.match(lines('slow id=1')[1],/queued=25\d total=25\d ok/);
  sim.log.length=0;const quick=command(pan);run(10);
  assert.equal(quick.done,true);assert.equal(lines('slow').length,0);
});

test('a reply that comes after the timeout is not taken for the next command',{skip:!available},async()=>{
  const [pan]=await setup();sim.replyAfter=150;
  const slow=command(pan);run(125);
  assert.match(String(slow.error?.message),/timed out after 120ms/);
  // The driver waits 20 ms before the next command; the old reply lands at 150 ms and no command is waiting.
  run(40);sim.replyAfter=2;
  const next=command(pan);run(10);
  assert.equal(next.done,true);assert.equal(next.error,undefined);
});
