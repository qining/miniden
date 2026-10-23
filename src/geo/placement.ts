/* =====================================================================
   src/geo/placement.ts — S18：摆家具时的几何判据（纯函数，单位 ft）

   gap 审计 G6 / G7（docs/research/11-home-furnishing-gaps.md）：homeowner 摆家具时问的是
   「贴墙了吗」「离墙还有多远」「是不是插进墙里了」「门还开得开吗」。判据写在这里而不是 app.html 里，
   是因为它们要被 vitest 逐条钉住（docs/design/home-v2.md §S18）：

     · wallFaces：墙体封口多边形 → 两条长边（墙皮）+ 指向室内一侧的单位法线；
     · snapBox：盒子的某条边与某面墙皮平行（夹角 < angTol）、距离 < r、沿墙皮方向有重叠 → 平移到贴齐；
       盒子本地 x 向的边与 y 向的边各至多贴一面（= 推进墙角）；
     · clearances：盒子四条边的中点沿外法线到第一面迎面墙皮的距离（拖动时的距离标注）；
     · doorSweep：平开门扇扫过的扇形（多边形近似）—— 家具占了它 = 门开不开。

   纯度：不碰 DOM / three（R7）。
   ===================================================================== */

export type Pt2 = [number, number];

export interface Face {
  a: Pt2;
  b: Pt2;
  /** 单位法线：从墙体指向墙皮外侧（家具在这一侧） */
  n: Pt2;
  /** 来自第几个多边形（调用方据此认墙） */
  poly: number;
}

export interface Box {
  cx: number;
  cy: number;
  /** 本地 x 向的尺寸（宽） */
  w: number;
  /** 本地 y 向的尺寸（深） */
  d: number;
  /** 度 */
  rot: number;
}

const sub = (a: Pt2, b: Pt2): Pt2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Pt2, b: Pt2) => a[0] * b[0] + a[1] * b[1];
const len = (v: Pt2) => Math.hypot(v[0], v[1]);

/** 墙体封口多边形 → 墙皮。四边形 [a1,b1,b2,a2] 取两条长边（0、2 号边：端头埋在相邻墙里，不是墙皮）；
    其它多边形、或 allEdges（结构柱：四面都是面）取所有 ≥ minLen 的边。 */
export function wallFaces(polys: readonly (readonly Pt2[])[], minLen = 0.5, allEdges = false): Face[] {
  const out: Face[] = [];
  polys.forEach((P, k) => {
    if (!P || P.length < 3) return;
    const c: Pt2 = [P.reduce((s, p) => s + p[0], 0) / P.length, P.reduce((s, p) => s + p[1], 0) / P.length];
    const idx = P.length === 4 && !allEdges ? [0, 2] : P.map((_, i) => i);
    for (const i of idx) {
      const a = P[i] as Pt2,
        b = P[(i + 1) % P.length] as Pt2,
        e = sub(b, a),
        L = len(e);
      if (L < minLen) continue;
      let n: Pt2 = [-e[1] / L, e[0] / L];
      const m: Pt2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (dot(sub(m, c), n) < 0) n = [-n[0], -n[1]]; // 朝外：离开多边形中心
      out.push({ a: [a[0], a[1]], b: [b[0], b[1]], n, poly: k });
    }
  });
  return out;
}

/** 盒子的四条边：外法线 s、边中点 m、沿边方向的单位向量 t 与半长 h、属于本地哪根轴（0 = ±x 边，1 = ±y 边） */
function boxSides(box: Box) {
  const r = (box.rot * Math.PI) / 180,
    ux: Pt2 = [Math.cos(r), Math.sin(r)],
    uy: Pt2 = [-Math.sin(r), Math.cos(r)];
  const c: Pt2 = [box.cx, box.cy];
  const mk = (s: Pt2, half: number, t: Pt2, th: number, axis: 0 | 1) => ({
    s,
    m: [c[0] + s[0] * half, c[1] + s[1] * half] as Pt2,
    t,
    h: th,
    axis,
  });
  return [
    mk(ux, box.w / 2, uy, box.d / 2, 0),
    mk([-ux[0], -ux[1]], box.w / 2, uy, box.d / 2, 0),
    mk(uy, box.d / 2, ux, box.w / 2, 1),
    mk([-uy[0], -uy[1]], box.d / 2, ux, box.w / 2, 1),
  ];
}

/** 一条边（中点 m、方向 t、半长 h）投到墙皮所在直线上，与墙皮本身有没有重叠（留 margin） */
function overlapsAlong(f: Face, m: Pt2, t: Pt2, h: number, margin: number): boolean {
  const e = sub(f.b, f.a),
    L = len(e),
    u: Pt2 = [e[0] / L, e[1] / L];
  const c = dot(sub(m, f.a), u),
    ext = Math.abs(dot(t, u)) * h;
  return c + ext > margin && c - ext < L - margin;
}

export interface Snap {
  dx: number;
  dy: number;
  /** 贴上的墙皮（faces 下标；0–2 个） */
  faces: number[];
}

/** 贴墙吸附。r = 吸附半径（ft，调用方按屏幕像素换算）；angTol = 平行判据（度）。
    已经插进墙里一点（距离为负、绝对值 < r）也拉回到贴齐。 */
export function snapBox(box: Box, faces: readonly Face[], r: number, angTol = 3): Snap {
  const cosT = Math.cos((angTol * Math.PI) / 180);
  let cur: Box = { ...box };
  const used: number[] = [];
  let dx = 0,
    dy = 0;
  for (const axis of [0, 1] as const) {
    let best: { i: number; dist: number; n: Pt2 } | null = null;
    for (const side of boxSides(cur)) {
      if (side.axis !== axis) continue;
      faces.forEach((f, i) => {
        if (dot(side.s, f.n) > -cosT) return; // 这条边不是迎着这面墙皮
        if (!overlapsAlong(f, side.m, side.t, side.h, 0.05)) return;
        // 边上离墙皮最近的那个角（边与墙皮不完全平行时，以它为准）
        const corner = [1, -1]
          .map((k) => [side.m[0] + side.t[0] * side.h * k, side.m[1] + side.t[1] * side.h * k] as Pt2)
          .map((p) => dot(sub(p, f.a), f.n));
        const dist = Math.min(...corner);
        if (Math.abs(dist) >= r) return;
        if (!best || Math.abs(dist) < Math.abs(best.dist)) best = { i, dist, n: f.n };
      });
    }
    if (best) {
      const b = best as { i: number; dist: number; n: Pt2 };
      const mx = -b.dist * b.n[0],
        my = -b.dist * b.n[1];
      dx += mx;
      dy += my;
      cur = { ...cur, cx: cur.cx + mx, cy: cur.cy + my };
      used.push(b.i);
    }
  }
  return { dx, dy, faces: used };
}

export interface Clearance {
  /** 0..3 = +x / −x / +y / −y 边 */
  side: number;
  dist: number;
  from: Pt2;
  to: Pt2;
  face: number;
}

/** 四条边中点沿外法线方向到第一面迎面墙皮的距离（≤ maxDist 才报）；拖动时画距离标注用 */
export function clearances(box: Box, faces: readonly Face[], maxDist: number): Clearance[] {
  const out: Clearance[] = [];
  boxSides(box).forEach((side, k) => {
    let best: Clearance | null = null;
    faces.forEach((f, i) => {
      const den = dot(side.s, f.n);
      if (den > -1e-6) return; // 墙皮背对这条边 / 与射线平行
      const t = dot(sub(f.a, side.m), f.n) / den; // 沿 s 走 t 到达墙皮所在直线
      if (t < -1e-6 || t > maxDist) return;
      const hit: Pt2 = [side.m[0] + side.s[0] * t, side.m[1] + side.s[1] * t];
      const e = sub(f.b, f.a),
        L = len(e),
        q = dot(sub(hit, f.a), e) / L;
      if (q < -1e-6 || q > L + 1e-6) return; // 打在墙皮所在直线上、但不在这段墙皮上
      if (!best || t < best.dist) best = { side: k, dist: Math.max(0, t), from: side.m, to: hit, face: i };
    });
    if (best) out.push(best);
  });
  return out;
}

/** 平开门扇扫过的扇形：铰链 H、关门时门扇指向 T、开向法线 n（单位）、门扇长 L → 多边形（H + 圆弧上 seg+1 个点） */
export function doorSweep(H: Pt2, T: Pt2, n: Pt2, seg = 12): Pt2[] {
  const e = sub(T, H),
    L = len(e);
  if (L < 1e-6) return [];
  const u: Pt2 = [e[0] / L, e[1] / L];
  const out: Pt2[] = [[H[0], H[1]]];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * (Math.PI / 2);
    out.push([
      H[0] + L * (Math.cos(a) * u[0] + Math.sin(a) * n[0]),
      H[1] + L * (Math.cos(a) * u[1] + Math.sin(a) * n[1]),
    ]);
  }
  return out;
}
