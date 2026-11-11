// Raises a WAV PCM16 file so its peak is -1 dBFS (pure gain, no clipping or compression).
// The K151 host plays MOD sounds at its own volume (50% by default), so quiet files are
// almost inaudible. Running it again leaves the file unchanged. Usage: node normalize-audio.mjs assets/x.bin
import {readFile,writeFile} from 'node:fs/promises';
const file=process.argv[2];if(!file)throw Error('usage: node normalize-audio.mjs <wav>');
const bytes=await readFile(file);
if(bytes.toString('latin1',0,4)!=='RIFF'||bytes.readUInt16LE(20)!==1||bytes.readUInt16LE(34)!==16)throw Error('PCM16 WAV required');
let offset=12,data;
while(offset+8<=bytes.length){const id=bytes.toString('latin1',offset,offset+4),size=bytes.readUInt32LE(offset+4);if(id==='data'){data={start:offset+8,end:offset+8+size};break;}offset+=8+size+(size&1);}
if(!data)throw Error('no data chunk');
let peak=0;for(let i=data.start;i+1<data.end;i+=2)peak=Math.max(peak,Math.abs(bytes.readInt16LE(i)));
const target=Math.round(32767*10**(-1/20)),gain=peak?target/peak:1;
if(Math.abs(gain-1)<.01){console.log(`${file}: already at -1 dBFS`);process.exit(0);}
for(let i=data.start;i+1<data.end;i+=2)bytes.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(bytes.readInt16LE(i)*gain))),i);
await writeFile(file,bytes);
console.log(`${file}: gain ${(20*Math.log10(gain)).toFixed(1)} dB, peak -1.0 dBFS`);
