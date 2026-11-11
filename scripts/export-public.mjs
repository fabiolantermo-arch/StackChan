// Makes the public copy of Robottino: the tracked files as they are now, without the owner's own data.
// Nothing here publishes anything: the copy is a plain folder (no git history); sending it to GitHub is a separate,
// explicit step.
//   node scripts/export-public.mjs <destination folder>
// - Left out: the working diary and the assistant's rules (they tell the owner's own setup and history), the compiled
//   firmware (anyone can build it). The licence text is docs/public/LICENSE.
// - Replaced: the personal strings listed in private/public-export.json (outside git), in every text file and in
//   file names. The same list is then searched for again, with every line of the files in private/, e-mail
//   addresses, home folders and the usual shapes of keys: one hit and the copy is refused.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,rmSync,statSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const destination=process.argv[2]&&path.resolve(process.argv[2]);
if(!destination){console.error('Usage: node scripts/export-public.mjs <destination folder>');process.exit(2);}
if(destination===root||destination.startsWith(root+path.sep)||root.startsWith(destination+path.sep)){console.error('The destination must be outside the working repository.');process.exit(2);}
const configPath=path.join(root,'private/public-export.json');
if(!existsSync(configPath)){console.error('private/public-export.json is missing: it lists the personal strings to replace.');process.exit(2);}
const config=JSON.parse(readFileSync(configPath,'utf8'));
const replace=config.replace.slice().sort((a,b)=>b[0].length-a[0].length); // the longest first

const EXCLUDED=[/^CLAUDE\.md$/,/^\.claude\//,/^PASSAGGIO-CLAUDE-CODE\.md$/,/^docs\/progress\.md$/,/^firmware\/artifacts\/(?!THIRD-PARTY-LICENSES\.txt$)/,/^docs\/public\//];
const BINARY=/\.(png|jpe?g|gif|mp3|mp4|mov|m4a|aac|webm|wav|bin|xsa|icns|ico|pdf|car|ttf|otf|zip)$/i;
const clean=text=>replace.reduce((value,[from,to])=>value.split(from).join(to),text);

if(existsSync(destination)){
  if(existsSync(path.join(destination,'.git'))){console.error('The destination holds a git repository: remove it yourself, this script never deletes one.');process.exit(2);}
  if(readdirSync(destination).length&&!existsSync(path.join(destination,'.robottino-public-copy'))){console.error('The destination is not empty and was not made by this script.');process.exit(2);}
  rmSync(destination,{recursive:true});
}
mkdirSync(destination,{recursive:true});writeFileSync(path.join(destination,'.robottino-public-copy'),'Made by scripts/export-public.mjs. Safe to delete.\n');

const tracked=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
const written=[];
const put=(relative,content,mode)=>{
  const target=path.join(destination,relative);mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,content);if(mode&0o111)chmodSync(target,0o755);written.push(relative);
};
for(const file of tracked){
  if(EXCLUDED.some(rule=>rule.test(file)))continue;
  const source=path.join(root,file);if(!existsSync(source))continue;
  const mode=statSync(source).mode,name=clean(file);
  if(BINARY.test(file))put(name,readFileSync(source),mode);
  // The public copy greets nobody by name until its owner sets one.
  else put(name,clean(readFileSync(source,'utf8')).replace(file==='wrangler.jsonc'?/"OWNER_NAME":"[^"]*"/:/$^/,'"OWNER_NAME":""').replace(file==='wrangler.jsonc'?/"ALLOW_SWEARING":"[^"]*"/:/$^/,'"ALLOW_SWEARING":"false"'),mode);
}
// The licence.
put('LICENSE',clean(readFileSync(path.join(root,'docs/public/LICENSE'),'utf8')).replace('{{HOLDER}}',config.licenseHolder||'Robottino contributors'),0);
// The public .gitignore keeps the compiled firmware out too.
writeFileSync(path.join(destination,'.gitignore'),readFileSync(path.join(destination,'.gitignore'),'utf8').replace(/\s*$/,'\n')+'firmware/artifacts/\n.robottino-public-copy\n');

// Search the copy for anything that must not leave: nothing found is ever printed, only where it was.
const needles=new Map();
for(const [from] of config.replace)needles.set(from.toLowerCase(),'personal string');
const privateDir=path.join(root,'private');
for(const entry of readdirSync(privateDir,{recursive:true})){
  const file=path.join(privateDir,String(entry));if(!statSync(file).isFile()||file===configPath||statSync(file).size>1_000_000)continue;
  let text;try{text=readFileSync(file,'utf8');}catch{continue;}
  for(const line of text.split(/\r?\n/)){const value=line.trim();if(value.length>=16&&!/\s/.test(value))needles.set(value.toLowerCase(),'a line of private/'+entry);}
}
const SHAPES=[[/\bsk-[A-Za-z0-9_-]{20,}/,'an OpenAI-style key'],[/\bxi-api-key['":\s]+[A-Za-z0-9]{20,}/i,'an ElevenLabs key'],[/-----BEGIN [A-Z ]*PRIVATE KEY-----/,'a private key'],
  [/\bBearer\s+[A-Za-z0-9._-]{32,}/,'a bearer token'],[/[A-Za-z0-9._%+-]+@(?!example\.|users\.noreply\.github\.com|anthropic\.com)[A-Za-z0-9.-]+\.[a-z]{2,}/i,'an e-mail address'],[/\/Users\/(?!me\/|example\/|\$|<)[A-Za-z0-9._-]+/,'a home folder'],[/\bgh[pousr]_[A-Za-z0-9]{30,}/,'a GitHub token']];
const hits=[];
for(const relative of written){
  const data=readFileSync(path.join(destination,relative));const lower=data.toString('latin1').toLowerCase();
  if(needles.has(relative.toLowerCase()))hits.push([relative,'its name']);
  for(const [needle,what] of needles)if(lower.includes(Buffer.from(needle,'utf8').toString('latin1'))){hits.push([relative,what]);}
  if(BINARY.test(relative))continue;
  const text=data.toString('utf8');
  for(const [shape,what] of SHAPES)if(shape.test(text))hits.push([relative,what]);
}
if(hits.length){
  for(const [file,what] of hits)console.error(`REFUSED ${file}: ${what}`);
  rmSync(destination,{recursive:true});console.error(`The public copy was removed: ${hits.length} finding(s).`);process.exit(1);
}
console.log(`Public copy: ${written.length} files in ${destination}. ${tracked.length-written.length+1} tracked files left out. No personal string, private line or key found. Nothing was published.`);
