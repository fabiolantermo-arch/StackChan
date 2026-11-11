# Robottino

*Versione italiana · [English version](README.md)*

Un compagno da scrivania costruito su **M5Stack StackChan K151** (CoreS3, ESP32-S3): parla, muove la testa quando glielo chiedi, cambia faccia e umore, segue un viso e ti dice che cosa vede con la sua fotocamera.

https://github.com/user-attachments/assets/97672104-78df-42dc-a973-b0203a75e100

49 secondi: il robot su una scrivania, mentre parla e si muove. Se il lettore non compare, il file è [docs/media/demo.mp4](docs/media/demo.mp4).

Sono tre parti che parlano tra loro solo attraverso il servizio cloud, quindi nessun computer deve restare acceso:

| Parte | Cartella | Che cos'è |
|---|---|---|
| Robot | `firmware/stackchan-mod/`, `firmware/host/` | Un MOD [Moddable](https://www.moddable.com/) (JavaScript, XS) sopra un host [Stack-chan](https://github.com/stack-chan/stack-chan) modificato |
| Servizio cloud | `src/`, `test/` | Un Cloudflare Worker con Durable Objects: relay della voce, collegamento robot ↔ telefono, abbinamento, memoria, vista |
| App iPhone | `ios/` | Un'app SwiftUI: video dal vivo, controllo della testa, chiamate, inseguimento del viso, impostazioni |

> **Stato: un progetto personale, funzionante su un solo robot.** Tutto quello che c'è qui gira ogni giorno sul K151 dell'autore, ma è stato provato soltanto su quell'unico esemplare. Aspettati di dover adattare delle cose. Gran parte della documentazione e tutta la lingua parlata sono in **italiano**; i commenti nel codice sono in inglese.

## Che cosa fa

- **Conversazione.** Un tocco lungo sulla testa avvia una conversazione a voce (agente ElevenLabs oppure OpenAI realtime, fatti passare dal Worker). La bocca segue l'audio; il viso segue l'umore della risposta.
- **Comandi a voce per la testa**, riconosciuti dal robot stesso dalla trascrizione e mossi dentro l'intervallo calibrato (funzionano in italiano e in inglese):

  | Dì | La testa |
  |---|---|
  | «destra», «sinistra», «guarda a destra», «girati a sinistra» | gira di 20° da quella parte (finendo sempre da quel lato rispetto al centro) |
  | «su», «giù», «alza la testa», «abbassa la testa» | si inclina di 20° |
  | «tutto su», «tutto a sinistra» | va a fine corsa dell'intervallo calibrato |
  | «guarda avanti», «al centro» | torna dritta |
  | «muovi la testa» | scuote |

- **Facce a voce.** Faccia e tono di voce cambiano insieme:

  | Dì | La faccia |
  |---|---|
  | «sorridi», «faccia felice» | sorride per qualche secondo, con una breve risata |
  | «fai la faccia triste» | diventa triste e resta triste, voce compresa |
  | «fai la faccia arrabbiata» | diventa arrabbiata e resta brontolona (mai offensiva) |
  | «torna felice» | sorride, poi torna come sempre |
  | «torna normale», «calmati», «non essere più triste» | torna subito come sempre |

- **«Cos'è questo?»** Tieni un oggetto davanti al robot e chiedi «cos'è questo?», «cosa vedi?» o «cosa ho in mano?». Scatta una foto 160×120 con la sua fotocamera, la manda sulla connessione della voce, e un modello con la vista la descrive in una frase che il robot dice. Non indovina mai: niente foto, niente risposta.
- **Collegamento con il telefono.** Dall'iPhone: video dal vivo, controllo manuale della testa, inseguimento del viso (Vision sul telefono, la testa sul robot), chiamate nei due sensi, danze.
- **Timer, promemoria, una piccola memoria permanente, ricerca sul web** tramite l'agente.

## L'app iPhone

Un'app SwiftUI nativa (iOS 18 o successivo) in `ios/`. Non è sull'App Store: si compila dai sorgenti con Xcode e si installa sul proprio telefono. L'interfaccia è in italiano.

| Scheda | Che cosa si fa |
|---|---|
| **Robot** | Vedere se il robot è in linea, incollare il token dell'app, accendere o spegnere «segui il mio viso mentre parliamo» |
| **Aspetto** | Scegliere il volto (due ragazze e un robot bianco), il modello vocale e la voce, e la **lingua**: italiano o inglese |
| **Studio** | Un editor di danze, le espressioni e un collegamento simulato, per provare senza il robot |
| **Test** | Tutto ciò che richiede il robot vero: abbinamento con un codice e Wi-Fi via Bluetooth, **Live** (la camera del robot, un joystick per la testa, l'inseguimento del viso con la camera del robot o del telefono, una chiamata attraverso il robot, immagini sul suo schermo, danze), una conversazione a voce dal telefono e **Ricordi**, ciò che Robottino ricorda di te |

Come si collega: l'app non parla mai direttamente con il robot. Tutti e due tengono una connessione con il Worker, che fa da ponte (`RobotLink`). Il token dell'app si incolla una volta (`ROBOT_API_TOKEN`, il valore che hai impostato come segreto Cloudflare) e l'app lo tiene nel Portachiavi; nessuna chiave è mai dentro l'app. L'abbinamento dà al robot un token suo, diverso.

Per compilarla: apri `ios/Robottino.xcodeproj`, imposta il tuo identificativo del pacchetto e il tuo team di firma, sostituisci l'indirizzo del Worker con il tuo (`robottino-stackchan.example.workers.dev` in `ios/Robottino/`) e avviala sul tuo iPhone. `node ios/test-connection.mjs` esegue sul Mac i test della logica dell'app senza telefono; `node ios/build-check.mjs` compila e controlla la firma senza installare.

## Hardware

- M5Stack **StackChan K151** (CoreS3, ESP32-S3 rev 0.2, 16 MB di flash, due servi seriali, camera GC0308, sensore di tocco sulla testa Si12T).
- Un iPhone per l'app (facoltativo per la conversazione, necessario per il collegamento dal vivo e per l'abbinamento).

Una build per CoreS3 da sola non prova la compatibilità con il K151: limiti dei servi, calibrazione e sensore della testa sono stati tutti regolati sul robot vero.

## Account e chiavi che servono

- Un account **Cloudflare** (Workers + Durable Objects).
- Una chiave API **OpenAI** (vista, ricerca sul web, voce realtime facoltativa).
- Un account **ElevenLabs** con un agente di Conversational AI (il percorso vocale predefinito).

Le chiavi sono **solo segreti Cloudflare** (`wrangler secret put …`): `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `ROBOT_API_TOKEN` (il token dell'app) e `ROBOT_DEVICE_TOKEN` (il token del robot; i due non sono mai intercambiabili). Niente di segreto va nel repository, nel pacchetto dell'app o nel firmware. I nomi sono in `.env.example`.

Le impostazioni semplici stanno in `wrangler.jsonc` → `vars`: `ELEVENLABS_AGENT_ID`, `OPENAI_MODEL`, `OWNER_NAME` (il tuo nome, usato nel saluto; lascialo vuoto per un saluto neutro) e `ALLOW_SWEARING` (`"true"` permette al robot di dire parolacce quando qualcuno gliele chiede; spenta per impostazione predefinita).

L'indirizzo del Worker compare come `robottino-stackchan.example.workers.dev` nel MOD del robot, nell'app e negli script: sostituiscilo con quello della tua installazione.

## Per cominciare

```sh
npm ci
npx wrangler types                      # genera le dichiarazioni dei tipi del Worker
npx tsc --noEmit
npm test                                # test del Worker (Vitest) + test del firmware (Node)
node ios/test-connection.mjs            # controlli Swift offline
```

Pubblica il Worker (il tuo account, i tuoi segreti):

```sh
npx wrangler deploy
```

Compila il MOD del robot (solo compilazione, non scrive mai sul robot):

```sh
node firmware/stackchan-mod/build.mjs
```

Le build del firmware richiedono Moddable SDK 10.1.0, ESP-IDF v6.1 e una copia di Stack-chan in `work/` (che non fa parte di questo repository); `firmware/host/build-host.mjs` applica le patch di `firmware/host/patches/` e rifiuta di compilare se i sorgenti differiscono da «base più patch». Si scrive sul robot con `esptool` (MOD a `0x910000`, host a `0x10000`); leggi prima `firmware/stackchan-mod/README-it.md`.

L'app per iPhone è `ios/Robottino.xcodeproj`: vedi [L'app iPhone](#lapp-iphone) qui sopra.

## Com'è fatto

- `docs/architecture-it.md`: componenti, rotte e chi può chiamarle.
- `docs/decisions-it.md`: decisioni tecniche e perché.
- `firmware/stackchan-mod/README-it.md`, `ios/README-it.md`: i due client.

Regole di progetto da conoscere prima di cambiare qualcosa:

- **Il robot ha una piccola memoria JavaScript fissa.** Niente di grande viene mai copiato o messo in coda: fotogrammi, immagini e audio vanno a pezzi, e ogni flusso continuo scarta dati invece di far crescere una coda.
- **Sicurezza della testa.** Ogni posa passa da una sola funzione con i limiti calibrati; un comando senza la conferma dei servi non è mai considerato eseguito; una risposta persa si ripete una sola volta.
- **Niente finzioni.** Se una chiamata API, una conferma o una foto falliscono, il robot lo dice.
- **Limiti e quote** nel Worker (voce, immagini, abbinamento) fanno parte del progetto, non sono avanzi.

## Test

Il Worker ha test Vitest eseguiti nel runtime dei Workers; il MOD è provato in Node caricando i moduli veri contro un hardware simulato (servi che perdono risposte, timer in ritardo, una camera e dei socket finti). `npm run verify` esegue l'insieme completo.

## Contribuire

Segnalazioni e pull request sono benvenute, in inglese o in italiano. Indica su quale hardware hai provato e mantieni i test verdi (`npm test`). Le modifiche a movimenti, limiti o a qualunque cosa scriva sul robot richiedono un test che fallisca senza di esse.

## Software di terzi

L'host del robot è compilato da [Stack-chan](https://github.com/stack-chan/stack-chan) (Apache-2.0) con il [Moddable SDK](https://github.com/Moddable-OpenSource/moddable); le loro licenze sono in `firmware/artifacts/THIRD-PARTY-LICENSES.txt`. Le immagini dei volti sono state generate dall'autore con strumenti di IA e sono rilasciate insieme al progetto.

## Licenza

MIT, vedi [LICENSE](LICENSE).
