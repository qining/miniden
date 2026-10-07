// S5 测试 fixture：生成两个最小但完整的 DXF（R1 场景：双线墙 + 门洞 + 窗 + 圆柱 + 房间环）
//
//   tests/fixtures/apartment-mm.dxf — 单位 mm（$INSUNITS=1，INSUNITS 路径）
//   tests/fixtures/apartment-cm.dxf — 单位 cm（$INSUNITS=0，启发式路径）
//
// 户型（米，y-up）：10×8 外框（八条线，四道双线带 240），内墙 x=6（双线 120，留 1.5..2.7 门洞 1.2m），
// 门扇 DOOR 层，南墙窗 1.8m WINDOW 层，圆柱 r=0.25 COL 层，左房闭合环 ROOM 层。
// 期望：units 检测对、墙带 5 条、墙段 6（内墙被门洞切 2）、门 1、窗 1、柱 1、房间 1。
//
// 运行：node scripts/make-dxf-fixtures.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'tests', 'fixtures');
mkdirSync(out, { recursive: true });

// --- 最小 DXF 写出器（严格 ASCII，组码+值成对，EOF 单个）---
function dxf(insunits, scale, layers, entities) {
  const L = [];
  const g = (c, v) => {
    L.push(String(c));
    L.push(String(v));
  };
  g(0, 'SECTION');
  g(2, 'HEADER');
  g(9, '$INSUNITS');
  g(70, insunits);
  g(0, 'ENDSEC');
  g(0, 'SECTION');
  g(2, 'TABLES');
  g(0, 'TABLE');
  g(2, 'LAYER');
  g(70, layers.length);
  for (const [name, color] of layers) {
    g(0, 'LAYER');
    g(2, name);
    g(70, 0);
    g(62, color);
  }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');
  g(0, 'SECTION');
  g(2, 'ENTITIES');
  for (const e of entities) {
    g(0, e.t);
    g(8, e.l);
    if (e.t === 'LINE') {
      g(10, e.a.x);
      g(20, e.a.y);
      g(11, e.b.x);
      g(21, e.b.y);
    } else if (e.t === 'CIRCLE') {
      g(10, e.c.x);
      g(20, e.c.y);
      g(40, e.r);
    } else if (e.t === 'LWPOLYLINE') {
      g(90, e.pts.length);
      g(70, e.closed ? 1 : 0);
      for (const p of e.pts) {
        g(10, p.x);
        g(20, p.y);
      }
    }
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return L.join('\n') + '\n';
}

// --- 几何（米，y-up；scale 换算到目标单位）---
function geom(s) {
  const S = (x) => Math.round(x * s * 100) / 100; // 米→目标单位（2 位小数足够）
  const P = (x, y) => ({ x: S(x), y: S(y) });
  const ln = (l, a, b) => ({ t: 'LINE', l, a: P(a[0], a[1]), b: P(b[0], b[1]) });
  const e = [];
  // 外墙双线（中心线 10×8 矩形，厚 0.24 → ±0.12）
  const O = 0.12;
  e.push(ln('WALL', [-O, -O], [10 + O, -O])); // 南（外）
  e.push(ln('WALL', [-O, O], [10 + O, O])); // 南（内）
  e.push(ln('WALL', [-O, 8 + O], [10 + O, 8 + O])); // 北（外）
  e.push(ln('WALL', [-O, 8 - O], [10 + O, 8 - O])); // 北（内）
  e.push(ln('WALL', [10 + O, -O], [10 + O, 8 + O])); // 东（外）
  e.push(ln('WALL', [-O, -O], [-O, 8 + O])); // 西（外）
  e.push(ln('WALL', [10 - O, -O], [10 - O, 8 + O])); // 东（内）
  e.push(ln('WALL', [O, -O], [O, 8 + O])); // 西（内）
  // 内墙 x=6，厚 0.12（±0.06），门洞 y 1.5..2.7
  e.push(ln('WALL', [6 - 0.06, -O], [6 - 0.06, 1.5]));
  e.push(ln('WALL', [6 + 0.06, -O], [6 + 0.06, 1.5]));
  e.push(ln('WALL', [6 - 0.06, 2.7], [6 - 0.06, 8 + O]));
  e.push(ln('WALL', [6 + 0.06, 2.7], [6 + 0.06, 8 + O]));
  // 门扇（DOOR）：铰链在缺口下端 (6,1.5)，向内（左）开 0.9
  e.push(ln('DOOR', [6, 1.5], [5.1, 1.5]));
  // 窗（WINDOW）：南墙中心线 y=0，x 2..3.8（1.8m）
  e.push(ln('WINDOW', [2, 0], [3.8, 0]));
  // 圆柱（COL）：r=0.25 @ (3,3)
  e.push({ t: 'CIRCLE', l: 'COL', c: P(3, 3), r: S(0.25) });
  // 房间环（ROOM）：左房 0..6 × 0..8（48 m²）
  e.push({ t: 'LWPOLYLINE', l: 'ROOM', closed: true, pts: [P(0, 0), P(6, 0), P(6, 8), P(0, 8)] });
  return e;
}

const layers = [
  ['WALL', 7],
  ['DOOR', 3],
  ['WINDOW', 4],
  ['COL', 8],
  ['ROOM', 5],
];

writeFileSync(join(out, 'apartment-mm.dxf'), dxf(1, 1000, layers, geom(1000))); // mm
writeFileSync(join(out, 'apartment-cm.dxf'), dxf(0, 100, layers, geom(100))); // cm
console.log('fixtures: apartment-mm.dxf, apartment-cm.dxf →', out);
