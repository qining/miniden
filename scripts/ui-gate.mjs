#!/usr/bin/env node
/* E16 — UI 黄金截图门禁（R10 关 C 的实现）
 *
 * 用法：
 *   node scripts/ui-gate.mjs                 # 8 个 #ui:* 状态全部截图并与 private/golden/ 基线比对
 *   node scripts/ui-gate.mjs --update        # 重拍基线（显式动作！改样式的 PR 必须贴新旧对比）
 *   node scripts/ui-gate.mjs 2d night        # 只跑指定状态
 *   node scripts/ui-gate.mjs --selftest      # 同一状态截两次，md5 必须一致（本机确定性体检）
 *
 * 规则（R10）：
 *   本地：像素 diff 比例 ≤0.3% 为 PASS；超限输出 diff 图（差异像素标红）到 private/golden/
 *   CI：  黄金基线由 CI 环境生成；同代码两次渲染 md5 必须一致（--selftest 即其本地等价物）
 *
 * 环境（CI 适配）：
 *   CHROME=/path/to/chrome        默认 macOS Google Chrome
 *   UG_WINDOW=1700x1100           固定窗口（换窗口 = 全部重拍基线）
 *   UG_BUDGET2D / UG_BUDGET3D     各状态 virtual-time-budget（ms）
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gold = join(root, 'private', 'golden');
const shots = join(gold, 'shots');

const CHROME =
  process.env.CHROME ||
  (process.env.CI === 'true' ? 'google-chrome' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const CI_FLAGS = process.env.CI === 'true' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
const [W, H] = (process.env.UG_WINDOW || '1700,1100').split(',').map(Number);
const BUDGET = {
  '2d': +(process.env.UG_BUDGET2D || 20000),
  '2d-sel': +(process.env.UG_BUDGET2D || 20000),
  ft: +(process.env.UG_BUDGET2D || 20000),
  collapsed: +(process.env.UG_BUDGET2D || 20000),
  '3d': +(process.env.UG_BUDGET3D || 60000),
  fp: +(process.env.UG_BUDGET3D || 60000),
  night: +(process.env.UG_BUDGET3D || 60000),
  dlg: +(process.env.UG_BUDGET3D || 60000),
};
const THRESH = +(process.env.UG_THRESH || 0.003); // 本地 ≤0.3%
const TOL = 4; // 单通道容差（抗 swiftshader 微噪声）

const ALL = Object.keys(BUDGET);
const args = process.argv.slice(2);
const update = args.includes('--update');
const selftest = args.includes('--selftest');
const want = args.filter((a) => !a.startsWith('--'));
const states = want.length ? want : ALL;
if (states.some((s) => !ALL.includes(s))) {
  console.error(`未知状态: ${states.filter((s) => !ALL.includes(s))}（可选 ${ALL}）`);
  process.exit(2);
}

mkdirSync(shots, { recursive: true });

function shoot(state, out) {
  // S10：截 dist（本地注入了 mine.json，与 private/golden 的 mine 基线对应；
  // CI 无 private/ → dist 是 generic → CI 用自己的 golden）
  const url = `file://${join(root, 'dist', 'planner.html')}#ui:${state}`;
  execFileSync(
    CHROME,
    [
      '--headless',
      '--use-angle=swiftshader',
      ...CI_FLAGS,
      `--screenshot=${out}`,
      `--window-size=${W},${H}`,
      `--virtual-time-budget=${BUDGET[state]}`,
      url,
    ],
    { stdio: 'ignore', env: { ...process.env, MallocNanoArena: '1' } }
  );
  if (!existsSync(out)) throw new Error(`screenshot 未生成: ${out}`);
}
const md5 = (f) => createHash('md5').update(readFileSync(f)).digest('hex');

function diffPng(a, b) {
  const pa = PNG.sync.read(readFileSync(a));
  const pb = PNG.sync.read(readFileSync(b));
  if (pa.width !== pb.width || pa.height !== pb.height)
    return { diff: 1, why: `尺寸不同 ${pa.width}x${pa.height} vs ${pb.width}x${pb.height}` };
  const n = pa.width * pa.height;
  let bad = 0;
  const d = pa.data,
    e = pb.data;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (
      Math.abs(d[o] - e[o]) > TOL ||
      Math.abs(d[o + 1] - e[o + 1]) > TOL ||
      Math.abs(d[o + 2] - e[o + 2]) > TOL ||
      Math.abs(d[o + 3] - e[o + 3]) > TOL
    )
      bad++;
  }
  return { diff: bad / n, why: '' };
}

// ---- selftest：同状态两次截图 md5 必须一致 ----
if (selftest) {
  let ok = true;
  for (const s of states) {
    shoot(s, join(shots, `st1-${s}.png`));
    shoot(s, join(shots, `st2-${s}.png`));
    const a = md5(join(shots, `st1-${s}.png`)),
      b = md5(join(shots, `st2-${s}.png`));
    const same = a === b;
    if (!same) ok = false;
    console.log(`${same ? 'PASS' : 'FAIL'} selftest:${s} | md5 ${a} vs ${b}`);
  }
  process.exit(ok ? 0 : 1);
}

// ---- 常规门禁 ----
let fail = 0;
for (const s of states) {
  const shot = join(shots, `${s}.png`);
  const base = join(gold, `${s}.png`);
  shoot(s, shot);
  if (update) {
    copyFileSync(shot, base);
    console.log(`UPDATE ${s} | md5 ${md5(shot)}`);
    continue;
  }
  if (!existsSync(base)) {
    fail++;
    console.log(`FAIL ${s} | 缺基线 ${base}（先跑 --update 生成）`);
    continue;
  }
  const r = diffPng(shot, base);
  if (r.diff > THRESH) {
    fail++;
    const pa = PNG.sync.read(readFileSync(shot));
    const pb = PNG.sync.read(readFileSync(base));
    const n = pa.width * pa.height;
    const d = pa.data,
      e = pb.data;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (
        Math.abs(d[o] - e[o]) > TOL ||
        Math.abs(d[o + 1] - e[o + 1]) > TOL ||
        Math.abs(d[o + 2] - e[o + 2]) > TOL ||
        Math.abs(d[o + 3] - e[o + 3]) > TOL
      ) {
        d[o] = 255;
        d[o + 1] = 0;
        d[o + 2] = 0;
      }
    }
    const out = join(gold, `diff-${s}.png`);
    writeFileSync(out, PNG.sync.write(pa));
    console.log(`FAIL ${s} | diff ${(r.diff * 100).toFixed(3)}% > ${THRESH * 100}%${r.why} | diff图 ${out}`);
  } else {
    console.log(`PASS ${s} | diff ${(r.diff * 100).toFixed(4)}% ≤ ${THRESH * 100}%${r.why}`);
  }
}
console.log(`\nE16: ${states.length - fail}/${states.length} PASS（阈值 ${THRESH * 100}%，窗口 ${W}x${H}）`);
process.exit(fail ? 1 : 0);
