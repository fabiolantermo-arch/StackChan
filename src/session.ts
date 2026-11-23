import { DurableObject } from "cloudflare:workers";
import { askLiveOne, askOpenAI, synthesizeElevenLabs } from "./providers";
import type { ChatMessage } from "./types";
import { askElevenAgent } from './eleven-agent';
import {voiceStream} from './voice-stream';

// How long an iPhone call can keep the robot's search lights off at most (calls last up to 5 minutes).
const OTHER_CALL_MS=6*60*1000;
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
  private tellSearch?:(active:boolean)=>void;
  // Searches under way, and the iPhone's ElevenLabs calls open meanwhile (code review, 19 Nov 2026): the agent's web
  // search webhook does not say which call it is for, so the robot lights up only while its own call is the only
  // one that can have asked, and the end of one search does not switch off another still running.
  private searches=0;
  private others=new Map<string,number>();
  /** A web search has started or ended: the robot shows it with its lights, if the search can only be its own. */
  searching(active:boolean){
    try{
      if(!this.tellSearch){this.searches=0;return;}
      const now=Date.now();for(const [id,until] of this.others)if(until<now)this.others.delete(id);
      this.searches=Math.max(0,this.searches+(active===true?1:-1));
      if(active===true&&this.others.size)return;
      this.tellSearch(this.searches>0&&!this.others.size);
    }catch{}
  }
  /** Another ElevenLabs call (the iPhone's) opened or closed: kept at most as long as a call can last. */
  otherCall(id:string,open:boolean){if(open)this.others.set(id,Date.now()+OTHER_CALL_MS);else this.others.delete(id);}
  async fetch(request:Request) {
    // The robot has one call at a time. If it restarts in the middle of one, nothing closes the old call here (its
    // connection just goes quiet), and every new call was refused as busy until the old one ran out (owner, 11 Nov
    // 2026: «conversazione terminata appena la faccio partire», after the robot restarted). A new call from the robot
    // means the old one is gone: it is closed (its turns saved as usual) and the new one takes its place.
    if(this.streaming&&this.stopStream&&new URL(request.url).searchParams.get('sessionId')==='robot'){
      console.log(JSON.stringify({event:'voice.replaced'}));this.stopStream();
    }
    if(this.streaming)return Response.json({error:'session_busy'},{status:409});
    this.streaming=true;this.searches=0;
    const params=new URL(request.url).searchParams,other=params.get('sessionId')!=='robot'&&params.get('provider')==='elevenlabs'?crypto.randomUUID():undefined;
    const robotSession=()=>this.env.CHAT_SESSIONS.getByName('stream:elevenlabs:robot');
    const tellOther=(open:boolean)=>{if(other)void robotSession().otherCall(other,open).catch(()=>{});};
    const history=this.ctx.storage.sql.exec<{role:string;content:string}>('SELECT role,content FROM (SELECT id,role,content FROM messages ORDER BY id DESC LIMIT 12) ORDER BY id').toArray();
    try {
      const response=await voiceStream(request,this.env,history,messages=>{
        // A failed history write must never leave the session permanently busy.
        try{
          this.ctx.storage.transactionSync(()=>{
            for(const m of messages)this.ctx.storage.sql.exec('INSERT INTO messages(role,content,created_at) VALUES(?,?,?)',m.role,m.content,new Date().toISOString());
            this.ctx.storage.sql.exec('DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 12)');
          });
        }finally{this.streaming=false;this.stopStream=undefined;this.tellSearch=undefined;tellOther(false);}
      },(stop,searching)=>{this.stopStream=stop;this.tellSearch=searching;tellOther(true);});
      if(response.status!==101){this.streaming=false;tellOther(false);}
      return response;
    }catch{this.streaming=false;tellOther(false);return Response.json({error:'provider_unavailable'},{status:502});}
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
