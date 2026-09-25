#!/bin/bash
# Live rendering/AI/retirement stress. Shared dev server or WORLD_TEST_BASE; no external map dependency.
set -euo pipefail
cd "$(dirname "$0")/.."
read -r -d '' browser_commands <<'BROWSER' || true
set -e
agent-browser network route '**/api/interpreter' --abort
agent-browser set viewport 1440 900
agent-browser open "${WORLD_TEST_BASE:-http://127.0.0.1:5200/}?autostart&city=boulder&nointro&nostream&time=16.4"
agent-browser wait --fn '!!window.gtUI && !document.querySelector(".gt-loading") && game.elapsed>3'
agent-browser eval '({readyMs:performance.now(),heapMB:Math.round(performance.memory.usedJSHeapSize/1048576),store:window.__worldStore})'
agent-browser eval --stdin < tools/world-soak.js
agent-browser wait 20000
agent-browser wait 20000
agent-browser wait 20000
agent-browser wait --fn 'window.__soak.done'
agent-browser eval 'if (__soak.error || __soak.errors.length || __soak.failedShaders || __soak.samples.length!==7 || __soak.samples.some(s=>!s.ready || s.paused)) throw Error(JSON.stringify(__soak)); ({...__soak,worldStore:window.__worldStore})'
agent-browser errors
agent-browser reload
agent-browser wait --fn '!!window.gtUI && !document.querySelector(".gt-loading") && game.elapsed>3'
agent-browser eval 'if(!window.__worldStore || window.__worldStore.cacheHits<1) throw Error("Warm reload did not reuse hosted map cache"); ({warmReadyMs:performance.now(),store:window.__worldStore})'
BROWSER
exec tools/browser.sh "$browser_commands"
