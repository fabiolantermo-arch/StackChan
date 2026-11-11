# Robottino for iPhone

*[Versione italiana](README-it.md) · English version*

A native SwiftUI app for iOS 18 or later. It is not distributed on the App Store or TestFlight: open `Robottino.xcodeproj` in Xcode, choose your own bundle identifier and signing team, and run it on your phone. The interface is in Italian.

What it does:

- **Robot**: whether the robot is online, the app's token, and the switch for following your face during a conversation.
- **Aspetto**: the face, the voice model and voice, and the language (Italian or English).
- **Studio**: a dance editor, expressions and a simulated link, usable without the robot.
- **Test**: pairing with a code and Wi-Fi over Bluetooth; **Live** (the robot's camera, a joystick for the head, face following, a call through the robot, pictures on its screen, dances); a voice conversation from the phone; **Ricordi**, what Robottino remembers, to read, add, edit and delete.

The app never talks to the robot directly: both connect to the Worker, which relays between them. The app's token (`ROBOT_API_TOKEN`) is pasted by the user and kept in the Keychain; provider keys never go in the app, and updating the app must never uninstall it (the Keychain and its data would be lost).

The code is in three files: `RobotLiveCore.swift` (pure logic, tested by `test-connection.swift`), `RobotLive.swift` (audio, camera and the Live screens) and `Sources.swift` (the main interface).

```sh
node ios/test-connection.mjs   # the logic tests, on the Mac
node ios/build-check.mjs       # builds and checks the signature, installs nothing
```

See also [TEST-ROBOT-en.md](TEST-ROBOT-en.md) and [STUDIO-en.md](STUDIO-en.md).
