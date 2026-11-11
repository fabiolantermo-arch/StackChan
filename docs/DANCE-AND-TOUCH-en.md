# Dance and touch: sources and status

Checked on 6 November 2026. No robot was flashed and no physical dance was performed.

## Two different bases

- Stack-chan Moddable, commit 906ee9a0cd2a0107a24c714efb10274f3b546afa: https://github.com/stack-chan/stack-chan . The host code recognises forward and backward strokes on the head sensor: firmware/host/app/default-behavior/on-context-created.ts. The public TouchPanel module exposes subscribe and the removal of the listener; our MOD uses this API and its own Piu callback for the face.
- M5Stack's factory firmware, commit 28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400: https://github.com/m5stack/StackChan . Here are firmware/main/stackchan/modifiers/dance.h and firmware/main/apps/app_dance/app_dance.cpp, as well as choreographies and an editor in the Flutter app. It is C++/ESP-IDF/LVGL code, not a JavaScript MOD that can be loaded directly into our host. The README warns that the public sources may come after the firmware and app releases.

## Robottino's adaptation

A touch receiver with a temporary smile, with no automatic voice and no memory writes, and with movement subject to the conditions given below. It keeps the mouth driven by FaceState. The timing of the Happy dance is used as a reference for a short, original, reduced sequence: 4.2 seconds, a relative swing of the head of ±0.15 rad, serialised transitions, no music or LEDs. It does not directly convert the units or speeds of the factory servos.

A single software owner of the movement: tracking or dance. The dance needs the movements switched on explicitly in the menu and waits for the previous pose to end; detections during the dance are not queued. At the end a fresh target is awaited. Switching off or stopping keeps the last commanded pose; it neither orders a jump to the centre nor suddenly removes torque. A transition already sent may finish.

The tracker no longer advances a virtual pose while the movements are off, so that the first command after switching on does not start from a position never asked of the motors. These software limits do NOT replace measuring the starting position and calibrating the physical K151.

## Validation and limits

31 project tests and 8 capability trials of the MOD passed, the typecheck succeeded and the release archive was rebuilt with the official Moddable SDK 10.0.2. The M5Stack MIT licence and Stack-chan's Apache-2.0 are kept with the sources and the archive. Still to be verified: hardware, firmware and partitions, calibration, real coordinates and directions, the Piu rendering, sharing of the sensor bus and the servos' response.

The iPhone app still has only the simulation of the movements and the camera section prepared: the real app/cloud/robot link is not implemented and no iPhone button starts this dance. The app update is built and signed, but the iPhone still does not offer the trusted connection to install it (CoreDevice 4016). The update script stays available for when the phone is connected and unlocked.

Touch update: a stroke on the head or a touch on the face shows a smile and soft red hearts for about 3 seconds. A small movement that returns to the previous pose is foreseen only with verified hardware, confirmed calibration, motors switched on locally and no remote command or dance in progress. Stop, switching off or an error interrupt the sequence without starting the return. The rendering of the decorations, the sensors and the movement have not yet been tried physically.
