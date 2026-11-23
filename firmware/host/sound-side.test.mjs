// The side a sound comes from (firmware/host/face/sound-side-core.c), built for the Mac and tried on made-up sounds
// whose delay between the two microphones is known. No robot, no microphone.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const face=fileURLToPath(new URL('./face/',import.meta.url));
const folder=mkdtempSync(path.join(tmpdir(),'robottino-sound-'));
const program=path.join(folder,'sound-side');
writeFileSync(path.join(folder,'main.c'),`#include "sound-side-core.h"
#include <stdio.h>
#include <stdlib.h>
int main(void){
  static int16_t samples[2*8192];
  size_t got=fread(samples,4,8192,stdin);
  RobottinoSoundSide side={-1,-1,-1};
  int ok=robottino_sound_side(got?samples:NULL,(int)got,&side);
  printf("%d %d %d %d\\n",ok,side.level,side.lag16,side.quality);
  return 0;
}
`);
const built=spawnSync('cc',['-O2','-Wall','-Werror','-I',face,path.join(face,'sound-side-core.c'),path.join(folder,'main.c'),'-lm','-o',program],{encoding:'utf8'});
process.on('exit',()=>{try{rmSync(folder,{recursive:true,force:true});}catch{}});
const haveCompiler=built.error?.code!=='ENOENT';
const side=pairs=>{
  const bytes=Buffer.alloc(pairs.length*4);pairs.forEach(([a,b],i)=>{bytes.writeInt16LE(a,i*4);bytes.writeInt16LE(b,i*4+2);});
  const [ok,level,lag16,quality]=spawnSync(program,{input:bytes,encoding:'utf8'}).stdout.trim().split(' ').map(Number);
  return {ok,level,lag:lag16/16,quality:quality/255};
};
// The same made-up sounds every run.
const random=seed=>()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296-.5;};
// A sound like a voice, made eight times finer than the microphones sample it, so that it can reach the second
// microphone later than the first by eighths of a sample. delay8 > 0: the second microphone hears it later.
const heard=({frames=1600,delay8=0,loud=3000,own=0,hum=0,offsetA=0,offsetB=0,seed=1}={})=>{
  const noise=random(seed),other=random(seed+99),fine=new Float64Array((frames+40)*8);
  let smooth=0,slow=0;for(let i=0;i<fine.length;i++){smooth+=(noise()-smooth)*.12;slow+=(smooth-slow)*.02;fine[i]=smooth-slow*.5;}
  let peak=0;for(const v of fine)peak=Math.max(peak,Math.abs(v));
  const clip=v=>Math.max(-32768,Math.min(32767,Math.round(v)));
  return Array.from({length:frames},(_,n)=>{
    const at=(n+20)*8,low=hum*Math.sin(n*2*Math.PI*50/16000);
    return [clip(fine[at]/peak*loud+low+other()*own+offsetA),clip(fine[at-delay8]/peak*loud+low+other()*own+offsetB)];
  });
};

test('the C code builds on the Mac with no warnings',{skip:!haveCompiler&&'no C compiler here'},()=>{
  assert.equal(built.status,0,built.stderr);
});
test('a sound that reaches the second microphone later or earlier: the delay is found to a quarter of a sample',{skip:!haveCompiler&&'no C compiler here'},()=>{
  for(const delay8 of [-32,-20,-16,-12,-8,-5,-2,0,2,5,8,12,16,20,32]){
    const found=side(heard({delay8}));
    assert.equal(found.ok,1);assert.ok(Math.abs(found.lag-delay8/8)<=.25,`delay ${delay8/8}: found ${found.lag}`);
    // A delay that falls between two samples reads as a less perfect match (about 0,6 instead of 1): still far from noise (under 0,3).
    assert.ok(found.quality>(delay8%8===0?.9:.55),`delay ${delay8/8}: quality ${found.quality}`);
  }
});
test('the same with each microphone\'s own noise, the mains hum and a steady offset on top',{skip:!haveCompiler&&'no C compiler here'},()=>{
  for(const delay8 of [-16,-8,-4,0,4,8,16])for(const seed of [1,2,3]){
    const found=side(heard({delay8,own:300,hum:1500,offsetA:900,offsetB:-700,seed}));
    assert.ok(Math.abs(found.lag-delay8/8)<=.4,`delay ${delay8/8} seed ${seed}: found ${found.lag}`);
    assert.ok(found.quality>.4);
  }
});
test('a short piece (a clap of 25 ms) is enough',{skip:!haveCompiler&&'no C compiler here'},()=>{
  for(const delay8 of [-12,0,12]){const found=side(heard({frames:400,delay8}));assert.ok(Math.abs(found.lag-delay8/8)<=.3,`found ${found.lag}`);}
});
test('how loud: silence is 0, a steady offset is not a sound, a loud sound is loud',{skip:!haveCompiler&&'no C compiler here'},()=>{
  const silent=side(Array.from({length:1600},()=>[0,0]));assert.deepEqual(silent,{ok:1,level:0,lag:0,quality:0});
  const offset=side(Array.from({length:1600},()=>[1200,-800]));assert.equal(offset.level,0);assert.equal(offset.quality,0);
  const quiet=side(heard({loud:300})),loud=side(heard({loud:12000}));
  assert.ok(quiet.level>20&&quiet.level<300);assert.ok(loud.level>quiet.level*20);
});
test('two microphones that hear different things: the answer says so (low quality)',{skip:!haveCompiler&&'no C compiler here'},()=>{
  const a=heard({seed:5}),b=heard({seed:77}),found=side(a.map(([first],i)=>[first,b[i][1]]));
  assert.ok(found.quality<.3,`quality ${found.quality}`);
});
test('too little to say anything, and more than a quarter of a second: no error either way',{skip:!haveCompiler&&'no C compiler here'},()=>{
  assert.equal(side(heard({frames:20})).ok,0);assert.equal(side([]).ok,0);
  const long=side(heard({frames:8000,delay8:8}));assert.equal(long.ok,1);assert.ok(Math.abs(long.lag-1)<=.25);
});
test('the loudest sounds do not overflow the sums',{skip:!haveCompiler&&'no C compiler here'},()=>{
  const square=Array.from({length:4096},(_,n)=>{const v=(n>>2)%2?32767:-32768,w=((n-1)>>2)%2?32767:-32768;return [v,w];});
  const found=side(square);assert.equal(found.ok,1);assert.ok(Math.abs(found.lag-1)<=.25,`found ${found.lag}`);assert.ok(found.quality>.9);
});
