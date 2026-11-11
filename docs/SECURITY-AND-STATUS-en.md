# Verification status and use of the backend

The cloud service does not need a Mac switched on. Worker: robottino-stackchan. No resource of other projects is connected to this one.

Only /health is public. Chat, catalogue and WebSocket need `Authorization: Bearer <token>`. The token is in the secret ROBOT_API_TOKEN and, locally, in private/robot-token (permissions 0600, outside Git). Do not share it and do not put it in URLs. It is not a provider key.

Limits: 6 openings a minute and 100 a UTC day for the owner, persistent and shared between sessions. A voice connection lasts 5 minutes at most (`VOICE_LIMITS` in src/voice-stream.ts); input within 256 KB/s and 24 MB in total, 30 events/s, 32 KB an event. The iPhone app (Studio → Parla con Robottino) uses this path with the phone's microphone and speaker. It is not an exact money limit: set spending alerts at the providers too.

## Protocol

Open `wss://robottino-stackchan.example.workers.dev/api/voice?provider=openai&sessionId=demo` with Authorization in the header. For ElevenLabs use provider=elevenlabs.

The events stay the provider's official ones. OpenAI: wait for session.started, send session.input_audio.append with PCM16 mono 24 kHz in base64. ElevenLabs: wait for conversation_initiation_metadata, respect user_input_audio_format, send user_audio_chunk, answer pings with pong/event_id. Play the audio received in the format the provider declares. Close the socket to end; the backend closes the provider too.

Voice interruptions are handled by the provider. The client must stop and clear its own buffer when it receives the matching event. This part is still to be implemented in the firmware.

The old /api/chat is no longer the working mode: it answers 426 websocket_required to valid, authenticated requests. Do not present that result as a failed conversation.

## Memory and limits

The last 12 messages per session and provider, 4000 characters each at most. The history is sent again only to the selected provider, as authorised by the user. The transcripts depend on the events received; the continuity of the memories is not yet verified with a multi-turn audio conversation. No audio is kept in the database. Persistent memory on Cloudflare: use distinct sessionIds for separate conversations.

## Checks

6 local tests passed: provider selection, stub, token, anonymous access, validation/payload, quota. Remote check: health 200, API without token 401; both WebSockets authenticate and produce events and synthetic audio. It does not replace the listening and interruption trial on the physical robot.

Sami is the published voice of the ElevenLabs Robottino agent (eleven_realtime_v1_max). OpenAI uses gpt-live-1 / marin. The API keys stay in the Cloudflare secrets.

A private ElevenLabs agent: authentication required, 100 calls a day, 1 at a time, bursting off. The Worker gets a signed URL and does not expose it to the client. Audio trial before this protection: OpenAI 345600 bytes; ElevenLabs/Sami 238080 bytes. They are counts of data received, not a perceptual check of quality.

Still needed on the K151: model and firmware verification, microphone capture, buffering/playback, reconnection, face/movement synchronisation and an acoustic trial. No flashing was done.

## iPhone/robot Live relay

Added /api/robot/status and /api/robot/live, authenticated with the app token; /api/robot/device needs a distinct robot credential. The RobotLink relay is deployed, tested with a virtual device and the production Swift client. Formats, limits, provisioning and the physical trials still needed: [Live document](LIVE-IPHONE-ROBOT-en.md). The iPhone/robot call does not use the AI providers. No flashing was done.

## Conversation started from the robot (7 November 2026)

A long touch on the head (about 0.9 s) starts or ends the conversation; the short touch, on release, keeps smile and laugh (the laugh is suspended during the conversation). The MOD (`voice-device.js`, protocol in `voice-wire.js`) opens `wss://…/api/robot/voice` with the **device credential**: the server refuses the app's token, applies the same quota (6 a minute, 100 a day) and the limits of `VOICE_LIMITS`, uses the provider saved in the app and a separate history (`sessionId` `robot`). PCM16 mono audio in the formats the provider declares (ElevenLabs 16 kHz, OpenAI 24 kHz), messages of 100 ms; the mouth follows the audio being played. Without echo cancellation, while Robottino talks the microphone sends nothing: it only measures the volume and, if for 0.3 s it hears a voice louder than the `bargeLevel` threshold (preference `robottino`, default 6000 RMS, 0 switches it off), it interrupts the reply, also sends the last 400 ms and drops the rest of the reply until the provider confirms (3 s at most). A short touch on the head while it talks always interrupts it. The threshold is to be tuned on the K151. Closing after 30 s of silence, 10 s with no answer from the service, an error or the 5-minute limit. «Dimentica tutto» needs the confirmation from the app. It needs verified hardware; audio formats, volume and responsiveness are to be tried on the K151.

Trial from the Mac with the same access and the same protocol code: `npm run robot:talk` (synthesised sentence), `npm run robot:talk -- "frase"` or `npm run robot:talk -- --microphone`. It really calls the provider.

## Expressions, timers, life at rest and Claude Code (7 November 2026)

Only built and tried with tests and a virtual device: nothing was flashed.

- **Mood of the replies** (`replyMood` in `voice-wire.js`, twin of `RobotReplyMood` in the app): from the words of the reply the face becomes happy or sad and the head makes one gesture per reply (yes → nods, no → shakes, question → tilts). No extra AI call. Gestures on the robot use the same path as the dances (±10°, verified hardware, calibration and movements on are needed; never while the Live app is connected).
- **Spoken timers and Pomodoro** (`timerCommand`, `reminders.js`; in the app `RobotTimerCommand` + local notifications): «avvisami tra 10 minuti», «ricordami tra mezz'ora di…», «facciamo un pomodoro» (25+5 minutes for 4 rounds), «quanto manca?», «annulla il timer». From 10 seconds to 6 hours, 4 timers at most. On the robot the alert is a message, the smile, a nod and the sound `avviso.bin` (made by `prepare-alert.mjs`); the robot's timers are lost on restart. On the iPhone they arrive as notifications even with the app closed. The server never saves «ricordami tra…» as a memory and tells the model to just confirm.
- **Life at rest**: irregular blinks (every 2.5–6.5 s, sometimes double) and, with movements on and nobody to follow, a look around every 20–40 s. "Breathing" by shifting the portrait is ruled out: it would leave a blue line on the hair.
- **Reactions to Claude Code**: `POST /api/robot/reaction` (the app's token) with `kind` among `attention`, `done`, `success`, `failure`; the server forwards only these fixed values to the connected robot, one every 2 s at most (409 if the robot is not connected). The hooks in `.claude/settings.json` call `scripts/robot-reaction.mjs`: permission request → «Claude Code ti chiede un permesso»; end of turn → «Claude Code ha finito»; test commands → «Test superati!» or «Qualcosa non va». The script never blocks Claude Code and ignores every error. The virtual robot (`npm run robot:virtual`) prints the reactions.

## Pairing the robot and safety switches (7 November 2026)

No key in the firmware. A robot without `deviceToken` opens `wss://…/api/robot/pair` **without credentials** (quota 6 a minute, 100 a day, 4 robots waiting at most) and receives a random 6-digit code, valid for 5 minutes, which it shows on the screen. The owner types it in the app (Robot tab → Abbina robot): `POST /api/robot/pair` with the **app's token**. Only then does the Durable Object `RobotPairing` send that robot its credential (`ROBOT_DEVICE_TOKEN`); the robot saves it in `Preference` (`robottino.deviceToken`), answers `stored`, and the app gets success only after this confirmation (10 s at most). The code is valid once; after 10 wrong codes in an hour the requests are refused. The robot reconnects by itself after pairing; from its menu «Abbina con l'app» makes a new code. End-to-end trial: `node scripts/test-pairing.mjs` (it does not print the tokens).

The switches `verified` and `calibrated` are turned on from the robot's menu («Hardware verificato (sì/no)», «Calibrazione fatta (sì/no)») with a second press within 5 s; they turn off at once with a single press and turn the movements off too. They are to be turned on only after the physical checks.

## Camera in the iOS simulator

The page Studio → «Inseguimento viso» (a simulation on the iPhone, without the robot) was removed on 10 November 2026 at the user's request, with `RobotHeadFollower`, `RobotGazeFace` and the eye masks. The real following is Live → «Segui il mio viso».

In the iOS simulator (which has no camera) the app receives the images from `Simulator Camera.command` (`scripts/mac-camera.swift`): it uses the iPhone as the Mac's webcam (Continuity Camera, always the rear camera by Apple's choice) or the Mac's camera (`--mac`). It listens only on 127.0.0.1:8765, each image is a 4-byte length + JPEG, no data leaves the Mac. In the simulator Vision runs on the CPU only. The code is built only for the simulator (`#if targetEnvironment(simulator)`): the app on the iPhone always uses its front camera. It serves Live → «Imita il mio viso» when the app runs in the simulator.

Head limits (7 November 2026, widened at the user's request): 0.65 rad/s; ±0.8 rad (about 46°) right and left, within the K151 driver's ±128°; up to 0.52 rad (30°) upwards, like the upstream UP pose. Upstream convention: negative p looks up; the K151 servo receives −p limited to 5–85°, so p = 0 (straight) is already near the lower end stop and the head does not go down. Before this date the sign of the pitch in `tracker.js` was inverted (a face higher up would have asked to lower the head). To be tested on the robot: directions of rotation and the real straight position.
