/* =====================================================================
   DXF 实体提取（extractRaw / bulgeToArc）—— 每种实体一条，含「静默丢弃」的边界
   背景：真实集成图纸里 ARC 有 22 个、CIRCLE 有 9 个（qcad_entities / libredwg），
   这些实体走的是哪条分支、什么情况下会被丢掉，以前没有任何测试钉着。
   ===================================================================== */
import { describe, it, expect } from 'vitest';
import { extractRaw, bulgeToArc } from '../../src/geo/import-dxf';
import type { DxfDoc, DxfEntity } from '../../src/geo/import-dxf';

const doc = (entities: DxfEntity[]): DxfDoc => ({ header: { $INSUNITS: 4 }, entities });
const ent = (e: Record<string, unknown>): DxfEntity => e as unknown as DxfEntity;

describe('LINE / 折线', () => {
  it('普通 LINE 入 segs；零长 LINE 不入（否则配对出零厚墙带）', () => {
    const r = extractRaw(
      doc([
        ent({
          type: 'LINE',
          layer: 'WALL',
          vertices: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
          ],
        }),
        ent({
          type: 'LINE',
          layer: 'WALL',
          vertices: [
            { x: 5, y: 5 },
            { x: 5, y: 5 },
          ],
        }),
        ent({ type: 'LINE', layer: 'WALL', vertices: [{ x: 1, y: 1 }] }),
      ])
    );
    expect(r.segs).toHaveLength(1);
  });

  it('墙层的闭合折线要逐边（含闭合边）入候选，不能只当多边形 —— 否则永远配不出墙厚', () => {
    const r = extractRaw(
      doc([
        ent({
          type: 'LWPOLYLINE',
          layer: 'WALL',
          shape: true,
          vertices: [
            { x: 0, y: 0 },
            { x: 4000, y: 0 },
            { x: 4000, y: 3000 },
            { x: 0, y: 3000 },
          ],
        }),
      ])
    );
    expect(r.segs).toHaveLength(4); // 3 条显式边 + 1 条闭合边
    expect(r.closed).toHaveLength(0);
  });

  it('家具层的闭合折线仍当多边形（不当墙）', () => {
    const r = extractRaw(
      doc([
        ent({
          type: 'LWPOLYLINE',
          layer: 'FURNITURE',
          shape: true,
          vertices: [
            { x: 0, y: 0 },
            { x: 600, y: 0 },
            { x: 600, y: 600 },
          ],
        }),
      ])
    );
    expect(r.closed).toHaveLength(1);
    expect(r.segs).toHaveLength(0);
  });

  it('开放折线：逐边 + bulge 边转圆弧（直线边照常入 segs）', () => {
    const r = extractRaw(
      doc([
        ent({
          type: 'LWPOLYLINE',
          layer: 'WALL',
          shape: false,
          vertices: [
            { x: 0, y: 0 },
            { x: 1000, y: 0, bulge: 0.4142 }, // 圆角
            { x: 1000, y: 1000 },
          ],
        }),
      ])
    );
    expect(r.segs).toHaveLength(1); // 只有 1000→1000 那条直边
    expect(r.arcs).toHaveLength(1);
    expect(r.arcs[0].r).toBeCloseTo(707.1, 0); // θ=4·atan(0.4142)=90°，弦长 1000 → r = 500/sin45° = 707.1
    expect(r.arcs[0].full).toBe(false);
  });

  it('bulge 的正负决定弧在行进方向的哪一侧（圆心在弦的两侧）', () => {
    const up = bulgeToArc({ x: 0, y: 0 }, { x: 100, y: 100 }, 0.4142)!;
    const down = bulgeToArc({ x: 0, y: 0 }, { x: 100, y: 100 }, -0.4142)!;
    // 0.4142 是 tan(π/8)=0.41421356 的近似 → 结果有 1e-3 量级末位差，别按精确值断言
    expect(up.r).toBeCloseTo(100, 2);
    expect(up.c.x).toBeCloseTo(0, 2);
    expect(up.c.y).toBeCloseTo(100, 2); // 弦的左上侧
    expect(down.c.x).toBeCloseTo(100, 2);
    expect(down.c.y).toBeCloseTo(0, 2); // 弦的右下侧
    expect(Math.abs(up.e - up.s)).toBeCloseTo(Math.abs(down.e - down.s), 9);
  });

  it('bulge 太小（≈0）不算弧；折线点数不足 2 直接跳过', () => {
    const r = extractRaw(
      doc([
        ent({
          type: 'LWPOLYLINE',
          layer: 'WALL',
          vertices: [
            { x: 0, y: 0, bulge: 1e-9 },
            { x: 10, y: 0 },
          ],
        }),
        ent({ type: 'LWPOLYLINE', layer: 'WALL', vertices: [{ x: 0, y: 0 }] }),
        ent({
          type: 'LWPOLYLINE',
          layer: 'WALL',
          vertices: [
            { x: NaN, y: 0 },
            { x: 10, y: 0 },
          ],
        }),
      ])
    );
    expect(r.arcs).toHaveLength(0);
    expect(r.segs).toHaveLength(1); // NaN 点被过滤后只剩一条有效点 → 不足 2 → 跳过；第一条是直线边
  });
});

describe('ARC / CIRCLE', () => {
  it('ARC 正常入 arcs（角度已是弧度）', () => {
    const r = extractRaw(
      doc([
        ent({ type: 'ARC', layer: 'WALL', center: { x: 0, y: 0 }, radius: 500, startAngle: 0, endAngle: Math.PI / 2 }),
      ])
    );
    expect(r.arcs).toHaveLength(1);
    expect(r.arcs[0].full).toBe(false);
  });

  it('endAngle < startAngle（跨过 0°）要补成正向扫角，不能算出负扫角', () => {
    const r = extractRaw(
      doc([ent({ type: 'ARC', layer: 'WALL', center: { x: 0, y: 0 }, radius: 10, startAngle: 5, endAngle: 1 })])
    );
    expect(r.arcs[0].e).toBeGreaterThan(r.arcs[0].s);
    expect(r.arcs[0].e - r.arcs[0].s).toBeCloseTo(1 - 5 + 2 * Math.PI, 9);
  });

  it('整圆 ARC（sweep≈2π）标 full', () => {
    const r = extractRaw(
      doc([
        ent({ type: 'ARC', layer: 'COL', center: { x: 0, y: 0 }, radius: 300, startAngle: 0, endAngle: Math.PI * 2 }),
      ])
    );
    expect(r.arcs[0].full).toBe(true);
  });

  it('缺 center / 半径 ≤ 0 的 ARC 与 CIRCLE 被跳过（不产生 NaN 几何）', () => {
    const r = extractRaw(
      doc([
        ent({ type: 'ARC', layer: 'WALL', radius: 10, startAngle: 0, endAngle: 1 }),
        ent({ type: 'ARC', layer: 'WALL', center: { x: 0, y: 0 }, radius: 0 }),
        ent({ type: 'CIRCLE', layer: 'COL' }),
        ent({ type: 'CIRCLE', layer: 'COL', center: { x: 0, y: 0 }, radius: -3 }),
      ])
    );
    expect(r.arcs).toHaveLength(0);
    expect(r.circles).toHaveLength(0);
  });

  it('CIRCLE 入 circles（后续按柱层 → 圆形柱）', () => {
    const r = extractRaw(doc([ent({ type: 'CIRCLE', layer: 'COL', center: { x: 200, y: 300 }, radius: 250 })]));
    expect(r.circles).toHaveLength(1);
    expect(r.circles[0].cls).toBe('col');
  });
});

describe('SPLINE 与「读不了的实体」', () => {
  it('SPLINE 有 fitPoints 用 fitPoints；没有则退回 controlPoints', () => {
    const a = extractRaw(
      doc([
        ent({
          type: 'SPLINE',
          layer: 'WALL',
          fitPoints: [
            { x: 0, y: 0 },
            { x: 10, y: 5 },
            { x: 20, y: 0 },
          ],
        }),
      ])
    );
    expect(a.segs).toHaveLength(2);
    const b = extractRaw(
      doc([
        ent({
          type: 'SPLINE',
          layer: 'WALL',
          controlPoints: [
            { x: 0, y: 0 },
            { x: 10, y: 5 },
          ],
        }),
      ])
    );
    expect(b.segs).toHaveLength(1);
    const c = extractRaw(doc([ent({ type: 'SPLINE', layer: 'WALL', fitPoints: [{ x: 0, y: 0 }] })]));
    expect(c.segs).toHaveLength(0);
  });

  it('闭合 SPLINE 当多边形（不当一串散线）', () => {
    const r = extractRaw(
      doc([
        ent({
          type: 'SPLINE',
          layer: 'FURNITURE',
          closed: true,
          fitPoints: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
          ],
        }),
      ])
    );
    expect(r.closed).toHaveLength(1);
    expect(r.segs).toHaveLength(0);
  });

  it('ELLIPSE / INSERT / TEXT / 未知实体要计数报出来，不能静默消失', () => {
    const r = extractRaw(
      doc([
        ent({ type: 'ELLIPSE', layer: 'WALL' }),
        ent({ type: 'INSERT', layer: 'FURNITURE' }),
        ent({ type: 'TEXT', layer: 'TEXT' }),
        ent({ type: 'MTEXT', layer: 'TEXT' }),
        ent({ type: 'HATCH', layer: 'FLOOR' }),
        ent({ type: 'DIMENSION', layer: 'DIM' }),
      ])
    );
    expect(r.skipped).toEqual({ ellipses: 1, inserts: 1, texts: 2, other: 2 });
  });

  it('空文档 / 没有 entities 字段都不能抛', () => {
    expect(extractRaw({ entities: [], header: {} }).segs).toHaveLength(0);
    expect(extractRaw({} as DxfDoc).segs).toHaveLength(0);
  });
});
