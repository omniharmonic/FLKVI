#!/bin/bash
# Full city integration and frozen-scene rendering comparison. Requires the shared Vite server.
set -euo pipefail
cd "$(dirname "$0")/.."
export GT_TEST_CITY="${1:-boulder}"
exec tools/browser.sh 'set -e; agent-browser set viewport 1440 900; agent-browser open "http://127.0.0.1:5200/?autostart&city=${GT_TEST_CITY}&nointro&nostream&prof&quality=high&time=16.4"; agent-browser wait --fn "!!window.gtUI"; agent-browser wait 10000; agent-browser eval --stdin < tools/world-regressions.js; agent-browser errors'
