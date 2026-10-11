# P2-T6 主理人复原留档（10:1x）
背景：T6 实例（agent-035fcebb）05:23 step17/18（真机 E2E/E3/E4 全实证落盘）后停摆，VM 遗留 enforce-on 补丁态逾 4.5h。SendMessage 续跑报 Not in a team（句柄失效）⇒ 主理人直接执行复原（环境安全项不等重派）。
- restore: ssh User@172.16.100.2 → node C:/WinVMBridge/tools-t6/t6-enforce-patch.mjs restore → RESTORED runtime+start-hidden（源=*.bak-p2t6，未覆写，原始字节可回收纪律由脚本头注保证）
- 复原哈希实测：runtime=f61dd89f9d558ef6… start-hidden=801038bc95a21b6e… 逐字节=窗口前基线（=T5 还原态，双窗口三点一致）
- kill-restart.ps1：new_service PID=232 Start=10/11 10:16（只 kill-restart，未重跑 install-vm）
- /health 终态（health-restore-1016.json）：authMode=loopback-only（Bearer-off ⇒ not-mounted/unverified 形态，与 j.security 实形一致）、provider=workbuddy state=ready ok=true ⇒ 三值回默认
- T5 的 *.bak-p2t5 未动；VM 侧遗留工具目录 C:/WinVMBridge/tools-t6（含 a2a-call/chain-readback/seq-dump/enforce-patch 脚本），非 git 面、无害，后续批清场可并。
待办移交第四段实例：全仓 sweep 落盘 + IS_PASS + 八项回报（编辑面/真机实证面全部已在盘，勿重做）。
