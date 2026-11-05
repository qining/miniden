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
  // 2026-10-24 再上调（显式）：home-v2 做完停在 1,438,814B（99.2%）。用户口径：功能和性能第一，预算挡路就直接上调 ——
  // 预算是防「无感膨胀」的护栏（依赖误内联、资源误入库），不是目标；留 ~18% 余量给后面的 bug 修复与功能。
  // 2026-10-30 再上调（显式）：S26 装修材料库（research/15 §5 估 +120–185KB：地面 42、公共色板 42、墙砖 / 墙纸程序化贴图、
  // 洗手台 5 形式 / 马桶 3 / 淋浴 5 / 浴缸 2 的 2D 图例 + 3D 建模、门板 / 窗格 / 百叶、选择器界面）。S25 收尾时已用 98.1%。
  // 2026-11-05 再上调（显式）：S27 装修材料库第二轮（research/16 §5 估 +110–170KB：3D 点选、踢脚线 / 天花 / 墙裙、五金色、
  // 卫浴细节、整屋配色、吊柜）。S27a + S27b 落地后 app.html 用到 96.0%，后面三包装不下。
  {
    path: 'app.html',
    max: 2_150_000,
    note: '唯一事实来源（含 298 条目录 + 157 模型 + S10 目录扩展协议 + home-v2 S15–S21 + S17b + S25 + S26 / S27 材料库）',
  },
  { path: 'dist/app.html', max: 5_170_000, note: '公开入口单文件（运行时库全部内联；2026-11-05 随 app.html 上调）' },
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
