# Reti di Robottino: casa e hotspot iPhone

La scheda Robot ora presenta la sezione Wi-Fi per prima e Collegamento sicuro per ultima, dopo Modello e voce e Stato.

## Due profili

- **Wi-Fi di casa:** nome esatto della rete e password. È la rete con priorità.
- **Hotspot dell’iPhone:** nome della rete dell’hotspot e password. È l’alternativa quando non c’è il Wi-Fi di casa.

«Salva e invia al robot» conserva entrambi nel Portachiavi locale, con accessibilità solo a telefono sbloccato e senza migrazione su altri dispositivi. Nessun file JSON, UserDefaults, log o servizio cloud riceve le password. I campi password sono mascherati. Le password non salvate vengono rimosse dalla bozza uscendo dalla scheda o passando in background; quelle salvate possono essere rilette dal Portachiavi quando l’app torna attiva. Rimuovi profili da questo iPhone richiede conferma e cancella soltanto la voce dedicata del Portachiavi, senza cambiare token, ricordi o configurazione del robot.

È possibile salvare un solo profilo completo, oppure entrambi. I nomi delle due reti devono essere differenti. I nomi sono conservati esattamente come digitati, inclusi spazi significativi, entro32byte UTF-8. Password WPA in formato comune8–63 caratteri ASCII oppure64 cifre esadecimali; questa validazione non è una prova di compatibilità o autenticazione sul firmware fisico.

## Hotspot

In Impostazioni dell’iPhone → Hotspot personale attivare Consenti agli altri di accedere e Ottimizza la compatibilità. Il nome dell’hotspot corrisponde al nome dell’iPhone; copiarlo esattamente con la relativa password. Non viene inventato un nome leggendo il valore generico iPhone fornito alle app.

Il K151 richiede una rete a2,4GHz. Apple documenta che Ottimizza la compatibilità limita l’hotspot a quella banda. L’hotspot usa dati cellulare e dipende da piano/operatore e copertura. La nostra app non attiva silenziosamente l’hotspot e non cambia impostazioni di sistema.

## Disponibile e ancora da collegare

**Disponibile:** moduli per i due profili, salvataggio/rilettura/rimozione nel Portachiavi, controllo dei dati e pulsante Controlla robot online. Quest’ultimo legge soltanto lo stato autenticato del relay: distingue robot raggiungibile, offline, dispositivo virtuale ed errore. Non dimostra quale rete sia in uso, né che la password immessa sia corretta. Il controllo non invia le credenziali.

**Non ancora operativo sul robot:** il pulsante Invia profili al robot è disabilitato. Servono verifica modello/firmware, metodo locale sicuro di associazione e installazione dei profili sul robot. Salvare sull’iPhone non configura il Wi-Fi del robot.

La politica desiderata è implementata nel modulo puro network-profiles.js e testata: preferisce casa, sceglie hotspot se solo quello è visibile, ignora reti sconosciute e canali5GHz, rispetta reti temporaneamente bloccate e non cambia rete durante una chiamata/attività indicata come occupata. Quando inattivo può preferire casa se torna visibile. Un singolo risultato di scansione mancante non interrompe una connessione ancora attiva.

Questo modulo **non è collegato al driver radio o al ciclo di avvio**, non scansiona e non modifica reti reali. L’host upstream attuale memorizza una sola coppia SSID/password in stored-wifi.ts: il passaggio automatico tra due profili richiede ancora un adattatore per il firmware verificato, tentativi/timeout e prove di perdita/ritorno rete. Il modulo di selezione non è incluso nel MOD attivo per evitare di sostituire la gestione Wi-Fi dell’host senza hardware. Nessun flash eseguito.

Il firmware di fabbrica M5Stack configura la rete attraverso la propria associazione Bluetooth; non è automaticamente lo stesso protocollo dell’host community Moddable. Non vengono spedite password al vecchio protocollo o al backend per aggirare questa verifica.

## Test

Prove Swift sul modello di produzione con Portachiavi/rete sostituiti: due profili conservati e ripristinati, SSID esatti, limiti e duplicati rifiutati, cancellazione e rimozione delle password dalla bozza, stato online via GET senza corpo e nessun invio abilitato. Test della selezione reti: casa/hotspot, priorità indipendente dal segnale, reti sconosciute/5GHz, rete esclusa, cambio mentre occupato, scansione vuota e profili ambigui. Verifica complessiva ripetibile con Verify Robottino.command; accesso reale a router/hotspot e cambio automatico sul robot non collaudati.

## Fonti

- [M5Stack K151: rete2,4GHz e associazione iniziale](https://docs.m5stack.com/en/StackChan).
- [Apple: connessione all’hotspot personale](https://support.apple.com/it-it/111785).
- [Apple: sicurezza e modalità di compatibilità2,4GHz](https://support.apple.com/it-ch/guide/security/secfd166f620/web).
- Upstream locale fissato: firmware/host/modules/connectivity/stored-wifi.ts, network-manager.ts e network-service.ts; app di fabbrica: device_wifi_config.dart. Nessuna loro gestione di reti è stata modificata.

## Percorso locale individuato nel firmware Stack-chan (7 novembre 2026)

Lettura del codice upstream fissato (`host/app/setup-mode.ts`, `host/modules/connectivity/preference-server.ts`, `preference-write-guard.ts`, `preferences/consts.ts`), non provata su hardware:

- Aprendo **Impostazioni** sul robot, l’host avvia un server Bluetooth LE di tipo UART (servizio `6E400001-B5A3-F393-E0A9-E50E24DCCA9E`, nome `STK`) e apre una **finestra di scrittura di 5 minuti**. Fuori dalla finestra le scritture vengono ignorate.
- Il telefono scrive JSON sulla caratteristica RX, anche spezzato in più pacchetti (riassemblato entro 3 secondi): `{"_batch":{"wifi.ssid":"…","wifi.password":"…"}}`. Sono accettate solo le chiavi elencate in `PREF_KEYS`, tra cui `wifi.ssid` e `wifi.password`.
- L’host memorizza **una sola rete**. I due profili casa/hotspot richiedono comunque l’adattatore descritto sopra (`network-profiles.js`).
- **Limite di sicurezza, accettato dal proprietario il 7 novembre 2026:** il canale UART non cifra i dati a livello applicativo. Durante i 5 minuti, chi è nel raggio Bluetooth potrebbe intercettare la password; il robot rimanda anche i valori correnti in notifica. Il percorso resta locale (niente cloud).
- **App:** scheda Robot → Wi-Fi del robot → «Salva e invia al robot»: dopo il salvataggio nel Portachiavi invia da sola entrambe le reti, prima l’hotspot e poi casa, nella stessa sessione Bluetooth con 1,5 s di pausa tra le due (premerlo di nuovo ripete l’invio). Prima va aperta la finestra Impostazioni sul robot (5 minuti). L’app cerca il servizio, attiva le notifiche, scrive pezzi UTF-8 da 60 byte con conferma e dichiara il successo solo quando il robot notifica `wifi.ssid` e `wifi.password` uguali a quelli inviati (o li riportava già uguali). Timeout: 20 s per trovare il robot, 8 s per la conferma.

Prima dell’uso reale: confermare che il K151 esegua questo host e non il firmware di fabbrica M5Stack (che usa la propria associazione), verificare UUID e nome sul dispositivo, e provare scrittura e riavvio della rete.

## Passaggio automatico casa/hotspot (7 novembre 2026, solo compilato e testato in simulazione)

Il firmware di base ha un solo posto per la rete (`wifi.ssid`/`wifi.password`) e via Bluetooth accetta solo quelle due chiavi. Il MOD (`wifi-switch.js`) esporta `onLaunch`, che il firmware esegue **prima** di collegarsi:

1. esegue senza modifiche il passaggio originale del firmware (`app-default-behavior/on-launch`: splash, Impostazioni, gestione MOD) e intanto, ogni 300 ms, legge la rete salvata: ogni rete nuova scritta durante le Impostazioni viene ricordata nel dominio `robottino` (`net0ssid`/`net0pass` principale, `net1ssid`/`net1pass` riserva; l’ultima scritta diventa la principale). Un robot già configurato conserva la sua rete come principale;
2. se ricorda due reti, cerca le reti visibili (`wifi-scan` del firmware, massimo 6 s) e mette nel posto del firmware la principale se è visibile, altrimenti la riserva; se non ne vede nessuna non cambia nulla e il firmware mostra la sua schermata «riprova / senza rete».

Le password restano nel robot e nel Portachiavi dell’iPhone: non passano dal server. Il MOD esporta `onLaunch` solo se il firmware ha il modulo `app-default-behavior/on-launch`, così la modalità Impostazioni non si perde mai. Da verificare sul K151: che il firmware legga la rete dalle preferenze (alcune configurazioni speciali di prova la fissano a vuoto in fase di compilazione), la durata reale della ricerca e il riavvio con la rete di riserva.
