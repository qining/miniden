/* S15：点位被家具挡住的判据（纯函数，单位 ft）。
   口径（docs/design/home-v2.md §S15）：墙面类看面板正前方 5–25cm 的一排探点 + 高度区间是否相交；
   地面类看占地是否盖住中心且家具落地；天花永不判；灯具 / 幽灵件不参与；blocks=false 的类型（上下水 / 燃气 / 排风口）不判。 */
import { describe, it, expect } from 'vitest';
import { pointBlockers, obbCorners, pointInPoly, convexClipArea, type FurnBox, type Pt2 } from '../../src/geo/points';

const CM = 1 / 30.48;
// 一面朝 +y 的墙在 y=0，插座贴墙皮装在 (0, 0)，正面朝 +y（rot = 90°）
const outlet = (hCm: number, extra: Record<string, unknown> = {}) => ({
  x: 0,
  y: 0,
  rot: 90,
  h: hCm * CM,
  host: 'wall',
  plateW: 7 * CM,
  plateH: 11.5 * CM,
  ...extra,
});
// 一件家具：中心 (cx, cy)、宽 w 深 d（cm）、高度区间 [z0, z1]（cm）、旋转 rot（度）
const box = (
  id: string,
  cx: number,
  cy: number,
  w: number,
  d: number,
  z0: number,
  z1: number,
  rot = 0,
  extra = {}
): FurnBox => ({
  id,
  corners: obbCorners(cx * CM, cy * CM, w * CM, d * CM, rot),
  z0: z0 * CM,
  z1: z1 * CM,
  ...extra,
});

describe('obbCorners / pointInPoly', () => {
  it('轴对齐与旋转 90° 的占地是同一块（宽深互换）', () => {
    const a = obbCorners(0, 0, 2, 1, 0);
    const b = obbCorners(0, 0, 1, 2, 90);
    for (const p of [
      [0.9, 0.4],
      [-0.9, -0.4],
    ] as [number, number][]) {
      expect(pointInPoly(p, a)).toBe(true);
      expect(pointInPoly(p, b)).toBe(true);
    }
    expect(pointInPoly([0, 0.6], a)).toBe(false);
  });
});

describe('pointBlockers：墙面点位', () => {
  it('沙发（高 80cm）背靠墙摆在 30cm 的插座前 → 挡住', () => {
    expect(pointBlockers(outlet(30), [box('sofa', 0, 45, 200, 90, 0, 80)])).toEqual(['sofa']);
  });

  it('矮凳（高 20cm）在 30cm 的插座前 → 不挡（低于面板下沿）', () => {
    expect(pointBlockers(outlet(30), [box('bench', 0, 20, 100, 35, 0, 20)])).toEqual([]);
  });

  it('壁挂柜（离地 150–190cm）在 30cm 的插座正上方 → 不挡；同一个柜子挡住 160cm 的开关', () => {
    const cab = box('cab', 0, 18, 120, 35, 150, 190);
    expect(pointBlockers(outlet(30), [cab])).toEqual([]);
    expect(pointBlockers(outlet(160), [cab])).toEqual(['cab']);
  });

  it('家具离墙 40cm 摆（插座前面空着一条缝）→ 不挡', () => {
    expect(pointBlockers(outlet(30), [box('sofa', 0, 40 + 45, 200, 90, 0, 80)])).toEqual([]);
  });

  it('家具在插座侧面 1m 处 → 不挡；只差半个面板宽就盖到 → 挡住', () => {
    expect(pointBlockers(outlet(30), [box('cab', 100 + 50, 20, 100, 40, 0, 90)])).toEqual([]);
    expect(pointBlockers(outlet(30), [box('cab', 3 + 50, 20, 100, 40, 0, 90)])).toEqual(['cab']);
  });

  it('旋转 45° 的柜子斜着压在插座前 → 挡住', () => {
    expect(pointBlockers(outlet(30), [box('cab', 0, 25, 60, 40, 0, 90, 45)])).toEqual(['cab']);
  });

  it('地毯在墙面插座前 → 不挡（地毯只有 1cm 高）', () => {
    expect(pointBlockers(outlet(30), [box('rug', 0, 100, 200, 300, 0, 1, 0, { rug: true })])).toEqual([]);
  });

  it('灯具与幽灵件不参与', () => {
    const lamp = box('lamp', 0, 15, 30, 30, 0, 160, 0, { light: true });
    const ghost = box('ghost', 0, 15, 40, 40, 0, 40, 0, { ghost: true });
    expect(pointBlockers(outlet(30), [lamp, ghost])).toEqual([]);
  });

  it('同时被两件挡住 → 两件都报', () => {
    const r = pointBlockers(outlet(30, { plateW: 30 * CM }), [
      box('a', -40, 20, 70, 40, 0, 80),
      box('b', 40, 20, 70, 40, 0, 80),
    ]);
    expect(r.sort()).toEqual(['a', 'b']);
  });

  it('blocks=false 的类型（上下水 / 燃气 / 排风口）永不判', () => {
    expect(pointBlockers(outlet(110, { blocks: false }), [box('washer', 0, 35, 60, 60, 0, 85)])).toEqual([]);
  });

  it('朝向决定「正前方」：朝 −y 的插座，家具在 +y 一侧 → 不挡', () => {
    expect(pointBlockers(outlet(30, { rot: 270 }), [box('sofa', 0, 45, 200, 90, 0, 80)])).toEqual([]);
  });
});

describe('pointBlockers：地面 / 天花点位', () => {
  const vent = { x: 0, y: 0, rot: 0, h: 0, host: 'floor', plateW: 25 * CM, plateH: 10 * CM };
  it('地毯盖住地面送风口 → 挡住（地毯盖住一样不出风）', () => {
    expect(pointBlockers(vent, [box('rug', 0, 0, 200, 300, 0, 1, 0, { rug: true })])).toEqual(['rug']);
  });
  it('床压在送风口上 → 挡住；壁挂柜在送风口上方 → 不挡', () => {
    expect(pointBlockers(vent, [box('bed', 0, 0, 160, 200, 0, 45)])).toEqual(['bed']);
    expect(pointBlockers(vent, [box('cab', 0, 0, 120, 35, 150, 190)])).toEqual([]);
  });
  it('家具在送风口旁边 → 不挡', () => {
    expect(pointBlockers(vent, [box('bed', 120, 0, 160, 200, 0, 45)])).toEqual([]);
  });
  it('天花点位永不判', () => {
    expect(pointBlockers({ ...vent, host: 'ceiling', h: 8.8 }, [box('wardrobe', 0, 0, 100, 60, 0, 240)])).toEqual([]);
  });
  it('空列表 → 空结果', () => {
    expect(pointBlockers(vent, [])).toEqual([]);
  });
});

describe('S17 家具压在楼梯上：凸多边形裁任意多边形的面积', () => {
  // L 形楼梯外轮廓（手算：第一段 x∈[-1.5,1.5]、y∈[0,9.5]；第二段 y∈[6.5,9.5]、x 到 6）
  const L: Pt2[] = [
    [-1.5, 0],
    [-1.5, 9.5],
    [6, 9.5],
    [6, 6.5],
    [1.5, 6.5],
    [1.5, 0],
  ];
  it('完全在里面 = 自己的面积；压住一半 = 一半', () => {
    expect(convexClipArea(L, obbCorners(0, 3, 2, 2, 0))).toBeCloseTo(4, 9);
    expect(convexClipArea(L, obbCorners(1.5, 3, 2, 2, 0))).toBeCloseTo(2, 9);
  });
  it('放在 L 的凹口里（两段梯段之间那块空地）= 0：凹多边形不能当凸包算', () => {
    expect(convexClipArea(L, obbCorners(3.5, 3, 2, 2, 0))).toBeCloseTo(0, 9);
  });
  it('只碰边（柜子贴着楼梯口放）= 0；转 45° 跨过拐角 > 0', () => {
    expect(convexClipArea(L, obbCorners(2.5, 3, 2, 2, 0))).toBeCloseTo(0, 9);
    expect(convexClipArea(L, obbCorners(1.5, 6.5, 2, 2, 45))).toBeGreaterThan(0.5);
  });
  it('绕向无关；退化输入 = 0', () => {
    const box = obbCorners(0, 3, 2, 2, 0);
    expect(convexClipArea(L.slice().reverse(), box.slice().reverse())).toBeCloseTo(4, 9);
    expect(convexClipArea([], box)).toBe(0);
    expect(convexClipArea(L, box.slice(0, 2))).toBe(0);
  });
});
