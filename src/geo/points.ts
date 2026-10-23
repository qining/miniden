/* =====================================================================
   src/geo/points.ts — S15：点位被家具挡住的判据（纯函数，单位 ft）

   用户 2026-10-22：「挡住插座的时候有高亮就够了」。判据写在这里而不是 app.html 里，
   是因为它是一条要被 vitest 逐条钉住的几何口径（docs/design/home-v2.md §S15）：

     · 墙面类（wall / run / fx）：面板正前方 5–25cm、左右各半个面板宽的一排探点；
       某件家具的占地包含任一探点，且它的高度区间与面板 [h − H/2, h + H/2] 相交 → 挡住。
       （低于面板下沿的矮凳不挡；壁挂在面板上方的柜子不挡；地毯 1cm 高，自然不挡墙面插座。）
     · 地面类（floor）：占地盖住点位中心，且家具落地（z0 ≤ 5cm）→ 挡住（地毯也算：盖住送风口一样不出风）。
     · 天花类（ceiling）：永不判。
     · 灯具 / 幽灵件不参与；blocks === false 的类型（上下水 / 燃气 / 排风口——前面站着家电是正确的摆法）不判。

   纯度：不 import three / document（R7）。
   ===================================================================== */

export type Pt2 = [number, number];

export interface PointLike {
  x: number;
  y: number;
  /** 度：面板正面朝向（0 = +x，90 = +y） */
  rot: number;
  /** ft：面板中心离地高 */
  h: number;
  host?: string;
  /** ft：面板宽 / 高（缺省 7 × 11.5cm） */
  plateW?: number;
  plateH?: number;
  /** false = 这一类不算「被挡住」 */
  blocks?: boolean;
}

export interface FurnBox {
  id: string | number;
  /** 占地的四个角（世界坐标 ft，任意绕向） */
  corners: Pt2[];
  /** ft：高度区间（离地到顶） */
  z0: number;
  z1: number;
  rug?: boolean;
  light?: boolean;
  ghost?: boolean;
}

const CM = 1 / 30.48;

/** 中心 (cx, cy)、宽 w（本地 x）、深 d（本地 y）、绕中心转 rotDeg 度的矩形四角 */
export function obbCorners(cx: number, cy: number, w: number, d: number, rotDeg: number): Pt2[] {
  const r = (rotDeg * Math.PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r);
  const hw = w / 2,
    hd = d / 2;
  return (
    [
      [-hw, -hd],
      [hw, -hd],
      [hw, hd],
      [-hw, hd],
    ] as Pt2[]
  ).map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c] as Pt2);
}

/** 点在多边形内（射线法；边上的点按「在内」或「在外」都可能，调用方不依赖边界情形） */
export function pointInPoly(p: Pt2, poly: readonly Pt2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i],
      [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 挡住这个点位的家具 id（顺序 = boxes 的顺序；没有 = 空数组） */
export function pointBlockers(p: PointLike, boxes: readonly FurnBox[]): Array<string | number> {
  if (p.blocks === false || p.host === 'ceiling') return [];
  const out: Array<string | number> = [];
  const cands = boxes.filter((b) => !b.light && !b.ghost);
  if (p.host === 'floor') {
    for (const b of cands) if (b.z0 <= 5 * CM && pointInPoly([p.x, p.y], b.corners)) out.push(b.id);
    return out;
  }
  const W = p.plateW ?? 7 * CM,
    H = p.plateH ?? 11.5 * CM;
  const r = (p.rot * Math.PI) / 180,
    n: Pt2 = [Math.cos(r), Math.sin(r)],
    u: Pt2 = [-n[1], n[0]];
  const probes: Pt2[] = [];
  for (const d of [5, 10, 15, 20, 25])
    for (const a of [-W / 2, 0, W / 2]) probes.push([p.x + n[0] * d * CM + u[0] * a, p.y + n[1] * d * CM + u[1] * a]);
  const lo = p.h - H / 2,
    hi = p.h + H / 2;
  for (const b of cands) {
    if (b.z1 < lo || b.z0 > hi) continue;
    if (probes.some((q) => pointInPoly(q, b.corners))) out.push(b.id);
  }
  return out;
}
