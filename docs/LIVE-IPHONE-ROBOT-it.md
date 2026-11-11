# Live iPhone ↔ Robottino

Implementazione del 6 novembre 2026. Il relay è distribuito nel Worker robottino-stackchan; funziona senza un Mac acceso. È un prototipo software con test locali e una prova attraverso Cloudflare con dispositivo virtuale, non un collaudo sul K151 fisico.

## Nuova scheda Live

- **Video del robot:** pulsante Avvia/Ferma, fotogrammi RGB565LE 320×240, acquisizione richiesta ogni333ms (circa3fps; frequenza e latenza reali da misurare). Nessun video precaricato spacciato per camera reale.
- **Testa:** cursori orizzontale e «in su» e centro: fino a 90° ai lati e 85° in su, mai in giù (scelta dell’utente, 9 novembre 2026, notte; il robot resta comunque dentro la sua calibrazione), a velocità costante; destra e sinistra come nel joystick della pagina Test. Specchio e danze restano ±10°. L'app richiede conferma del robot. Abilitati solo dopo verifica hardware, calibrazione e attivazione locale dei motori; tracking e danza vengono esclusi durante il controllo remoto.
- **Chiamata audio iPhone/robot:** microfono e altoparlante in entrambe le direzioni; dal 10 novembre 2026 viaggia in µ-law 8 kHz mono (pezzi da 800 byte con due byte di segno B1 08; microfono e altoparlante restano PCM16 a 16 kHz sui due lati), prima PCM16 mono16kHz. Non coinvolge OpenAI/ElevenLabs, non genera una conversazione AI. Richiede autorizzazione microfono iPhone prima di attivare il microfono del robot. Voice processing sul telefono; sul robot il microfono è sospeso durante audio udibile in uscita e per180ms successivi. Il silenzio non mantiene il microfono bloccato. Non è dimostrata una conversazione acustica full duplex senza eco: serve prova fisica. Altoparlante al25%, buffer limitati, accesso audio esclusivo del MOD.
- **Segui il mio viso (9 novembre 2026):** Avvia inseguimento → il robot accende la camera a 160×120, la riduce a 80×60 in grigi (canale verde, media di 2×2 pixel: 4,8 KB, pacchetti di tipo 6) e manda un fotogramma al massimo ogni 150 ms, solo quando il precedente è partito; l’app lo ricompone (tipo 7 interno, solo nell’app); l’iPhone cerca il viso con Vision (solo il riquadro, niente punti del viso) e risponde con `track` (numero del fotogramma, centro del viso). Il robot ricorda la posizione della testa degli ultimi 8 fotogrammi e gira la testa da lì: 80% dello spostamento per risposta, campo visivo misurato 58°×45° (fotogrammi solo a testa ferma), scarto sotto 3° ignorato, limiti 90° per lato e 85° in su, 3 rad/s. Viso accettato da Vision con sicurezza ≥ 0,5 e alto o largo almeno il 6% dell’immagine (un viso tagliato dal bordo conta per l’altezza; il suo centro viene ricostruito). Se il viso esce vicino a un bordo, la testa fa al massimo due passi da quella parte; senza viso, una persona vista di spalle fa puntare la sua testa (`RobotFaceFollowMemory`). Pezzi di immagine da 4 KB, mandati solo con la coda del socket vuota (a colori 160×120, sull’hotspot, misurato: un’immagine ogni 1,5–2 s; in grigio 2 pezzi). Con l’app aperta parte anche da solo durante una conversazione con il robot (scheda Robot → «Segui il mio viso mentre parliamo»), con un fotogramma ogni 250 ms. Senza risposte per 1,5 s la testa resta dov’è. Richiede camera, hardware verificato, calibrazione e movimenti attivati sul robot; esclude video, imitazione, testa manuale e danze finché è attivo. Da collaudare sul robot: verso della rotazione (immagine non specchiata, yaw positivo verso la sinistra del robot), campo visivo reale e frequenza dei fotogrammi in rete.
- **Imitazione viso:** nuova sezione subito dopo Collegamento reale, prima del video. Scegli Camera del robot (predefinita) oppure Camera iPhone, poi Avvia imitazione. Con la camera del robot il video parte automaticamente e Vision analizza sul telefono i fotogrammi ricevuti; la fotocamera iPhone resta spenta e non richiede il relativo permesso. Con Camera iPhone viene invece usata la frontale con permesso esplicito. La scelta non cambia mentre l’imitazione è attiva. Nel primo caso il limite è il flusso di circa3fps, nel secondo l’analisi arriva a5 aggiornamenti/s. Vengono restituiti solo posa/occhi/bocca; l’analisi sul telefono non identifica la persona e non viene inviata a provider AI. Una sola analisi in corso, nessuna coda di fotogrammi; risultati successivi allo stop ignorati. Viso assente ed errori Vision sono mostrati distintamente senza inventare comandi. Il volto del robot usa i sei ritratti esistenti. Precisione a distanza, luce/orientamento e segni dei motori richiedono collaudo fisico. Tenere l’app aperta e l’iPhone collegato al relay.

- **Invio immagine:** scelta esplicita da Foto, adattamento con bande a160×120 senza EXIF/localizzazione, invio al robot e ingrandimento2× sul display320×240. “Torna al volto” ripristina il ritratto. Nessun caricamento automatico della libreria.

Camera e microfono non partono all'apertura della scheda. Uscita, passaggio in background, interruzione audio e disconnessione chiudono i flussi. Le richieste di autorizzazione non vengono scambiate per un passaggio in background; i risultati tardivi vengono ignorati dopo l'uscita. Il pulsante Ferma tutto chiude il collegamento e provoca la pulizia sul robot. È un arresto software: non annulla fisicamente una posa già consegnata al driver, non centra né libera bruscamente i servi.

## Collegamento e protezioni

- App: WSS `/api/robot/live`, header Authorization con il token Robottino già nel Portachiavi.
- Robot: WSS `/api/robot/device`, credenziale **diversa** ROBOT_DEVICE_TOKEN, conservata localmente in private/robot-device-token con permessi0600 e nei secret del solo Worker Robottino. Non va incollata nell'app o nella chat. Nessuna API key dei provider nel firmware.
- Stato: GET `/api/robot/status` autenticato. Offline non equivale a backend guasto. Il campo simulated identifica esplicitamente il dispositivo virtuale.
- Durable Object RobotLink dedicato, aggiunto con migrazione v3-robot-link; le classi ChatSession e RobotMemory e i relativi dati sono conservati.
- Una app e un robot alla volta: un nuovo collegamento non sostituisce quello occupato. Nessuna riconnessione automatica che riattivi media o motori.
- ACK dei comandi entro1500ms; heartbeat ogni5s, chiusura dopo15s senza traffico e sessione massima10min. I comandi non si accumulano senza limite. Sequenze media crescenti, schema/ruolo/dimensioni/velocità validati; credenziali non accettate negli URL. I controlli motion del MOD conservano il watchdog1200ms del driver.
- Media inoltrati in transito via TLS, non salvati in memoria permanente, R2 o database. Non è cifratura end-to-end: il relay Cloudflare può elaborare i byte. I log registrano percorso/metodo, non payload o credenziali. Il singolo frame più recente resta in RAM sui dispositivi per visualizzazione; nessun archivio delle chiamate.

Wire v1:12byte di header, magic RB, versione1, tipo1=camera RGB565LE,2=display RGB565LE,3=audio della chiamata (B1 08 + µ-law 8 kHz mono; fino al 9 novembre 2026 PCM16LE mono16k); sequenzaUInt32BE, larghezza/altezzaUInt16BE e payload. Le immagini inviate al display restano160×120. Per il video320×240 il tipo4 contiene frameID UInt32BE, offset UInt32BE e fino32768byte RGB565LE dopo l’header base: cinque messaggi per un frame153600byte, ciascuno sotto il limite65536 del WebSocket SDK. Il client ricostruisce un solo frame in RAM; scarta frame incompleti dopo2s e rifiuta replay, buchi e dimensioni incoerenti. Il tipo1 resta compatibile con i vecchi frame completi (fino320×240). Limite800000byte/s per peer e120 messaggi/s; audio2..6400byte pari, dimensioni0. I media sono abilitati nel relay solo dopo ACK positivo del robot; pacchetti in volo dopo uno stop sono scartati. Non è il protocollo SC/BLE/LAN dell'app M5Stack di fabbrica.

## Requisiti firmware: prima del robot fisico

Il MOD usa l'upstream community Stack-chan commit906ee9a0cd2a0107a24c714efb10274f3b546afa, Moddable10.0.2, candidato m5stackchan_cores3. Usa robot.camera, robot.audio.acquireExclusive, embedded:io/audio/in e out, websocket/securesocket con verifica TLS, Preference e runtime-bitmap-port. Importazione fallita disabilita Live lasciando disponibili volto e controlli locali. Un archivio MOD compilato non dimostra che il firmware attuale del K151 contenga questi moduli nativi.

Occorre leggere modello/revisione, firmware e partizioni; verificare sensori, pin/I2S, amplificatore, camera, certificati TLS e disponibilità dei moduli host; determinare centro, segni e limiti dei servi. Solo dopo questa verifica e conferma esplicita si potranno installare/configurare host e MOD. Nessun flash è stato eseguito.

Il dispositivo legge Preference nel dominio robottino: deviceToken, verified e calibrated. Finché la verifica non è compiuta, non impostare verified/calibrated a true; i controlli rimangono non disponibili. La credenziale arriva con l’**abbinamento con codice** (vedi SECURITY-AND-STATUS-it.md); `verified` e `calibrated` si attivano a mano dal menu del robot dopo i controlli fisici. Il MOD avvia solo il canale di controllo se configurato; non apre autonomamente camera o microfono.

Restano da collaudare: camera e colori reali; memoria/PSRAM e stabilità con video+audio; latenza, perdita rete e audio acustico; precisione della posa, direzione e arresto dei motori; orientamento/luce camera frontale e selettore Foto sul telefono. Labbra sincronizzate al playback di una conversazione AI, rilevatore autonomo di oggetti e flusso audio AI del robot sono lavori distinti ancora da implementare.

## Verifiche ripetibili

`npm run verify -- --iphone-build --cloud` esegue test, compilazioni, firma e controlli cloud in sola lettura. Report e log in work/verification/latest.json.

`node scripts/test-live-cloud.mjs` è una prova remota esplicita: apre due WebSocket nel solo progetto Robottino e usa un dispositivo marcato simulated. Rifiuta di sostituire un robot online; invia immagini sintetiche e silenzio PCM, verifica testa/viso, ACK, immagine, audio bidirezionale e chiusura accoppiata. Non accede a camera/microfono, non chiama provider e non modifica ricordi/preferenze. Report work/verification/live-cloud.json. Non dimostra il funzionamento fisico.

`node scripts/test-live-native.mjs` compila ed esegue il client Swift di produzione contro Cloudflare e un dispositivo virtuale: sono passati stato, video, testa, viso, immagine, PCM bidirezionale e STOP. Non usa i driver audio/video dell’iPhone. Report work/verification/live-native.json.

La nuova app compila ed è firmata. Aggiornare con Update Robottino.command quando l'iPhone è collegato e sbloccato; non disinstallare l'app, per mantenere i dati esistenti. Aggiornamento6 novembre2026,22:52: iPhone raggiungibile, firma ricontrollata, nuova versione installata e avviata senza disinstallazione. Il collaudo fisico audio/video e robot resta da eseguire.

## Documenti ufficiali e sorgenti consultati

- [Cloudflare Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) — acceptWebSocket, hibernation e attachment.
- [Cloudflare secret](https://developers.cloudflare.com/workers/configuration/secrets/) — credenziali lato Worker.
- [Stack-chan upstream fissato](https://github.com/stack-chan/stack-chan/tree/906ee9a0cd2a0107a24c714efb10274f3b546afa/firmware) — host/modules/camera, app/runtime-audio.ts, ui/views/camera-preview/runtime-bitmap-port e mods/examples/openai_live_webrtc.
- [Moddable SDK10.0.2](https://github.com/Moddable-OpenSource/moddable/tree/10.0.2) — esempi io/audioin/capture-sync, modules/network/websocket e modules/crypt/securesocket, consultati nella copia locale.
- [Apple Vision landmarks](https://developer.apple.com/documentation/vision/vndetectfacelandmarksrequest), AVAudioEngine, AVCaptureSession e PhotosPicker nelle dichiarazioni SDK Xcode locale.

## Attivazione e risoluzione

Dalla scheda Live: Collega al robot → Imita il mio viso → Camera del robot → Avvia imitazione. La sezione segue immediatamente Collegamento reale · Robottino. Il video si avvia automaticamente. Per arrestare: Ferma imitazione; il video resta disponibile finché non si preme Ferma video. Ferma video interrompe anche l’imitazione da quella sorgente. Ferma tutto chiude entrambi.

La camera K151 GC0308 è dichiarata640×480 da [M5Stack](https://docs.m5stack.com/en/StackChan). Il [firmware ufficiale esaminato](https://github.com/m5stack/StackChan/blob/28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400/firmware/sdkconfig.defaults) seleziona320×240; non è una verifica dell’ultima app distribuita. Anche il nostro MOD ora richiede320×240. L’uscita reale non è stata ancora misurata sul robot fisico.

Ultimo aggiornamento: nuova versione con scelta Camera del robot/Camera iPhone, sezione subito sotto Collegamento reale e video richiesto320×240 installata e avviata sull’iPhone fisico.70 test del progetto/MOD,22 gruppi Swift, prova Vision sintetica e prove remote passati. Hardware robot non flashato né collaudato.


## Danze dallo Studio (7 novembre 2026)

Comando `dance` con `steps` (1–32 passi, ±10°, 300–5000 ms, massimo 60 s, espressioni del catalogo). Il server lo valida, ricostruisce i soli campi noti e lo accetta solo con movimenti abilitati e calibrati; il firmware lo rivalida. L’ACK indica l’inizio della danza, non la fine. Il collegamento dell’app resta aperto per la durata: chiuderlo, STOP o un errore motore fermano la danza. Luci e musica restano sull’iPhone.

## Robot virtuale

`npm run robot:virtual` collega un dispositivo marcato `simulated` con il token dispositivo locale: video di prova a barre, tono durante la chiamata, registro di comandi, danze e immagini (salvate in work/virtual-robot/screen.ppm), ricollegamento con le stesse attese del firmware. Rifiuta di sostituire un robot già collegato. L’app non applica il volto a un dispositivo simulato, per scelta.

## Ricollegamento del robot

Il server chiude il dispositivo quando l’app si scollega, dopo 10 minuti o 15 secondi senza segnali (nel codice, non ancora pubblicato: i 10 minuti si contano da quando entra l’app e la chiusura porta il motivo). Dal 10 novembre 2026 anche il robot chiude da sé dopo 12 s senza niente dal server. Il MOD ora si ricollega da solo dopo 5 s, poi 10, 20, 40 e al massimo 60 s; l’attesa torna a 5 s dopo un collegamento riuscito e i tentativi cessano con «Ferma Robottino». Da provare sul robot.
