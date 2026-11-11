# Memoria permanente di Robottino

Archivio SQLite dedicato RobotMemory, binding ROBOT_MEMORY, nello stesso Worker robottino-stackchan ma separato dalla cronologia ChatSession. Nessun binding, ID di database o credenziale di altri progetti. Proprietario unico associato al token Robottino; gli ID di proprietario non sono selezionabili dal client.

API autenticata: GET /api/memories elenca i ricordi; POST /api/memories riceve un comando JSON.

Azioni: remember (text, kind profile/fact/preference, expiresAt opzionale in millisecondi), update (id, text), forget (id), forget_match (text: elimina solo se un unico ricordo corrisponde, altrimenti `ambiguous`/`not_found`), recall (query; senza query restituisce fino a 12 ricordi di ogni tipo, prima i profili), list, prepare_clear e clear (confirmation restituita da prepare_clear). La conferma vale 2 minuti, una sola volta e viene invalidata da nuovi salvataggi. Nessuna cancellazione totale senza questa conferma.

Massimo 100 ricordi, 500 caratteri ciascuno. Provenienza explicit_user_command e date di creazione/aggiornamento. Scadenza applicata in lettura. I filtri rifiutano credenziali comuni ma non garantiscono di riconoscere ogni possibile segreto: non inserire mai password o chiavi. Nessun audio nell'archivio ricordi. Le copie di recupero della piattaforma non sono eliminate dalla cancellazione logica.

Nel WebSocket inviare {"type":"memory.command","command":{"action":"remember","text":"Mi piace il mare"}} oppure {"type":"memory.command","text":"Ricorda che mi piace il mare"}. Risposta memory.result. Comandi non inoltrati al provider come istruzioni. Ricordi di profilo disponibili all'apertura di entrambe le modalità; recall permette recupero pertinente delle altre informazioni. In assenza di memoria, la voce continua.

Per Live 1 non si salvano automaticamente frammenti di trascrizione: il client deve inviare il comando dopo aver determinato la frase completa. I comandi naturali di correzione e cancellazione singola saranno risolti dall'app scegliendo l'ID esatto; il backend non elimina ricordi per somiglianza. Le risposte memory.result vanno mostrate/riprodotte dal client.

La cancellazione dei ricordi permanenti non cancella la cronologia recente già presente nelle sessioni né contesti già inviati ai provider. Terminare e ripartire con sessionId nuovo per non riutilizzare contesti precedenti. Gestione unificata della cancellazione fra tutte le sessioni ancora da completare.


Frasi vocali riconosciute: «Ricorda che…», «Dimentica che…», «Cosa ricordi/sai di me?», «Cosa ricordi di/del/della…?», «Dimentica tutto» (conferma sullo schermo dell’iPhone).
