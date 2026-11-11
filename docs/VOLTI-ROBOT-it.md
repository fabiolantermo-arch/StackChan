# Volti Robottino

La scheda Live → Aspetto del volto offre due scelte: Ritratto e Robot bianco. Robot bianco rappresenta soltanto la testa della foto di riferimento, con schermo nero, occhi azzurri e bocca con lingua. Non contiene corpo o sfondo della foto. Le immagini sono320×240, pari allo schermo K151 dichiarato.

La scelta si può salvare su iPhone anche offline. Se il robot verificato è collegato viene inviata; il pulsante Applica al robot riprova. La conferma segue l’ACK del MOD e lo stile viene conservato nelle preferenze del robot. Il software di fabbrica non implementa questo protocollo. Se sul display è aperta una foto, tornare prima al volto. La scelta su iPhone non dimostra l’applicazione al robot.

Entrambi i volti dispongono di sei pose: serena, felice, pensierosa, ammiccamento, bocca socchiusa e bocca aperta. Le anteprime di Studio seguono la scelta iPhone. Durante le chiamate la bocca è guidata dall’intensità PCM riprodotta: si chiude nel silenzio e usa due aperture al variare del volume. È un’animazione di ampiezza, non sincronizzazione fonetica; l’audio della conversazione AI sul robot resta da integrare. I cuori della carezza continuano a essere sovrapposti allo stile attivo.

Per il robot bianco la testa è stata generata prendendo come riferimento la foto allegata, poi le sei espressioni sono state adattate allo schermo della testa. Le immagini precedenti restano inalterate. La resa, i tempi, la memoria richiesta e l’animazione devono essere provati sul K151 reale. L’archivio MOD usa l’host community documentato e non è stato installato: prima di qualsiasi flash occorrono verifica di modello, firmware, partizioni e conferma esplicita.

I test coprono selezione, validazione, salvataggio preferenza, sei pose, ritorno allo stile precedente, audio e silenzio, controllo cloud e client Swift con robot virtuale. Nessuna prova simula la percezione visiva o la qualità acustica del dispositivo fisico.

Tocco: sul robot bianco, un tocco sulla testa aggiunge un breve bip e una cascata di numeri verdi per circa3 secondi, oltre alle decorazioni esistenti. Il bip può essere omesso se il sistema audio è occupato. I movimenti mantengono le protezioni di verifica, calibrazione e attivazione locale. La nuova scheda Tocco simula separatamente testa e schermo per entrambi i volti, con suono e movimento di anteprima sull’iPhone: non invia comandi al robot. Il comportamento reale e la resa delle cifre sono da collaudare sul dispositivo fisico.


## Lentiggini (7 novembre 2026)

Terzo volto realistico, id `redhead`: ragazza con capelli rossi e lentiggini, generata dall’utente con ChatGPT come griglia 3×2 delle sei espressioni (`firmware/stackchan-mod/assets/red-atlas-source.png`). `firmware/stackchan-mod/prepare-redhead.swift` ritaglia le sei pose 320×240 (`red-*.png`), con la testa allineata sulla prima entro 1 px. Nell’app le immagini sono `Face-Red-*`. Lo stesso id è accettato da app, relay (`src/robot-wire.ts`), MOD (`FACE_STYLES` in `portrait-state.js`) e protocollo Live. Il pacchetto MOD passa da 2,5 a 3,7 MB: va verificato che entri nella partizione del K151 prima del flash.

Bocca fluida (7 novembre 2026): nelle pose «bocca socchiusa» e «bocca aperta» di Lentiggini ChatGPT aveva cambiato anche occhi e sopracciglia, quindi a ogni sillaba saltava tutto il viso. `prepare-redhead.swift` ora tiene il viso sereno e sostituisce solo un ovale (da sotto il naso al mento, oltre gli angoli della bocca) sfumato ai bordi. Nell’app la conversazione usa un’apertura continua (`mouthOpenness`, 0–1) e dissolve le pose della bocca invece di scattare; il robot resta a tre passi (`mouthLevel`), ma senza il salto del viso.

Bocca ancora più fluida e bionda (7 novembre 2026): nell’app l’apertura della bocca passa per `RobotMouthSmoother` (si apre in fretta, si chiude più dolcemente, calcolato a ogni fotogramma) e le pose della bocca si sovrappongono con dissolvenze più larghe. Anche il Ritratto (bionda) ora tiene il viso sereno mentre parla: `firmware/stackchan-mod/prepare-blonde-mouth.swift` prende solo l’ovale della bocca da `girl-talk-*-full.png` (pose originali, conservate) e scrive `girl-talk-*.png` e le imageset `Face-talk-*`.
