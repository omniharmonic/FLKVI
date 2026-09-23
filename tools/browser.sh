#!/bin/bash
# Serialized headless-browser access for agents. Only ONE Chromium may run at a time on this machine
# (software WebGL is CPU-heavy; parallel browsers crashed the host).
# Usage: tools/browser.sh '<shell commands using agent-browser>'
#   e.g. tools/browser.sh 'agent-browser open "http://127.0.0.1:5200/?autostart"; sleep 30; agent-browser screenshot /path/shot.png'
# Waits for the lock, runs your commands with a 240 s hard cap, then always closes the browser.
LOCK=/tmp/groundtruth-browser.lock
MAX=240
while ! mkdir "$LOCK" 2>/dev/null; do
  age=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || date +%s) ))
  if [ "$age" -gt $((MAX + 60)) ]; then rmdir "$LOCK" 2>/dev/null; fi
  sleep 3
done
export AGENT_BROWSER_SESSION=gt-shared
# Cap test-browser memory so a heavy city load cannot starve the host.
export AGENT_BROWSER_ARGS="--js-flags=--max-old-space-size=1536,--renderer-process-limit=2,--disable-gpu-shader-disk-cache"
cleanup() { agent-browser close >/dev/null 2>&1; rmdir "$LOCK" 2>/dev/null; }
trap cleanup EXIT INT TERM
agent-browser set viewport 1024 576 >/dev/null 2>&1
bash -c "$1" &
pid=$!
( sleep $MAX; kill -TERM $pid 2>/dev/null; echo "[browser.sh] hit ${MAX}s cap, killed" >&2 ) &
watchdog=$!
wait $pid; status=$?
kill $watchdog 2>/dev/null
exit $status
