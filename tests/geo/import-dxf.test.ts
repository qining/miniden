// S5 测试：DXF → ProjectDoc 映射（fixture 驱动，R1 场景）
// fixture：scripts/make-dxf-fixtures.mjs（node scripts/make-dxf-fixtures.mjs 重新生成）
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import DxfParser from 'dxf-parser';
import { importDxf, classifyLayer, type DxfDoc } from '../../src/geo/import-dxf';
import { validate } from '../../src/schema/project';
import { expand, type Seg, type Geom } from '../../src/schema/primitives';
import { docToLegacy } from '../../src/schema/migrate';
import {
  buildDocFromRaw,
  detectBands,
  transform,
  type Raw,
  type RawClosed,
  type RawSeg,
  type V2,
  type LayerClass,
} from '../../src/geo/import-common';

const here = dirname(fileURLToPath(import.meta.url));
const M_TO_FT = 1 / 0.3048;
const f2 = (x: number) => Math.round(x * 10000) / 10000;
const near = (a: number, b: number, eps = 0.005) => expect(Math.abs(a - b)).toBeLessThan(eps);
const v = (x: number, y: number) => ({ x, y });
const distFt = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y);
// v1 里墙/门/窗的 geom 恒为 seg（ADR-0002：弧墙是将来）
const seg = (g: Geom): Seg => g as Seg;

function parseFixture(name: string): DxfDoc {
  const txt = readFileSync(join(here, '..', 'fixtures', name), 'utf8');
  return new DxfParser().parseSync(txt) as unknown as DxfDoc;
}
function run(name: string) {
  return importDxf(parseFixture(name));
}

describe('classifyLayer', () => {
  it('中文 + 英文 + 0/undefined', () => {
    expect(classifyLayer('WALL')).toBe('wall');
    expect(classifyLayer('墙体')).toBe('wall');
    expect(classifyLayer('DOOR_FRAME')).toBe('door');
    expect(classifyLayer('WINDOW')).toBe('window');
    expect(classifyLayer('COLUMN')).toBe('col');
    expect(classifyLayer('FURNITURE')).toBe('furn');
    expect(classifyLayer('0')).toBe('other');
    expect(classifyLayer(undefined)).toBe('other');
    expect(classifyLayer('DIM')).toBe('axis');
  });
});

describe('units: $INSUNITS 路径', () => {
  const { info } = run('apartment-mm.dxf');
  it('mm fixture 检出 mm（insunits）', () => {
    expect(info.unit).toBe('mm');
    expect(info.unitMethod).toBe('insunits');
  });
  it('量级正确（10.24×8.24m）', () => {
    near(info.extent.w, 10.24);
    near(info.extent.h, 8.24);
  });
});

describe('units: 启发式路径（$INSUNITS=0）', () => {
  const { info } = run('apartment-cm.dxf');
  it('cm fixture 用墙厚中位数检出 cm', () => {
    expect(info.unit).toBe('cm');
    expect(info.unitMethod).toBe('heuristic');
  });
});

describe('units: $INSUNITS 码表必须照 DXF 规范', () => {
  // DXF 规范（Autodesk DXF Reference / ezdxf）：1=Inches 2=Feet 3=Miles 4=Millimeters
  // 5=Centimeters 6=Meters 7=Kilometers … 19=Yards。AutoCAD/Fusion 导出的 mm 图纸写的是 4。
  const codes: Array<[number, string]> = [
    [1, 'in'],
    [2, 'ft'],
    [4, 'mm'],
    [5, 'cm'],
    [6, 'm'],
    [19, 'yd'],
  ];
  for (const [code, unit] of codes) {
    it(`$INSUNITS=${code} → ${unit}`, () => {
      const r = importDxf({ header: { $INSUNITS: code }, entities: [] } as unknown as DxfDoc);
      expect(r.info.unit).toBe(unit);
      expect(r.info.unitMethod).toBe('insunits');
    });
  }
  it('规范里有、我们没有的单位（7=公里）→ 回退启发式，不硬套', () => {
    const r = importDxf({ header: { $INSUNITS: 7 }, entities: [] } as unknown as DxfDoc);
    expect(r.info.unitMethod).not.toBe('insunits');
  });
  it('真实 mm 图纸（$INSUNITS=4）的 240 墙厚读成 0.24m，不是 6.1m', () => {
    const d = {
      header: { $INSUNITS: 4 },
      entities: [
        { type: 'LINE', layer: 'WALL', vertices: [v(0, 0), v(3000, 0)] },
        { type: 'LINE', layer: 'WALL', vertices: [v(0, 240), v(3000, 240)] },
      ],
    } as unknown as DxfDoc;
    const r = importDxf(d);
    expect(r.info.unit).toBe('mm');
    expect(r.info.counts.walls).toBe(1);
    near(r.doc.walls[0]!.thick ?? 0, 0.24 * M_TO_FT, 0.02);
    expect(r.info.warnings.some((w) => w.includes('量级'))).toBe(false);
  });
});

describe('墙带配对', () => {
  const { doc } = run('apartment-mm.dxf');
  it('6 条墙：4 外 + 内墙被门洞切成 2 段', () => {
    expect(doc.walls).toHaveLength(6);
  });
  it('外墙厚 0.24m → 0.7874ft；内墙 0.12m → 0.3937ft', () => {
    const thick = doc.walls.map((w) => f2(w.thick ?? 0)).sort((a, b) => a - b);
    expect(thick.filter((t) => t > 0.7)).toHaveLength(4);
    expect(thick.filter((t) => t < 0.7)).toHaveLength(2);
    near(thick[0]!, 0.12 * M_TO_FT);
    near(thick[3]!, 0.24 * M_TO_FT);
  });
  it('y 翻转 + 平移：所有几何 ≥ 0（原 y=-0.12m 的外南墙贴 0）', () => {
    for (const w of doc.walls) {
      const g = seg(w.geom);
      expect(Math.min(g.x1, g.x2, g.y1, g.y2)).toBeGreaterThanOrEqual(-0.01);
    }
  });
});

describe('门', () => {
  const { doc } = run('apartment-mm.dxf');
  it('1 个门，缺口 1.2m → 3.937ft（竖直缺口）', () => {
    expect(doc.doors).toHaveLength(1);
    const d = doc.doors[0];
    const gap = seg(d.gapGeom!);
    near(Math.abs(gap.x2 - gap.x1), 0, 0.001);
    near(Math.abs(gap.y2 - gap.y1), 1.2 * M_TO_FT, 0.02);
  });
  it('门扇 = 图纸 DOOR 层段（0.9m，水平）', () => {
    const d = doc.doors[0];
    const leaf = seg(d.geom);
    near(Math.abs(leaf.x2 - leaf.x1), 0.9 * M_TO_FT, 0.02);
    near(Math.abs(leaf.y2 - leaf.y1), 0, 0.001);
    expect(d.kind).toBe('swing');
    expect([0, 1]).toContain(d.hinge);
    expect([1, -1]).toContain(d.side);
  });
  it('pos 是缺口在整墙上的比例（0..1）', () => {
    expect(doc.doors[0].pos).toBeGreaterThanOrEqual(0);
    expect(doc.doors[0].pos).toBeLessThanOrEqual(1);
  });
});

describe('窗', () => {
  const { doc } = run('apartment-mm.dxf');
  it('1 个窗，1.8m → 5.906ft，默认 fixed/窗台 0.9m/顶 2.4m', () => {
    expect(doc.windows).toHaveLength(1);
    const w = doc.windows[0];
    near(w.width, 1.8 * M_TO_FT, 0.02);
    near(w.sill, 0.9 * M_TO_FT, 0.005);
    near(w.head, 2.4 * M_TO_FT, 0.005);
    expect(w.style).toBe('fixed');
  });
});

describe('柱 / 房间', () => {
  const { doc } = run('apartment-mm.dxf');
  it('圆柱 r=0.25m → fullCircle 实体', () => {
    expect(doc.solids).toHaveLength(1);
    const s = doc.solids[0];
    expect(s.geom.t).toBe('arc');
    if (s.geom.t === 'arc') near(s.geom.r, 0.25 * M_TO_FT, 0.005);
    expect(s.column).toBe(true);
  });
  it('48m² 闭合环 → 房间（不是实体）', () => {
    expect(doc.rooms).toHaveLength(1);
    const r = doc.rooms[0];
    near(r.wd!, 6 * M_TO_FT, 0.02);
    near(r.dp!, 8 * M_TO_FT, 0.02);
  });
});

describe('文档质量', () => {
  const { doc, info } = run('apartment-mm.dxf');
  it('通过 schema validate（含 id 唯一性）', () => {
    expect(validate(doc)).toEqual([]);
  });
  it('所有墙/门/窗的 expand() 能展开（消费端契约，ADR-0002）', () => {
    for (const w of doc.walls) expect(expand(w.geom).length).toBeGreaterThan(0);
    for (const d of doc.doors) expect(expand(d.geom).length).toBeGreaterThan(0);
    for (const w of doc.windows) expect(expand(w.geom).length).toBeGreaterThan(0);
  });
  it('确定性：两次导入 JSON 完全相同', () => {
    expect(JSON.stringify(run('apartment-mm.dxf').doc)).toBe(JSON.stringify(doc));
  });
  it('docToLegacy 投影不抛（新文档也能走旧渲染路径）', () => {
    expect(() => docToLegacy(doc)).not.toThrow();
  });
  it('warnings 不报量级异常', () => {
    expect(info.warnings.some((w) => w.includes('量级'))).toBe(false);
  });
});

describe('边界', () => {
  it('空文档：不崩，0 墙 + 警告', () => {
    const r = importDxf({ header: { $INSUNITS: 4 }, entities: [] });
    expect(r.info.counts.walls).toBe(0);
    expect(r.info.warnings.some((w) => w.includes('未检出墙体'))).toBe(true);
  });
  it('单线墙：默认厚 0.1m，仍成墙', () => {
    const d = {
      header: { $INSUNITS: 4 },
      entities: [
        {
          type: 'LINE',
          layer: '0',
          vertices: [
            { x: 0, y: 0 },
            { x: 3000, y: 0 },
          ],
        },
        {
          type: 'LINE',
          layer: '0',
          vertices: [
            { x: 0, y: 0 },
            { x: 0, y: 3000 },
          ],
        },
      ],
    };
    const r = importDxf(d as unknown as DxfDoc);
    expect(r.info.counts.walls).toBe(2);
    near(r.doc.walls[0]!.thick ?? 0, 0.1 * M_TO_FT, 0.005);
  });
  it('用户强制单位覆盖自动检测', () => {
    const d = {
      header: { $INSUNITS: 6 }, // m（DXF 规范 6=Meters）
      entities: [
        {
          type: 'LINE',
          layer: '0',
          vertices: [
            { x: 0, y: 0 },
            { x: 3, y: 0 },
          ],
        },
      ],
    };
    const r = importDxf(d as unknown as DxfDoc, { unit: 'cm' });
    expect(r.info.unit).toBe('cm');
    expect(r.info.unitMethod).toBe('user');
  });
});

describe('S12：家具层轮廓 → 台面 run（读几何，不猜位置）', () => {
  const P = (x: number, y: number): V2 => ({ x, y });
  const rawOf = (closed: RawClosed[], segs: RawSeg[]): Raw => ({
    segs,
    arcs: [],
    circles: [],
    closed,
    skipped: { ellipses: 0, inserts: 0, texts: 0, other: 0 },
  });
  const build = (pts: V2[], wall: [V2, V2] | null) =>
    buildDocFromRaw(
      rawOf([{ pts, cls: 'furn' as LayerClass }], wall ? [{ a: wall[0], b: wall[1], cls: 'wall' as LayerClass }] : []),
      { unit: 'm', name: 't', method: 'user' }
    );

  it('柜体带形状（3.0m × 0.6m）→ run，深度取轮廓实际延伸，不再落成整高 solid', () => {
    const r = build([P(1, 0.05), P(4, 0.05), P(4, 0.65), P(1, 0.65)], [P(0, 0), P(6, 0)]);
    expect(r.info.counts.runs).toBe(1);
    const run = r.doc.runs![0]!;
    near(run.depth!, 0.6 * M_TO_FT, 0.01);
    near(run.topH!, 0.9 * M_TO_FT, 0.01);
    expect(r.doc.solids.length).toBe(0);
  });

  it('path 取靠墙那条长边（前沿贴墙）', () => {
    const r = build([P(1, 0.05), P(4, 0.05), P(4, 0.65), P(1, 0.65)], [P(0, 0), P(6, 0)]);
    const run = r.doc.runs![0]!;
    const ys = run.path.map((p) => p[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(0.01); // 水平边
    const wy = (r.doc.walls[0]!.geom as { y1: number }).y1;
    near(Math.abs(ys[0] - wy), 0.05 * M_TO_FT, 0.01); // 就是贴墙那条
    // 若挑的是对面那条边，距离会是 0.6m
    expect(Math.abs(ys[0] - wy)).toBeLessThan(0.1 * M_TO_FT);
  });

  it('没有墙带时退回最长边', () => {
    const r = build([P(1, 0.05), P(4, 0.05), P(4, 0.65), P(1, 0.65)], null);
    expect(r.info.counts.runs).toBe(1);
    const run = r.doc.runs![0]!;
    const L = Math.hypot(run.path[1][0] - run.path[0][0], run.path[1][1] - run.path[0][1]);
    near(L * 0.3048, 3.0, 0.02); // 3.0m 长边
    near(run.depth! * 0.3048, 0.6, 0.02);
  });

  it('床（2.0×1.6m，不浅）不当柜体带 → 仍是 solid', () => {
    const r = build([P(1, 0), P(3, 0), P(3, 1.6), P(1, 1.6)], [P(0, 0), P(6, 0)]);
    expect(r.info.counts.runs).toBe(0);
    expect(r.doc.solids.length).toBe(1);
  });

  it('浅但太短（0.5×0.4m）→ solid，不是 run', () => {
    const r = build([P(1, 0), P(1.5, 0), P(1.5, 0.4), P(1, 0.4)], [P(0, 0), P(6, 0)]);
    expect(r.info.counts.runs).toBe(0);
    expect(r.doc.solids.length).toBe(1);
  });

  it('读入柜体带时给出可核对的警告（不是猜）', () => {
    const r = build([P(1, 0.05), P(4, 0.05), P(4, 0.65), P(1, 0.65)], [P(0, 0), P(6, 0)]);
    const w = r.info.warnings.find((x) => x.includes('柜体带'));
    expect(w).toBeTruthy();
    expect(w).toContain('1 个');
    expect(w).toContain('0.9m');
  });

  it('导入的 run 通过校验且不进投影', () => {
    const r = build([P(1, 0.05), P(4, 0.05), P(4, 0.65), P(1, 0.65)], [P(0, 0), P(6, 0)]);
    expect(validate(r.doc)).toEqual([]);
    expect(Object.keys(docToLegacy(r.doc))).toEqual(['walls', 'fixed', 'doors']);
  });
});

/* ---- bug 猎 #6：同一条墙线被门洞切成两簇、两簇段方向相反时，
   mergeCollinearBands 的 key 只归一化了 dir，没归一化 offset/intervals
   → 两簇不合并 → 门洞看不见（导入户型丢门）。 ---- */
describe('墙带合并 — 反向段（bug 猎 #6）', () => {
  // 一条 6m 长、240mm 厚的水平墙，中间 0.9m 门洞；左半段指向 +x，右半段指向 −x
  const raw: Raw = {
    segs: [
      { a: v(0, 0), b: v(3000, 0), cls: 'wall' },
      { a: v(0, 240), b: v(3000, 240), cls: 'wall' },
      { a: v(6000, 0), b: v(3900, 0), cls: 'wall' },
      { a: v(6000, 240), b: v(3900, 240), cls: 'wall' },
    ],
    arcs: [],
    circles: [],
    closed: [],
    skipped: { ellipses: 0, inserts: 0, texts: 0, other: 0 },
  };
  it('detectBands：反向段仍归并为同一条带（1 带 2 区间 = 门洞可见）', () => {
    const tf = transform(raw, 'mm');
    const segs = tf.segs.filter((s) => distFt(s.a, s.b) >= 0.1 * M_TO_FT);
    const bands = detectBands(segs);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.intervals).toHaveLength(2);
    // 区间必须落在同一条法向坐标上（同一 dir 框架内）
    const gapM = (bands[0]!.intervals[1].u0 - bands[0]!.intervals[0].u1) * 0.3048;
    near(gapM, 0.9, 0.02);
  });
  it('buildDocFromRaw：门洞被读成 1 个门（旧版读成 0 个）', () => {
    const { doc, info } = buildDocFromRaw(raw, { unit: 'mm', method: 'user' });
    expect(doc.doors).toHaveLength(1);
    expect(doc.walls).toHaveLength(2);
    near(seg(doc.doors[0]!.gapGeom!).x2 - seg(doc.doors[0]!.gapGeom!).x1, 0.9 * M_TO_FT, 0.02);
    expect(validate(doc)).toEqual([]);
    expect(info.counts.doors).toBe(1);
  });
});

/* ---- bug 猎 #7/#8：transform 的 y 翻转只翻了点，没翻弧角 ----
   (x,y)→(x,−y) 把角度 φ 映成 −φ 且扫掠方向反转；原样保留 s/e 会让
   消费端（expand / SVG A）画出镜像弧（甚至补弧）。
   同时：v1 不读入弧墙，但旧版一声不响，用户只看到「墙少了」。 ---- */
describe('transform — 圆弧（bug 猎 #7）', () => {
  const raw: Raw = {
    segs: [],
    arcs: [{ c: v(0, 0), r: 1, s: 0, e: Math.PI / 2, cls: 'wall', full: false }],
    circles: [],
    closed: [],
    skipped: { ellipses: 0, inserts: 0, texts: 0, other: 0 },
  };
  it('y 翻转后弧角取反并交换（s′=−e, e′=−s），端点逐位对上', () => {
    const tf = transform(raw, 'm');
    const a = tf.arcs[0]!;
    near(a.s, -Math.PI / 2, 1e-9);
    near(a.e, 0, 1e-9);
    // 端点必须与「把原始端点直接 flip 后」的位置一致
    const c = a.c;
    const p0 = { x: c.x + a.r * Math.cos(a.s), y: c.y + a.r * Math.sin(a.s) };
    const p1 = { x: c.x + a.r * Math.cos(a.e), y: c.y + a.r * Math.sin(a.e) };
    near(p0.x, 1 * M_TO_FT, 1e-6);
    near(p0.y, 0, 1e-6);
    near(p1.x, 2 * M_TO_FT, 1e-6);
    near(p1.y, 1 * M_TO_FT, 1e-6);
  });
  it('整圆不受影响（full 弧 s/e 无意义）', () => {
    const full: Raw = {
      ...raw,
      arcs: [{ c: v(0, 0), r: 1, s: 0.3, e: 0.3 + 2 * Math.PI, cls: 'wall', full: true }],
    };
    const a = transform(full, 'm').arcs[0]!;
    expect(a.full).toBe(true);
    near(a.e - a.s, 2 * Math.PI, 1e-9);
  });
});

describe('圆弧不读入必须说出来（bug 猎 #8）', () => {
  it('含弧的原始数据 → 警告里写明跳过了几段弧', () => {
    const raw: Raw = {
      segs: [
        { a: v(0, 0), b: v(3000, 0), cls: 'wall' },
        { a: v(0, 240), b: v(3000, 240), cls: 'wall' },
      ],
      arcs: [{ c: v(1500, 120), r: 120, s: 0, e: Math.PI, cls: 'wall', full: false }],
      circles: [],
      closed: [],
      skipped: { ellipses: 0, inserts: 0, texts: 0, other: 0 },
    };
    const { info } = buildDocFromRaw(raw, { unit: 'mm', method: 'user' });
    expect(info.warnings.some((w) => /圆弧/.test(w))).toBe(true);
  });
});

/* ---- bug 猎 #9：「柱」的判据必须是图纸自己的分类，不是面积大小 ----
   旧版 column = areaM2 < 2：真实图纸里小面积闭合轮廓多半是家具/设备轮廓
   （qcad_entities 29 个实心块，无一在 col 层），立成到顶的墙就是错的；
   反过来 col 层的柱在 3D 里根本不出现（app.html 的 3D 只认内置户型的填充色）。
   现在 column = 图纸说它是柱（col 层 / 圆）→ 3D 立实体、算结构块。 */
describe('实心块分类：column 来自图纸（bug 猎 #9）', () => {
  const raw: Raw = {
    segs: [
      { a: v(0, 0), b: v(6000, 0), cls: 'wall' },
      { a: v(0, 240), b: v(6000, 240), cls: 'wall' },
    ],
    arcs: [],
    circles: [{ c: v(3000, 1200), r: 300, cls: 'other' }],
    closed: [
      { pts: [v(1000, 1000), v(1400, 1000), v(1400, 1400), v(1000, 1400)], cls: 'col' }, // 0.16 m²，col 层
      { pts: [v(3000, 3000), v(3800, 3000), v(3800, 3800), v(3000, 3800)], cls: 'other' }, // 0.64 m²，非柱
    ],
    skipped: { ellipses: 0, inserts: 0, texts: 0, other: 0 },
  };
  const { doc, info } = buildDocFromRaw(raw, { unit: 'mm', method: 'user' });

  it('col 层轮廓 + 圆 → column:true；非柱轮廓 → column:false（旧版两者都 true）', () => {
    expect(doc.solids).toHaveLength(3);
    const byName = doc.solids.map((s) => (s.name === '柱' ? '柱' : '?'));
    expect(byName).toEqual(['柱', '?', '柱']);
    expect(doc.solids.map((s) => !!s.column)).toEqual([true, false, true]);
  });
  it('非柱实心块必须报出：2D 灰块、3D 不立实体，并给出改判办法', () => {
    const w = info.warnings.filter((x) => /灰色块/.test(x));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('1 个闭合轮廓');
    expect(w[0]).toContain('3D 不立实体');
  });
  it('全是柱时不报（不给用户噪音）', () => {
    const only = buildDocFromRaw({ ...raw, closed: [raw.closed[0]!], circles: [] }, { unit: 'mm', method: 'user' });
    expect(only.doc.solids.every((s) => s.column)).toBe(true);
    expect(only.info.warnings.filter((x) => /灰色块/.test(x))).toHaveLength(0);
  });
  it('validate 通过（column 是可选布尔，不影响 schema）', () => {
    expect(validate(doc)).toEqual([]);
  });
});
