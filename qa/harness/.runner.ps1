# 运行独立 PsBridge 测试并把输出落盘（部署脚本生成，用后删除）
$out = node C:/WinVMBridge/.psbtest.mjs 2>&1 | Out-String
$out | Set-Content -Encoding utf8 C:/WinVMBridge/.psbtest.out
Write-Output $out
