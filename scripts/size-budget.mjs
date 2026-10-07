#!/usr/bin/env node
// E13: 包体预算门禁。防止单文件产物无感膨胀（依赖内联、资源误入库、建模代码失控）。
// 预算是棘轮：上调必须是显式动作并在提交信息里说明原因（如 S10 目录扩容）。
// 用法: node scripts/size-budget.mjs   （CI 在 build 之后跑；本地 npm run size:check）
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// 预算（字节）。基线 2026-10-06：app.html 996,855 · dist/app.html 3,809,369（three 608KB +
// dxf 25KB + pdf ~1MB 内联）。留 ~10-15% 余量吸收正常增长。
const BUDGETS = [
  { path: 'app.html', max: 1_150_000, note: '唯一事实来源（含 275 条目录 + 146 模型）' },
  { path: 'dist/app.html', max: 4_200_000, note: '公开入口单文件（运行时库全部内联）' },
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
