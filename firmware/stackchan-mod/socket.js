// Classic-style WebSocket client (callback, write, close) on the host's ECMA-419 WebSocket client
// (device.network.ws.io with the host's wss configuration: TLS with certificate verification on, the host's root
// certificates), as the host's own web WebSocket builds it.
// Not that web WebSocket (9 Nov 2026): when the server closed while data still waited in its queue (camera pieces,
// microphone audio), it wrote that data on the closing connection from inside a native callback; the error was
// unhandled and the robot restarted. Here data goes out only into the room the connection reports, nothing is
// written after the close, and no error from a callback reaches the host.
import Timer from 'timer';
import Modules from 'modules';
const CLOSE_WAIT_MS=2000;
const bytesOf=text=>typeof ArrayBuffer.fromString==='function'?ArrayBuffer.fromString(text):new TextEncoder().encode(text).buffer;
const textOf=buffer=>typeof String.fromArrayBuffer==='function'?String.fromArrayBuffer(buffer):new TextDecoder().decode(buffer);
// Connections being opened (DNS, TCP, TLS handshake). The handshake keeps the robot busy for long stretches: no
// head command starts meanwhile (mod.js), so a servo reply is never read late (9 Nov 2026).
let opening=0;
export const connecting=()=>opening>0;
// Wi-Fi without power saving while something streams (camera, call, conversation; 10 Nov 2026). At rest the host
// keeps the radio in modem sleep: it wakes about every 100 ms, so what comes from the network can wait that long.
// The host offers mods a lease for this (network-power, as its own example mod uses): held, the radio stays awake;
// closed, the host goes back to saving power. Without that module, or if the driver refuses, nothing changes.
// It is not what limits the speed of the link (measured 10 Nov 2026, the same with and without the lease): the
// host's connection holds 5.7 KB to send (four packets, a host build setting) and takes more only when the network
// has confirmed them, 130-190 ms later on the iPhone hotspot: about 23 KB/s, one whole following frame a second.
// So the following image is small enough to leave in one go (live-wire.js windowChunks), and room says when.
export function lowLatency(){
  let lease;
  try{if(Modules.has('network-power'))lease=Modules.importNow('network-power').acquireLowLatency();}catch{lease=undefined;}
  if(typeof trace==='function')trace(`[robottino] wifi fast ${lease?'on':'unavailable'}\n`);
  return {get held(){return !!lease;},close(){const held=lease;lease=undefined;if(!held)return;try{held.close();}catch{}if(typeof trace==='function')trace('[robottino] wifi fast off\n');}};
}
// TEMPORARY (K151 bring-up, 10 Nov 2026): a small fixed log of when data is written and when the connection gives
// room back, to find where following loses its time (about 200 ms for every 4 KB piece, with or without the Wi-Fi
// lease). Nothing is recorded before probeStart(); five numbers an event (ms, kind, three values).
const PROBE_EVENTS=64;
const join=(a,b)=>{const out=new Uint8Array(a.byteLength+b.byteLength);out.set(new Uint8Array(a),0);out.set(new Uint8Array(b),a.byteLength);return out.buffer;};
export class Client{
  static handshake=2;static receive=3;static disconnect=4;
  #client;#open=false;#ended=false;#opening=true;#writable=0;#queue=[];#queued=0;#message;#probe;#probeCount=0;#probeAt=0;
  callback;
  constructor({host,port=443,path='/',headers=[]}){
    const pairs=new Map();for(let i=0;i+1<headers.length;i+=2)pairs.set(headers[i],headers[i+1]);
    const network=globalThis.device.network;
    opening++;
    // noDelay: every message leaves at once. Otherwise a short one (the answer to a command, the end of an image)
    // waits until the network has confirmed the data sent before it, 130-190 ms on the hotspot (10 Nov 2026).
    try{this.#client=new network.ws.io({...network.wss,socket:{...network.wss.socket,noDelay:true},host,port,path,headers:pairs,
      onReadable:(count,options)=>{try{this.#readable(count,options);}catch{this.#end();}},
      onWritable:count=>{try{this.#writableNow(count);}catch{this.#end();}},
      // A close from the server: stop at once. The client answers it and shuts the connection by itself.
      onControl:opcode=>{if(opcode===8)this.#end();},
      onClose:()=>this.#end(),
      onError:()=>this.#end()
    });}catch(error){this.#opened();throw error;}
  }
  probeStart(){this.#probe??=new Int32Array(PROBE_EVENTS*5);this.#probeCount=0;this.#probeAt=Date.now();}
  note(kind,a=0,b=0,c=0){
    const log=this.#probe;if(!log||this.#probeCount>=PROBE_EVENTS)return;
    const at=this.#probeCount++*5;log[at]=Date.now()-this.#probeAt;log[at+1]=kind.charCodeAt(0);log[at+2]=a;log[at+3]=b;log[at+4]=c;
  }
  // The events as text lines, eight an entry: «ms kind a/b/c».
  probeLines(){
    const log=this.#probe,lines=[];if(!log)return lines;
    for(let i=0,text='';i<this.#probeCount;i++){
      const at=i*5;text+=` ${log[at]}${String.fromCharCode(log[at+1])}${log[at+2]}/${log[at+3]}/${log[at+4]}`;
      if(i%8===7||i===this.#probeCount-1){lines.push(text);text='';}
    }
    return lines;
  }
  #opened(){if(this.#opening){this.#opening=false;opening--;}}
  // Bytes not yet handed to the connection.
  get bufferedAmount(){return this.#queued;}
  // Bytes the connection takes right now without making them wait (none while something already waits).
  get room(){return this.#open&&!this.#ended&&!this.#queue.length?this.#writable:0;}
  write(data){
    if(this.#ended)throw Error('socket_closed');
    let binary=true;
    if(typeof data==='string'){data=bytesOf(data);binary=false;}
    else if(ArrayBuffer.isView(data))data=data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength);
    else if(!(data instanceof ArrayBuffer))throw TypeError('invalid_data');
    this.note('q',data.byteLength,this.#queued,this.#writable);
    this.#queue.push({data,binary});this.#queued+=data.byteLength;
    this.#flush();
  }
  close(){
    if(this.#ended)return;
    this.#ended=true;this.#queue=[];this.#queued=0;this.#opened();
    const client=this.#client;
    // A normal close (code 1000) when there is room for it, then the connection goes in any case.
    if(this.#open&&this.#writable>=2){try{client.write(Uint8Array.of(0x03,0xE8),{opcode:8});Timer.set(()=>{try{client.close();}catch{}},CLOSE_WAIT_MS);return;}catch{}}
    try{client.close();}catch{}
  }
  #end(){
    if(this.#ended)return;
    this.#ended=true;this.#queue=[];this.#queued=0;this.#opened();
    try{this.callback?.(Client.disconnect);}catch{}
  }
  #writableNow(count){
    if(this.#ended)return;
    this.note('r',count,this.#queued);
    this.#writable=count;
    if(!this.#open){this.#open=true;this.#opened();this.callback?.(Client.handshake);if(this.#ended)return;}
    this.#flush();
  }
  #flush(){
    while(this.#open&&!this.#ended&&this.#queue.length){
      const item=this.#queue[0],length=item.data.byteLength,room=this.#writable;
      if(room<=0)return;
      if(length<=room){
        const from=Date.now();
        try{this.#writable=this.#client.write(item.data,{binary:item.binary});}catch{this.#end();return;}
        this.note('w',length,this.#writable,Date.now()-from);
        this.#queue.shift();this.#queued-=length;
      }else{
        // Larger than the room left: the first part now, the rest of the same message when there is room again.
        const from=Date.now();
        try{this.#writable=this.#client.write(item.data.slice(0,room),{binary:item.binary,more:true});}catch{this.#end();return;}
        this.note('f',room,this.#writable,Date.now()-from);
        item.data=item.data.slice(room);this.#queued-=room;
        return;
      }
    }
  }
  #readable(count,options){
    if(!count)return;
    this.note('i',count);
    const data=this.#client.read(count);
    if(this.#ended||!this.#open)return;
    const message=this.#message?join(this.#message,data):data;
    if(options?.more){this.#message=message;return;}
    this.#message=undefined;
    this.callback?.(Client.receive,options?.binary?message:textOf(message));
  }
}
