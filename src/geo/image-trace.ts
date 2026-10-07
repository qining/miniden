/* =====================================================================
   src/geo/image-trace.ts — S7：图片底图特征提取（纯 JS，无依赖）

   输入：灰度像素（0..255，0=黑）+ 宽高 → 输出：像素坐标线段集（y 向下）。
   管线（R2 §1，OpenCV.js 的替代实现——单文件/离线约束下的取舍，
   质量不足时再升级白名单 OpenCV）：

     Otsu 全局阈值 → 二值墨层（户型图 = 深色线在浅色底上）
     → 3×3 Sobel + NMS + 双阈值滞后（Canny-lite）
     → 投影式 Hough：120 个候选法向角（1.5° 步进，含斜墙）
        × 2px ρ 分箱计数 → 候选线去重（|Δρ|<8px ∧ Δθ<4°）
        → 每条候选线回收近线像素 → 沿线投影排序 → 间隙(>10px)断开
        → 段长 ≥ minLen 的入结果（按票数降序，≤ maxSegs）

   全部纯函数：无 DOM / 无 Math.random（确定性 = 像素回归可复现）。
   浏览器侧（planner.html）负责 canvas → 灰度 与 像素 → 文档 ft 的映射
   （imgTransform / imgPtToDoc 也在本模块，纯计算可单测）。
   ===================================================================== */

export interface TraceSeg {
  a: { x: number; y: number };
  b: { x: number; y: number };
  weight: number; // 支撑像素数（描摹优先级/显示用）
  theta: number; // 法向角（度，0..180）
}

export interface TraceOpts {
  /** 最短段长（px）：默认 max(24, 1.2%·最长边) */
  minLen?: number;
  /** 结果上限：默认 400（按 weight 降序截断） */
  maxSegs?: number;
  /** Hough 分箱最小票数：默认 max(30, 0.5%·边像素数) */
  minVotes?: number;
  /** 角度步进（度）：默认 1.5（120 个法向，覆盖 ±45° 内的斜墙） */
  angleStep?: number;
  /** Canny 双阈值（Sobel 幅值）：默认 [120, 250] */
  cannyLow?: number;
  cannyHigh?: number;
}

export interface TraceResult {
  segs: TraceSeg[];
  edgeCount: number; // 滞后后的边像素数（诊断用：扫描件/噪声图会异常多）
  inverted: boolean; // 极性翻转过（深底浅字）
}

/* ---------- 内部小工具（确定性，无全局状态） ---------- */

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/** Otsu 全局阈值；直方图退化（单值）时回退 128。 */
function otsu(gray: ArrayLike<number>, n: number): number {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < n; i++) hist[clamp255(gray[i])]++;
  // 在「实际存在的灰度值」之间选分界（阈值 = 相邻两值的中点）。
  // 经典逐 t 扫描在双峰图（0/255）上最优阈值落在 t=0——g<0 恒假、墨层全空，
  // 这是 Otsu 的已知陷阱；用中点阈值后 0/255 图 → thr=127.5，黑线入墨。
  const vals: number[] = [];
  let total = 0,
    sum = 0;
  for (let t = 0; t < 256; t++)
    if (hist[t]) {
      vals.push(t);
      total += hist[t];
      sum += t * hist[t];
    }
  if (vals.length < 2) return 128; // 单值图：无墨
  let wB = 0,
    sumB = 0,
    best = 128,
    bestV = -1;
  for (let k = 0; k < vals.length - 1; k++) {
    const va = vals[k],
      vb = vals[k + 1];
    // wB = 0..va 的累计（含 va）
    for (let t = k ? vals[k - 1] + 1 : 0; t <= va; t++) {
      wB += hist[t];
      sumB += t * hist[t];
    }
    const wF = total - wB;
    if (!wF) continue;
    const mB = sumB / wB,
      mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > bestV) {
      bestV = v;
      best = (va + vb) / 2;
    }
  }
  return best;
}

/** Sobel 幅值（对二值墨层）+ NMS。返回幅值（其余 0）与边像素坐标数组。 */
function canny(bin: Uint8Array, w: number, h: number, lo: number, hi: number) {
  const n = w * h;
  const gx = new Int32Array(n),
    gy = new Int32Array(n);
  for (let y = 1; y < h - 1; y++) {
    const r0 = (y - 1) * w,
      r1 = y * w,
      r2 = (y + 1) * w;
    for (let x = 1; x < w - 1; x++) {
      gx[r1 + x] =
        bin[r0 + x + 1] +
        2 * bin[r1 + x + 1] +
        bin[r2 + x + 1] -
        (bin[r0 + x - 1] + 2 * bin[r1 + x - 1] + bin[r2 + x - 1]);
      gy[r1 + x] =
        bin[r2 + x - 1] + 2 * bin[r2 + x] + bin[r2 + x + 1] - (bin[r0 + x - 1] + 2 * bin[r0 + x] + bin[r0 + x + 1]);
    }
  }
  const mag = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    const r1 = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = r1 + x;
      mag[i] = Math.sqrt(gx[i] * gx[i] + gy[i] * gy[i]);
    }
  }
  // NMS（第二趟）：梯度方向量化到 0/45/90/135 四档，比对应方向的两个邻居（含对角）
  const magAt = (i: number) => (i >= 0 && i < n ? mag[i] : 0);
  for (let y = 1; y < h - 1; y++) {
    const r1 = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = r1 + x;
      const m = mag[i];
      if (m < hi) {
        mag[i] = 0;
        continue;
      }
      // atan2 归一化到 [0,π)（y 向下系，对称性不受影响）
      let a = Math.atan2(gy[i], gx[i]);
      if (a < 0) a += Math.PI;
      const q = a < Math.PI / 4 || a >= (7 * Math.PI) / 8 ? 0 : a < (3 * Math.PI) / 4 ? (a < Math.PI / 2 ? 1 : 2) : 3;
      let n1 = 0,
        n2 = 0;
      if (q === 0) {
        n1 = i + 1;
        n2 = i - 1;
      } else if (q === 1) {
        n1 = i + 1 + w;
        n2 = i - 1 - w;
      } else if (q === 2) {
        n1 = i + w;
        n2 = i - w;
      } else {
        n1 = i - 1 + w;
        n2 = i + 1 - w;
      }
      if (m >= magAt(n1) && m >= magAt(n2))
        mag[i] = m; // 严格大于邻居才保留（相等也保留，避免双线丢边）
      else mag[i] = 0;
    }
  }
  // 双阈值滞后（8 连通，显式栈）
  const strong = new Uint8Array(n),
    edge = new Uint8Array(n);
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (mag[i] >= hi) {
      strong[i] = 1;
      edge[i] = 1;
      stack.push(i);
    } else if (mag[i] >= lo) strong[i] = 2;
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w,
      y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx,
          ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (strong[j] === 2) {
          strong[j] = 1;
          edge[j] = 1;
          stack.push(j);
        }
      }
  }
  const xs: number[] = [],
    ys: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (edge[y * w + x]) {
        xs.push(x);
        ys.push(y);
      }
    }
  return { xs, ys };
}

/** 投影式 Hough（见文件头）。xs/ys = 边像素坐标。 */
function hough(xs: number[], ys: number[], w: number, h: number, o: Required<TraceOpts>) {
  const N = xs.length;
  if (N < 30) return [] as TraceSeg[];
  const minLen = o.minLen ?? Math.max(24, Math.max(w, h) * 0.012);
  const minVotes = o.minVotes ?? Math.max(30, N * 0.005);
  const maxSegs = o.maxSegs ?? 400;
  const DEG = Math.PI / 180;

  // 1) 候选线：(θ, ρ) 密集分箱
  const cand: { theta: number; rho: number; votes: number }[] = [];
  for (let ti = 0; ti < 180 / o.angleStep; ti++) {
    const th = ti * o.angleStep * DEG;
    const nx = Math.cos(th),
      ny = Math.sin(th);
    // ρ 范围
    let rmin = Infinity,
      rmax = -Infinity;
    for (let i = 0; i < N; i++) {
      const r = xs[i] * nx + ys[i] * ny;
      if (r < rmin) rmin = r;
      if (r > rmax) rmax = r;
    }
    if (!Number.isFinite(rmin)) continue;
    const nBins = Math.max(1, Math.ceil((rmax - rmin) / 2) + 1);
    if (nBins > 20000) continue;
    const cnt = new Int32Array(nBins);
    for (let i = 0; i < N; i++) {
      const b = ((xs[i] * nx + ys[i] * ny - rmin) / 2) | 0;
      cnt[b]++;
    }
    for (let b = 0; b < nBins; b++) {
      if (cnt[b] >= minVotes) cand.push({ theta: ti * o.angleStep, rho: rmin + b * 2 + 1, votes: cnt[b] });
    }
  }
  // 2) 去重（近平行+近共线 → 留票高的）
  cand.sort((a, b) => b.votes - a.votes);
  const kept: typeof cand = [];
  for (const c of cand) {
    let dup = false;
    for (const k of kept) {
      const dth = Math.abs(c.theta - k.theta) % 180;
      if (Math.min(dth, 180 - dth) < 4 && Math.abs(c.rho - k.rho) < 8) {
        dup = true;
        break;
      }
    }
    if (!dup) kept.push(c);
    if (kept.length >= 80) break;
  }
  // 3) 每条候选线：回收近线像素 → 沿线投影 → 间隙断开
  const segs: TraceSeg[] = [];
  const dx = (th: number) => -Math.sin(th * DEG),
    dy = (th: number) => Math.cos(th * DEG);
  for (const c of kept) {
    const nx = Math.cos(c.theta * DEG),
      ny = Math.sin(c.theta * DEG);
    const ddx = dx(c.theta),
      ddy = dy(c.theta);
    const s: number[] = [];
    for (let i = 0; i < N; i++) {
      if (Math.abs(xs[i] * nx + ys[i] * ny - c.rho) <= 2.5) s.push(xs[i] * ddx + ys[i] * ddy);
    }
    if (s.length < minVotes) continue;
    s.sort((a, b) => a - b);
    let runStart = 0;
    for (let i = 1; i <= s.length; i++) {
      const gap = i === s.length || s[i] - s[i - 1] > 10;
      if (!gap) continue;
      const s0 = s[runStart],
        s1 = s[i - 1];
      if (s1 - s0 >= minLen) {
        // 沿线坐标 → 像素（取线中心 ρ）
        const toPt = (t: number) => ({ x: c.rho * nx + t * ddx, y: c.rho * ny + t * ddy });
        const a = toPt(s0),
          b = toPt(s1);
        segs.push({ a, b, weight: i - runStart, theta: c.theta });
      }
      runStart = i;
    }
  }
  segs.sort((a, b) => b.weight - a.weight);
  return segs.slice(0, maxSegs);
}

/* ---------- 公开入口 ---------- */

export function traceLines(gray: ArrayLike<number>, w: number, h: number, opts: TraceOpts = {}): TraceResult {
  const o: Required<TraceOpts> = {
    minLen: opts.minLen ?? Math.max(24, Math.max(w, h) * 0.012),
    maxSegs: opts.maxSegs ?? 400,
    minVotes: opts.minVotes ?? 0, // 0 → hough() 内部再套默认
    angleStep: opts.angleStep ?? 1.5,
    cannyLow: opts.cannyLow ?? 120,
    cannyHigh: opts.cannyHigh ?? 250,
  };
  const n = w * h;
  // 极性：平均亮 < 128 → 深底（浅字）→ 翻转
  let sum = 0;
  for (let i = 0; i < n; i++) sum += gray[i];
  const inverted = sum / n < 128;
  const bin = new Uint8Array(n);
  const thr = otsu(gray, n);
  for (let i = 0; i < n; i++) {
    const g = gray[i];
    const ink = inverted ? g > thr : g < thr;
    bin[i] = ink ? 255 : 0;
  }
  const { xs, ys } = canny(bin, w, h, o.cannyLow, o.cannyHigh);
  const minVotes = opts.minVotes ?? Math.max(30, xs.length * 0.005);
  const segs = hough(xs, ys, w, h, { ...o, minVotes });
  return { segs, edgeCount: xs.length, inverted };
}

/* ---------- 放置变换：图像像素 ↔ 文档 ft（y 均向下） ----------

   约定（与 build2D 一致：文档坐标 ft，1ft = S px viewBox）：
   ftPerPx = mPerPx / 0.3048；(ox,oy) = **旋转后包围盒**的左上角文档坐标；
   图像中心 C = (ox + bw/2·ft, oy + bh/2·ft)，bw/bh 随 rot 交换。
   像素 p → 文档：C + R(rot)·(p − (w/2,h/2))·ftPerPx（R = SVG rotate 矩阵，
   y 向下系里顺时针；与 <image transform=rotate> 完全一致）。
--------------------------------------------------------------------- */

export interface BaseImageLike {
  w: number;
  h: number;
  mPerPx: number;
  ox: number;
  oy: number;
  rot?: 0 | 90 | 180 | 270;
}

export interface ImgTransform {
  ftPerPx: number; // ft/px
  rot: 0 | 90 | 180 | 270;
  bw: number;
  bh: number; // 旋转后包围盒（像素，未乘 ft）
  cx: number;
  cy: number; // 图像中心（文档 ft）
  toDoc(px: number, py: number): [number, number];
  toImg(x: number, y: number): [number, number]; // 文档 ft → 像素（可出界）
}

export function imgTransform(bi: BaseImageLike): ImgTransform {
  const ftPerPx = bi.mPerPx / 0.3048;
  const rot = bi.rot ?? 0;
  const swap = rot === 90 || rot === 270;
  const bw = swap ? bi.h : bi.w,
    bh = swap ? bi.w : bi.h;
  const cx = bi.ox + (bw / 2) * ftPerPx,
    cy = bi.oy + (bh / 2) * ftPerPx;
  // R(rot)·(x,y)：y 向下系顺时针
  const R = (x: number, y: number): [number, number] => {
    switch (rot) {
      case 0:
        return [x, y];
      case 90:
        return [-y, x];
      case 180:
        return [-x, -y];
      default:
        return [y, -x];
    }
  };
  const Ri = (x: number, y: number): [number, number] => {
    switch (rot) {
      case 0:
        return [x, y];
      case 90:
        return [y, -x];
      case 180:
        return [-x, -y];
      default:
        return [-y, x];
    }
  };
  return {
    ftPerPx,
    rot,
    bw,
    bh,
    cx,
    cy,
    toDoc(px, py) {
      const [rx, ry] = R((px - bi.w / 2) * ftPerPx, (py - bi.h / 2) * ftPerPx);
      return [cx + rx, cy + ry];
    },
    toImg(x, y) {
      const [ix, iy] = Ri((x - cx) / ftPerPx, (y - cy) / ftPerPx);
      return [ix + bi.w / 2, iy + bi.h / 2];
    },
  };
}
