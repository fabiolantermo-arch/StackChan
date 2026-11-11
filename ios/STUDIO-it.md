# Studio Robottino — editor danze, espressioni e simulatore

Implementato nell'app iPhone nella quarta scheda **Studio**, separata da Robot, Ricordi e Test. Le tre voci aprono Editor danze, Espressioni e Simulatore collegamento. Il volto riusa i sei ritratti già creati per Robottino, senza modificare l'icona dell'app.

## Editor danze

- Danza di esempio, nuova danza, nome, aggiunta/modifica/eliminazione/riordino dei passi, duplicazione e libreria locale persistente. Eliminazione delle danze salvate con conferma.
- Ogni passo contiene orientamento orizzontale/verticale, durata, espressione e colori indipendenti delle due luci simulate.
- Limiti dell'editor: ±10° per asse, 300–5000 ms per passo, 1–32 passi, durata nominale totale massima 60 secondi. Sono limiti dell'anteprima, non una calibrazione o un profilo cinematico del robot fisico.
- Riproduzione con anteprima del volto, orientamento, luci e passo corrente. Attende la conferma simulata di ogni comando prima della sua durata. La latenza simulata si aggiunge alla durata nominale; non è una timeline musicale a precisione di campione.
- Salvataggio atomico JSON in Application Support/Robottino/dances-v1.json nel contenitore dell'app. Permessi600 e protezione file iOS. Un archivio corrotto non viene sovrascritto automaticamente.
- Importazione/esportazione JSON versione1 tramite File. Validazione di dimensione, numero/ID dei passi, nomi, numeri finiti, angoli, tempi e versione. Importare crea nuovi ID e richiede Salva: non sostituisce automaticamente danze già presenti.

## Musica locale facoltativa

File MP3/M4A/WAV/AAC/CAF selezionato dall'utente tramite File, entro20MB e10minuti, verificato con AVAudioPlayer e copiato nel contenitore locale protetto. Il percorso interno usa un UUID; non sono ammessi percorsi arbitrari importati da JSON. Parte dal primo passo confermato e termina con la sequenza, lo stop, un errore o l'uscita/attività sospesa dell'app. Riproduzione sull'iPhone, non sull'altoparlante del robot. Nessun microfono utilizzato.

Il JSON esportato non incorpora il file musicale. Importando una danza da un altro dispositivo viene rimossa la vecchia associazione audio: la traccia va selezionata di nuovo. Rimuovere l'associazione o cancellare una danza non elimina automaticamente i file audio copiati, perché altre copie della danza potrebbero ancora usarli.

## Espressioni

Sei pose: Serena, Felice, Pensierosa, Ammiccamento, Bocca socchiusa, Bocca aperta. Anteprima e aggiunta come passo nell'editor. Il pulsante Prova nel simulatore invia un comando locale confermato, senza generare voce. Non è ancora un editor di disegno dei volti o di deformazione delle pupille.

## Simulatore collegamento

Stati scollegato/collegamento/collegato/errore; ritardo impostabile0–1000ms e guasti selezionabili (nessuna risposta/comando rifiutato). Comandi e conferme con ID, sequenza, deduplicazione e controllo di riutilizzo dell'ID con payload diverso. Un solo comando in attesa; cache128 conferme e log40 eventi.

Stop invalida i comandi pendenti senza applicare conferme tardive e mantiene l'ultima posa. La disconnessione invalida anche l'attesa dell'ultimo passo, evitando un falso completamento della danza. Nessuna riconnessione implicita. Uscita dalla scheda Studio o app non attiva interrompono riproduzione, audio e connessione simulata.

Questo è un doppio software **in memoria**, non un simulatore del protocollo binario del firmware M5Stack né del trasporto BLE/Wi-Fi fisico. Non apre socket, non chiama il backend, non muove motori, non acquisisce la telecamera e non produce comandi reali. Gli eventuali accessi al backend nelle schede Robot/Ricordi restano indipendenti.

## Verifiche eseguite

`node ios/test-connection.mjs`:18 gruppi di verifiche Swift passati sul modello di produzione, incluse le regressioni di token/riconnessone, persistenza/duplicazione/importazione, rifiuto di dati non validi, protezione dell'archivio corrotto, conferme duplicate e tardive, stop/disconnessione durante l'attesa, riproduzione ordinata, importazione audio WAV e mancato utilizzo della rete nello Studio.

Build iPhone completata e firma Apple verificata. Build simulatore completata e processo avviato su un dispositivo dedicato Robottino Studio QA. Controllo visivo della UI non completato: nell'ambiente accessibile non è disponibile la finestra dell'app Simulator, pur essendo presenti runtime e strumenti da terminale. Riproduzione sonora effettiva sull'iPhone e selettori File richiedono ancora prova manuale.

L’app completa è stata installata e avviata sull’iPhone fisico senza disinstallare la versione precedente; i successivi aggiornamenti riusano lo stesso contenitore. Per installare: collegare/sbloccare l'iPhone e usare Update Robottino.command. Non è stata disinstallata la versione precedente. Nessun deploy cloud o flash firmware effettuato.

## Fonti delle API native

- https://developer.apple.com/documentation/avfaudio/avaudioplayer
- https://developer.apple.com/documentation/swiftui/view/fileimporter(ispresented:allowedcontenttypes:oncompletion:)
