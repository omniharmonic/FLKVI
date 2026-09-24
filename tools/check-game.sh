#!/bin/bash
# Requires the shared Vite server at 127.0.0.1:5200 and agent-browser on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
exec tools/browser.sh 'set -e; agent-browser open "http://127.0.0.1:5200/src/game/dev/gamedev.html"; agent-browser wait --fn "!!window.game?.__gameplay"; agent-browser eval --stdin < tools/game-regressions.js'
