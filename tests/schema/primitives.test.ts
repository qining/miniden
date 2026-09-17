import { describe, it, expect } from 'vitest';
import {
  arcPoint, arcSweep, arcLen, segLen, dist, expand, polyArea, arcFrom3Points, fullCircle,
  type Arc, type Seg,
} from '../../src/schema/primitives';

/* =====================================================================
   primitives（ADR-0002）——expand() 是唯一的 geom→段链 展开函数。
   验收：矢高误差断言（ADR-0002「expand() 是纯函数 → 单测覆盖」）。
   ===================================================================== */

const close = (a: [number, number], b: [number, number], eps = 1e-9) =>
  Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;

const quarter: Arc = { t: 'arc', cx: 0, cy: 0, r: 1, a0: 0, a1: 90, dir: 1 };
const half: Arc = { t: 'arc', cx: 0, cy: 0, r: 1, a0: 0, a1: 180, dir: 1 };
const full: Arc = fullCircle(2, 3, 0.5);

describe('arcPoint / arcSweep / arcLen', () => {
  it('弧上点（y 向下坐标）', () => {
    expect(close(arcPoint(quarter, 0), [1, 0])).toBe(true);
    expect(close(arcPoint(quarter, 90), [0, 1])).toBe(true);
    expect(close(arcPoint(quarter, 135), [-0.70710678, 0.70710678], 1e-6)).toBe(true);
  });

  it('sweep：带符号、360 环绕、整圆', () => {
    expect(arcSweep(quarter)).toBe(90);
    expect(arcSweep({ ...quarter, a0: 270, a1: 90, dir: 1 })).toBe(180);   // 跨 0°
    expect(arcSweep({ ...quarter, a0: 90, a1: 0, dir: -1 })).toBe(-90);    // 顺向：90→0
    expect(arcSweep({ ...quarter, a0: 0, a1: 270, dir: -1 })).toBe(-90);   // 顺向跨 0°
    expect(arcSweep(full)).toBe(360);
  });

  it('arcLen', () => {
    expect(arcLen(quarter)).toBeCloseTo(Math.PI / 2, 12);
    expect(arcLen(full)).toBeCloseTo(Math.PI, 12);
  });
});

describe('expand(seg / poly)', () => {
  it('seg → 单段链', () => {
    const s: Seg = { t: 'seg', x1: 0, y1: 0, x2: 3, y2: 4 };
    expect(expand(s)).toEqual([[[0, 0], [3, 4]]]);
    expect(segLen(s)).toBe(5);
  });

  it('零长段 → 空链（不抛错）', () => {
    expect(expand({ t: 'seg', x1: 1, y1: 1, x2: 1, y2: 1 })).toEqual([]);
  });

  it('poly → 闭合链（首尾相接）', () => {
    const out = expand({ t: 'poly', pts: [[0, 0], [2, 0], [2, 1], [0, 1]] });
    expect(out).toHaveLength(4);
    expect(out[3][1]).toEqual(out[0][0]);
    expect(polyArea([[0, 0], [2, 0], [2, 1], [0, 1]])).toBe(2);
  });
});

describe('expand(arc) —— 矢高误差（ADR-0002 验收）', () => {
  // 弦中点到圆心的距离偏差 = 该弦的矢高
  const sagitta = (a: Arc, p0: [number, number], p1: [number, number]) => {
    const mid: [number, number] = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
    return Math.abs(a.r - dist(mid, [a.cx, a.cy]));
  };

  it('默认 3mm 矢高上限', () => {
    for (const a of [quarter, half, full]) {
      const out = expand(a);
      expect(out.length).toBeGreaterThanOrEqual(2);
      for (const [p0, p1] of out) {
        expect(sagitta(a, p0, p1)).toBeLessThanOrEqual(0.01 * 1.0001);
      }
      expect(close(out[0][0], arcPoint(a, a.a0), 1e-12)).toBe(true);
      expect(close(out[out.length - 1][1], arcPoint(a, a.a1), 1e-12)).toBe(true);
    }
  });

  it('整圆首尾相接（闭合）', () => {
    const out = expand(full);
    expect(close(out[0][0], out[out.length - 1][1], 1e-12)).toBe(true);
  });

  it('更紧的 chordTol → 更多段；segments 强制段数', () => {
    const nDefault = expand(quarter).length;
    const nTight = expand(quarter, { chordTol: 0.001 }).length;
    expect(nTight).toBeGreaterThan(nDefault);
    expect(expand(quarter, { segments: 5 })).toHaveLength(5);
  });

  it('dir=-1 反向走（90° → 0°，经第一象限）', () => {
    const a: Arc = { t: 'arc', cx: 0, cy: 0, r: 1, a0: 90, a1: 0, dir: -1 };
    const out = expand(a);
    expect(close(out[0][0], [0, 1], 1e-12)).toBe(true);     // 起点 θ=90
    expect(close(out[out.length - 1][1], [1, 0], 1e-12)).toBe(true); // 终点 θ=0
    const mid = out[Math.floor(out.length / 2)][0];
    expect(mid[0]).toBeGreaterThan(0.5);
    expect(mid[1]).toBeGreaterThan(0.5);
  });
});

describe('arcFrom3Points（三点定弧，ADR-0002 编辑交互）', () => {
  it('四分之一圆（顺时针，y 向下）', () => {
    const res = arcFrom3Points([1, 0], [0.7071, 0.7071], [0, 1]);
    expect(res).not.toBeNull();
    const a = res!.arc;
    expect(a.cx).toBeCloseTo(0, 3);
    expect(a.cy).toBeCloseTo(0, 3);
    expect(a.r).toBeCloseTo(1, 3);
    expect(a.dir).toBe(1);
    const out = expand(a);
    expect(close(out[0][0], [1, 0], 1e-3)).toBe(true);
    expect(close(out[out.length - 1][1], [0, 1], 1e-3)).toBe(true);
  });

  it('三点共线 → null（消费层降级折线）', () => {
    expect(arcFrom3Points([0, 0], [1, 1], [2, 2])).toBeNull();
  });
});
