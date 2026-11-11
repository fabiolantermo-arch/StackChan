// BUILD ONLY. Deliberately offers no flash/deploy option.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {existsSync,mkdirSync,copyFileSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
const upstream=path.join(root,'work/stack-chan-upstream');
const sdk=path.join(root,'work/moddable-sdk-10.1.0');
const expected='906ee9a0cd2a0107a24c714efb10274f3b546afa';
const revision=spawnSync('git',['rev-parse','HEAD'],{cwd:upstream,encoding:'utf8'});
if(revision.status!==0||revision.stdout.trim()!==expected)throw Error('Upstream revision differs from the documented baseline. Review compatibility before building.');
if(!existsSync(path.join(sdk,'build/bin/mac/release/mcrun')))throw Error('Build official Moddable SDK 10.1.0 tools first; see README.');
const result=spawnSync('npm',['run','mod:build','--',path.join(root,'firmware/stackchan-mod/manifest.json'),'--device=m5stackchan_cores3','--mode=release','-f','rgb565be'],{
  cwd:path.join(upstream,'firmware'),stdio:'inherit',env:{...process.env,MODDABLE:sdk,PATH:`${sdk}/build/bin/mac/release:${process.env.PATH}`}
});
if(result.status!==0)process.exit(result.status??1);
// The M5StackChan host (m5stack_cores3 target) draws RGB565BE (Commodetto format 8);
// little-endian assets show shifted colours on the real screen.
const format=readFileSync(path.join(upstream,'firmware/dist/tmp/esp32/release/stackchan-mod/mc.format.h'),'utf8');
if(!/kCommodettoBitmapFormat 8\b/.test(format))throw Error('MOD assets are not RGB565BE (format 8): '+format.trim());
const archive=path.join(upstream,'firmware/dist/bin/esp32/release/stackchan-mod/stackchan-mod.xsa');
const output=path.join(root,'firmware/artifacts');mkdirSync(output,{recursive:true});
copyFileSync(archive,path.join(output,'robottino-portrait.xsa'));
writeFileSync(path.join(output,'THIRD-PARTY-LICENSES.txt'),
  'Stack-chan (Apache-2.0)\n'+readFileSync(path.join(root,'firmware/stackchan-mod/vendor/LICENSE-stack-chan'),'utf8')+
  '\nM5Stack factory dance reference (MIT)\n'+readFileSync(path.join(root,'firmware/stackchan-mod/vendor/LICENSE-m5stack'),'utf8'));
const bytes=readFileSync(archive);
writeFileSync(path.join(output,'build-info.json'),JSON.stringify({builtAt:new Date().toISOString(),stackchanCommit:expected,moddableVersion:'10.1.0',candidateTarget:'m5stackchan_cores3',hardwareCompatibilityVerified:false,flashed:false,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},null,2)+'\n');
console.log('Build complete. No device was written. Hardware and partition compatibility remain unverified.');
