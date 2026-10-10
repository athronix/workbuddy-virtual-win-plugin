// L2-D 探针辅助（VM 侧）：备份运行配置并把 agent.provider 切到 workbuddy-deterministic
// 用法: node l2d-switch.mjs <runtime.json 路径> <备份路径> <目标 provider>
import { readFileSync, writeFileSync, copyFileSync, existsSync, statSync } from 'node:fs';

const [, , runtimePath, backupPath, target] = process.argv;
if (!runtimePath || !backupPath || !target) {
  console.error('usage: node l2d-switch.mjs <runtime> <backup> <provider>');
  process.exit(2);
}

const raw = readFileSync(runtimePath, 'utf8');
const before = JSON.parse(raw);

if (!existsSync(backupPath)) {
  copyFileSync(runtimePath, backupPath);
  console.log('backup_created', backupPath, statSync(backupPath).size);
} else {
  console.log('backup_exists', backupPath, statSync(backupPath).size);
}

// 只改 agent.provider，其余键（含 $schema/comment/security.tasks 等）逐字保留
before.agent = before.agent ?? {};
const previous = before.agent.provider;
before.agent.provider = target;
writeFileSync(runtimePath, JSON.stringify(before, null, 2) + '\n', 'utf8');
console.log('provider', previous, '->', target);

const check = JSON.parse(readFileSync(runtimePath, 'utf8'));
console.log('verify.agent.provider =', check.agent.provider);
console.log('verify.keys =', Object.keys(check).join(','));
console.log('verify.providers =', Object.keys(check.agent.providers ?? {}).join(','));
