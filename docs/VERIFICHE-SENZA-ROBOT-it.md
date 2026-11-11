# Verifiche senza dispositivo — 6 novembre 2026

Eseguire `npm run typecheck` e `npm test`. I test non usano API key né chiamate esterne a OpenAI/ElevenLabs.

Risultato: controllo TypeScript completo passato e 12 test locali passati.

Copertura: autorizzazione, richiesta anonima, payload e JSON invalidi, quota comune, provider richiesti, stub hardware; inoltro audio/eventi di interruzione, chiusura socket, assemblaggio trascrizioni; rifiuto comandi non ammessi; contesto iniziale OpenAI e contesto ElevenLabs con servizio simulato; recupero ultimi 12 messaggi in ordine da SQLite, isolamento e cancellazione memoria.

Queste prove dimostrano il comportamento del backend con eventi sintetici. Non dimostrano recupero dopo crash del processo, comprensione vocale reale, qualità percepita, eliminazione dell'eco o funzionamento dei servomotori. Il simulatore di test usa ancora il runtime Cloudflare incluso nella vecchia integrazione Vitest, con data massima 2025-09-06: la validazione sulla data di produzione non è completa.

Correzioni aggiuntive: impedita cancellazione memoria durante una sessione streaming; chiusura dei socket garantita anche se il salvataggio del testo fallisce.

Le prove reali cloud precedenti restano documentate in SECURITY-AND-STATUS-it.md. Nessun flash del robot.
