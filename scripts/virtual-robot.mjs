// Virtual robot: connects to the Robottino relay as a device, declaring itself simulated.
// It uses the firmware's own dispatcher (live-wire.js). No real sensor, no AI provider.
// Start: npm run robot:virtual   ·   Quit: Ctrl+C
import WebSocket from 'ws';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {DeviceCommands,encodeMedia,cameraChunks} from '../firmware/stackchan-mod/live-wire.js';

const root=fileURLToPath(new URL('../',import.meta.url)),base='https://robottino-stackchan.example.workers.dev';
const deviceToken=(await readFile(path.join(root,'private/robot-device-token'),'utf8')).trim();
const screenFile=path.join(root,'work/virtual-robot/screen.ppm');
const log=text=>console.log(`[${new Date().toLocaleTimeString('it-IT')}] ${text}`);

let socket,controller,heartbeat,cameraTimer,toneTimer,danceTimers=[],seq=0,frameId=0,retry=5000,stopping=false,received=0;
const send=value=>{if(socket?.readyState===WebSocket.OPEN)socket.send(typeof value==='string'?value:JSON.stringify(value));};
const media=buffer=>{if(socket?.readyState===WebSocket.OPEN)socket.send(buffer);};

// A coloured bar that scrolls: it shows in the app that the video is live.
function testFrame(tick){
  const width=320,height=240,pixels=new Uint8Array(width*height*2);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const band=Math.floor(((x+tick*12)%width)/40),colors=[0xF800,0xFD20,0xFFE0,0x07E0,0x07FF,0x001F,0x781F,0xFFFF],value=y>200?0x2104:colors[band];
    const i=(y*width+x)*2;pixels[i]=value&255;pixels[i+1]=value>>8;
  }
  return pixels.buffer;
}
const clearDance=()=>{for(const timer of danceTimers)clearTimeout(timer);danceTimers=[];};
const io={
  camera(enabled){
    clearInterval(cameraTimer);cameraTimer=undefined;
    if(!enabled){log('Video fermato.');return;}
    let tick=0;log('Video avviato: 320×240, circa 3 fotogrammi al secondo.');
    cameraTimer=setInterval(()=>{for(const chunk of cameraChunks(++frameId,testFrame(tick++),320,240,()=>++seq))media(chunk);},333);
  },
  call(enabled){
    clearInterval(toneTimer);toneTimer=undefined;
    if(!enabled){log(`Chiamata terminata. Audio ricevuto dall'iPhone: ${received} byte.`);return;}
    let phase=0;received=0;log('Chiamata avviata: invio un tono leggero a 440 Hz.');
    toneTimer=setInterval(()=>{
      const pcm=new Int16Array(320);for(let i=0;i<pcm.length;i++){pcm[i]=Math.round(Math.sin(phase)*1500);phase+=2*Math.PI*440/16000;}
      media(encodeMedia(3,++seq,pcm.buffer));
    },20);
  },
  screen(enabled){log(enabled?'Schermo: pronto a ricevere un’immagine.':'Schermo: torna il volto.');},
  audio(data){received+=data.byteLength;},
  async image(frame){
    const width=frame.width,height=frame.height,input=new Uint8Array(frame.payload),rgb=Buffer.alloc(width*height*3);
    for(let i=0;i<width*height;i++){const v=input[i*2]|input[i*2+1]<<8;rgb[i*3]=(v>>11)*255/31;rgb[i*3+1]=((v>>5)&63)*255/63;rgb[i*3+2]=(v&31)*255/31;}
    await mkdir(path.dirname(screenFile),{recursive:true});await writeFile(screenFile,Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`),rgb]));
    log(`Immagine ricevuta ${width}×${height}: salvata in ${path.relative(root,screenFile)} (apribile con Anteprima).`);
  },
  motion(value){log(`Testa: orizzontale ${value.yaw}°, verticale ${value.pitch}°.`);},
  face(value){log(`Volto imitato: occhi ${value.leftEye.toFixed(2)}/${value.rightEye.toFixed(2)}, bocca ${value.mouth.toFixed(2)}.`);},
  faceStyle(style){log(`Stile volto: ${style==='white'?'Robot bianco':'Ritratto'}.`);},
  dance(steps){
    clearDance();let at=0;log(`Danza ricevuta: ${steps.length} passi.`);
    steps.forEach((step,index)=>{danceTimers.push(setTimeout(()=>log(`  passo ${index+1}: ${step.expression}, ${step.yaw}° / ${step.pitch}°, ${step.durationMs} ms`),at));at+=step.durationMs;});
    danceTimers.push(setTimeout(()=>log('Danza finita.'),at));
  },
  stop(){clearDance();io.camera(false);io.call(false);log('STOP: tutto fermo.');}
};
const hello=()=>send({type:'hello',capabilities:{hardwareVerified:true,calibrated:true,motion:true,camera:true,audio:true,screen:true,simulated:true}});
function cleanup(){clearInterval(heartbeat);clearInterval(cameraTimer);clearInterval(toneTimer);clearDance();controller?.close();heartbeat=cameraTimer=toneTimer=undefined;}
function connect(){
  socket=new WebSocket(base.replace('https:','wss:')+'/api/robot/device',{headers:{Authorization:'Bearer '+deviceToken},handshakeTimeout:10000,maxPayload:65535});
  controller=new DeviceCommands(io,send);
  socket.on('open',()=>{retry=5000;seq=0;log('Robot virtuale collegato. Apri l’app: risulterà «Dispositivo virtuale di prova».');hello();heartbeat=setInterval(()=>{send({type:'ping'});hello();},5000);});
  socket.on('unexpected-response',(_request,response)=>{log(response.statusCode===409?'Un robot è già collegato: non lo sostituisco.':`Collegamento rifiutato (${response.statusCode}).`);});
  socket.on('message',(data,binary)=>{
    try{
      if(binary)controller.media(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength));
      else{const event=JSON.parse(data.toString());if(event.type==='command')void controller.command(event);if(event.type==='peer.connected')log('L’app iPhone si è collegata.');if(event.type==='reaction')log(`Reazione: ${({attention:'Claude Code ti chiede un permesso.',done:'Claude Code ha finito.',success:'Test superati!',failure:'Qualcosa non va: controlla Claude Code.'})[event.kind]??'sconosciuta'}`);}
    }catch{socket.close();}
  });
  socket.on('error',()=>{});
  socket.on('close',(_code,reason)=>{
    cleanup();if(stopping)return;
    log(`Collegamento chiuso${reason?.length?` (${reason})`:''}: riprovo tra ${retry/1000} s, come farà il robot vero.`);
    setTimeout(connect,retry);retry=Math.min(60000,retry*2);
  });
}
process.on('SIGINT',()=>{stopping=true;log('Robot virtuale spento.');cleanup();socket?.terminate();process.exit(0);});
connect();
