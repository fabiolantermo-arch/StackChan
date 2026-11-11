# Danza e tocco: fonti e stato

Verifica del 6 novembre 2026. Nessun robot è stato flashato e nessuna danza fisica è stata eseguita.

## Due basi diverse

- Stack-chan Moddable, commit 906ee9a0cd2a0107a24c714efb10274f3b546afa: https://github.com/stack-chan/stack-chan . Il codice host riconosce carezze avanti/indietro sul sensore testa: firmware/host/app/default-behavior/on-context-created.ts. Il modulo pubblico TouchPanel espone subscribe e la rimozione del listener; il nostro MOD usa questa API e il proprio callback Piu per il viso.
- Firmware di fabbrica M5Stack, commit 28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400: https://github.com/m5stack/StackChan . Qui si trovano firmware/main/stackchan/modifiers/dance.h e firmware/main/apps/app_dance/app_dance.cpp, oltre a coreografie/editor nell'app Flutter. È codice C++/ESP-IDF/LVGL, non un MOD JavaScript direttamente caricabile nel nostro host. Il README avverte che i sorgenti pubblici possono arrivare dopo i rilasci di firmware/app.

## Adattamento Robottino

Ricevitore tocco con sorriso temporaneo, senza voce automatica o scritture di memoria, con movimento subordinato alle condizioni riportate sotto. Conserva la bocca pilotata da FaceState. La temporizzazione della danza Happy è usata come riferimento per una sequenza breve originale ridotta: 4.2 secondi, oscillazione relativa della testa di ±0.15 rad, transizioni serializzate, niente musica/LED. Non converte direttamente unità/velocità dei servi di fabbrica.

Un solo proprietario software del movimento: tracking oppure danza. La danza richiede attivazione esplicita dei movimenti nel menu e attende la fine della posa precedente; i rilevamenti durante la danza non vengono accodati. Alla fine si attende un bersaglio fresco. Disattivazione/arresto mantiene l'ultima posa comandata, non ordina un salto al centro né toglie improvvisamente coppia. Una transizione già inviata può terminare.

Il tracker non avanza più una posa virtuale mentre i movimenti sono spenti, evitando che il primo comando dopo l'attivazione parta da una posizione mai richiesta ai motori. Questi limiti software NON sostituiscono la misura della posizione iniziale e la calibrazione del K151 fisico.

## Convalida e limiti

31 test del progetto e 8 prove di capability del MOD passati, typecheck riuscito e archivio release ricompilato con SDK ufficiale Moddable 10.0.2. Licenza MIT M5Stack e Apache-2.0 Stack-chan conservate con sorgenti e archivio. Restano da verificare hardware/firmware/partizioni, calibrazione, coordinate e direzioni reali, resa Piu, condivisione bus sensori e risposta dei servi.

L'app iPhone ha ancora solo la simulazione dei movimenti e la sezione camera predisposta: il collegamento reale app/cloud/robot non è implementato e nessun pulsante iPhone avvia questa danza. L'aggiornamento dell'app è compilato e firmato ma l'iPhone continua a non offrire la connessione attendibile per installarlo (CoreDevice 4016). Lo script di aggiornamento rimane disponibile per quando il telefono sarà collegato e sbloccato.

Aggiornamento tocco: carezza sulla testa o tocco sul volto mostrano sorriso e cuori rossi sfumati per circa3 secondi. Un piccolo movimento con ritorno alla posa precedente è previsto solo con hardware verificato, calibrazione confermata, motori attivati localmente e nessun comando remoto/danza in corso. Stop, disattivazione o errore interrompono la sequenza senza avviare il ritorno. La resa delle decorazioni, i sensori e il movimento non sono ancora provati fisicamente.
