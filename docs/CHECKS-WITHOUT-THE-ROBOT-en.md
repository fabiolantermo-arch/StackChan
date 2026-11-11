# Checks without the device — 6 November 2026

Run `npm run typecheck` and `npm test`. The tests use no API key and make no external call to OpenAI or ElevenLabs.

Result: the full TypeScript check passed and 12 local tests passed.

Coverage: authorisation, anonymous request, invalid payloads and JSON, the shared quota, the requested providers, the hardware stub; forwarding of audio and interruption events, socket closing, assembling transcripts; refusal of commands that are not allowed; the initial OpenAI context and the ElevenLabs context with a simulated service; retrieval of the last 12 messages in order from SQLite, isolation and deletion of the memory.

These trials show how the backend behaves with synthetic events. They do not show recovery after a process crash, real speech understanding, perceived quality, echo cancellation or the working of the servo motors. The test simulator still uses the Cloudflare runtime bundled with the old Vitest integration, with 2025-09-06 as its latest date: validation on the production date is not complete.

Further fixes: deleting the memory during a streaming session is prevented; the sockets are closed even when saving the text fails.

The earlier real cloud trials remain documented in SECURITY-AND-STATUS-en.md. No flashing of the robot.
