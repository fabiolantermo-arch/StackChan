# Live iPhone ↔ Robottino

Implementation of 6 November 2026. The relay is deployed in the Worker robottino-stackchan; it works without a Mac switched on. It is a software prototype with local tests and a trial through Cloudflare with a virtual device, not a test on the physical K151.

## The new Live tab

- **Video from the robot:** a Start/Stop button, RGB565LE frames of 320×240, capture requested every 333 ms (about 3 fps; the real rate and latency are to be measured). No pre-loaded video is passed off as the real camera.
- **Head:** horizontal and "up" sliders and centre: up to 90° to the sides and 85° up, never down (the user's choice, 9 November 2026, night; the robot stays within its calibration anyway), at constant speed; right and left as in the joystick of the Test page. Mirroring and dances stay ±10°. The app asks for the robot's confirmation. Enabled only after hardware verification, calibration and local activation of the motors; tracking and dance are excluded during remote control.
- **iPhone/robot audio call:** microphone and speaker in both directions; since 10 November 2026 it travels as µ-law 8 kHz mono (pieces of 800 bytes with two marker bytes B1 08; microphone and speaker stay PCM16 at 16 kHz on both sides), before that PCM16 mono 16 kHz. It does not involve OpenAI/ElevenLabs and does not produce an AI conversation. It needs the iPhone's microphone permission before the robot's microphone is switched on. Voice processing on the phone; on the robot the microphone is suspended during audible outgoing audio and for 180 ms after. Silence does not keep the microphone blocked. A full-duplex acoustic conversation without echo is not shown: a physical trial is needed. Speaker at 25%, limited buffers, exclusive audio access for the MOD.
- **Follow my face (9 November 2026):** Start following → the robot switches the camera on at 160×120, reduces it to 80×60 in grey (the green channel, mean of 2×2 pixels: 4.8 KB, packets of kind 6) and sends a frame at most every 150 ms, only when the previous one has left; the app puts it back together (internal kind 7, only in the app); the iPhone looks for the face with Vision (only the box, no facial points) and answers with `track` (the frame number, the centre of the face). The robot remembers the head's position for the last 8 frames and turns the head from there: 80% of the displacement per answer, measured field of view 58°×45° (frames only with the head still), a deviation under 3° ignored, limits 90° a side and 85° up, 3 rad/s. A face accepted by Vision with confidence ≥ 0.5 and at least 6% of the image high or wide (a face cut by the edge counts by its height; its centre is reconstructed). If the face leaves near an edge, the head makes two steps at most that way; with no face, a person seen from behind makes the head point to their side (`RobotFaceFollowMemory`). Image pieces of 4 KB, sent only with the socket's queue empty (in colour 160×120, on the hotspot, measured: an image every 1.5–2 s; in grey 2 pieces). With the app open it also starts by itself during a conversation with the robot (Robot tab → "Segui il mio viso mentre parliamo"), with a frame every 250 ms. With no answers for 1.5 s the head stays where it is. It needs camera, verified hardware, calibration and movements on the robot; it excludes video, imitation, manual head and dances while it is active. To be tested on the robot: the direction of the rotation (image not mirrored, yaw positive towards the robot's left), the real field of view and the rate of the frames on the network.
- **Face imitation:** a new section right after the real link, before the video. Choose Robot camera (the default) or iPhone camera, then Start imitation. With the robot's camera the video starts automatically and Vision analyses on the phone the frames received; the iPhone's camera stays off and the related permission is not asked. With iPhone camera the front one is used instead, with explicit permission. The choice does not change while the imitation is active. In the first case the limit is the flow of about 3 fps, in the second the analysis reaches 5 updates/s. Only pose, eyes and mouth are returned; the analysis on the phone does not identify the person and is not sent to AI providers. One analysis in progress, no queue of frames; results after the stop are ignored. An absent face and Vision errors are shown distinctly without inventing commands. The robot's face uses the six existing portraits. Precision at a distance, light and orientation and the motors' signs need a physical test. Keep the app open and the iPhone connected to the relay.

- **Sending a picture:** an explicit choice from Photos, fitted with bands to 160×120 with no EXIF or location, sent to the robot and enlarged 2× on the 320×240 display. "Torna al volto" restores the portrait. No automatic upload of the library.

Camera and microphone do not start when the tab opens. Leaving, going to the background, an audio interruption and disconnection close the flows. The permission requests are not mistaken for a move to the background; late results are ignored after leaving. The Stop-all button closes the link and causes clean-up on the robot. It is a software stop: it does not physically cancel a pose already handed to the driver, and it neither centres nor abruptly releases the servos.

## Link and protections

- App: WSS `/api/robot/live`, an Authorization header with the Robottino token already in the Keychain.
- Robot: WSS `/api/robot/device`, a **different** credential ROBOT_DEVICE_TOKEN, kept locally in private/robot-device-token with permissions 0600 and in the secrets of the Robottino Worker only. It must not be pasted into the app or the chat. No provider API key in the firmware.
- State: an authenticated GET `/api/robot/status`. Offline is not the same as a broken backend. The field simulated identifies the virtual device explicitly.
- A dedicated Durable Object RobotLink, added with the migration v3-robot-link; the classes ChatSession and RobotMemory and their data are kept.
- One app and one robot at a time: a new connection does not replace the busy one. No automatic reconnection that reactivates media or motors.
- ACK of commands within 1500 ms; heartbeat every 5 s, closing after 15 s without traffic and a session of 10 min at most. Commands do not pile up without limit. Increasing media sequences, schema/role/size/speed validated; credentials not accepted in URLs. The motion controls of the MOD keep the driver's 1200 ms watchdog.
- Media forwarded in transit over TLS, not saved in permanent memory, R2 or a database. It is not end-to-end encryption: the Cloudflare relay can process the bytes. The logs record path and method, not payload or credentials. The single most recent frame stays in RAM on the devices for display; no archive of the calls.

Wire v1: a 12-byte header, magic RB, version 1, kind 1 = camera RGB565LE, 2 = display RGB565LE, 3 = call audio (B1 08 + µ-law 8 kHz mono; until 9 November 2026 PCM16LE mono 16k); sequence UInt32BE, width/height UInt16BE and the payload. The pictures sent to the display stay 160×120. For the 320×240 video, kind 4 holds a frameID UInt32BE, an offset UInt32BE and up to 32768 bytes of RGB565LE after the base header: five messages for a frame of 153600 bytes, each under the 65536 limit of the SDK's WebSocket. The client rebuilds a single frame in RAM; it drops incomplete frames after 2 s and refuses replays, gaps and inconsistent sizes. Kind 1 stays compatible with the old complete frames (up to 320×240). Limit 800000 bytes/s per peer and 120 messages/s; audio 2..6400 even bytes, sizes 0. The media are enabled in the relay only after a positive ACK from the robot; packets in flight after a stop are dropped. It is not the SC/BLE/LAN protocol of the M5Stack factory app.

## Firmware requirements: before the physical robot

The MOD uses the community upstream Stack-chan commit 906ee9a0cd2a0107a24c714efb10274f3b546afa, Moddable 10.0.2, candidate m5stackchan_cores3. It uses robot.camera, robot.audio.acquireExclusive, embedded:io/audio/in and out, websocket/securesocket with TLS verification, Preference and runtime-bitmap-port. A failed import disables Live, leaving the face and the local controls available. A built MOD archive does not show that the K151's current firmware holds these native modules.

Model/revision, firmware and partitions must be read; sensors, pins/I2S, amplifier, camera, TLS certificates and availability of the host modules verified; centre, signs and limits of the servos determined. Only after this verification and an explicit confirmation can host and MOD be installed or configured. No flash was done.

The device reads Preference in the domain robottino: deviceToken, verified and calibrated. Until the verification is done, do not set verified/calibrated to true; the controls stay unavailable. The credential arrives with the **pairing with a code** (see SECURITY-AND-STATUS-en.md); `verified` and `calibrated` are switched on by hand from the robot's menu after the physical checks. The MOD starts the control channel only if configured; it does not open camera or microphone by itself.

Still to be tested: real camera and colours; memory/PSRAM and stability with video + audio; latency, network loss and acoustic audio; precision of the pose, direction and stopping of the motors; front-camera orientation/light and the Photos picker on the phone. Lips synchronised with the playback of an AI conversation, an autonomous object detector and the robot's AI audio flow are separate pieces of work still to be implemented.

## Repeatable checks

`npm run verify -- --iphone-build --cloud` runs tests, builds, signature and read-only cloud checks. Report and logs in work/verification/latest.json.

`node scripts/test-live-cloud.mjs` is an explicit remote trial: it opens two WebSockets in the Robottino project only and uses a device marked simulated. It refuses to replace an online robot; it sends synthetic images and PCM silence, and checks head/face, ACK, picture, two-way audio and the paired closing. It does not access camera or microphone, does not call providers and does not change memories or preferences. Report work/verification/live-cloud.json. It does not show physical working.

`node scripts/test-live-native.mjs` builds and runs the production Swift client against Cloudflare and a virtual device: state, video, head, face, picture, two-way PCM and STOP passed. It does not use the iPhone's audio/video drivers. Report work/verification/live-native.json.

The new app builds and is signed. Update with Update Robottino.command when the iPhone is connected and unlocked; do not uninstall the app, so that the existing data is kept. Update of 6 November 2026, 22:52: iPhone reachable, signature checked again, the new version installed and started without uninstalling. The physical audio/video and robot test is still to be done.

## Official documents and sources consulted

- [Cloudflare Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) — acceptWebSocket, hibernation and attachment.
- [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/) — Worker-side credentials.
- [The pinned Stack-chan upstream](https://github.com/stack-chan/stack-chan/tree/906ee9a0cd2a0107a24c714efb10274f3b546afa/firmware) — host/modules/camera, app/runtime-audio.ts, ui/views/camera-preview/runtime-bitmap-port and mods/examples/openai_live_webrtc.
- [Moddable SDK 10.0.2](https://github.com/Moddable-OpenSource/moddable/tree/10.0.2) — examples io/audioin/capture-sync, modules/network/websocket and modules/crypt/securesocket, consulted in the local copy.
- [Apple Vision landmarks](https://developer.apple.com/documentation/vision/vndetectfacelandmarksrequest), AVAudioEngine, AVCaptureSession and PhotosPicker in the local Xcode SDK declarations.

## Activation and troubleshooting

From the Live tab: Connect to the robot → Imita il mio viso → Robot camera → Start imitation. The section follows the real link · Robottino right away. The video starts automatically. To stop: Stop imitation; the video stays available until Stop video is pressed. Stop video also interrupts the imitation from that source. Stop all closes both.

The K151's GC0308 camera is declared 640×480 by [M5Stack](https://docs.m5stack.com/en/StackChan). The [official firmware examined](https://github.com/m5stack/StackChan/blob/28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400/firmware/sdkconfig.defaults) selects 320×240; this is not a check of the latest distributed app. Our MOD too now asks for 320×240. The real output has not yet been measured on the physical robot.

Last update: a new version with the choice of Robot camera / iPhone camera, the section right under the real link and the 320×240 video asked for, installed and started on the physical iPhone. 70 project/MOD tests, 22 Swift groups, a synthetic Vision trial and remote trials passed. Robot hardware not flashed nor tested.


## Dances from Studio (7 November 2026)

A `dance` command with `steps` (1–32 steps, ±10°, 300–5000 ms, 60 s at most, expressions from the catalogue). The server validates it, rebuilds only the known fields and accepts it only with movements enabled and calibrated; the firmware validates it again. The ACK marks the start of the dance, not its end. The app's link stays open for the duration: closing it, STOP or a motor error stop the dance. Lights and music stay on the iPhone.

## Virtual robot

`npm run robot:virtual` connects a device marked `simulated` with the local device token: a test video of bars, a tone during the call, a log of commands, dances and pictures (saved in work/virtual-robot/screen.ppm), reconnection with the same waits as the firmware. It refuses to replace a robot already connected. The app does not apply the face to a simulated device, by choice.

## Reconnecting the robot

The server closes the device when the app disconnects, after 10 minutes or 15 seconds without signals (in the code, not yet deployed: the 10 minutes are counted from when the app joins and the closing carries the reason). Since 10 November 2026 the robot also closes by itself after 12 s with nothing from the server. The MOD now reconnects by itself after 5 s, then 10, 20, 40 and 60 s at most; the wait goes back to 5 s after a successful connection and the attempts stop with "Ferma Robottino". To be tried on the robot.
