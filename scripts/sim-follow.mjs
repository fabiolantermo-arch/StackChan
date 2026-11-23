// Builds the «Inseguimento con rover e testa» simulation page (owner, 15 Nov 2026: «fai simulazione al mac di
// inseguimento rover/testa») with the robot's own rover-follow.js inside it, so the page decides exactly as the MOD.
// Usage: node scripts/sim-follow.mjs <output.html>
import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const follow=(await readFile(new URL('firmware/stackchan-mod/rover-follow.js',root),'utf8')).replace(/^export /gm,'');
// The pretend world, the same file the measurements use (rover-follow.test.mjs).
const world=(await readFile(new URL('scripts/sim-follow-world.js',root),'utf8')).replace(/^export /gm,'');
const page=(await readFile(new URL('scripts/sim-follow-template.html',root),'utf8')).replace('/*ROVER_FOLLOW*/',()=>follow).replace('/*WORLD*/',()=>world);
const out=process.argv[2];if(!out)throw Error('usage: node scripts/sim-follow.mjs <output.html>');
await writeFile(out,page);console.log(`written ${out} (${page.length} bytes)`);
