// 生成 TASK-001 交付日志（程序化，避免手工转录误差）
const fs = require('fs');
const path = require('path');
const OUT = '/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin/deploy-demo-app/.codeart-out';
const TRY = path.join(OUT, '_lint-try');
const TS = '20261020-181433';
const strip = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '').replace(/\\n/g, '\n');

function loadDiag(tag) {
  const arr = JSON.parse(fs.readFileSync(path.join(TRY, 'diaglog-' + tag + '.json'), 'utf8'));
  return arr.map((d) => ({
    level: d.level || 'info',
    text: strip(d.m).trim(),
  }));
}

function fmt(entries, wantLevel) {
  let out = '';
  let n = 0;
  for (const e of entries) {
    if (wantLevel && e.level !== wantLevel) continue;
    n++;
    const t = e.text.replace(/\n\s*/g, ' | ');
    out += '  ' + String(n).padStart(2, '0') + ') [' + e.level.toUpperCase() + '] ' + t + '\n';
  }
  if (n === 0) out = '  (无)\n';
  return out;
}

const feat = loadDiag('feature');
const prod = loadDiag('product');
const all = feat.concat(prod);
const errs = all.filter((e) => e.level === 'error');
const warns = all.filter((e) => e.level === 'warn');

const cl = `================================================================================
TASK-001 · ArkTS 规则检查（codelinter）执行日志
================================================================================
时间戳        : ${TS}
执行者        : CodeArts Agent（HarmonyOS PC 沙箱）
工程根目录    : /storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin/deploy-demo-app
任务文件      : .codeart-tasks/TASK-001.md
检查引擎      : SDK 内置 ets-loader ArkTS Linter（官方 codelinter 不可用时的编译器级替代，见 §1/§3）
引擎模式      : STANDARD_MODE（完整 ArkTS 规则集）
ArkTS 版本    : ArkTS_1_1

================================================================================
【0】结论摘要
================================================================================
  · ArkTS 规则（arkts-no-* 等 STANDARD_MODE 规则）违反数 ......... 0
  · 编译/类型层 ERROR ............................................. ${errs.length}
  · WARNING（API 检查器常规提示）.................................. ${warns.length}
  · 官方 codelinter CLI 可用性 .................................... 否（未安装，见 §1）
  · 官方 hvigorw 可用性 .......................................... 否（未安装，见 §1）

  ⚠ 与 WB 自审结论对照：ArkTS 语法/规则层面 0 violations 成立；
    但 API/类型层面被编译器/检查器报出 12 条 ERROR（WB 自审未覆盖），因此
    “0 violations”结论在更严格的 API/类型维度被推翻。详见 §7。

================================================================================
【1】官方工具可用性核查（权威证据）
================================================================================
  命令: for t in codelinter hvigorw ohpm devecocli; do command -v "$t"; done
  结果:
    codelinter : NOT FOUND
    hvigorw    : NOT FOUND   （且工程内不存在 hvigorw wrapper 脚本）
    ohpm       : NOT FOUND
    devecocli  : NOT FOUND   （hmosBuild 工具报告 "devecocli not found and auto-install failed"）
  全盘搜索: find / -iname "*codelinter*" -o -iname "*hvigor*" -o -iname "ohpm*" -o -iname "*devecocli*"
    → 0 命中
  Node 运行时: /data/service/hnp/bin/node v24.13.0
    → 默认 JIT 下任何脚本执行均崩溃: "Fatal error ... Check failed: 12 == (*__errno_location())" / Signal 5
    → 仅 'node --jitless' 可正常执行（本日志使用该模式驱动 Linter）
  可用 SDK: /data/service/hnp/ohos-sdk.org/ohos-sdk_26.0.0.18/ohos
    → ets/ build-tools/ets-loader（含 ArkTS Linter）、toolchains/（hdc、restool、hap-sign-tool 等）
    → 但不含 hvigor / codelinter / ohpm 二进制

================================================================================
【2】tools/build.sh 原始执行（任务指定命令）
================================================================================
  $ bash tools/build.sh all
    [17:56:21] ==> [1/2] codelinter (ArkTS 规则检查)
    [17:56:21] ERR: 未找到 codelinter / hvigorw。
    [17:56:21]     请在 CodeArts Agent 中用内置 DevEco CLI 执行 Code Linter，并把完整输出贴到:
                     .codeart-out/codelinter-20261020-175621.log
    [17:56:21] ==> [2/2] assembleHap (构建 HAP)
    [17:56:21] ERR: 未找到 hvigorw wrapper。
    [17:56:21]     请在 CodeArts Agent 中: 1) Sync / ohpm install  2) 用内置 DevEco CLI 构建 HAP
    [17:56:21] ==> 完成, rc=4
  → 退出码 rc=4；脚本预建的 codelinter-*.log / assembleHap-*.log 均为 0 字节（无内容）。

================================================================================
【3】替代执行方案（编译器级权威）
================================================================================
  codelinter CLI 本质是调用 ets-loader 内嵌的 ArkTS Linter。本执行直接驱动同一引擎：
    require('.../ets-loader/lib/ets_checker.js').etsStandaloneChecker(files, logger, options)
    → 内部: createLanguageService() → runArkTSLinter()
    → 核心: typescript@4.9.5-r4 的 ts.ArkTSLinter_1_1.runArkTSLinter(program, ...)
  驱动脚本: .codeart-out/_lint-try/do_lint.cjs
  原始诊断: .codeart-out/_lint-try/diaglog-feature.json / diaglog-product.json
  说明: 按模块传 module.json5（Stage 模型），并设 compatibleSdkVersion=20 → STANDARD_MODE。

  §4/§5 为逐条原始输出（去 ANSI 着色）。

================================================================================
【4】ERROR（共 ${errs.length} 条）
================================================================================
${fmt(all, 'error')}
================================================================================
【5】WARNING（共 ${warns.length} 条）
================================================================================
${fmt(all, 'warn')}
================================================================================
【6】.ts 文件的 es2abc 真实编译验证（补充）
================================================================================
  工具: .../ets-loader/bin/ark/build/bin/es2abc（es2panda，原生 aarch64）
  命令: es2abc --extension ts --module --output <out.abc> <file>
  结果: 以下 9 个业务/工具 .ts 全部编译成功（rc=0），无语法错误：
    feature/winvm-onetap/src/main/ets/data/DeployEngine.ts ............ OK
    feature/winvm-onetap/src/main/ets/data/GitHubReleaseClient.ts ..... OK
    feature/winvm-onetap/src/main/ets/data/Sha256Verifier.ts .......... OK
    feature/winvm-onetap/src/main/ets/data/ZipExtractor.ts ............ OK
    feature/winvm-onetap/src/main/ets/data/SharedDirStore.ts .......... OK
    feature/winvm-onetap/src/main/ets/data/ClipboardService.ts ........ OK
    feature/winvm-onetap/src/main/ets/domain/DeployModels.ts .......... OK
    feature/winvm-onetap/src/main/ets/prompt/InstallPromptBuilder.ts .. OK
    feature/winvm-onetap/src/main/ets/util/Logger.ts .................. OK
  注: .ets 含 ArkUI 装饰器语法，es2abc 无法直接编译（需 ets-loader 预处理），
      故 .ets 的检查以 §3 的 ArkTS Linter 结果为准。

================================================================================
【7】分类与真值裁决（供 WB 修码）
================================================================================
  A. 确认为“真实代码问题”（已用 SDK .d.ts 独立核验，建议修复）
     A1. feature/.../ui/DeployPage.ets:74:8  ERROR
         Property 'space' does not exist on type 'ColumnAttribute'.
         核验: ets/component/column.d.ts 中 space 仅为构造参数 ColumnOptions 字段，无 .space() 属性方法。
         修法: 改为 Column({ space: 12 }) { ... } 构造参数写法。
     A2. feature/.../ui/DeployPage.ets:174:12 ERROR
         Property 'fontSize' does not exist on type 'SelectAttribute'.
         核验: ets/component/select.d.ts 无 fontSize 属性。
         修法: Select 用 .font(...) 设置文字样式，或移除 .fontSize()。
     A3. feature/.../ui/DeployPage.ets:281:27 / 332:29 / 390:31  ERROR（同类 3 处）
         Argument of type 'TextOverflow' is not assignable to parameter of type 'TextOverflowOptions'.
         核验: ets/component/text.d.ts:863  textOverflow(options: TextOverflowOptions)。
         修法: .textOverflow({ overflow: TextOverflow.Ellipsis }) 。

  B. 环境/模式相关（standalone 环境未完整复刻 hvigor Stage 上下文；工程实为 Stage 模型）
     报错文本: "This API is used only in Stage Mode, but the current Mode is FA."
     位置: SharedDirStore.ts:24:38, :25:30（abilityAccessCtrl.requestPermissionsFromUser(this.context,...)）
           DeployEngine.ts:45:38（this.context.cacheDir，Stage Context）
           DeployPage.ets:550:45（this.getUIContext().getHostContext()）
           product/.../EntryAbility.ets:8:43, :15:17
     判定: 上述均使用 Stage 模型 API（Context / UIAbility / UIContext），工程亦为 Stage
           （存在 module.json5 且已设 compileMode=moduleJson）。该诊断与真实 Stage 语义不符，
           判为 harness 环境产物；建议在 DevEco 真实构建中复核。

  C. 依赖未安装导致（非源码缺陷）
     product/.../pages/Index.ets:2:28  "Cannot find module 'winvm_onetap'"（HAR 依赖未 ohpm install）
     feature/.../hvigorfile.ts:1:27 / product/.../hvigorfile.ts:1:26  "Cannot find module '@ohos/hvigor'"（构建脚本依赖）
     判定: 执行 ohpm install / Sync 后应消除。

  D. WARNING 说明（40 条）
     · "Function may throw exceptions. Special handling is required." —— SDK API 检查器常规提示，非 ArkTS 规则违反。
     · "To use this API, you need to apply for the permissions: ohos.permission.INTERNET" —— 需在 module.json5 声明 INTERNET 权限。

================================================================================
【8】复现步骤
================================================================================
  1) cd <工程根>
  2) bash tools/build.sh all                         # 观察 rc=4（官方链缺失）
  3) FF=$(grep '^feature/' .codeart-out/_lint-try/filelist.txt | grep -v hvigorfile.ts | tr '\\n' ' ')
     node --jitless .codeart-out/_lint-try/do_lint.cjs "$PWD" \\
       "$PWD/feature/winvm-onetap/src/main/module.json5" feature $FF
  4) PF=$(grep '^product/' .codeart-out/_lint-try/filelist.txt | grep -v hvigorfile.ts | tr '\\n' ' ')
     node --jitless .codeart-out/_lint-try/do_lint.cjs "$PWD" \\
       "$PWD/product/phone/src/main/module.json5" product $PF
  5) 查看 .codeart-out/_lint-try/diaglog-feature.json / diaglog-product.json
================================================================================
END OF codelinter log
`;

fs.writeFileSync(path.join(OUT, 'codelinter-' + TS + '.log'), cl);

const ah = `================================================================================
TASK-001 · HAP 构建（assembleHap）执行日志
================================================================================
时间戳        : ${TS}
执行者        : CodeArts Agent（HarmonyOS PC 沙箱）
工程根目录    : /storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin/deploy-demo-app

================================================================================
【0】结论
================================================================================
  · 构建结果: 失败 —— 未能产出任何 HAP。
  · 最终退出码: build.sh build → rc=2；hmosBuild → status=failed。
  · 产物 HAP 绝对路径: 无（未产出）。
  · 根因: 官方构建链 hvigorw / devecocli 在本环境不可用（并伴随签名配置缺失）。

================================================================================
【1】tools/build.sh build（任务指定命令）
================================================================================
  $ bash tools/build.sh build
    [..] ==> [2/2] assembleHap (构建 HAP)
    [..] ERR: 未找到 hvigorw wrapper。
    [..] 请在 CodeArts Agent 中: 1) Sync / ohpm install  2) 用内置 DevEco CLI 构建 HAP
  → rc=2。工程根与各模块均无 hvigorw wrapper（find 0 命中）。

================================================================================
【2】CodeArts 内置 hmosBuild 尝试（deveco CLI 通道）
================================================================================
  尝试 2-1（原工程 build-profile.json5）:
    status = failed
    errors = ["Signing config \\"default\\" not found in build-profile.json5"]
    原因: build-profile.json5 的 app.signingConfigs 为空数组 []，而 product "default"
          引用了 signingConfig="default"，导致签名预检失败（尚未进入编译）。

  尝试 2-2（在 .codeart-out/_build-try 副本中注入调试签名后再试；原工程零改动）:
    注入内容: signingConfigs[0] = { name:"default", type:"HarmonyOS", material:{
      storeFile  = <SDK>/toolchains/lib/OpenHarmony.p12,
      certpath   = <SDK>/toolchains/lib/OpenHarmonyApplication.pem,
      profile    = <SDK>/toolchains/lib/OpenHarmonyProfileDebug.pem,
      signAlg    = "SHA256withECDSA", keyAlias="OpenHarmony Application Release" } }
    status = failed
    errors = ["devecocli not found and auto-install failed. Please install manually:
               npm install -g @deveco/deveco-cli@stable  Or set DEVECO_CLI_PATH ..."]

================================================================================
【3】原因分析
================================================================================
  · hvigor / hvigorw 不存在 → 无 HAP 构建编排器（无法执行 compile→pack→sign 流程）。
  · devecocli 不存在且自动安装失败（npm 二进制在本环境崩溃：Signal 5；仅 node --jitless 可用）。
  · 网络可达（registry.npmjs.org / repo.harmonyos.com 均 HTTP 200），但 npm 客户端不可用，
    故无法通过 "npm install -g @deveco/deveco-cli@stable" 补救。
  · 工程根未执行过 ohpm install，无 node_modules / oh_modules，HAR 依赖亦未就绪。

================================================================================
【4】本环境已具备、可供后续真机构建参考的材料
================================================================================
  · OpenHarmony SDK: /data/service/hnp/ohos-sdk.org/ohos-sdk_26.0.0.18/ohos
  · 调试签名材料（SDK 自带）: <SDK>/toolchains/lib/
      OpenHarmony.p12 / OpenHarmonyApplication.pem / OpenHarmonyProfileDebug.pem
      UnsgnedDebugProfileTemplate.json / hap-sign-tool / ohos_packing_tool
  · ArkTS 编译器: <SDK>/ets/build-tools/ets-loader/bin/ark/build/bin/es2abc
  · 结论: 若在装有 DevEco Studio / devecocli 的完整环境执行
      "hvigorw assembleHap"（或 IDE 构建），并配好上述 debug 签名，即可产出 HAP。

================================================================================
【5】复现步骤
================================================================================
  bash tools/build.sh build                 # 观察 rc=2（无 hvigorw）
  然后（在具备 devecocli 的环境）:
    export DEVECO_CLI_PATH=<devecocli 路径>
    <deveco cli> build --project <工程根> --build-mode debug --product default
================================================================================
END OF assembleHap log
`;

fs.writeFileSync(path.join(OUT, 'assembleHap-' + TS + '.log'), ah);
console.log('written: codelinter-' + TS + '.log, assembleHap-' + TS + '.log');
console.log('errors=' + errs.length + ' warns=' + warns.length);