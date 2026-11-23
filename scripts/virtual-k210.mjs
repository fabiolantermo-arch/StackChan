// A pretend K210 camera: writes the same 12-byte frames the real one will (firmware/stackchan-mod/k210.js,
// firmware/k210/boot.py). For the tests, and to try the robot's side before the camera arrives: with a 3,3 V
// USB-serial adapter on the robot's PORT.C (adapter TX → G18, ground → ground; never the 5 V wire) the Mac plays the camera.
//   node scripts/virtual-k210.mjs                         prints the frames (no robot needed)
//   node scripts/virtual-k210.mjs --port /dev/cu.usbserial-XXXX [--fps 15] [--pattern circle|still|lost|none|dirty]
// Quit: Ctrl+C. It sends nothing but these frames and reads nothing.
import {encodeFrame,K210_BAUD} from '../firmware/stackchan-mod/k210.js';
import {execFileSync} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {pathToFileURL} from 'node:url';

export const PATTERNS=['circle','still','lost','none','dirty'];
// One picture after another, as bytes. circle: a face that goes round the picture in about 4 s. still: a face in the
// middle. lost: three seconds with the face, three without. none: nobody. dirty: circle, with noise and cut frames
// in between, as on a bad cable.
export function* pictures({pattern='circle',count=Infinity,fps=15}={}){
  for(let n=0;n<count;n++){
    const turn=n/(fps*4)*2*Math.PI,seen=pattern==='none'?false:pattern==='lost'?Math.floor(n/(fps*3))%2===0:true;
    const still=pattern==='still'||pattern==='lost';
    const frame=encodeFrame({seq:n,faces:seen?1:0,x:still?.5:.5+.3*Math.cos(turn),y:still?.5:.5+.25*Math.sin(turn),w:.2,h:.27,score:.85,ms:Math.round(1000/fps)});
    if(pattern==='dirty'&&n%7===3){yield Uint8Array.of(0x52,0x00,0xff,0x4B);yield frame.subarray(0,5);continue;}
    yield frame;
  }
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
  const args=process.argv.slice(2),value=name=>{const at=args.indexOf(name);return at>=0?args[at+1]:undefined;};
  const pattern=value('--pattern')??'circle',fps=Math.min(30,Math.max(1,Number(value('--fps')??15)||15)),port=value('--port');
  if(!PATTERNS.includes(pattern)){console.error(`Pattern sconosciuto. Scegli tra: ${PATTERNS.join(', ')}`);process.exit(1);}
  let out;
  if(port){
    if(!port.startsWith('/dev/')){console.error('La porta deve essere un dispositivo seriale, per esempio /dev/cu.usbserial-XXXX');process.exit(1);}
    execFileSync('stty',['-f',port,String(K210_BAUD),'raw','cs8','-cstopb','-parenb','clocal']);
    out=createWriteStream(port);out.on('error',error=>{console.error(`Porta seriale: ${error.message}`);process.exit(1);});
    console.log(`Camera finta su ${port}, ${fps} immagini al secondo, «${pattern}». Ctrl+C per fermare.`);
  }
  const source=pictures({pattern,fps});let sent=0;
  const timer=setInterval(()=>{
    const {value:bytes,done}=source.next();if(done){clearInterval(timer);return;}
    if(out)out.write(bytes);else console.log(Buffer.from(bytes).toString('hex').replace(/(..)/g,'$1 ').trim());
    if(out&&++sent%(fps*5)===0)console.log(`${sent} immagini inviate`);
  },Math.round(1000/fps));
  process.on('SIGINT',()=>{clearInterval(timer);out?.end();process.exit(0);});
}
