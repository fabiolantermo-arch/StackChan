# Robottino's networks: home and iPhone hotspot

The Robot tab now shows the Wi-Fi section first and the secure link last, after model and voice and state.

## Two profiles

- **Home Wi-Fi:** the exact name of the network and its password. It is the network with priority.
- **iPhone hotspot:** the name of the hotspot's network and its password. It is the alternative when there is no home Wi-Fi.

"Salva e invia al robot" keeps both in the local Keychain, accessible only with the phone unlocked and without migration to other devices. No JSON file, UserDefaults, log or cloud service receives the passwords. The password fields are masked. Unsaved passwords are removed from the draft on leaving the tab or going to the background; saved ones can be read again from the Keychain when the app becomes active. "Rimuovi profili da questo iPhone" asks for confirmation and deletes only the dedicated Keychain entry, without changing token, memories or the robot's configuration.

One complete profile can be saved, or both. The names of the two networks must differ. Names are kept exactly as typed, significant spaces included, within 32 UTF-8 bytes. WPA passwords in the common format of 8–63 ASCII characters or 64 hexadecimal digits; this validation is not proof of compatibility or of authentication on the physical firmware.

## Hotspot

In the iPhone's Settings → Personal Hotspot switch on "Allow Others to Join" and "Maximise Compatibility". The hotspot's name is the iPhone's name; copy it exactly with its password. No name is made up by reading the generic value "iPhone" given to apps.

The K151 needs a 2.4 GHz network. Apple documents that Maximise Compatibility limits the hotspot to that band. The hotspot uses mobile data and depends on plan, carrier and coverage. Our app does not silently switch the hotspot on and does not change system settings.

## Available and still to be connected

**Available:** forms for the two profiles, saving/reading/removing in the Keychain, data checks and the "Controlla robot online" button. The latter only reads the relay's authenticated state: it tells apart a reachable robot, offline, a virtual device and an error. It does not show which network is in use, nor that the password entered is right. The check does not send the credentials.

**Not yet working on the robot:** the "Invia profili al robot" button is disabled. Model and firmware verification, a safe local way of pairing and installing the profiles on the robot are needed. Saving on the iPhone does not configure the robot's Wi-Fi.

The wanted policy is implemented in the pure module network-profiles.js and tested: it prefers home, chooses the hotspot if only that is visible, ignores unknown networks and 5 GHz channels, respects temporarily blocked networks and does not change network during a call or an activity marked as busy. When idle it may prefer home if it becomes visible again. A single missing scan result does not interrupt a connection still alive.

This module **is not connected to the radio driver or to the start-up cycle**, does not scan and does not change real networks. The current upstream host stores a single SSID/password pair in stored-wifi.ts: automatic switching between two profiles still needs an adapter for the verified firmware, attempts and timeouts, and trials of losing and regaining the network. The selection module is not included in the active MOD, to avoid replacing the host's Wi-Fi handling without hardware. No flashing was done.

M5Stack's factory firmware configures the network through its own Bluetooth pairing; it is not automatically the same protocol as the community Moddable host. No password is sent to the old protocol or to the backend to get around this verification.

## Tests

Swift trials on the production model with Keychain and network replaced: two profiles kept and restored, exact SSIDs, limits and duplicates refused, deletion and removal of the passwords from the draft, online state via GET without a body and no sending enabled. Tests of the network selection: home/hotspot, priority independent of the signal, unknown and 5 GHz networks, excluded network, change while busy, empty scan and ambiguous profiles. The overall verification can be repeated with Verify Robottino.command; real access to router and hotspot and automatic switching on the robot are not tested.

## Sources

- [M5Stack K151: 2.4 GHz network and initial pairing](https://docs.m5stack.com/en/StackChan).
- [Apple: connecting to the personal hotspot](https://support.apple.com/it-it/111785).
- [Apple: security and the 2.4 GHz compatibility mode](https://support.apple.com/it-ch/guide/security/secfd166f620/web).
- The pinned local upstream: firmware/host/modules/connectivity/stored-wifi.ts, network-manager.ts and network-service.ts; factory app: device_wifi_config.dart. None of their network handling was changed.

## The local path found in the Stack-chan firmware (7 November 2026)

A reading of the pinned upstream code (`host/app/setup-mode.ts`, `host/modules/connectivity/preference-server.ts`, `preference-write-guard.ts`, `preferences/consts.ts`), not tried on hardware:

- When **Settings** is opened on the robot, the host starts a UART-type Bluetooth LE server (service `6E400001-B5A3-F393-E0A9-E50E24DCCA9E`, name `STK`) and opens a **5-minute write window**. Outside the window writes are ignored.
- The phone writes JSON on the RX characteristic, even split over several packets (put back together within 3 seconds): `{"_batch":{"wifi.ssid":"…","wifi.password":"…"}}`. Only the keys listed in `PREF_KEYS` are accepted, among them `wifi.ssid` and `wifi.password`.
- The host stores **one network only**. The two home/hotspot profiles still need the adapter described above (`network-profiles.js`).
- **Security limit, accepted by the owner on 7 November 2026:** the UART channel does not encrypt the data at application level. During the 5 minutes, anyone within Bluetooth range could intercept the password; the robot also sends the current values back in a notification. The path stays local (no cloud).
- **App:** Robot tab → the robot's Wi-Fi → "Salva e invia al robot": after saving in the Keychain it sends both networks by itself, the hotspot first and then home, in the same Bluetooth session with a 1.5 s pause between the two (pressing it again repeats the sending). The Settings window must be opened on the robot first (5 minutes). The app looks for the service, switches the notifications on, writes UTF-8 pieces of 60 bytes with confirmation and declares success only when the robot notifies `wifi.ssid` and `wifi.password` equal to those sent (or already reported them equal). Timeouts: 20 s to find the robot, 8 s for the confirmation.

Before real use: confirm that the K151 runs this host and not M5Stack's factory firmware (which uses its own pairing), verify UUID and name on the device, and try writing and the network restart.

## Automatic home/hotspot switching (7 November 2026, only built and tested in simulation)

The base firmware has a single place for the network (`wifi.ssid`/`wifi.password`) and over Bluetooth accepts only those two keys. The MOD (`wifi-switch.js`) exports `onLaunch`, which the firmware runs **before** connecting:

1. it runs the firmware's original step unchanged (`app-default-behavior/on-launch`: splash, Settings, MOD handling) and meanwhile, every 300 ms, reads the saved network: every new network written during Settings is remembered in the `robottino` domain (`net0ssid`/`net0pass` main, `net1ssid`/`net1pass` reserve; the last one written becomes the main one). A robot already configured keeps its network as the main one;
2. if it remembers two networks, it looks for the visible networks (the firmware's `wifi-scan`, 6 s at most) and puts the main one in the firmware's place if it is visible, otherwise the reserve; if it sees neither it changes nothing and the firmware shows its "retry / no network" screen.

The passwords stay in the robot and in the iPhone's Keychain: they do not pass through the server. The MOD exports `onLaunch` only if the firmware has the module `app-default-behavior/on-launch`, so the Settings mode is never lost. To be verified on the K151: that the firmware reads the network from the preferences (some special test configurations fix it to empty at build time), the real length of the search and the restart with the reserve network.
