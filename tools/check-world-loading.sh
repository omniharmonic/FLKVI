#!/bin/bash
# Hosted coverage and deliberate outage recovery. Shared dev server or WORLD_TEST_BASE required.
set -euo pipefail
cd "$(dirname "$0")/.."
read -r -d '' browser_commands <<'BROWSER' || true
set -e
base="${WORLD_TEST_BASE:-http://127.0.0.1:5200/}"
artifacts="${WORLD_TEST_ARTIFACTS:-/tmp/flk-world-loading}"
mkdir -p "$artifacts"
agent-browser network route '**/api/interpreter' --abort
agent-browser set viewport 1440 900
if [ "${WORLD_TEST_RECOVERY_ONLY:-0}" != 1 ]; then
for pin in 'city=frisco-co' 'city=moab' 'city=chicago-loop' 'lat=18.341&lon=-64.932'; do
  agent-browser open "${base}?autostart&${pin}&nointro&nostream&time=16.4&mode=freeroam"
  agent-browser wait --fn '!!window.gtUI && !document.querySelector(".gt-loading") && game.elapsed>3'
  agent-browser eval --stdin < tools/world-loading-browser.js
  agent-browser eval 'document.querySelectorAll(".gt-clickplay").forEach(e=>e.remove())'
  agent-browser errors
  case "$pin" in
    city=frisco-co) agent-browser screenshot "$artifacts/alpine.png";;
    city=moab) agent-browser screenshot "$artifacts/desert.png";;
    city=chicago-loop) agent-browser screenshot "$artifacts/urban.png";;
    *) agent-browser screenshot "$artifacts/st-thomas.png";;
  esac
done
fi
agent-browser network route "${base}world/**" --abort
agent-browser open "${base}?autostart&city=boulder&nointro&nostream&mode=freeroam"
agent-browser wait --fn '!!window.gtUI && !document.querySelector(".gt-loading") && game.elapsed>3'
agent-browser eval --stdin < tools/world-loading-browser.js
agent-browser network route "${base}recipes/*.json" --abort
for pin in 'city=boulder' 'lat=40.019&lon=-105.276'; do
  agent-browser open "${base}?autostart&${pin}&expect=generated&nointro&nostream&mode=freeroam"
  agent-browser wait --fn '!!window.gtUI && !document.querySelector(".gt-loading") && game.elapsed>3'
  agent-browser eval --stdin < tools/world-loading-browser.js
done
agent-browser eval '(async()=>{const g=game,s=g.world.streaming;g.paused=true;const r=[];for(const [i,j] of [[1,0],[2,0],[2,1]]){await s.request(i,j);const d=s.districts.get(`${i},${j}`);if(!d)throw Error(`Generated travel failed ${i},${j}`);g.player.respawn([(d.bounds.minX+d.bounds.maxX)/2,(d.bounds.minZ+d.bounds.maxZ)/2]);r.push({district:d.key,roads:d.recipe.roads.length,ready:s.isReady(g.player.position.x,g.player.position.z)});}return r;})()'

BROWSER
exec tools/browser.sh "$browser_commands"
