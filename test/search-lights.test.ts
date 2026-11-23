// The robot's search lights (session.ts searching): the agent's web search webhook does not say which call asked, so
// they light up only while the robot's call is the only ElevenLabs call open, and overlapping searches are counted
// (code review, 19 Nov 2026).
import {it,expect} from 'vitest';
import {env,runInDurableObject} from 'cloudflare:test';
it('search lights: counted, and not lit while an iPhone call could be the one searching',async()=>{
  const stub=env.CHAT_SESSIONS.getByName('search-lights-'+crypto.randomUUID());
  await runInDurableObject(stub,async(session:any)=>{
    const told:boolean[]=[];session.tellSearch=(active:boolean)=>told.push(active);
    session.searching(true);session.searching(true);session.searching(false);
    expect(told,'a second search still running keeps them on').toEqual([true,true,true]);
    session.searching(false);expect(told.at(-1)).toBe(false);
    session.otherCall('phone',true);told.length=0;
    session.searching(true);expect(told,'an iPhone call is open: maybe its search, no lights').toEqual([]);
    session.searching(false);expect(told).toEqual([false]);
    session.otherCall('phone',false);session.searching(true);expect(told.at(-1)).toBe(true);
    session.tellSearch=undefined;session.searching(false);
  });
});
