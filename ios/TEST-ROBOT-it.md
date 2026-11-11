# Scheda Test nell'app iPhone

La scheda Test è separata da Robot e Ricordi, con pulsante Indietro. Robot e Ricordi conservano recupero del token dal Portachiavi e verifica automatica del backend all'apertura/ritorno in primo piano.

## Disponibile in questa versione

- Simulazione dei movimenti attivabile esplicitamente, disattivata all'uscita dalla scheda e quando l'app non è attiva.
- Sinistra/destra/su/giù a passi di 5°, centro e arresto della sola simulazione; limiti ±10°. Nessuna richiesta di movimento inviata al backend.
- Verifica di disponibilità tramite richiesta autenticata GET `/api/robot/status`. La route è ora distribuita e risponde200 con connected=false quando il robot è offline. Il collegamento operativo è nella nuova scheda Live, non nei controlli simulati Test.
- Sezione telecamera del robot con stato non disponibile e pulsante disabilitato. Non usa la fotocamera dell'iPhone e non mostra immagini simulate.

## Da implementare sul collegamento reale

La scheda Test mantiene i propri controlli simulati. La nuova [scheda Live](../docs/LIVE-IPHONE-ROBOT-it.md) implementa video, testa, chiamata, imitazione del viso e invio immagini con conferma dei comandi. Richiede un MOD configurato e compatibile: nessun flash eseguito.

## Verifiche

`node ios/test-connection.mjs` compila il modello Swift di produzione con rete e Portachiavi simulati ed esegue sei verifiche: recupero token/riconnessione, persistenza dopo riavvio, protezione da token errato, primo avvio senza token, simulazione limitata senza comandi di rete e controlli reali disabilitati con bridge assente/positivo non verificato. Non sono test della UI sul dispositivo né della camera fisica.

Compilazione iOS e verifica firma riuscite. L’aggiornamento completo, inclusa la scheda Live, è stato installato e avviato sull’iPhone fisico il6 novembre2026 alle22:52, senza disinstallare l’app precedente. Usare `Update Robottino.command` quando il telefono è collegato e sbloccato.

Lo script compila in una cartella temporanea privata fuori da Documenti, per evitare che i metadati Finder/iCloud invalidino la firma. Sorgenti e log rimangono in Robottino; verifica firma, team e bundle ID rimangono obbligatori.
