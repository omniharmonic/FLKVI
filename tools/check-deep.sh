#!/bin/bash
# Deterministic district, combat, weather and damage integration. Shared server required.
set -euo pipefail
cd "$(dirname "$0")/.."
exec tools/browser.sh 'set -e; agent-browser set viewport 1440 900; agent-browser open "http://127.0.0.1:5200/?autostart&city=boulder&nointro&nostream&time=16.4"; agent-browser wait --fn "!!window.gtUI"; agent-browser eval --stdin < tools/deep-browser-regressions.js; agent-browser errors'
