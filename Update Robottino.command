#!/bin/bash
set -euo pipefail

# Relocatable updater for this app only. No cloud deployment, firmware flash or uninstall.
ROBOT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROBOT_DEVICE="${ROBOT_DEVICE_ID:-00000000-0000000000000000}"
ROBOT_TEAM="TEAMID0000"
ROBOT_BUNDLE="com.example.robottino"
ROBOT_WORK="$ROBOT_ROOT/work/iphone-update"

finish() {
  local result=$?
  # The temporary build (~130 MB) is never reused: remove it, and only that folder.
  case "${ROBOT_BUILD:-}" in /private/tmp/robottino-iphone-build.*) rm -rf "$ROBOT_BUILD" ;; esac
  if [[ $result -ne 0 ]]; then
    printf '\nAggiornamento non completato. Controlla il messaggio sopra e sblocca l’iPhone.\n'
    printf 'L’app già presente non è stata disinstallata. Log: %s\n' "$ROBOT_WORK/build.log"
  fi
  if [[ -t 0 && -t 1 ]]; then
    printf '\nPremi Invio per chiudere.'
    read -r _ || true
  fi
  exit "$result"
}
trap finish EXIT

[[ -f "$ROBOT_ROOT/ios/Robottino.xcodeproj/project.pbxproj" ]] || { printf 'Progetto Robottino non trovato accanto allo script.\n'; exit 1; }
command -v xcodebuild >/dev/null || { printf 'Installa e configura Xcode prima di aggiornare.\n'; exit 1; }
if ! security find-identity -v -p codesigning | grep -q 'Apple Development:'; then
  printf 'Nessun certificato Apple Development valido. Controlla l’account in Xcode.\n'
  exit 1
fi
mkdir -p "$ROBOT_WORK"
if [[ "${1:-}" == '--check' ]]; then
  printf 'Progetto e certificato presenti. Nessuna compilazione o installazione effettuata.\n'
  exit 0
fi
printf 'Aggiornamento Robottino. Tieni l’iPhone collegato e sbloccato.\n'
xcrun devicectl device info details --device "$ROBOT_DEVICE" --timeout 20 > "$ROBOT_WORK/device-check.log" 2>&1 || {
  printf 'iPhone non raggiungibile. Collegalo, sbloccalo e autorizza il Mac.\n'
  exit 1
}
printf 'Compilazione e firma in corso…\n'
# Build outside synced Documents: Finder/file-provider metadata invalidates signing.
# mktemp creates a private, unique build directory; sources/logs stay in Robottino.
ROBOT_BUILD="$(mktemp -d /private/tmp/robottino-iphone-build.XXXXXX)"
ROBOT_APP="$ROBOT_BUILD/Build/Products/Debug-iphoneos/Robottino.app"
if ! xcodebuild -quiet -project "$ROBOT_ROOT/ios/Robottino.xcodeproj" -scheme Robottino \
  -configuration Debug -destination 'generic/platform=iOS' \
  -derivedDataPath "$ROBOT_BUILD" -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$ROBOT_TEAM" build > "$ROBOT_WORK/build.log" 2>&1; then
  tail -n 35 "$ROBOT_WORK/build.log"
  exit 1
fi
codesign --verify --deep --strict "$ROBOT_APP"
[[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$ROBOT_APP/Info.plist")" == "$ROBOT_BUNDLE" ]] || { printf 'Identificativo app inatteso. Installazione annullata.\n'; exit 1; }
codesign -d --verbose=2 "$ROBOT_APP" 2>&1 | grep "TeamIdentifier=$ROBOT_TEAM" >/dev/null || { printf 'Team di firma inatteso. Installazione annullata.\n'; exit 1; }
printf 'Installazione sull’iPhone…\n'
xcrun devicectl device install app --device "$ROBOT_DEVICE" "$ROBOT_APP" --timeout 60
printf 'Apertura Robottino…\n'
xcrun devicectl device process launch --device "$ROBOT_DEVICE" --terminate-existing "$ROBOT_BUNDLE" --timeout 30
printf '\nRobottino aggiornato e avviato.\n'
