# Ricerca web per Robottino (7 novembre 2026)

**Stato: attiva** dalla versione `0d1a9c68` del Worker. Codice in `src/web-search.ts`; strumento ElevenLabs `cerca_sul_web` (`tool_4701m6v6vpb7ezesxet9yd1b92y0`), installato con `POST /api/admin/web-search-tool` (token dell'app): ripetere la chiamata aggiorna lo strumento invece di duplicarlo. Provato a voce con entrambi i provider («Che tempo fa domani a Milano?»). Per provare con l'agente ElevenLabs usare `ROBOTTINO_ATTESA=20000`: la ricerca richiede qualche secondo e lo script si chiude comunque dopo 60 s.

Quanto segue è il piano iniziale, rimasto come documentazione.

## OpenAI GPT-Live 1 (provider `openai`)
- GPT-Live non ha strumenti propri: **delega** a un modello «backend» (guida: https://developers.openai.com/api/docs/guides/live-delegation).
- Se `delegation` manca nel `session.start`, il default è la delega **client**: il modello può emettere `session.delegation.created` e restare in attesa senza che nessuno risponda. Oggi `src/voice-stream.ts` non la configura.
- Piano: nel `session.start` aggiungere
  `delegation:{type:'responses',responses:{model:'gpt-6-luna',instructions:'Rispondi in italiano, breve, adatto a essere detto a voce, cita il nome della fonte, niente URL.',tools:[{type:'web_search',search_context_size:'low',user_location:{type:'approximate',country:'IT',timezone:'Europe/Rome'}}],max_output_tokens:600}}`
  e nelle istruzioni: «per notizie, meteo, risultati, orari o fatti che non conosci, delega la ricerca».
- Eventi nuovi in arrivo (`session.delegation.created`, `response.event`): i client li ignorano già. Attenzione: l'`error` con codice `responses_validation_failed` **non è fatale**, mentre firmware e app oggi chiudono su ogni `error`. Il relay deve filtrarlo (registrarlo nei log senza inoltrarlo).
- Costi: il backend e la ricerca web si pagano a parte rispetto ai minuti di voce.

## ElevenLabs (provider `elevenlabs`)
- Nessuna ricerca web integrata: serve uno strumento **webhook**. Si crea con `POST https://api.elevenlabs.io/v1/convai/tools` usando `tool_config` `{type:'webhook',name:'cerca_sul_web',description,api_schema:{url,method:'POST',request_headers:{...},request_body_schema:{type:'object',required:['query'],properties:{query:{type:'string',description}}}},pre_tool_speech:'force',response_timeout_secs:20}`. Poi si collega l'ID alla lista `conversation_config.agent.prompt.tool_ids` dell'agente, unendolo agli strumenti esistenti senza sostituirli.
- La chiave ElevenLabs esiste solo come secret del Worker. Serve quindi una route amministrativa (token dell'app) che crei o aggiorni lo strumento dal Worker.
- Endpoint del Worker `POST /api/tools/web-search`: header di autorizzazione derivato con HMAC da `ROBOT_API_TOKEN`, quota dedicata (`quota:search`). Chiama la Responses API con lo strumento `web_search` e restituisce `{answer}`. Questa stessa funzione (`src/web-search.ts`) serve anche per un eventuale test diretto.

## Verifica
Test Vitest per la route e per il filtro dell'errore. Pubblicazione dopo conferma, poi una prova a voce: `npm run robot:talk -- --app --openai "Che tempo fa domani a Milano?"` e la stessa domanda con `--elevenlabs`. In caso di problemi, ripristino con `npx wrangler rollback`.
