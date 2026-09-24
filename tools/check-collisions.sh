#!/bin/bash
# Real solver collisions, separate from authored damage and animation fixtures.
set -euo pipefail
cd "$(dirname "$0")/.."
exec tools/browser.sh 'set -e; agent-browser open "http://127.0.0.1:5200/?autostart&city=boulder&nointro&nostream"; agent-browser wait --fn "!!window.gtUI && !document.querySelector(\".gt-loading\") && game.elapsed>1"; agent-browser eval --stdin < tools/collision-regressions.js; agent-browser errors'
