// End-to-end pairing against the deployed Worker: plays the robot (no credential), receives a code,
// types it as the app would and checks the robot gets its own credential. Never prints tokens.
import WebSocket from 'ws';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pairingEvent} from '../firmware/stackchan-mod/live-wire.js';
const root=new URL('../',import.meta.url),host='robottino-stackchan.example.workers.dev';
const appToken=(await readFile(new URL('private/robot-token',root),'utf8')).trim(),deviceToken=(await readFile(new URL('private/robot-device-token',root),'utf8')).trim();
const robot=new WebSocket(`wss://${host}/api/robot/pair`),inbox=[],waiters=[];
robot.on('message',data=>{const event=pairingEvent(data.toString());const w=waiters.shift();if(w)w(event);else inbox.push(event);});
const next=()=>inbox.length?Promise.resolve(inbox.shift()):new Promise((resolve,reject)=>{waiters.push(resolve);setTimeout(()=>reject(Error('timeout')),15000);});
await new Promise((resolve,reject)=>{robot.once('open',resolve);robot.once('error',reject);});
const shown=await next();assert.equal(shown.type,'code');
const deliver=code=>fetch(`https://${host}/api/robot/pair`,{method:'POST',headers:{authorization:'Bearer '+appToken,'content-type':'application/json'},body:JSON.stringify({code})});
const wrong=await deliver(shown.code==='000000'?'000001':'000000');assert.equal(wrong.status,404);
const answer=deliver(`${shown.code.slice(0,3)} ${shown.code.slice(3)}`);
const credential=await next();assert.equal(credential.type,'credential');assert.ok(credential.token===deviceToken,'the robot receives exactly its own credential');
robot.send(JSON.stringify({type:'stored',ok:true}));
const done=await answer;assert.equal(done.status,200);assert.deepEqual(await done.json(),{ok:true});
robot.close();
console.log('PASS pairing over Cloudflare: code shown, wrong code refused, credential delivered only after the app typed the code, success only after the robot confirmed. Tokens not printed.');
