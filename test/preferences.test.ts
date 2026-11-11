import {expect,it,vi} from 'vitest';
import {env} from 'cloudflare:test';
import {validPreferences,preferencesAPI,voices} from '../src/preferences';
it('accepts only supported voices of the selected provider',()=>{
  expect(validPreferences({provider:'openai',voice:'marin'})).toBe(true);
  expect(validPreferences({provider:'elevenlabs',voice:'marin'})).toBe(false);
  expect(validPreferences({provider:'other',voice:'x'})).toBe(false);
});
it('persists settings in the dedicated Robottino archive',async()=>{
  const store=env.ROBOT_MEMORY.getByName('preferences-test-'+crypto.randomUUID());
  await store.setPreferences({provider:'openai',voice:'cedar'});
  expect(await store.preferences()).toEqual({provider:'openai',voice:'cedar'});
});
it('does not report success or save settings when ElevenLabs rejects an update',async()=>{
  const before=await env.ROBOT_MEMORY.getByName('owner').preferences();
  const mock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(null,{status:403}));
  try{
    const r=await preferencesAPI(new Request('https://test/api/preferences',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'elevenlabs',voice:'cjVigY5qzO86Huf0OWal'})}),env);
    expect(r.status).toBe(502);
    expect(await env.ROBOT_MEMORY.getByName('owner').preferences()).toEqual(before);
  }finally{mock.mockRestore();}
});

it('offers the documented voices without duplicates while preserving Robottino choices',()=>{
  const names=voices.elevenlabs.map(v=>v.name);
  for(const name of ['Sami','Eric','Elettra','Giulia Pro','Giulia','Mia','Stella','Samanta','Aida','Alessandro','Chiara','Violetta','Matteo','Lorenzo','Ginevra','Giusy']) expect(names).toContain(name);
  expect(new Set(voices.elevenlabs.map(v=>v.id)).size).toBe(voices.elevenlabs.length);
  for(const voice of voices.elevenlabs) expect(validPreferences({provider:'elevenlabs',voice:voice.id})).toBe(true);
});
