// Generates assets/avviso.bin: a short three-note chime, WAV PCM16 mono 16 kHz (same format as the laugh).
// Peak about -1 dBFS: the K151 host plays MOD sounds at its own volume (50% by default).
import {writeFile} from 'node:fs/promises';
const rate=16000,notes=[[880,.16],[1175,.16],[1568,.32]],gap=.04,samples=[];
for(let round=0;round<2;round++){
  for(const [frequency,length] of notes){
    for(let i=0;i<rate*length;i++){const t=i/rate,envelope=Math.min(1,t/.01)*Math.exp(-t*6);samples.push(Math.round(Math.sin(2*Math.PI*frequency*t)*envelope*30700));}
    for(let i=0;i<rate*gap;i++)samples.push(0);
  }
  for(let i=0;i<rate*.25;i++)samples.push(0);
}
const data=Buffer.alloc(samples.length*2);samples.forEach((v,i)=>data.writeInt16LE(v,i*2));
const header=Buffer.alloc(44);
header.write('RIFF',0);header.writeUInt32LE(36+data.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);
header.writeUInt32LE(rate,24);header.writeUInt32LE(rate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(data.length,40);
await writeFile(new URL('./assets/avviso.bin',import.meta.url),Buffer.concat([header,data]));
console.log(`assets/avviso.bin: ${(samples.length/rate).toFixed(2)} s`);
