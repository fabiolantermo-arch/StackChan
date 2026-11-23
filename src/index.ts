import {placeOf,fixedPlace,installRobotTools,robotToolsState} from './robot-tools';
import { ChatSession } from "./session";
import type { ChatRequest } from "./types";
import { selectProvider, voiceProfiles } from './voice-config';
import { authorized, type Secrets } from './security';
import {askLiveOne} from './providers';
import {askElevenAgent,installAsrKeywords,installEnglish,englishReady,agentVoice,setAgentVoice,voiceWish} from './eleven-agent';
import {memoryAPI} from './memory-api';
import {preferencesAPI} from './preferences';
import {webSearch,toolAuthorized,installElevenSearchTool} from './web-search';
import {FACE_IDS} from './voice-stream';
export {RobotMemory} from './memories';
export {RobotLink} from './robot-link';
export {RobotPairing} from './pairing';

function json(data: unknown, status = 200, origin = "*") { return new Response(JSON.stringify(data), {status,headers:{"content-type":"application/json","access-control-allow-origin":origin,"access-control-allow-headers":"content-type, authorization","access-control-allow-methods":"POST, OPTIONS"}}); }

export default { async fetch(request: Request, env: Env): Promise<Response> {
  const origin = env.ALLOWED_ORIGIN ?? "https://robottino.invalid";
  if (request.method === "OPTIONS") return new Response(null, {status:204});
  const url = new URL(request.url);
  console.log(JSON.stringify({message:"request",method:request.method,path:url.pathname}));
  if (url.pathname === "/health") return json({ok:true,prototype:true},200,origin);
  if(url.pathname==='/api/robot/device'){
    const token=(env as Env & {ROBOT_DEVICE_TOKEN?:string}).ROBOT_DEVICE_TOKEN;
    if(token===(env as Env & Secrets).ROBOT_API_TOKEN||!await authorized(request,token))return json({error:'unauthorized'},401,origin);
    const headers=new Headers(request.headers);headers.set('x-robottino-role','device');
    return env.ROBOT_LINK.getByName('owner-robot').fetch(new Request(request,{headers}));
  }
  if(url.pathname==='/api/tools/web-search'&&request.method==='POST'){
    // Called by the ElevenLabs agent (webhook tool) with a header derived from the app token.
    if(!await toolAuthorized(request,env))return json({error:'unauthorized'},401,origin);
    if(!await env.CHAT_SESSIONS.getByName('quota:search').consume())return json({answer:'Ho fatto troppe ricerche: riprova tra un minuto.'},200,origin);
    let query='';try{query=String((await request.json() as {query?:unknown}).query??'');}catch{}
    if(!query.trim()||query.length>300)return json({error:'invalid_query'},400,origin);
    // The robot shows the search with its lights, if the call is the robot's (session.ts; nothing happens otherwise).
    const robot=env.CHAT_SESSIONS.getByName('stream:elevenlabs:robot'),lights=async(active:boolean)=>{try{await robot.searching(active);}catch{}};
    await lights(true);
    try{return json({answer:await webSearch(env,query)},200,origin);}
    catch(error){console.error(JSON.stringify({message:'web_search_failed',error:error instanceof Error?error.message:String(error)}));return json({answer:'La ricerca sul web non è riuscita in questo momento.'},200,origin);}
    finally{await lights(false);}
  }
  if(url.pathname==='/api/robot/pair'&&request.headers.get('upgrade')?.toLowerCase()==='websocket'){
    // The robot has no credential yet: it only receives a code to show; the credential needs the app.
    if(!await env.CHAT_SESSIONS.getByName('quota:pair').consume())return json({error:'rate_limit_exceeded'},429,origin);
    return env.ROBOT_PAIRING.getByName('owner').fetch(request);
  }
  if(url.pathname==='/api/robot/voice'){
    // The robot talks with its own credential, the saved provider and a separate history.
    const token=(env as Env & {ROBOT_DEVICE_TOKEN?:string}).ROBOT_DEVICE_TOKEN;
    if(token===(env as Env & Secrets).ROBOT_API_TOKEN||!await authorized(request,token))return json({error:'unauthorized'},401,origin);
    if(request.headers.get('upgrade')?.toLowerCase()!=='websocket')return json({error:'websocket_required'},426,origin);
    if (!await env.CHAT_SESSIONS.getByName('quota:owner').consume()) return json({error:'rate_limit_exceeded'},429,origin);
    let provider='elevenlabs';
    try{provider=(await env.ROBOT_MEMORY.getByName('owner').preferences()).provider;}catch{}
    const target=new URL(request.url);const audio=url.searchParams.get('audio'),mic=url.searchParams.get('mic'),face=url.searchParams.get('face');target.search='?provider='+provider+'&sessionId=robot'+(audio==='ulaw'||audio==='ima'?'&audio='+audio:'')+(audio==='ima'&&mic==='alaw'?'&mic=alaw':'')+(audio==='ima'&&url.searchParams.get('lips')==='1'?'&lips=1':'')+(FACE_IDS.includes(face as typeof FACE_IDS[number])?'&face='+face:'');
    // A robot with the agent's tools (robot-tools.ts) says so; the approximate place of its connection (Cloudflare's
    // estimate, rounded to 0.1°) is for the weather of its greeting, passed inside the Worker only.
    if(url.searchParams.get('tools')==='1')target.search+='&tools=1';
    // Its rover answers (15 Nov 2026): «destra», «avanti»… go to the rover first (robot-tools.ts ROVER_ON_RULE).
    if(url.searchParams.get('rover')==='1')target.search+='&rover=1';
    const forwarded=new Request(target,request),place=fixedPlace(env.WEATHER_PLACE)??placeOf((request as Request&{cf?:unknown}).cf);
    forwarded.headers.delete('x-robottino-place');if(place)forwarded.headers.set('x-robottino-place',place);
    return env.CHAT_SESSIONS.getByName('stream:'+provider+':robot').fetch(forwarded);
  }
  if (!await authorized(request,(env as Env & Secrets).ROBOT_API_TOKEN)) return json({error:'unauthorized'},401,origin);
  if(url.pathname==='/api/robot/status'&&request.method==='GET')return json(await env.ROBOT_LINK.getByName('owner-robot').status(),200,origin);
  if(url.pathname==='/api/robot/pair'&&request.method==='POST'){
    let code='';try{code=String((await request.json() as {code?:unknown}).code??'').replace(/\s/g,'');}catch{}
    const result=await env.ROBOT_PAIRING.getByName('owner').deliver(code,(env as Env&{ROBOT_DEVICE_TOKEN?:string}).ROBOT_DEVICE_TOKEN);
    return json(result,result.ok?200:result.error==='unknown_code'?404:result.error==='too_many_attempts'?429:result.error==='not_configured'?503:409,origin);
  }
  if(url.pathname==='/api/robot/reaction'&&request.method==='POST'){
    let kind='';try{kind=String((await request.json() as {kind?:unknown}).kind??'');}catch{}
    const result=await env.ROBOT_LINK.getByName('owner-robot').reaction(kind);
    return json(result,result.delivered?200:result.error==='invalid_reaction'?400:result.error==='too_soon'?429:409,origin);
  }
  if(url.pathname==='/api/robot/live'){
    const headers=new Headers(request.headers);headers.set('x-robottino-role','app');
    return env.ROBOT_LINK.getByName('owner-robot').fetch(new Request(request,{headers}));
  }
  if(url.pathname==='/api/admin/web-search-tool'&&request.method==='POST'){
    try{return json(await installElevenSearchTool(env,url.origin),200,origin);}
    catch(error){return json({error:error instanceof Error?error.message:'install_failed'},502,origin);}
  }
  // Adds English to Robottino's agent (eleven-agent.ts installEnglish); GET only tells how the agent is set.
  // The agent's tools for the robot (robot-tools.ts): POST installs them and attaches them to the agent (only after the
  // owner's yes), GET tells which are there and the agent's voice model.
  if(url.pathname==='/api/admin/robot-tools'&&(request.method==='POST'||request.method==='GET')){
    try{return json(request.method==='POST'?await installRobotTools(env):await robotToolsState(env),200,origin);}
    catch(error){return json({error:error instanceof Error?error.message:'install_failed'},502,origin);}
  }
  if(url.pathname==='/api/admin/agent-english'&&(request.method==='POST'||request.method==='GET')){
    try{return json(request.method==='POST'?await installEnglish(env):await englishReady(env),200,origin);}
    catch(error){return json({error:error instanceof Error?error.message:'install_failed'},502,origin);}
  }
  // The agent's voice (eleven-agent.ts): GET tells how it is set; POST makes it livelier, or sets what the body says
  // ({stability, speed, expressive, temperature}, each within its limits), only after the owner's request.
  if(url.pathname==='/api/admin/agent-voice'&&(request.method==='POST'||request.method==='GET')){
    try{
      if(request.method==='GET')return json(await agentVoice(env),200,origin);
      const text=await request.text();let body:unknown;
      if(text.trim())try{body=JSON.parse(text);}catch{return json({error:'invalid_request'},400,origin);}
      const wish=voiceWish(body);if(!wish)return json({error:'invalid_request'},400,origin);
      return json(await setAgentVoice(env,wish),200,origin);
    }catch(error){return json({error:error instanceof Error?error.message:'install_failed'},502,origin);}
  }
  if(url.pathname==='/api/admin/asr-keywords'&&request.method==='POST'){
    try{return json(await installAsrKeywords(env),200,origin);}
    catch(error){return json({error:error instanceof Error?error.message:'install_failed'},502,origin);}
  }
  if(url.pathname==='/api/memories')return memoryAPI(request,env);
  if(url.pathname==='/api/preferences')return preferencesAPI(request,env);
  if (url.pathname === '/api/voice' && request.headers.get('upgrade')?.toLowerCase()==='websocket') {
    const session=url.searchParams.get('sessionId')??'default';
    const selected=url.searchParams.get('provider')??'openai';
    if(!/^[a-zA-Z0-9_-]{1,64}$/.test(session)||!['openai','elevenlabs'].includes(selected)) return json({error:'invalid_request'},400,origin);
    // «robot» is the robot's own conversation (/api/robot/voice, device credential): the app's credential never enters
    // it, so it can neither take its place nor read its history or use its tools (review of 17 Nov 2026, R5).
    if(session.toLowerCase()==='robot') return json({error:'reserved_session'},403,origin);
    if (!await env.CHAT_SESSIONS.getByName('quota:owner').consume()) return json({error:'rate_limit_exceeded'},429,origin);
    return env.CHAT_SESSIONS.getByName('stream:'+selected+':'+session).fetch(request);
  }
  if (url.pathname === '/api/providers') return json(voiceProfiles,200,origin);
  if (url.pathname !== "/api/chat" || request.method !== "POST") return json({error:"not_found"},404,origin);
  try {
    if (!request.headers.get('content-type')?.includes('application/json')) return json({error:'unsupported_media_type'},415,origin);
    const reader = request.body?.getReader();
    if (!reader) return json({error:'invalid_request'},400,origin);
    const decoder = new TextDecoder(); let raw = '', size = 0;
    for (;;) {
      const {done,value} = await reader.read(); if (done) break;
      size += value.length;
      if (size > 12000) { await reader.cancel(); return json({error:'payload_too_large'},413,origin); }
      raw += decoder.decode(value,{stream:true});
    }
    raw += decoder.decode();
    let body: Partial<ChatRequest>;
    try { body = JSON.parse(raw); } catch { return json({error:'invalid_json'},400,origin); }
    if (typeof body?.sessionId !== 'string' || typeof body?.message !== 'string' || !body.message.trim() || body.message.length > 4000) return json({error:"invalid_request"},400,origin);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(body.sessionId) || (body.speak !== undefined && typeof body.speak !== 'boolean')) return json({error:'invalid_request'},400,origin);
    const provider = selectProvider(body.provider);
    return json({error:'websocket_required',endpoint:'/api/voice?provider='+provider,reason:'I modelli vocali usano il trasporto continuo WebSocket.'},426,origin);
  } catch (error) {
    if (error instanceof Error && error.message.includes('session_busy')) return json({error:'session_busy'},409,origin);
    if (error instanceof Error && error.message === 'invalid_provider') return json({error:'invalid_provider'},400,origin);
    if (error instanceof Error && error.message.includes('elevenlabs_agent_not_configured')) return json({error:'elevenlabs_agent_not_configured'},503,origin);
    console.error(JSON.stringify({message:"request_failed",error:error instanceof Error ? error.message : String(error)}));
    return json({error:"upstream_or_server_error"},502,origin);
  }
}} satisfies ExportedHandler<Env>;

export { ChatSession };
