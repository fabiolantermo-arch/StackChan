import {it,expect,vi,afterEach} from 'vitest';
import {env} from 'cloudflare:test';
import worker from '../src/index';
import {agentVoice,setAgentVoice,voiceWish,LIVELY_VOICE} from '../src/eleven-agent';
import {ENERGY_RULE,SEARCH_SPEECH_RULE} from '../src/voice-stream';
afterEach(()=>vi.restoreAllMocks());
// Owner, 16 Nov 2026: «modifica l'agente 11 Labs di robottino in modo tale che abbia una voce molto più energica, un
// po' come fatto per LiveWatch»; «anche mentre ricerca deve comportarsi come LiveWatch».
const config={...env,ROBOT_API_TOKEN:'t'.repeat(40),ELEVENLABS_API_KEY:'test-eleven',ELEVENLABS_AGENT_ID:'agent_test'} as any;
const calm=()=>({conversation_config:{asr:{keywords:['Robottino']},tts:{voice_id:'voice-1',model_id:'eleven_v4_turbo',stability:.5,similarity_boost:.75,speed:1,expressive_mode:false,agent_output_audio_format:'pcm_16000'},
  agent:{language:'it',prompt:{prompt:'Sei Robottino.',llm:'model-x',temperature:0,tool_ids:['t1'],tools:[{id:'t1',name:'cerca_sul_web'}]}}},platform_settings:{widget:{x:1}}});
// A stand-in for the provider's agent. deep: a PATCH adds to the voice settings; else it puts them in place of the old ones.
function provider(agent:any,deep=true){
  const calls:{method:string;body?:any}[]=[];
  vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
    const method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({method,body});
    expect(new URL(String(input)).pathname).toBe('/v1/convai/agents/agent_test');
    if(method==='PATCH'){
      expect(Object.keys(body)).toEqual(['conversation_config']);const part=body.conversation_config;expect(['tts','agent']).toContain(Object.keys(part).join());
      if(part.tts)agent={...agent,conversation_config:{...agent.conversation_config,tts:deep?{...agent.conversation_config.tts,...part.tts}:part.tts}};
      if(part.agent){
        expect(Object.keys(part.agent)).toEqual(['prompt']);expect('tools'in part.agent.prompt).toBe(false);
        agent={...agent,conversation_config:{...agent.conversation_config,agent:{...agent.conversation_config.agent,prompt:deep?{...agent.conversation_config.agent.prompt,...part.agent.prompt}:{...part.agent.prompt,tools:agent.conversation_config.agent.prompt.tools}}}};
      }
    }
    return Response.json(agent);
  });
  return {calls,agent:()=>agent};
}
it('makes the agent’s voice livelier (stability 0.23, expressive mode) and touches nothing else',async()=>{
  expect(LIVELY_VOICE).toEqual({stability:.23,expressive:true});
  const p=provider(calm());
  expect(await agentVoice(config)).toEqual({voice:'voice-1',model:'eleven_v4_turbo',stability:.5,similarity:.75,speed:1,expressive:false,llm:'model-x',temperature:0});
  const result=await setAgentVoice(config);
  expect(result.before.stability).toBe(.5);expect(result.after).toEqual({voice:'voice-1',model:'eleven_v4_turbo',stability:.23,similarity:.75,speed:1,expressive:true,llm:'model-x',temperature:0});
  expect(result.changed).toEqual(['stability','expressive_mode']);expect(result.voiceUnchanged).toBe(true);expect(result.promptUnchanged).toBe(true);
  const patches=p.calls.filter(c=>c.method==='PATCH');expect(patches).toHaveLength(1);expect(patches[0].body).toEqual({conversation_config:{tts:{stability:.23,expressive_mode:true}}});
  expect(p.agent().conversation_config.agent).toEqual(calm().conversation_config.agent);expect(p.agent().conversation_config.asr).toEqual({keywords:['Robottino']});expect(p.agent().platform_settings).toEqual({widget:{x:1}});
  // Already so: nothing is written again. Giving back `before` undoes it.
  expect((await setAgentVoice(config)).changed).toEqual([]);expect(p.calls.filter(c=>c.method==='PATCH')).toHaveLength(1);
  const undone=await setAgentVoice(config,{stability:result.before.stability!,expressive:result.before.expressive!});
  expect(undone.after).toEqual(result.before);expect(p.agent().conversation_config.tts).toEqual(calm().conversation_config.tts);
});
it('an agent without the expressive setting gets only the stability; a provider that replaces the voice settings gets them back whole',async()=>{
  const plain=calm();delete (plain.conversation_config.tts as any).expressive_mode;
  const a=provider(plain);const first=await setAgentVoice(config);
  expect(first.changed).toEqual(['stability']);expect(first.after.expressive).toBe(null);expect(a.agent().conversation_config.tts.voice_id).toBe('voice-1');
  vi.restoreAllMocks();
  const b=provider(calm(),false),second=await setAgentVoice(config);
  expect(b.calls.filter(c=>c.method==='PATCH')).toHaveLength(2);expect(second.voiceUnchanged).toBe(true);
  expect(b.agent().conversation_config.tts).toEqual({...calm().conversation_config.tts,stability:.23,expressive_mode:true});
});
it('sets the temperature of the model that writes the replies (owner: «porta temperatura a 1»), leaving the prompt, its model and its tools as they are',async()=>{
  for(const deep of [true,false]){
    const p=provider(calm(),deep),result=await setAgentVoice(config,{temperature:1});
    expect(result.before.temperature).toBe(0);expect(result.after.temperature).toBe(1);expect(result.changed).toEqual(['temperature']);
    expect(result.promptUnchanged).toBe(true);expect(result.voiceUnchanged).toBe(true);
    expect(p.calls.filter(c=>c.method==='PATCH')[0].body).toEqual({conversation_config:{agent:{prompt:{temperature:1}}}});
    expect(p.calls.filter(c=>c.method==='PATCH')).toHaveLength(deep?1:2);
    expect(p.agent().conversation_config.agent.prompt).toEqual({...calm().conversation_config.agent.prompt,temperature:1});expect(p.agent().conversation_config.tts).toEqual(calm().conversation_config.tts);
    expect((await setAgentVoice(config,{temperature:1})).changed).toEqual([]);
    vi.restoreAllMocks();
  }
});
it('takes only the four settings, each within its limits',()=>{
  expect(voiceWish({temperature:1})).toEqual({temperature:1});expect(voiceWish({temperature:0})).toEqual({temperature:0});
  for(const bad of [{temperature:1.5},{temperature:-1},{temperature:'1'},{temperature:1,llm:'other'}])expect(voiceWish(bad)).toBe(null);
  expect(voiceWish(undefined)).toEqual(LIVELY_VOICE);expect(voiceWish({stability:.4})).toEqual({stability:.4});expect(voiceWish({speed:1.1,expressive:false})).toEqual({speed:1.1,expressive:false});
  for(const bad of [{},[],'x',5,{stability:2},{stability:-.1},{stability:'0.2'},{speed:2},{speed:.5},{expressive:'yes'},{voice_id:'other'},{stability:.2,prompt:'x'}])expect(voiceWish(bad)).toBe(null);
});
it('the route reads and sets the voice only with the app token, and refuses anything else than the three settings',async()=>{
  const p=provider(calm()),bindings={...config} as any,ctx={waitUntil(){},passThroughOnException(){}} as any;
  const call=(method:string,body?:string,token='t'.repeat(40))=>worker.fetch(new Request('https://unit/api/admin/agent-voice',{method,body,headers:{authorization:'Bearer '+token}}),bindings,ctx);
  expect((await call('GET',undefined,'wrong')).status).toBe(401);expect(p.calls).toHaveLength(0);
  const read=await call('GET');expect(read.status).toBe(200);expect((await read.json() as any).stability).toBe(.5);
  expect((await call('POST','{"voice_id":"other"}')).status).toBe(400);expect((await call('POST','not json')).status).toBe(400);expect(p.calls.filter(c=>c.method==='PATCH')).toHaveLength(0);
  const set=await call('POST');expect(set.status).toBe(200);expect((await set.json() as any).after.stability).toBe(.23);
  const tuned=await call('POST','{"stability":0.3,"speed":1.05}');expect((await tuned.json() as any).after).toMatchObject({stability:.3,speed:1.05,expressive:true});
});
it('the two rules given at every call: a lively tone, and a short lively sentence before a web search',()=>{
  expect(ENERGY_RULE).toMatch(/energia/);expect(ENERGY_RULE).toMatch(/vivace/);
  expect(SEARCH_SPEECH_RULE).toMatch(/prima di ogni ricerca/);expect(SEARCH_SPEECH_RULE).toMatch(/3-6 parole/);expect(SEARCH_SPEECH_RULE).toMatch(/Mai «devo»/);
});
