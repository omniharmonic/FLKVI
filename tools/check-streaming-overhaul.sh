#!/bin/bash
# Multi-ring offline streaming, curved-network continuity, disposal and a real vehicle seam crossing.
set -euo pipefail
cd "$(dirname "$0")/.."
exec tools/browser.sh 'set -e; agent-browser network route "**/api/interpreter" --abort; agent-browser open "http://127.0.0.1:5200/?autostart&city=boulder&nointro&nostream"; agent-browser wait --fn "!!window.gtUI && !document.querySelector(\".gt-loading\") && game.elapsed>3"; agent-browser eval --stdin < tools/streaming-overhaul-browser.js; agent-browser errors'
