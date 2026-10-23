/* S18：摆家具的几何判据（纯函数，单位 ft）。独立量：墙皮位置 = 轴线 ± 半厚；贴齐后的边 = 墙皮；
   扇形面积 → 四分之一圆（12 段折线近似，内接多边形面积公式给出的值）。 */
import { describe, it, expect } from 'vitest';
import { wallFaces, snapBox, clearances, doorSweep, type Pt2, type Box } from '../../src/geo/placement';

/** 轴线 (x1,y1)→(x2,y2)、厚 t 的墙体封口多边形 [a1,b1,b2,a2]（与 app 的 wallPolys 同形） */
const wallPoly = (x1: number, y1: number, x2: number, y2: number, t: number): Pt2[] => {
  const L = Math.hypot(x2 - x1, y2 - y1),
    nx = (-(y2 - y1) / L) * (t / 2),
    ny = ((x2 - x1) / L) * (t / 2);
  return [
    [x1 - nx, y1 - ny],
    [x2 - nx, y2 - ny],
    [x2 + nx, y2 + ny],
    [x1 + nx, y1 + ny],
  ];
};
const area = (p: Pt2[]) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) a += p[i][0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * p[i][1];
  return Math.abs(a / 2);
};
/** 盒子四角 */
const corners = (b: Box): Pt2[] => {
  const r = (b.rot * Math.PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r);
  return (
    [
      [-b.w / 2, -b.d / 2],
      [b.w / 2, -b.d / 2],
      [b.w / 2, b.d / 2],
      [-b.w / 2, b.d / 2],
    ] as Pt2[]
  ).map(([x, y]) => [b.cx + x * c - y * s, b.cy + x * s + y * c] as Pt2);
};

// 一间 10 × 6 的房：四面墙轴线在 y=0 / x=10 / y=6 / x=0，厚 0.5（墙皮在轴线 ± 0.25）
const room = [
  wallPoly(0, 0, 10, 0, 0.5),
  wallPoly(10, 0, 10, 6, 0.5),
  wallPoly(10, 6, 0, 6, 0.5),
  wallPoly(0, 6, 0, 0, 0.5),
];
const F = wallFaces(room);

describe('墙皮', () => {
  it('每段墙两条长边；法线朝外（离开墙体）', () => {
    expect(F.length).toBe(8);
    const bottomIn = F.find((f) => f.poly === 0 && f.n[1] > 0.99)!; // y=0 那段墙朝房间（+y）的墙皮
    expect(bottomIn.a[1]).toBeCloseTo(0.25, 9);
    expect(bottomIn.b[1]).toBeCloseTo(0.25, 9);
    const bottomOut = F.find((f) => f.poly === 0 && f.n[1] < -0.99)!;
    expect(bottomOut.a[1]).toBeCloseTo(-0.25, 9);
  });
  it('非四边形：所有够长的边都算；太短的边不算', () => {
    const tri: Pt2[] = [
      [0, 0],
      [4, 0],
      [0, 0.3],
    ];
    expect(wallFaces([tri], 0.5).length).toBe(2);
    expect(wallFaces([[] as Pt2[]]).length).toBe(0);
  });
  it('结构柱（allEdges）：四边都是面，法线都朝外', () => {
    const col: Pt2[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const f = wallFaces([col], 0.5, true);
    expect(f.length).toBe(4);
    for (const x of f) {
      const m: Pt2 = [(x.a[0] + x.b[0]) / 2, (x.a[1] + x.b[1]) / 2];
      expect((m[0] - 0.5) * x.n[0] + (m[1] - 0.5) * x.n[1]).toBeGreaterThan(0);
    }
  });
});

describe('贴墙吸附', () => {
  it('离墙皮 0.75ft、吸附半径 1ft → 贴上（边落在墙皮上）；半径 0.5ft → 不动', () => {
    const b: Box = { cx: 5, cy: 1.5, w: 2, d: 1, rot: 0 }; // 下沿 y=1.0，墙皮 y=0.25
    const s = snapBox(b, F, 1);
    expect(s.faces.length).toBe(1);
    expect(s.dx).toBeCloseTo(0, 9);
    expect(s.dy).toBeCloseTo(-0.75, 9);
    expect(snapBox(b, F, 0.5)).toEqual({ dx: 0, dy: 0, faces: [] });
  });
  it('推进墙角：本地 x 向与 y 向各贴一面', () => {
    const b: Box = { cx: 1.5, cy: 1.2, w: 2, d: 1, rot: 0 }; // 左沿 x=0.5（墙皮 0.25）、下沿 y=0.7（墙皮 0.25）
    const s = snapBox(b, F, 0.6);
    expect(s.faces.length).toBe(2);
    expect(s.dx).toBeCloseTo(-0.25, 9);
    expect(s.dy).toBeCloseTo(-0.45, 9);
  });
  it('转 90°：宽深互换，照样贴', () => {
    const b: Box = { cx: 5, cy: 1.6, w: 2, d: 1, rot: 90 }; // 转后沿 y 方向半长 1 → 下沿 y=0.6
    const s = snapBox(b, F, 0.5);
    expect(s.dy).toBeCloseTo(-0.35, 9);
  });
  it('不平行（转 10°）不吸；2° 以内照吸，以离墙最近的那个角为准', () => {
    expect(snapBox({ cx: 5, cy: 1.5, w: 2, d: 1, rot: 10 }, F, 1).faces.length).toBe(0);
    const b: Box = { cx: 5, cy: 1.5, w: 2, d: 1, rot: 2 };
    const s = snapBox(b, F, 1);
    expect(s.faces.length).toBe(1);
    const moved = corners({ ...b, cx: b.cx + s.dx, cy: b.cy + s.dy });
    expect(Math.min(...moved.map((p) => p[1]))).toBeCloseTo(0.25, 9);
  });
  it('已经插进墙里一点 → 拉回到贴齐；墙皮沿线方向够不着（家具在墙端外面）→ 不吸', () => {
    const s = snapBox({ cx: 5, cy: 0.6, w: 2, d: 1, rot: 0 }, F, 0.5); // 下沿 0.1 < 墙皮 0.25
    expect(s.dy).toBeCloseTo(0.15, 9);
    const lone = wallFaces([wallPoly(0, 0, 4, 0, 0.5)]);
    expect(snapBox({ cx: 6, cy: 0.9, w: 2, d: 1, rot: 0 }, lone, 1).faces.length).toBe(0);
  });
  it('墙的另一面（背对着的墙皮）不参与', () => {
    // 盒子在 y<0 一侧（墙外），朝 +y 的墙皮背对它
    const s = snapBox({ cx: 5, cy: -1.0, w: 2, d: 1, rot: 0 }, F, 0.4); // 上沿 −0.5，外侧墙皮 −0.25
    expect(s.dy).toBeCloseTo(0.25, 9);
  });
});

describe('距离标注', () => {
  it('四条边到迎面墙皮的距离 = 独立量（房间净尺寸 − 家具尺寸 − 位置）', () => {
    const b: Box = { cx: 5, cy: 3, w: 2, d: 1, rot: 0 };
    const c = clearances(b, F, 20);
    const by = (k: number) => c.find((x) => x.side === k)!.dist;
    expect(by(0)).toBeCloseTo(10 - 0.25 - 6, 9); // +x：右墙皮 9.75 − 右沿 6
    expect(by(1)).toBeCloseTo(4 - 0.25, 9); // −x：左沿 4 − 左墙皮 0.25
    expect(by(2)).toBeCloseTo(6 - 0.25 - 3.5, 9);
    expect(by(3)).toBeCloseTo(2.5 - 0.25, 9);
  });
  it('超过 maxDist 的不报；射线打在墙皮所在直线上但不在墙皮上 → 不报', () => {
    expect(clearances({ cx: 5, cy: 3, w: 2, d: 1, rot: 0 }, F, 2).length).toBe(0);
    const lone = wallFaces([wallPoly(0, 0, 4, 0, 0.5)]);
    expect(clearances({ cx: 6, cy: 2, w: 2, d: 1, rot: 0 }, lone, 10).length).toBe(0);
  });
});

describe('门扇扫过的扇形', () => {
  it('铰链 + 圆弧 13 个点；面积 = 12 段内接折线的四分之一圆', () => {
    const p = doorSweep([0, 0], [3, 0], [0, 1]);
    expect(p.length).toBe(14);
    const want = 0.5 * 9 * 12 * Math.sin(Math.PI / 2 / 12); // 12 个等腰三角形
    expect(area(p)).toBeCloseTo(want, 9);
    expect(p[p.length - 1][0]).toBeCloseTo(0, 9);
    expect(p[p.length - 1][1]).toBeCloseTo(3, 9);
  });
  it('门扇长 0 → 空', () => {
    expect(doorSweep([1, 1], [1, 1], [0, 1])).toEqual([]);
  });
});
