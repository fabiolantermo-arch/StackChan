// robottino-socket over a fake of the host's ECMA-419 WebSocket client: no network involved. The fake throws like
// the real one (modules/embedded/network/ws/client) when written to while not connected or past its room.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SourceTextModule,SyntheticModule,createContext} from 'node:vm';
import {readFile} from 'node:fs/promises';
async function load({power}={}){
  const sockets=[],timers=[];
  class WS{
    constructor(options){this.options=options;this.writes=[];this.incoming=[];this.state='connected';this.room=0;this.closes=0;sockets.push(this);}
    write(data,options){
      const bytes=data instanceof ArrayBuffer?new Uint8Array(data):data;
      if(this.state!=='connected'||bytes.byteLength+8>this.room)throw new Error;
      this.writes.push({bytes:[...bytes],options:{...options}});this.room-=bytes.byteLength+8;return Math.max(0,this.room-8);
    }
    read(count){const next=this.incoming.shift();assert.equal(next.byteLength,count);return next;}
    close(){this.closes++;if(this.closes>1)throw new TypeError('closed twice');this.state='closed';}
    // What the host does: room for writing, a message, a close from the server.
    writable(room){this.room=room;this.options.onWritable(Math.max(0,room-8));}
    receive(bytes,options){const buffer=new Uint8Array(bytes).buffer;this.incoming.push(buffer);this.options.onReadable(buffer.byteLength,options);}
    serverClose(){this.options.onControl(8,new ArrayBuffer(2));this.state='closing';}
  }
  const wss={verify:true,socket:{io:'TLS'}};
  const context=createContext({Error,TypeError,Map,ArrayBuffer,Uint8Array,TextEncoder,TextDecoder,device:{network:{ws:{io:WS},wss}}});
  const timer=new SyntheticModule(['default'],function(){this.setExport('default',{set(fn,ms){timers.push({fn,ms});return timers.length;}});},{context});
  const root=new SourceTextModule(await readFile(new URL('./socket.js',import.meta.url),'utf8'),{context});
  // The host's modules as a mod sees them: network-power only when the host has it.
  const host=new SyntheticModule(['default'],function(){this.setExport('default',{has:name=>name==='network-power'&&!!power,importNow(name){if(name!=='network-power'||!power)throw Error('not found');return power;}});},{context});
  await root.link(async name=>{if(name==='timer')return timer;if(name==='modules')return host;throw Error(name);});await root.evaluate();
  return {Client:root.namespace.Client,connecting:root.namespace.connecting,lowLatency:root.namespace.lowLatency,sockets,timers,wss};
}
const text=s=>[...new TextEncoder().encode(s)];
test('opens wss with the host configuration (TLS verification on) and the header pairs',async()=>{
  const {Client,sockets,wss}=await load();
  new Client({host:'example.workers.dev',port:443,path:'/api/robot/device',headers:['Authorization','Bearer abc']});
  const o=sockets[0].options;
  assert.equal(o.host,'example.workers.dev');assert.equal(o.port,443);assert.equal(o.path,'/api/robot/device');
  assert.deepEqual([...o.headers],[['Authorization','Bearer abc']]);
  assert.equal(o.verify,true);assert.equal(o.socket.io,wss.socket.io,'the host wss configuration (TLS), not an override');
  assert.deepEqual(JSON.parse(JSON.stringify(o.socket)),{io:'TLS',noDelay:true},'plus only: every message leaves at once');assert.deepEqual(wss.socket,{io:'TLS'},'the host configuration itself is not touched');
});
test('room: what the connection takes at once, none before it opens, while something waits or after the end',async()=>{
  const {Client,sockets}=await load();
  const client=new Client({host:'h',path:'/x'}),ws=sockets[0];client.callback=()=>{};
  assert.equal(client.room,0,'not open yet');
  ws.writable(5000+8);assert.equal(client.room,5000);
  client.write(new ArrayBuffer(1620));assert.equal(client.room,5000-1620-8,'less after a write (the fake takes 8 bytes a message)');
  client.write(new ArrayBuffer(4000));assert.ok(client.bufferedAmount>0);assert.equal(client.room,0,'something waits: no room');
  ws.writable(6000);assert.equal(client.bufferedAmount,0);assert.ok(client.room>0,'room again once the network has taken it');
  client.close();assert.equal(client.room,0);
});
test('opens on the first room to write, delivers text, binary and messages in parts, writes what fits',async()=>{
  const {Client,sockets}=await load();
  const client=new Client({host:'example.workers.dev',path:'/x'}),ws=sockets[0];
  const events=[];client.callback=(type,value)=>events.push([type,value instanceof ArrayBuffer?[...new Uint8Array(value)]:value]);
  client.write('presto');assert.equal(ws.writes.length,0,'nothing before the connection is ready');assert.equal(client.bufferedAmount,6);
  ws.writable(1000);assert.deepEqual(events[0],[Client.handshake,undefined]);
  assert.deepEqual(ws.writes[0],{bytes:text('presto'),options:{binary:false}});assert.equal(client.bufferedAmount,0);
  ws.receive(text('{"type":"ping"}'),{binary:false});ws.receive([1,2],{binary:true,more:true});ws.receive([3],{binary:true});
  assert.deepEqual(events.slice(1),[[Client.receive,'{"type":"ping"}'],[Client.receive,[1,2,3]]]);
  client.write(new Uint8Array([9,1,2,3]).subarray(1));assert.deepEqual(ws.writes[1],{bytes:[1,2,3],options:{binary:true}});
});
test('a message larger than the room goes in parts, the rest when there is room again',async()=>{
  const {Client,sockets}=await load();
  const client=new Client({host:'h',path:'/x'}),ws=sockets[0];client.callback=()=>{};
  ws.writable(10+8);
  client.write(new Uint8Array(25).fill(7).buffer);
  assert.equal(ws.writes[0].bytes.length,10);assert.deepEqual(ws.writes[0].options,{binary:true,more:true});assert.equal(client.bufferedAmount,15);
  ws.writable(100);assert.equal(ws.writes[1].bytes.length,15);assert.deepEqual(ws.writes[1].options,{binary:true});assert.equal(client.bufferedAmount,0);
});
test('the server closes while data waits: one disconnect, nothing written afterwards, nothing thrown (restart of 9 Nov 2026)',async()=>{
  const {Client,sockets}=await load();
  const client=new Client({host:'h',path:'/x'}),ws=sockets[0];const events=[];client.callback=type=>events.push(type);
  ws.writable(4096+8);client.write(new ArrayBuffer(4096));client.write(new ArrayBuffer(4096));
  assert.equal(client.bufferedAmount,4096,'a camera piece still waits');
  ws.serverClose();
  assert.deepEqual(events,[Client.handshake,Client.disconnect]);assert.equal(client.bufferedAmount,0,'the waiting data is dropped');
  assert.doesNotThrow(()=>ws.writable(9000),'the host calls back after answering the close: no write, no error');
  assert.equal(ws.writes.length,1);
  assert.throws(()=>client.write('dopo'),/socket_closed/);
  client.close();assert.equal(ws.closes,0,'the host client finishes the close by itself');assert.deepEqual(events,[Client.handshake,Client.disconnect]);
});
test('a write the host refuses or a failing callback ends the link without throwing into the host',async()=>{
  const {Client,sockets}=await load();
  const client=new Client({host:'h',path:'/x'}),ws=sockets[0];const events=[];
  client.callback=(type,value)=>{events.push(type);if(type===Client.receive)throw Error('boom');};
  ws.writable(100);
  assert.doesNotThrow(()=>ws.receive(text('x'),{binary:false}));assert.deepEqual(events,[Client.handshake,Client.receive,Client.disconnect]);
  const other=new Client({host:'h',path:'/y'}),ws2=sockets[1];const seen=[];other.callback=type=>seen.push(type);
  ws2.writable(100);ws2.state='closing';
  assert.doesNotThrow(()=>other.write('ciao'));assert.deepEqual(seen,[Client.handshake,Client.disconnect]);
  assert.doesNotThrow(()=>ws2.options.onError());assert.deepEqual(seen,[Client.handshake,Client.disconnect],'one disconnect only');
});
test('close sends a normal close when there is room, then lets the connection go; pairing has no header',async()=>{
  const {Client,sockets,timers}=await load();
  const client=new Client({host:'h',path:'/api/robot/pair'}),ws=sockets[0];const events=[];client.callback=type=>events.push(type);
  assert.equal(ws.options.headers.size,0);
  ws.writable(1000);client.write(new ArrayBuffer(200));client.close();
  assert.deepEqual(ws.writes.at(-1),{bytes:[0x03,0xE8],options:{opcode:8}});assert.equal(client.bufferedAmount,0);
  assert.equal(timers.length,1);assert.equal(timers[0].ms,2000);
  ws.options.onClose();timers[0].fn();assert.deepEqual(events,[Client.handshake],'closing on purpose is not a disconnect');
  assert.throws(()=>client.write('x'),/socket_closed/);
  const early=new Client({host:'h',path:'/z'}),ws3=sockets[1];early.close();assert.equal(ws3.closes,1,'not open yet: closed at once');
});
test('connecting() is true from creation to open or end (no head command meanwhile, mod.js)',async()=>{
  const {Client,connecting,sockets}=await load();
  assert.equal(connecting(),false);
  const a=new Client({host:'h',path:'/a'});a.callback=()=>{};assert.equal(connecting(),true);
  const b=new Client({host:'h',path:'/b'});b.callback=()=>{};
  sockets[0].writable(100);assert.equal(connecting(),true,'one still opening');
  sockets[1].options.onError();assert.equal(connecting(),false,'opened or ended: none left');
  const c=new Client({host:'h',path:'/c'});c.close();assert.equal(connecting(),false,'closed before opening');
  sockets[0].writable(100);sockets[0].options.onClose();assert.equal(connecting(),false,'counted once only');
});
test('Wi-Fi awake on request: the host\'s lease is taken once and given back once; without it nothing changes (10 Nov 2026)',async()=>{
  const events=[];
  const {lowLatency}=await load({power:{acquireLowLatency(){events.push('on');return {close(){events.push('off');}};}}});
  const lease=lowLatency();assert.equal(lease.held,true);assert.deepEqual(events,['on']);
  lease.close();lease.close();assert.deepEqual(events,['on','off'],'closed once only');assert.equal(lease.held,false);
  const old=await load();const none=old.lowLatency();assert.equal(none.held,false,'an older host: no lease, no error');none.close();
  const refusing=await load({power:{acquireLowLatency(){throw Error('failed to set Wi-Fi power save');}}});
  const refused=refusing.lowLatency();assert.equal(refused.held,false,'the driver refuses: the robot goes on as before');refused.close();
  const stuck=await load({power:{acquireLowLatency(){return {close(){throw Error('driver');}};}}});
  const held=stuck.lowLatency();assert.doesNotThrow(()=>held.close(),'an error giving it back never reaches the caller');
});
// TEMPORARY (K151 bring-up): the timing log used to find where following loses its time.
test('temporary timing log: nothing before probeStart, then writes, room and incoming data, never more than its fixed size',async()=>{
  const {Client,sockets}=await load();
  const client=new Client({host:'example.workers.dev',path:'/x'}),ws=sockets[0];
  client.note('c');assert.equal(client.probeLines().length,0,'nothing is kept before probeStart');
  ws.writable(40);client.probeStart();
  client.write(new Uint8Array(20).buffer);client.write(new Uint8Array(30).buffer);ws.writable(100);ws.receive([1,2,3],{binary:true});
  const kinds=client.probeLines().join('').trim().split(' ').map(entry=>entry.replace(/^\d+/,''));
  assert.deepEqual(kinds.map(entry=>entry[0]),['q','w','q','f','r','w','i']);
  assert.equal(kinds[1].split('/')[0],'w20');assert.equal(kinds[3].split('/')[0],'f4','the part that fitted');assert.equal(kinds[4],'r92/26/0');
  for(let i=0;i<200;i++)client.note('g',i);
  const lines=client.probeLines();assert.equal(lines.join('').trim().split(' ').length,64);assert.ok(lines.every(line=>line.trim().split(' ').length<=8));
  client.probeStart();assert.equal(client.probeLines().length,0);
});
