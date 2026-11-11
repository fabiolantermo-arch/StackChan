import {expect,it} from 'vitest';
import {env} from 'cloudflare:workers';
import worker from '../src/index';
const bindings={...env,ROBOT_API_TOKEN:'a'.repeat(64),ROBOT_DEVICE_TOKEN:'d'.repeat(64)} as any;
async function robot(){
  const response=await worker.fetch(new Request('https://unit/api/robot/pair',{headers:{upgrade:'websocket'}}),bindings);
  expect(response.status).toBe(101);const ws=response.webSocket!;ws.accept();
  const messages:any[]=[],waiters:((v:any)=>void)[]=[];
  ws.addEventListener('message',e=>{const v=JSON.parse(String(e.data));const w=waiters.shift();if(w)w(v);else messages.push(v);});
  const next=()=>messages.length?Promise.resolve(messages.shift()):new Promise<any>(resolve=>waiters.push(resolve));
  return {ws,next};
}
const deliver=(code:string,token=bindings.ROBOT_API_TOKEN)=>worker.fetch(new Request('https://unit/api/robot/pair',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({code})}),bindings);

it('gives the device credential only to the robot showing the code, and succeeds only after it saved it',async()=>{
  const r=await robot(),shown=await r.next();
  expect(shown.type).toBe('code');expect(shown.code).toMatch(/^\d{6}$/);
  expect((await deliver(shown.code,bindings.ROBOT_DEVICE_TOKEN)).status).toBe(401);
  expect((await deliver(shown.code==='000000'?'111111':'000000')).status).toBe(404);
  const pending=deliver(shown.code.slice(0,3)+' '+shown.code.slice(3));
  const credential=await r.next();expect(credential).toEqual({type:'credential',token:bindings.ROBOT_DEVICE_TOKEN});
  r.ws.send(JSON.stringify({type:'stored',ok:true}));
  const answer=await pending;expect(answer.status).toBe(200);expect(await answer.json()).toEqual({ok:true});
  expect((await deliver(shown.code)).status).toBe(404); // the code works once
});
it('reports failure when the robot does not confirm or goes away',async()=>{
  const r=await robot(),shown=await r.next();
  const pending=deliver(shown.code);await r.next();r.ws.send(JSON.stringify({type:'stored',ok:false}));
  const answer=await pending;expect(answer.status).toBe(409);expect(await answer.json()).toEqual({ok:false,error:'robot_not_confirmed'});
  const gone=await robot(),code=(await gone.next()).code;const closed=new Promise(resolve=>gone.ws.addEventListener('close',resolve,{once:true}));gone.ws.close();await closed;
  await new Promise(resolve=>setTimeout(resolve,20));
  expect((await deliver(code)).status).toBe(404);
});
it('opening a pairing socket needs WebSocket and no credential leaks without the app token',async()=>{
  expect((await worker.fetch(new Request('https://unit/api/robot/pair'),bindings)).status).toBe(401);
  const r=await robot(),shown=await r.next();expect(Object.keys(shown).sort()).toEqual(['code','expiresInSeconds','type']);
  expect((await deliver(shown.code,'')).status).toBe(401);r.ws.close();
});
