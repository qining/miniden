/* =====================================================================
   src/geo/regions.ts — S16：点一下房间 → 这个房间的轮廓（纯函数，单位 ft）

   用户 2026-10-22：「地板的品类，样式，也是要命的需求」。给房间换地板之前先得知道「房间」是哪一块：
   内置户型只有房间名常量，自己画的户型连房间名都没有。这里不要求用户画房间多边形 ——
   墙 / 窗 / 门洞 / 开口本来就把房间围出来了：

     1. 栅格化（缺省 1 英寸一格）：格心落在墙体里（距墙轴 ≤ 半厚）= 障碍；柱子多边形里 = 障碍；
        给了地板轮廓时轮廓外 = 障碍。障碍最细也按 0.75 格算，保证 4 邻接的泛洪漏不过去。
     2. 从点击点 4 邻接泛洪；碰到栅格边缘 = 这块没被围住（墙有缺口）→ 如实报 leaked，不猜。
     3. 追踪泛洪区域的边界（区域在左手边的有向格边 → 首尾相接成环；鞍点优先左转 = 只认 4 邻接）
        → 取面积最大的那个环 = 外轮廓 → RDP 简化掉栅格台阶。
     4. 面积 = 区域格数 × 格面积（柱子占的格不算 —— 地板用量就该扣掉柱子）。
     5. 标注点 = 区域里离边界最远的格心（多源 BFS 距离变换），L 形房间的名字不会落在墙上。
     6. 房屋外轮廓 = 从栅格边缘泛洪出「室外」，其余部分的外环（修 G16：自己画的 L 形房子，
        地板不再是墙体包围盒那块矩形）。墙没围合时返回 null，调用方退回原来的包围盒。

   纯度：不 import three / document（R7）。
   ===================================================================== */

export type Pt2 = [number, number];

export interface Barrier {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** ft：半厚 */
  half: number;
}

export interface RegionInput {
  segs: Barrier[];
  /** 实心障碍（柱子 / 结构块） */
  polys?: Pt2[][];
  /** 地板轮廓：给了就把轮廓外当障碍 */
  bounds?: Pt2[] | null;
  /** ft：格边长，缺省 1/12（1 英寸） */
  cell?: number;
  /** ft：包围盒外留白，缺省 2 */
  pad?: number;
  /** 栅格格数上限（太大的户型自动放粗格子），缺省 4,000,000 */
  maxCells?: number;
}

export interface Grid {
  x0: number;
  y0: number;
  cell: number;
  w: number;
  h: number;
  /** 1 = 障碍 */
  block: Uint8Array;
  /** 墙皮线 / 地板轮廓边（精修轮廓用：栅格追踪出的边换成它真正贴着的那条线，消掉量化误差） */
  lines?: FaceLine[];
}

export interface FaceLine {
  px: number;
  py: number;
  ux: number;
  uy: number;
}

/** 每段墙的两面墙皮（轴线按半厚平移）+ 地板轮廓的每条边 */
export function faceLines(segs: readonly Barrier[], bounds?: readonly Pt2[] | null): FaceLine[] {
  const out: FaceLine[] = [];
  for (const s of segs) {
    const dx = s.x2 - s.x1,
      dy = s.y2 - s.y1,
      L = Math.hypot(dx, dy);
    if (L < 1e-6) continue;
    const ux = dx / L,
      uy = dy / L,
      nx = -uy,
      ny = ux;
    for (const sg of [1, -1]) out.push({ px: s.x1 + nx * s.half * sg, py: s.y1 + ny * s.half * sg, ux, uy });
  }
  if (bounds && bounds.length >= 3)
    for (let i = 0; i < bounds.length; i++) {
      const a = bounds[i],
        b = bounds[(i + 1) % bounds.length],
        L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L > 1e-6) out.push({ px: a[0], py: a[1], ux: (b[0] - a[0]) / L, uy: (b[1] - a[1]) / L });
    }
  return out;
}

/* 栅格追踪出来的轮廓精修：每条边找方向平行（< 4°）、距离 < tol 的墙皮线，换成那条线；
   顶点 = 相邻两条线的交点。墙角于是精确落在墙皮上 —— 不精修的话轮廓有半格的量化误差，
   重标定前后各算一次「中心」会差出零点几英尺（实测 0.09ft），面积也偏小。 */
export function refineToFaces(poly: readonly Pt2[], lines: readonly FaceLine[], tol: number): Pt2[] {
  const n = poly.length;
  if (n < 3 || !lines.length) return poly.slice();
  const sin4 = Math.sin((4 * Math.PI) / 180);
  const L: FaceLine[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i],
      b = poly[(i + 1) % n],
      len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-12;
    const ux = (b[0] - a[0]) / len,
      uy = (b[1] - a[1]) / len,
      mx = (a[0] + b[0]) / 2,
      my = (a[1] + b[1]) / 2;
    let best: FaceLine | null = null,
      bd = tol;
    for (const ln of lines) {
      if (Math.abs(ux * ln.uy - uy * ln.ux) > sin4) continue;
      const d = Math.abs(ln.ux * (my - ln.py) - ln.uy * (mx - ln.px));
      if (d < bd) ((bd = d), (best = ln));
    }
    L.push(best || { px: a[0], py: a[1], ux, uy });
  }
  const out: Pt2[] = [];
  for (let i = 0; i < n; i++) {
    const A = L[(i + n - 1) % n],
      B = L[i];
    const den = A.ux * B.uy - A.uy * B.ux;
    if (Math.abs(den) < 1e-6) {
      out.push(poly[i]);
      continue;
    }
    const t = ((B.px - A.px) * B.uy - (B.py - A.py) * B.ux) / den;
    const q: Pt2 = [A.px + A.ux * t, A.py + A.uy * t];
    out.push(Math.hypot(q[0] - poly[i][0], q[1] - poly[i][1]) > tol * 3 ? poly[i] : q);
  }
  return out;
}

/* S27 M04：斜墙的栅格台阶拉直。RDP 的容差只有 0.75 格，斜墙上的台阶（每级 1 格）在角度不是 45° 时偏差会超过它，
   于是留下一串短边；这些短边的方向和斜墙差得远，refineToFaces 的「平行 < 4°」也接不住 —— 一面斜墙读成几十面「墙」。
   这里先把「连续若干顶点都离同一条墙皮线 < tol、且沿线单调前进」的一段收成首尾两点，留下的那条边与墙皮平行，
   再交给 refineToFaces 精修到墙皮上。单调这一条防的是绕过细墙端头又折回来的那种 U 形（两侧墙皮可能都在容差里）。 */
export function straightenRuns(poly: readonly Pt2[], lines: readonly FaceLine[], tol: number): Pt2[] {
  let pts = poly.slice();
  if (pts.length < 4 || !lines.length) return pts;
  const near = (q: Pt2, ln: FaceLine) => Math.abs(ln.ux * (q[1] - ln.py) - ln.uy * (q[0] - ln.px)) < tol;
  const along = (q: Pt2, ln: FaceLine) => (q[0] - ln.px) * ln.ux + (q[1] - ln.py) * ln.uy;
  const pass = (arr: Pt2[]): Pt2[] => {
    const out: Pt2[] = [];
    let i = 0;
    while (i < arr.length) {
      let bestJ = i;
      for (const ln of lines) {
        if (!near(arr[i], ln)) continue;
        let j = i,
          dir = 0;
        while (j + 1 < arr.length && near(arr[j + 1], ln)) {
          const d = along(arr[j + 1], ln) - along(arr[j], ln);
          if (Math.abs(d) > 1e-9) {
            const sg = Math.sign(d);
            if (dir && sg !== dir) break;
            dir = sg;
          }
          j++;
        }
        if (j > bestJ) bestJ = j;
      }
      out.push(arr[i]);
      if (bestJ > i + 1) {
        out.push(arr[bestJ]);
        i = bestJ + 1;
      } else i++;
    }
    return out;
  };
  // 闭合环：一遍从 0 开始，再把起点挪到中间走一遍，接住跨过数组首尾的那一段
  pts = pass(pts);
  const h = Math.floor(pts.length / 2);
  pts = pass(pts.slice(h).concat(pts.slice(0, h)));
  return pts.length >= 3 ? pts : poly.slice();
}

export interface Region {
  /** 外轮廓（简化后，世界坐标 ft，逆时针） */
  poly: Pt2[];
  /** ft²：区域格数 × 格面积（不含柱子） */
  area: number;
  /** 房间名放这里：离边界最远的点 */
  label: Pt2;
  /** 包围盒 [x0, y0, x1, y1] */
  bbox: [number, number, number, number];
  cells: number;
}

export interface RegionResult {
  region: Region | null;
  /** true = 这块没有被墙围住（泛洪碰到了栅格边缘） */
  leaked: boolean;
}

/* 墙按「方头」算（与 2D 里 stroke-linecap:square 画出来的墙一致）：沿墙方向两端各多出半厚，
   墙角因此是方的 —— 圆头会把墙角削圆，简化后留下多余的顶点（L 形房间读成 7 个角）。 */
function inWall(px: number, py: number, s: Barrier, r: number): boolean {
  const dx = s.x2 - s.x1,
    dy = s.y2 - s.y1,
    L = Math.hypot(dx, dy);
  if (L < 1e-9) return Math.hypot(px - s.x1, py - s.y1) <= r;
  const ux = dx / L,
    uy = dy / L;
  const a = (px - s.x1) * ux + (py - s.y1) * uy,
    b = -(px - s.x1) * uy + (py - s.y1) * ux;
  return a >= -r && a <= L + r && Math.abs(b) <= r;
}

export function pointInPolygon(p: Pt2, poly: readonly Pt2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i],
      [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 有符号面积（逆时针为正，y 轴向下的平面图坐标里看起来是顺时针——只用绝对值时无所谓） */
export function signedArea(poly: readonly Pt2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i],
      [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}
export const polyArea = (poly: readonly Pt2[]): number => Math.abs(signedArea(poly));

export function buildGrid(inp: RegionInput): Grid | null {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  const feed = (x: number, y: number, r = 0) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    x0 = Math.min(x0, x - r);
    y0 = Math.min(y0, y - r);
    x1 = Math.max(x1, x + r);
    y1 = Math.max(y1, y + r);
  };
  for (const s of inp.segs) {
    feed(s.x1, s.y1, s.half);
    feed(s.x2, s.y2, s.half);
  }
  for (const p of inp.polys || []) for (const q of p) feed(q[0], q[1]);
  for (const q of inp.bounds || []) feed(q[0], q[1]);
  if (!Number.isFinite(x0)) return null;
  const pad = inp.pad ?? 2;
  x0 -= pad;
  y0 -= pad;
  x1 += pad;
  y1 += pad;
  let cell = inp.cell ?? 1 / 12;
  const maxCells = inp.maxCells ?? 4_000_000;
  if (((x1 - x0) / cell) * ((y1 - y0) / cell) > maxCells) cell = Math.sqrt(((x1 - x0) * (y1 - y0)) / maxCells);
  const w = Math.ceil((x1 - x0) / cell),
    h = Math.ceil((y1 - y0) / cell);
  const block = new Uint8Array(w * h);
  const cx = (i: number) => x0 + (i + 0.5) * cell,
    cy = (j: number) => y0 + (j + 0.5) * cell;
  for (const s of inp.segs) {
    const r = Math.max(s.half, cell * 0.75);
    const i0 = Math.max(0, Math.floor((Math.min(s.x1, s.x2) - r - x0) / cell)),
      i1 = Math.min(w - 1, Math.ceil((Math.max(s.x1, s.x2) + r - x0) / cell)),
      j0 = Math.max(0, Math.floor((Math.min(s.y1, s.y2) - r - y0) / cell)),
      j1 = Math.min(h - 1, Math.ceil((Math.max(s.y1, s.y2) + r - y0) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (inWall(cx(i), cy(j), s, r)) block[j * w + i] = 1;
  }
  for (const poly of inp.polys || []) {
    if (poly.length < 3) continue;
    let px0 = Infinity,
      py0 = Infinity,
      px1 = -Infinity,
      py1 = -Infinity;
    for (const q of poly) {
      px0 = Math.min(px0, q[0]);
      py0 = Math.min(py0, q[1]);
      px1 = Math.max(px1, q[0]);
      py1 = Math.max(py1, q[1]);
    }
    const i0 = Math.max(0, Math.floor((px0 - x0) / cell)),
      i1 = Math.min(w - 1, Math.ceil((px1 - x0) / cell)),
      j0 = Math.max(0, Math.floor((py0 - y0) / cell)),
      j1 = Math.min(h - 1, Math.ceil((py1 - y0) / cell));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) if (pointInPolygon([cx(i), cy(j)], poly)) block[j * w + i] = 1;
  }
  if (inp.bounds && inp.bounds.length >= 3) {
    /* 逐行扫描：与逐格 pointInPolygon 同一个奇偶判据、同一个交点公式（逐格结果一致，vitest 守着），
       但每行只算一次交点。逐格判是 格数 × 边数：内置户型（1 英寸一格、地板轮廓 20 来条边）一次建栅格
       ~70ms，墙一改就要重建（轮㊱ 房间轮廓跟着墙走），这一步占了九成。 */
    const b = inp.bounds;
    const xs: number[] = [];
    for (let j = 0; j < h; j++) {
      const y = cy(j);
      xs.length = 0;
      for (let a = 0, c = b.length - 1; a < b.length; c = a++) {
        const [xa, ya] = b[a],
          [xc, yc] = b[c];
        if (ya > y !== yc > y) xs.push(((xc - xa) * (y - ya)) / (yc - ya) + xa);
      }
      xs.sort((p, q) => p - q);
      // 格心在多边形里 ⇔ 格心右边（x < 交点）的交点个数为奇数；k = 已经不在格心右边的交点个数
      let k = 0;
      for (let i = 0; i < w; i++) {
        const x = cx(i);
        while (k < xs.length && !(x < xs[k])) k++;
        if ((xs.length - k) % 2 === 0) block[j * w + i] = 1;
      }
    }
  }
  // S27 M04：柱子 / 台面这类障碍多边形的边也是墙皮 —— 斜着的那几条边同样要能拉直、精修
  const lines = faceLines(inp.segs, inp.bounds);
  for (const P of inp.polys || [])
    for (let i = 0; i < P.length; i++) {
      const a = P[i],
        b = P[(i + 1) % P.length],
        L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L > 1e-6) lines.push({ px: a[0], py: a[1], ux: (b[0] - a[0]) / L, uy: (b[1] - a[1]) / L });
    }
  return { x0, y0, cell, w, h, block, lines };
}

export function cellAt(g: Grid, x: number, y: number): number {
  const i = Math.floor((x - g.x0) / g.cell),
    j = Math.floor((y - g.y0) / g.cell);
  if (i < 0 || j < 0 || i >= g.w || j >= g.h) return -1;
  return j * g.w + i;
}

/** 4 邻接泛洪。passable(idx) 决定哪些格能走（缺省 = 不是障碍）。 */
export function flood(
  g: Grid,
  start: number,
  passable?: (idx: number) => boolean
): { mask: Uint8Array; count: number; touchesEdge: boolean } {
  const ok = passable || ((k: number) => g.block[k] === 0);
  const mask = new Uint8Array(g.w * g.h);
  if (start < 0 || !ok(start)) return { mask, count: 0, touchesEdge: false };
  const q = new Int32Array(g.w * g.h);
  let head = 0,
    tail = 0,
    count = 0,
    edge = false;
  mask[start] = 1;
  q[tail++] = start;
  while (head < tail) {
    const k = q[head++];
    count++;
    const i = k % g.w,
      j = (k - i) / g.w;
    if (i === 0 || j === 0 || i === g.w - 1 || j === g.h - 1) edge = true;
    if (i > 0 && !mask[k - 1] && ok(k - 1)) ((mask[k - 1] = 1), (q[tail++] = k - 1));
    if (i < g.w - 1 && !mask[k + 1] && ok(k + 1)) ((mask[k + 1] = 1), (q[tail++] = k + 1));
    if (j > 0 && !mask[k - g.w] && ok(k - g.w)) ((mask[k - g.w] = 1), (q[tail++] = k - g.w));
    if (j < g.h - 1 && !mask[k + g.w] && ok(k + g.w)) ((mask[k + g.w] = 1), (q[tail++] = k + g.w));
  }
  return { mask, count, touchesEdge: edge };
}

/** 区域边界的所有闭环（世界坐标，格角上的点）。区域在有向边的左手边；鞍点优先左转（只认 4 邻接）。 */
export function traceLoops(g: Grid, mask: Uint8Array): Pt2[][] {
  const W = g.w + 1; // 角点索引 = j * W + i
  const out = new Map<number, number[]>(); // 起点角 → 终点角列表
  const addE = (a: number, b: number) => {
    const l = out.get(a);
    if (l) l.push(b);
    else out.set(a, [b]);
  };
  const inM = (i: number, j: number) => i >= 0 && j >= 0 && i < g.w && j < g.h && mask[j * g.w + i] === 1;
  for (let j = 0; j < g.h; j++)
    for (let i = 0; i < g.w; i++) {
      if (!mask[j * g.w + i]) continue;
      // 格子的四条边（屏幕坐标 y 向下；沿边走时区域在左手边）
      if (!inM(i, j - 1)) addE(j * W + i + 1, j * W + i); // 上边：右 → 左
      if (!inM(i - 1, j)) addE(j * W + i, (j + 1) * W + i); // 左边：上 → 下
      if (!inM(i, j + 1)) addE((j + 1) * W + i, (j + 1) * W + i + 1); // 下边：左 → 右
      if (!inM(i + 1, j)) addE((j + 1) * W + i + 1, j * W + i + 1); // 右边：下 → 上
    }
  const loops: Pt2[][] = [];
  const dirOf = (a: number, b: number): [number, number] => [(b % W) - (a % W), Math.floor(b / W) - Math.floor(a / W)];
  for (const [startA] of out) {
    let l = out.get(startA);
    while (l && l.length) {
      const pts: number[] = [startA];
      let a = startA,
        b = l.pop() as number;
      if (!l.length) out.delete(a);
      let guard = 0;
      while (b !== startA && guard++ < 50_000_000) {
        pts.push(b);
        const nexts = out.get(b);
        if (!nexts || !nexts.length) break;
        let pick = 0;
        if (nexts.length > 1) {
          // 鞍点：按「左转 > 直行 > 右转」挑（屏幕坐标 y 向下，左转 = 叉积 < 0）
          const [dx, dy] = dirOf(a, b);
          let best = Infinity;
          nexts.forEach((c, idx) => {
            const [ex, ey] = dirOf(b, c);
            const cross = dx * ey - dy * ex,
              dot = dx * ex + dy * ey;
            const rank = cross < 0 ? 0 : dot > 0 ? 1 : 2;
            if (rank < best) ((best = rank), (pick = idx));
          });
        }
        const c = nexts.splice(pick, 1)[0];
        if (!nexts.length) out.delete(b);
        a = b;
        b = c;
      }
      loops.push(pts.map((k) => [g.x0 + (k % W) * g.cell, g.y0 + Math.floor(k / W) * g.cell] as Pt2));
      l = out.get(startA);
    }
  }
  return loops;
}

function rdp(pts: Pt2[], tol: number): Pt2[] {
  if (pts.length < 3) return pts.slice();
  const [ax, ay] = pts[0],
    [bx, by] = pts[pts.length - 1];
  const dx = bx - ax,
    dy = by - ay,
    L = Math.hypot(dx, dy) || 1e-12;
  let md = -1,
    mi = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L;
    if (d > md) ((md = d), (mi = i));
  }
  if (md <= tol) return [pts[0], pts[pts.length - 1]];
  const a = rdp(pts.slice(0, mi + 1), tol),
    b = rdp(pts.slice(mi), tol);
  return a.slice(0, -1).concat(b);
}

/** 闭合多边形的 RDP 简化（先在离起点最远的点处切成两条链，各自简化后拼回去，再去掉共线点） */
export function simplifyClosed(poly: readonly Pt2[], tol: number): Pt2[] {
  if (poly.length < 4) return poly.slice();
  let far = 0,
    fd = -1;
  for (let i = 1; i < poly.length; i++) {
    const d = Math.hypot(poly[i][0] - poly[0][0], poly[i][1] - poly[0][1]);
    if (d > fd) ((fd = d), (far = i));
  }
  const a = rdp(poly.slice(0, far + 1) as Pt2[], tol),
    b = rdp((poly.slice(far) as Pt2[]).concat([poly[0]]), tol);
  let out = a.slice(0, -1).concat(b.slice(0, -1));
  // 去掉共线点（容差 tol）
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const p = out[(i + out.length - 1) % out.length],
        q = out[i],
        r = out[(i + 1) % out.length];
      const L = Math.hypot(r[0] - p[0], r[1] - p[1]) || 1e-12;
      const d = Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) / L;
      if (d <= tol * 0.5) {
        out = out.slice(0, i).concat(out.slice(i + 1));
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** 多源 BFS 距离变换：区域里离边界最远的格心 */
function farthestCell(g: Grid, mask: Uint8Array): number {
  const dist = new Int32Array(g.w * g.h).fill(-1);
  const q = new Int32Array(g.w * g.h);
  let head = 0,
    tail = 0;
  for (let k = 0; k < mask.length; k++) {
    if (!mask[k]) continue;
    const i = k % g.w,
      j = (k - i) / g.w;
    const border =
      i === 0 ||
      j === 0 ||
      i === g.w - 1 ||
      j === g.h - 1 ||
      !mask[k - 1] ||
      !mask[k + 1] ||
      !mask[k - g.w] ||
      !mask[k + g.w];
    if (border) ((dist[k] = 0), (q[tail++] = k));
  }
  let maxD = 0;
  while (head < tail) {
    const k = q[head++];
    if (dist[k] > maxD) maxD = dist[k];
    const i = k % g.w;
    const nb = [i > 0 ? k - 1 : -1, i < g.w - 1 ? k + 1 : -1, k - g.w, k + g.w];
    for (const n of nb) {
      if (n < 0 || n >= mask.length || !mask[n] || dist[n] >= 0) continue;
      dist[n] = dist[k] + 1;
      q[tail++] = n;
    }
  }
  /* 曼哈顿距离在矩形里会出一整条「最远」的脊线：取脊线（所有最远格）的中心附近那一格，
     否则 12×10 的房间名会偏到脊线一端（实测偏 1ft） */
  let sx = 0,
    sy = 0,
    cnt = 0;
  for (let k = 0; k < dist.length; k++)
    if (dist[k] === maxD && mask[k]) {
      sx += k % g.w;
      sy += Math.floor(k / g.w);
      cnt++;
    }
  if (!cnt) return -1;
  const mx = sx / cnt,
    my = sy / cnt;
  let best = -1,
    bd = Infinity;
  for (let k = 0; k < dist.length; k++)
    if (dist[k] === maxD && mask[k]) {
      const d = ((k % g.w) - mx) ** 2 + (Math.floor(k / g.w) - my) ** 2;
      if (d < bd) ((bd = d), (best = k));
    }
  return best;
}

function regionFromMask(g: Grid, mask: Uint8Array, count: number): Region | null {
  const loops = traceLoops(g, mask);
  if (!loops.length) return null;
  let outer = loops[0],
    oa = polyArea(loops[0]);
  for (const l of loops) {
    const a = polyArea(l);
    if (a > oa) ((oa = a), (outer = l));
  }
  const raw0 = simplifyClosed(outer, g.cell * 0.75);
  const raw = g.lines && g.lines.length ? straightenRuns(raw0, g.lines, g.cell * 1.2) : raw0;
  const poly = g.lines && g.lines.length ? refineToFaces(raw, g.lines, g.cell * 1.6) : raw;
  if (signedArea(poly) < 0) poly.reverse();
  // 面积 = 精修后外轮廓的面积 − 洞（柱子）占的格：外环围住的格数 − 区域格数
  const holeArea = Math.max(0, oa - count * g.cell * g.cell);
  const fc = farthestCell(g, mask);
  const fi = fc % g.w,
    fj = (fc - fi) / g.w;
  let bx0 = Infinity,
    by0 = Infinity,
    bx1 = -Infinity,
    by1 = -Infinity;
  for (const p of poly) {
    bx0 = Math.min(bx0, p[0]);
    by0 = Math.min(by0, p[1]);
    bx1 = Math.max(bx1, p[0]);
    by1 = Math.max(by1, p[1]);
  }
  return {
    poly,
    area: Math.max(0, polyArea(poly) - holeArea),
    label: [g.x0 + (fi + 0.5) * g.cell, g.y0 + (fj + 0.5) * g.cell],
    bbox: [bx0, by0, bx1, by1],
    cells: count,
  };
}

/** 点 (x, y) 所在的房间。点在墙里 / 栅格外 → region=null, leaked=false；没围住 → leaked=true */
export function regionAt(inpOrGrid: RegionInput | Grid, x: number, y: number): RegionResult {
  const g = 'block' in inpOrGrid ? inpOrGrid : buildGrid(inpOrGrid);
  if (!g) return { region: null, leaked: false };
  const start = cellAt(g, x, y);
  if (start < 0 || g.block[start]) return { region: null, leaked: false };
  const f = flood(g, start);
  if (f.touchesEdge) return { region: null, leaked: true };
  return { region: regionFromMask(g, f.mask, f.count), leaked: false };
}

/** 房屋外轮廓：从栅格边缘泛洪出「室外」，补集最大连通块的外环。墙没围合 → null */
export function footprint(inpOrGrid: RegionInput | Grid): Pt2[] | null {
  const g = 'block' in inpOrGrid ? inpOrGrid : buildGrid(inpOrGrid);
  if (!g) return null;
  const outside = flood(g, 0); // (0,0) 在留白里，一定不是障碍
  const inside = new Uint8Array(g.w * g.h);
  let insideN = 0,
    freeInside = 0;
  for (let k = 0; k < inside.length; k++)
    if (!outside.mask[k]) {
      inside[k] = 1;
      insideN++;
      if (!g.block[k]) freeInside++;
    }
  // 墙没围合：「室内」就只剩墙体那几格 → 没有意义
  if (!insideN || freeInside < insideN * 0.3) return null;
  // 取最大的那个连通块（4 邻接）
  let best: { mask: Uint8Array; count: number } | null = null;
  const seen = new Uint8Array(inside.length);
  for (let k = 0; k < inside.length; k++) {
    if (!inside[k] || seen[k]) continue;
    const f = flood(g, k, (idx) => inside[idx] === 1);
    for (let m = 0; m < f.mask.length; m++) if (f.mask[m]) seen[m] = 1;
    if (!best || f.count > best.count) best = f;
  }
  if (!best) return null;
  const r = regionFromMask(g, best.mask, best.count);
  return r ? r.poly : null;
}
