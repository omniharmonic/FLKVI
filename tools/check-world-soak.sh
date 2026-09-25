#!/bin/bash
# Live rendering/AI/retirement stress. One browser, shared dev server, no external map dependency.
set -euo pipefail
cd "$(dirname "$0")/.."
exec tools/browser.sh 'set -e; agent-browser network route "**/api/interpreter" --abort; agent-browser open "http://127.0.0.1:5200/?autostart&city=boulder&nointro&nostream&time=16.4"; agent-browser wait --fn "!!window.gtUI && !document.querySelector(\".gt-loading\") && game.elapsed>3"; agent-browser eval --stdin < tools/world-soak.js; agent-browser wait 20000; agent-browser wait 20000; agent-browser wait 20000; agent-browser wait --fn "window.__soak.done"; agent-browser eval "if (__soak.error || __soak.errors.length || __soak.failedShaders || __soak.samples.length!==7 || __soak.samples.some(s=>!s.ready || s.paused)) throw Error(JSON.stringify(__soak)); __soak"; agent-browser errors'
