// The log on the microSD card, against a pretend card. No robot, no card.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSdLog,stamp,SD_FOLDER,SD_FILES,BUFFER_BYTES,FILE_BYTES,REPLAY_BYTES,FLUSH_MS,FAILURES_TO_REST,REST_MS} from './sd-log.js';

// A card as the host gives it: a root with files and folders by path, and files read and written at a position.
const fakeCard=()=>{
  const files=new Map(),folders=new Set(),calls=[];let inside=0,fail;
  const missing=path=>{const error=Error('not found: '+path);throw error;};
  // As the host's files (files-vfs.c): status of a path that is not there does not fail, it is neither file nor
  // folder; createDirectory, status, delete and move take a plain path; deleting what is not there says false.
  const root={
    status(path){assert.equal(typeof path,'string');return {isFile:()=>files.has(path),isDirectory:()=>folders.has(path),size:files.get(path)?.length??0};},
    createDirectory(path){assert.equal(typeof path,'string','a path, not {path}');folders.add(path);return true;},
    delete(path){assert.equal(typeof path,'string');return files.delete(path);},
    move(from,to){if(!files.has(from))missing(from);files.set(to,files.get(from));files.delete(from);},
    openFile({path,mode}){
      assert.equal(inside,1,'the card is used only inside withCard');
      if(mode==='w')files.set(path,new Uint8Array(0));else if(!files.has(path))missing(path);
      let open=true;
      return {
        status:()=>({size:files.get(path).length}),
        read(count,position){assert.ok(open);return files.get(path).slice(position,position+count).buffer;},
        write(buffer,position){assert.ok(open);assert.notEqual(mode,'r');const old=files.get(path),bytes=new Uint8Array(buffer),next=new Uint8Array(Math.max(old.length,position+bytes.length));next.set(old);next.set(bytes,position);files.set(path,next);},
        close(){open=false;calls.push('close');}
      };
    }
  };
  const withCard=operation=>{if(fail)throw Error(fail);inside++;calls.push('begin');try{return operation(root);}finally{inside--;calls.push('end');}};
  const text=name=>new TextDecoder().decode(files.get(`${SD_FOLDER}/${name}`)??new Uint8Array(0));
  return {withCard,files,folders,calls,text,failWith(reason){fail=reason;},put(name,content){folders.add(SD_FOLDER);files.set(`${SD_FOLDER}/${name}`,new TextEncoder().encode(content));}};
};
const robot=(card=fakeCard(),{clock=new Date(2026,10,14,14,45,3,7)}={})=>{
  const usb=[];let time=0;
  const log=createSdLog({withCard:card.withCard,now:()=>time,date:()=>clock,encode:text=>new TextEncoder().encode(text).buffer,decode:buffer=>new TextDecoder().decode(buffer),usb:line=>usb.push(line)});
  return {card,usb,log,at:ms=>{time=ms;}};
};

test('the time in front of each line: the clock when it is set, seconds since the start before that',()=>{
  assert.equal(stamp(new Date(2026,10,14,9,5,7,42),123456),'09:05:07.042');
  assert.equal(stamp(new Date(1970,0,1,0,0,5),12340),'+12.3s','the clock has not been set by the network yet');
  assert.equal(stamp(undefined,500),'+0.5s');
});
test('a first start on an empty card: the folder and this run\'s file are made, nothing to show from before',()=>{
  const r=robot();assert.equal(r.log.start(),true);
  assert.ok(r.card.folders.has(SD_FOLDER));assert.equal(r.card.text('log0.txt'),'');assert.deepEqual(r.usb,[]);
  assert.equal(r.log.start(),false,'only once');
});
test('lines are written to the card every few seconds, in one piece, each with its time',()=>{
  const r=robot();r.log.start();
  r.log.line('[robottino] motion held\n');r.log.line('[robottino] motion down');
  assert.equal(r.card.text('log0.txt'),'','not at once');
  r.at(FLUSH_MS-1);assert.equal(r.log.flush(),false);
  r.at(FLUSH_MS);assert.equal(r.log.flush(),true);
  assert.equal(r.card.text('log0.txt'),'14:45:03.007 [robottino] motion held\n14:45:03.007 [robottino] motion down\n');
  r.log.line('third');r.at(2*FLUSH_MS);r.log.flush();
  assert.match(r.card.text('log0.txt'),/motion down\n14:45:03\.007 third\n$/,'added at the end');
  assert.equal(r.log.waiting,0);
});
test('with force the lines are written at once (when Robottino is closed)',()=>{
  const r=robot();r.log.start();r.log.line('last words');assert.equal(r.log.flush(true),true);
  assert.match(r.card.text('log0.txt'),/last words\n$/);
  assert.equal(r.log.flush(true),false,'nothing waiting: the card is not touched');
});
test('at every start the files move down one place and the end of the run before is shown on the USB log',()=>{
  const card=fakeCard();card.put('log0.txt','14:00:01.000 first\n14:00:02.000 second\n');card.put('log1.txt','older\n');card.put('log2.txt','oldest\n');
  const r=robot(card);r.log.start();
  assert.equal(card.text('log2.txt'),'older\n','the run before the last is kept, the oldest is gone');
  assert.equal(card.text('log1.txt'),'14:00:01.000 first\n14:00:02.000 second\n');assert.equal(card.text('log0.txt'),'');
  assert.deepEqual(r.usb,['[sd] the run before: the last 39 of 39 bytes','[sd] 14:00:01.000 first','[sd] 14:00:02.000 second','[sd] end of the run before']);
  // What is shown from the card is not written to the card again.
  r.at(FLUSH_MS);r.log.flush();assert.equal(card.text('log0.txt'),'');
});
test('a long run before: only its end is shown, read in small pieces (the robot\'s memory is fixed)',()=>{
  const card=fakeCard();let long='';for(let i=0;i<4000;i++)long+=`14:00:00.000 line number ${i}\n`;
  card.put('log0.txt',long);
  const reads=[],withCard=operation=>card.withCard(root=>operation({...root,status:root.status,openFile(options){const file=root.openFile(options);return {...file,read(count,position){reads.push(count);return file.read(count,position);}};}}));
  const usb=[],log=createSdLog({withCard,now:()=>0,date:()=>new Date(2026,10,14),encode:text=>new TextEncoder().encode(text).buffer,decode:buffer=>new TextDecoder().decode(buffer),usb:line=>usb.push(line)});
  log.start();
  assert.ok(Math.max(...reads)<=1024,'never more than a kilobyte at a time');assert.equal(reads.reduce((a,b)=>a+b,0),REPLAY_BYTES);
  assert.equal(usb.at(-1),'[sd] end of the run before');assert.equal(usb.at(-2),'[sd] 14:00:00.000 line number 3999','up to the very last line');
  const shown=usb.filter(line=>/line number/.test(line));assert.ok(shown.length>1000&&shown.length<1400,`${shown.length} lines`);
  assert.ok(shown.slice(1).every(line=>/^\[sd\] 14:00:00\.000 line number \d+$/.test(line)),'whole lines, none joined or cut (but the first)');
});
test('more lines than the buffer holds: the extra ones are dropped and the log says how many',()=>{
  const r=robot();r.log.start();
  const line='x'.repeat(100);let n=0;while(r.log.waiting+114<=BUFFER_BYTES){r.log.line(line);n++;}
  for(let i=0;i<7;i++)r.log.line(line);
  assert.ok(r.log.waiting<=BUFFER_BYTES);
  r.at(FLUSH_MS);r.log.flush();
  const text=r.card.text('log0.txt');assert.match(text,/^14:45:03\.007 \[robottino\] sd log: 7 lines dropped\n/);
  assert.equal(text.split('\n').filter(l=>l.endsWith(line)).length,n);
});
test('no card: said once on the USB log, no error leaves, and the card is left alone for a minute after three failures',()=>{
  const card=fakeCard();card.failWith('no card');const r=robot(card);
  assert.doesNotThrow(()=>r.log.start());assert.deepEqual(r.usb,['[robottino] sd log not available: no card']);
  r.log.line('one');
  for(let i=1;i<=FAILURES_TO_REST;i++){r.at(i*FLUSH_MS);assert.equal(r.log.flush(),false);}
  assert.equal(r.log.resting,true);const begins=card.calls.length;
  r.at(FAILURES_TO_REST*FLUSH_MS+REST_MS-1);r.log.flush();assert.equal(card.calls.length,begins,'not tried while resting');
  assert.equal(r.log.waiting>0,true,'the line is still waiting');assert.equal(r.log.error,'no card');
});
test('a card that comes back: what was waiting is written',()=>{
  const card=fakeCard(),r=robot(card);r.log.start();
  card.failWith('write failed');r.log.line('kept');r.at(FLUSH_MS);assert.equal(r.log.flush(),false);
  card.failWith(undefined);r.at(2*FLUSH_MS);assert.equal(r.log.flush(),true);
  assert.match(card.text('log0.txt'),/kept\n$/);
});
test('the pin the card shares with the screen is always given back: every use ends, also when it fails inside',()=>{
  const card=fakeCard(),r=robot(card);r.log.start();r.log.line('a');
  // The file of this run disappears (card changed): the write fails inside withCard.
  card.files.delete(`${SD_FOLDER}/log0.txt`);r.at(FLUSH_MS);assert.equal(r.log.flush(),false);
  assert.equal(card.calls.filter(c=>c==='begin').length,card.calls.filter(c=>c==='end').length);
});
test('a file that has grown to its limit moves down a place and a new one begins',()=>{
  const card=fakeCard(),r=robot(card);r.log.start();
  card.put('log0.txt','y'.repeat(FILE_BYTES-10));
  r.log.line('fills it');r.at(FLUSH_MS);r.log.flush();
  assert.ok(card.files.get(`${SD_FOLDER}/log0.txt`).length>=FILE_BYTES);
  r.log.line('into the new file');r.at(2*FLUSH_MS);r.log.flush();
  assert.equal(card.text('log0.txt'),'14:45:03.007 into the new file\n');assert.ok(card.files.get(`${SD_FOLDER}/log1.txt`).length>=FILE_BYTES);
});
test('short file names in one folder, so any card will take them',()=>{
  for(const name of [SD_FOLDER,...SD_FILES])assert.match(name,/^[a-z0-9]{1,8}(\.[a-z0-9]{1,3})?$/);
});

test('the run before the last can be shown too, when asked: whole, with its own mark',()=>{
  const card=fakeCard();card.put('log0.txt','last run\n');card.put('log1.txt','the one before\nwith two lines\n');
  const r=robot(card);r.log.start();r.usb.length=0;
  assert.equal(r.log.older(),true);
  assert.deepEqual(r.usb,['[sd2] the run before the last: the last 30 of 30 bytes','[sd2] the one before','[sd2] with two lines','[sd2] end of the run before the last']);
  const none=robot();none.log.start();assert.equal(none.log.older(),false,'nothing that old on the card');
});
