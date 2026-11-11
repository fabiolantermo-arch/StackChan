# Architecture

Updated on 7 November 2026. Three components talk only through the Cloudflare Worker: the iPhone and the robot never connect to each other directly.

```
 iPhone app (ios/)                Cloudflare Worker (src/)                 K151 robot (firmware/stackchan-mod/)
 ─────────────────                ─────────────────────────                ─────────────────────────────────────
 app token (Keychain)    ──WSS──▶ /api/voice ──────────▶ OpenAI Live / ElevenLabs
                         ──WSS──▶ /api/robot/live ─┐                   ┌── /api/robot/device ◀──WSS── device token
                                                   └── RobotLink (DO) ─┘
                         ──POST─▶ /api/robot/pair ── RobotPairing (DO) ─── /api/robot/pair ◀──WSS── robot without a token
                                  /api/robot/voice ◀──────────────────────────────────────WSS── device token
 Claude Code hook ──POST─▶ /api/robot/reaction ──▶ RobotLink ──▶ robot
```

## Cloudflare Worker (`src/`)

- Name `robottino-stackchan`, URL `https://robottino-stackchan.example.workers.dev`, configuration in `wrangler.jsonc` (compatibility 2026-11-06).
- Durable Objects (SQLite): `ChatSession` (`session.ts`, history and quota), `RobotMemory` (`memories.ts`, permanent memories), `RobotLink` (`robot-link.ts`, app↔robot relay), `RobotPairing` (`pairing.ts`, pairing with a code). Migrations v1 → v4: never remove or reorder them.
- Main files: `index.ts` (routes and authentication), `voice-stream.ts` (voice relay, `VOICE_LIMITS`, memory and timer rules, Italian date), `providers.ts` / `voice-config.ts` / `eleven-agent.ts`, `robot-vision.ts` ("what is this?": the picture from the robot's camera arrives in pieces over the voice connection, becomes an enlarged PNG and an OpenAI model with vision describes it in one sentence that the agent says; `PICTURE_LIMITS`), `web-search.ts` (search and the ElevenLabs tool), `memory-api.ts`, `preferences.ts`, `robot-wire.ts` (validation of the robot's messages, allowed face styles), `security.ts`.

### Routes

| Route | Who | Credential |
|---|---|---|
| `GET /health` | everyone | none |
| `WSS /api/voice?provider=openai\|elevenlabs&sessionId=…` | app | app token |
| `WSS /api/robot/voice` | robot | device token (the app token is refused) |
| `WSS /api/robot/live`, `GET /api/robot/status` | app | app token |
| `WSS /api/robot/device` | robot | device token |
| `WSS /api/robot/pair` | unpaired robot | none (quota 6/min, 100/day, 4 waiting) |
| `POST /api/robot/pair` | app | app token |
| `POST /api/robot/reaction` | Claude Code hook | app token; `kind` ∈ attention, done, success, failure; 1 every 2 s |
| `GET/POST /api/memories`, `/api/preferences`, `/api/providers` | app | app token |
| `POST /api/tools/web-search` | ElevenLabs agent | HMAC derived from the app token |
| `POST /api/admin/web-search-tool` | owner | app token |
| `GET/POST /api/admin/agent-english` | owner | app token (GET: how the agent is set; POST: adds English to the languages of the Robottino agent and the permission to choose it at the start, touching nothing else) |
| `POST /api/admin/asr-keywords` | owner | app token (adds `ASR_KEYWORDS` to the speech recognition of the Robottino agent only, keeping the other words, the prompt and the other settings) |
| `/api/chat` | — | answers 426: the WebSocket is used |

Credentials only in the `Authorization` header, never in the URL.

### Voice providers

- OpenAI `gpt-live-1`, voice marin; web search delegated to Responses (`gpt-6-luna` + `web_search`).
- ElevenLabs Realtime V1 Max, agent `agent_00000000000000000000000000`, voice Sami `kAzI34nYjizE0zON6rXv`, tool `cerca_sul_web`. The default.
- Limits: 6 openings a minute and 100 a day, 5 minutes per connection, 256 KB/s and 24 MB incoming.

## Live relay — binary protocol "RB" v1

A 12-byte header: magic `RB`, version 1, kind, sequence UInt32BE, width and height UInt16BE.

- Kind 1: camera RGB565LE.
- Kind 2: display RGB565LE 160×120.
- Kind 3: call audio. Since 10 November 2026 two marker bytes (B1 08) and then µ-law 8 kHz mono, pieces of 800 bytes (a tenth of a second); the earlier PCM16LE mono 16 kHz is dropped by whoever receives it.
- Kind 4: pieces of a 320×240 frame: frameID and offset UInt32BE, up to 32 768 bytes a piece, 5 pieces a frame.

JSON commands with ACK within 1500 ms, heartbeat 5 s, closing after 15 s of silence, a session of at most 10 minutes, one app and one robot at a time. The robot closes the link by itself after 12 s with nothing from the server. In the code but not yet deployed (10 November 2026): the 10 minutes counted from when the app joins, and closing with the reason (`robot_silent`, `app_silent`, `session_expired`, `command_timeout`). Details in `docs/LIVE-IPHONE-ROBOT-en.md`.

## iPhone app (`ios/`)

- Project `ios/Robottino.xcodeproj`, three source files:
  - `Sources.swift`: store, interface, Wi-Fi, Ricordi, Test with joystick;
  - `RobotLiveCore.swift`: pure, testable logic (protocols, voice, mood, `RobotFaceFollowMemory`, `RobotCallAudio`, `RobotMouthSmoother`, `RobotFaceStyle`);
  - `RobotLive.swift`: audio, camera and Vision, conversation, `RobotVoicePanel`.
- Tabs: **Robot** (state in one sentence, pair the robot, Wi-Fi, secure link), **Aspetto** (face, model and voice), **Studio** (dances, expressions, simulator, Live, Ricordi, then talk to Robottino), **Test** (the robot's real state from the service; a joystick that moves the real head within ±10°, the limit of remote commands, or a simulation of 46° / 30° upwards).
- The Wi-Fi is saved in the Keychain and sent to the robot over Bluetooth (hotspot and home).
- Offline tests: `ios/test-connection.swift`, run by `test-connection.mjs`.

## Robot (`firmware/stackchan-mod/`)

A Moddable 10.0.2 MOD on Stack-chan upstream `906ee9a0cd2a0107a24c714efb10274f3b546afa`, candidate target `m5stackchan_cores3`. No C code, so no real echo cancellation. The regexes do not use `\p{…}`.

- `mod.js`: behaviour, touch, gestures (no glances at rest since 9 November 2026).
- `face.js` + `portrait-state.js`: a face made of 320×240 pictures; `FACE_STYLES` = portrait `girl-`, white `white-`, redhead `red-`. While it talks the serene face stays and only a small picture of the mouth changes (`MOUTH_BOXES`, poses `MOUTH_POSES` 0–4), updated as soon as the host sends the face state.
- `tracker.js`: face following. Two ways: the position of the face in a fixed frame (Bluetooth MediaPipe) or, with Live "Segui il mio viso", the position in the frame of the robot's camera plus the position of the head when the picture was taken (`aim`). `FaceLock` chooses the image to send: the whole 160×120 until the face is found, then 80×60 (a 120×90 window around the face, or the whole image halved), and brings the iPhone's answers back to the coordinates of the whole image.
- `dance.js`: dances.
- `voice-device.js` / `voice-wire.js`: conversation from the robot, in turns (microphone and speaker never open together). It connects to `/api/robot/voice?audio=ima&mic=alaw`: the microphone goes as binary A-law (the host's `ChatAudioIO/Codecs` encoding, μ-law as a fallback); the replies arrive as binary frames `[1][number of poses][a mouth pose every 4 blocks, about 32 ms][IMA blocks of 68 bytes = 129 samples]` (`src/robot-audio.ts`, about 194 ms a frame; the robot plays them in segments of about 97 ms) and go, without decoding in JavaScript, into the queue (24 elements) of the host's `pins/audioout` driver: a callback per segment moves the mouth.
- `live-device.js` / `live-wire.js`: Live relay. Following commands `track.start` (camera 160×120; in grey, kind 6: the whole image every ≥150 ms until the face is found, then small 80×60 images every ≥250 ms taken when the connection has room for all three pieces; always and only with an empty queue), `track` (`frameId`, `x`, `y`) and `track.stop`; they need camera and movements on.
- `socket.js`: all the MOD's sockets (the host's low-level client) and `lowLatency()`: it asks the host for an always-awake Wi-Fi (module `network-power`) while camera, following, Live call or conversation transmit; at rest the radio goes back to power saving. Messages leave at once (`noDelay`) and `room` says how many bytes the connection takes without making them wait: the host keeps at most 11.4 KB waiting for the network's confirmation (`TCP_SEND_BUFFER` in the host build; 5.7 KB until 10 November), and this is what limits the speed of the images (about 35 KB/s on the hotspot, measured on 10 November; about 23 before).
- `pairing-device.js`: pairing.
- `reminders.js`: timers.
- `calibration.js`: calibration of the head. The host converts rotations into servo positions with fixed centres (horizontal 460, vertical 620) and limits the vertical to 5…85°; the MOD widens the host's limits (the `config` section of the manifest → `mod/config`, positions 0…1000) and applies its own: centre and end stops measured by hand, minus 12 steps (about 4°) of margin. Every pose goes through `setHeadPose` → `toHost()`; without measurements exactly the host's limits hold. Measurements in Preference `robottino/headCal`.
- `lights.js`: the head lights (the K151's 12 coloured LEDs, commanded by the host through the PY32: `robot.lighting`, LED `head`). Scheme "Discreta" at a quarter of the brightness: off at rest; steady light blue when it listens, blinking light blue when it connects or thinks, warm white when it talks, purple with the iPhone connected (Live, camera, following, Test), blinking orange with the pairing code, blinking yellow for a reminder until the head is touched, red for three blinks after an error. The MOD updates them every 100 ms and writes to the LEDs only when the light changes; the phase of the conversation comes from `voice.phase`.
- `wifi-switch.js`: two networks.
- Preferences in the `robottino` domain: `deviceToken`, `verified`, `calibrated`. Movements need verified, calibrated and local activation.
- Builds in `firmware/artifacts/` (`.xsa` archive and hashes).

## Conventions shared between components

- **Head**: safety limits yaw ±90° (π/2) and pitch between −85° and 0, where negative means looking up; the real limit is the calibration (version 2) minus the margin. One speed only, 3 rad/s (about 170°/s, the highest the user asked for), measured from where the head should be, with minimum steps of 0.1 s (`HEAD_SPEED`, `MIN_MOVE`, `moveTime`, `setHeadPose`). The absolute following of `tracker.js` and `RobotHeadFollower` stays at ±0.8 and −0.52 with the same speed. The K151 servo receives −p; the manifest widens the host's limits. The K151's horizontal servo turns the other way: the MOD inverts it in `servoPositions`/`rotationFromRaw` (`YAW_SERVO`), the app sends the angles as they are.
- **Conversation**: the robot's `hello` contains `conversation`; the Worker's state exposes it; the open app uses it to follow the face during the conversation (`RobotConversationFollow`).
- **Face styles**: the ids `portrait`, `white`, `redhead` are the same in app, relay and MOD. Every face has six poses: neutral, happy, sad, blink, talk-small, talk-open.
- **Mood of the replies**: `replyMood` (MOD) and `RobotReplyMood` (app) are twins. The expression depends on the sentence in progress, the gesture on the start of the reply.

## Local tools (`scripts/`)

- `virtual-robot.mjs`: a simulated device.
- `robot-talk.mjs`: a conversation from the Mac.
- `robot-reaction.mjs`: Claude Code's reactions on the robot. **Hooks switched off on 9 November 2026 at the user's request** (`.claude/settings.json` empty); to switch them back on, put back the hooks `Notification` (`attention`), `Stop` (`done`) and `PostToolUse` on `Bash` (`tests`).
- `test-live-cloud.mjs`, `test-live-native.mjs`, `test-pairing.mjs`: trials on the cloud.
- `verify.mjs`: the full verification.
- `mac-camera.swift`: lends a camera to the iOS simulator on 127.0.0.1:8765.
