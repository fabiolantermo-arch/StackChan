// Claude Code hook → Robottino reacts on its screen (fixed reactions only, no text is sent).
// Use: node scripts/robot-reaction.mjs attention|done|tests   (tests: reads the Bash result from stdin)
// Never blocks or fails the hook: any error is ignored. ROBOTTINO_DEBUG=1 prints the outcome.
import {readFile} from 'node:fs/promises';
const mode=process.argv[2],debug=process.env.ROBOTTINO_DEBUG?(...a)=>console.error('[robottino]',...a):()=>{};
async function input(){let text='';for await(const part of process.stdin)text+=part;try{return JSON.parse(text);}catch{return {};}}
async function main(){
  const event=process.stdin.isTTY?{}:await input();
  let kind=mode;
  if(mode==='attention'&&event.message&&!/permission|permesso|approv/i.test(event.message))return debug('notifica ignorata:',event.message);
  if(mode==='tests'){
    // Only test commands: success or failure from the usual runners' summaries.
    if(!/\b(?:npm (?:run )?test|vitest|node --test|swift test|xcodebuild test)\b/.test(event.tool_input?.command??''))return;
    const output=JSON.stringify(event.tool_response??'');
    kind=/# fail [1-9]|\b[1-9]\d* failed\b|not ok \d|\bFAIL\b/.test(output)?'failure':/# pass \d|\b\d+ passed\b|\bPASS\b/.test(output)?'success':'';
    if(!kind)return;
  }
  if(!['attention','done','success','failure'].includes(kind))return debug('reazione sconosciuta:',kind);
  const token=(await readFile(new URL('../private/robot-token',import.meta.url),'utf8')).trim();
  const response=await fetch('https://robottino-stackchan.example.workers.dev/api/robot/reaction',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({kind}),signal:AbortSignal.timeout(4000)});
  debug(kind,response.status,(await response.text()).slice(0,200));
}
await main().catch(error=>debug('errore:',error.message));
