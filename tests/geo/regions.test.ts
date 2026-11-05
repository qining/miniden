/* S16：点一下房间 → 房间轮廓 / 面积 / 标注点；房屋外轮廓（纯函数，单位 ft）。
   断言用独立量：矩形房间的净面积 = (轴线宽 − 墙厚) × (轴线深 − 墙厚)，不照抄实现。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildGrid,
  regionAt,
  footprint,
  simplifyClosed,
  polyArea,
  pointInPolygon,
  traceLoops,
  flood,
  cellAt,
  type Barrier,
  type Pt2,
} from '../../src/geo/regions';

const T = 0.4; // 墙厚 ft（≈12cm）
const wall = (x1: number, y1: number, x2: number, y2: number, t = T): Barrier => ({ x1, y1, x2, y2, half: t / 2 });
const box = (x0: number, y0: number, x1: number, y1: number): Barrier[] => [
  wall(x0, y0, x1, y0),
  wall(x1, y0, x1, y1),
  wall(x1, y1, x0, y1),
  wall(x0, y1, x0, y0),
];

describe('regionAt：矩形房间', () => {
  const segs = box(0, 0, 12, 10);
  const r = regionAt({ segs }, 6, 5);

  it('围住了（不漏）、面积 = 净宽 × 净深（误差 < 1%）', () => {
    expect(r.leaked).toBe(false);
    expect(r.region).toBeTruthy();
    const want = (12 - T) * (10 - T);
    expect(Math.abs(r.region!.area - want) / want).toBeLessThan(0.01);
  });

  it('轮廓被简化成 4 个角，四边离墙皮 < 1 英寸', () => {
    const p = r.region!.poly;
    expect(p.length).toBe(4);
    const xs = p.map((q) => q[0]),
      ys = p.map((q) => q[1]);
    expect(Math.abs(Math.min(...xs) - T / 2)).toBeLessThan(1 / 12);
    expect(Math.abs(Math.max(...xs) - (12 - T / 2))).toBeLessThan(1 / 12);
    expect(Math.abs(Math.min(...ys) - T / 2)).toBeLessThan(1 / 12);
    expect(Math.abs(Math.max(...ys) - (10 - T / 2))).toBeLessThan(1 / 12);
  });

  it('标注点在房间正中附近（离边界最远）', () => {
    const [lx, ly] = r.region!.label;
    expect(Math.abs(lx - 6)).toBeLessThan(0.6);
    expect(Math.abs(ly - 5)).toBeLessThan(0.6);
  });

  it('点在墙里 → 没有区域、也不算漏', () => {
    const w = regionAt({ segs }, 0, 5);
    expect(w.region).toBeNull();
    expect(w.leaked).toBe(false);
  });
});

describe('regionAt：形状与拓扑', () => {
  it('L 形房间 → 6 个角，面积对得上', () => {
    // 轴线：(0,0)-(12,0)-(12,6)-(6,6)-(6,12)-(0,12)
    const pts: Pt2[] = [
      [0, 0],
      [12, 0],
      [12, 6],
      [6, 6],
      [6, 12],
      [0, 12],
    ];
    const segs = pts.map((p, i) => wall(p[0], p[1], pts[(i + 1) % pts.length][0], pts[(i + 1) % pts.length][1]));
    const r = regionAt({ segs }, 2, 2);
    expect(r.leaked).toBe(false);
    expect(r.region!.poly.length).toBe(6);
    // 净面积：轴线 L 形面积 108，扣掉墙内侧那一半厚度沿周长（48ft）≈ 48 × T/2，再补回凸 / 凹角的小方块
    const want = 108 - 48 * (T / 2) + (5 * (T / 2) ** 2 - (T / 2) ** 2);
    expect(Math.abs(r.region!.area - want) / want).toBeLessThan(0.015);
  });

  it('墙有一个 2ft 的缺口 → leaked', () => {
    const segs = [wall(0, 0, 12, 0), wall(12, 0, 12, 10), wall(12, 10, 0, 10), wall(0, 10, 0, 6), wall(0, 4, 0, 0)];
    const r = regionAt({ segs }, 6, 5);
    expect(r.leaked).toBe(true);
    expect(r.region).toBeNull();
  });

  it('一道隔墙分出两间：各自只是自己那一半', () => {
    const segs = [...box(0, 0, 20, 10), wall(10, 0, 10, 10)];
    const a = regionAt({ segs }, 5, 5),
      b = regionAt({ segs }, 15, 5);
    const want = (10 - T) * (10 - T);
    expect(Math.abs(a.region!.area - want) / want).toBeLessThan(0.01);
    expect(Math.abs(b.region!.area - want) / want).toBeLessThan(0.01);
    expect(pointInPolygon([15, 5], a.region!.poly)).toBe(false);
  });

  it('房间里有一根 1.5ft 见方的柱子：面积扣掉柱子，轮廓还是外面那四个角', () => {
    const col: Pt2[] = [
      [5, 4],
      [6.5, 4],
      [6.5, 5.5],
      [5, 5.5],
    ];
    const r = regionAt({ segs: box(0, 0, 12, 10), polys: [col] }, 2, 2);
    const want = (12 - T) * (10 - T) - 1.5 * 1.5;
    expect(Math.abs(r.region!.area - want) / want).toBeLessThan(0.01);
    expect(r.region!.poly.length).toBe(4);
  });

  it('45° 斜墙围成的三角形房间：面积误差 < 2%', () => {
    const segs = [wall(0, 0, 12, 0), wall(12, 0, 0, 12), wall(0, 12, 0, 0)];
    const r = regionAt({ segs }, 2, 2);
    expect(r.leaked).toBe(false);
    // 净三角形：每条边向内收 T/2（内切圆半径法：面积 ≈ (r_in − T/2)² / r_in² × 原面积）
    const A = 72,
      s = (12 + 12 + 12 * Math.SQRT2) / 2,
      rin = A / s;
    const want = A * ((rin - T / 2) / rin) ** 2;
    expect(Math.abs(r.region!.area - want) / want).toBeLessThan(0.02);
    expect(r.region!.poly.length).toBeGreaterThanOrEqual(3); // 45° 的尖儿在 1 英寸格子上分辨不出来，会被截成一小段边
    expect(r.region!.poly.length).toBeLessThanOrEqual(4);
  });

  it('给了地板轮廓：轮廓外当障碍（没有墙的那一边也围得住）', () => {
    const bounds: Pt2[] = [
      [0, 0],
      [12, 0],
      [12, 10],
      [0, 10],
    ];
    const r = regionAt({ segs: [wall(0, 0, 12, 0), wall(12, 0, 12, 10)], bounds }, 4, 4);
    expect(r.leaked).toBe(false);
    expect(r.region!.area).toBeGreaterThan(100);
  });
});

describe('footprint：房屋外轮廓', () => {
  it('L 形房子 → 6 个角（不是包围盒那块矩形），面积 ≈ 外皮围成的面积', () => {
    const pts: Pt2[] = [
      [0, 0],
      [12, 0],
      [12, 6],
      [6, 6],
      [6, 12],
      [0, 12],
    ];
    const segs = pts.map((p, i) => wall(p[0], p[1], pts[(i + 1) % pts.length][0], pts[(i + 1) % pts.length][1]));
    const fp = footprint({ segs })!;
    expect(fp).toBeTruthy();
    expect(fp.length).toBe(6);
    const want = 108 + 48 * (T / 2) + (5 * (T / 2) ** 2 - (T / 2) ** 2);
    expect(Math.abs(polyArea(fp) - want) / want).toBeLessThan(0.015);
  });

  it('墙没围合 → null（调用方退回包围盒）', () => {
    expect(footprint({ segs: [wall(0, 0, 12, 0), wall(12, 0, 12, 10)] })).toBeNull();
  });

  it('什么都没有 → null', () => {
    expect(footprint({ segs: [] })).toBeNull();
    expect(buildGrid({ segs: [] })).toBeNull();
  });
});

describe('底层件', () => {
  it('simplifyClosed：栅格台阶被拉直成一条斜边', () => {
    const stair: Pt2[] = [];
    for (let i = 0; i < 20; i++) stair.push([i, i], [i + 1, i]);
    const poly: Pt2[] = [[0, 0], ...stair.slice(1), [20, 20], [0, 20]];
    const s = simplifyClosed(poly, 1.0);
    expect(s.length).toBeLessThanOrEqual(4);
  });

  it('traceLoops：单格区域 = 一个 4 角环；面积 = 格面积', () => {
    const g = buildGrid({ segs: [wall(0, 0, 1, 0, 0.01)], cell: 1, pad: 2 })!;
    const k = cellAt(g, -1.5, -1.5);
    const m = new Uint8Array(g.w * g.h);
    m[k] = 1;
    const loops = traceLoops(g, m);
    expect(loops.length).toBe(1);
    expect(loops[0].length).toBe(4);
    expect(polyArea(loops[0])).toBeCloseTo(1, 6);
  });

  it('flood：从障碍格起步 → 空', () => {
    const g = buildGrid({ segs: box(0, 0, 4, 4) })!;
    const f = flood(g, cellAt(g, 0, 2));
    expect(f.count).toBe(0);
  });

  it('太大的户型自动放粗格子（格数不超过上限）', () => {
    const g = buildGrid({ segs: box(0, 0, 400, 400), maxCells: 100_000 })!;
    expect(g.w * g.h).toBeLessThanOrEqual(110_000);
    const r = regionAt(g, 200, 200);
    expect(r.leaked).toBe(false);
  });
});

describe('buildGrid 的地板轮廓：逐行扫描与逐格 pointInPolygon 逐格一致（轮㊱ 的性能改写）', () => {
  /* 独立量：同一份输入、只给地板轮廓不给墙 → 障碍格 = 格心不在轮廓里的格子。按逐格 pointInPolygon 现算一遍对表 */
  const brute = (bounds: Pt2[]) => {
    const g = buildGrid({ segs: [], bounds })!;
    let diff = 0,
      outside = 0;
    for (let j = 0; j < g.h; j++)
      for (let i = 0; i < g.w; i++) {
        const want = pointInPolygon([g.x0 + (i + 0.5) * g.cell, g.y0 + (j + 0.5) * g.cell], bounds) ? 0 : 1;
        if (want) outside++;
        if (g.block[j * g.w + i] !== want) diff++;
      }
    return { diff, outside, cells: g.w * g.h };
  };
  it('L 形、带斜边的、顶点正好落在格心上的、凹进去的多段（含共线点）：一个格子都不差', () => {
    const shapes: Pt2[][] = [
      [
        [0, 0],
        [20, 0],
        [20, 8],
        [9, 8],
        [9, 15],
        [0, 15],
      ],
      [
        [0, 0],
        [14, 0],
        [18, 6],
        [11, 13],
        [-3, 9],
      ],
      // 顶点 / 水平边正好压在格心那一行（格 1/12ft、留白 2ft：格心 y = 网格起点 + (j + 0.5)/12）
      [
        [1 / 24, 1 / 24],
        [6 + 1 / 24, 1 / 24],
        [6 + 1 / 24, 3 + 1 / 24],
        [3 + 1 / 24, 3 + 1 / 24],
        [3 + 1 / 24, 6 + 1 / 24],
        [1 / 24, 6 + 1 / 24],
      ],
      [
        [0, 0],
        [5, 0],
        [10, 0],
        [10, 10],
        [7, 4],
        [3, 10],
        [0, 10],
      ],
    ];
    for (const b of shapes) {
      const r = brute(b);
      expect(r.diff).toBe(0);
      expect(r.outside).toBeGreaterThan(0);
      expect(r.outside).toBeLessThan(r.cells);
    }
  });
  it('入库的通用户型地板轮廓：一个格子都不差', () => {
    const plan = JSON.parse(readFileSync(new URL('../../data/plans/generic.json', import.meta.url), 'utf8'));
    expect(brute(plan.floorpts).diff).toBe(0);
  });
});

describe('通用户型（入库的 generic.json，不含个人数据）', () => {
  const plan = JSON.parse(readFileSync(new URL('../../data/plans/generic.json', import.meta.url), 'utf8'));
  const half = 6.5 / 22 / 2; // 缺省墙厚（viewBox px 6.5 / S=22）的一半
  const segs: Barrier[] = plan.walls.map((w: { x1: number; y1: number; x2: number; y2: number; wd?: number }) => ({
    x1: w.x1,
    y1: w.y1,
    x2: w.x2,
    y2: w.y2,
    half: (w.wd != null ? w.wd / 22 : 6.5 / 22) / 2,
  }));
  const grid = buildGrid({ segs, bounds: plan.floorpts })!;
  const floorArea = polyArea(plan.floorpts);
  const rooms = plan.labels.filter((l: { small?: boolean }) => !l.small);

  it('每个房间名所在处都能围出一块房间：不漏、比整套小、标签点在轮廓里', () => {
    expect(half).toBeGreaterThan(0);
    for (const L of rooms) {
      const r = regionAt(grid, L.p[0], L.p[1]);
      expect(r.leaked, L.t).toBe(false);
      expect(r.region, L.t).toBeTruthy();
      expect(r.region!.area, L.t).toBeLessThan(floorArea * 0.9);
      expect(r.region!.area, L.t).toBeGreaterThan(15);
      expect(pointInPolygon(L.p, r.region!.poly), L.t).toBe(true);
    }
  });

  it('有标注尺寸、且被墙围住的房间：识别面积与标注的「宽 × 深」相差 < 12%（开放式空间跳过）', () => {
    let compared = 0;
    for (const L of rooms) {
      if (!L.wd || !L.dp) continue;
      const r = regionAt(grid, L.p[0], L.p[1]);
      // 轮廓里还有别的房间名 = 开放式空间（厨房和客厅连在一起），标注尺寸描述的不是这块区域
      const shared = rooms.some((M: { p: Pt2 }) => M !== L && pointInPolygon(M.p, r.region!.poly));
      if (shared) continue;
      const nominal = L.wd * L.dp;
      expect(
        Math.abs(r.region!.area - nominal) / nominal,
        `${L.t}：识别 ${r.region!.area.toFixed(1)} vs 标注 ${nominal}`
      ).toBeLessThan(0.12);
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(2);
  });
});

describe('精修：轮廓的墙角精确落在墙皮上（不是栅格上）', () => {
  it('矩形房间：四个角 = 墙皮交点（误差 < 1e-9），面积 = 净宽 × 净深（精确）', () => {
    const r = regionAt({ segs: box(0, 0, 12, 10) }, 6, 5).region!;
    const want = [
      [T / 2, T / 2],
      [12 - T / 2, T / 2],
      [12 - T / 2, 10 - T / 2],
      [T / 2, 10 - T / 2],
    ];
    for (const w of want) expect(r.poly.some((p) => Math.hypot(p[0] - w[0], p[1] - w[1]) < 1e-9)).toBe(true);
    expect(r.area).toBeCloseTo((12 - T) * (10 - T), 6);
  });

  it('房屋外轮廓：L 形的 6 个角 = 外墙皮交点（重标定前后中心一致的前提）', () => {
    const pts: Pt2[] = [
      [0, 0],
      [12, 0],
      [12, 6],
      [6, 6],
      [6, 12],
      [0, 12],
    ];
    const segs = pts.map((p, i) => wall(p[0], p[1], pts[(i + 1) % pts.length][0], pts[(i + 1) % pts.length][1]));
    const fp = footprint({ segs })!;
    const h = T / 2;
    const want = [
      [-h, -h],
      [12 + h, -h],
      [12 + h, 6 + h],
      [6 + h, 6 + h],
      [6 + h, 12 + h],
      [-h, 12 + h],
    ];
    for (const w of want)
      expect(
        fp.some((p) => Math.hypot(p[0] - w[0], p[1] - w[1]) < 1e-9),
        JSON.stringify(w)
      ).toBe(true);
    // 整体放大 2 倍（墙厚也 ×2）后外轮廓也正好 ×2：中心不漂
    const fp2 = footprint({
      segs: segs.map((s) => ({ x1: s.x1 * 2, y1: s.y1 * 2, x2: s.x2 * 2, y2: s.y2 * 2, half: s.half * 2 })),
    })!;
    expect(polyArea(fp2) / polyArea(fp)).toBeCloseTo(4, 9);
  });

  it('没有匹配的墙皮线（地板轮廓边以外的斜边）时保留原边，不会把顶点甩到远处', () => {
    const r = regionAt({ segs: [wall(0, 0, 12, 0), wall(12, 0, 0, 12), wall(0, 12, 0, 0)] }, 2, 2).region!;
    for (const p of r.poly) {
      expect(p[0]).toBeGreaterThan(-0.5);
      expect(p[1]).toBeGreaterThan(-0.5);
      expect(p[0] + p[1]).toBeLessThan(12.5);
    }
  });
});

describe('traceLoops：鞍点（两格只在对角相接）按 4 邻接分开', () => {
  it('对角相接的两格 → 两个各 4 个角的环（不会走成一个 8 字）', () => {
    const g = buildGrid({ segs: [wall(0, 0, 1, 0, 0.01)], cell: 1, pad: 3 })!;
    const a = cellAt(g, -2.5, -2.5),
      b = cellAt(g, -1.5, -1.5);
    const m = new Uint8Array(g.w * g.h);
    m[a] = 1;
    m[b] = 1;
    const loops = traceLoops(g, m);
    expect(loops.length).toBe(2);
    for (const l of loops) {
      expect(l.length).toBe(4);
      expect(polyArea(l)).toBeCloseTo(1, 6);
    }
  });
});

describe('斜墙：栅格台阶拉直到墙皮（S27 M04：斜墙房间读出上百面「墙」）', () => {
  // 梯形房间：左墙斜 30° 左右，其余三面正交
  const segs = [wall(0, 0, 12, 0), wall(12, 0, 12, 10), wall(12, 10, 5, 10), wall(5, 10, 0, 0)];
  const r = regionAt({ segs }, 7, 5);
  const p = r.region!.poly;

  it('轮廓 = 4 个角（不是一串台阶）', () => {
    expect(r.leaked).toBe(false);
    expect(p.length).toBe(4);
  });

  it('斜边落在斜墙的墙皮上（顶点离墙皮线 < 1 英寸）', () => {
    // 斜墙轴线 (5,10)→(0,0)；朝房间那侧的墙皮 = 轴线向房间内平移 T/2
    const L = Math.hypot(5, 10),
      ux = -5 / L,
      uy = -10 / L;
    const off = (q: Pt2) => (q[0] - 5) * uy - (q[1] - 10) * ux; // 到轴线的有向距离
    const slant = p.filter((q) => Math.abs(Math.abs(off(q)) - T / 2) < 1 / 12);
    expect(slant.length).toBe(2);
  });

  it('面积 = 四条墙皮线围出的净面积（误差 < 1%）', () => {
    // 独立量：每段墙轴线向房间内平移 T/2，相邻两条求交 = 净角点
    const axes: [Pt2, Pt2][] = [
      [
        [0, 0],
        [12, 0],
      ],
      [
        [12, 0],
        [12, 10],
      ],
      [
        [12, 10],
        [5, 10],
      ],
      [
        [5, 10],
        [0, 0],
      ],
    ];
    const inward = axes.map(([a, b]) => {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]),
        nx = -(b[1] - a[1]) / L,
        ny = (b[0] - a[0]) / L; // 走向 (0,0)→(12,0)→(12,10)→(5,10)：法线 (−dy, dx) 指向房间里
      return { px: a[0] + nx * (T / 2), py: a[1] + ny * (T / 2), ux: (b[0] - a[0]) / L, uy: (b[1] - a[1]) / L };
    });
    const X = (A: (typeof inward)[0], B: (typeof inward)[0]): Pt2 => {
      const den = A.ux * B.uy - A.uy * B.ux,
        t = ((B.px - A.px) * B.uy - (B.py - A.py) * B.ux) / den;
      return [A.px + A.ux * t, A.py + A.uy * t];
    };
    const net = inward.map((_, i) => X(inward[(i + 3) % 4], inward[i]));
    const want = Math.abs(polyArea(net));
    expect(Math.abs(r.region!.area - want) / want).toBeLessThan(0.01);
  });
});

describe('斜边障碍多边形：轮廓沿它的斜边也拉直', () => {
  // 方房间里贴着下墙放一个梯形台面块（斜边约 35°）
  const segs = box(0, 0, 14, 10);
  const blockPoly: Pt2[] = [
    [4, 9.8],
    [10, 9.8],
    [8, 7],
    [6, 7],
  ];
  const r = regionAt({ segs, polys: [blockPoly] }, 7, 3);
  it('轮廓 = 外框 4 角 + 梯形 4 角 = 8 个角', () => {
    expect(r.region!.poly.length).toBe(8);
  });
});
