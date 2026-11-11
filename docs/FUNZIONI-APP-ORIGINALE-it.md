# Confronto con l'app originale M5Stack

Verificato il 6 novembre 2026 sui sorgenti ufficiali m5stack/StackChan, commit 28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400. È una lettura del codice, non una prova dell'app distribuita: il README avverte che il repository può essere aggiornato in ritardo rispetto ai rilasci. Il firmware M5Stack di fabbrica (C++/ESP-IDF/LVGL) e quello community Stack-chan/Moddable usato dal nostro MOD sono basi diverse; il supporto nell'uno non garantisce lo stesso protocollo nell'altro.

## Funzioni riscontrate

| Funzione originale | Evidenza nei sorgenti app | Opportunità per Robottino | Verifica senza robot |
|---|---|---|---|
| Comando manuale testa e parametri volto | view/popup/motion.dart; controlMotion/controlAvatar | Rendere operativa la scheda Test, con calibrazione e conferma esecuzione | Codec, controlli limiti, simulatore; movimenti fisici da provare |
| Video dal robot con comando della testa | view/home/monitoring_camera.dart; onCamera/offCamera, JPEG | Visualizzazione live e scatto manuale | Decoder e test con immagini di prova; sorgente camera reale assente |
| Chiamata audio telefono/robot | view/home/avatar.dart; onAudio/offAudio, registrazione/riproduzione Opus | Parlare e ascoltare dal telefono attraverso il robot | Interfaccia, formati e prove registrate; latenza/acustica da misurare |
| Imitazione del volto e orientamento della testa | view/util/stack_chan_face_view.dart; ML Kit sul telefono | Robot che imita sorriso, occhi e posa del volto | Rilevamento sulla camera del telefono possibile senza robot; azionamento da verificare |
| Immagini dal telefono al display | view/home/avatar.dart; onPhoneScreen/offPhoneScreen, invio JPEG | Foto, volto personalizzato e modalità avatar | Anteprima e codifica immagini; rendering fisico da verificare |
| Registrazione/modifica/riproduzione coreografie | view/home/record_dance.dart, dance.dart, dance_list_page.dart | Libreria gesti e danze, editor con anteprima | Timeline, salvataggio, validazione e simulatore realizzabili subito |
| Musica e colori LED nelle coreografie | record_dance.dart; musicInfo, leftRgbColor/rightRgbColor | Danza con espressioni e luci, non solo oscillazione testa | Pianificazione/simulazione; LED e sincronismo audio reali da provare |
| Configurazione Wi-Fi e associazione robot | view/popup/device_wifi_config.dart, binding_device.dart | Abbinamento nell'app, stato connessione e configurazione dedicata | Flusso e parser; radio BLE, associazione e firmware da verificare |
| Nome robot e più dispositivi | view/home/settings.dart | Identità e selettore robot, distinto dalle voci AI | Metadati e UI realizzabili senza hardware |
| Configurazione agente, strumenti MCP e cronologia chat | settings.dart, mcp_page.dart, conversation_page.dart; integrazione XiaoZhi | Collegare i nostri provider e strumenti, cronologia consultabile separata dai ricordi | Backend/UI e test senza hardware; non riusare token o agenti XiaoZhi come credenziali OpenAI/ElevenLabs |

Il rilevamento del volto qui usa la camera del telefono: non dimostra un riconoscimento autonomo di persone/oggetti sulla camera del robot. Il codice della bocca nel mirroring usa la probabilità di sorriso; non è automaticamente sincronizzazione delle labbra con l'audio. I parametri servo originali non vanno copiati direttamente nel MOD senza conversione di unità e calibrazione.

## Trasporto: il lavoro prioritario

network/device_message_transport.dart preferisce il collegamento LAN al robot previsto e ripiega sul canale remoto. network/local_area_network_service.dart definisce frame SC versione1 con header20byte, sessione, sequenza e lunghezza; il remoto ha framing diverso. La LAN non è un semplice endpoint HTTP della camera da aprire: l'app annuncia il proprio endpoint al firmware attraverso il canale remoto (lan_endpoint_announcer.dart) e gestisce una procedura di autenticazione. Il codice specifica che l'handshake RSA serve per autenticare, non equivale a cifratura del traffico applicativo.

Possiamo sviluppare e testare codec Swift/TypeScript, framing, validazione, gestione riconnessioni e un robot simulato prima dell'hardware. Vanno poi scelti e verificati il protocollo effettivo, la direzione della connessione, l'autenticazione e la compatibilità del firmware fisico. Non possiamo promettere che basti collegare l'app al firmware di fabbrica senza modificarlo o configurarlo. Il nostro endpoint audio Cloudflare e il BLE MediaPipe del MOD non sono già compatibili con tutti questi messaggi.

## Stato successivo: implementazione Live

Video, testa, chiamata, imitazione del viso e immagini hanno ora un percorso software app/relay/MOD: [dettagli e limiti](LIVE-IPHONE-ROBOT-it.md). Prova remota passata con dispositivo virtuale. Non è una replica del protocollo di fabbrica né un collaudo fisico; Studio rimane un simulatore.

## Ordine originariamente proposto

1. Contratto unico app/robot e simulatore, con stato attendibile, capacità e conferma dei comandi. È la base per sostituire i controlli disabilitati con controlli reali.
2. Comandi testa e acquisizione di una foto; in seguito video live, verificando costi/banda e arresto alla chiusura della schermata.
3. Libreria espressioni/gesti e editor di coreografie con anteprima, luci e musica. Conservare sempre la precedenza dell'arresto e l'esclusione tra tracking e danza.
4. Chiamata telefono/robot e mirroring delle espressioni del telefono.
5. Configurazione robot/Wi-Fi, strumenti e cronologia, ampliando solo quanto utile per l'uso personale.

Account/community/mappa/post dell'app originale sono componenti sociali separati; non servono per ottenere un assistente personale con memoria. Non è stata verificata una schermata di aggiornamento firmware dall'app: l'OTA è documentata per il prodotto, ma non va attribuita a una funzione iPhone solo dal nome Version nelle impostazioni.

La sola lettura originaria del repository non aggiungeva funzioni (il successivo sviluppo Live è documentato separatamente): nessun deploy, flash, associazione, accesso alla fotocamera o registrazione audio eseguiti.

## Fonti ufficiali

- https://github.com/m5stack/StackChan/blob/28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400/README.md
- https://github.com/m5stack/StackChan/tree/28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400/app/lib/view/home
- https://github.com/m5stack/StackChan/blob/28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400/app/lib/network/local_area_network_service.dart
- https://docs.m5stack.com/en/StackChan
