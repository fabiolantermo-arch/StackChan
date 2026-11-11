# Due configurazioni vocali

Superato dal documento SECURITY-AND-STATUS-it.md: il percorso attivo è /api/voice autenticato. La voce attuale è Sami. Le istruzioni /api/chat qui sotto sono storico del prototipo.

POST /api/chat accetta provider `openai` (default) oppure `elevenlabs`.

- OpenAI: gpt-live-1, voce marin, PCM mono 24 kHz.
- ElevenLabs: agente dedicato Robottino agent_00000000000000000000000000, eleven_realtime_v1_max, italiano, voce Eric predefinita.

Esempio body: `{"sessionId":"demo","provider":"elevenlabs","message":"Ciao","speak":true}`.

Prototipo a turni: raccoglie audio nel backend e chiude dopo una breve pausa. Non è ancora un trasporto audio continuo bidirezionale per il robot. Riconoscimento microfono, interruzioni, memoria conversazionale Live e validazione codec sul K151 restano da implementare/verificare. Non usare queste prove come verifica hardware. Le chiavi sono nei secret Cloudflare; l'Agent ID non è un segreto.

Fonti: https://developers.openai.com/api/reference/resources/live/primary-websocket e https://elevenlabs.io/docs/eleven-agents/customization/realtime-models
