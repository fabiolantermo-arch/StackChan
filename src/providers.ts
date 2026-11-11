import type { ChatMessage } from "./types";

export async function askLiveOne(env: Env, text: string, history: ChatMessage[] = []): Promise<{ text: string; audioBase64: string | null }> {
  if (!env.OPENAI_API_KEY) throw new Error("OpenAI is not configured");
  const response = await fetch("https://api.openai.com/v1/live/sessions", { headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, Upgrade: "websocket" } });
  const socket = response.webSocket;
  if (!socket) throw new Error("Live One websocket was not created");
  return await new Promise((resolve, reject) => {
    let transcript = "";
    let audio = "";
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = () => { clearTimeout(timeout); clearInterval(heartbeat); clearTimeout(finishTimer); try {socket.close(1000);} catch {} };
    const fail = (code:string) => { if(settled)return; settled=true; cleanup(); reject(new Error(code)); };
    const timeout = setTimeout(() => fail('Live One timeout'), 20000);
    const finish = () => {
      if(settled)return; settled=true;
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (finishTimer) clearTimeout(finishTimer);
      try { socket.close(1000); } catch {}
      resolve({ text: transcript, audioBase64: audio ? btoa(audio) : null });
    };
    socket.addEventListener('close',()=>{if(!settled){if(transcript)finish();else fail('Live One closed');}});
    socket.addEventListener("error", () => fail('Live One websocket error'));
    socket.addEventListener("message", (event) => {
      try {
        const value = JSON.parse(String(event.data)) as { type?: string; delta?: string; error?: { code?: string } };
        if(value.type==='session.started'||value.type==='session.error'||value.type==='error') console.log(JSON.stringify({provider:'openai',event:value.type,code:value.error?.code}));
        if (value.type === "session.started") {
          heartbeat = setInterval(() => socket.send(JSON.stringify({type:'session.input_audio.append',audio:btoa('\u0000'.repeat(4800))})),100);
          socket.send(JSON.stringify({ type: "session.commentary.append", event_id: "robottino-live-one-test", delegation_id: null, content: 'Rispondi ora alla richiesta dell’utente: ' + text }));
        } else if (value.type === "session.output_transcript.delta" && value.delta) {
          transcript += value.delta;
          if (finishTimer) clearTimeout(finishTimer);
          finishTimer = setTimeout(finish, 1200);
        } else if (value.type === "session.output_audio.delta" && value.delta) {
          audio += atob(value.delta);
          if(audio.length>2000000) { fail('audio_limit'); return; }
          if (finishTimer) clearTimeout(finishTimer);
          finishTimer = setTimeout(finish,2000);
        } else if (value.type === "error" || value.type === "session.error") {
          fail('Live One provider error');
        }
      } catch {
        fail('Invalid Live One response');
      }
    });
    socket.accept();
    socket.send(JSON.stringify({type:'session.start',session:{model:'gpt-live-1',store:false,input:history.map(m=>({type:'message',role:m.role,content:[{type:m.role==='assistant'?'output_text':'input_text',text:m.content}]})),audio:{format:{type:'audio/pcm',rate:24000},output:{voice:'marin'}}}}));
  });
}

export async function askOpenAI(env: Env, history: ChatMessage[]): Promise<string> {
  if (!env.OPENAI_API_KEY || !env.OPENAI_MODEL) throw new Error("OpenAI is not configured");
  const response = await fetch("https://api.openai.com/v1/responses", { method:"POST", headers:{authorization:`Bearer ${env.OPENAI_API_KEY}`,"content-type":"application/json"}, body:JSON.stringify({model:env.OPENAI_MODEL,input:history}) });
  if (!response.ok) throw new Error(`OpenAI request failed: ${response.status}`);
  const data = await response.json() as { output_text?: string; output?: Array<{content?: Array<{text?: string}>}> };
  const text = data.output_text ?? data.output?.flatMap((item) => item.content ?? []).map((part) => part.text ?? "").join("");
  if (!text) throw new Error("OpenAI returned no text");
  return text;
}

export async function synthesizeElevenLabs(env: Env, text: string): Promise<string | null> {
  if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID) return null;
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(env.ELEVENLABS_VOICE_ID)}`, { method:"POST", headers:{"xi-api-key":env.ELEVENLABS_API_KEY,"content-type":"application/json",accept:"audio/mpeg"}, body:JSON.stringify({text,model_id:env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2"}) });
  if (!response.ok) throw new Error(`ElevenLabs request failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
