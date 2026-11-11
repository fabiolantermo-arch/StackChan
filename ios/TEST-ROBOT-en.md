# The Test tab in the iPhone app

The Test tab is separate from Robot and Ricordi, with a Back button. Robot and Ricordi keep the recovery of the token from the Keychain and the automatic check of the backend on opening and on coming back to the foreground.

## Available in this version

- A simulation of the movements that is switched on explicitly, and off when leaving the tab and when the app is not active.
- Left/right/up/down in steps of 5°, centre and stop, for the simulation only; limits ±10°. No movement request is sent to the backend.
- An availability check through the authenticated request GET `/api/robot/status`. The route is now deployed and answers 200 with connected=false when the robot is offline. The working link is in the new Live tab, not in the simulated controls of Test.
- A robot camera section with the state "not available" and a disabled button. It does not use the iPhone's camera and shows no simulated images.

## To be implemented on the real link

The Test tab keeps its own simulated controls. The new [Live tab](../docs/LIVE-IPHONE-ROBOT-en.md) implements video, head, call, face imitation and sending pictures, with confirmation of the commands. It needs a configured, compatible MOD: no flashing was done.

## Checks

`node ios/test-connection.mjs` builds the production Swift model with a simulated network and Keychain and runs six checks: token recovery and reconnection, persistence after a restart, protection from a wrong token, first start without a token, the bounded simulation with no network commands, and the real controls disabled when the bridge is absent or positive but unverified. They are not tests of the UI on the device nor of the physical camera.

iOS build and signature check succeeded. The complete update, Live tab included, was installed and started on the physical iPhone on 6 November 2026 at 22:52, without uninstalling the earlier app. Use `Update Robottino.command` when the phone is connected and unlocked.

The script builds in a private temporary folder outside Documents, so that Finder/iCloud metadata do not invalidate the signature. Sources and logs stay in Robottino; the checks of signature, team and bundle ID remain mandatory.
