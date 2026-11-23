# Architettura

Aggiornato al 7 novembre 2026. Tre componenti parlano solo attraverso il Worker Cloudflare: l’iPhone e il robot non si collegano mai direttamente.

```
 App iPhone (ios/)                Cloudflare Worker (src/)                 Robot K151 (firmware/stackchan-mod/)
 ─────────────────                ─────────────────────────                ─────────────────────────────────────
 token app (Portachiavi) ──WSS──▶ /api/voice ──────────▶ OpenAI Live / ElevenLabs
                         ──WSS──▶ /api/robot/live ─┐                   ┌── /api/robot/device ◀──WSS── token dispositivo
                                                   └── RobotLink (DO) ─┘
                         ──POST─▶ /api/robot/pair ── RobotPairing (DO) ─── /api/robot/pair ◀──WSS── robot senza token
                                  /api/robot/voice ◀──────────────────────────────────────WSS── token dispositivo
 hook Claude Code ──POST─▶ /api/robot/reaction ──▶ RobotLink ──▶ robot
```

## Worker Cloudflare (`src/`)

- Nome `robottino-stackchan`, URL `https://robottino-stackchan.example.workers.dev`, configurazione in `wrangler.jsonc` (compatibilità 2026-11-06).
- Durable Objects (SQLite): `ChatSession` (`session.ts`, cronologia e quota), `RobotMemory` (`memories.ts`, ricordi permanenti), `RobotLink` (`robot-link.ts`, relay app↔robot), `RobotPairing` (`pairing.ts`, abbinamento con codice). Migrazioni v1 → v4: mai rimuoverle o riordinarle.
- File principali: `index.ts` (rotte e autenticazione), `voice-stream.ts` (relay vocale, `VOICE_LIMITS`, regole ricordi/timer, data italiana), `providers.ts` / `voice-config.ts` / `eleven-agent.ts`, `robot-vision.ts` («cos’è questo?»: la foto della camera del robot arriva a pezzi sulla connessione della voce, diventa un PNG ingrandito e un modello OpenAI con la vista la descrive in una frase che l’agente dice; `PICTURE_LIMITS`), `web-search.ts` (ricerca e strumento ElevenLabs), `memory-api.ts`, `preferences.ts`, `robot-wire.ts` (validazione messaggi robot, stili di volto ammessi), `security.ts`.

### Rotte

| Rotta | Chi | Credenziale |
|---|---|---|
| `GET /health` | tutti | nessuna |
| `WSS /api/voice?provider=openai\|elevenlabs&sessionId=…` | app | token app |
| `WSS /api/robot/voice` | robot | token dispositivo (il token app è rifiutato) |
| `WSS /api/robot/live`, `GET /api/robot/status` | app | token app |
| `WSS /api/robot/device` | robot | token dispositivo |
| `WSS /api/robot/pair` | robot non abbinato | nessuna (quota 6/min, 100/giorno, 4 in attesa) |
| `POST /api/robot/pair` | app | token app |
| `POST /api/robot/reaction` | hook Claude Code | token app; `kind` ∈ attention, done, success, failure; 1 ogni 2 s |
| `GET/POST /api/memories`, `/api/preferences`, `/api/providers` | app | token app |
| `POST /api/tools/web-search` | agente ElevenLabs | HMAC derivato dal token app |
| `POST /api/admin/web-search-tool` | proprietario | token app |
| `GET/POST /api/admin/agent-english` | proprietario | token app (GET: come è impostato l’agente; POST: aggiunge l’inglese alle lingue dell’agente Robottino e il permesso di sceglierlo all’avvio, senza toccare altro) |
| `POST /api/admin/asr-keywords` | proprietario | token app (aggiunge `ASR_KEYWORDS` al riconoscimento vocale del solo agente Robottino, tenendo le altre parole, il prompt e le altre impostazioni) |
| `/api/chat` | — | risponde 426: si usa il WebSocket |

Credenziali solo nell’header `Authorization`, mai nell’URL.

### Provider vocali

- OpenAI `gpt-live-1`, voce marin; ricerca web delegata a Responses (`gpt-6-luna` + `web_search`).
- ElevenLabs Realtime V1 Max, agente `agent_00000000000000000000000000`, voce Sami `kAzI34nYjizE0zON6rXv`, strumento `cerca_sul_web`. Predefinito.
- Limiti: 6 aperture/minuto e 100/giorno, 5 minuti per connessione, 256 KB/s e 24 MB in ingresso.

## Relay Live — protocollo binario «RB» v1

Header di 12 byte: magic `RB`, versione 1, tipo, sequenza UInt32BE, larghezza e altezza UInt16BE.

- Tipo 1: camera RGB565LE.
- Tipo 2: display RGB565LE 160×120.
- Tipo 3: audio della chiamata. Dal 10 novembre 2026 due byte di segno (B1 08) e poi µ-law 8 kHz mono, pezzi da 800 byte (un decimo di secondo); il PCM16LE mono 16 kHz di prima viene scartato da chi lo riceve.
- Tipo 4: pezzi di un fotogramma 320×240: frameID e offset UInt32BE, fino a 32 768 byte per pezzo, 5 pezzi per fotogramma.

Comandi JSON con ACK entro 1500 ms, heartbeat 5 s, chiusura dopo 15 s di silenzio, sessione al massimo 10 minuti, una app e un robot alla volta. Il robot chiude da sé il collegamento dopo 12 s senza niente dal server. Nel codice ma non ancora pubblicato (10 novembre 2026): i 10 minuti contati da quando entra l’app e la chiusura con il motivo (`robot_silent`, `app_silent`, `session_expired`, `command_timeout`). Dettagli in `docs/LIVE-IPHONE-ROBOT-it.md`.

## App iPhone (`ios/`)

- Progetto `ios/Robottino.xcodeproj`, tre file sorgente:
  - `Sources.swift`: store, interfaccia, Wi-Fi, Ricordi, Test con joystick;
  - `RobotLiveCore.swift`: logica pura e testabile (protocolli, voce, umore, `RobotFaceFollowMemory`, `RobotCallAudio`, `RobotMouthSmoother`, `RobotFaceStyle`);
  - `RobotLive.swift`: audio, fotocamera e Vision, conversazione, `RobotVoicePanel`.
- Schede: **Robot** (stato in una frase, Abbina robot, Wi-Fi, Collegamento sicuro), **Aspetto** (volto, modello e voce), **Studio** (danze, espressioni, simulatore, Live, Ricordi, poi Parla con Robottino), **Test** (stato reale del robot dal servizio; joystick che muove la testa vera entro ±10°, il limite dei comandi a distanza, oppure simulazione 46° / 30° in su).
- Il Wi-Fi viene salvato nel Portachiavi e inviato al robot via Bluetooth (hotspot e casa).
- Test offline: `ios/test-connection.swift`, eseguito da `test-connection.mjs`.

## Robot (`firmware/stackchan-mod/`)

MOD Moddable 10.0.2 su Stack-chan upstream `906ee9a0cd2a0107a24c714efb10274f3b546afa`, target candidato `m5stackchan_cores3`. Niente codice C, quindi niente cancellazione d’eco vera. Le regex non usano `\p{…}`.

- `mod.js`: comportamento, tocco, gesti (niente sguardi a riposo dal 9 novembre 2026).
- `face.js` + `portrait-state.js`: volto a immagini 320×240; `FACE_STYLES` = portrait `girl-`, white `white-`, redhead `red-`. Mentre parla resta il viso sereno e cambia solo una piccola immagine della bocca (`MOUTH_BOXES`, pose `MOUTH_POSES` 0–4), aggiornata appena l’host manda lo stato del volto.
- `tracker.js`: inseguimento del viso. Due modi: posizione del viso in un’inquadratura fissa (Bluetooth MediaPipe, dal 14 novembre 2026 spento se la preferenza `bleTracking` del robot non è `true`: teneva il Bluetooth sempre acceso accanto al Wi-Fi) oppure, con Live «Segui il mio viso», posizione nel fotogramma della camera del robot più la posizione della testa al momento dello scatto (`aim`). `FaceLock` sceglie l’immagine da mandare: intera 160×120 finché il viso non è trovato, poi 80×60 (una finestra 120×90 attorno al viso, oppure l’intera dimezzata), e riporta le risposte dell’iPhone alle coordinate dell’immagine intera.
- `dance.js`: danze.
- `voice-device.js` / `voice-wire.js`: conversazione dal robot, a turni (microfono e altoparlante mai aperti insieme). Si collega a `/api/robot/voice?audio=ima&lips=1&mic=alaw` (`lips=1` dal 16 novembre 2026: ogni posa della bocca porta anche la forma delle labbra della lettera detta, posa + 16 × forma; vedi `.claude/rules/volti.md`): il microfono va in A-law binario (codifica dell’host `ChatAudioIO/Codecs`, ripiego μ-law); le risposte arrivano come frame binari `[1][numero di pose][una posa della bocca ogni 4 blocchi, circa 32 ms][blocchi IMA da 68 byte = 129 campioni]` (`src/robot-audio.ts`, circa 194 ms per frame; il robot li suona in segmenti di circa 97 ms) e vanno, senza decodifica in JavaScript, nella coda (24 elementi) del driver `pins/audioout` dell’host: una callback per segmento muove la bocca.
- `live-device.js` / `live-wire.js`: relay Live. Comandi di inseguimento `track.start` (camera 160×120; in grigi, tipo 6: immagine intera ogni ≥150 ms finché il viso non è trovato, poi immagini piccole 80×60 ogni ≥250 ms scattate quando la connessione ha posto per tutti e tre i pezzi; sempre e solo a coda vuota), `track` (`frameId`, `x`, `y`) e `track.stop`; richiedono camera e movimenti attivi.
- `socket.js`: tutti i socket del MOD (client di basso livello dell’host) e `lowLatency()`: chiede all’host il Wi-Fi sempre sveglio (modulo `network-power`) mentre camera, inseguimento, chiamata Live o conversazione trasmettono; a riposo la radio torna in risparmio. I messaggi partono subito (`noDelay`) e `room` dice quanti byte la connessione prende senza farli aspettare: l’host ne tiene al massimo 11,4 KB in attesa della conferma della rete (`TCP_SEND_BUFFER` nella build dell’host; 5,7 KB fino al 10 novembre), ed è questo a limitare la velocità delle immagini (circa 35 KB/s sull’hotspot, misurati il 10 novembre; prima circa 23).
- `pairing-device.js`: abbinamento.
- `reminders.js`: timer.
- `calibration.js`: calibrazione della testa. L’host converte le rotazioni in posizioni dei servi con centri fissi (orizzontale 460, verticale 620) e limita il verticale a 5…85°; il MOD allarga i limiti dell’host (sezione `config` del manifest → `mod/config`, posizioni 0…1000) e applica i propri: centro e fine corsa misurati a mano, meno 12 passi (circa 4°) di margine. Ogni posa passa da `setHeadPose` → `toHost()`; senza misure valgono esattamente i limiti dell’host. Misure in Preference `robottino/headCal`.
- `lights.js`: luci della testa (12 LED colorati del K151, comandati dall’host attraverso il PY32: `robot.lighting`, LED `head`). A un quarto della luminosità, colori scelti dall’utente il 12 novembre 2026: spente a riposo; verde fisso quando ascolta, blu fisso quando parla (rosso e giallo che si alternano ogni mezzo secondo quando parla con la faccia arrabbiata), giallo fisso mentre cerca sul web, turchese fisso mentre scatta e fa leggere la foto di «cos’è questo?», bianco lampeggiante quando si collega o prepara la risposta, viola con l’iPhone collegato (Live, camera, inseguimento, Test), arancione lampeggiante con il codice di abbinamento, rosa lampeggiante per un promemoria finché non si tocca la testa, rosso per tre lampeggi dopo un errore. La ricerca sul web la dice il Worker al robot con l’evento `robot.search` sulla connessione della voce (`src/voice-stream.ts`, dalla rotta `/api/tools/web-search` attraverso `ChatSession.searching`, o dalla delega di OpenAI). Il MOD le aggiorna ogni 100 ms e scrive sui LED solo quando la luce cambia; la fase della conversazione viene da `voice.phase`.
- `wifi-switch.js`: due reti.
- `motion-sense.js` (14 novembre 2026): sollevato, scosso, caduto dal sensore di movimento della testa (`robot.input.imu`, lettura ogni 100 ms; serve l’host `14d`). In mano o caduto la testa non riceve comandi.
- `sound-ear.js` (14 novembre 2026): quando un suono è «una voce da quel lato», dai numeri di `soundSide` dell’host (due microfoni quasi nello stesso punto: solo sinistra o destra). Mentre il robot dorme i microfoni sono aperti; una voce lo sveglia e la ricerca a zigzag parte da quel lato (`selfWake` in `live-device.js`).
- `k210.js` (14 novembre 2026, preparato e mai provato): ascolto della camera K210 sulla seriale della PORT.C; vedi `firmware/k210/README-it.md`.
- `rover-wire.js` (14 novembre 2026, preparato e mai provato): rover M5Stack RoverC Pro via I2C (0x38) sulla porta A, quattro ruote mecanum; ogni movimento lo ferma il robot. `rover-body.js`: il corpo gira verso la voce e dietro al volto, si ferma se il robot è sollevato. A voce lo strumento `muovi_rover` (Worker `robot-tools.ts`), dall’iPhone il comando Live `rover` (relay `robot-wire.ts`, tasti in `RobotLive.swift`). `lego-wire.js` resta nel repository ma è fuori dal MOD (LEGO spento).
- Preference nel dominio `robottino`: `deviceToken`, `verified`, `calibrated`. I movimenti richiedono verified, calibrated e l’attivazione locale.
- Build in `firmware/artifacts/` (archivio `.xsa` e hash).

## Convenzioni condivise tra componenti

- **Testa**: limiti di sicurezza yaw ±90° (π/2) e pitch tra −85° e 0, dove negativo significa guardare in su; il limite vero è la calibrazione (versione 2) meno il margine. Una sola velocità, 3 rad/s (circa 170°/s, la massima chiesta dall’utente), misurata da dove la testa dovrebbe essere, con passi minimi di 0,1 s (`HEAD_SPEED`, `MIN_MOVE`, `moveTime`, `setHeadPose`). L’inseguimento assoluto di `tracker.js` e `RobotHeadFollower` resta a ±0,8 e −0,52 con la stessa velocità. Il servo K151 riceve −p; il manifest allarga i limiti dell’host. Il servo orizzontale del K151 gira al contrario: il MOD lo inverte in `servoPositions`/`rotationFromRaw` (`YAW_SERVO`), l’app manda gli angoli così come sono.
- **Conversazione**: il `hello` del robot contiene `conversation`; lo stato del Worker lo espone; l’app aperta lo usa per seguire il viso durante la conversazione (`RobotConversationFollow`).
- **Stili di volto**: gli id `portrait`, `white`, `redhead` sono uguali in app, relay e MOD. Ogni volto ha sei pose: neutral, happy, sad, blink, talk-small, talk-open.
- **Umore delle risposte**: `replyMood` (MOD) e `RobotReplyMood` (app) sono gemelli. L’espressione dipende dalla frase in corso, il gesto dall’inizio della risposta.

## Strumenti locali (`scripts/`)

- `virtual-robot.mjs`: dispositivo simulato.
- `robot-talk.mjs`: conversazione dal Mac.
- `robot-reaction.mjs`: reazioni di Claude Code sul robot. **Hook disattivati il 9 novembre 2026 su richiesta dell’utente** (`.claude/settings.json` vuoto); per riattivarli rimettere gli hook `Notification` (`attention`), `Stop` (`done`) e `PostToolUse` su `Bash` (`tests`).
- `test-live-cloud.mjs`, `test-live-native.mjs`, `test-pairing.mjs`: prove sul cloud.
- `verify.mjs`: verifica completa.
- `mac-camera.swift`: presta una fotocamera al simulatore iOS su 127.0.0.1:8765.

### Esplorazione e riconoscimento del proprietario

Aggiornamento del 23 novembre 2026, commit di implementazione `aa68b53`.

L’identità arriva dall’iPhone. In Robot, «Riconosci viso e oggetti» deve essere attivo e il profilo va registrato con il nome e «Questo sono io». Durante l’esplorazione, l’app confronta il video del robot con le immagini salvate sul telefono. Due riscontri consecutivi inviano il nome con il comando Live `sight/person`. Un mancato riscontro invia `sight/stranger`. Le impronte del viso restano nel telefono.

Il MOD accetta questi aggiornamenti anche mentre la conversazione dell’esplorazione è aperta, prima del filtro che normalmente esclude le reazioni del viso in chiamata. `voice.person()` inoltra sulla connessione vocale un evento `explore` con `on: true`, `identityOnly: true` e `name` (stringa oppure null). Questo evento aggiorna solo l’identità e preserva la memoria delle ultime frasi dell’esplorazione.

Nel Worker, `ExploreIdentity` valida il nome e lo considera recente per 3 secondi. Avvio e fine dell’esplorazione azzerano il nome. `exploreAsk()` passa il risultato al modello che descrive la foto. Il saluto per nome è ammesso solo se al centro compare una sola persona con il viso visibile. La frase mantiene l’incertezza del confronto locale, per esempio «Ehi Ada, mi sembri tu!». Senza un riscontro recente resta la descrizione generica della persona.

Richiede l’app in primo piano, il collegamento Live e il profilo salvato. La precisione sul viso reale e la tempestività del video vanno provate dall’utente nelle condizioni d’illuminazione effettive. La camera del robot e quella K210 rilevano i volti, ma questo percorso usa l’iPhone per confrontarli con il profilo.

File coinvolti: `ios/Robottino/RobotLive.swift`, `Sources.swift`, `firmware/stackchan-mod/mod.js`, `voice-device.js`, `src/robot-vision.ts` e `voice-stream.ts`. Test aggiunti in `test/explore-identity.test.ts` e `firmware/stackchan-mod/voice-device.test.mjs`. Esiti della distribuzione in `docs/progress.md`.

Durante Esplora, RobotExploreKey.allowsGestures sospende i gesti dell’app, il callback scarta quelli già accodati e il MOD rifiuta gesture. Il riconoscimento del profilo resta attivo. mediaPaused nel dispositivo Live dà precedenza alla voce rispetto al video durante l’esplorazione; lo scatto successivo attende la fine del parlato. Attese locali ridotte, quota immagini invariata. Il 23 novembre l’utente ha confermato il riconoscimento dopo la nuova registrazione del profilo.

Lo Stop manuale dell’esplorazione (23 novembre 2026) ha priorità nelle code di app, relay e MOD, annulla i comandi pendenti e chiude la conversazione. Il Worker usa exploreRevision per scartare descrizioni completate dopo un cambio di sessione esplorativa. Durante Esplora sono sospesi anche Forza e saluto del sensore distanza, mantenendo il controllo ostacoli. La posizione nella foto serve a scegliere il soggetto e non va ripetuta nella frase pronunciata.

### Scansione verticale con rover durante Esplora

Dal 23 novembre 2026, Explore.pitch alterna a ogni sosta 0°, 25° in su, 50° in su, 25° in su e ricomincia. Il MOD applica reachable con la calibrazione effettiva. Prima del cambio di altezza arresta le ruote e usa lo stesso percorso setHeadPose con conferma dei servi e watchdog degli altri movimenti. La foto aspetta headSettled e wheelsStill. Durante questa attesa il rover non riceve nuovi comandi di marcia. Lo Stop annulla la vista in preparazione, chiude il parlato e impedisce lo scatto successivo. Motori spenti, errore di movimento o attesa oltre 4 secondi terminano la scansione. Nella modalità senza rover, tenuta in mano dall’utente, le foto mantengono la posizione scelta a mano. La sequenza con il rover fisico resta da collaudare.


## Revisione Esplora del 23 novembre 2026 — distribuita dopo approvazione

Il driver rover accetta una funzione `allowForward` dal MOD e tiene traccia dell'avanzamento effettivo, compresi i comandi diretti. Prima di muoversi in avanti e durante la marcia controlla testa stabilizzata entro ±5° di yaw e pitch; un ToF rilevato richiede lettura successiva all'allineamento e recente entro 300 ms. Ogni ripartenza dopo una scansione verticale passa da posa orizzontale e nuova lettura. I movimenti manuali senza sensore mai rilevato mantengono il comportamento precedente; Esplora con ruote richiede il ToF. Nessun limite di motori, watchdog o conferme è allentato.

La posa Esplora ha token e scadenza di 4 s dall'invio, non dall'inizio dell'attesa della voce. I 3 minuti complessivi rimangono. La fine automatica porta un motivo da lista fissa al Worker, pulisce l'audio precedente e consente l'annuncio e la conversazione successivi. Stop manuale chiude la chiamata. Stop Esplora conserva ACK e operazioni indipendenti: priorità senza sostituzione, massimo otto pendenti nel relay e nell'app. Lo STOP globale conserva la sua semantica di arresto generale.

Le foto contano 7 s di lavoro escludendo pause per voce/pose, con limite assoluto di 30 s e rilascio del frame. Il fallimento della descrizione risponde anche allo strumento guarda chiamato in Esplora. Il nome filtrato del proprietario entra già nelle istruzioni OpenAI vision oltre al contesto ElevenLabs; le impronte locali non vengono inviate. Esiti e limiti di collaudo in `REVISIONE-ESPLORA-2026-11-23.md`.
