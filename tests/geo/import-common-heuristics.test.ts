/* bug 猎第七轮：导入侧的「量纲表 / 阈值量纲 / 父墙归属」
   三条都是先写失败测试确认红，再修（AGENTS §5.1.1）。 */
import { describe, it, expect } from 'vitest';
import {
  UNIT_TO_M,
  UNIT_NOMINAL,
  detectUnitsFromSamples,
  buildDocFromRaw,
  classifyLayer,
  type Raw,
  type RawSeg,
  type RawClosed,
  type V2,
  type LayerClass,
} from '../../src/geo/import-common';
import { detectUnits, importDxf, type DxfDoc } from '../../src/geo/import-dxf';

const P = (x: number, y: number): V2 => ({ x, y });
const rawOf = (segs: RawSeg[], closed: RawClosed[] = []): Raw => ({
  segs,
  arcs: [],
  circles: [],
  closed,
  skipped: { ellipses: 0, inserts: 0, texts: 0, other: 0 },
});
const seg = (a: V2, b: V2, cls: LayerClass): RawSeg => ({ a, b, cls });
const near = (v: number, want: number, tol = 0.02) => expect(Math.abs(v - want)).toBeLessThan(tol);

/* ---------------------------------------------------------------- 量纲表 */

describe('UNIT_NOMINAL 必须与 UNIT_TO_M 自洽（一张表，不能各写各的）', () => {
  it('每个单位的「240mm 标称值」= 0.24 / UNIT_TO_M[u]', () => {
    for (const u of Object.keys(UNIT_TO_M) as (keyof typeof UNIT_TO_M)[]) {
      const want = 0.24 / UNIT_TO_M[u];
      // 相对误差 1%：表里允许四舍五入到 3~4 位有效数字，不允许差一个数量级
      expect(Math.abs(UNIT_NOMINAL[u]! / want - 1), `${u}: ${UNIT_NOMINAL[u]} vs ${want}`).toBeLessThan(0.01);
    }
  });

  it('pt（PDF 原生点）：240mm = 680.3pt，不是 68.03pt', () => {
    near(UNIT_NOMINAL.pt, 680.315, 1);
  });

  it('一份点制图纸（墙厚 680pt）要读成 pt，不是退回 mm 把 240mm 墙读成 680mm', () => {
    const d = detectUnitsFromSamples([680.3, 680.3, 680.3]);
    expect(d.unit).toBe('pt');
    expect(d.method).toBe('heuristic');
  });

  it('detectUnits：$INSUNITS 有效时优先于启发式；无效时走启发式；无样本时退回 mm', () => {
    const doc = (ins?: unknown) =>
      ({ header: ins === undefined ? {} : { $INSUNITS: ins }, entities: [] }) as unknown as DxfDoc;
    expect(detectUnits(doc(4), [240])).toEqual({ unit: 'mm', method: 'insunits' });
    expect(detectUnits(doc('6'), [680.3])).toEqual({ unit: 'm', method: 'insunits' }); // 字符串也认
    expect(detectUnits(doc(0), [680.3]).unit).toBe('pt'); // 0 = 未指定 → 启发式
    expect(detectUnits(doc('乱写的'), [240])).toEqual({ unit: 'mm', method: 'heuristic' });
    expect(detectUnits(doc(), [])).toEqual({ unit: 'mm', method: 'fallback' });
  });

  it('端到端：无 $INSUNITS 的点制 DXF → unit=pt，墙厚 ≈0.24m', () => {
    // 30000×36800 pt = 10.6×13.0m；两对平行线间距 680pt = 240mm
    const d = {
      header: {},
      entities: [
        { type: 'LINE', layer: '0', vertices: [P(0, 0), P(30000, 0)] },
        { type: 'LINE', layer: '0', vertices: [P(0, 680), P(30000, 680)] },
        { type: 'LINE', layer: '0', vertices: [P(0, 30000), P(30000, 30000)] },
        { type: 'LINE', layer: '0', vertices: [P(0, 30680), P(30000, 30680)] },
      ],
    } as unknown as DxfDoc;
    const r = importDxf(d);
    expect(r.info.unit).toBe('pt');
    expect(r.info.unitMethod).toBe('heuristic');
    const thickM = Math.max(...r.doc.walls.map((w) => (w.thick ?? 0) * 0.3048));
    near(thickM, 0.24, 0.03);
  });
});

/* ---------------------------------------------------------------- run 深度阈值 */

describe('柜体带判据：深度阈值是 10cm（不是 3cm）', () => {
  const buildRun = (pts: V2[]) =>
    buildDocFromRaw(rawOf([seg(P(0, 0), P(6, 0), 'wall')], [{ pts, cls: 'furn' }]), {
      unit: 'm',
      name: 't',
      method: 'user',
    });

  it('1.2m × 0.05m 的浅轮廓 → 不是柜体带（5cm 深的「台面」是图纸里的细线/符号）', () => {
    const r = buildRun([P(1, 0.05), P(2.2, 0.05), P(2.2, 0.1), P(1, 0.1)]);
    expect(r.info.counts.runs).toBe(0);
    expect(r.doc.solids.length).toBe(1);
  });

  it('1.2m × 0.12m（12cm）→ 仍算柜体带', () => {
    const r = buildRun([P(1, 0.05), P(2.2, 0.05), P(2.2, 0.17), P(1, 0.17)]);
    expect(r.info.counts.runs).toBe(1);
    near((r.doc.runs![0]!.depth ?? 0) * 0.3048, 0.12, 0.02);
  });

  it('正常柜体带 3.0m × 0.6m 不受影响', () => {
    const r = buildRun([P(1, 0.05), P(4, 0.05), P(4, 0.65), P(1, 0.65)]);
    expect(r.info.counts.runs).toBe(1);
    near((r.doc.runs![0]!.depth ?? 0) * 0.3048, 0.6, 0.02);
  });
});

/* ---------------------------------------------------------------- 父墙归属 */

describe('门 / 窗的 wallId 必须指向它真正所在的那段墙（墙带被门缝切成多段时）', () => {
  // 一条墙带被 1.0m 门缝切成两段：w01 = x[0,2]，w02 = x[3,5]（单位 m，y-up）
  const splitBand = () =>
    buildDocFromRaw(
      rawOf([
        seg(P(0, 0), P(2, 0), 'wall'),
        seg(P(0, 0.24), P(2, 0.24), 'wall'),
        seg(P(3, 0), P(5, 0), 'wall'),
        seg(P(3, 0.24), P(5, 0.24), 'wall'),
      ]),
      { unit: 'm', name: 't', method: 'user' }
    );

  it('前提：确实切出了两段墙 + 一个门缝门', () => {
    const r = splitBand();
    expect(r.info.counts.walls).toBe(2);
    expect(r.info.counts.doors).toBe(1);
  });

  it('窗压在第一段上 → wallId 是第一段（不是「最后一个区间」）', () => {
    const r = buildDocFromRaw(
      rawOf([
        seg(P(0, 0), P(2, 0), 'wall'),
        seg(P(0, 0.24), P(2, 0.24), 'wall'),
        seg(P(3, 0), P(5, 0), 'wall'),
        seg(P(3, 0.24), P(5, 0.24), 'wall'),
        seg(P(0.5, 0.12), P(1.5, 0.12), 'window'),
      ]),
      { unit: 'm', name: 't', method: 'user' }
    );
    expect(r.info.counts.windows).toBe(1);
    const win = r.doc.windows[0]!;
    const midX = (((win.geom as { x1: number }).x1 + (win.geom as { x2: number }).x2) / 2) * 0.3048;
    expect(midX).toBeGreaterThan(0);
    expect(midX).toBeLessThan(2); // 落在第一段范围内
    expect(win.wallId).toBe(r.doc.walls[0]!.id); // 就是覆盖它的那段
    expect(win.wallId && r.doc.walls.some((w) => w.id === win.wallId)).toBe(true);
  });

  it('门缝门 → wallId 是缝前那段墙（门开在结束于缺口的那道墙里）', () => {
    const r = splitBand();
    const door = r.doc.doors[0]!;
    expect(door.wallId).toBe(r.doc.walls[0]!.id);
  });

  it('窗压在第二段上 → wallId 是第二段', () => {
    const r = buildDocFromRaw(
      rawOf([
        seg(P(0, 0), P(2, 0), 'wall'),
        seg(P(0, 0.24), P(2, 0.24), 'wall'),
        seg(P(3, 0), P(5, 0), 'wall'),
        seg(P(3, 0.24), P(5, 0.24), 'wall'),
        seg(P(3.5, 0.12), P(4.5, 0.12), 'window'),
      ]),
      { unit: 'm', name: 't', method: 'user' }
    );
    expect(r.doc.windows[0]!.wallId).toBe(r.doc.walls[1]!.id);
  });

  it('单区间墙带（没被切开）行为不变', () => {
    const r = buildDocFromRaw(
      rawOf([
        seg(P(0, 0), P(4, 0), 'wall'),
        seg(P(0, 0.24), P(4, 0.24), 'wall'),
        seg(P(1, 0.12), P(2, 0.12), 'window'),
      ]),
      { unit: 'm', name: 't', method: 'user' }
    );
    expect(r.info.counts.walls).toBe(1);
    expect(r.doc.windows[0]!.wallId).toBe(r.doc.walls[0]!.id);
  });

  it('产出的文档必须过 validate + checkGeoms（wallId 引用存在的墙）', () => {
    const r = buildDocFromRaw(
      rawOf([
        seg(P(0, 0), P(2, 0), 'wall'),
        seg(P(0, 0.24), P(2, 0.24), 'wall'),
        seg(P(3, 0), P(5, 0), 'wall'),
        seg(P(3, 0.24), P(5, 0.24), 'wall'),
        seg(P(0.5, 0.12), P(1.5, 0.12), 'window'),
      ]),
      { unit: 'm', name: 't', method: 'user' }
    );
    expect(r.doc.walls.length).toBeGreaterThan(0);
    for (const w of r.doc.windows) expect(r.doc.walls.some((x) => x.id === w.wallId)).toBe(true);
    for (const d of r.doc.doors) expect(d.wallId === null || r.doc.walls.some((x) => x.id === d.wallId)).toBe(true);
  });
});

/* ---------------------------------------------------------------- 图层分类 */

describe('classifyLayer：优先级与词边界（代码注释以前写得像相反，现在与测试一致）', () => {
  it('墙 > 柱：层名同时提到两者按墙算', () => {
    expect(classifyLayer('WALL-COLS')).toBe('wall');
    expect(classifyLayer('COL-WALL')).toBe('wall');
  });

  it('纯柱层写法仍命中 col', () => {
    for (const n of ['COL', 'COLS', 'COLUMN', 'COLUMNS', 'S-COLS', '柱']) expect(classifyLayer(n)).toBe('col');
  });

  it("'colors' 不得命中 col（词边界）", () => {
    expect(classifyLayer('colors')).not.toBe('col');
    expect(classifyLayer('COLORS')).not.toBe('col');
  });
});
