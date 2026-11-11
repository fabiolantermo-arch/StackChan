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
