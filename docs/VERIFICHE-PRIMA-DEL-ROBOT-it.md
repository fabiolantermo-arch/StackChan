# Verifica completa prima del robot fisico

Eseguita il 6 novembre 2026. Report macchina e hash dei sorgenti: work/verification/latest.json. Tutte le nove fasi richieste sono passate; nessun deploy cloud, flash, installazione o disinstallazione iPhone eseguiti da questa procedura.

## Miglioramenti verificati

- **Movimenti:** annullamento dell'attivazione anche quando la risposta arriva in ritardo; richiesta già annullata prima della chiamata al driver non viene inviata. Una sola posa in corso. Un comando di attivazione o posa senza conferma entro1200ms blocca nuovi movimenti fino al riavvio del modulo. Anche eccezioni sincrone e promesse rifiutate del driver fanno fallire la gestione senza riattivazioni implicite.
- **Tempo e dati:** MotionClock usa Time.ticks/Time.delta ufficiali Moddable e gestisce il rollover del contatore; il controllo non segue l'orologio civile. Identificativi bersaglio validati e dati non finiti/retrogradi rifiutati. Sono garanzie software, non una misura della posizione o della velocità fisica dei servi.
- **Pulizia risorse:** rilascio delle sottoscrizioni BLE anche se la seconda iscrizione fallisce, nessun riavvio del volto o reazione tardiva dopo dispose. La bocca pilotata dallo stato audio conserva precedenza sul sorriso di tocco/danza; l'ammiccamento resta possibile.
- **Ambiente npm/Cloudflare:** @cloudflare/vitest-plugin1.6.0, Vitest4.1.12 e Vite7.3.7; Wrangler4.158.0 mantenuto. Eliminato il runtime di test obsoleto e relativo fallback di compatibilità. Il vecchio npm10 ha incontrato un errore interno durante la risoluzione della migrazione nella copia isolata; il lockfile è stato generato con npm11 eseguito una tantum e poi verificato con una vera npm ci di npm10.9.3. npm globale non modificato, nessun --force/--legacy-peer-deps, backup dei file precedenti in work/verification/before-update/. Audit dell'installazione finale: zero vulnerabilità segnalate (non garanzia di assenza di ogni difetto).

## Risultati

| Fase | Esito |
|---|---|
| Generazione binding/tipi Worker | Passata |
| TypeScript | Passato |
| Suite backend e controller puri |42/42 test passati |
| Lifecycle MOD e contratto del volto Piu simulato |32/32 test passati |
| Modello Swift iPhone |24 gruppi di verifiche passati |
| Archivio MOD release | Compilato per il target candidato CoreS3, licenze e hash allegati |
| Pacchetto Worker | Compilato con deploy --dry-run, nulla caricato |
| App iPhone | Build completata, firma/team/bundle verificati; nulla installato |
| Servizio online, sola lettura | Salute200; preferenze/ricordi senza token401; preferenze con token200 |
| Endpoint di controllo robot |200 autenticato: bridge distribuito, robot fisico offline |

Nessuna sessione vocale a pagamento aperta e nessuna modifica a ricordi/preferenze reali durante questa verifica. Le prove locali usano sostituti dei provider. I controlli online leggono solo gli endpoint necessari; non scrivono dati di test in produzione e non stampano il token.

## Ripetere la verifica

- Doppio clic su **Verify Robottino.command**: include build/firma iPhone; non richiede il telefono collegato.
- `npm run verify`: tipi, test, modello Swift, archivio MOD e pacchetto Worker.
- `npm run verify -- --iphone-build --cloud`: aggiunge firma iPhone e controllo autenticazione del servizio esistente. Richiede macOS/Xcode, SDK Moddable locale, dipendenze installate e token locale già configurato; la parte cloud richiede rete.

I log numerati e il report sono in work/verification/. La procedura non installa le dipendenze automaticamente e non usa comandi flash/deploy reali. Il flag cloud non apre l'audio. File chiave/token e dati utente non sono inclusi negli hash del report.

## Restano da implementare o collaudare

Il [bridge Live](LIVE-IPHONE-ROBOT-it.md) è implementato e distribuito, verificato in remoto con un dispositivo virtuale: immagini, video, audio bidirezionale, testa/viso, ACK e disconnessione. La scheda Studio è un doppio software in memoria, non un'implementazione del protocollo binario o del collegamento BLE/Wi-Fi. La camera della scheda Test resta disabilitata; Live usa invece le capacità dichiarate dal MOD verificato. Il rilevamento autonomo di oggetti sulla camera del K151 è ancora da implementare; MediaPipe attuale usa rilevamenti esterni.

Al robot fisico serviranno: verifica SKU/revisione/firmware/partizioni; conferma prima di qualsiasi flash; misura della posa iniziale, segni/coordinate/limiti dei servi; verifica latenza e conferme reali, risposta all'arresto, sensori testa/schermo; resa e memoria Piu; camera, alimentazione, microfono/altoparlante e sincronizzazione labbra/audio. Nessuna prova software sostituisce queste misure.

Il blocco di collegamento dell’iPhone è stato superato il6 novembre2026 alle22:52: firma nuovamente verificata, app completa installata e avviata sul telefono fisico senza disinstallazione. Conferma in work/verification/iphone-build.json. Il controllo visivo delle schermate e la riproduzione sonora effettiva restano manuali. I runtime simulatori sono disponibili, ma la finestra Simulator.app non è accessibile nell'ambiente: non viene dichiarato un collaudo visivo mai eseguito.

## Fonti ufficiali usate

- https://developers.cloudflare.com/workers/testing/vitest-integration/ — plugin e migrazione a Vitest4/nuovo nome del pacchetto.
- SDK Moddable10.0.2 locale: modules/base/time/esp/modTime.c — semantica di ticks/delta.
- Help del Wrangler locale4.158.0 — deploy --dry-run e outdir.

Aggiornamento Live: prova remota sintetica esplicita eseguita separatamente dalla procedura verify (work/verification/live-cloud.json). Nessuna camera, microfono, chiave provider o memoria reale usata. Il deploy ha aggiunto solo RobotLink al Worker Robottino, mantenendo memoria e configurazioni precedenti.

Anche il client Swift di produzione è stato verificato attraverso Cloudflare con dispositivo virtuale (scripts/test-live-native.mjs, report live-native.json): video, testa, viso, immagine, PCM nei due sensi e STOP. Non è una prova dei driver iOS sul telefono.

Aggiunta la prova del detector Vision di produzione con CGImage sintetica vuota, senza camera: nessun comando viso/testa e contenimento dei burst. Non è una verifica della precisione con una persona. Test passati anche per ricostruzione320×240, replay, timeout e chunk mancanti. La prova Vision necessita accesso ai servizi grafici del Mac.

Wi-Fi: aggiunti moduli casa/hotspot nel Portachiavi e test del modello e della politica di selezione; nessuna password inviata al cloud, nessun cambio rete fisico o provisioning eseguito. La conferma online non identifica la rete usata. Dettagli in WIFI-CASA-E-HOTSPOT-it.md.
