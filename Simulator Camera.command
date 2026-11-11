#!/bin/bash
# Lends a camera to the iOS simulator (which has none): the iPhone's camera used as a webcam
# (Continuity Camera, always the rear one) or the Mac's own. On this Mac only.
# Then in the simulator: Studio → Inseguimento viso → Avvia inseguimento. Close the window to stop.
cd "$(dirname "$0")" || exit 1
exec xcrun swift scripts/mac-camera.swift "$@"
