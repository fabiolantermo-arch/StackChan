import {Client} from 'robottino-socket';
import Preference from 'preference';
import Timer from 'timer';
import {pairingEvent} from 'robottino-live-wire';

// First pairing without keys in the firmware: the robot shows a 6-digit code, the owner types it
// in the iPhone app, and the server sends this robot its own credential, saved only here.
// While the owner types the code the socket would carry nothing for a minute or more, and an idle
// connection can be dropped on the way (9 Nov 2026: «sul robot mi dice che non è abbinato»): a small
// keep-alive every 20 s, which the server ignores. hooks.diag records each step (TEMPORARY, nvs pairDiag).
const KEEPALIVE_MS=20000;
export function createPairing(robot,hooks){
  let socket,timer,keepalive,code,closed=true,stored=false,savedOk=false; // stored: the credential has come
  const stop=reason=>{
    if(closed)return;closed=true;hooks.diag?.('end:'+reason);
    if(timer!==undefined)Timer.clear(timer);timer=undefined;if(keepalive!==undefined)Timer.clear(keepalive);keepalive=undefined;code=undefined;
    try{socket?.close();}catch{}socket=undefined;
    hooks.ended(reason);
  };
  async function start(){
    if(!closed)return false;
    closed=false;stored=savedOk=false;hooks.diag?.('start');
    try{await robot.connectivity.network?.ready;}catch{stop('network');return false;}
    if(closed)return false;
    // A socket that cannot even be made ends the pairing, or it would stay «active» for ever (code review, 19 Nov 2026).
    try{socket=new Client({host:'robottino-stackchan.example.workers.dev',port:443,path:'/api/robot/pair'});}
    catch{stop('error');return false;}
    timer=Timer.set(()=>stop('expired'),330000); // the server code lasts 5 minutes
    socket.callback=(type,value)=>{
      if(closed)return;
      try{
        if(type===Client.receive&&typeof value==='string'){
          const event=pairingEvent(value);
          if(event.type==='code'){
            code=event.code;hooks.diag?.('code');hooks.code(event.code);
            if(keepalive===undefined)keepalive=Timer.repeat(()=>{try{socket?.write(JSON.stringify({type:'ping'}));}catch{}},KEEPALIVE_MS);
            return;
          }
          if(event.type!=='credential'){stop('error');return;}
          hooks.diag?.('cred');
          let ok=false;stored=true;
          try{Preference.set('robottino','deviceToken',event.token);ok=Preference.get('robottino','deviceToken')===event.token;}catch{}
          hooks.diag?.(ok?'stored':'notstored');socket.write(JSON.stringify({type:'stored',ok}));savedOk=ok;
          // Let the confirmation leave before closing.
          if(timer!==undefined)Timer.clear(timer);timer=Timer.set(()=>stop(ok?'paired':'store_failed'),500);
        }else if(type===Client.handshake)hooks.diag?.('open');
        // The server closes as soon as it has the confirmation (src/pairing.ts): after the token, that is the end of a
        // pairing that worked, not an interruption (code review, 19 Nov 2026).
        else if(type===Client.disconnect)stop(stored?(savedOk?'paired':'store_failed'):'closed');
      }catch{stop('error');}
    };
    return true;
  }
  return {start,stop:()=>stop('user'),get active(){return !closed;},get code(){return code;}};
}
