import {DurableObject} from 'cloudflare:workers';
import {caps,command,packet,danceSteps,type RobotCaps,type Action} from './robot-wire';
type Peer={gone?:boolean;role:'app'|'device';epoch:string;born:number;seen:number;window:number;count:number;bytes:number;seq:number;hello?:RobotCaps;camera:boolean;call:boolean;screen:boolean;pending:{id:string;action:Action;until:number}[];ids:string[]};
// A session is the robot and one app together: at most 10 minutes, counted from when the app joined. The robot's link
// waits alone between sessions and is renewed every 10 minutes; until 10 Nov 2026 its own age ended the session too,
// so an app that joined a link 9 minutes old was cut after one minute (the owner: «dopo un po' si scollega»).
// Alone, the robot's link still lasts 10 minutes; a link silent for 15 s closes the session as before.
const SESSION_MS=600000,SILENCE_MS=15000;
const empty:RobotCaps={hardwareVerified:false,calibrated:false,motion:false,camera:false,audio:false,screen:false};
export class RobotLink extends DurableObject<Env>{
  // A link that was closed here is out at once (`gone`), also when the other side never answers the close: a robot
  // that restarted, or was switched off, leaves its old link half open, and for the runtime it can stay «open» long
  // after (11 Nov 2026: the restarted robot was refused as busy, 409, for more than eight minutes; no Live and no
  // picture for «cos'è questo?»).
  private peers(role?:string){return this.ctx.getWebSockets().filter(ws=>{if(ws.readyState!==1)return false;const peer=this.info(ws);return !!peer&&!peer.gone&&(!role||peer.role===role);});}
  private info(ws:WebSocket):Peer{return ws.deserializeAttachment();}
  private send(ws:WebSocket,value:unknown){ws.send(JSON.stringify(value));}
  private expired(peer:Peer,now:number){
    const app=peer.role==='device'?this.peers('app')[0]:undefined;
    return now-(app?Math.max(peer.born,this.info(app).born):peer.born)>SESSION_MS;
  }
  private closeAll(reason:string,epoch?:string){for(const ws of this.peers()){const peer=this.info(ws);if(epoch&&peer.epoch!==epoch)continue;try{ws.serializeAttachment({...peer,gone:true});}catch{}try{ws.close(1000,reason);}catch{}}}
  status(){
    const ws=this.peers('device')[0],peer=ws&&this.info(ws),fresh=!!peer&&Date.now()-peer.seen<SILENCE_MS&&!this.expired(peer,Date.now());
    return {connected:fresh&&!!peer?.hello,...(fresh&&peer?.hello?peer.hello:empty),protocol:'robottino-live-v1',audioFormat:'mulaw_8000_mono',videoFormat:'rgb565le',motionEnabled:fresh&&!!peer?.hello?.motion&&!!peer?.hello?.calibrated&&!!peer?.hello?.hardwareVerified};
  }
  private lastReaction=0;
  // Fixed reactions only (Claude Code hooks): no free text reaches the robot.
  reaction(kind:string){
    if(!['attention','done','success','failure'].includes(kind))return {delivered:false,error:'invalid_reaction'};
    const now=Date.now();if(now-this.lastReaction<2000)return {delivered:false,error:'too_soon'};
    const device=this.peers('device')[0];if(!device||!this.status().connected)return {delivered:false,error:'robot_offline'};
    this.lastReaction=now;this.send(device,{type:'reaction',kind});return {delivered:true};
  }
  private broadcast(){for(const ws of this.peers('app'))this.send(ws,{type:'status',...this.status()});}
  async fetch(request:Request){
    if(request.headers.get('upgrade')?.toLowerCase()!=='websocket')return new Response('WebSocket richiesto',{status:426});
    const role=request.headers.get('x-robottino-role');if(role!=='app'&&role!=='device')return new Response(null,{status:403});
    // A link of the same role that has been silent for SILENCE_MS is dead (the alarm would close it too): it does not
    // keep the new one out. A live one still does.
    for(const ws of this.peers(role)){const peer=this.info(ws);if(Date.now()-peer.seen>SILENCE_MS){console.log(JSON.stringify({event:'link.stale_replaced',role}));this.closeAll(role==='device'?'robot_silent':'app_silent',peer.epoch);}}
    if(this.peers(role).length)return Response.json({error:'robot_session_busy'},{status:409});
    const pair=new WebSocketPair(),server=pair[1];
    this.ctx.acceptWebSocket(server,[role]);
    const other=this.peers().find(ws=>ws!==server),epoch=other?this.info(other).epoch:crypto.randomUUID();
    server.serializeAttachment({role,epoch,born:Date.now(),seen:Date.now(),window:Date.now(),count:0,bytes:0,seq:0,camera:false,call:false,screen:false,pending:[],ids:[]} satisfies Peer);
    await this.ctx.storage.setAlarm(Date.now()+5000);
    this.send(server,{type:'connected',role,protocol:'robottino-live-v1'});
    if(role==='app'){
      const device=this.peers('device')[0];if(device)this.send(device,{type:'peer.connected'});
      this.send(server,{type:'status',...this.status()});
    }
    if(role==='device'&&this.peers('app').length)this.send(server,{type:'peer.connected'});
    return new Response(null,{status:101,webSocket:pair[0]});
  }
  webSocketMessage(ws:WebSocket,message:string|ArrayBuffer){
    const peer=this.info(ws),now=Date.now();
    if(!peer||peer.gone)return; // closed here already: nothing more from it counts
    if(this.expired(peer,now)){this.closeAll('session_expired');return;}
    if(now-peer.window>=1000){peer.window=now;peer.count=0;peer.bytes=0;}
    peer.seen=now;peer.count++;peer.bytes+=typeof message==='string'?message.length*2:message.byteLength;
    if(peer.count>120||peer.bytes>800000){this.closeAll('rate_limit');return;}
    if(typeof message!=='string'){
      const decoded=packet(message),device=this.peers('device')[0],app=this.peers('app')[0];
      if(!decoded||decoded.sequence<=peer.seq){this.closeAll('invalid_media');return;}
      peer.seq=decoded.sequence;ws.serializeAttachment(peer);
      if(!device||!app)return;
      const modes=this.info(device);
      const camera=decoded.kind===1||decoded.kind===4||decoded.kind===6;
      if(camera&&peer.role!=='device'||(decoded.kind===2||decoded.kind===5)&&peer.role!=='app'){this.closeAll('wrong_media_direction');return;}
      if(camera&&!modes.camera||(decoded.kind===2||decoded.kind===5)&&!modes.screen||decoded.kind===3&&!modes.call)return;
      (peer.role==='app'?device:app).send(message);return;
    }
    ws.serializeAttachment(peer);
    if(message.length>4096){this.closeAll('message_too_large');return;}
    let value:any;try{value=JSON.parse(message);}catch{this.closeAll('invalid_json');return;}
    if(!value||typeof value!=='object'||Array.isArray(value)){this.closeAll('invalid_event');return;}
    if(value.type==='ping'){this.send(ws,{type:'pong'});return;}
    if(peer.role==='device'){
      if(value.type==='hello'){
        const capabilities=caps(value.capabilities);if(!capabilities){this.closeAll('invalid_capabilities');return;}
        peer.hello=capabilities;ws.serializeAttachment(peer);this.broadcast();return;
      }
      if(value.type==='ack'){
        const app=this.peers('app')[0];if(!app)return;
        const owner=this.info(app),pending=owner.pending.find(p=>p.id===value.id);
        if(!pending||pending.until<now||typeof value.ok!=='boolean'){this.closeAll('invalid_ack');return;}
        owner.pending=owner.pending.filter(p=>p.id!==value.id);app.serializeAttachment(owner);
        if(value.ok){
          // Face following streams small camera frames too: the same permission as the video.
          if(pending.action.startsWith('camera.')||pending.action==='track.start'||pending.action==='track.stop')peer.camera=pending.action.endsWith('start');
          if(pending.action.startsWith('call.'))peer.call=pending.action.endsWith('start');
          if(pending.action.startsWith('screen.'))peer.screen=pending.action.endsWith('start');
          if(pending.action==='stop')peer.camera=peer.call=peer.screen=false;
          ws.serializeAttachment(peer);
        }
        this.send(app,{type:'ack',id:value.id,ok:value.ok,error:value.ok?undefined:'device_rejected'});return;
      }
      this.closeAll('invalid_device_event');return;
    }
    if(!command(value)){this.closeAll('invalid_command');return;}
    const device=this.peers('device')[0],status=this.status();
    if(!device||!status.connected){this.send(ws,{type:'ack',id:value.id,ok:false,error:'robot_offline'});return;}
    const available=(value.action.startsWith('camera.')||value.action==='track.start'?status.camera:value.action.startsWith('call.')?status.audio:value.action.startsWith('screen.')?status.screen:true);
    const moves=value.action==='motion'||value.action==='dance'||value.action==='track.start'||value.action==='track'||value.action==='mirror'&&value.followHead;
    if(!available||(value.action!=='stop'&&value.action!=='track.stop'&&!status.hardwareVerified)||(['mirror','face.style'].includes(value.action)&&!status.screen)||(moves&&!status.motionEnabled)){
      this.send(ws,{type:'ack',id:value.id,ok:false,error:'capability_unavailable'});return;
    }
    if(peer.pending.some(p=>p.until<now)){this.closeAll('command_timeout');return;}
    if(peer.ids.includes(value.id)){this.send(ws,{type:'ack',id:value.id,ok:false,error:'duplicate_command'});return;}
    if(peer.pending.length>=4){this.send(ws,{type:'ack',id:value.id,ok:false,error:'busy'});return;}
    peer.ids.push(value.id);if(peer.ids.length>128)peer.ids.shift();
    if(value.action==='stop')peer.pending=[];
    peer.pending.push({id:value.id,action:value.action,until:now+1500});ws.serializeAttachment(peer);
    // Strip caller-controlled fields; no provider keys or arbitrary device instructions.
    this.send(device,{type:'command',id:value.id,action:value.action,yaw:value.yaw,pitch:value.pitch,leftEye:value.leftEye,rightEye:value.rightEye,mouth:value.mouth,followHead:value.followHead,style:value.style,steps:value.action==='dance'?danceSteps(value.steps):undefined,frameId:value.action==='track'?value.frameId:undefined,x:value.action==='track'?value.x:undefined,y:value.action==='track'?value.y:undefined});
  }
  webSocketClose(ws:WebSocket){const peer=this.info(ws);if(peer&&!peer.gone)this.closeAll('peer_disconnected',peer.epoch);}
  webSocketError(ws:WebSocket){const peer=this.info(ws);if(peer&&!peer.gone)this.closeAll('peer_error',peer.epoch);}
  async alarm(){
    const now=Date.now();
    for(const ws of this.peers()){
      // The reason tells the app what happened (it shows it in plain words): who went silent, time over, or a command
      // the robot did not confirm.
      const p=this.info(ws),reason=now-p.seen>SILENCE_MS?(p.role==='device'?'robot_silent':'app_silent'):this.expired(p,now)?'session_expired':p.pending.some(command=>command.until<now)?'command_timeout':undefined;
      if(reason){this.closeAll(reason);break;}
    }
    if(this.peers().length)await this.ctx.storage.setAlarm(now+5000);
  }
}
