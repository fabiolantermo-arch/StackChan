# Schede NFC sul robot: studio (21 novembre 2026)

Studio fatto su richiesta dell’utente, dopo la foto della scheda «NTAG215 NFC Card» di M5Stack («Vuoi che studi come far leggere schede NFC al robot?» — «Sì, studialo»). Il codice è stato preparato lo stesso giorno («Sì, preparalo»): vedi «Stato» qui sotto. **Niente è stato provato sul robot.**

## Stato (21 novembre 2026, pomeriggio)

- **Fatti i passi 1 e 2 della proposta.** `firmware/stackchan-mod/nfc.js` (`NfcCards`, limiti in `NFC`) con 7 prove su un lettore finto in `nfc.test.mjs`, più una prova del MOD intero in `mod.test.mjs` («NFC: no reader until switched on…»).
- In `mod.js` c’è un solo nome nuovo, `nfc`, più l’import: la pila passa da 403 a **405 caselle** (limite 446).
- Voce «NFC: sì/no» nel menu grande, preferenza `nfc`, spenta di serie. La voce compare solo se l’host offre il lettore e se ci stanno ancora le voci che seguono, così «Chiudi» non sparisce mai. Manca solo con «Hardware: no», due reti e un tasto di prova insieme.
- **Quando controlla** (dopo la prima prova): una volta al secondo, con il campo radio acceso finché il robot è libero. Non controlla durante conversazione, chiamata o comandi dall’iPhone, frasi e suoni, calibrazione, risveglio, ballo, pulsante di accensione, e mentre un comando ai servi aspetta la conferma. Controlla invece mentre il robot dorme. **Controlla invece mentre il robot segue da solo il tuo viso**: l’inseguimento è quasi sempre acceso, e se fosse escluso non controllerebbe mai.
- **Cosa fa con una scheda**: per ora la mostra sullo schermo («Scheda NFC: 04…») e la scrive sul registro (`[robottino] nfc card <uid> <tipo>`). Le azioni vere sono il passo 4.
- **Registro**: `nfc ready`, `nfc card`, `nfc removed`, `nfc open failed …`, e ogni minuto `nfc polls N worst W ms`, il tempo peggiore di un controllo: è la misura che manca.
- **Errori**: lettore assente → «NFC: lettore non trovato.», detto una volta, senza altri tentativi. Tre controlli falliti di fila → lettore chiuso, «NFC: il lettore non risponde. Riprovo tra un minuto.»
- **Prima prova sul robot (21 novembre 2026, 13:49–13:52, MOD `059dfa1b`)**: host, bootloader e partizioni identici a `host-2026-11-17`; MOD scritto e verificato, avvio regolare (pila a posto). La prima volta la voce «NFC» non era nel menu; poco dopo sì (causa non chiarita). Alle 13:51:01 **`nfc ready`: il chip c’è e risponde**. Poi `nfc polls 48 worst 80 ms`: **nessuna scheda letta** in 48 controlli, e **un controllo arriva a 80 ms**, più del triplo della stima, perché il campo si riaccendeva a ogni controllo con l’attesa del driver sul bus. Il robot ha dormito quasi tutto il tempo (si addormenta dopo 30 s da solo) e lì non controllava. Alle 13:52:39 l’utente ha staccato il cavo.
- **Corretto dopo la prova (MOD `e89abac5`, da scrivere)**: il campo resta acceso finché l’NFC è attivo e il robot è libero, e si spegne quando è occupato. Il robot controlla **anche mentre dorme**. Da vedere alla prossima prova: se legge la scheda, dove, e il nuovo tempo peggiore (atteso 20–25 ms). Il campo sempre acceso consuma batteria: da misurare se il robot va senza cavo.

## In breve

- Secondo l’etichetta, il robot ha un **lettore NFC**, il chip ST25R3916 sul bus I2C interno (G12/G11, indirizzo 0x50). Ci sono anche il sensore a sfioramento Si12T (0x68), l’IMU (0x69) e il PY32 (0x6F), che dà corrente ai servi e accende i LED.
- **L’host che è sul robot ha già il driver.** Nel file `firmware/artifacts/host-2026-11-17/xs_esp32.bin` ci sono i moduli `embedded:sensor/RFID/ST25R3916` e `embedded:sensor/RFID/ndef`. Li mette la piattaforma originale `m5stackchan_cores3` (upstream `906ee9a`, Moddable 10.1.0), che offre il lettore come `device.sensor.RFID`. Il lettore non si accende da solo: lo crea solo un MOD che lo chiede. **Quindi basta il MOD, senza riscrivere l’host.**
- La scheda della foto (NTAG215) è del tipo che il driver sa leggere: ISO 14443 A, «Type 2». Il driver legge il suo numero di serie (UID, 7 byte) e il contenuto NDEF (per esempio un indirizzo web).
- Per usarla come «pulsante» basta il **numero di serie**: non serve scriverci niente. Così va bene anche se M5Stack l’ha bloccata in scrittura.

## Come funziona il driver (letto nel codice, non misurato)

- Non c’è un segnale «scheda arrivata». Il MOD deve chiedere a intervalli regolari con `sample()`. La risposta è `{present:true, uidHex, sak, type}` quando una scheda arriva, `{present:false}` quando va via, e niente se non cambia nulla. Una scheda tenuta ferma non si ripete.
- **Ogni domanda ferma il JavaScript.** Senza scheda, il driver prova due richieste radio (REQA e WUPA). Per ciascuna aspetta fino a 10 ms leggendo di continuo il bus I2C. Dopo 8 domande a vuoto riaccende il campo radio: fino a 20 ms in più, più 5 ms di pausa. **Stima dal codice: circa 20–25 ms bloccati per domanda.** Ogni 250 ms vuol dire circa il 10% del tempo del MOD; ogni secondo, circa il 2–3%.
- Il driver nasconde i propri errori: un `undefined` non prova che il lettore funzioni.
- Dopo varie domande a vuoto, il driver può riaccendere il campo radio da solo. L’esempio originale (`work/stack-chan-upstream/firmware/mods/examples/rfid/`) per spegnere il lettore lo chiude e basta: va fatto anche noi.
- Lettura NDEF: solo schede Type 2 (NTAG, Ultralight). Scrittura solo su schede già formattate e non bloccate. MIFARE Classic (molti badge e tessere) non è supportato: di quelle si legge solo il numero di serie.

## Rischi per Robottino

1. **Tempo rubato al resto.** Inseguimento del viso, pezzi della camera, audio della chiamata e della conversazione girano tutti nel ciclo JavaScript. 25 ms fermi ogni tanto possono dare scatti o buchi nell’audio. Proposta: controllare le schede **solo a riposo** (niente chiamata, conversazione, Live o inseguimento attivo), ogni 500–1000 ms.
2. **Bus I2C condiviso.** Sullo stesso bus ci sono il PY32 (corrente dei servi e LED), il sensore a sfioramento, l’IMU e, secondo l’host, anche la configurazione della camera (SCCB sulla porta 1). Durante la prova bisogna guardare che servi, luci e tocco restino normali. Sul registro non devono comparire errori del bus.
3. **Batteria.** Il campo radio acceso consuma. Si può accendere l’antenna solo durante la domanda e spegnerla subito dopo. Costa 5 ms in più a domanda e va provato.
4. **Sicurezza.** Il numero di serie di una scheda si copia facilmente. Le schede vanno bene per comodità (avviare una chiamata, cambiare volto), **mai** per cose protette: abbinamento, Wi-Fi, token, cancellazioni.
5. **Dove appoggiare la scheda.** La posizione dell’antenna nel robot non è scritta nei documenti che abbiamo: va trovata alla prima prova.

## Proposta di lavoro (da approvare)

1. **`nfc.js`** nel MOD: un piccolo modulo che apre il lettore solo a riposo, fa una domanda ogni 1000 ms e chiude tutto (antenna spenta) appena il robot ha altro da fare. Dà solo i numeri di serie nuovi e conta gli errori. Le prove sono in `nfc.test.mjs` con un lettore finto: arrivo, rimozione, errori, chiusura, niente domande mentre è spento.
2. **Preferenza `nfc`** (spenta di serie) e voce «NFC: sì/no» nel menu grande, come per rover e sensori. Riga sul registro: `[robottino] nfc <uid>`.
3. **Prima prova sul robot** (con l’utente davanti): accendere, appoggiare la scheda della foto, leggere il numero di serie sul registro (anche il contenuto NDEF, una volta sola a richiesta). Poi misurare quanto dura davvero una domanda e se servi, luci e tocco restano normali.
4. **Solo dopo, le azioni.** Per esempio: scheda conosciuta → avvia la conversazione, oppure → cambia volto. Le schede si associano dal robot («appoggia la scheda da ricordare») o dall’app. La scelta delle azioni spetta all’utente.

## Cosa resta da verificare

- Che il chip risponda davvero a 0x50 su questo robot. Se manca, il driver dice «ST25R3916 not found».
- Il tempo reale di una domanda e l’effetto su camera, audio e servi.
- La distanza di lettura e il punto giusto dove appoggiare la scheda.
- Se la scheda M5Stack è bloccata in scrittura. Non serve per il «pulsante», solo per riscriverne il contenuto.
