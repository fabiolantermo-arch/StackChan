#!/bin/bash
set -euo pipefail
ROBOT_CHECK_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROBOT_CHECK_ROOT"
node scripts/verify.mjs --iphone-build "$@"
if [[ -t 0 && -t 1 ]]; then
  printf '\nPremi Invio per chiudere.'
  read -r _ || true
fi
