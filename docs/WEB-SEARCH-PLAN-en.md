# Web search for Robottino (7 November 2026)

**Status: active** since version `0d1a9c68` of the Worker. Code in `src/web-search.ts`; ElevenLabs tool `cerca_sul_web` (`tool_4701m6v6vpb7ezesxet9yd1b92y0`), installed with `POST /api/admin/web-search-tool` (the app's token): repeating the call updates the tool instead of duplicating it. Tried by voice with both providers («Che tempo fa domani a Milano?»). To try it with the ElevenLabs agent use `ROBOTTINO_ATTESA=20000`: the search takes a few seconds and the script closes after 60 s anyway.

What follows is the initial plan, kept as documentation.

## OpenAI GPT-Live 1 (provider `openai`)
- GPT-Live has no tools of its own: it **delegates** to a "backend" model (guide: https://developers.openai.com/api/docs/guides/live-delegation).
- If `delegation` is missing in `session.start`, the default is **client** delegation: the model may emit `session.delegation.created` and wait with nobody answering. Today `src/voice-stream.ts` does not configure it.
- Plan: in `session.start` add
  `delegation:{type:'responses',responses:{model:'gpt-6-luna',instructions:'Rispondi in italiano, breve, adatto a essere detto a voce, cita il nome della fonte, niente URL.',tools:[{type:'web_search',search_context_size:'low',user_location:{type:'approximate',country:'IT',timezone:'Europe/Rome'}}],max_output_tokens:600}}`
  and in the instructions: "for news, weather, results, timetables or facts you do not know, delegate the search".
- New incoming events (`session.delegation.created`, `response.event`): the clients already ignore them. Careful: the `error` with code `responses_validation_failed` is **not fatal**, while firmware and app today close on every `error`. The relay must filter it (log it without forwarding it).
- Costs: the backend and the web search are paid for separately from the minutes of voice.

## ElevenLabs (provider `elevenlabs`)
- No built-in web search: a **webhook** tool is needed. It is created with `POST https://api.elevenlabs.io/v1/convai/tools` using `tool_config` `{type:'webhook',name:'cerca_sul_web',description,api_schema:{url,method:'POST',request_headers:{...},request_body_schema:{type:'object',required:['query'],properties:{query:{type:'string',description}}}},pre_tool_speech:'force',response_timeout_secs:20}`. Then its ID is attached to the agent's `conversation_config.agent.prompt.tool_ids` list, joined to the existing tools without replacing them.
- The ElevenLabs key exists only as a secret of the Worker. So an administrative route is needed (the app's token) that creates or updates the tool from the Worker.
- The Worker's endpoint `POST /api/tools/web-search`: an authorisation header derived with HMAC from `ROBOT_API_TOKEN`, its own quota (`quota:search`). It calls the Responses API with the `web_search` tool and returns `{answer}`. The same function (`src/web-search.ts`) also serves a direct test.

## Verification
Vitest tests for the route and for the error filter. Deployment after confirmation, then a trial by voice: `npm run robot:talk -- --app --openai "Che tempo fa domani a Milano?"` and the same question with `--elevenlabs`. In case of problems, restore with `npx wrangler rollback`.
