/* =====================================================================
   src/schema/primitives.ts — 几何原语（ADR-0002，存储层硬要求）

   规则（docs/decisions/0002-geometric-primitives.md）：
   1. 存储层必须是真原语：seg / arc / polygon——折线近似只允许发生在
      消费端（expand 的粒度参数），不能入库。
   2. 所有消费端统一调用唯一的 expand(geom) → 线段链 函数；每端自带
      粒度（2D 吸附要密、缩略图可以稀）。
   3. 消费端允许跳过 expand 走原生曲线（SVG path A / 3D 圆柱 / 解析弧长）。
   4. 弧的编辑交互 = 三点定弧（arcFrom3Points）。

   坐标系：项目平面 = 图纸平面，单位英尺（ft），y 向下（与 SVG 一致）。
   角度：度数；点(θ) = (cx + r·cosθ, cy + r·sinθ)——y 向下系统里
   θ 增大 = 屏幕上顺时针。θ 模 360 归一。

   本模块是纯函数：禁 import three / document / localStorage（R7 模块图）。
   ===================================================================== */

export type Pt = [number, number];

export interface Seg { t: 'seg'; x1: number; y1: number; x2: number; y2: number }
export interface Arc {
  t: 'arc';
  cx: number; cy: number; r: number;
  a0: number; a1: number;          // 度数；a1−a0 = 360 即整圆
  dir: 1 | -1;                     // +1 = θ 增大方向；−1 = θ 减小方向
}
export interface Poly { t: 'poly'; pts: Pt[] }
export type Geom = Seg | Arc | Poly;

/** 弧上的点：θ 度数 → [x, y]（y 向下坐标）。 */
export function arcPoint(arc: Arc, aDeg: number): Pt {
  const a = aDeg * Math.PI / 180;
  return [arc.cx + arc.r * Math.cos(a), arc.cy + arc.r * Math.sin(a)];
}

/** 有向扫过的角度总量（度数，含 dir 符号；整圆 = ±360）。 */
export function arcSweep(arc: Arc): number {
  let d = arc.a1 - arc.a0;
  if (arc.dir > 0) { if (d <= 0) d += 360; }
  else { if (d >= 0) d -= 360; }
  return d; // 已含 dir 方向符号（dir=+1 → d≥0；dir=-1 → d≤0）
}

export function arcLen(arc: Arc): number {
  return Math.abs(arcSweep(arc)) / 360 * 2 * Math.PI * arc.r;
}

export function segLen(s: Seg): number {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * expand —— 唯一的 geom → 线段链 展开函数（ADR-0002）。
 * 返回连续折线链：相邻段的尾点 = 下一段首点（整圆/闭合多边形首尾相接）。
 *
 * 粒度：opt.chordTol（默认 0.01 ft ≈ 3mm）= 每根弦的矢高上限；
 * opt.segments 可强制固定段数（优先生效）。
 * 退化（零长段、零半径弧）返回单点链或空链，不抛错。
 */
export function expand(geom: Geom, opt: { chordTol?: number; segments?: number } = {}): [Pt, Pt][] {
  const tol = opt.chordTol ?? 0.01;
  if (geom.t === 'seg') {
    if (dist([geom.x1, geom.y1], [geom.x2, geom.y2]) < 1e-9) return [];
    return [[[geom.x1, geom.y1], [geom.x2, geom.y2]]];
  }
  if (geom.t === 'poly') {
    const pts = geom.pts.length >= 2 ? geom.pts : [];
    const out: [Pt, Pt][] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (i + 1 < pts.length && dist(a, b) < 1e-9) continue;
      if (i + 1 === pts.length && pts.length < 3 && dist(a, b) < 1e-9) continue;
      out.push([a, b]);
    }
    return out;
  }
  // arc
  if (geom.r < 1e-9) return [];
  const sweepSigned = arcSweep(geom);
  const sweep = Math.abs(sweepSigned);
  if (sweep < 1e-9) return [[arcPoint(geom, geom.a0), arcPoint(geom, geom.a0)]];
  // 矢高 ≤ tol：δ ≤ 2·acos(1 − tol/r)（tol ≥ r 时一步到位）
  let n: number;
  if (opt.segments != null) {
    n = Math.max(2, Math.round(opt.segments));
  } else {
    const maxStep = tol >= geom.r ? 180 : 2 * Math.acos(1 - tol / geom.r) * 180 / Math.PI;
    n = Math.max(2, Math.ceil(sweep / maxStep));
  }
  const out: [Pt, Pt][] = [];
  let prev = arcPoint(geom, geom.a0);
  for (let i = 1; i <= n; i++) {
    // 从 a0 按 dir 均分 n 步走到 a1（用带符号 sweep：dir=-1 时递减）
    const aa = geom.a0 + (sweepSigned / n) * i;
    const p = arcPoint(geom, aa);
    out.push([prev, p]);
    prev = p;
  }
  return out;
}

/** 多边形面积（鞋带公式；y 向下系统里顺时针多边形为负）。 */
export function polyArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/**
 * 三点定弧（ADR-0002 编辑交互）：p0 → pm → p2（均按路径方向给出）
 * → {arc, dir}。三点共线返回 null（调用方降级为 seg 或折线）。
 */
export function arcFrom3Points(p0: Pt, pm: Pt, p2: Pt): { arc: Arc; dir: 1 | -1 } | null {
  const ax = p0[0], ay = p0[1], bx = pm[0], by = pm[1], cx = p2[0], cy = p2[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;   // 共线
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const ang = (p: Pt) => Math.atan2(p[1] - uy, p[0] - ux) * 180 / Math.PI;
  const a0 = ang(p0), a1 = ang(p2);
  // 方向：p0→pm→p2 的转向（y 向下：叉积 <0 = θ 减小）
  const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const dir: 1 | -1 = cross >= 0 ? 1 : -1;
  // 把 a1 归一到与 a0 同圈（沿 dir 从 a0 到 a1，0 < sweep ≤ 360）
  let sweep: number;
  if (dir > 0) { sweep = a1 - a0; while (sweep <= 0) sweep += 360; }
  else { sweep = a1 - a0; while (sweep >= 0) sweep -= 360; }
  // 中间点校验（保证 pm 在所选方向上）
  const mid = a0 + sweep / 2;
  const pmExp = arcPoint({ t: 'arc', cx: ux, cy: uy, r, a0, a1, dir }, mid);
  if (dist(pmExp, pm) > Math.max(0.02, r * 0.01)) {
    // 中间点落在另一侧 → 取补弧
    const other = dir > 0 ? -360 - sweep : 360 + sweep;
    const mid2 = a0 + other / 2;
    const pmExp2 = arcPoint({ t: 'arc', cx: ux, cy: uy, r, a0, a1, dir: -dir as 1 | -1 }, mid2);
    if (dist(pmExp2, pm) > Math.max(0.02, r * 0.01)) return null;
    return { arc: { t: 'arc', cx: ux, cy: uy, r, a0, a1: a0 + other, dir: (-dir as 1 | -1) }, dir: -dir as 1 | -1 };
  }
  return { arc: { t: 'arc', cx: ux, cy: uy, r, a0, a1: a0 + sweep, dir }, dir };
}

/** 整圆（a1−a0 = 360，dir=1）。 */
export function fullCircle(cx: number, cy: number, r: number): Arc {
  return { t: 'arc', cx, cy, r, a0: 0, a1: 360, dir: 1 };
}
