// Repeatable pre-hardware checks. Every command is fixed; no flash/deploy/install.
import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const flags=new Set(process.argv.slice(2));
if([...flags].some(flag=>!['--cloud','--iphone-build'].includes(flag)))throw Error('Opzioni ammesse: --cloud, --iphone-build');
const output=path.join(root,'work/verification');await mkdir(output,{recursive:true});
const steps=[
  ['Binding e tipi','npm',['run','cf:types']],
  ['Controllo TypeScript','npm',['run','typecheck']],
  ['Test backend e firmware','npm',['test']],
  ['Test app iPhone','node',['ios/test-connection.mjs']],
  ['Vision su fotogramma sintetico, senza camera','node',['ios/test-vision.mjs']],
  ['Compilazione MOD, senza flash','node',['firmware/stackchan-mod/build.mjs']],
  ['Pacchetto Worker, senza distribuzione','npm',['exec','--no','--','wrangler','deploy','--dry-run','--outdir',path.join(output,'worker-bundle')]],
];
if(flags.has('--iphone-build'))steps.push(['Build e firma iPhone','node',['ios/build-check.mjs']]);
if(flags.has('--cloud'))steps.push(['Controlli cloud in sola lettura','node',['scripts/check-cloud.mjs']]);
const report={started:new Date().toISOString(),results:[],sourceHashes:{},hardwareTested:false,flashed:false,deployed:false,installed:false};
for(const filename of ['package-lock.json','src/index.ts','src/robot-link.ts','src/robot-wire.ts','firmware/stackchan-mod/live-device.js','firmware/stackchan-mod/live-wire.js','ios/Robottino/RobotLive.swift','ios/Robottino/RobotLiveCore.swift','firmware/stackchan-mod/mod.js','firmware/stackchan-mod/clock.js','ios/Robottino/Sources.swift']){
  report.sourceHashes[filename]=createHash('sha256').update(await readFile(path.join(root,filename))).digest('hex');
}
for(const [index,[name,command,args]] of steps.entries()){
  const log=path.join(output,`${String(index+1).padStart(2,'0')}.log`);
  console.log(`Verifica ${index+1}/${steps.length}: ${name}`);
  let buffer='';
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:root,env:{...process.env,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',data=>{buffer+=data;});child.stderr.on('data',data=>{buffer+=data;});
    child.on('error',reject);child.on('close',resolve);
  });
  await writeFile(log,buffer);
  report.results.push({name,exitCode:code,passed:code===0,log});
  await writeFile(path.join(output,'latest.json'),JSON.stringify(report,null,2)+'\n');
  if(code!==0){console.error(buffer.slice(-5000));console.error(`Verifica non superata: ${name}`);process.exitCode=1;break;}
}
report.finished=new Date().toISOString();report.passed=report.results.length===steps.length&&report.results.every(result=>result.passed);
await writeFile(path.join(output,'latest.json'),JSON.stringify(report,null,2)+'\n');
console.log(report.passed?'Tutte le verifiche richieste sono passate. Hardware ancora da provare.':'Verifiche incomplete: consultare work/verification/latest.json.');
