#!/bin/sh
cd /storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin
NODE=/data/storage/el1/bundle/libs/arm64/node/bin/node
for i in $(seq 1 80); do
  $NODE qa/r19/call.mjs qa/r19/mon-proc system.process.list '{}' >/dev/null 2>&1
  $NODE -e "
const j=JSON.parse(require('fs').readFileSync('qa/r19/mon-proc.resp.json','utf8'));
const arr=((j.payload||{}).result||{}).structuredContent?.data||[];
const hits=arr.filter(p=>/winget|Uninstall\.exe|Un\.exe|WXWork/i.test(p.name||''));
const line=Date.now()+' '+(hits.length?hits.map(p=>p.processId+':'+p.name+' ['+String(p.commandLine||'').slice(0,110)+']').join(' ;; '):'NONE');
require('fs').appendFileSync('qa/r19/e1-monitor.log', line+'\n');
" 2>/dev/null || echo "$(date +%s) MONITOR_READ_FAIL" >> qa/r19/e1-monitor.log
  sleep 4
done
