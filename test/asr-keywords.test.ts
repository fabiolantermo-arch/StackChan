import {it,expect,vi,afterEach} from 'vitest';
import {env} from 'cloudflare:test';
import worker from '../src/index';
import {installAsrKeywords,ASR_KEYWORDS} from '../src/eleven-agent';
afterEach(()=>vi.restoreAllMocks());
const config={...env,ROBOT_API_TOKEN:'t'.repeat(40),ELEVENLABS_API_KEY:'test-eleven',ELEVENLABS_AGENT_ID:'agent_test'} as any;
it('adds the head words to the speech recognition of Robottino’s agent only, keeping its keywords, prompt and other settings',async()=>{
  const calls:{method:string;path:string;body?:any}[]=[];
  let agent:any={conversation_config:{asr:{quality:'high',provider:'elevenlabs',keywords:['Robottino']},agent:{prompt:{prompt:'Sei Robottino.'}}}};
  vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
    const path=new URL(String(input)).pathname,method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({method,path,body});
    if(method==='PATCH')agent={conversation_config:{...agent.conversation_config,asr:body.conversation_config.asr}};
    return Response.json(agent);
  });
  const result=await installAsrKeywords(config);
  expect(calls.every(c=>c.path==='/v1/convai/agents/agent_test')).toBe(true);
  const patch=calls.find(c=>c.method==='PATCH')!.body;
  expect(Object.keys(patch.conversation_config)).toEqual(['asr']);
  expect(patch.conversation_config.asr).toEqual({quality:'high',provider:'elevenlabs',keywords:['Robottino',...ASR_KEYWORDS]});
  expect(result).toEqual({keywords:['Robottino',...ASR_KEYWORDS],added:true,promptUnchanged:true});
});
it('the route needs the app token and reports a provider failure',async()=>{
  const call=(headers:Record<string,string>)=>worker.fetch(new Request('https://unit/api/admin/asr-keywords',{method:'POST',headers}),config);
  expect((await call({})).status).toBe(401);
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('no',{status:403}));
  const failed=await call({authorization:'Bearer '+config.ROBOT_API_TOKEN});
  expect(failed.status).toBe(502);expect((await failed.json() as any).error).toBe('elevenlabs_GET_agent_403');
});
