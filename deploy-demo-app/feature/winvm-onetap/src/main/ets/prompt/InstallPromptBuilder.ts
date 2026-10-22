import { FIXED_SERVICE_PORT, WinvmConfig, ResolvedRelease } from '../domain/DeployModels';

// install prompt 生成器：逐字遵循父项目 docs/deploy/通过铠大师app安装部署.md §5.2 模板，
// 参数代入 {VERSION}/{VM_HOST}/{VM_USER}/{WINVM_VM_PROVIDER} + 高级设置项
// （SSH 端口/隧道本地端口/VM 部署目录/隧道后端/干跑/HOST_DEPLOY/VM_DEPLOY），
// 并追加步骤 9（report 旁写副本，供演示版 App 读回；父项目模板暂无，见 issues ID-2）。
// 目录命名（ID-1，spec 4.5.3 / design 1.1.2）：父模板写作 `~/Downloads/winvm-release`（复数），
// 与本机权威落包目录 `Download`（单数）不一致；此处统一为权威绝对路径，使步骤 1 的 curl 目标目录
// 与步骤 9 / App 读回目录语义一致（父文档命名偏差登记为 issues ID-1，见 .codeart-out/ISSUES.md）。
export class InstallPromptBuilder {

  static build(config: WinvmConfig, release: ResolvedRelease): string {
    const version = release.tag;
    const dryRunValue = config.dryRun ? '1' : '0';
    const hostDeployValue = config.hostDeploy ? '1' : '0';
    const vmDeployValue = config.vmDeploy ? '1' : '0';
    const prompt = `请在本鸿蒙机上安装部署 WinVM Bridge 发布版 ${version}，全程自动执行、无需向我确认，最后输出验证报告：

包来源：GitHub Release（匿名下载，见步骤 1）→ 落包目录：/storage/Users/currentUser/Download/winvm-release/
VM 地址：${config.vmHost}   VM 用户：${config.vmUser}   SSH 端口：${config.sshPort}   Provider：${config.provider}

步骤：
1. 从 GitHub Release 匿名下载发布包并校验（REL-11 起的分发起点）：
   mkdir -p /storage/Users/currentUser/Download/winvm-release && cd /storage/Users/currentUser/Download/winvm-release
   curl -L ${release.zipUrl} -o ${release.zipName}
   curl -L ${release.shaUrl} -o ${release.zipName}.sha256
   sha256sum -c ${release.zipName}.sha256 —— 非 OK 即弃包重取（旁挂校验文件与 zip 同为 Release 资产，Q-2）；
   校验通过后解压（unzip），cd <解压目录>/overall
   首机公钥摆渡（Q-1，一次性；已有 keypair 则整段跳过）：
   [ -f ~/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519
   mkdir -p /storage/Users/currentUser/.workbuddy/winvm && cp ~/.ssh/id_ed25519.pub /storage/Users/currentUser/.workbuddy/winvm/id_ed25519.pub
   ※ 只摆渡 .pub 到共享目录（供铠大师后续机注入）；**私钥 id_ed25519 绝不出沙箱**。
2. 写 .env：VM_HOST/VM_USER/VM_SSH_PORT=${config.sshPort}/VM_DEPLOY_DIR=${config.vmDeployDir}/WINVM_VM_PROVIDER=${config.provider}，WINVM_DRY_RUN=${dryRunValue}、HOST_DEPLOY=${hostDeployValue}、VM_DEPLOY=${vmDeployValue}、
   WINVM_SETUP_TUNNEL=1、WINVM_TUNNEL_LOCAL_PORT=${config.tunnelLocalPort}、WINVM_TUNNEL_REMOTE_PORT=${FIXED_SERVICE_PORT}、WINVM_SERVICE_PORT=${FIXED_SERVICE_PORT}、WINVM_TUNNEL_BACKEND=${config.tunnelBackend}。
3. 前置自检（只读）：node delivery/bootstrap.mjs check —— 有阻塞项先停下并把明细写进报告。
4. SSH 免密验证：ssh -o BatchMode=yes ${config.vmUser}@${config.vmHost} whoami —— 成功=铠大师公钥注入生效；
   失败则跑 node delivery/bootstrap.mjs trust（可能需要我输一次 VM 密码）；再失败即中止并写报告。
5. VM 前置兜底（须在第 4 步免密之后，本命令经 SSH 执行）：node delivery/bootstrap.mjs prepare-vm --apply --ensure-node
   —— 若铠大师「VM 环境准备」已做完，预期全 [SKIP]（幂等互证）。
6. 按发布铁律清空重装：bash deploy-all.sh --wipe（先双端 uninstall 清场，再 HOST→VM→VM-START→TUNNEL→TEST→QA-PROBE→HEALTH 七相位）。用 \`bash <script>\` 而非 \`./<script>\`——hmdfs 落包可能丢执行位，bash 显式解释不依赖 mode 位（Q-4）。
7. 部署成功后跑验证矩阵 7 项并把结果 JSON 写入 /storage/Users/currentUser/.workbuddy/winvm/deploy-report.json：
   {version, ok, finishedAt, phases:{...耗时}, checks:[{id,pass,evidence(traceId/字段摘要)}], failures:[...]}
8. 同时把同样内容贴回对话作为最终回复。任何一步失败：停止后续，report 里写明失败相位、错误原文、根因初判。
9. 部署状态旁写副本（供鸿蒙部署助手读回）：将第 7 步写出的报告复制一份到
   /storage/Users/currentUser/Download/winvm-release/deploy-report.json
   （mkdir -p /storage/Users/currentUser/Download/winvm-release 确保目录存在；
    本步为演示版追加的读回通道，不影响第 7 步规范路径本身，正式版应由父项目模板纳入）`;
    InstallPromptBuilder.assertNoPlaceholder(prompt);
    return prompt;
  }

  // 防呆：占位符必须全部被真实参数替换
  private static assertNoPlaceholder(prompt: string): void {
    const tokens: string[] = ['{VERSION}', '{VM_HOST}', '{VM_USER}', '{WINVM_VM_PROVIDER}'];
    for (const token of tokens) {
      if (prompt.indexOf(token) >= 0) {
        throw new Error(`E5001 prompt 占位符残留: ${token}`);
      }
    }
  }
}
