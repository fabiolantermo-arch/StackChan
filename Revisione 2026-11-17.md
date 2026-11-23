# Revisione del codice Robottino

**17 novembre 2026 · Progetto in Documenti/robottino · Commit `c938d0866114b7642291e6c086853cef4a6ba05e`**

Prima di usare il rover in autonomia, va risolto il caso in cui il robot perde il collegamento con il controller delle ruote durante una manovra. Anche il comando di arresto dell’iPhone può essere rifiutato quando ci sono più comandi in attesa. L’altra priorità è la configurazione Wi-Fi via Bluetooth, che nel sorgente dell’host tratta la password come una normale preferenza e contiene istruzioni che possono scriverla nei log.

La revisione comprende il backend Cloudflare, l’app iPhone, il modulo del robot e le parti dell’host coinvolte nei problemi descritti. Sono stati usati test locali e dispositivi simulati. Le conclusioni sull’hardware descrivono il comportamento dedotto dal codice e vanno convalidate al banco. Il documento è l’unica aggiunta alla cartella. Nessun aggiornamento del firmware, dell’app o dei servizi live è stato eseguito.

## P1 · Da correggere prima dell’uso del componente interessato

### R1 · L’arresto delle ruote può fallire mentre il firmware le considera ferme

**Evidenza.** In `firmware/stackchan-mod/rover-wire.js:57`, `halt()` cancella il timer del movimento prima di provare a scrivere la velocità zero sul bus I²C. Se la scrittura fallisce, `fail()` ritenta immediatamente e passa in errore. Dopo due fallimenti non rimane alcun tentativo programmato e `moving` vale `false`, perché dipende dal timer. Il percorso di arresto generale in `firmware/stackchan-mod/mod.js:1198` ignora inoltre il valore restituito da `rover.stop()`. Il dispatcher può quindi inviare un ACK positivo anche se il comando di arresto delle ruote è fallito. Riferimenti aggiuntivi: `rover-wire.js:76`, `rover-wire.js:87`, `live-wire.js:169` e `live-device.js:824`.

**Riproduzione locale.** Con un bus finto che ha accettato il comando di marcia e poi rifiutato entrambe le scritture di arresto, le quattro ruote simulate hanno mantenuto la velocità precedente. Il firmware ha restituito errore, ha indicato `moving: false` e ha lasciato zero timer attivi. Il sorgente descrive il controller come privo di un proprio watchdog. Il comportamento del controller fisico in perdita di comunicazione resta da misurare.

**Correzione e verifica.** Propagare il fallimento fino all’ACK dell’app e mantenere lo stato «arresto non confermato» finché lo zero non viene scritto. Prevedere tentativi controllati di recupero del bus e un meccanismo di arresto indipendente dal programma principale, se il controller lo consente. Provare al banco con ruote sollevate, interrompendo la connessione I²C e riavviando il robot con le ruote in movimento. Un test automatico deve rifiutare qualsiasi esito positivo se lo zero non arriva al controller simulato.

### R2 · Il comando Stop può essere bloccato dalla coda Live

**Evidenza.** L’app rifiuta un quinto comando in `ios/Robottino/RobotLiveCore.swift:913`. Anche il relay rifiuta ogni comando con quattro conferme pendenti, prima di eseguire la gestione speciale di `stop` in `src/robot-link.ts:109`. Se lo Stop viene comunque inoltrato, il relay svuota i comandi pendenti senza risolverli nell’app. Il firmware può sopprimere i loro ACK dopo il cambio di generazione. I timeout dei comandi superati possono allora chiudere il canale anche dopo uno Stop riuscito.

**Riproduzione locale.** Quattro movimenti accodati senza risposta, poi Stop. Il relay ha risposto `busy` e il dispositivo simulato non ha ricevuto lo Stop.

**Correzione e verifica.** Dare priorità allo Stop sia nell’app sia nel relay. Annullare esplicitamente i comandi superati e ignorare solo le conferme tardive di quei comandi. Verificare coda piena, ACK tardivo e Stop durante avvio della camera, danza e movimento. Incrociare il test con R1 per distinguere conferma della ricezione e conferma dell’arresto.

### R3 · La configurazione Bluetooth può divulgare la password Wi-Fi

**Evidenza.** L’host include `wifi.password` tra le preferenze. All’iscrizione alle notifiche, invia i valori correnti al client Bluetooth. Ricezione e modifica contengono anche chiamate a `trace` con i valori completi. Il servizio UART dell’SDK dichiara normali permessi di lettura e scrittura. Nel percorso analizzato non è emerso un controllo di autenticazione del client prima della notifica. L’app si collega al primo dispositivo che pubblica l’UUID del servizio e considera la password restituita come parte della conferma. La finestra di cinque minuti limita le scritture, ma non identifica il dispositivo che si collega.

**Riferimenti.** `work/stack-chan-upstream/firmware/host/modules/preferences/consts.ts:12`, `work/stack-chan-upstream/firmware/host/modules/connectivity/preference-server.ts:120`, `:147`, `:182`, `:212`, `work/moddable-sdk/modules/network/ble/uart/bleservices/uart.json` e `ios/Robottino/RobotLive.swift:1457`, `:1498`. Il sorgente indica il rischio. In questa revisione non sono stati acquisiti pacchetti Bluetooth o letti log del robot, quindi non è stabilito se le tracce siano attive nell’immagine installata.

**Correzione e verifica.** Eliminare le tracce dei valori e il rimando della password. Confermare la singola operazione con un identificativo e uno stato. Richiedere associazione autenticata prima di leggere o scrivere credenziali, e verificare l’identità del robot nell’app prima dell’invio. Provare una password finta con due periferiche in modalità impostazioni, un telefono non autorizzato e il log seriale della build di prova.

## P2 · Affidabilità, isolamento e coerenza

### R4 · L’abbinamento può essere bloccato da richieste anonime

Il WebSocket iniziale è pubblico. `src/index.ts:43` consuma una quota unica prima di sapere se il servizio di abbinamento ha posto. `src/session.ts:47` applica 6 tentativi al minuto e 100 al giorno. `src/pairing.ts:16` ammette solo quattro connessioni in attesa. Nella prova locale quattro aperture anonime hanno occupato tutti i posti, altre due richieste rifiutate hanno consumato la quota e la settima è stata respinta per limite. L’effetto riguarda la disponibilità dell’abbinamento e non permette da solo di ottenere la credenziale.

Legare l’apertura a una breve finestra autorizzata dal proprietario o a un invito monouso, mantenere limiti separati per traffico anonimo e abbinamento autorizzato e verificare che le richieste respinte non consumino l’intera capacità giornaliera. [Cloudflare Durable Objects · WebSocket](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)

### R5 · Il token dell’app può entrare nella sessione vocale riservata al robot

La rotta del telefono in `src/index.ts:114` accetta `sessionId=robot`. Per lo stesso provider genera quindi la stessa chiave di sessione della rotta dispositivo, che invece verifica il token dedicato in `src/index.ts:49`. La sessione in `src/session.ts:17` può sostituire la conversazione in corso. In `src/voice-stream.ts:128` anche l’accesso alla modalità strumenti del robot dipende dal parametro, con `tools=1` e provider ElevenLabs. Un client col token dell’app può così interrompere la chiamata del robot e accedere al contesto associato. Non è un accesso anonimo e non dà di per sé controllo del robot fisico.

Usare chiavi distinte per app e dispositivo e scegliere modalità e capacità dal ruolo verificato sul server. Incrociare entrambi i token con entrambe le rotte e verificare che una connessione dell’app non sostituisca quella del robot.

### R6 · Un cambio voce fallito può lasciare l’agente e l’app con impostazioni diverse

In `src/preferences.ts:44` l’agente ElevenLabs viene aggiornato prima delle verifiche finali e del salvataggio locale. Se il fornitore riceve il cambio ma fallisce la rilettura, o se l’attivazione dell’inglese fallisce, l’app riceve un errore e il database conserva i vecchi valori, mentre la voce dell’agente può essere già cambiata. Due salvataggi concorrenti possono inoltre intercalare le operazioni sullo stesso agente.

Serializzare i salvataggi e verificare i prerequisiti prima della modifica. Se un aggiornamento esterno riesce parzialmente, registrare uno stato esplicito da riconciliare con il provider. Testare PATCH riuscito seguito da verifica fallita, inglese indisponibile e due richieste concorrenti. Le prove future possono sostituire le API esterne con risposte simulate.

### R7 · La rete di riserva è scelta per visibilità, non per riuscita del collegamento

`firmware/stackchan-mod/wifi-switch.js:46` seleziona all’avvio una rete tra gli SSID visibili e scrive un solo profilo nelle preferenze dell’host. Se la rete di casa appare ma la sua password è cambiata, l’host ritenta lo stesso profilo. Il ciclo esaminato non prova l’hotspot dopo il fallimento e non implementa il passaggio automatico quando il robot perde la rete durante l’uso. Riferimento incrociato: `work/stack-chan-upstream/firmware/host/app/boot-services.ts:83`.

Fare scegliere il secondo profilo dopo un numero limitato di tentativi del primo. Gestire riconnessione, pausa tra i tentativi e priorità della rete di casa. Provare password di casa errata con hotspot disponibile, perdita della rete durante l’uso e ritorno a casa. Allineare `docs/WIFI-CASA-E-HOTSPOT-it.md` all’effettivo comportamento del firmware.

### R8 · La cancellazione dei Ricordi lascia la cronologia vocale separata

Il comando di svuotamento in `src/memories.ts:36` cancella i ricordi espliciti. Il backend salva separatamente gli ultimi 12 messaggi della sessione vocale e li ricarica al collegamento successivo, come si vede in `src/session.ts:25` e `src/session.ts:32`. Il metodo `clearHistory()` in `src/session.ts:46` non risulta collegato alla cancellazione nell’app. Una frase eliminata dai Ricordi può quindi continuare a influenzare le risposte se era stata detta nella stessa sessione. L’interfaccia usa il termine **Ricordi**, quindi la cancellazione attuale è coerente con il nome della sezione. Resta da rendere distinguibile la cronologia breve e la sua eventuale rimozione.

Mostrare la differenza tra i due archivi e prevedere un controllo esplicito per la cronologia, se si vuole offrire una cancellazione complessiva. Verificare anche il caso di una chiamata attiva che alla chiusura tenti di salvare nuove trascrizioni.

## Esito delle verifiche

| Controllo | Esito |
| --- | --- |
| Controllo tipi TypeScript | Passato. |
| Backend Cloudflare con Vitest | 131 test passati in 19 file. Il simulatore ha richiesto una porta locale. |
| Firmware e codice host | 523 passati, 10 saltati, 0 falliti nella prova iniziale. Sei saltati perché la copia temporanea non includeva i sorgenti upstream dei servi nel percorso atteso, quattro perché disattivati nel progetto. |
| Modelli, protocollo e logica iPhone | 49 verifiche Swift passate. |
| Vision su immagine nera sintetica | Passato su macOS con accesso ai servizi grafici locali. Il primo tentativo con accesso limitato si era fermato all’asserzione del test. |
| Riproduzioni aggiuntive | Tre comportamenti riprodotti localmente: arresto I²C fallito, Stop respinto a coda piena e quota anonima dell’abbinamento esaurita. |

La compilazione completa e la firma dell’app iPhone, la prova sui motori, l’abbinamento Bluetooth reale e i servizi vocali in produzione restano fuori da questa verifica. I numeri riportati riguardano la copia del commit indicato.

Per riprendere in Claude Code, usare R1–R3 come primo gruppo di lavoro e partire dalle riproduzioni descritte. Il criterio di chiusura per ciascun problema è un test che fallisce con il comportamento attuale e passa dopo la correzione. Per R1 e R3 serve anche la corrispondente prova al banco.
