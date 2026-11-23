// Robottino's log on the microSD card (owner, 14 Nov 2026: «ho installato una scheda micro SD, d'ora in poi usala per
// i registri senza cavo»). Until now what the robot wrote (`trace`) could only be read with the USB cable plugged in,
// and opening the USB port restarts the robot: whatever had gone wrong was gone before it could be read.
//
// - Every line goes to the USB log as before and into a small buffer; the buffer is written to the card every few
//   seconds (flush), in one piece. Nothing is kept beyond BUFFER_BYTES: lines that do not fit are dropped and counted.
// - Files, in the folder `robot` of the card (short 8.3 names): log0.txt is this run, log1.txt the run before, log2.txt
//   the one before that. At every start they move down one place; a file that reaches FILE_BYTES moves down too.
// - At every start the end of the run before (REPLAY_BYTES) is written on the USB log, each line with `[sd] ` in
//   front and never copied to the card again: whoever opens the USB port after a problem reads what happened before
//   the restart that opening it causes. For more than that, the card can be read on a computer.
// - The card is reached only inside the host's own withSDCard (stackchan-sdcard): the card shares a pin with the
//   screen, which the host hands over and takes back around each use. No card, a full card, an error: counted, and
//   after FAILURES_TO_REST in a row the card is left alone for REST_MS. Never an error out of here.
// - No secret may ever be written by the robot on its log (CLAUDE.md): the card holds what the USB log shows.
// Pure of the host: the card, the clock and the text coding are given from mod.js, so the tests run this file on
// the Mac.
export const SD_FOLDER='robot',SD_FILES=['log0.txt','log1.txt','log2.txt'];
export const BUFFER_BYTES=4096,FILE_BYTES=1024*1024,REPLAY_BYTES=32*1024,REPLAY_PIECE=1024,FLUSH_MS=5000,FAILURES_TO_REST=3,REST_MS=60000;
const two=value=>(value<10?'0':'')+value;
// The time of day in front of each line, or the seconds since the start when the clock is not set yet.
export const stamp=(date,sinceStart)=>date&&date.getFullYear()>2024
  ?`${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3,'0')}`
  :`+${(sinceStart/1000).toFixed(1)}s`;
// withCard(operation): runs operation(files) with the card ready (the host's withSDCard), files being the card's root
// (openFile({path, mode}), and with a plain path: status, delete, move, createDirectory). now(): ms. date(): the clock. encode(text) → ArrayBuffer,
// decode(buffer) → text. usb(text): one line on the USB log.
export function createSdLog({withCard,now,date,encode,decode,usb}){
  const path=name=>`${SD_FOLDER}/${name}`;
  let buffer='',dropped=0,failures=0,restUntil=0,flushedAt=0,written=0,size=0,started=false,lastError;
  // The host's status() does not fail for a path that is not there: it gives a status that is neither a file nor
  // a folder. (Taken for «it is there» at first, on 14 Nov 2026: the first card that mounted gave «No such file or
  // directory» when the file of the run before, which was not there, was moved.)
  const exists=(files,name)=>{try{const status=files.status(name);return status.isFile()||status.isDirectory();}catch{return false;}};
  const rotate=files=>{
    if(!exists(files,SD_FOLDER))files.createDirectory(SD_FOLDER); // a path, as status, delete and move; openFile takes {path, mode}
    const [current,previous,oldest]=SD_FILES.map(path);
    if(exists(files,oldest))files.delete(oldest);
    if(exists(files,previous))files.move(previous,oldest);
    if(exists(files,current))files.move(current,previous);
    files.openFile({path:current,mode:'w'}).close();size=0;
  };
  // The end of a file of the card on the USB log, each line with `mark` in front. Piece by piece: the robot's
  // memory is fixed, 32 KB at once would not fit. The first line may be cut.
  const show=(files,name,bytes,mark,title)=>{
    if(!exists(files,name))return false;
    const file=files.openFile({path:name,mode:'r'});
    try{
      const length=file.status().size;let at=Math.max(0,length-bytes),rest='';
      usb(`${mark}${title}: the last ${length-at} of ${length} bytes`);
      while(at<length){
        const count=Math.min(REPLAY_PIECE,length-at),lines=(rest+decode(file.read(count,at))).split('\n');at+=count;
        rest=lines.pop();for(const line of lines)if(line)usb(mark+line);
      }
      if(rest)usb(mark+rest);
      usb(`${mark}end of ${title}`);
    }finally{file.close();}
    return true;
  };
  const failed=error=>{lastError=String(error?.message??error).slice(0,60);failures++;if(failures>=FAILURES_TO_REST){restUntil=now()+REST_MS;failures=0;}};
  return {
    // Once, when Robottino starts: the files move down, and the end of the run before goes to the USB log.
    start(){
      if(started)return false;started=true;
      try{
        withCard(files=>{
          rotate(files);
          show(files,path(SD_FILES[1]),REPLAY_BYTES,'[sd] ','the run before');
        });
        return true;
      }catch(error){failed(error);try{usb(`[robottino] sd log not available: ${lastError}`);}catch{}return false;}
    },
    // The run before the last, whole or its end, on the USB log with `[sd2] ` in front: asked for by hand when the
    // answer to a question is further back than the last run (each time the USB port is opened a new run begins).
    older(bytes=FILE_BYTES){
      try{return withCard(files=>show(files,path(SD_FILES[2]),bytes,'[sd2] ','the run before the last'));}catch(error){failed(error);return false;}
    },
    // One line of the robot's log: kept for the card. (The caller writes it on the USB log itself.)
    line(text){
      const entry=`${stamp(date?.(),now())} ${String(text).replace(/\n+$/,'')}\n`;
      if(buffer.length+entry.length>BUFFER_BYTES){dropped++;return;}
      buffer+=entry;
    },
    // Called from the robot's cycle: writes what is waiting, every FLUSH_MS (or at once with force).
    flush(force=false){
      const time=now();
      if(!started||!buffer||time<restUntil||(!force&&time-flushedAt<FLUSH_MS))return false;
      flushedAt=time;
      const text=(dropped?`${stamp(date?.(),time)} [robottino] sd log: ${dropped} lines dropped\n`:'')+buffer;
      try{
        withCard(files=>{
          if(size>=FILE_BYTES)rotate(files);
          const bytes=encode(text),file=files.openFile({path:path(SD_FILES[0]),mode:'r+'});
          try{const at=file.status().size;file.write(bytes,at);size=at+bytes.byteLength;}finally{file.close();}
        });
        written+=text.length;buffer='';dropped=0;failures=0;return true;
      }catch(error){
        // What could not be written stays for the next try, as long as it fits; the card may be back in a minute.
        failed(error);return false;
      }
    },
    get waiting(){return buffer.length;},
    get written(){return written;},
    get resting(){return now()<restUntil;},
    get error(){return lastError;}
  };
}
