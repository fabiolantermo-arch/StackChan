# Two voice configurations

Superseded by SECURITY-AND-STATUS-en.md: the active path is the authenticated /api/voice. The current voice is Sami. The /api/chat instructions below are the history of the prototype.

POST /api/chat accepts the provider `openai` (default) or `elevenlabs`.

- OpenAI: gpt-live-1, voice marin, mono PCM at 24 kHz.
- ElevenLabs: Robottino's own agent agent_00000000000000000000000000, eleven_realtime_v1_max, Italian, default voice Eric.

Example body: `{"sessionId":"demo","provider":"elevenlabs","message":"Ciao","speak":true}`.

A turn-based prototype: it collects the audio in the backend and closes after a short pause. It is not yet a continuous two-way audio transport for the robot. Microphone recognition, interruptions, Live conversational memory and codec validation on the K151 are still to be implemented and verified. Do not use these trials as a hardware check. The keys are Cloudflare secrets; the Agent ID is not a secret.

Sources: https://developers.openai.com/api/reference/resources/live/primary-websocket and https://elevenlabs.io/docs/eleven-agents/customization/realtime-models
