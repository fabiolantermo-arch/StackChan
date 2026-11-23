// Separate Robottino agent: never updates or reuses any other agent.
export async function askElevenAgent(env: Env, message: string) {
  const config = env as Env & { ELEVENLABS_API_KEY?: string; ELEVENLABS_AGENT_ID?: string };
  if (!config.ELEVENLABS_API_KEY || !config.ELEVENLABS_AGENT_ID) throw new Error('elevenlabs_agent_not_configured');
  const headers = { 'xi-api-key': config.ELEVENLABS_API_KEY };
  const agentResponse = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(config.ELEVENLABS_AGENT_ID)}`, { headers, signal: AbortSignal.timeout(10000) });
  if (!agentResponse.ok) throw new Error(`elevenlabs_agent_config_${agentResponse.status}`);
  const agent = await agentResponse.json() as { conversation_config?: { realtime_model?: string; agent?: { realtime_model?: string } } };
  if ((agent.conversation_config?.realtime_model ?? agent.conversation_config?.agent?.realtime_model) !== 'eleven_realtime_v1_max') throw new Error('elevenlabs_agent_requires_realtime_v1_max');
  const signed = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(config.ELEVENLABS_AGENT_ID)}`, { headers, signal: AbortSignal.timeout(10000) });
  if (!signed.ok) throw new Error(`elevenlabs_auth_${signed.status}`);
  const { signed_url } = await signed.json() as { signed_url: string };
  const response = await fetch(signed_url.replace(/^wss:/, 'https:'), { headers: { Upgrade: 'websocket' } });
  const ws = response.webSocket;
  if (!ws) throw new Error('elevenlabs_websocket_failed');
  return await new Promise<{ text: string; audioBase64: string | null }>((resolve, reject) => {
    let text = '', audio = '';
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = () => { clearTimeout(timer); clearTimeout(idle); clearInterval(heartbeat); try { ws.close(); } catch {} };
    const finish = () => { if(settled)return; settled=true; cleanup(); resolve({text,audioBase64:audio ? btoa(audio) : null}); };
    const fail = (code:string) => { if(settled)return; settled=true; cleanup(); reject(new Error(code)); };
    const timer = setTimeout(() => fail('elevenlabs_timeout'), 25000);
    ws.addEventListener('message', event => {
      try {
        const data = JSON.parse(String(event.data));
        if(data.type==='conversation_initiation_metadata'||data.type==='error') console.log(JSON.stringify({provider:'elevenlabs',event:data.type}));
        if (data.type === 'conversation_initiation_metadata') {
          ws.send(JSON.stringify({ type: 'user_message', text: message }));
        }
        if (data.type === 'ping') ws.send(JSON.stringify({ type: 'pong', event_id: data.ping_event.event_id }));
        if (data.type === 'agent_response') {
          text = data.agent_response_event.agent_response;
          clearTimeout(idle); idle = setTimeout(finish,5000);
        }
        if (data.type === 'audio') { audio += atob(data.audio_event.audio_base_64); if(audio.length>2000000)fail('audio_limit'); }
        if (text && audio) { clearTimeout(idle); idle = setTimeout(finish,2000); }
      } catch { fail('elevenlabs_invalid_event'); }
    });
    ws.addEventListener('error', () => fail('elevenlabs_socket_error'));
    ws.addEventListener('close', () => { if(!settled) { if(text)finish(); else fail('elevenlabs_closed'); } });
    ws.accept();
    ws.send(JSON.stringify({ type: 'conversation_initiation_client_data' }));
  });
}
// Words the speech recognition of Robottino's agent should prefer when the audio is unclear (owner, 11 Nov 2026:
// «a sinistra» was transcribed «Sì, grazie»). Robottino's agent only (ELEVENLABS_AGENT_ID), never another one;
// the keywords already there are kept, and nothing else of the agent changes.
export const ASR_KEYWORDS=['destra','sinistra','alto','basso','tutto','guarda','girati','spostati'];
export async function installAsrKeywords(env:Env){
  const config=env as Env&{ELEVENLABS_API_KEY?:string;ELEVENLABS_AGENT_ID?:string};
  if(!config.ELEVENLABS_API_KEY||!config.ELEVENLABS_AGENT_ID)throw Error('elevenlabs_not_configured');
  const path='/v1/convai/agents/'+encodeURIComponent(config.ELEVENLABS_AGENT_ID);
  const api=async(init:RequestInit={})=>{
    const response=await fetch('https://api.elevenlabs.io'+path,{...init,headers:{'xi-api-key':config.ELEVENLABS_API_KEY!,'content-type':'application/json'},signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error(`elevenlabs_${init.method??'GET'}_agent_${response.status}`);
    return response.json() as Promise<any>;
  };
  const before=await api(),asr={...(before.conversation_config?.asr??{})};
  const keywords:string[]=[...new Set([...(Array.isArray(asr.keywords)?asr.keywords:[]),...ASR_KEYWORDS])].slice(0,50);
  await api({method:'PATCH',body:JSON.stringify({conversation_config:{asr:{...asr,keywords}}})});
  const after=await api(),saved:string[]=after.conversation_config?.asr?.keywords??[];
  return {keywords:saved,added:ASR_KEYWORDS.every(word=>saved.includes(word)),promptUnchanged:after.conversation_config?.agent?.prompt?.prompt===before.conversation_config?.agent?.prompt?.prompt};
}

// English next to Italian (owner, 11 Nov 2026: «imposta l'agente per parlare anche in inglese», then the language as a
// choice in the app). Robottino's agent only. Two things are added and nothing else is touched: English among the
// agent's languages (language_presets.en) and the permission to choose the language when a conversation starts
// (platform_settings.overrides…agent.language). The speech recognition follows the conversation's language.
// `ready` is what a conversation in English needs: both things as the provider has them after the change.
const agentApi=(env:Env)=>{
  const config=env as Env&{ELEVENLABS_API_KEY?:string;ELEVENLABS_AGENT_ID?:string};
  if(!config.ELEVENLABS_API_KEY||!config.ELEVENLABS_AGENT_ID)throw Error('elevenlabs_not_configured');
  const path='/v1/convai/agents/'+encodeURIComponent(config.ELEVENLABS_AGENT_ID);
  return async(init:RequestInit={})=>{
    const response=await fetch('https://api.elevenlabs.io'+path,{...init,headers:{'xi-api-key':config.ELEVENLABS_API_KEY!,'content-type':'application/json'},signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error(`elevenlabs_${init.method??'GET'}_agent_${response.status}`);
    return response.json() as Promise<any>;
  };
};
// A livelier voice (owner, 16 Nov 2026: «modifica l'agente 11 Labs di robottino in modo tale che abbia una voce molto
// più energica, un po' come fatto per LiveWatch»). LiveWatch's agent (another project, only read) has the same voice
// (Sami), the same model, stability 0.23 and the expressive mode on: a low stability lets the voice move much more.
// Robottino's agent only. Only the settings named here are written (and the expressive mode only on an agent that
// has the setting); the voice, the model, the prompt and everything else are read again afterwards and must be as
// they were. `before` is what to give back to this same call to undo it.
export const LIVELY_VOICE={stability:.23,expressive:true};
// temperature (owner, the same evening: «porta temperatura a 1», as LiveWatch's agent has it): not the voice but how
// freely the model that writes the replies chooses its words; 0 gave the same flat sentences every time.
export type VoiceWish={stability?:number;speed?:number;expressive?:boolean;temperature?:number};
const voiceState=(agent:any)=>{
  const tts=agent?.conversation_config?.tts??{},prompt=agent?.conversation_config?.agent?.prompt??{};
  return {voice:tts.voice_id??null,model:tts.model_id??null,stability:tts.stability??null,similarity:tts.similarity_boost??null,speed:tts.speed??null,expressive:tts.expressive_mode??null,llm:prompt.llm??null,temperature:prompt.temperature??null};
};
export function voiceWish(value:unknown):VoiceWish|null{
  if(value===undefined||value===null)return LIVELY_VOICE;
  if(typeof value!=='object'||Array.isArray(value))return null;
  const v=value as Record<string,unknown>,wish:VoiceWish={};
  for(const key of Object.keys(v))if(!['stability','speed','expressive','temperature'].includes(key))return null;
  if('stability'in v){if(typeof v.stability!=='number'||!(v.stability>=0&&v.stability<=1))return null;wish.stability=v.stability;}
  if('speed'in v){if(typeof v.speed!=='number'||!(v.speed>=.7&&v.speed<=1.2))return null;wish.speed=v.speed;}
  if('expressive'in v){if(typeof v.expressive!=='boolean')return null;wish.expressive=v.expressive;}
  if('temperature'in v){if(typeof v.temperature!=='number'||!(v.temperature>=0&&v.temperature<=1))return null;wish.temperature=v.temperature;}
  return Object.keys(wish).length?wish:null;
}
export async function agentVoice(env:Env){return voiceState(await agentApi(env)());}
export async function setAgentVoice(env:Env,wish:VoiceWish=LIVELY_VOICE){
  const api=agentApi(env),before=await api(),was={...(before.conversation_config?.tts??{})},change:Record<string,unknown>={};
  if(wish.stability!==undefined&&was.stability!==wish.stability)change.stability=wish.stability;
  if(wish.speed!==undefined&&was.speed!==wish.speed)change.speed=wish.speed;
  if(wish.expressive!==undefined&&'expressive_mode'in was&&was.expressive_mode!==wish.expressive)change.expressive_mode=wish.expressive;
  const others=(agent:any)=>{const {stability,speed,expressive_mode,...rest}=agent?.conversation_config?.tts??{};return JSON.stringify(rest);};
  let after=before;
  if(Object.keys(change).length){
    await api({method:'PATCH',body:JSON.stringify({conversation_config:{tts:change}})});after=await api();
    // A provider that replaced the voice settings instead of adding to them: they are written again whole.
    if(others(after)!==others(before)){await api({method:'PATCH',body:JSON.stringify({conversation_config:{tts:{...was,...change}}})});after=await api();}
  }
  // The temperature is among the prompt's settings: only it is written, and the prompt's text, model and tools are
  // read again (`tools` is the provider's expanded copy of tool_ids: never sent, never compared).
  const promptOf=(agent:any)=>{const {temperature,tools,...rest}=agent?.conversation_config?.agent?.prompt??{};return JSON.stringify(rest);};
  const changed=Object.keys(change);
  if(wish.temperature!==undefined&&before.conversation_config?.agent?.prompt?.temperature!==wish.temperature){
    changed.push('temperature');
    await api({method:'PATCH',body:JSON.stringify({conversation_config:{agent:{prompt:{temperature:wish.temperature}}}})});after=await api();
    if(promptOf(after)!==promptOf(before)){
      const {tools,...whole}=before.conversation_config?.agent?.prompt??{};
      await api({method:'PATCH',body:JSON.stringify({conversation_config:{agent:{prompt:{...whole,temperature:wish.temperature}}}})});after=await api();
    }
  }
  return {before:voiceState(before),after:voiceState(after),changed,voiceUnchanged:others(after)===others(before),
    promptUnchanged:promptOf(after)===promptOf(before)};
}
const englishState=(agent:any)=>{
  const presets=agent?.conversation_config?.language_presets??{},primary=agent?.conversation_config?.agent?.language??null;
  const override=agent?.platform_settings?.overrides?.conversation_config_override?.agent?.language===true;
  return {primary,languages:Object.keys(presets),override,ready:(primary==='en'||'en'in presets)&&override};
};
export async function englishReady(env:Env){return englishState(await agentApi(env)());}
export async function installEnglish(env:Env){
  const api=agentApi(env),before=await api(),was=englishState(before);
  if(!was.ready){
    const presets={...(before.conversation_config?.language_presets??{})},overrides={...(before.platform_settings?.overrides??{})};
    const allowed={...(overrides.conversation_config_override??{})};allowed.agent={...(allowed.agent??{}),language:true};overrides.conversation_config_override=allowed;
    // The shape of an added language has changed between versions of the provider's API: the first one accepted stays.
    const first=before.conversation_config?.agent?.first_message??'';
    const shapes=[{overrides:{agent:{first_message:first}}},{overrides:{agent:{}}},{overrides:{}}];
    let failure:unknown;
    for(const shape of 'en'in presets?[presets.en]:shapes){
      try{await api({method:'PATCH',body:JSON.stringify({conversation_config:{language_presets:{...presets,en:shape}},platform_settings:{overrides}})});failure=undefined;break;}
      catch(error){failure=error;}
    }
    if(failure)throw failure;
  }
  const after=await api(),now=englishState(after);
  return {...now,changed:!was.ready,promptUnchanged:after.conversation_config?.agent?.prompt?.prompt===before.conversation_config?.agent?.prompt?.prompt,voiceUnchanged:after.conversation_config?.tts?.voice_id===before.conversation_config?.tts?.voice_id};
}
