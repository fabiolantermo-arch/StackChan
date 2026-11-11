import {expect,it} from 'vitest';
import {env} from 'cloudflare:test';
import {spokenMemoryCommand} from '../src/memories';
const fresh=()=>env.ROBOT_MEMORY.getByName('test-'+crypto.randomUUID());
it('saves explicit memories, deduplicates and updates with provenance',async()=>{
  const store=fresh();
  const a=await store.command({action:'remember',text:'Mi chiamo Ada',kind:'profile'});
  expect('memory'in a).toBe(true);if(!('memory'in a))throw Error('missing memory');
  const id=a.memory!.id;
  expect(a.memory!.source).toBe('explicit_user_command');
  await store.command({action:'remember',text:'Mi chiamo Ada'});
  expect(await store.list()).toHaveLength(1);
  await store.command({action:'update',id,text:'Mi chiamo Mario'});
  expect((await store.recall())[0].text).toBe('Mi chiamo Mario');
});
it('requires a current single-use confirmation to clear everything',async()=>{
  const store=fresh();await store.command({action:'remember',text:'Dato sintetico'});
  expect(await store.command({action:'clear'})).toHaveProperty('error','confirmation_required');
  const challenge=await store.command({action:'prepare_clear'});
  if(!('confirmation'in challenge))throw Error('missing confirmation');
  expect(await store.command({action:'clear',confirmation:challenge.confirmation})).toEqual({ok:true});
  expect(await store.list()).toEqual([]);
  expect(await store.command({action:'clear',confirmation:challenge.confirmation})).toHaveProperty('error');
});
it('expires confirmation on mutation and isolates owners',async()=>{
  const a=fresh(),b=fresh();const challenge=await a.command({action:'prepare_clear'});
  await a.command({action:'remember',text:'Nuovo ricordo'});
  if(!('confirmation'in challenge))throw Error('missing confirmation');
  expect(await a.command({action:'clear',confirmation:challenge.confirmation})).toHaveProperty('error');
  expect(await b.list()).toEqual([]);
});
it('rejects credentials, invalid expiry and unknown commands',async()=>{
  const store=fresh();
  expect(await store.command({action:'remember',text:'password segreta'})).toHaveProperty('error','secret_not_allowed');
  expect(await store.command({action:'remember',text:'Dato',expiresAt:1})).toHaveProperty('error','invalid_expiry');
  expect(await store.command({action:'automatic-save'})).toHaveProperty('error','invalid_action');
});
it('retrieves relevant facts and forgets an exact id',async()=>{
  const store=fresh();const a=await store.command({action:'remember',text:'Mi piace la pizza'});
  expect(await store.recall('pizza')).toHaveLength(1);
  expect(await store.recall('montagna')).toEqual([]);
  if(!('memory'in a))throw Error('missing memory');
  await store.command({action:'forget',id:a.memory!.id});expect(await store.list()).toEqual([]);
});
it('does not interpret ordinary speech or negated requests as memory writes',()=>{
  expect(spokenMemoryCommand('Mi piace il mare')).toBeNull();
  expect(spokenMemoryCommand('Non ricorda che questo è un esempio')).toBeNull();
  expect(spokenMemoryCommand('Ricorda che mi piace il mare')).toEqual({action:'remember',text:'mi piace il mare'});
});
it('recalls spoken facts at conversation start, profile first, and matches accented words',async()=>{
  const store=fresh();
  await store.command(spokenMemoryCommand('Ricorda che il mio caffè preferito è amaro')!);
  await store.command({action:'remember',text:'Mi chiamo Ada',kind:'profile'});
  const recalled=(await store.recall()).map(m=>m.text);
  expect(recalled).toEqual(['Mi chiamo Ada','il mio caffè preferito è amaro']);
  expect(await store.recall('caffè')).toHaveLength(1);
});
it('forgets a spoken memory only when exactly one matches and recalls by topic',async()=>{
  const store=fresh();
  await store.command({action:'remember',text:'Mi piace il caffè amaro'});
  await store.command({action:'remember',text:'Mi piace il tè verde'});
  expect(spokenMemoryCommand('Dimentica che mi piace il caffè amaro.')).toEqual({action:'forget_match',text:'mi piace il caffè amaro'});
  expect(spokenMemoryCommand('Cosa ricordi del tè?')).toEqual({action:'recall',query:'tè'});
  expect(spokenMemoryCommand('Cosa sai di me?')).toEqual({action:'list'});
  expect(await store.command({action:'forget_match',text:'mi piace'})).toHaveProperty('error','ambiguous');
  expect(await store.list()).toHaveLength(2);
  expect(await store.command({action:'forget_match',text:'montagna'})).toHaveProperty('error','not_found');
  expect(await store.command(spokenMemoryCommand('Dimentica che mi piace il caffè amaro')!)).toMatchObject({ok:true});
  expect((await store.list()).map(m=>m.text)).toEqual(['Mi piace il tè verde']);
  expect(await store.recall('tè')).toHaveLength(1);
});
it('understands natural spoken memory phrases from speech transcripts',()=>{
  expect(spokenMemoryCommand('Robottino, ricordati che mi piace il mare.')).toEqual({action:'remember',text:'mi piace il mare'});
  // Timers belong to the device: never saved as memories.
  expect(spokenMemoryCommand('Ricordami tra 10 minuti di chiamare la mamma')).toBeNull();
  expect(spokenMemoryCommand('Segnami un timer di 5 minuti')).toBeNull();
  expect(spokenMemoryCommand('Ehi Robottino ricorda: il mio gatto si chiama Neve')).toEqual({action:'remember',text:'il mio gatto si chiama Neve'});
  expect(spokenMemoryCommand('Memorizza che domani ho il dentista')).toEqual({action:'remember',text:'domani ho il dentista'});
  expect(spokenMemoryCommand('Tieni a mente che sono vegetariano')).toEqual({action:'remember',text:'sono vegetariano'});
  expect(spokenMemoryCommand('Ti ricordi di me?')).toEqual({action:'list'});
  expect(spokenMemoryCommand('Robottino, cosa ti ricordi di me?')).toEqual({action:'list'});
  expect(spokenMemoryCommand('Scordati che mi piace il mare')).toEqual({action:'forget_match',text:'mi piace il mare'});
  expect(spokenMemoryCommand('Cancella tutti i ricordi')).toEqual({action:'prepare_clear'});
  expect(spokenMemoryCommand('Ti ricordi quando siamo andati al mare?')).toBeNull();
  expect(spokenMemoryCommand('Non ricordare niente')).toBeNull();
});
