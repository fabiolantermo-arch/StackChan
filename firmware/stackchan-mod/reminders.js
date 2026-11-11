// Spoken timers and Pomodoro kept on the robot: no cloud storage, lost on restart.
const POMODORO={work:25*60000,rest:5*60000,rounds:4};
export function duration(seconds){
  const h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60),s=Math.round(seconds%60),parts=[];
  if(h)parts.push(h===1?'1 ora':h+' ore');if(m)parts.push(m===1?'1 minuto':m+' minuti');if(s&&!h)parts.push(s===1?'1 secondo':s+' secondi');
  return parts.join(' e ')||'0 secondi';
}
export class Reminders {
  constructor(limit=4){this.items=[];this.limit=limit;}
  get active(){return this.items.length>0;}
  /** Applies a parsed spoken command and returns the line to show. */
  apply(command,now){
    if(!Number.isFinite(now))return 'Orologio non valido: timer non disponibili.';
    switch(command?.action){
      case 'set':
        if(this.items.filter(i=>i.kind==='timer').length>=this.limit)return `Ho già ${this.limit} timer attivi: annullali prima.`;
        this.add({at:now+command.seconds*1000,kind:'timer',label:command.label??''});
        return `Timer di ${duration(command.seconds)} impostato${command.label?': '+command.label:''}.`;
      case 'pomodoro':
        this.items=this.items.filter(i=>i.kind!=='pomodoro');this.add({at:now+POMODORO.work,kind:'pomodoro',phase:'work',round:1});
        return 'Pomodoro: 25 minuti di lavoro, poi ti avviso per la pausa.';
      case 'cancel':{const count=this.items.length;this.items=[];return count?'Timer annullati.':'Nessun timer attivo.';}
      case 'status':{
        const next=this.items[0];if(!next)return 'Nessun timer attivo.';
        const left=duration(Math.max(1,Math.ceil((next.at-now)/1000)));
        return next.kind==='pomodoro'?`Pomodoro, ${next.phase==='work'?'lavoro':'pausa'}: mancano ${left}.`:`Mancano ${left}${next.label?' per: '+next.label:''}.`;
      }
      case 'invalid':return 'Posso impostare timer da 10 secondi a 6 ore.';
      default:return null;
    }
  }
  add(item){this.items.push(item);this.items.sort((a,b)=>a.at-b.at);}
  /** Expired items with their alert line; a Pomodoro schedules its next phase. */
  due(now){
    const fired=[];
    while(this.items[0]&&this.items[0].at<=now){
      const item=this.items.shift();
      if(item.kind==='timer'){fired.push({item,text:item.label?'Tempo scaduto: '+item.label+'!':'Tempo scaduto!'});continue;}
      if(item.phase==='work'){
        const last=item.round>=POMODORO.rounds;
        if(!last)this.add({at:item.at+POMODORO.rest,kind:'pomodoro',phase:'rest',round:item.round});
        fired.push({item,text:last?'Pomodoro completato: 4 giri, bravo!':'Pausa! 5 minuti di riposo.'});
      }else{
        this.add({at:item.at+POMODORO.work,kind:'pomodoro',phase:'work',round:item.round+1});
        fired.push({item,text:`Si riparte: giro ${item.round+1} di ${POMODORO.rounds}, 25 minuti.`});
      }
    }
    return fired;
  }
}
