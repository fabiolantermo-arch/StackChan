// Mechanical slicing/resizing only; source illustration generated with built-in ImageGen.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PORTRAIT_FRAMES} from './portrait-state.js';
const assets=fileURLToPath(new URL('./assets/',import.meta.url));
for(const [index,name] of PORTRAIT_FRAMES.entries()){
  const output=`${assets}girl-${name}.png`;
  for(const args of [
    ['--cropToHeightWidth','384','512','--cropOffset',String(Math.floor(index/3)*512+48),String(index%3*512),`${assets}girl-atlas-source.png`,'--out',output],
    ['--resampleHeightWidth','240','320',output,'--out',output],
  ]){const result=spawnSync('sips',args,{stdio:'pipe'});if(result.status!==0)throw Error(result.stderr.toString());}
}
console.log('Prepared six 320×240 portraits. No firmware or cloud changes.');
