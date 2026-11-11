# Stato verifiche e uso del backend

Il servizio cloud non richiede un Mac acceso. Worker: robottino-stackchan. Nessuna risorsa di altri progetti è collegata a questo.

Solo /health è pubblico. Chat, catalogo e WebSocket richiedono `Authorization: Bearer <token>`. Il token è nel secret ROBOT_API_TOKEN e, localmente, in private/robot-token (permessi 0600, escluso da Git). Non condividerlo e non inserirlo negli URL. Non è una chiave del provider.

Limiti: 6 aperture/minuto e 100/giorno UTC per il proprietario, persistenti e condivise fra le sessioni. Una connessione vocale dura al massimo 5 minuti (`VOICE_LIMITS` in src/voice-stream.ts); input entro 256 KB/s e 24 MB totali, 30 eventi/s, 32 KB/evento. L’app iPhone (Studio → Parla con Robottino) usa questo percorso con microfono e altoparlante del telefono. Non è un limite monetario esatto: configurare anche gli avvisi di spesa nei provider.

## Protocollo

Aprire `wss://robottino-stackchan.example.workers.dev/api/voice?provider=openai&sessionId=demo` con Authorization nell'header. Per ElevenLabs usare provider=elevenlabs.

Gli eventi restano quelli ufficiali del provider. OpenAI: attendere session.started, inviare session.input_audio.append con PCM16 mono 24 kHz in base64. ElevenLabs: attendere conversation_initiation_metadata, rispettare user_input_audio_format, inviare user_audio_chunk, rispondere ai ping con pong/event_id. Riprodurre l'audio ricevuto secondo il formato dichiarato dal provider. Chiudere il socket per terminare; il backend chiude anche il provider.

Le interruzioni vocali sono gestite dal provider. Il client deve interrompere/ripulire il proprio buffer quando riceve l'evento corrispondente. Questa parte resta da implementare nel firmware.

La vecchia /api/chat non è più la modalità operativa: risponde 426 websocket_required alle richieste valide/autenticate. Non presentare quel risultato come una conversazione fallita.

## Memoria e limiti

Ultimi 12 messaggi per sessione/provider, massimo 4000 caratteri ciascuno. La cronologia viene reinviata solo al provider selezionato, come autorizzato dall'utente. Le trascrizioni dipendono dagli eventi ricevuti; la continuità dei ricordi non è ancora verificata con una conversazione audio a più turni. Nessuna conservazione di audio nel database. Memoria persistente su Cloudflare: usare sessionId distinti per conversazioni separate.

## Verifiche

6 test locali passati: selezione provider, stub, token, accesso anonimo, validazione/payload, quota. Verifica remota: health 200, API senza token 401; entrambi i WebSocket autenticano e producono eventi/audio sintetico. Non sostituisce la prova di ascolto e interruzione sul robot fisico.

Sami è la voce pubblicata dell'agente ElevenLabs Robottino (eleven_realtime_v1_max). OpenAI usa gpt-live-1 / marin. Le API key restano nei secret Cloudflare.

Agente ElevenLabs privato: autenticazione obbligatoria, 100 chiamate/giorno, 1 simultanea, bursting disattivato. Il Worker ottiene un URL firmato e non lo espone al client. Prova audio prima di questa protezione: OpenAI 345600 byte; ElevenLabs/Sami 238080 byte. Sono conteggi di dati ricevuti, non una verifica percettiva della qualità.

Ancora necessari sul K151: verifica modello/firmware, acquisizione microfono, buffering/playback, riconnessione, sincronizzazione volto/movimento e prova acustica. Nessun flash eseguito.

## Relay Live iPhone/robot

Aggiunti /api/robot/status e /api/robot/live autenticati con il token app; /api/robot/device richiede una credenziale robot distinta. Relay RobotLink distribuito, testato con dispositivo virtuale e client Swift di produzione. Formati, limiti, provisioning e prove fisiche ancora necessarie: [documento Live](LIVE-IPHONE-ROBOT-it.md). La chiamata iPhone/robot non usa i provider AI. Nessun flash eseguito.

## Conversazione avviata dal robot (7 novembre 2026)

Tocco lungo sulla testa (circa 0,9 s) avvia o chiude la conversazione; il tocco breve, al rilascio, mantiene sorriso e risata (la risata è sospesa durante la conversazione). Il MOD (`voice-device.js`, protocollo in `voice-wire.js`) apre `wss://…/api/robot/voice` con la **credenziale dispositivo**: il server rifiuta il token dell’app, applica la stessa quota (6/minuto, 100/giorno) e i limiti di `VOICE_LIMITS`, usa il provider salvato nell’app e una cronologia separata (`sessionId` `robot`). Audio PCM16 mono ai formati dichiarati dal provider (ElevenLabs 16 kHz, OpenAI 24 kHz), messaggi da 100 ms; la bocca segue l’audio in riproduzione. Senza cancellazione d’eco, mentre Robottino parla il microfono non invia nulla: misura solo il volume e, se sente per 0,3 s una voce più forte della soglia `bargeLevel` (preferenza `robottino`, predefinita 6000 RMS, 0 la disattiva), interrompe la risposta, invia anche gli ultimi 400 ms e scarta il resto della risposta finché il provider non conferma (massimo 3 s). Un tocco breve sulla testa mentre parla lo interrompe sempre. La soglia va regolata sul K151. Chiusura dopo 30 s di silenzio, 10 s senza risposta del servizio, errore o limite di 5 minuti. «Dimentica tutto» richiede la conferma dall’app. Richiede hardware verificato; formati audio, volume e reattività vanno provati sul K151.

Prova dal Mac con lo stesso accesso e lo stesso codice di protocollo: `npm run robot:talk` (frase sintetizzata), `npm run robot:talk -- "frase"` o `npm run robot:talk -- --microphone`. Chiama davvero il provider.

## Espressioni, timer, vita a riposo e Claude Code (7 novembre 2026)

Solo compilato e provato con test e dispositivo virtuale: nulla è stato flashato.

- **Umore delle risposte** (`replyMood` in `voice-wire.js`, gemello `RobotReplyMood` nell’app): dalle parole della risposta il viso diventa felice o triste e la testa fa un solo gesto per risposta (sì → annuisce, no → scuote, domanda → inclina). Nessuna chiamata IA in più. I gesti sul robot usano lo stesso percorso delle danze (±10°, servono hardware verificato, calibrazione e movimenti attivi; mai mentre l’app Live è collegata).
- **Timer e Pomodoro a voce** (`timerCommand`, `reminders.js`; nell’app `RobotTimerCommand` + notifiche locali): «avvisami tra 10 minuti», «ricordami tra mezz’ora di…», «facciamo un pomodoro» (25+5 minuti per 4 giri), «quanto manca?», «annulla il timer». Da 10 secondi a 6 ore, massimo 4 timer. Sul robot l’avviso è un messaggio, il sorriso, un cenno e il suono `avviso.bin` (generato da `prepare-alert.mjs`); i timer del robot si perdono al riavvio. Sull’iPhone arrivano come notifiche anche ad app chiusa. Il server non salva mai «ricordami tra…» come ricordo e dice al modello di limitarsi a confermare.
- **Vita a riposo**: battiti di ciglia irregolari (ogni 2,5–6,5 s, a volte doppi) e, con movimenti attivi e nessuno da seguire, uno sguardo intorno ogni 20–40 s. Il «respiro» spostando il ritratto è escluso: lascerebbe una riga blu sui capelli.
- **Reazioni a Claude Code**: `POST /api/robot/reaction` (token dell’app) con `kind` tra `attention`, `done`, `success`, `failure`; il server inoltra solo questi valori fissi al robot collegato, al massimo uno ogni 2 s (409 se il robot non è collegato). Gli hook in `.claude/settings.json` chiamano `scripts/robot-reaction.mjs`: richiesta di permesso → «Claude Code ti chiede un permesso»; fine turno → «Claude Code ha finito»; comandi di test → «Test superati!» o «Qualcosa non va». Lo script non blocca mai Claude Code e ignora ogni errore. Il robot virtuale (`npm run robot:virtual`) stampa le reazioni.

## Abbinamento del robot e interruttori di sicurezza (7 novembre 2026)

Nessuna chiave nel firmware. Il robot senza `deviceToken` apre `wss://…/api/robot/pair` **senza credenziali** (quota 6/minuto, 100/giorno, al massimo 4 robot in attesa) e riceve un codice casuale di 6 cifre, valido 5 minuti, che mostra sullo schermo. Il proprietario lo scrive nell’app (scheda Robot → Abbina robot): `POST /api/robot/pair` con il **token dell’app**. Solo allora il Durable Object `RobotPairing` manda a quel robot la sua credenziale (`ROBOT_DEVICE_TOKEN`); il robot la salva in `Preference` (`robottino.deviceToken`), risponde `stored` e l’app riceve successo solo dopo questa conferma (10 s al massimo). Il codice vale una volta; dopo 10 codici sbagliati in un’ora le richieste sono rifiutate. Il robot si ricollega da solo dopo l’abbinamento; dal suo menu «Abbina con l’app» rigenera un codice. Prova end-to-end: `node scripts/test-pairing.mjs` (non stampa i token).

Gli interruttori `verified` e `calibrated` si attivano dal menu del robot («Hardware verificato (sì/no)», «Calibrazione fatta (sì/no)») con una seconda pressione entro 5 s; si spengono subito con una sola pressione e spengono anche i movimenti. Vanno attivati solo dopo i controlli fisici.

## Fotocamera nel simulatore iOS

La pagina Studio → «Inseguimento viso» (simulazione sull’iPhone, senza robot) è stata tolta il 10 novembre 2026 su richiesta dell’utente, con `RobotHeadFollower`, `RobotGazeFace` e le maschere degli occhi. L’inseguimento vero è Live → «Segui il mio viso».

Nel simulatore iOS (che non ha fotocamera) l’app riceve le immagini da `Simulator Camera.command` (`scripts/mac-camera.swift`): usa l’iPhone come webcam del Mac (Continuity Camera, sempre la fotocamera posteriore per scelta di Apple) oppure la fotocamera del Mac (`--mac`). Ascolta solo su 127.0.0.1:8765, ogni immagine è lunghezza a 4 byte + JPEG, nessun dato esce dal Mac. Nel simulatore Vision gira solo su CPU. Il codice è compilato solo per il simulatore (`#if targetEnvironment(simulator)`): l’app sull’iPhone usa sempre la sua fotocamera frontale. Serve a Live → «Imita il mio viso» quando l’app gira nel simulatore.

Limiti della testa (7 novembre 2026, allargati su richiesta dell’utente): 0,65 rad/s; ±0,8 rad (circa 46°) a destra/sinistra, entro i ±128° del driver K151; fino a 0,52 rad (30°) in su, come la posa UP upstream. Convenzione upstream: p negativo guarda in su; il servo K151 riceve −p limitato a 5–85°, quindi p = 0 (dritta) è già vicino al fine corsa basso e la testa non scende. Prima di questa data il segno del pitch in `tracker.js` era invertito (un viso in alto avrebbe chiesto di abbassare la testa). Da collaudare sul robot: versi di rotazione e posizione dritta reale.
