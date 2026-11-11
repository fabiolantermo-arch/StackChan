# Studio Robottino — dance editor, expressions and simulator

Implemented in the iPhone app in the fourth tab, **Studio**, separate from Robot, Ricordi and Test. Its three entries open the dance editor, the expressions and the link simulator. The face reuses the six portraits already made for Robottino, without changing the app's icon.

## Dance editor

- A sample dance, new dance, name, adding/editing/deleting/reordering steps, duplicating, and a persistent local library. Saved dances are deleted with a confirmation.
- Each step holds horizontal and vertical orientation, duration, expression and the independent colours of the two simulated lights.
- The editor's limits: ±10° per axis, 300–5000 ms per step, 1–32 steps, a nominal total duration of at most 60 seconds. They are limits of the preview, not a calibration or a kinematic profile of the physical robot.
- Playback with a preview of the face, orientation, lights and current step. It waits for the simulated confirmation of each command before its duration. The simulated latency is added to the nominal duration; it is not a sample-accurate musical timeline.
- Atomic JSON save in Application Support/Robottino/dances-v1.json in the app's container. Permissions 600 and iOS file protection. A corrupted archive is not overwritten automatically.
- JSON version 1 import/export through Files. Validation of size, number and IDs of the steps, names, finite numbers, angles, times and version. Importing creates new IDs and needs Save: it does not automatically replace dances already there.

## Optional local music

An MP3/M4A/WAV/AAC/CAF file chosen by the user through Files, within 20 MB and 10 minutes, checked with AVAudioPlayer and copied into the protected local container. The internal path uses a UUID; arbitrary paths imported from JSON are not allowed. It starts at the first confirmed step and ends with the sequence, the stop, an error, or leaving the app or its suspension. Playback is on the iPhone, not on the robot's speaker. No microphone is used.

The exported JSON does not embed the music file. When a dance is imported from another device the old audio association is removed: the track must be chosen again. Removing the association or deleting a dance does not automatically delete the copied audio files, because other copies of the dance might still use them.

## Expressions

Six poses: Serena, Felice, Pensierosa, Ammiccamento, Bocca socchiusa, Bocca aperta. Preview, and adding as a step in the editor. The "Prova nel simulatore" button sends a confirmed local command, without producing voice. It is not yet an editor for drawing faces or deforming the pupils.

## Link simulator

States disconnected/connecting/connected/error; a settable delay of 0–1000 ms and selectable faults (no answer / command refused). Commands and confirmations with ID, sequence, de-duplication and a check against reusing an ID with a different payload. One command waiting at a time; a cache of 128 confirmations and a log of 40 events.

Stop invalidates the pending commands without applying late confirmations and keeps the last pose. Disconnecting also invalidates the wait for the last step, avoiding a false completion of the dance. No implicit reconnection. Leaving the Studio tab or an inactive app stop playback, audio and the simulated connection.

This is a software double **in memory**, not a simulator of the binary protocol of the M5Stack firmware nor of the physical BLE/Wi-Fi transport. It opens no socket, does not call the backend, moves no motor, does not capture the camera and produces no real command. Any access to the backend in the Robot and Ricordi tabs stays independent.

## Checks carried out

`node ios/test-connection.mjs`: 18 groups of Swift checks passed on the production model, including the regressions of token and reconnection, persistence/duplication/import, refusal of invalid data, protection of the corrupted archive, duplicate and late confirmations, stop and disconnection while waiting, ordered playback, WAV audio import and no use of the network in Studio.

iPhone build completed and Apple signature verified. Simulator build completed and the process started on a dedicated device, Robottino Studio QA. The visual check of the UI was not completed: the Simulator app's window is not available in the accessible environment, although runtime and command-line tools are present. Actual sound playback on the iPhone and the Files pickers still need a manual trial.

The complete app was installed and started on the physical iPhone without uninstalling the earlier version; later updates reuse the same container. To install: connect and unlock the iPhone and use Update Robottino.command. The earlier version was not uninstalled. No cloud deploy or firmware flash was done.

## Sources for the native APIs

- https://developer.apple.com/documentation/avfaudio/avaudioplayer
- https://developer.apple.com/documentation/swiftui/view/fileimporter(ispresented:allowedcontenttypes:oncompletion:)
