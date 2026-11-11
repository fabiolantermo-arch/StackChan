import { DurableObject } from "cloudflare:workers";
import { askLiveOne, askOpenAI, synthesizeElevenLabs } from "./providers";
import type { ChatMessage } from "./types";
import { askElevenAgent } from './eleven-agent';
import {voiceStream} from './voice-stream';

export class ChatSession extends DurableObject<Env> {
  private busy = false;
  private leaseUntil=0;
  beginTurn() {
    if(Date.now()<this.leaseUntil)throw new Error('session_busy');
    this.leaseUntil=Date.now()+45000;
    return this.ctx.storage.sql.exec<{role:'user'|'assistant';content:string}>('SELECT role,content FROM (SELECT id,role,content FROM messages ORDER BY id DESC LIMIT 12) ORDER BY id').toArray();
  }
  finishTurn(user:string,assistant:string) { if(assistant)this.save(user,assistant);this.leaseUntil=0; }
  private streaming = false;
  private stopStream?:()=>void;
  async fetch(request:Request) {
    // The robot has one call at a time. If it restarts in the middle of one, nothing closes the old call here (its
    // connection just goes quiet), and every new call was refused as busy until the old one ran out (owner, 11 Nov
    // 2026: «conversazione terminata appena la faccio partire», after the robot restarted). A new call from the robot
    // means the old one is gone: it is closed (its turns saved as usual) and the new one takes its place.
    if(this.streaming&&this.stopStream&&new URL(request.url).searchParams.get('sessionId')==='robot'){
      console.log(JSON.stringify({event:'voice.replaced'}));this.stopStream();
    }
    if(this.streaming)return Response.json({error:'session_busy'},{status:409});
    this.streaming=true;
    const history=this.ctx.storage.sql.exec<{role:string;content:string}>('SELECT role,content FROM (SELECT id,role,content FROM messages ORDER BY id DESC LIMIT 12) ORDER BY id').toArray();
    try {
      const response=await voiceStream(request,this.env,history,messages=>{
        // A failed history write must never leave the session permanently busy.
        try{
          this.ctx.storage.transactionSync(()=>{
            for(const m of messages)this.ctx.storage.sql.exec('INSERT INTO messages(role,content,created_at) VALUES(?,?,?)',m.role,m.content,new Date().toISOString());
            this.ctx.storage.sql.exec('DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 12)');
          });
        }finally{this.streaming=false;this.stopStream=undefined;}
      },stop=>{this.stopStream=stop;});
      if(response.status!==101)this.streaming=false;
      return response;
    }catch{this.streaming=false;return Response.json({error:'provider_unavailable'},{status:502});}
  }
  clearHistory() { if(this.streaming||this.busy)throw new Error('session_busy');this.ctx.storage.sql.exec('DELETE FROM messages'); }
  consume() {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS quota (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL)');
    const now = Date.now(), minute = 'm' + Math.floor(now/60000), day = 'd' + Math.floor(now/86400000);
    const count = (key:string) => this.ctx.storage.sql.exec<{count:number}>('SELECT count FROM quota WHERE bucket=?',key).toArray()[0]?.count ?? 0;
    if (count(minute)>=6 || count(day)>=100) return false;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM quota WHERE bucket NOT IN (?,?)',minute,day);
      for (const key of [minute,day]) this.ctx.storage.sql.exec('INSERT INTO quota VALUES (?,1) ON CONFLICT(bucket) DO UPDATE SET count=count+1',key);
    });
    return true;
  }
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => { this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)"); });
  }
  async chat(message: string, speak = false, provider = 'openai'): Promise<{reply:string; audioBase64:string|null}> {
    if (this.busy) throw new Error('session_busy');
    this.busy = true;
    try {
    const prior = this.ctx.storage.sql.exec<{role:"user"|"assistant";content:string}>("SELECT role, content FROM (SELECT id,role,content FROM messages ORDER BY id DESC LIMIT 12) ORDER BY id ASC").toArray();
    if (provider === 'elevenlabs') {
      const context = prior.length ? 'Cronologia (solo contesto): ' + JSON.stringify(prior) + '\nRichiesta corrente: ' : '';
      const result = await askElevenAgent(this.env, context + message);
      this.save(message,result.text);
      return { reply: result.text, audioBase64: speak ? result.audioBase64 : null };
    }
    if (this.env.OPENAI_MODEL === "gpt-live-1") {
      const live = await askLiveOne(this.env, message, prior);
      this.ctx.storage.sql.exec("INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?)", "user", message, new Date().toISOString());
      this.ctx.storage.sql.exec("INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?)", "assistant", live.text, new Date().toISOString());
      this.ctx.storage.sql.exec('DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 12)');
      return {reply:live.text, audioBase64:speak ? live.audioBase64 : null};
    }
    const reply = await askOpenAI(this.env, [...prior, {role:"user",content:message} satisfies ChatMessage]);
    this.ctx.storage.sql.exec("INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?)", "user", message, new Date().toISOString());
    this.ctx.storage.sql.exec("INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?)", "assistant", reply, new Date().toISOString());
    return {reply, audioBase64:speak ? await synthesizeElevenLabs(this.env, reply) : null};
    } finally { this.busy = false; }
  }
  private save(user:string,assistant:string) {
    this.ctx.storage.transactionSync(()=>{
      for(const [role,content] of [['user',user],['assistant',assistant]]) this.ctx.storage.sql.exec('INSERT INTO messages(role,content,created_at) VALUES(?,?,?)',role,content.slice(0,4000),new Date().toISOString());
      this.ctx.storage.sql.exec('DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 12)');
    });
  }
}
