# Comparison with M5Stack's original app

Checked on 6 November 2026 on the official m5stack/StackChan sources, commit 28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400. It is a reading of the code, not a trial of the distributed app: the README warns that the repository may be updated later than the releases. M5Stack's factory firmware (C++/ESP-IDF/LVGL) and the community Stack-chan/Moddable one used by our MOD are different bases; support in one does not guarantee the same protocol in the other.

## Features found

| Original feature | Evidence in the app's sources | Opportunity for Robottino | Verification without the robot |
|---|---|---|---|
| Manual head command and face parameters | view/popup/motion.dart; controlMotion/controlAvatar | Make the Test tab operational, with calibration and confirmation of execution | Codec, limit checks, simulator; physical movements to be tried |
| Video from the robot with head command | view/home/monitoring_camera.dart; onCamera/offCamera, JPEG | Live view and manual shot | Decoder and tests with sample pictures; no real camera source |
| Phone/robot audio call | view/home/avatar.dart; onAudio/offAudio, Opus recording/playback | Talking and listening from the phone through the robot | Interface, formats and recorded trials; latency and acoustics to be measured |
| Imitating the face and the head's orientation | view/util/stack_chan_face_view.dart; ML Kit on the phone | A robot that imitates smile, eyes and pose of the face | Detection on the phone's camera is possible without the robot; actuation to be verified |
| Pictures from the phone to the display | view/home/avatar.dart; onPhoneScreen/offPhoneScreen, JPEG sending | Photos, a custom face and avatar mode | Preview and picture encoding; physical rendering to be verified |
| Recording/editing/playing choreographies | view/home/record_dance.dart, dance.dart, dance_list_page.dart | A library of gestures and dances, an editor with preview | Timeline, saving, validation and simulator can be done at once |
| Music and LED colours in the choreographies | record_dance.dart; musicInfo, leftRgbColor/rightRgbColor | A dance with expressions and lights, not only a swinging head | Planning/simulation; real LEDs and audio sync to be tried |
| Wi-Fi configuration and pairing the robot | view/popup/device_wifi_config.dart, binding_device.dart | Pairing in the app, connection state and a dedicated configuration | Flow and parser; BLE radio, pairing and firmware to be verified |
| Robot name and several devices | view/home/settings.dart | Identity and robot selector, distinct from the AI voices | Metadata and UI can be done without hardware |
| Agent configuration, MCP tools and chat history | settings.dart, mcp_page.dart, conversation_page.dart; XiaoZhi integration | Connecting our providers and tools, a history that can be read apart from the memories | Backend/UI and tests without hardware; do not reuse XiaoZhi tokens or agents as OpenAI/ElevenLabs credentials |

Face detection here uses the phone's camera: it does not show autonomous recognition of people or objects on the robot's camera. The mouth code in the mirroring uses the smile probability; it is not automatically lip synchronisation with the audio. The original servo parameters must not be copied directly into the MOD without unit conversion and calibration.

## Transport: the priority work

network/device_message_transport.dart prefers the LAN link to the intended robot and falls back on the remote channel. network/local_area_network_service.dart defines SC frames version 1 with a 20-byte header, session, sequence and length; the remote has a different framing. The LAN is not a plain camera HTTP endpoint to open: the app announces its own endpoint to the firmware through the remote channel (lan_endpoint_announcer.dart) and handles an authentication procedure. The code states that the RSA handshake serves to authenticate; it is not the same as encrypting the application traffic.

We can develop and test Swift/TypeScript codecs, framing, validation, reconnection handling and a simulated robot before the hardware. Then the actual protocol, the direction of the connection, the authentication and the compatibility of the physical firmware must be chosen and verified. We cannot promise that connecting the app to the factory firmware is enough without modifying or configuring it. Our Cloudflare audio endpoint and the MOD's MediaPipe BLE are not already compatible with all these messages.

## Next state: the Live implementation

Video, head, call, face imitation and pictures now have an app/relay/MOD software path: [details and limits](LIVE-IPHONE-ROBOT-en.md). A remote trial passed with a virtual device. It is neither a replica of the factory protocol nor a physical test; Studio stays a simulator.

## Order originally proposed

1. A single app/robot contract and a simulator, with a reliable state, capabilities and confirmation of the commands. It is the basis for replacing the disabled controls with real ones.
2. Head commands and taking a photo; later live video, checking costs and bandwidth and the stop when the screen is closed.
3. A library of expressions and gestures and a choreography editor with preview, lights and music. Always keep the precedence of stop and the exclusion between tracking and dance.
4. Phone/robot call and mirroring of the phone's expressions.
5. Robot/Wi-Fi configuration, tools and history, extending only what is useful for personal use.

Account, community, map and posts of the original app are separate social components; they are not needed to get a personal assistant with memory. A firmware update screen in the app was not verified: OTA is documented for the product, but must not be attributed to an iPhone feature only from the name Version in the settings.

The original reading of the repository alone added no feature (the later Live development is documented separately): no deploy, flash, pairing, camera access or audio recording was done.

## Official sources

- https://github.com/m5stack/StackChan/blob/28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400/README.md
- https://github.com/m5stack/StackChan/tree/28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400/app/lib/view/home
- https://github.com/m5stack/StackChan/blob/28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400/app/lib/network/local_area_network_service.dart
- https://docs.m5stack.com/en/StackChan
