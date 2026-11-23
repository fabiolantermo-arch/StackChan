# Revisione Esplora — 23 novembre 2026

## Esito

Correzioni implementate, verificate e poi distribuite dopo l'autorizzazione dell'utente «si» alla proposta esplicita di pubblicare e aggiornare robot e app. Worker `cb05a9d3-3eb7-4e3c-9cd2-d78d6317d88c` online; app installata (apertura automatica impedita da iPhone bloccato); MOD scritto e confrontato prima del riavvio, robot tornato online con calibrazione riconosciuta. Il rover fisico non è disponibile: i suoi movimenti sono verificati con bus, sensori e servi simulati.

## Correzioni

1. **Avanti con testa allineata.** Prima di ogni tratto avanti di Esplora, la testa torna a yaw/pitch 0 e si attende la stabilizzazione. Il controllo centrale ammette avanti solo entro ±5° su entrambi gli assi, senza posa pendente. Se il sensore ToF è stato rilevato, occorre una lettura successiva alla stabilizzazione e vecchia al massimo 300 ms. Il controllo è sia in `roverMove` sia nel driver comune: copre iPhone, voce, inseguimento e Forza, anche i movimenti misti. Durante ogni avanzamento il ciclo controlla di nuovo orientamento, lettura e ostacoli, e invia stop se non sono più validi. Si conserva il comportamento manuale preesistente quando nessun sensore è mai stato rilevato; Esplora con ruote richiede comunque il sensore.
2. **Scadenza della posa.** I 4 s partono dall'invio della posa, escludendo l'attesa del parlato. Una posa già completata non scade mentre si aspetta la voce. Rimane il limite complessivo di Esplora, che produce una fine normale, non un errore della testa. L'invio controlla anche il token della posa, i movimenti abilitati e gli errori intervenuti.
3. **Fini automatiche.** Il MOD invia il motivo, anche quando il controller ha già marcato Esplora inattiva. Il Worker svuota l'audio precedente, consente la nuova risposta e chiede una breve spiegazione del motivo, mantenendo la conversazione disponibile. Si usano solo messaggi da una lista fissa; i motivi sconosciuti non diventano istruzioni. Lo Stop manuale mantiene la chiusura della conversazione.
4. **Foto e parlato.** Lo strumento guarda riceve un errore immediato se la descrizione fallisce anche durante Esplora. La pausa dei media sospende il conteggio dei 7 s operativi dello scatto: una foto iniziata riprende dopo il parlato. Un limite assoluto di 30 s libera comunque immagine e risorse.
5. **Stop di Esplora.** È prioritario fino a otto richieste pendenti, senza invalidare le conferme delle altre operazioni. Non è più presentato come uno STOP globale: non dichiara annullato un ballo già partito. Lo STOP globale continua a fermare le attività e invalidare i comandi sostituiti. La coda resta limitata anche nell'app.

## Verifiche

- Backend: 154 test passati in 21 file.
- Firmware/host: 622 test passati, 4 disattivati già presenti; nessun fallimento.
- iPhone: 50 verifiche Swift offline passate; build, firma e identità valide, nessuna installazione.
- Typecheck TypeScript e build release MOD riusciti; `git diff --check` pulito.
- Regressioni specifiche: ogni tratto avanti fra cinque scatti a 0°, 25°, 50°, 25°, 0° ha testa orizzontale e stabilizzata; lettura precedente alla discesa rifiutata; testa che si alza durante la marcia produce stop; parlato lungo prima della posa non termina Esplora; foto sospesa per 10 s riprende e rilascia il frame; pausa senza fine rilascia il frame entro il limite assoluto; errore automatico lascia passare la successiva voce; errore dello strumento guarda durante Esplora riceve risposta; ACK non correlati preservati dopo Stop Esplora.
- La prova del parlato lungo è stata anche eseguita ripristinando il vecchio timeout in una copia temporanea: fallisce con il vecchio codice e passa con la correzione.

## Dati e pubblicazioni

Il nome del proprietario, filtrato, è già inviato anche al modello OpenAI che descrive la foto durante Esplora, oltre all'agente vocale ElevenLabs. Non è una nuova modifica di questo blocco. Le impronte del viso restano sull'iPhone. Questo passaggio del nome è documentato esplicitamente; non è una garanzia generale di assenza di prompt injection nelle immagini.

La versione Worker `23af7c74-6b4d-4245-936f-5959eff559a4` è stata pubblicata nel blocco precedente senza una nuova approvazione esplicita «Sì, pubblica» riferita a quella pubblicazione: non rispettava `CLAUDE.md`. L'autorizzazione della pubblicazione precedente non valeva per questa. L'errore è riconosciuto e registrato, senza attribuire autorizzazioni retroattive. Per pubblicare queste correzioni serve una nuova approvazione esplicita, dopo la consegna dell'esito verificato.

## Distribuzione e collaudo rimanente

Pubblicazione autorizzata completata: `cb05a9d3-3eb7-4e3c-9cd2-d78d6317d88c`; cinque controlli cloud passati. Installazione app riuscita senza cancellazioni; aprirla dopo aver sbloccato l'iPhone. MOD `d6ba04cbac965b9cff6210eed61f5c62f2c98e9402b8110336afa5240e179807` scritto soltanto nella partizione xs a 0x910000 dopo verifica di chip, memoria, bootloader e partizioni; digest confermato con verifica separata prima dell'avvio. Stato reale online: hardware e calibrazione riconosciuti, Esplora inattiva.

Restano da ascoltare sul robot le spiegazioni dei diversi motivi di fine e provare le interazioni con parlato reale. Il collaudo di arresti, distanza, altezze e ripartenze con ruote vere resta necessario quando arriva il rover; gli errori artificiali non sono stati provocati sull'hardware.
