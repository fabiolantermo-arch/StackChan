import {expect,it} from 'vitest';
import {env,runInDurableObject} from 'cloudflare:test';
it('restores the latest twelve messages in order from SQLite and isolates sessions',async()=>{
  const first=env.CHAT_SESSIONS.getByName('memory-'+crypto.randomUUID());
  const second=env.CHAT_SESSIONS.getByName('memory-'+crypto.randomUUID());
  await runInDurableObject(first,async(_instance,state)=>{
    for(let i=0;i<16;i++)state.storage.sql.exec('INSERT INTO messages(role,content,created_at) VALUES(?,?,?)',i%2?'assistant':'user','message-'+i,new Date().toISOString());
  });
  const history=await first.beginTurn();
  expect(history).toHaveLength(12);
  expect(history[0].content).toBe('message-4');
  expect(history[11].content).toBe('message-15');
  expect(await second.beginTurn()).toEqual([]);
  await first.finishTurn('','');
  await first.clearHistory();
  expect(await first.beginTurn()).toEqual([]);
});
