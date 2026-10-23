#!/usr/bin/env node
// E13: 包体预算门禁。防止单文件产物无感膨胀（依赖内联、资源误入库、建模代码失控）。
// 预算是棘轮：上调必须是显式动作并在提交信息里说明原因（如 S10 目录扩容）。
// 用法: node scripts/size-budget.mjs   （CI 在 build 之后跑；本地 npm run size:check）
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// 预算（字节）。基线 2026-10-06：app.html 996,855 · dist/app.html 3,809,369（three 608KB +
// dxf 25KB + pdf ~1MB 内联）。留 ~10-15% 余量吸收正常增长。
const BUDGETS = [
  // 2026-10-23 上调（显式）：home-v2 一整轮（S15 点位 / S16 房间与地板 / S17 多层与楼梯 / S18–S21）。
  // S15 + S16 已用掉 ~96KB（1,153KB → 1,249,888B，离旧预算只剩 112B）；S17–S21 预计再 +150–200KB。
  {
    path: 'app.html',
    max: 1_450_000,
    note: '唯一事实来源（含 298 条目录 + 157 模型 + S10 目录扩展协议 + home-v2 S15–S21 + S17b；剩 ~11KB，再加功能要显式上调）',
  },
  { path: 'dist/app.html', max: 4_400_000, note: '公开入口单文件（运行时库全部内联）' },
];

let fail = 0;
for (const b of BUDGETS) {
  let size;
  try {
    size = statSync(join(root, b.path)).size;
  } catch {
    console.error(`FAIL  ${b.path}: 不存在（先 npm run build）`);
    fail++;
    continue;
  }
  const pct = ((size / b.max) * 100).toFixed(1);
  const ok = size <= b.max;
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${b.path}: ${(size / 1024).toFixed(0)}KB / 预算 ${(b.max / 1024).toFixed(0)}KB (${pct}%) — ${b.note}`
  );
  if (!ok) fail++;
}
if (fail) {
  console.error('包体超预算。要么找出膨胀原因，要么显式上调 BUDGETS 并在提交信息里说明。');
  process.exit(1);
}
