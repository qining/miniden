/* S17：楼梯几何（纯函数，单位 ft）。断言用独立量：踢面高 × 踏步数 = 层间高差；占地面积 = 梯段长 × 宽 + 平台 w²；
   外轮廓按手算的角点比对（拐角 90° 时 = 梯段 + 方形平台的并集）。 */
import { describe, it, expect } from 'vitest';
import {
  stairLayout,
  stepCount,
  cleanRing,
  fitStairPath,
  isDogLeg,
  RISER_TARGET,
  MIN_FLIGHT,
  FLAT_TOL,
  type Pt2,
} from '../../src/geo/stairs';

/** 多边形的角点集合（顺序 / 起点无关）：保留 3 位小数比对 */
const cornerSet = (p: Pt2[]) => p.map((q) => q.map((v) => (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3)).join(',')).sort();

const area = (p: Pt2[]) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) a += p[i][0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * p[i][1];
  return Math.abs(a / 2);
};

describe('踏步数', () => {
  it('按 17.5cm 的目标踢面高取整，夹在 2–40；给了 steps 就用它', () => {
    expect(stepCount(9.8)).toBe(Math.round(9.8 / RISER_TARGET));
    expect(stepCount(0.1)).toBe(2);
    expect(stepCount(100)).toBe(40);
    expect(stepCount(9.8, 14)).toBe(14);
    expect(stepCount(9.8, 99)).toBe(40);
  });
});

describe('直跑楼梯', () => {
  const L = stairLayout(
    [
      [0, 0],
      [0, 14],
    ],
    3,
    9.8
  )!;
  it('最后一级顶面 = 层间高差（与上层地面齐平），每级踢面相等', () => {
    expect(L.steps.length).toBe(L.stepsN);
    expect(L.steps[L.steps.length - 1].top).toBeCloseTo(9.8, 9);
    expect(L.riser * L.stepsN).toBeCloseTo(9.8, 9);
    for (let i = 1; i < L.steps.length; i++) expect(L.steps[i].top - L.steps[i - 1].top).toBeCloseTo(L.riser, 9);
  });
  it('踏面：宽 3ft、沿梯段均分；占地 = 14 × 3', () => {
    expect(L.tread).toBeCloseTo(14 / L.stepsN, 9);
    expect(area(L.steps[0].poly)).toBeCloseTo(3 * L.tread, 9);
    expect(L.footprint.length).toBe(1);
    expect(area(L.footprint[0])).toBeCloseTo(42, 9);
    expect(L.landings.length).toBe(0);
  });
});

describe('L 形 / U 形', () => {
  it('L 形：一个 w×w 平台在转角；两段梯段让出半个平台；踏步总数守恒', () => {
    const w = 3;
    const L = stairLayout(
      [
        [0, 0],
        [0, 8],
        [6, 8],
      ],
      w,
      9.8
    )!;
    expect(L.landings.length).toBe(1);
    expect(area(L.landings[0].poly)).toBeCloseTo(w * w, 9);
    const flightLen = 8 - w / 2 + (6 - w / 2);
    const fp = L.footprint.reduce((s, p) => s + area(p), 0);
    expect(fp).toBeCloseTo(flightLen * w + w * w, 6);
    expect(L.steps.length).toBe(L.stepsN);
    expect(L.steps[L.steps.length - 1].top).toBeCloseTo(9.8, 9);
    // 平台高度 = 第一段走完时的踏步顶
    expect(L.landings[0].top).toBeGreaterThan(0);
    expect(L.landings[0].top).toBeLessThan(9.8);
    // 外轮廓 = 梯段 + 平台的并集：手算的 6 个角（不是凸包 —— 凸包会把两段梯段之间那块三角也挖掉）
    expect(cornerSet(L.outline)).toEqual(
      cornerSet([
        [-1.5, 0],
        [-1.5, 9.5],
        [6, 9.5],
        [6, 6.5],
        [1.5, 6.5],
        [1.5, 0],
      ])
    );
    expect(area(L.outline)).toBeCloseTo(fp, 6);
  });

  it('双跑（U 形中间那段 = 梯宽）：两段梯段并排、中间不分踏步，两个平台拼成 2w × w；外轮廓是一个矩形', () => {
    const w = 3;
    const L = stairLayout(
      [
        [0, 0],
        [0, 10],
        [w, 10],
        [w, 0],
      ],
      w,
      9.8
    )!;
    expect(L).not.toBeNull();
    expect(L.steps.length).toBe(L.stepsN);
    expect(L.landings.length).toBe(2);
    expect(L.landings[0].top).toBeCloseTo(L.landings[1].top, 9); // 同一个休息平台
    expect(L.steps[L.steps.length - 1].top).toBeCloseTo(9.8, 9);
    expect(cornerSet(L.outline)).toEqual(
      cornerSet([
        [-1.5, 0],
        [-1.5, 11.5],
        [4.5, 11.5],
        [4.5, 0],
      ])
    );
    // 两段梯段长度相同 → 踏步对半分（奇数时差 1）
    const firstRun = L.steps.filter((s) => s.poly.every((p) => p[0] < 1.5 + 1e-9)).length;
    expect(Math.abs(L.stepsN - 2 * firstRun)).toBeLessThanOrEqual(1);
  });

  it('U 形中间那段比梯宽还短（两段梯段会重叠）→ null', () => {
    expect(
      stairLayout(
        [
          [0, 0],
          [0, 10],
          [2, 10],
          [2, 0],
        ],
        3,
        9.8
      )
    ).toBeNull();
  });

  it('U 形（4 点）：两个平台；每段至少分到 1 级', () => {
    const L = stairLayout(
      [
        [0, 0],
        [0, 7],
        [3.5, 7],
        [3.5, 0],
      ],
      3,
      9.8
    )!;
    expect(L.landings.length).toBe(2);
    expect(L.footprint.length).toBe(5);
    expect(L.steps.length).toBe(L.stepsN);
    // 中间那段 3.5 − 3 = 0.5ft ≥ 一级踏步：照样分踏步；外轮廓是 U（梯井那一条是凹口，不是洞）
    expect(L.outline.length).toBe(8);
    expect(area(L.outline)).toBeCloseTo(
      L.footprint.reduce((t, p) => t + area(p), 0),
      6
    );
  });
});

describe('外轮廓清理', () => {
  it('重合点、共线点、180° 折返的尖刺都去掉', () => {
    const r = cleanRing([
      [0, 0],
      [0, 0],
      [2, 0],
      [4, 0],
      [4, 3],
      [2, 3],
      [2, 5],
      [2, 3],
      [0, 3],
    ]);
    expect(cornerSet(r)).toEqual(
      cornerSet([
        [0, 0],
        [4, 0],
        [4, 3],
        [0, 3],
      ])
    );
    expect(
      cleanRing([
        [0, 0],
        [1, 0],
        [2, 0],
      ])
    ).toEqual([]);
  });

  it('折回去的急弯（> ~148°）不是一部楼梯 → null', () => {
    expect(
      stairLayout(
        [
          [0, 0],
          [0, 10],
          [0.6, 0],
        ],
        3,
        9.8
      )
    ).toBeNull();
  });
});

describe('放不下 / 非法输入 → null', () => {
  it('转角太近（梯段 < 0.3ft）、重合点、宽或高差非正、点不够', () => {
    expect(
      stairLayout(
        [
          [0, 0],
          [0, 1.6],
          [5, 1.6],
        ],
        3,
        9.8
      )
    ).toBeNull();
    expect(
      stairLayout(
        [
          [0, 0],
          [0, 0],
        ],
        3,
        9.8
      )
    ).toBeNull();
    expect(
      stairLayout(
        [
          [0, 0],
          [0, 10],
        ],
        0,
        9.8
      )
    ).toBeNull();
    expect(
      stairLayout(
        [
          [0, 0],
          [0, 10],
        ],
        3,
        0
      )
    ).toBeNull();
    expect(stairLayout([[0, 0]] as Pt2[], 3, 9.8)).toBeNull();
  });
});

describe('取整误差与整图缩放：双跑楼梯不许「放不下」', () => {
  const w = 91 / 30.48; // 审查实测：91cm 梯宽、第一段不是横平竖直时，端点 / 梯宽各自取到 0.01ft，中段比梯宽短 0.003–0.01ft
  const dog = (mid: number): Pt2[] => [
    [0, 0],
    [0, 10],
    [mid, 10],
    [mid, 0],
  ];
  it('中段比梯宽短不到 FLAT_TOL → 当正好贴着：照样是一部楼梯，外轮廓仍是一个干净的矩形', () => {
    const L = stairLayout(dog(w - 0.008), w, 9.8)!;
    expect(L).not.toBeNull();
    expect(L.outline.length).toBe(4);
    expect(L.steps[L.steps.length - 1].top).toBeCloseTo(9.8, 9);
  });
  it('端点取整后拐角差一点点 90°（编辑器里第一段斜着画就会这样）：外轮廓 = 梯段 + 平台的并集，没有碎缝', () => {
    const P: Pt2[] = [
      [15, 3],
      [16.5, 12],
      [13.55, 12.49],
      [12.24, 4.6],
    ]; // 探针实测的一组：中段 2.99042、末段不严格平行于首段、而且比首段短（外轮廓左下缺一角 = 6 个角）
    const L = stairLayout(P, 2.99, 9.8)!;
    expect(L).not.toBeNull();
    expect(L.landings.length).toBe(2);
    expect(L.outline.length).toBe(6);
    const pieces = L.footprint.reduce((t, q) => t + area(q), 0);
    expect(Math.abs(area(L.outline) - pieces)).toBeLessThan(0.05);
  });
  it('长出不到 FLAT_TOL 同样按正好一个梯宽算：不多出一条梯井和一块碎平台', () => {
    const L = stairLayout(dog(w + 0.006), w, 9.8)!;
    expect(L.outline.length).toBe(4);
    expect(L.landings.length).toBe(2);
  });
  it('短得超过 FLAT_TOL（两段梯段真的重叠）→ 仍然拒', () => {
    expect(stairLayout(dog(w - FLAT_TOL - 0.01), w, 9.8)).toBeNull();
  });
  it('isDogLeg：4 个点且中段 = 梯宽（± FLAT_TOL）', () => {
    expect(isDogLeg(dog(w), w)).toBe(true);
    expect(isDogLeg(dog(w + 0.5), w)).toBe(false);
    expect(isDogLeg(dog(w).slice(0, 3), w)).toBe(false);
  });
  it('整图 ×0.9：中段 = 0.9w < w → fitStairPath(dogLeg) 把中段定回一个梯宽，楼梯照样有效', () => {
    const scaled = dog(w).map((p) => [p[0] * 0.9, p[1] * 0.9] as Pt2);
    expect(stairLayout(scaled, w, 9.8)).toBeNull(); // 不修就消失
    const fit = fitStairPath(scaled, w, true)!;
    expect(Math.hypot(fit[2][0] - fit[1][0], fit[2][1] - fit[1][1])).toBeCloseTo(w, 9);
    expect(fit[1]).toEqual(scaled[1]); // 第一段不动
    const L = stairLayout(fit, w, 9.8)!;
    expect(L).not.toBeNull();
    expect(L.outline.length).toBe(4);
  });
  it('改宽：双跑楼梯中段跟着梯宽走（收窄也收拢，不留出一道梯井）', () => {
    const wide = 120 / 30.48;
    const fit = fitStairPath(dog(w), wide, true)!;
    expect(Math.hypot(fit[2][0] - fit[1][0], fit[2][1] - fit[1][1])).toBeCloseTo(wide, 9);
    const narrow = fitStairPath(dog(w), 80 / 30.48, true)!;
    expect(Math.hypot(narrow[2][0] - narrow[1][0], narrow[2][1] - narrow[1][1])).toBeCloseTo(80 / 30.48, 9);
  });
  it('L 形收尾那段太短 → 加长到「半个平台 + 一级踏步」；直跑太短 → 加长到一级踏步；有重合点 → null', () => {
    const L0: Pt2[] = [
      [0, 0],
      [0, 8],
      [1.2, 8],
    ];
    expect(stairLayout(L0, 3, 9.8)).toBeNull();
    const f = fitStairPath(L0, 3)!;
    expect(Math.hypot(f[2][0] - f[1][0], f[2][1] - f[1][1])).toBeCloseTo(1.5 + MIN_FLIGHT, 9);
    expect(stairLayout(f, 3, 9.8)).not.toBeNull();
    const s = fitStairPath(
      [
        [0, 0],
        [0, 0.1],
      ],
      3
    )!;
    expect(Math.hypot(s[1][0], s[1][1])).toBeCloseTo(MIN_FLIGHT, 9);
    expect(
      fitStairPath(
        [
          [1, 1],
          [1, 1],
        ],
        3
      )
    ).toBeNull();
    expect(fitStairPath([], 3)).toBeNull();
  });
});
