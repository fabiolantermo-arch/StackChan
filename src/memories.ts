import {DurableObject} from 'cloudflare:workers';
import {validPreferences,type Preferences} from './preferences';
export type Memory={id:string;text:string;kind:string;created_at:string;updated_at:string;expires_at:number|null;source:string};
type Command={action?:string;id?:string;text?:string;kind?:string;expiresAt?:number;confirmation?:string;query?:string};
export class RobotMemory extends DurableObject<Env> {
  constructor(ctx:DurableObjectState,env:Env){super(ctx,env);ctx.blockConcurrencyWhile(async()=>{
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,text TEXT NOT NULL,kind TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,expires_at INTEGER,source TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS confirmations(token TEXT PRIMARY KEY,expires INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS preferences(id INTEGER PRIMARY KEY,value TEXT NOT NULL)');
  });}
  preferences():Preferences{return JSON.parse(this.ctx.storage.sql.exec<{value:string}>('SELECT value FROM preferences WHERE id=1').toArray()[0]?.value??'{"provider":"elevenlabs","voice":"kAzI34nYjizE0zON6rXv"}');}
  setPreferences(value:Preferences){if(!validPreferences(value))throw Error('invalid_preferences');this.ctx.storage.sql.exec('INSERT INTO preferences VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',JSON.stringify(value));return value;}
  list(){
    this.ctx.storage.sql.exec('DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?',Date.now());
    return this.ctx.storage.sql.exec<Memory>('SELECT * FROM memories ORDER BY updated_at DESC,id').toArray();
  }
  recall(query=''){
    // Unicode-aware split keeps accented Italian words intact.
    const words=query.toLocaleLowerCase('it').split(/[^\p{L}\p{N}]+/u).filter(w=>w.length>2).slice(0,20);
    if(words.length)return this.list().filter(m=>words.some(w=>m.text.toLocaleLowerCase('it').includes(w))).slice(0,6).map(m=>({id:m.id,text:m.text}));
    // Conversation start: every kind, profile first, so spoken "ricorda che" facts are recalled too.
    const items=this.list();
    return [...items.filter(m=>m.kind==='profile'),...items.filter(m=>m.kind!=='profile')].slice(0,12).map(m=>({id:m.id,text:m.text}));
  }
  command(input:unknown){
    if(!input||typeof input!=='object')return {error:'invalid_command'};
    const c=input as Command;
    if(c.action==='list')return {memories:this.list()};
    if(c.action==='recall')return {memories:this.recall(typeof c.query==='string'?c.query.slice(0,500):'')};
    if(c.action==='prepare_clear'){
      const token=crypto.randomUUID();
      this.ctx.storage.sql.exec('DELETE FROM confirmations');
      this.ctx.storage.sql.exec('INSERT INTO confirmations VALUES(?,?)',token,Date.now()+120000);
      return {confirmation:token,requiresConfirmation:true};
    }
    if(c.action==='clear'){
      if(typeof c.confirmation!=='string')return {error:'confirmation_required'};
      const valid=this.ctx.storage.sql.exec('SELECT token FROM confirmations WHERE token=? AND expires>?',c.confirmation,Date.now()).toArray().length;
      if(!valid)return {error:'confirmation_invalid'};
      this.ctx.storage.transactionSync(()=>{this.ctx.storage.sql.exec('DELETE FROM memories');this.ctx.storage.sql.exec('DELETE FROM confirmations');});
      return {ok:true};
    }
    if(c.action==='forget_match'){
      // Spoken "dimentica che…": delete only an unambiguous single match.
      if(typeof c.text!=='string'||!c.text.trim()||c.text.length>500)return {error:'invalid_text'};
      const needle=c.text.trim().toLocaleLowerCase('it').replace(/[.!?]+$/,'');
      const matches=this.list().filter(m=>m.text.toLocaleLowerCase('it').includes(needle));
      if(!matches.length)return {error:'not_found'};
      if(matches.length>1)return {error:'ambiguous',memories:matches.slice(0,6).map(m=>({id:m.id,text:m.text}))};
      this.ctx.storage.sql.exec('DELETE FROM memories WHERE id=?',matches[0].id);this.ctx.storage.sql.exec('DELETE FROM confirmations');
      return {ok:true,forgotten:{id:matches[0].id,text:matches[0].text}};
    }
    if(c.action==='forget'){
      if(typeof c.id!=='string')return {error:'id_required'};
      this.ctx.storage.sql.exec('DELETE FROM memories WHERE id=?',c.id);return {ok:true};
    }
    if(!['remember','update'].includes(c.action??''))return {error:'invalid_action'};
    if(typeof c.text!=='string'||!c.text.trim()||c.text.length>500)return {error:'invalid_text'};
    // Conservative guard for common credentials; never log rejected content.
    if(/password|passwd|api.?key|chiave (?:api|privata)|codice (?:pin|otp)|\bsk-[a-z0-9_-]{12,}|-----BEGIN|Bearer\s+[a-z0-9]/i.test(c.text))return {error:'secret_not_allowed'};
    if(c.kind!==undefined&&!['profile','fact','preference'].includes(c.kind))return {error:'invalid_kind'};
    if(c.expiresAt!==undefined&&(!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=Date.now()))return {error:'invalid_expiry'};
    const items=this.list();
    if(c.action==='update'&&!items.some(m=>m.id===c.id))return {error:'not_found'};
    const text=c.text.trim();
    if(c.action==='remember'){
      const duplicate=items.find(m=>m.text===text);if(duplicate)return {memory:duplicate};
      if(items.length>=100)return {error:'memory_limit'};
    }
    const id=c.action==='update'?c.id!:crypto.randomUUID(),now=new Date().toISOString();
    const previous=items.find(m=>m.id===id);
    this.ctx.storage.sql.exec('INSERT INTO memories VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text,kind=excluded.kind,updated_at=excluded.updated_at,expires_at=excluded.expires_at',id,text,c.kind??previous?.kind??'fact',previous?.created_at??now,now,c.expiresAt??previous?.expires_at??null,'explicit_user_command');
    this.ctx.storage.sql.exec('DELETE FROM confirmations');
    return {memory:this.list().find(m=>m.id===id)!};
  }
}
export function spokenMemoryCommand(text:unknown):Command|null{
  if(typeof text!=='string'||text.length>600)return null;
  // Speech transcripts add names, commas and punctuation: "Robottino, ricordati che…".
  const value=text.trim().replace(/^(?:(?:ehi|ciao|ok|senti)[,\s]+)?robottino[\s,.:!]*/i,'').replace(/[\s.!?]+$/,'').trim();
  if(/^(?:dimentica|cancella|scorda(?:ti)?)\s+tutt[oi](?:\s+i\s+ricordi)?$/i.test(value))return {action:'prepare_clear'};
  if(/^(?:(?:che\s+)?cosa\s+(?:ti\s+)?(?:ricordi|sai)|(?:ti\s+)?ricordi\s+(?:qualcosa)?)\s*di\s+me$/i.test(value))return {action:'list'};
  const about=/^(?:che\s+)?cosa\s+(?:ti\s+)?(?:ricordi|sai)\s+(?:di|su|sul|sulla|sui|sulle|del|della|dei|delle)\s+(.+)$/i.exec(value);
  if(about)return {action:'recall',query:about[1]};
  const forget=/^(?:dimentica|scorda(?:ti)?)\s*[,:]?\s*(?:che\s+)?(.+)$/i.exec(value);
  if(forget)return {action:'forget_match',text:forget[1]};
  // "Ricordami tra 10 minuti…" is a timer handled on the device, never a memory.
  const remember=/^(?:ricorda(?:ti)?|memorizza|tieni\s+a\s+mente|segna(?:ti)?)(?!\p{L})\s*[,:]?\s*(?:che\s+)?(.+)$/iu.exec(value);
  if(remember&&remember[1].length>2)return {action:'remember',text:remember[1]};
  return null;
}
