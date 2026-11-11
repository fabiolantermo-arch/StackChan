import {installEnglish} from './eleven-agent';
// A documented Italian ElevenLabs catalogue, copied as identifiers only.
// Robottino has its own agent and keeps its current voice until explicitly changed.
export const voices = {
  openai: [{id:'marin',name:'Marin'},{id:'cedar',name:'Cedar'}],
  elevenlabs: [
    {id:'kAzI34nYjizE0zON6rXv',name:'Sami'},
    {id:'cjVigY5qzO86Huf0OWal',name:'Eric'},
    {id:'G0q9AYE8QsarSbMtaIEu',name:'Elettra'},
    {id:'RZ9oBlQ97k7Ug7uU1Ij0',name:'Giulia Pro'},
    {id:'uC9VI5XrTxXRNlCzGSKR',name:'Giulia'},
    {id:'rBvFGN2xzwk9odGDuw0q',name:'Mia'},
    {id:'exATa44ZUcsstQSIV2RM',name:'Stella'},
    {id:'fQmr8dTaOQq116mo2X7F',name:'Samanta'},
    {id:'CiwzbDpaN3pQXjTgx3ML',name:'Aida'},
    {id:'PSp7S6ST9fDNXDwEzX0m',name:'Alessandro'},
    {id:'Dzlw1nIlAqiOOW6J7qo1',name:'Chiara'},
    {id:'gfKKsLN1k0oYYN9n2dXX',name:'Violetta'},
    {id:'MTgv1KRJpUnc34UMGTHK',name:'Matteo'},
    {id:'DTGwzA4YLrWB1FAT6Uas',name:'Lorenzo'},
    {id:'QITiGyM4owEZrBEf0QV8',name:'Ginevra'},
    {id:'8KInRSd4DtD5L5gK7itu',name:'Giusy'}
  ]
};
// language: what Robottino speaks and understands in a conversation (owner, 11 Nov 2026: Italian or English, chosen in
// the app). Absent means Italian, as before.
export type Preferences={provider:'openai'|'elevenlabs';voice:string;language?:'it'|'en'};
export function validPreferences(value:unknown):value is Preferences {
  if(!value||typeof value!=='object')return false;
  const c=value as Preferences;
  return (c.provider==='openai'||c.provider==='elevenlabs')&&voices[c.provider].some(v=>v.id===c.voice)&&(c.language===undefined||c.language==='it'||c.language==='en');
}
export async function preferencesAPI(request:Request,env:Env){
  const store=env.ROBOT_MEMORY.getByName('owner');
  if(request.method==='GET')return Response.json({preferences:await store.preferences(),voices},{headers:{'cache-control':'no-store'}});
  if(request.method!=='POST')return Response.json({error:'method_not_allowed'},{status:405});
  if(!request.headers.get('content-type')?.includes('application/json'))return Response.json({error:'unsupported_media_type'},{status:415});
  // Bound streaming input before buffering.
  const reader=request.body?.getReader();let raw='',size=0;const decoder=new TextDecoder();
  if(!reader)return Response.json({error:'invalid_request'},{status:400});
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1024){await reader.cancel();return Response.json({error:'payload_too_large'},{status:413});}raw+=decoder.decode(value,{stream:true});}
  let body:unknown;try{body=JSON.parse(raw+decoder.decode());}catch{return Response.json({error:'invalid_json'},{status:400});}
  if(!validPreferences(body))return Response.json({error:'invalid_preferences'},{status:400});
  if(body.provider==='elevenlabs'){
    try {
    const response=await fetch('https://api.elevenlabs.io/v1/convai/agents/'+encodeURIComponent(env.ELEVENLABS_AGENT_ID),{method:'PATCH',headers:{'xi-api-key':env.ELEVENLABS_API_KEY??'','content-type':'application/json'},body:JSON.stringify({conversation_config:{tts:{voice_id:body.voice}}}),signal:AbortSignal.timeout(10000)});
    if(!response.ok)return Response.json({error:'voice_update_failed'},{status:502});
    const checked=await fetch('https://api.elevenlabs.io/v1/convai/agents/'+encodeURIComponent(env.ELEVENLABS_AGENT_ID),{headers:{'xi-api-key':env.ELEVENLABS_API_KEY??''},signal:AbortSignal.timeout(10000)});
    const config=await checked.json() as {conversation_config?:{tts?:{voice_id?:string}}};
    if(!checked.ok||config.conversation_config?.tts?.voice_id!==body.voice)return Response.json({error:'voice_update_unverified'},{status:502});
    }catch{return Response.json({error:'voice_update_failed'},{status:502});}
  }
  // The language stays as it was when the request does not name one (an older app saves model and voice only).
  // English with the ElevenLabs agent needs the agent to have it: it is added now if missing, and when that cannot
  // be confirmed nothing is saved, so no conversation is ever started in a language the agent refuses.
  const language=body.language??(await store.preferences()).language;
  if(language==='en'&&body.provider==='elevenlabs'){
    try{if(!(await installEnglish(env)).ready)return Response.json({error:'language_unavailable'},{status:502});}
    catch{return Response.json({error:'language_unavailable'},{status:502});}
  }
  return Response.json({preferences:await store.setPreferences({provider:body.provider,voice:body.voice,...(language?{language}:{})})},{headers:{'cache-control':'no-store'}});
}
