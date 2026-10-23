/* =====================================================================
   src/geo/stairs.ts — S17：楼梯几何（纯函数，单位 ft）

   用户 2026-10-22：「对于 house 来说，多层以及楼梯，这个需求也非常要命」。
   轻量口径（ADR-0006）：楼梯回答的是「占多大地方、从哪上、上到哪」，不回答施工问题
   （踏步前缘突出量、规范校核）。所以模型是：

     · 中心线 path 2–4 个点：2 点 = 直跑，3 点 = L 形（一个转角平台），4 点 = U 形 / 双折（两个平台）；
     · 每个转角是边长 = 楼梯宽 w 的方形平台（以转角点为中心，沿来向摆正）；
     · 平台之间是梯段；踏步数 = 层间高差 / 17.5cm 取整（2–40），按梯段长度分给各段；
     · U 形中间那段可以短到 0（两段梯段并排 = 「双跑楼梯」，两个平台连成一个 2w × w 的休息平台）：
       短于一级踏步的中间段不分踏步，当平台走；
     · 第 k 级踏步顶面高 = k × 踢面高；最后一级顶面 = 层间高差（与上层地面齐平）；
     · 外轮廓 outline = 梯段 + 平台的并集（一个简单多边形）= 上层楼板要开的洞、2D 的命中 / 选中范围。
       编辑器把拐角约束成 90°，此时「斜接加宽的中心线」与「梯段 + 方形平台」逐点重合。

   纯度：不碰 DOM / three（R7）。
   ===================================================================== */

export type Pt2 = [number, number];

export const RISER_TARGET = 17.5 / 30.48; // ft：目标踢面高
export const MIN_STEPS = 2;
export const MAX_STEPS = 40;
/** ft：短于它的梯段放不下一级踏步（起步 / 收尾那段必须够；中间那段不够就当平台） */
export const MIN_FLIGHT = 0.3;
/** ft：U 形中间那段比梯宽短不到这么多 = 取整误差（端点各自取到 0.01ft、梯宽也取整），当正好一个梯宽（两段并排） */
export const FLAT_TOL = 0.03;

export interface StairStep {
  /** 踏面四角（世界坐标 ft） */
  poly: Pt2[];
  /** ft：踏面顶高（相对楼梯所在楼层的地面） */
  top: number;
}

export interface StairLayout {
  steps: StairStep[];
  /** 转角平台（四角 + 顶高）；U 形中间不分踏步的那段也在这里（与相邻平台同高） */
  landings: Array<{ poly: Pt2[]; top: number }>;
  /** 占地分块（梯段 + 平台），每块一个四边形 */
  footprint: Pt2[][];
  /** 外轮廓：占地分块的并集（简单多边形）—— 上层楼板开洞 / 2D 命中与选中 */
  outline: Pt2[];
  /** 方向箭头（沿中心线，起点 → 终点） */
  arrow: Pt2[];
  riser: number;
  /** 梯段总长（不含平台）/ 踏步数 */
  tread: number;
  stepsN: number;
  rise: number;
}

export function stepCount(rise: number, steps?: number): number {
  if (steps && Number.isInteger(steps)) return Math.max(MIN_STEPS, Math.min(MAX_STEPS, steps));
  return Math.max(MIN_STEPS, Math.min(MAX_STEPS, Math.round(rise / RISER_TARGET)));
}

const sub = (a: Pt2, b: Pt2): Pt2 => [a[0] - b[0], a[1] - b[1]];
const len = (v: Pt2) => Math.hypot(v[0], v[1]);

/** 沿方向 u（单位向量）、宽 w 的矩形：从 a 到 b（a、b 在中心线上） */
function rectAlong(a: Pt2, b: Pt2, w: number): Pt2[] {
  const d = sub(b, a),
    L = len(d) || 1e-12;
  const u: Pt2 = [d[0] / L, d[1] / L],
    n: Pt2 = [-u[1] * (w / 2), u[0] * (w / 2)];
  return [
    [a[0] + n[0], a[1] + n[1]],
    [b[0] + n[0], b[1] + n[1]],
    [b[0] - n[0], b[1] - n[1]],
    [a[0] - n[0], a[1] - n[1]],
  ];
}

/** 去掉重合点、共线点与 180° 折返的尖刺（双跑楼梯两段梯段并排时，两侧轮廓在中缝处会折返） */
export function cleanRing(poly: readonly Pt2[], eps = 1e-6): Pt2[] {
  let P = poly.map((p) => [p[0], p[1]] as Pt2);
  for (let changed = true; changed && P.length >= 3;) {
    changed = false;
    for (let i = 0; i < P.length && P.length >= 3; i++) {
      const a = P[(i - 1 + P.length) % P.length],
        b = P[i],
        c = P[(i + 1) % P.length];
      const ab = sub(b, a),
        bc = sub(c, b);
      if (len(ab) < eps || Math.abs(ab[0] * bc[1] - ab[1] * bc[0]) < eps * Math.max(1, len(ab) + len(bc))) {
        P.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  if (P.length < 3) P = [];
  return P;
}

/** 斜接加宽的中心线：左侧偏移链 + 右侧偏移链反向。拐角 90° 时斜接点正好是方形平台的外角 / 内角。 */
function miterOutline(P: readonly Pt2[], w: number): Pt2[] | null {
  const h = w / 2,
    N: Pt2[] = [];
  for (let i = 0; i < P.length - 1; i++) {
    const d = sub(P[i + 1], P[i]),
      L = len(d);
    N.push([-d[1] / L, d[0] / L]);
  }
  const left: Pt2[] = [],
    right: Pt2[] = [];
  const at = (p: Pt2, m: Pt2, s: number): Pt2 => [p[0] + m[0] * h * s, p[1] + m[1] * h * s];
  left.push(at(P[0], N[0], 1));
  right.push(at(P[0], N[0], -1));
  for (let i = 1; i < P.length - 1; i++) {
    const n1 = N[i - 1],
      n2 = N[i],
      c = 1 + n1[0] * n2[0] + n1[1] * n2[1];
    if (c < 0.15) return null; // 折回去的急弯（> ~148°）：斜接点飞出去，不是一部楼梯
    const m: Pt2 = [(n1[0] + n2[0]) / c, (n1[1] + n2[1]) / c];
    left.push(at(P[i], m, 1));
    right.push(at(P[i], m, -1));
  }
  const nl = N[N.length - 1];
  left.push(at(P[P.length - 1], nl, 1));
  right.push(at(P[P.length - 1], nl, -1));
  // 端点各自取整到 0.01ft，拐角不是严格的 90° → 两段并排的梯段之间会留下几毫米的碎缝 / 尖刺：按 0.02ft 的容差清掉
  const ring = cleanRing(left.concat(right.reverse()), 0.02);
  return ring.length >= 3 ? ring : null;
}

/** 把中间那段从 i 号点往后整体平移 by（沿第 i 段方向），后面各段的长度与方向不变 */
function shiftFrom(P: Pt2[], i: number, by: number): void {
  const d = sub(P[i + 1], P[i]),
    L = len(d);
  if (L < 1e-9) return;
  const v: Pt2 = [(d[0] / L) * by, (d[1] / L) * by];
  for (let k = i + 1; k < P.length; k++) P[k] = [P[k][0] + v[0], P[k][1] + v[1]];
}

/** 双跑楼梯：4 个点、中间那段正好（± FLAT_TOL）一个梯宽 */
export function isDogLeg(path: readonly Pt2[], w: number): boolean {
  return !!path && path.length === 4 && Math.abs(len(sub(path[2] as Pt2, path[1] as Pt2)) - w) <= FLAT_TOL;
}

/** 让一条中心线放得下宽 w 的楼梯：太短的段沿自己的方向加长（后面的点整体平移）——起步 / 收尾那段至少一级踏步、
    U 形中间那段至少一个梯宽；dogLeg = 把中间那段定成正好一个梯宽（双跑楼梯改梯宽 / 整图缩放后还是双跑）。
    有重合点（方向未知）→ null。拐角是不是直角不管（编辑器已经取了直角）。 */
export function fitStairPath(path: readonly Pt2[], w: number, dogLeg = false): Pt2[] | null {
  if (!path || path.length < 2 || !(w > 0)) return null;
  const P = path.map((p) => [p[0], p[1]] as Pt2);
  const nSeg = P.length - 1;
  for (let i = 0; i < nSeg; i++) {
    const L = len(sub(P[i + 1], P[i]));
    if (L < 1e-6) return null;
    const cuts = (i > 0 ? w / 2 : 0) + (i < nSeg - 1 ? w / 2 : 0);
    const first = i === 0,
      last = i === nSeg - 1;
    if (!first && !last) {
      if (dogLeg && nSeg === 3) shiftFrom(P, i, w - L);
      else if (L < cuts) shiftFrom(P, i, cuts - L);
    } else if (L - cuts < MIN_FLIGHT) shiftFrom(P, i, MIN_FLIGHT + cuts - L);
  }
  return P;
}

export function stairLayout(path: readonly Pt2[], w: number, rise: number, steps?: number): StairLayout | null {
  if (!path || path.length < 2 || !(w > 0) || !(rise > 0)) return null;
  const P = path.map((p) => [p[0], p[1]] as Pt2);
  const nSeg = P.length - 1;
  // 中间那段与梯宽差不到 FLAT_TOL（取整误差，长短都有可能）→ 按正好一个梯宽算：后面的点整体挪齐 ——
  // 短了外轮廓留一道细缝、长了多出一条不到 1cm 的「梯井」和一块碎平台
  for (let i = 1; i < nSeg - 1; i++) {
    const gap = len(sub(P[i + 1], P[i])) - w;
    if (gap !== 0 && Math.abs(gap) <= FLAT_TOL) shiftFrom(P, i, -gap);
  }
  // 每段梯段的起止：转角处让出半个平台（w/2）
  const flights: Array<{ a: Pt2; b: Pt2; L: number; flat: boolean }> = [];
  for (let i = 0; i < nSeg; i++) {
    const a = P[i],
      b = P[i + 1],
      d = sub(b, a),
      L = len(d);
    if (L < 1e-6) return null;
    const u: Pt2 = [d[0] / L, d[1] / L];
    const cutA = i > 0 ? w / 2 : 0,
      cutB = i < nSeg - 1 ? w / 2 : 0,
      fl = L - cutA - cutB;
    if (fl < -1e-6) return null; // 两个拐角平台互相压住（U 形中间那段比梯宽还短 = 两段梯段重叠；取整误差上面已挪齐）
    const flat = fl < MIN_FLIGHT;
    if (flat && (i === 0 || i === nSeg - 1)) return null; // 起步 / 收尾那段放不下一级踏步
    flights.push({
      a: [a[0] + u[0] * cutA, a[1] + u[1] * cutA],
      b: [b[0] - u[0] * cutB, b[1] - u[1] * cutB],
      L: Math.max(0, fl),
      flat,
    });
  }
  const outline = miterOutline(P, w);
  if (!outline) return null;
  const run = flights.filter((f) => !f.flat);
  const total = run.reduce((s, f) => s + f.L, 0);
  const N = stepCount(rise, steps);
  const riser = rise / N;
  // 各段分到的踏步数（按长度，最大余数法保证总和 = N；有长度的梯段至少 1 级，当平台走的中间段 0 级）
  const raw = flights.map((f) => (f.flat ? 0 : (f.L / total) * N));
  const per = raw.map((r, i) => (flights[i].flat ? 0 : Math.max(1, Math.floor(r))));
  let left = N - per.reduce((s, v) => s + v, 0);
  const order = raw
    .map((r, i) => [r - Math.floor(r), i])
    .filter(([, i]) => !flights[i].flat)
    .sort((x, y) => y[0] - x[0]);
  for (let k = 0; left > 0 && k < order.length * 4; k++, left--) per[order[k % order.length][1]]++;
  while (left < 0) {
    const i = per.indexOf(Math.max(...per));
    per[i]--;
    left++;
  }
  const out: StairStep[] = [];
  const landings: Array<{ poly: Pt2[]; top: number }> = [];
  const footprint: Pt2[][] = [];
  let k = 0;
  flights.forEach((f, i) => {
    const n = per[i];
    const d = sub(f.b, f.a),
      u: Pt2 =
        f.L > 1e-9
          ? [d[0] / f.L, d[1] / f.L]
          : (() => {
              const s = sub(P[i + 1], P[i]),
                l = len(s);
              return [s[0] / l, s[1] / l] as Pt2;
            })();
    for (let j = 0; j < n; j++) {
      const a: Pt2 = [f.a[0] + (u[0] * f.L * j) / n, f.a[1] + (u[1] * f.L * j) / n];
      const b: Pt2 = [f.a[0] + (u[0] * f.L * (j + 1)) / n, f.a[1] + (u[1] * f.L * (j + 1)) / n];
      k++;
      out.push({ poly: rectAlong(a, b, w), top: k * riser });
    }
    if (f.L > 1e-6) {
      const piece = rectAlong(f.a, f.b, w);
      footprint.push(piece);
      if (n === 0) landings.push({ poly: piece, top: k * riser }); // 不分踏步的中间段 = 平台的一部分
    }
    if (i < nSeg - 1) {
      // 转角平台：以转角点为中心、沿来向摆正的 w × w 方块；高度 = 已经走完的踏步顶
      const c = P[i + 1];
      const half: Pt2 = [u[0] * (w / 2), u[1] * (w / 2)];
      const sq = rectAlong([c[0] - half[0], c[1] - half[1]], [c[0] + half[0], c[1] + half[1]], w);
      landings.push({ poly: sq, top: k * riser });
      footprint.push(sq);
    }
  });
  return { steps: out, landings, footprint, outline, arrow: P, riser, tread: total / N, stepsN: N, rise };
}
