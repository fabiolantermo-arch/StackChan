import {expect,it} from 'vitest';
import worker from '../src/index';
import {authorized} from '../src/security';
import {env} from 'cloudflare:test';
it('rejects missing, short and incorrect credentials', async()=>{
  const token='a'.repeat(64);
  expect(await authorized(new Request('https://test'),token)).toBe(false);
  expect(await authorized(new Request('https://test',{headers:{authorization:'Bearer wrong'}}),token)).toBe(false);
  expect(await authorized(new Request('https://test',{headers:{authorization:'Bearer '+token}}),token)).toBe(true);
});
it('public health and denied chat do not invoke a provider',async()=>{
  expect((await worker.fetch(new Request('https://test/health'),env)).status).toBe(200);
  expect((await worker.fetch(new Request('https://test/api/chat',{method:'POST'}),env)).status).toBe(401);
});
it('rejects malformed and oversized bodies before provider traffic',async()=>{
  const token='t'.repeat(64), bindings={...env,ROBOT_API_TOKEN:token};
  for(const [body,status] of [['{',400],['x'.repeat(12001),413],['{"sessionId":"../bad","message":"hi"}',400]] as const){
    const r=await worker.fetch(new Request('https://test/api/chat',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body}),bindings);
    expect(r.status).toBe(status);
  }
});
it('enforces one quota across sessions',async()=>{
  const quota=env.CHAT_SESSIONS.getByName('quota-test-'+crypto.randomUUID());
  for(let i=0;i<6;i++)expect(await quota.consume()).toBe(true);
  expect(await quota.consume()).toBe(false);
});
