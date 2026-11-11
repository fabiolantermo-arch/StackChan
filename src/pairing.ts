import {DurableObject} from 'cloudflare:workers';
// First pairing of the robot without putting any key in the firmware: the robot opens an
// unauthenticated socket and shows a 6-digit code on its screen; the owner types it in the
// app (app token); only then the server hands the robot its own device credential, and the
// app gets success only after the robot confirms it saved it.
export const PAIRING={codeTtlMs:300000,storeTimeoutMs:10000,maxWaiting:4,maxFailures:10,failureWindowMs:3600000};
type Waiting={ws:WebSocket;expires:number;timer:ReturnType<typeof setTimeout>;stored?:(ok:boolean)=>void};
export class RobotPairing extends DurableObject<Env>{
  private waiting=new Map<string,Waiting>();
  private failures:number[]=[];
  private drop(code:string){const item=this.waiting.get(code);if(!item)return;clearTimeout(item.timer);this.waiting.delete(code);item.stored?.(false);try{item.ws.close(1000,'pairing_closed');}catch{}}
  private newCode(){
    for(;;){const n=crypto.getRandomValues(new Uint32Array(1))[0]%1000000,code=String(n).padStart(6,'0');if(!this.waiting.has(code))return code;}
  }
  async fetch(request:Request){
    if(request.headers.get('upgrade')?.toLowerCase()!=='websocket')return new Response('WebSocket richiesto',{status:426});
    if(this.waiting.size>=PAIRING.maxWaiting)return Response.json({error:'pairing_busy'},{status:429});
    const pair=new WebSocketPair(),ws=pair[1];ws.accept();
    const code=this.newCode(),item:Waiting={ws,expires:Date.now()+PAIRING.codeTtlMs,timer:setTimeout(()=>this.drop(code),PAIRING.codeTtlMs)};
    this.waiting.set(code,item);
    ws.addEventListener('message',event=>{
      try{const value=JSON.parse(String(event.data));if(value?.type==='stored'){const done=item.stored;item.stored=undefined;done?.(value.ok===true);}}catch{this.drop(code);}
    });
    ws.addEventListener('close',()=>{if(this.waiting.get(code)===item){clearTimeout(item.timer);this.waiting.delete(code);item.stored?.(false);}});
    ws.send(JSON.stringify({type:'code',code,expiresInSeconds:PAIRING.codeTtlMs/1000}));
    return new Response(null,{status:101,webSocket:pair[0]});
  }
  /** Called with the app token already checked. */
  async deliver(code:string,credential:string|undefined){
    const now=Date.now();this.failures=this.failures.filter(t=>now-t<PAIRING.failureWindowMs);
    if(this.failures.length>=PAIRING.maxFailures)return {ok:false,error:'too_many_attempts'};
    if(!credential||credential.length<32)return {ok:false,error:'not_configured'};
    const item=/^\d{6}$/.test(code)?this.waiting.get(code):undefined;
    if(!item||item.expires<now){this.failures.push(now);return {ok:false,error:'unknown_code'};}
    if(item.stored)return {ok:false,error:'pairing_in_progress'};
    const saved=await new Promise<boolean>(resolve=>{
      const timer=setTimeout(()=>{item.stored=undefined;resolve(false);},PAIRING.storeTimeoutMs);
      item.stored=ok=>{clearTimeout(timer);resolve(ok);};
      item.ws.send(JSON.stringify({type:'credential',token:credential}));
    });
    this.drop(code);
    return saved?{ok:true}:{ok:false,error:'robot_not_confirmed'};
  }
}
