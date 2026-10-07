// E14 SLO fixture：生成一个 ~10MB 的 DXF（导入 SLO「10MB <3s（带进度）」的最坏情况输入）
//
// 内容 = 真实导入管线会全量吃下的东西：WALL 层的双线墙段（共线归并的输入）+ COL 层圆柱。
// 确定性：固定种子 xorshift32，同输入同输出（CI 里现生成，不入库 —— 10MB 不进公开 repo）。
//
// 运行：node scripts/make-big-dxf.mjs [--out work/big10mb.dxf] [--target 10000000]
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const outPath = arg('--out', join(root, 'work', 'big10mb.dxf'));
const target = +arg('--target', 10 * 1024 * 1024);

let s = 0x1234abcd >>> 0;
function rnd01() {
  s ^= s << 13;
  s >>>= 0;
  s ^= s >>> 17;
  s ^= s << 5;
  s >>>= 0;
  return s / 4294967296;
}

const L = [];
let bytes = 0; // 累计字节（别每次 join 整个数组 —— 那是 O(n²)，生成会卡死）
const g = (c, v) => {
  const a = String(c);
  const b = String(v);
  L.push(a);
  L.push(b);
  bytes += a.length + b.length + 2;
};

g(0, 'SECTION');
g(2, 'HEADER');
g(9, '$INSUNITS');
g(70, 4); // mm
g(0, 'ENDSEC');
g(0, 'SECTION');
g(2, 'TABLES');
g(0, 'TABLE');
g(2, 'LAYER');
g(70, 3);
for (const [name, color] of [
  ['WALL', 7],
  ['COL', 3],
  ['FURN', 5],
]) {
  g(0, 'LAYER');
  g(2, name);
  g(70, 0);
  g(62, color);
}
g(0, 'ENDTAB');
g(0, 'ENDSEC');
g(0, 'SECTION');
g(2, 'ENTITIES');

// 内容口径：真实公寓图纸的最坏情况 —— 18×12m 户型、墙被拆成很多小段（描摹/打印图纸常见形态）、
// 家具闭合轮廓、柱、以及大量标注文字。尺度必须正常（否则「量级」警告会掩盖真实映射行为）。
// 注意墙段长度必须 ≥ 管线阈值 MIN_WALL_LEN=0.3m：短于 30cm 的段不参与墙带配对（管线阈值，不是 bug）。
const X0 = 1000,
  Y0 = 1000,
  W = 18000,
  H = 12000; // 18m × 12m
const TH = 240; // 240mm 墙厚
let n = 0;
const line = (layer, x1, y1, x2, y2) => {
  g(0, 'LINE');
  g(8, layer);
  g(10, x1);
  g(20, y1);
  g(11, x2);
  g(21, y2);
  n++;
};

// 40 道墙（外围 + 内隔墙），每段 400mm（密集分段 → 共线归并的压力输入）
const SEG = 400;
const walls = [];
for (let i = 0; i < 12; i++) walls.push({ dir: 'h', at: Y0 + 300 + i * 1000, from: X0, to: X0 + W });
for (let i = 0; i < 28; i++)
  walls.push({ dir: 'v', at: X0 + 300 + i * 640, from: Y0, to: Y0 + (i % 2 ? H : H - 3000) });
for (const w of walls) {
  const span = w.dir === 'h' ? w.to - w.from : w.to - w.from;
  const gapA = w.from + 1500 + Math.round(rnd01() * Math.max(1, span - 3500)); // 门洞起点
  const gapB = gapA + 950; // ~1m 门洞
  for (const side of [0, 1]) {
    for (let a = w.from; a < w.to; a += SEG) {
      const b = Math.min(a + SEG, w.to);
      if (b > gapA && a < gapB) continue; // 门洞内不画
      if (w.dir === 'h') line('WALL', a, w.at + side * TH, b, w.at + side * TH);
      else line('WALL', w.at + side * TH, a, w.at + side * TH, b);
    }
  }
}

// 柱（COLUMN 层圆）
for (let c = 0; c < 2000; c++) {
  g(0, 'CIRCLE');
  g(8, 'COL');
  g(10, X0 + 600 + (c % 40) * 430);
  g(20, Y0 + 400 + Math.floor(c / 40) * 240);
  g(40, 150);
  n++;
}

// 家具层闭合轮廓（S12 的 run 识别输入）：3000 个 40 顶点的多边形
for (let k = 0; k < 3000; k++) {
  const cx = X0 + 800 + (k % 60) * 290;
  const cy = Y0 + 300 + Math.floor(k / 60) * 230;
  const rw = 120 + Math.round(rnd01() * 160);
  const rd = 90 + Math.round(rnd01() * 120);
  g(0, 'LWPOLYLINE');
  g(8, 'FURN');
  g(90, 40);
  g(70, 1); // 闭合
  for (let v = 0; v < 40; v++) {
    const t = (v / 40) * Math.PI * 2;
    g(10, Math.round(cx + Math.cos(t) * rw));
    g(20, Math.round(cy + Math.sin(t) * rd));
  }
  n++;
}

// 标注文字（DIM 层 → 分类为 axis，管线要读但要跳过）：填到目标体积
let guard = 0;
while (bytes < target && guard++ < 400000) {
  g(0, 'TEXT');
  g(8, 'DIM');
  g(10, X0 + Math.round(rnd01() * W));
  g(20, Y0 + Math.round(rnd01() * H));
  g(40, 100);
  g(1, 'DIM ' + guard + ' · ' + Math.round(rnd01() * 9999) + 'mm');
  n++;
}

g(0, 'ENDSEC');
g(0, 'EOF');

const text = L.join('\n') + '\n';
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, text);
const kb = (text.length / 1024).toFixed(0);
console.log(
  `big DXF: ${outPath} · ${text.length} B (${kb} KB) · entities ${n} · 目标 ${target} B（差 ${((text.length - target) / 1024).toFixed(0)} KB）`
);
