// Web search for both voice providers: OpenAI GPT-Live delegates to a Responses model with the
// hosted web_search tool; the ElevenLabs agent calls /api/tools/web-search, which runs the same search.
export const SEARCH_MODEL='gpt-6-luna';
export const SEARCH_TOOL={type:'web_search',search_context_size:'low',user_location:{type:'approximate',country:'IT',timezone:'Europe/Rome'}};
export const SEARCH_INSTRUCTIONS='Sei il motore di ricerca di Robottino. Cerca sul web e rispondi in italiano in massimo tre frasi brevi, adatte a essere dette a voce: niente elenchi, niente link, cita solo il nome della fonte. Se non trovi nulla di affidabile, dillo.';
export const TOOL_NAME='cerca_sul_web';
const today=()=>'Oggi in Italia è '+new Intl.DateTimeFormat('it-IT',{timeZone:'Europe/Rome',dateStyle:'full',timeStyle:'short'}).format(new Date())+'.';

// Header for the ElevenLabs webhook, derived from the app token: no extra secret to store or print.
export async function toolToken(env:Env){
  const secret=(env as Env&{ROBOT_API_TOKEN?:string}).ROBOT_API_TOKEN;
  if(!secret||secret.length<32)return null;
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const mac=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('robottino-web-search-v1')));
  return [...mac].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export async function toolAuthorized(request:Request,env:Env){
  const expected=await toolToken(env);if(!expected)return false;
  const encode=new TextEncoder(),[a,b]=await Promise.all([request.headers.get('x-robottino-tool')??'',expected].map(s=>crypto.subtle.digest('SHA-256',encode.encode(s))));
  return crypto.subtle.timingSafeEqual(a,b);
}

export async function webSearch(env:Env,query:string){
  const question=query.trim().slice(0,300);
  if(!question)throw Error('invalid_query');
  if(!env.OPENAI_API_KEY)throw Error('search_not_configured');
  const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{authorization:'Bearer '+env.OPENAI_API_KEY,'content-type':'application/json'},
    body:JSON.stringify({model:SEARCH_MODEL,instructions:SEARCH_INSTRUCTIONS+' '+today(),input:question,tools:[SEARCH_TOOL],max_output_tokens:600,store:false}),signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw Error('search_failed_'+response.status);
  const data=await response.json() as {output_text?:string;output?:{content?:{type?:string;text?:string}[]}[]};
  const text=(data.output_text??data.output?.flatMap(item=>item.content??[]).filter(part=>part.type==='output_text').map(part=>part.text??'').join('')??'').trim();
  if(!text)throw Error('search_empty');
  return text.slice(0,1200);
}

// Creates or updates the ElevenLabs webhook tool and attaches it to Robottino's agent only,
// keeping the agent's prompt and every other tool as they are.
export async function installElevenSearchTool(env:Env,origin:string){
  const config=env as Env&{ELEVENLABS_API_KEY?:string;ELEVENLABS_AGENT_ID?:string};
  const token=await toolToken(env);
  if(!config.ELEVENLABS_API_KEY||!config.ELEVENLABS_AGENT_ID||!token)throw Error('elevenlabs_not_configured');
  const headers={'xi-api-key':config.ELEVENLABS_API_KEY,'content-type':'application/json'};
  const api=async(path:string,init:RequestInit={})=>{
    const response=await fetch('https://api.elevenlabs.io'+path,{...init,headers,signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error(`elevenlabs_${init.method??'GET'}_${path.split('/')[3]}_${response.status}`);
    return response.json() as Promise<any>;
  };
  const tool_config={type:'webhook',name:TOOL_NAME,
    description:'Cerca informazioni aggiornate sul web: notizie, meteo, risultati sportivi, orari, prezzi e fatti che non conosci o che possono essere cambiati. Usalo invece di inventare; poi riassumi il risultato a voce.',
    api_schema:{url:origin+'/api/tools/web-search',method:'POST',request_headers:{'x-robottino-tool':token},
      request_body_schema:{type:'object',required:['query'],properties:{query:{type:'string',description:'La domanda da cercare, in italiano, completa di luogo e data se servono.'}}}},
    pre_tool_speech:'force',response_timeout_secs:30};
  const existing=((await api('/v1/convai/tools')).tools??[]).find((t:any)=>t?.tool_config?.name===TOOL_NAME);
  const id:string=existing?(await api('/v1/convai/tools/'+existing.id,{method:'PATCH',body:JSON.stringify({tool_config})})).id??existing.id:(await api('/v1/convai/tools',{method:'POST',body:JSON.stringify({tool_config})})).id;
  const agent=await api('/v1/convai/agents/'+encodeURIComponent(config.ELEVENLABS_AGENT_ID));
  const prompt={...(agent.conversation_config?.agent?.prompt??{})};
  const before=prompt.prompt;
  const ids:string[]=[...new Set([...(prompt.tool_ids??[]),id])];
  delete prompt.tools; // expanded copy of tool_ids: sending both is rejected
  prompt.tool_ids=ids;
  await api('/v1/convai/agents/'+encodeURIComponent(config.ELEVENLABS_AGENT_ID),{method:'PATCH',body:JSON.stringify({conversation_config:{agent:{prompt}}})});
  const after=await api('/v1/convai/agents/'+encodeURIComponent(config.ELEVENLABS_AGENT_ID));
  const saved=after.conversation_config?.agent?.prompt;
  return {toolId:id,attached:!!saved?.tool_ids?.includes(id),promptUnchanged:saved?.prompt===before,tools:saved?.tool_ids?.length??0};
}
