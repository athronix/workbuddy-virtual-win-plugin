$ErrorActionPreference='Continue'
$dir='C:/WinVMWorkspace/t6probe'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$srv=@'
const http=require("http");
const fs=require("fs");
const LOG=process.argv[2];
const srv=http.createServer((req,res)=>{
  const rec={url:req.url,method:req.method,auth:req.headers["authorization"]||"(none)",mcpsession:req.headers["mcp-session-id"]||"(none)"};
  fs.appendFileSync(LOG,"REQ:"+JSON.stringify(rec)+"\n");
  let b="";req.on("data",d=>b+=d);req.on("end",()=>{fs.appendFileSync(LOG,"BODY:"+b.slice(0,400)+"\n");});
  res.writeHead(500,{"content-type":"application/json"});
  res.end(JSON.stringify({jsonrpc:"2.0",error:{code:-32000,message:"probe"},id:null}));
});
srv.listen(18499,"127.0.0.1",()=>fs.appendFileSync(LOG,"LISTENING\n"));
'@
Set-Content -Path "$dir/headprobe-server.js" -Value $srv -Encoding ASCII
Remove-Item "$dir/headers.log" -ErrorAction SilentlyContinue
Remove-Item "$dir/cb.out" -ErrorAction SilentlyContinue
Remove-Item "$dir/cb.err" -ErrorAction SilentlyContinue
$env:WINVM_PROBE_TOKEN='t6-probe-secret-abc123'
$cfg=@'
{"mcpServers":{"winvm":{"type":"streamableHttp","url":"http://127.0.0.1:18499/mcp?dtid=t6probe","headers":{"Authorization":"Bearer ${WINVM_PROBE_TOKEN}"}}}}
'@
Set-Content -Path "$dir/cfg.json" -Value $cfg -Encoding ASCII
$sp=Start-Process -FilePath node -ArgumentList "`"$dir\headprobe-server.js`"","`"$dir\headers.log`"" -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2
"SERVER_PID=" + $sp.Id
$cli=(Get-Command codebuddy.cmd -ErrorAction SilentlyContinue).Source
if(-not $cli){ $cli=(Get-Command codebuddy -ErrorAction SilentlyContinue).Source }
"CLI=$cli"
$p=Start-Process -FilePath $cli -ArgumentList '-p','"Reply with exactly OK."','--output-format','text','--permission-mode','bypassPermissions','--strict-mcp-config','--mcp-config',"`"$dir\cfg.json`"" -WindowStyle Hidden -PassThru -RedirectStandardOutput "$dir/cb.out" -RedirectStandardError "$dir/cb.err"
$done=Wait-Process -Id $p.Id -Timeout 200 -ErrorAction SilentlyContinue
"EXITED=" + $p.HasExited
"----HEADERS.LOG----"
Get-Content "$dir/headers.log" -ErrorAction SilentlyContinue | Select-Object -First 24
"----CB.OUT----"
Get-Content "$dir/cb.out" -ErrorAction SilentlyContinue | Select-Object -First 8
"----CB.ERR----"
Get-Content "$dir/cb.err" -ErrorAction SilentlyContinue | Select-Object -First 24
if(-not $p.HasExited){ taskkill /PID $p.Id /T /F 2>&1 | Out-Null }
taskkill /PID $sp.Id /T /F 2>&1 | Out-Null
"PROBE_DONE"
