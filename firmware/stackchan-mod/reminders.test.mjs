// Spoken timers, Pomodoro and reply mood: pure logic, no robot needed.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Reminders,ClockReminders,duration,LATE_MS} from './reminders.js';
import {voiceWire} from './voice-device.test.mjs';
// Values from the vm sandbox have another realm's prototypes: compare plain copies.
const same=(actual,expected,message)=>assert.deepEqual(JSON.parse(JSON.stringify(actual)),expected,message);
test('spoken timers are understood in everyday Italian and never as memories',async()=>{
  const {timerCommand,isMemoryPhrase}=await voiceWire();
  same(timerCommand('Robottino, ricordami tra 10 minuti di chiamare la mamma.'),{action:'set',seconds:600,label:'chiamare la mamma'});
  same(timerCommand('Metti un timer di cinque minuti'),{action:'set',seconds:300,label:''});
  assert.equal(timerCommand('Svegliami tra mezz’ora').seconds,1800);
  assert.equal(timerCommand('Ricordami tra un’ora e mezza').seconds,5400);
  assert.equal(timerCommand('Timer di 1 ora e 20 minuti').seconds,4800);
  same(timerCommand('Facciamo un pomodoro'),{action:'pomodoro'});
  same(timerCommand('Annulla il timer'),{action:'cancel'});
  same(timerCommand('Quanto manca?'),{action:'status'});
  same(timerCommand('timer di 2 secondi'),{action:'invalid'});
  assert.equal(timerCommand('Ricordami che mi piace il mare'),null,'no time: not a timer');
  assert.equal(timerCommand('Che ore sono?'),null);
  assert.equal(isMemoryPhrase('ricordami tra 10 minuti'),true,'the device checks timers before memories');
});
test('reply mood picks face and one head gesture from the words',async()=>{
  const {replyMood,BargeIn}=await voiceWire();
  same(replyMood('Sì, certo!'),{expression:'neutral',gesture:'nod'});
  same(replyMood('Ahahah, che ridere'),{expression:'happy',gesture:null});
  same(replyMood('Ciao! Che bello vederti'),{expression:'neutral',gesture:null});
  same(replyMood('Hahaha'),{expression:'happy',gesture:null});
  same(replyMood('Mi dispiace, non lo trovo.'),{expression:'sad',gesture:null});
  same(replyMood('Mi dispiace, non lo trovo. Però posso cercarlo sul web'),{expression:'neutral',gesture:null});
  same(replyMood('Sì, mi dispiace. Ti spiego'),{expression:'neutral',gesture:'nod'});
  same(replyMood('No, non credo.'),{expression:'neutral',gesture:'shake'});
  same(replyMood('Mi dispiace, non posso.'),{expression:'sad',gesture:null});
  same(replyMood('Come ti chiami?'),{expression:'neutral',gesture:'tilt'});
  assert.equal(replyMood(''),null);
  const barge=new BargeIn(6000,300);assert.equal(barge.feed(9000,100),false);assert.equal(barge.feed(9000,100),false);assert.equal(barge.feed(2000,100),false,'a dip restarts the count');
  assert.equal([barge.feed(9000,100),barge.feed(9000,100),barge.feed(9000,100)].at(-1),true);
  assert.equal(new BargeIn(0).feed(30000,1000),false,'level 0 disables voice interruption');
});
test('timers fire once, report time left and are limited',()=>{
  const r=new Reminders(2);
  assert.equal(r.apply({action:'set',seconds:600,label:'pasta'},0),'Timer di 10 minuti impostato: pasta.');
  assert.equal(r.apply({action:'status'},60000),'Mancano 9 minuti per: pasta.');
  r.apply({action:'set',seconds:30,label:''},0);
  assert.match(r.apply({action:'set',seconds:30,label:''},0),/già 2 timer/);
  assert.deepEqual(r.due(30000).map(f=>f.text),['Tempo scaduto!']);
  assert.deepEqual(r.due(600000).map(f=>f.text),['Tempo scaduto: pasta!']);assert.equal(r.due(700000).length,0);
  assert.equal(r.apply({action:'cancel'},0),'Nessun timer attivo.');
  assert.equal(r.apply({action:'set',seconds:5},NaN),'Orologio non valido: timer non disponibili.');
  assert.equal(duration(4800),'1 ora e 20 minuti');assert.equal(duration(90),'1 minuto e 30 secondi');
});
test('Pomodoro alternates 25 minutes of work and 5 of rest for 4 rounds, and can be cancelled',()=>{
  const r=new Reminders(),texts=[];r.apply({action:'pomodoro'},0);
  for(let t=0;t<=4*30*60000;t+=60000)for(const f of r.due(t))texts.push(f.text);
  assert.equal(texts.length,7);assert.equal(texts[0],'Pausa! 5 minuti di riposo.');assert.match(texts[1],/giro 2 di 4/);assert.match(texts.at(-1),/completato/);
  assert.equal(r.active,false);
  r.apply({action:'pomodoro'},0);assert.match(r.apply({action:'status'},60000),/lavoro: mancano 24 minuti/);assert.equal(r.apply({action:'cancel'},0),'Timer annullati.');
});
test('spoken head commands: a movement verb and a direction, «spostati», «muovi la testa», «girati» (11 Nov 2026)',async()=>{
  const {headCommand,timerCommand}=await voiceWire();
  const d=text=>headCommand(text)?.direction??null;
  assert.equal(d('Guarda a destra'),'right');assert.equal(d('Robottino, girati a sinistra.'),'left');
  assert.equal(d('Muoviti a destra'),'right');assert.equal(d('muovi la testa a sinistra'),'left');
  assert.equal(d('Guarda in alto'),'up');assert.equal(d('Alza la testa'),'up');assert.equal(d('guarda su'),'up');
  assert.equal(d('Guarda in basso'),'down');assert.equal(d('Abbassa la testa'),'down');assert.equal(d('Gira la testa a destra'),'right');assert.equal(d('Gira la testa a sinistra'),'left');assert.equal(d('Alza la testa.'),'up');assert.equal(d('Abbassa la testa.'),'down');assert.equal(d('guarda giù'),'down');
  assert.equal(d('Guarda avanti'),'center');assert.equal(d('girati verso di me'),'center');assert.equal(d('Muovi la testa'),'shake');assert.equal(d('Spostati in alto'),'up');assert.equal(d('Sposta la testa a destra'),'right');assert.equal(d('Girati in basso'),'down');
  assert.equal(d('A destra.'),'right','a direction alone, as a follow-up');assert.equal(d('Più in alto'),'up');assert.equal(d('ancora a sinistra'),'left');assert.equal(d('Guarda alto'),'up');assert.equal(d('guarda basso'),'down');
  assert.equal(d('Destra'),'right','the word alone');assert.equal(d('basso'),'down');assert.equal(d('Alto!'),'up');
  same(headCommand('Tutto a destra'),{direction:'right',full:true});same(headCommand('tutto in alto'),{direction:'up',full:true});same(headCommand('Guarda a sinistra'),{direction:'left'});assert.equal(d('Su questo hai ragione'),null);
  // 11 Nov 2026: «sinistra» came as «Sinis-- destra.»: the first direction said wins, a word cut short counts.
  assert.equal(d('Sinis-- destra.'),'left');assert.equal(d('Destra, anzi sinistra'),'right');assert.equal(d('Sinis'),'left');
  assert.equal(d('Finestra.'),'left','what the recognizer makes of «sinistra», in a very short sentence');assert.equal(d('Apri la finestra della cucina'),null);
  assert.equal(d('Tu.'),'up','«su» as the recognizer wrote it');assert.equal(d('Tu come stai?'),null);assert.equal(d('Sù.'),'up');assert.equal(d('Insù'),'up');assert.equal(d('In sù!'),'up');assert.equal(d('Su.'),'up');
  assert.equal(d('Non guardare a destra'),null,'negated');assert.equal(d('Guarda che domani piove'),null,'no direction');
  
  assert.equal(d('Ieri sono andato in centro e poi ho girato a destra per vedere il mare'),null,'a long sentence is a story');
  assert.equal(d('Che ore sono?'),null);assert.equal(timerCommand('Guarda a destra'),null,'never a timer');
});

test('«cos’è questo?»: short questions about what is in front of the robot ask for a picture (11 Nov 2026)',async()=>{
  const {seeCommand,headCommand,faceCommand}=await voiceWire();
  for(const text of ["Cos'è questo?",'Cos’è questo?','Che cos\'è questo?','Cosa è questo','Cosa vedi?','Che cosa vedi adesso?','Cosa ho in mano?','Robottino, cos\'è quello?','Che oggetto è?','Guarda cosa ho in mano','Dimmi cos\'è','Sai cos\'è questo?','Cosa ti sto mostrando?','Questo?','E questo?','Quello qui?','Questo cos\'è?','E questo che cos\'è?','Cos\'è?','Dimmi cos\'è questo.','Quello cosa è?'])assert.equal(seeCommand(text),true,text);
  for(const text of ['Cosa fai?','Cos\'è la fotosintesi?','Che tempo fa?','Guarda a destra','Sorridi','Ieri ho visto un film e non so dirti cos\'è questo sentimento che provo','Cosa ne pensi?','Questo è bello','Voglio questo',''])assert.equal(seeCommand(text),false,text);
  assert.equal(headCommand("Cos'è questo?"),null);assert.equal(faceCommand('Cosa vedi?'),null);
});
test('spoken face commands: smile, sad and angry face, short and never negated (11 Nov 2026)',async()=>{
  const {faceCommand,headCommand,timerCommand}=await voiceWire();
  const e=text=>faceCommand(text)?.expression??null;
  assert.equal(e('Sorridi'),'happy');assert.equal(e('Robottino, fammi un sorriso.'),'happy');assert.equal(e('Fai la faccia felice'),'happy');
  assert.equal(e('Fai la faccia triste'),'sad');assert.equal(e('faccia triste'),'sad');
  assert.equal(e('Fai la faccia arrabbiata'),'angry');assert.equal(e('Arrabbiati!'),'angry');
  assert.equal(e('Non sorridere'),null,'negated');assert.equal(e('Ieri la mia amica aveva una faccia triste per tutta la sera perché pioveva'),null,'a long sentence is a story');
  assert.equal(e("C'è triste."),'sad','the feeling alone, in a very short sentence');assert.equal(e('Arrabbiata!'),'angry');
  assert.equal(e('Torna felice'),'happy','back from sad or angry');assert.equal(e('Adesso torna allegra.'),'happy');assert.equal(e('Torna normale'),'normal');assert.equal(e('Non essere più triste'),'normal');assert.equal(e('Basta fare la faccia arrabbiata'),'normal');assert.equal(e('Calmati.'),'normal');
  assert.equal(e('Non fare la faccia arrabbiata'),'normal');assert.equal(e('Non sorridere'),null);
  assert.equal(e('Rabbiata.'),'angry','11 Nov 2026: the first syllable lost');assert.equal(e('Faccia arrabiata'),'angry');assert.equal(e('Rabbia!'),'angry');assert.equal(e('Ho tanta rabbia oggi per il lavoro'),null);assert.equal(e('Oggi sono molto triste per il lavoro'),null,'a longer sentence about a sad day is not a command');
  assert.equal(e('Guarda a destra'),null);assert.equal(headCommand('Sorridi'),null);assert.equal(timerCommand('Sorridi'),null);
});

test('the feeling Robottino says it has in its reply, in Italian and English; «voce» asks for the face too (12 Nov 2026)',async()=>{
  const {replyFaceCommand,faceCommand}=await voiceWire();
  const r=text=>replyFaceCommand(text)?.expression??null,e=text=>faceCommand(text)?.expression??null;
  for(const [text,expression] of [['Grrr, adesso sono proprio arrabbiata!','angry'],['Grrr, adesso sono proprio arrabbiato! Non si dicono certe parole!','angry'],['Grrr, adesso sono proprio arrabbiata!...','angry'],['Uffa, adesso sono davvero arrabbiata!','angry'],['Grrr, now I am really angry!','angry'],['Grr! I\'m so mad right now!','angry'],
    ['Oh no… che tristezza.','sad'],['Oh no… che tristezza....','sad'],['Oh no… that is so sad.','sad'],['Oh no... how sad.','sad'],['Adesso sono tanto triste.','sad'],['I am so sad now.','sad'],
    ['Ecco, sono tornata felice! Come posso aiutarti ora?','happy'],['Okay, I\'m happy again!','happy'],['Va bene, sono tornato normale.','normal'],['Ecco, mi sono calmata.','normal'],['Okay, back to normal!','normal'],['Alright, I have calmed down.','normal'],['Non sono più arrabbiata, promesso.','normal']])assert.equal(r(text),expression,text);
  for(const text of ['No, non sono arrabbiata, sto benissimo!','Non sono triste, tranquillo.','I am not angry at all.','Uff, oggi ci sono dieci gradi.','Ecco.','Fammi vedere…','Mi dispiace, purtroppo non posso.','Oh no, che tristezza, mi dispiace tanto per il tuo gatto. Vuoi raccontarmi come sta adesso?','That is so sad to hear, I am sorry about your cat and I hope it gets better soon.','C’era una volta una principessa che viveva in un castello lontano lontano, e un giorno disse al drago: sono arrabbiata con te!','Sto controllando il meteo per oggi, dammi un attimo.',''])assert.equal(r(text),null,text);
  // 11 Nov 2026, 18:17: «Fai la voce arrabbiata.» changed the voice and not the face.
  assert.equal(e('Fai la voce arrabbiata.'),'angry');assert.equal(e('Fai la voce triste'),'sad');assert.equal(e('Angry voice'),'angry');assert.equal(e('Make a sad voice'),'sad');assert.equal(e('Che bella voce che hai oggi, mi piace molto'),null);
  // «basta» is a way back for the voice (HEAD_RULE): the face must go back with it.
  assert.equal(e('Basta.'),'normal');assert.equal(e('Ok, basta.'),'normal');assert.equal(e('Adesso basta'),'normal');assert.equal(e('Basta poco per essere felici in questa vita'),null);
});

test('the same commands in English: head, faces and «what is this?», never from everyday sayings (11 Nov 2026)',async()=>{
  const {headCommand,faceCommand,seeCommand,replyHeadCommand,replySee,timerCommand}=await voiceWire();
  const d=text=>headCommand(text)?.direction??null,e=text=>faceCommand(text)?.expression??null;
  for(const [text,direction] of [['Right.','right'],['Left','left'],['Up','up'],['Down.','down'],['Look right','right'],['Turn left please','left'],['Look to the right','right'],['Go up a bit','up'],['Head down','down'],['Look up','up'],['Raise your head','up'],['Lower your head','down'],['Look ahead','center'],['Look at me','center'],['Center','center'],['Straight ahead','center'],['Shake your head','shake'],['Turn left, no, right','left']])assert.equal(d(text),direction,text);
  same(headCommand('All the way up'),{direction:'up',full:true});same(headCommand('Turn all the way to the left'),{direction:'left',full:true});same(headCommand('Look right'),{direction:'right'});
  for(const text of ['All right','That\'s right','What\'s up?','Calm down','Sit down','You\'re right about that','Don\'t look right','I left my keys at home','The weather is going down this week','Right now I am busy','Is that the right answer for you'])assert.equal(d(text),null,text);
  for(const [text,expression] of [['Smile','happy'],['Give me a smile','happy'],['Happy face','happy'],['Make a sad face','sad'],['Sad face','sad'],['Be sad','sad'],['Angry face','angry'],['Make an angry face','angry'],['Get angry','angry'],['Angry!','angry'],['Sad.','sad'],['Be happy again','happy'],['Back to happy','happy'],['Back to normal','normal'],['Calm down','normal'],['Stop being angry','normal'],['Don\'t be sad','normal'],['Normal face','normal']])assert.equal(e(text),expression,text);
  for(const text of ['Don\'t smile','I was sad yesterday because of work','What makes people angry in the morning','Look right'])assert.equal(e(text),null,text);
  for(const text of ['What is this?','What\'s this?','What\'s that?','What is it?','What are these?','What do you see?','What can you see?','What am I holding?','What\'s in my hand?','This?','And this?','Tell me what this is','Do you know what this is?','Look at this','Can you see this?','What object is this?'])assert.equal(seeCommand(text),true,text);
  for(const text of ['What is the capital of France?','What do you think?','What is this song about anyway','This is nice','See you later','What time is it?'])assert.equal(seeCommand(text),false,text);
  same(replyHeadCommand('Okay, I\'ve turned my head to the left.'),{direction:'left'});same(replyHeadCommand('Looking up now.'),{direction:'up'});assert.equal(replyHeadCommand('I can\'t turn my head to the right.'),null);
  assert.equal(replySee('Let me see…'),true);assert.equal(replySee('Let me take a look.'),true);assert.equal(replySee('Let me know.'),false);assert.equal(replySee('Let me check that for you.'),false,'said for anything: no picture');assert.equal(replySee('Let me check the connection for you.'),false);
  // Owner, 13 Nov 2026: «gli sto chiedendo il meteo per domani e mi dice vedo un ambiente interno». The picture is
  // taken only when looking is the whole reply; a search announced with the same words takes none.
  for(const text of ['Fammi vedere…','Fammi vedere.','Fammi vedere meglio…','Ok, fammi vedere…','Fammi guardare.','Fammi dare un\'occhiata…','Guardo subito.','Do un\'occhiata.','Fammi vedere cos\'è.','Fammi vedere che cos’è…','Fammi vedere cosa hai in mano.','Fammi vedere questo oggetto.','Aspetta, fammi vedere un attimo…','Let me see.','Okay, let me take a look…','Let me have a look at it.','Let me see what you\'re holding.','I\'ll take a look.'])assert.equal(replySee(text),true,text);
  for(const text of ['Fammi vedere... Aspetta un attimo, controllo subito il meteo per Roma.','Controllo subito le previsioni meteo per domani a Roma. Un attimo.','Controllo subito.','Fammi vedere il meteo.','Fammi vedere cosa dice il meteo per domani.','Fammi vedere che tempo fa a Roma.','Fammi vedere… ho girato la testa a destra.','Guardo subito le notizie di oggi.','Do un\'occhiata alle previsioni.','Vedo un ambiente interno, ma non si distingue nessun oggetto in particolare.','Let me see what the weather is like tomorrow.','Let me look that up for you.','Let me see if I can find the forecast.','I\'ll take a look at the news.'])assert.equal(replySee(text),false,text);
  // Italian is untouched, and a timer in either language still comes first where it did.
  assert.equal(d('Destra'),'right');assert.equal(e('Fai la faccia triste'),'sad');assert.equal(seeCommand("Cos'è questo?"),true);assert.equal(d('Tu.'),'up');
});

test('reminders at a clock time: kept across a restart, said once at their minute, a missed one still said if recent (14 Nov 2026)',()=>{
  const now=Date.UTC(2026,10,14,17,0),at=Date.UTC(2026,10,15,8,0);
  const list=new ClockReminders();
  assert.equal(list.add(at,'pane',0),'clock','no time from the network yet');
  assert.equal(list.add(now-1000,'ieri',now),'past');
  assert.equal(list.add(at,'pane',now),'ok');assert.equal(list.add(at+30000,'latte',now),'ok','the same minute replaces it');
  assert.deepEqual(list.list,[{at:at+30000,text:'latte'}]);
  for(let i=1;i<8;i++)assert.equal(list.add(at+i*3600000,'cosa '+i,now),'ok');
  assert.equal(list.add(at+99*3600000,'troppi',now),'full');
  const again=new ClockReminders(list.save());assert.deepEqual(again.list,list.list,'saved and read back');
  assert.deepEqual(again.due(at-1000),[]);
  assert.deepEqual(again.due(at+30000).map(f=>f.text),['Promemoria: latte']);assert.deepEqual(again.due(at+30000),[],'once');
  assert.equal(again.cancel(at+3600000+5000),1);assert.equal(again.cancel(at+3600000),0);
  // Off for a while: a reminder missed by less than LATE_MS is said, an older one goes silently.
  const late=again.due(at+2.5*3600000+LATE_MS);
  assert.deepEqual(late.map(f=>f.text),['Promemoria: cosa 3','Promemoria: cosa 4','Promemoria: cosa 5','Promemoria: cosa 6','Promemoria: cosa 7'],'«cosa 2», 6.5 h late, is not said');
  assert.deepEqual(again.list,[]);
  assert.deepEqual(new ClockReminders('not json').list,[]);assert.deepEqual(new ClockReminders(undefined).list,[]);
  assert.deepEqual(new ClockReminders(JSON.stringify([{at:'x',text:'a'},{at:5,text:''},{at:at,text:'ok'}])).list,[{at,text:'ok'}]);
});
