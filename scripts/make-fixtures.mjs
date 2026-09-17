#!/usr/bin/env node
/* =====================================================================
   scripts/make-fixtures.mjs — 从 planner.html 提取真实几何数据 → tests/fixtures/

   生成 legacy-geo.json：
   - legacy: 内置几何原文（WALLS/INNER/DOORS/FIXED/LABELS/FX/PATIO/ISL，SC 换算后 ft）
   - effEmpty: 空 USERGEO 时 effWalls/effFixed/effDoors 的输出（基线）
   - effUser: 合成 USERGEO（覆盖/隐藏/新增）时的 eff* 输出（迁移等价性的对照基准）

   提取的是**原始脚本行**（几何块是纯数据+纯函数，无 DOM 依赖），
   在 vm 沙箱里执行后序列化。输出无时间戳——重复生成逐字节相同。
   ===================================================================== */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(path.join(root, 'planner.html'), 'utf8');
const body = html.slice(html.indexOf('<script>\n') + '<script>\n'.length, html.lastIndexOf('</script>'));
const lines = body.split('\n');

function extractBalanced(startLine) {
  // 从 startLine（0-based）的花括号块开始，数括号到配平
  let depth = 0, started = false, out = [];
  for (let i = startLine; i < lines.length; i++) {
    const l = lines[i];
    for (const ch of l) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') { depth--; }
    }
    out.push(l);
    if (started && depth === 0) break;
  }
  return out.join('\n');
}

const idx = (re) => lines.findIndex(l => re.test(l));
if ([1, idx(/^const DIMTXT/), idx(/^const GEO_VERSION /), idx(/^let USERGEO = /), idx(/^const USERGEO_VERSION /), idx(/^function effWalls/), idx(/^function effFixed/), idx(/^function effDoors/)].some(i => i < 0)) {
  console.error('fixture 提取锚点缺失——planner.html 结构变了，检查脚本');
  process.exit(1);
}

// 块 1：脚本头 + 完整几何数据块（SC → DIMTXT）
const block1 = lines.slice(0, idx(/^const DIMTXT/) + 1).join('\n');
const extra = [
  lines[idx(/^const GEO_VERSION /)],
  lines[idx(/^let USERGEO = /)],
  lines[idx(/^const USERGEO_VERSION /)],
  extractBalanced(idx(/^function effWalls/)),
  extractBalanced(idx(/^function effFixed/)),
  extractBalanced(idx(/^function effDoors/)),
].join('\n');

const SYN_CODE = `({
  walls: [
    { x1: 5, y1: 5, x2: 9, y2: 5, t: 'w' },
    { x1: 20, y1: 30, x2: 24, y2: 30, t: 'g', wd: 3.5 },
  ],
  polys: [
    { name: '测试柱', pts: [[10, 10], [11.5, 10], [11.5, 11.5], [10, 11.5]] },
  ],
  doors: [
    { x1: 6, y1: 4, x2: 8, y2: 4, kind: 'swing', hinge: 1, side: -1, wood: false },
  ],
  hiddenW: [10], hiddenP: [5], hiddenD: [3],
  ovW: { 3: { x1: WALLS[3].x1 + 0.125, y1: WALLS[3].y1, x2: WALLS[3].x2, y2: WALLS[3].y2, t: WALLS[3].t, wd: 8 } },
  ovP: { 2: { poly: [[1, 1], [2, 1], [2, 2.5], [1, 2.5]] } },
  ovD: { 1: { side: -1, hinge: 0 } },
});`;

function run(scenario) {
  const script = [
    'var CALIB = false;',
    block1,
    extra,
    `USERGEO = ${JSON.stringify({ walls: [], polys: [], doors: [], hiddenW: [], hiddenP: [], hiddenD: [], ovW: {}, ovP: {}, ovD: {} })};`,
    scenario ? `USERGEO = ${scenario};` : '',
    `globalThis.__out = {
      meta: { sc: SC, geoVersion: GEO_VERSION, userGeoVersion: USERGEO_VERSION },
      legacy: { walls: WALLS, inner: INNER, doors: DOORS, fixed: FIXED, labels: LABELS, fx: FX, patio: PATIO, isl: ISL },
      eff: { walls: effWalls(), fixed: effFixed(), doors: effDoors() },
      userGeo: USERGEO,
    };`,
  ].join('\n');
  const sandbox = { console, globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'planner-geo-block.js' });
  return sandbox.__out;
}

const empty = run(null);
const user = run(SYN_CODE);
const fixture = {
  note: '从 planner.html 自动提取（scripts/make-fixtures.mjs）。eff* 输出是迁移等价性（docToLegacy ≡ eff*）的对照基准。无时间戳，重复生成逐字节相同。',
  empty,
  user,
};

const outPath = path.join(root, 'tests', 'fixtures', 'legacy-geo.json');
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(fixture, null, 1) + '\n');
const kb = (readFileSync(outPath).length / 1024).toFixed(1);
console.log(`legacy-geo.json: ${kb}KB — walls ${empty.legacy.walls.length}, doors ${empty.legacy.doors.length}, fixed ${empty.legacy.fixed.length}, labels ${empty.legacy.labels.length}, fx ${empty.legacy.fx.length}`);
