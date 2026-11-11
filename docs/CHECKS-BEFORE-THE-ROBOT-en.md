# Full verification before the physical robot

Carried out on 6 November 2026. Machine report and hashes of the sources: work/verification/latest.json. All nine required phases passed; no cloud deploy, flash, iPhone installation or uninstallation was done by this procedure.

## Improvements verified

- **Movements:** the activation is cancelled even when the answer arrives late; a request already cancelled before the call to the driver is not sent. One pose in progress at a time. An activation or pose command without confirmation within 1200 ms blocks new movements until the module restarts. Synchronous exceptions and rejected promises of the driver also make the handling fail, without implicit reactivations.
- **Time and data:** MotionClock uses Moddable's official Time.ticks/Time.delta and handles the rollover of the counter; the control does not follow the civil clock. Target identifiers are validated and non-finite or backward data are refused. These are software guarantees, not a measure of the physical position or speed of the servos.
- **Resource clean-up:** the BLE subscriptions are released even if the second subscription fails; no restart of the face and no late reaction after dispose. The mouth driven by the audio state keeps precedence over the smile of touch and dance; the wink stays possible.
- **npm/Cloudflare environment:** @cloudflare/vitest-plugin 1.6.0, Vitest 4.1.12 and Vite 7.3.7; Wrangler 4.158.0 kept. The obsolete test runtime and its compatibility fallback were removed. The old npm 10 met an internal error while resolving the migration in the isolated copy; the lockfile was generated with npm 11 run once and then verified with a real npm ci of npm 10.9.3. Global npm not changed, no --force/--legacy-peer-deps, backup of the earlier files in work/verification/before-update/. Audit of the final installation: zero vulnerabilities reported (not a guarantee that there is no defect).

## Results

| Phase | Outcome |
|---|---|
| Generation of the Worker's bindings/types | Passed |
| TypeScript | Passed |
| Backend suite and pure controllers | 42/42 tests passed |
| MOD lifecycle and contract of the simulated Piu face | 32/32 tests passed |
| iPhone Swift model | 24 groups of checks passed |
| MOD release archive | Built for the candidate CoreS3 target, licences and hashes attached |
| Worker package | Built with deploy --dry-run, nothing uploaded |
| iPhone app | Build completed, signature/team/bundle verified; nothing installed |
| Online service, read only | Health 200; preferences/memories without token 401; preferences with token 200 |
| Robot control endpoint | 200 authenticated: bridge deployed, physical robot offline |

No paid voice session was opened and no real memory or preference was changed during this verification. The local trials use stand-ins for the providers. The online checks only read the endpoints needed; they write no test data in production and do not print the token.

## Repeating the verification

- Double-click **Verify Robottino.command**: it includes the iPhone build and signature; the phone need not be connected.
- `npm run verify`: types, tests, Swift model, MOD archive and Worker package.
- `npm run verify -- --iphone-build --cloud`: adds the iPhone signature and the authentication check of the existing service. It needs macOS/Xcode, the local Moddable SDK, the dependencies installed and the local token already configured; the cloud part needs the network.

The numbered logs and the report are in work/verification/. The procedure does not install the dependencies automatically and uses no real flash or deploy command. The cloud flag does not open the audio. Key and token files and user data are not included in the report's hashes.

## Still to be implemented or tested

The [Live bridge](LIVE-IPHONE-ROBOT-en.md) is implemented and deployed, verified remotely with a virtual device: pictures, video, two-way audio, head/face, ACK and disconnection. The Studio tab is a software double in memory, not an implementation of the binary protocol or of the BLE/Wi-Fi link. The camera of the Test tab stays disabled; Live uses the capabilities declared by the verified MOD instead. Autonomous detection of objects on the K151's camera is still to be implemented; the current MediaPipe uses external detections.

The physical robot will need: verification of SKU/revision/firmware/partitions; confirmation before any flash; measurement of the starting pose, the signs/coordinates/limits of the servos; verification of real latency and confirmations, of the response to stop, of the head and screen sensors; Piu rendering and memory; camera, power, microphone/speaker and lip/audio synchronisation. No software trial replaces these measurements.

The iPhone connection block was overcome on 6 November 2026 at 22:52: signature verified again, complete app installed and started on the physical phone without uninstalling. Confirmation in work/verification/iphone-build.json. The visual check of the screens and the actual sound playback remain manual. The simulator runtimes are available, but the Simulator.app window is not accessible in the environment: no visual test that was never run is claimed.

## Official sources used

- https://developers.cloudflare.com/workers/testing/vitest-integration/ — plugin and migration to Vitest 4 and the package's new name.
- Local Moddable SDK 10.0.2: modules/base/time/esp/modTime.c — semantics of ticks/delta.
- Help of the local Wrangler 4.158.0 — deploy --dry-run and outdir.

Live update: an explicit synthetic remote trial was run separately from the verify procedure (work/verification/live-cloud.json). No camera, microphone, provider key or real memory was used. The deploy added only RobotLink to the Robottino Worker, keeping the earlier memory and configurations.

The production Swift client was also verified through Cloudflare with a virtual device (scripts/test-live-native.mjs, report live-native.json): video, head, face, picture, PCM both ways and STOP. It is not a trial of the iOS drivers on the phone.

A trial of the production Vision detector with an empty synthetic CGImage was added, without a camera: no face or head command, and bursts contained. It is not a verification of accuracy with a person. Tests also passed for the 320×240 reconstruction, replay, timeout and missing chunks. The Vision trial needs access to the Mac's graphics services.

Wi-Fi: home and hotspot forms in the Keychain were added, with tests of the model and of the selection policy; no password was sent to the cloud, and no physical network change or provisioning was done. The online confirmation does not identify the network in use. Details in HOME-WIFI-AND-HOTSPOT-en.md.
