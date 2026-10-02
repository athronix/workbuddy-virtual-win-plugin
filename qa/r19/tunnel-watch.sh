#!/bin/sh
cd /storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin
NODE=/data/storage/el1/bundle/libs/arm64/node/bin/node
for i in $(seq 1 40); do
  R=$($NODE -e "fetch('http://127.0.0.1:18443/health',{signal:AbortSignal.timeout(6000)}).then(r=>r.text()).then(t=>console.log('UP')).catch(e=>console.log('DOWN'))" 2>/dev/null)
  echo "$(date -Iseconds) $R"
  if [ "$R" = "UP" ]; then echo RECOVERED; exit 0; fi
  $NODE delivery/winvm-plugin.mjs tunnel ensure >/dev/null 2>&1
  sleep 20
done
echo NOT_RECOVERED
