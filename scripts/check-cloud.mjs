// Read-only smoke checks of this project's existing endpoint; never starts voice.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const base='https://robottino-stackchan.example.workers.dev';
const token=(await readFile(path.join(root,'private/robot-token'),'utf8')).trim();
if(token.length<32)throw Error('Token locale assente o non valido. Nessuna richiesta effettuata.');
const checks=[];
for(const [name,route,authenticated,expected] of [
  ['Salute servizio','/health',false,200],
  ['Preferenze protette','/api/preferences',false,401],
  ['Ricordi protetti','/api/memories',false,401],
  ['Token riconosciuto','/api/preferences',true,200],
  ['Bridge robot protetto disponibile','/api/robot/status',true,200],
]){
  const response=await fetch(base+route,{headers:authenticated?{Authorization:'Bearer '+token}:{},redirect:'error',signal:AbortSignal.timeout(10000)});
  const ok=response.status===expected;
  checks.push({name,status:response.status,expected,ok});
  await response.body?.cancel();
  console.log(`${ok?'PASS':'FAIL'} ${name}: HTTP ${response.status}`);
}
const directory=path.join(root,'work/verification');await mkdir(directory,{recursive:true});
await writeFile(path.join(directory,'cloud-readonly.json'),JSON.stringify({time:new Date().toISOString(),endpoint:base,readOnly:true,voiceStarted:false,checks},null,2)+'\n');
if(checks.some(check=>!check.ok))process.exitCode=1;
