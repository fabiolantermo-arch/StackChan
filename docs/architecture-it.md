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
- `tracker.js`: inseguimento del viso. Due modi: posizione del viso in un’inquadratura fissa (Bluetooth MediaPipe) oppure, con Live «Segui il mio viso», posizione nel fotogramma della camera del robot più la posizione della testa al momento dello scatto (`aim`). `FaceLock` sceglie l’immagine da mandare: intera 160×120 finché il viso non è trovato, poi 80×60 (una finestra 120×90 attorno al viso, oppure l’intera dimezzata), e riporta le risposte dell’iPhone alle coordinate dell’immagine intera.
- `dance.js`: danze.
- `voice-device.js` / `voice-wire.js`: conversazione dal robot, a turni (microfono e altoparlante mai aperti insieme). Si collega a `/api/robot/voice?audio=ima&mic=alaw`: il microfono va in A-law binario (codifica dell’host `ChatAudioIO/Codecs`, ripiego μ-law); le risposte arrivano come frame binari `[1][numero di pose][una posa della bocca ogni 4 blocchi, circa 32 ms][blocchi IMA da 68 byte = 129 campioni]` (`src/robot-audio.ts`, circa 194 ms per frame; il robot li suona in segmenti di circa 97 ms) e vanno, senza decodifica in JavaScript, nella coda (24 elementi) del driver `pins/audioout` dell’host: una callback per segmento muove la bocca.
- `live-device.js` / `live-wire.js`: relay Live. Comandi di inseguimento `track.start` (camera 160×120; in grigi, tipo 6: immagine intera ogni ≥150 ms finché il viso non è trovato, poi immagini piccole 80×60 ogni ≥250 ms scattate quando la connessione ha posto per tutti e tre i pezzi; sempre e solo a coda vuota), `track` (`frameId`, `x`, `y`) e `track.stop`; richiedono camera e movimenti attivi.
- `socket.js`: tutti i socket del MOD (client di basso livello dell’host) e `lowLatency()`: chiede all’host il Wi-Fi sempre sveglio (modulo `network-power`) mentre camera, inseguimento, chiamata Live o conversazione trasmettono; a riposo la radio torna in risparmio. I messaggi partono subito (`noDelay`) e `room` dice quanti byte la connessione prende senza farli aspettare: l’host ne tiene al massimo 11,4 KB in attesa della conferma della rete (`TCP_SEND_BUFFER` nella build dell’host; 5,7 KB fino al 10 novembre), ed è questo a limitare la velocità delle immagini (circa 35 KB/s sull’hotspot, misurati il 10 novembre; prima circa 23).
- `pairing-device.js`: abbinamento.
- `reminders.js`: timer.
- `calibration.js`: calibrazione della testa. L’host converte le rotazioni in posizioni dei servi con centri fissi (orizzontale 460, verticale 620) e limita il verticale a 5…85°; il MOD allarga i limiti dell’host (sezione `config` del manifest → `mod/config`, posizioni 0…1000) e applica i propri: centro e fine corsa misurati a mano, meno 12 passi (circa 4°) di margine. Ogni posa passa da `setHeadPose` → `toHost()`; senza misure valgono esattamente i limiti dell’host. Misure in Preference `robottino/headCal`.
- `lights.js`: luci della testa (12 LED colorati del K151, comandati dall’host attraverso il PY32: `robot.lighting`, LED `head`). Schema «Discreta» a un quarto della luminosità: spente a riposo; azzurro fisso quando ascolta, azzurro lampeggiante quando si collega o pensa, bianco caldo quando parla, viola con l’iPhone collegato (Live, camera, inseguimento, Test), arancione lampeggiante con il codice di abbinamento, giallo lampeggiante per un promemoria finché non si tocca la testa, rosso per tre lampeggi dopo un errore. Il MOD le aggiorna ogni 100 ms e scrive sui LED solo quando la luce cambia; la fase della conversazione viene da `voice.phase`.
- `wifi-switch.js`: due reti.
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
