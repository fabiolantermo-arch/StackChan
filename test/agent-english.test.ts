import {it,expect,vi,afterEach} from 'vitest';
import {env} from 'cloudflare:test';
import worker from '../src/index';
import {installEnglish,englishReady} from '../src/eleven-agent';
import {preferencesAPI} from '../src/preferences';
import {voiceStream,robotGreeting,ENGLISH_RULE} from '../src/voice-stream';
afterEach(()=>vi.restoreAllMocks());
const config={...env,ROBOT_API_TOKEN:'t'.repeat(40),ELEVENLABS_API_KEY:'test-eleven',ELEVENLABS_AGENT_ID:'agent_test'} as any;
// A stand-in for the provider's agent: PATCH merges what it is given; `refuse` makes it reject a shape of preset.
function provider(agent:any,refuse:(preset:any)=>boolean=()=>false){
  const calls:{method:string;body?:any}[]=[];
  vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
    const method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({method,body});
    expect(new URL(String(input)).pathname).toBe('/v1/convai/agents/agent_test');
    if(method==='PATCH'){
      if(body.conversation_config?.language_presets&&refuse(body.conversation_config.language_presets.en))return new Response('bad',{status:422});
      agent={...agent,conversation_config:{...agent.conversation_config,...body.conversation_config,agent:{...agent.conversation_config.agent,...(body.conversation_config?.agent??{})}},platform_settings:{...agent.platform_settings,...body.platform_settings}};
    }
    return Response.json(agent);
  });
  return {calls,agent:()=>agent};
}
const italian=()=>({conversation_config:{asr:{keywords:['Robottino']},tts:{voice_id:'voice-1'},agent:{language:'it',first_message:'',prompt:{prompt:'Sei Robottino.',tool_ids:['t1']}},language_presets:{}},platform_settings:{overrides:{conversation_config_override:{tts:{voice_id:true}}},widget:{x:1}}});

it('adds English to Robottino’s agent and the permission to choose the language, touching nothing else',async()=>{
  const p=provider(italian());
  expect(await englishReady(config)).toEqual({primary:'it',languages:[],override:false,ready:false});
  const result=await installEnglish(config);
  expect(result).toEqual({primary:'it',languages:['en'],override:true,ready:true,changed:true,promptUnchanged:true,voiceUnchanged:true});
  const patches=p.calls.filter(c=>c.method==='PATCH');expect(patches).toHaveLength(1);
  expect(Object.keys(patches[0].body)).toEqual(['conversation_config','platform_settings']);expect(Object.keys(patches[0].body.conversation_config)).toEqual(['language_presets']);
  expect(patches[0].body.platform_settings.overrides.conversation_config_override).toEqual({tts:{voice_id:true},agent:{language:true}});
  expect(p.agent().conversation_config.agent.prompt).toEqual({prompt:'Sei Robottino.',tool_ids:['t1']});expect(p.agent().platform_settings.widget).toEqual({x:1});
  // Already there: nothing is written again.
  const again=await installEnglish(config);expect(again.changed).toBe(false);expect(p.calls.filter(c=>c.method==='PATCH')).toHaveLength(1);
});
it('tries the other shapes of an added language when the provider refuses the first, and fails when none is taken',async()=>{
  const p=provider(italian(),preset=>'first_message'in(preset.overrides?.agent??{}));
  expect((await installEnglish(config)).ready).toBe(true);expect(p.calls.filter(c=>c.method==='PATCH')).toHaveLength(2);
  vi.restoreAllMocks();provider(italian(),()=>true);
  await expect(installEnglish(config)).rejects.toThrow('elevenlabs_PATCH_agent_422');
});
it('the route needs the app token; GET only reads',async()=>{
  const call=(method:string,headers:Record<string,string>={})=>worker.fetch(new Request('https://unit/api/admin/agent-english',{method,headers}),config);
  expect((await call('POST')).status).toBe(401);
  const p=provider(italian());const read=await call('GET',{authorization:'Bearer '+config.ROBOT_API_TOKEN});
  expect(await read.json()).toEqual({primary:'it',languages:[],override:false,ready:false});expect(p.calls.every(c=>c.method==='GET')).toBe(true);
});
it('English is saved as the language only once the agent has it; an older app that names no language keeps it',async()=>{
  const store=env.ROBOT_MEMORY.getByName('owner'),before=await store.preferences();
  const save=(body:unknown,e=config)=>preferencesAPI(new Request('https://test/api/preferences',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),e);
  try{
    provider(italian(),()=>true); // the provider refuses English
    const refused=await save({provider:'elevenlabs',voice:before.voice,language:'en'});
    expect(refused.status).toBe(502);expect((await store.preferences()).language).toBe(before.language);
    vi.restoreAllMocks();provider(italian());
    const saved=await save({provider:'elevenlabs',voice:'kAzI34nYjizE0zON6rXv',language:'en'});
    expect(saved.status).toBe(200);expect((await store.preferences()).language).toBe('en');
    expect((await save({provider:'elevenlabs',voice:'kAzI34nYjizE0zON6rXv'})).status).toBe(200);expect((await store.preferences()).language,'no language named: kept').toBe('en');
    expect((await save({provider:'elevenlabs',voice:'kAzI34nYjizE0zON6rXv',language:'it'})).status).toBe(200);expect((await store.preferences()).language).toBe('it');
    expect((await save({provider:'elevenlabs',voice:'kAzI34nYjizE0zON6rXv',language:'fr'})).status).toBe(400);
  }finally{vi.restoreAllMocks();await store.setPreferences(before);}
});
it('a call in English starts the agent in English, greets in English and says so in the rules; Italian is as before',async()=>{
  const store=env.ROBOT_MEMORY.getByName('owner'),before=await store.preferences();
  const start=async()=>{
    const pair=new WebSocketPair(),server=pair[1];server.accept();const messages:any[]=[];server.addEventListener('message',e=>{messages.push(JSON.parse(String(e.data)));});
    vi.spyOn(globalThis,'fetch').mockImplementation(async input=>String(input).includes('get-signed-url')?Response.json({signed_url:'wss://api.elevenlabs.io/test'}):new Response(null,{status:101,webSocket:pair[0]}));
    const response=await voiceStream(new Request('https://test/api/voice?provider=elevenlabs&sessionId=robot&audio=ima&face=redhead'),env);response.webSocket!.accept();
    server.send(JSON.stringify({type:'conversation_initiation_metadata',conversation_initiation_metadata_event:{agent_output_audio_format:'pcm_16000'}}));
    for(let i=0;i<50&&!messages.some(m=>m.type==='user_message');i++)await new Promise(r=>setTimeout(r,10));
    response.webSocket!.close();vi.restoreAllMocks();return messages;
  };
  try{
    await store.setPreferences({provider:'elevenlabs',voice:'kAzI34nYjizE0zON6rXv',language:'en'});
    const english=await start();
    expect(english[0]).toEqual({type:'conversation_initiation_client_data',conversation_config_override:{agent:{language:'en'}}});
    expect(english.find(m=>m.type==='user_message').text).toMatch(/^\(Call from the robot: you are Robottino.*Greet me first, in English: start with «Hi/);
    expect(english.find(m=>m.type==='contextual_update').text).toContain(ENGLISH_RULE);
    await store.setPreferences({provider:'elevenlabs',voice:'kAzI34nYjizE0zON6rXv'});
    const italian=await start();
    expect(italian[0]).toEqual({type:'conversation_initiation_client_data'});
    expect(italian.find(m=>m.type==='user_message').text).toMatch(/^\(Inizio chiamata dal robot:.*Parla di te al femminile\.\)$/);
    expect(italian.find(m=>m.type==='contextual_update').text).not.toContain(ENGLISH_RULE);
    expect(robotGreeting('white','Ada','en')).toContain('I am Ada');expect(robotGreeting('white','','en')).toContain('«Hi!»');
  }finally{vi.restoreAllMocks();await store.setPreferences(before);}
});

it('swear words on request are a setting: the rule goes to the agent only when ALLOW_SWEARING is "true"',async()=>{
  const {swearingAllowed,SWEAR_RULE}=await import('../src/voice-stream');
  expect(swearingAllowed({ALLOW_SWEARING:'true'})).toBe(true);expect(swearingAllowed({ALLOW_SWEARING:'TRUE'})).toBe(true);
  for(const value of [undefined,{},{ALLOW_SWEARING:''},{ALLOW_SWEARING:'false'},{ALLOW_SWEARING:'yes'}])expect(swearingAllowed(value as any)).toBe(false);
  expect(SWEAR_RULE).toMatch(/Solo su richiesta.*Mai insulti veri rivolti a una persona.*mai parole di disprezzo verso gruppi/s);
  const rules=async(e:Env)=>{
    const pair=new WebSocketPair(),server=pair[1];server.accept();const messages:any[]=[];server.addEventListener('message',m=>{messages.push(JSON.parse(String(m.data)));});
    vi.spyOn(globalThis,'fetch').mockImplementation(async input=>String(input).includes('get-signed-url')?Response.json({signed_url:'wss://api.elevenlabs.io/test'}):new Response(null,{status:101,webSocket:pair[0]}));
    const response=await voiceStream(new Request('https://test/api/voice?provider=elevenlabs&sessionId=robot&audio=ima'),e);response.webSocket!.accept();
    server.send(JSON.stringify({type:'conversation_initiation_metadata',conversation_initiation_metadata_event:{agent_output_audio_format:'pcm_16000'}}));
    for(let i=0;i<50&&!messages.some(m=>m.type==='contextual_update');i++)await new Promise(r=>setTimeout(r,10));
    response.webSocket!.close();vi.restoreAllMocks();return messages.find(m=>m.type==='contextual_update').text as string;
  };
  expect(await rules({...env,ALLOW_SWEARING:'true'} as Env)).toContain(SWEAR_RULE);
  expect(await rules({...env,ALLOW_SWEARING:'false'} as Env)).not.toContain('Parolacce:');
});
