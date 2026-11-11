# Updating Robottino on the iPhone

Double-click **Update Robottino.command**, in the project's root folder. Connect and unlock the iPhone 17 Pro Max; the Mac must be trusted by the device and Xcode must have a valid Apple Development certificate.

The script builds the current sources, signs only com.example.robottino, checks bundle and team, installs the update and opens the app. It does not uninstall the app, does not embed the backend's token and does not change Cloudflare or the robot's firmware. The memories stay on the server and the token stays in the iPhone's Keychain.

Logs and builds are in work/iphone-update, outside Git. `--check` verifies the project and that a certificate is there, without installing. If you change iPhone, set ROBOT_DEVICE_ID to the identifier of the authorised device.

First installation completed and signature verified on 6 November 2026. On first use, enter Robottino's own token in the app; do not enter the OpenAI or ElevenLabs keys.
