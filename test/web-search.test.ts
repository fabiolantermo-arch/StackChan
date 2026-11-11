import {afterEach,expect,it,vi} from 'vitest';
import {env} from 'cloudflare:test';
import worker from '../src/index';
import {toolToken,webSearch,installElevenSearchTool,TOOL_NAME} from '../src/web-search';
afterEach(()=>vi.restoreAllMocks());
const config={...env,ROBOT_API_TOKEN:'t'.repeat(40),OPENAI_API_KEY:'test-openai',ELEVENLABS_API_KEY:'test-eleven',ELEVENLABS_AGENT_ID:'agent_test'} as any;
const call=(headers:Record<string,string>,body:unknown)=>worker.fetch(new Request('https://unit/api/tools/web-search',{method:'POST',headers,body:JSON.stringify(body)}),config);

it('searches with the hosted web_search tool and returns a short spoken answer',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({output:[{content:[{type:'output_text',text:'Domani a Milano sole, 18 gradi (fonte: Meteo).'}]}]}));
  expect(await webSearch(config,' Meteo Milano domani ')).toBe('Domani a Milano sole, 18 gradi (fonte: Meteo).');
  const sent=JSON.parse(String(fetch.mock.calls[0][1]!.body));
  expect(sent.tools[0].type).toBe('web_search');expect(sent.input).toBe('Meteo Milano domani');expect(sent.store).toBe(false);
  await expect(webSearch(config,'  ')).rejects.toThrow('invalid_query');
});
it('the webhook needs the derived tool header, never the app token, and hides search failures',async()=>{
  const token=(await toolToken(config))!;expect(token).toMatch(/^[0-9a-f]{64}$/);expect(token).not.toContain(config.ROBOT_API_TOKEN);
  expect((await call({authorization:'Bearer '+config.ROBOT_API_TOKEN},{query:'meteo'})).status).toBe(401);
  expect((await call({'x-robottino-tool':token},{query:''})).status).toBe(400);
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('down',{status:500}));
  const failed=await call({'x-robottino-tool':token},{query:'meteo Milano'});
  expect(failed.status).toBe(200);expect((await failed.json() as any).answer).toMatch(/non è riuscita/);
});
it('installs the ElevenLabs tool on Robottino’s agent without touching its prompt or other tools',async()=>{
  const calls:{method:string;path:string;body?:any}[]=[];let agentPrompt:any={prompt:'Sei Robottino.',tool_ids:['other'],tools:[{name:'other'}]};
  vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
    const path=new URL(String(input)).pathname,method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({method,path,body});
    if(path==='/v1/convai/tools'&&method==='GET')return Response.json({tools:[]});
    if(path==='/v1/convai/tools'&&method==='POST')return Response.json({id:'tool_new'});
    if(method==='PATCH'){agentPrompt={...agentPrompt,...body.conversation_config.agent.prompt};return Response.json({});}
    return Response.json({conversation_config:{agent:{prompt:agentPrompt}}});
  });
  expect(await installElevenSearchTool(config,'https://robot.example')).toEqual({toolId:'tool_new',attached:true,promptUnchanged:true,tools:2});
  const created=calls.find(c=>c.method==='POST')!.body.tool_config;
  expect(created.name).toBe(TOOL_NAME);expect(created.api_schema.url).toBe('https://robot.example/api/tools/web-search');
  expect(created.api_schema.request_headers['x-robottino-tool']).toBe(await toolToken(config));
  const patch=calls.find(c=>c.method==='PATCH')!.body.conversation_config.agent.prompt;
  expect(patch.tool_ids).toEqual(['other','tool_new']);expect(patch.tools).toBeUndefined();expect(patch.prompt).toBe('Sei Robottino.');
});
