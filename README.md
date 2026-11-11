# Robottino

*[Versione italiana](README-it.md) · English version*

A desk companion built on the **M5Stack StackChan K151** (CoreS3, ESP32-S3): it talks, moves its head when asked, changes its face and mood, follows a face, and tells you what it sees through its camera.

https://github.com/user-attachments/assets/97672104-78df-42dc-a973-b0203a75e100

49 seconds: the robot on a desk, talking and moving. If the player does not show, the file is [docs/media/demo.mp4](docs/media/demo.mp4).

It is three parts that only ever talk through the cloud service, so no computer needs to stay on:

| Part | Folder | What it is |
|---|---|---|
| Robot | `firmware/stackchan-mod/`, `firmware/host/` | A [Moddable](https://www.moddable.com/) MOD (JavaScript, XS) on top of a patched [Stack-chan](https://github.com/stack-chan/stack-chan) host |
| Cloud service | `src/`, `test/` | A Cloudflare Worker with Durable Objects: voice relay, robot ↔ phone link, pairing, memory, vision |
| iPhone app | `ios/` | A SwiftUI app: live video, head control, calls, face following, settings |

> **Status: a personal project, working on one robot.** Everything here runs daily on the author's K151, but it has been tried on that single unit only. Expect to adapt things. The documentation exists in English and in Italian (files ending `-en` and `-it`); the robot speaks Italian or English; code comments are in English.

## What it does

- **Conversation.** A long touch on the head starts a voice conversation (ElevenLabs agent or OpenAI realtime, relayed by the Worker). The mouth follows the audio; the face follows the mood of the reply.
- **Spoken head commands**, recognised on the robot itself from the transcript and moved within the calibrated range:

  | Say | The head |
  |---|---|
  | “right”, “left”, “look right”, “turn left” | turns 20° that way (always ending on that side of straight ahead) |
  | “up”, “down”, “raise your head”, “lower your head” | tilts 20° |
  | “all the way up”, “all the way to the left” | goes to the end of the calibrated range |
  | “look ahead”, “center”, “look at me” | comes back to straight ahead |
  | “shake your head” | shakes |

- **Spoken faces.** The face and the tone of voice change together:

  | Say | The face |
  |---|---|
  | “smile”, “happy face” | smiles for a few seconds, with a short laugh |
  | “sad face”, “be sad” | turns sad and stays sad, voice included |
  | “angry face”, “get angry” | turns angry and stays grumpy (never offensive) |
  | “back to happy”, “be happy again” | smiles, then back to its usual self |
  | “back to normal”, “calm down”, “stop being angry” | back to its usual self at once |

- **“What is this?”** Hold an object in front of the robot and ask “what is this?”, “what do you see?” or “what am I holding?”. It takes one 160×120 picture with its camera, sends it over the voice connection, and a vision model describes it in one sentence that the robot says. It never guesses: no picture, no answer.

  Every command also works in Italian (see `firmware/stackchan-mod/voice-wire.js` for the exact phrases in both languages).
- **Phone link.** From the iPhone: live video, manual head control, face following (Vision on the phone, the head on the robot), calls both ways, dances.
- **Timers, reminders, a small permanent memory, web search** through the agent.

## The iPhone app

A native SwiftUI app (iOS 18 or later) in `ios/`. It is not on the App Store: you build it from source with Xcode and install it on your own phone. Its interface is in Italian.

| Tab | What you do there |
|---|---|
| **Robot** | See whether the robot is online, paste the app's token, switch “follow my face while we talk” on or off |
| **Aspetto** | Choose the face (two girls and a white robot), the voice model and voice, and the **language**: Italian or English |
| **Studio** | A dance editor, the expressions and a simulated link, to try things without the robot |
| **Test** | Everything that needs the real robot: pairing with a code and Wi-Fi over Bluetooth, **Live** (the robot's camera, a joystick for the head, face following with the robot's camera or the phone's, a call through the robot, pictures on its screen, dances), a voice conversation from the phone, and **Ricordi**, what Robottino remembers about you |

How it connects: the app never talks to the robot directly. Both keep a connection to the Worker, which relays between them (`RobotLink`). You paste the app's token once (`ROBOT_API_TOKEN`, the value you set as a Cloudflare secret) and the app keeps it in the Keychain; no key is ever inside the app. Pairing gives the robot its own, different token.

To build it: open `ios/Robottino.xcodeproj`, set your own bundle identifier and signing team, replace the Worker's address with yours (`robottino-stackchan.example.workers.dev` in `ios/Robottino/`), and run it on your iPhone. `node ios/test-connection.mjs` runs the app's logic tests on the Mac without a phone; `node ios/build-check.mjs` builds and checks the signature without installing.

## Hardware

- M5Stack **StackChan K151** (CoreS3, ESP32-S3 rev 0.2, 16 MB flash, two serial servos, GC0308 camera, Si12T head touch sensor).
- An iPhone for the app (optional for conversation, needed for the live link and pairing).

A CoreS3 build alone does not prove K151 compatibility: servo limits, calibration and the head sensor were all tuned on the real robot.

## Accounts and keys you need

- A **Cloudflare** account (Workers + Durable Objects).
- An **OpenAI** API key (vision, web search, optional realtime voice).
- An **ElevenLabs** account with a Conversational AI agent (the default voice path).

Keys are **Cloudflare secrets only** (`wrangler secret put …`): `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `ROBOT_API_TOKEN` (the app's token) and `ROBOT_DEVICE_TOKEN` (the robot's token; the two are never interchangeable). Nothing secret belongs in the repository, the app bundle or the firmware. See `.env.example` for the names.

Plain settings live in `wrangler.jsonc` → `vars`: `ELEVENLABS_AGENT_ID`, `OPENAI_MODEL`, `OWNER_NAME` (your first name, used in the greeting; leave it empty for a neutral greeting) and `ALLOW_SWEARING` (`"true"` lets the robot say swear words when someone asks for them; off by default).

The Worker's address appears as `robottino-stackchan.example.workers.dev` in the robot's MOD, the app and the scripts: replace it with your own deployment.

## Getting started

```sh
npm ci
npx wrangler types                      # generates the Worker's type declarations
npx tsc --noEmit
npm test                                # Worker tests (Vitest) + firmware tests (Node)
node ios/test-connection.mjs            # offline Swift checks
```

Deploy the Worker (your account, your secrets):

```sh
npx wrangler deploy
```

Build the robot's MOD (build only, it never flashes):

```sh
node firmware/stackchan-mod/build.mjs
```

The firmware builds expect Moddable SDK 10.1.0, ESP-IDF v6.1 and a Stack-chan checkout under `work/` (not part of this repository); `firmware/host/build-host.mjs` applies the patches in `firmware/host/patches/` and refuses to build if the sources differ from “baseline plus patches”. Writing to the robot is done with `esptool` (MOD at `0x910000`, host at `0x10000`); read `firmware/stackchan-mod/README-en.md` first.

The iPhone app is `ios/Robottino.xcodeproj`: see [The iPhone app](#the-iphone-app) above.

## How it is put together

- `docs/architecture-en.md`: components, routes and who may call them.
- `docs/decisions-en.md`: technical decisions and why.
- `firmware/stackchan-mod/README-en.md`, `ios/README-en.md`: the two clients.

Design rules worth knowing before you change things:

- **The robot has a small, fixed JavaScript memory.** Nothing large is ever copied or queued: camera frames, pictures and audio go piece by piece, and every continuous stream drops data rather than grow a queue.
- **Head safety.** Every pose goes through one function with the calibrated limits; a command without the servos' confirmation is never treated as done; a lost reply is retried once.
- **No pretending.** If an API call, an acknowledgement or a picture fails, the robot says so.
- **Limits and quotas** in the Worker (voice, pictures, pairing) are part of the design, not leftovers.

## Tests

The Worker has Vitest tests running in the Workers runtime; the MOD is tested in Node by loading the real modules against simulated hardware (servos that lose replies, late timers, a fake camera and sockets). `npm run verify` runs the whole set.

## Contributing

Issues and pull requests are welcome, in English or Italian. Please say which hardware you tried on, and keep the tests green (`npm test`). Changes to movement, limits or anything that writes to the robot need a test that fails without them.

## Third-party software

The robot's host is built from [Stack-chan](https://github.com/stack-chan/stack-chan) (Apache-2.0) with the [Moddable SDK](https://github.com/Moddable-OpenSource/moddable); their licences are in `firmware/artifacts/THIRD-PARTY-LICENSES.txt`. The face pictures were generated with AI tools by the author and are released with the project.

## Licence

MIT, see [LICENSE](LICENSE).
