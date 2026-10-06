/* =====================================================================
   src/geo/import-pdf.ts — PDF 矢量导入（S6，R1 设计）

   输入 = pdf.js `page.getOperatorList()` 的 {fnArray, argsArray}
   （4.10 格式：路径 op 打包在 constructPath 里、颜色是 setStroke* 对象参数）
   + 页面视口（pt）。
   输出 = ProjectDoc（走与 DXF 同一共享管线 buildDocFromRaw）。

   关键事实（与 DXF 的不同）：
     - **PDF 坐标恒为物理尺寸**（pt = 1/72 英寸）→ 单位固定 'pt'，
       无需单位启发式（PDF 没有 $INSUNITS）。1:100 之类的绘图错误
       会表现为整图量级异常（共享管线的 extent 警告兜住，UI 给用户看）。
     - **没有图层** → 语义分类改用**描边颜色**启发式（R1 的
       「天正图层乱 → 颜色兜底」思路）：近黑→墙、蓝→窗、红→门、
       绿→家具，其余→other（只作提示，用户可改）。
     - **扫描件检测**（R1）：几乎只有 paintImage、没有矢量路径
       → 降级提示走图片描摹通道（S7），不 apply。

   纯函数：禁 import three / document / localStorage（R7）；
   pdf.js 由 UI 层（lib/pdf.min.js）提供，本模块只消费结构化 op 列表
   （OPS 常量表作为参数传入，便于单测无需加载 pdf.js）。
   ===================================================================== */
import type { ProjectDoc } from '../schema/project';
import { buildDocFromRaw, UNIT_TO_M } from './import-common';
import type { Raw, V2, LayerClass, ImportResult } from './import-common';

/* ---------------------------------------------------------------- 类型 */

export interface PdfOpList {
  fnArray: number[];
  argsArray: (unknown[] | null)[];   // 无参 op 的条目是 null；有参的是类数组/对象（不同构建形态不一）
}
/** pdf.js 的 OPS 常量表（`pdfjsLib.OPS`）——只按名字引用，不硬编码数字。 */
export type OpsTable = Record<string, number>;

export interface PdfPageInfo {
  /** 页面尺寸 pt（viewport scale=1）。 */
  w: number; h: number;
  rotate?: number;
}

/* ---------------------------------------------------------------- 常量 */

/** 文字路径噪声阈值（pt）：bbox 对角线 < 5.3mm 的**闭合**多点路径
 *  当作文字字形轮廓丢弃（R1 的 bbox 密度启发式）。
 *  必须要求 closed——1:100–1:200 图纸里门弧（开放路径，bbox 10–14pt）
 *  与字形同量级，开放/闭合是唯一可靠区分（实测教训）。 */
const GLYPH_MAX_DIAG_PT = 15;
const GLYPH_MIN_PTS = 6;
/** 扫描件判据：矢量输出极少 + 有整页位图。 */
const SCAN_VEC_MAX = 8;
/** 贝塞尔采样密度（每条 cubic 的采样点数）。 */
const BEZ_SAMPLES = 8;
/** 弧拟合阈值（R1）：残差 < 弦高 20% → arc 原语，否则折线。 */
const ARC_RESID_FRAC = 0.2;
const ARC_MIN_SWEEP = 30 * Math.PI / 180;
const ARC_MAX_SWEEP = 340 * Math.PI / 180;
const ARC_FULL_SWEEP = 330 * Math.PI / 180;

/* ---------------------------------------------------------------- 工具 */

const v = (x: number, y: number): V2 => ({ x, y });
const sub = (a: V2, b: V2): V2 => v(a.x - b.x, a.y - b.y);
const len = (a: V2) => Math.hypot(a.x, a.y);
const num = (x: unknown): number => {
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
};
const angleDiff = (a: number, b: number) => {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

type Mat2 = [number, number, number, number, number, number];   // a b c d e f
const MAT_ID: Mat2 = [1, 0, 0, 1, 0, 0];
/** M = m ⊗ t（PDF：新 CTM 左乘当前）——点 p' = M·p。 */
function matMul(m: Mat2, t: Mat2): Mat2 {
  return [
    m[0] * t[0] + m[1] * t[2], m[0] * t[1] + m[1] * t[3],
    m[2] * t[0] + m[3] * t[2], m[2] * t[1] + m[3] * t[3],
    m[4] * t[0] + m[5] * t[2] + t[4], m[4] * t[1] + m[5] * t[3] + t[5],
  ];
}
function matApply(m: Mat2, p: V2): V2 {
  return v(m[0] * p.x + m[2] * p.y + m[4], m[1] * p.x + m[3] * p.y + m[5]);
}

/** pdf.js 4.x 的颜色参数，实际形态有三种（不同构建/宿主）：
 *   ① 类数组 [r,g,b]（含 PDFJNumberArray）
 *   ② 无 length 的对象 {0:r, 1:g, 2:b}（node 端常见）
 *   ③ 包一层 [obj] 或 {0:..,1:..,2:..}（历史构建）
 *  全部归一成 0–255 三元组。（曾踩坑：对形态②查 .length 永远 undefined，
 *  返回 [0,0,0] → 颜色分类全变近黑。） */
function rgbOf(a: unknown[]): [number, number, number] {
  const pickObj = (o: unknown): [number, number, number] | null => {
    if (o != null && (typeof o === 'object' || typeof o === 'function')) {
      const r = o as Record<string | number, unknown>;
      if (r[0] !== undefined || r[1] !== undefined || r[2] !== undefined)
        return [num(r[0]), num(r[1]), num(r[2])];
    }
    return null;
  };
  if (a.length >= 3) {
    if (a[0] != null && typeof a[0] !== 'object' && typeof a[0] !== 'function')
      return [num(a[0]), num(a[1]), num(a[2])];   // ①
    const p = pickObj(a[0]);
    if (p) return p;                                // ③
  }
  if (a[0] !== undefined || a[1] !== undefined || a[2] !== undefined)
    return [num(a[0]), num(a[1]), num(a[2])];       // ②
  return [0, 0, 0];
}

/** 描边颜色（0–255）→ 语义类。
 *  近黑 = 墙（默认）；蓝 = 窗；红 = 门；绿 = 家具；其余 = other。 */
export function classifyPdfColor(r: number, g: number, b: number): LayerClass {
  const R = r / 255, G = g / 255, B = b / 255;
  const mx = Math.max(R, G, B);
  if (mx <= 0.35) return 'other';
  const dWin = B - Math.max(R, G);
  const dDoor = R - Math.max(G, B);
  const dFurn = G - Math.max(R, B);
  if (dWin >= 0.25 && dWin >= dDoor && dWin >= dFurn) return 'window';
  if (dDoor >= 0.25 && dDoor >= dWin && dDoor >= dFurn) return 'door';
  if (dFurn >= 0.25) return 'furn';
  return 'other';
}

/* ------------------------------------------------------------ 路径模型 */

type PathOp =
  | { k: 'line'; p: V2 }
  | { k: 'curve'; c1: V2; c2: V2; p: V2 };

interface SubPath {
  start: V2;
  ops: PathOp[];
  closed: boolean;
}

function cubicSample(c0: V2, c1: V2, c2: V2, c3: V2, n: number): V2[] {
  const out: V2[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push(v(
      u * u * u * c0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * c3.x,
      u * u * u * c0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * c3.y,
    ));
  }
  return out;
}

/** 子路径 → 采样折线（直线取端点，每条 cubic 取 BEZ_SAMPLES 点；闭合补回首点）。 */
function samplePath(sp: SubPath): V2[] {
  const pts: V2[] = [sp.start];
  let cur = sp.start;
  for (const op of sp.ops) {
    if (op.k === 'line') { pts.push(op.p); cur = op.p; }
    else {
      for (const p of cubicSample(cur, op.c1, op.c2, op.p, BEZ_SAMPLES)) pts.push(p);
      cur = op.p;
    }
  }
  if (sp.closed) pts.push(sp.start);
  return pts;
}

function pathBboxDiag(pts: V2[]): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return Math.hypot(maxX - minX, maxY - minY);
}

/** 弦高：折线各点到首末连线（弦）的最大距离。 */
function chordHeight(pts: V2[]): number {
  const a = pts[0], b = pts[pts.length - 1];
  const L = len(sub(b, a));
  if (L < 1e-9) return 0;
  const n = sub(b, a);
  let h = 0;
  for (const p of pts) {
    const d = Math.abs(n.x * (p.y - a.y) - n.y * (p.x - a.x)) / L;
    if (d > h) h = d;
  }
  return h;
}

/** Kåsa 最小二乘圆拟合（3x3 闭式解）。
 *  先平移到质心再拟合——坐标远离原点时（如页内 offset 后的 100+pt）
 *  法方程病态，中心会解到 1e12（实测门弧 bug）。
 *  病态/共线时返回 null。 */
function fitCircle(pts: V2[]): { c: V2; r: number } | null {
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const t = pts.map(p => v(p.x - mx, p.y - my));
  // A·[u,v,k]ᵀ = b，A 行 = [2x, 2y, -1]，b = x²+y²（平移后坐标）
  let a11 = 0, a12 = 0, a13 = 0, a22 = 0, a23 = 0, a33 = 0, b1 = 0, b2 = 0, b3 = 0;
  for (const p of t) {
    const xx = 2 * p.x, yy = 2 * p.y, z = -1, w = p.x * p.x + p.y * p.y;
    a11 += xx * xx; a12 += xx * yy; a13 += xx * z; b1 += xx * w;
    a22 += yy * yy; a23 += yy * z; b2 += yy * w;
    a33 += z * z; b3 += z * w;
  }
  const det =
    a11 * (a22 * a33 - a23 * a23)
    - a12 * (a12 * a33 - a23 * a13)
    + a13 * (a12 * a23 - a22 * a13);
  if (Math.abs(det) < 1e-9) return null;
  const u = (b1 * (a22 * a33 - a23 * a23) - a12 * (b2 * a33 - a23 * b3) + a13 * (b2 * a23 - a22 * b3)) / det;
  const vv = (a11 * (b2 * a33 - a23 * b3) - b1 * (a12 * a33 - a23 * b3) + a13 * (a12 * b3 - b2 * a13)) / det;
  const k = (a11 * (a22 * b3 - b2 * a23) - a12 * (a12 * b3 - b2 * a13) + b1 * (a12 * a23 - a22 * a13)) / det;
  const r2 = u * u + vv * vv - k;
  if (!(r2 > 0)) return null;
  const r = Math.sqrt(r2);
  if (!Number.isFinite(r) || r <= 1e-9) return null;
  return { c: v(u + mx, vv + my), r };
}

/* ------------------------------------------------------------ 提取 */

/**
 * op 列表 → Raw（源单位 pt、y-up、逐段 cls）+ 扫描件标记。
 * CTM 栈（save/restore/transform）维护；路径 op 在 constructPath 内；
 * 颜色用描边色优先、填充色兜底。
 */
export function extractRawPdf(ops: PdfOpList, O: OpsTable): Raw & { scanned: boolean; imageOps: number } {
  const raw: Raw = {
    segs: [], arcs: [], circles: [], closed: [],
    skipped: { ellipses: 0, inserts: 0, texts: 0, other: 0 },
  };
  let imageOps = 0;
  let ctm: Mat2 = MAT_ID;
  const stack: Mat2[] = [];
  let strokeRGB: [number, number, number] = [0, 0, 0];
  let strokeSet = false;
  let fillRGB: [number, number, number] = [0, 0, 0];
  let fillSet = false;

  // 当前子路径状态用 holder 对象（而不是被闭包捕获的 let）：
  // 闭包内赋值会让 TS 对 let 的 narrowing 退化（never 风暴）；
  // 分支内用局部别名 c 保持 narrowing 稳定。
  const st = { cur: null as SubPath | null, last: v(0, 0) };
  const begin = (p: V2) => { st.cur = { start: p, ops: [], closed: false }; st.last = p; };

  const emit = (sp: SubPath) => {
    const pts = samplePath(sp);
    // 去重相邻近点（CTM 缩放为 0 / 重复 op）
    const clean: V2[] = [pts[0]];
    for (const p of pts.slice(1))
      if (len(sub(p, clean[clean.length - 1])) > 1e-6) clean.push(p);
    if (clean.length < 2) return;
    // 文字字形噪声（R1）：闭合 + bbox 极小 + 点密（开放弧豁免）
    if (sp.closed && pathBboxDiag(clean) < GLYPH_MAX_DIAG_PT && clean.length >= GLYPH_MIN_PTS) { raw.skipped.texts++; return; }
    const col: [number, number, number] = strokeSet ? strokeRGB : fillSet ? fillRGB : [0, 0, 0];
    const cls = classifyPdfColor(col[0], col[1], col[2]);
    const hasCurve = sp.ops.some(o => o.k === 'curve');

    if (!hasCurve) {
      if (sp.closed) raw.closed.push({ pts: clean, cls });
      else
        for (let i = 0; i + 1 < clean.length; i++)
          if (len(sub(clean[i + 1], clean[i])) > 1e-6) raw.segs.push({ a: clean[i], b: clean[i + 1], cls });
      return;
    }

    // 曲线路径：先试弧拟合（R1：残差 < 弦高 20% → arc；否则折线）
    const n = clean.length;
    let sweep = 0;
    let maxResid = 0;   // 注意：不能是 Infinity——Math.max(Infinity, x) 恒为 Infinity
    let fit: { c: V2; r: number } | null = null;
    if (n >= 5) {
      fit = fitCircle(clean);
      if (fit) {
        let prev = Math.atan2(clean[0].y - fit.c.y, clean[0].x - fit.c.x);
        for (let i = 1; i < n; i++) {
          const th = Math.atan2(clean[i].y - fit.c.y, clean[i].x - fit.c.x);
          sweep += angleDiff(th, prev);
          prev = th;
        }
        for (const p of clean) maxResid = Math.max(maxResid, Math.abs(len(sub(p, fit.c)) - fit.r));
      }
    }
    const ch = chordHeight(clean);
    const sAbs = Math.abs(sweep);
    const endCoincident = len(sub(clean[n - 1], clean[0])) < 1e-6;
    if (fit && sAbs >= ARC_MIN_SWEEP && (sAbs <= ARC_MAX_SWEEP || endCoincident)
        && maxResid < Math.max(ARC_RESID_FRAC * ch, 0.1)) {
      if (sAbs >= ARC_FULL_SWEEP) raw.circles.push({ c: fit.c, r: fit.r, cls });
      else {
        const s = Math.atan2(clean[0].y - fit.c.y, clean[0].x - fit.c.x);
        raw.arcs.push({ c: fit.c, r: fit.r, s, e: s + sweep, cls, full: false });
      }
      return;
    }
    for (let i = 0; i + 1 < n; i++)
      if (len(sub(clean[i + 1], clean[i])) > 1e-6) raw.segs.push({ a: clean[i], b: clean[i + 1], cls });
  };

  for (let i = 0; i < ops.fnArray.length; i++) {
    const f = ops.fnArray[i];
    const a = ops.argsArray[i] ?? [];
    if (f === O.save) stack.push(ctm);
    else if (f === O.restore) ctm = stack.pop() ?? MAT_ID;
    else if (f === O.transform)
      ctm = matMul(ctm, [num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5])]);
    else if (f === O.setStrokeRGBColor) { strokeRGB = rgbOf(a); strokeSet = true; }
    else if (f === O.setStrokeGray) {
      const g = num(a[0]);
      strokeRGB = [g * 255, g * 255, g * 255];
      strokeSet = true;
    }
    else if (f === O.setFillRGBColor) { fillRGB = rgbOf(a); fillSet = true; }
    else if (f === O.constructPath) {
      // pdf.js 4.x：args = [fns[], flatArgs[], minMax[]]（3.x 是逐 op 的 chunk 数组）
      const fns = (a[0] ?? []) as number[];
      const nums = (a[1] ?? []) as number[];
      let j = 0;
      for (let k = 0; k < fns.length; k++) {
        const cf = fns[k] | 0;
        if (cf === O.moveTo) {
          const ns = matApply(ctm, v(num(nums[j]), num(nums[j + 1]))); j += 2;
          // pdf.js 4.x 会在每条 curveTo 前插入隐式 moveTo（当前点重复）
          // → 起点与当前末端重合的 moveTo 视为延续，不拆分子路径
          //   （否则弧被切成一段段，弧拟合/字形过滤都失效）
          if (st.cur && !st.cur.closed && st.cur.ops.length
              && Math.hypot(ns.x - st.last.x, ns.y - st.last.y) < 0.01) continue;
          if (st.cur && st.cur.ops.length) emit(st.cur);
          begin(ns);
        } else if (cf === O.lineTo) {
          const p = matApply(ctm, v(num(nums[j]), num(nums[j + 1]))); j += 2;
          if (st.cur) { st.cur.ops.push({ k: 'line', p }); st.last = p; }
        } else if (cf === O.curveTo) {
          const c1 = matApply(ctm, v(num(nums[j]), num(nums[j + 1])));
          const c2 = matApply(ctm, v(num(nums[j + 2]), num(nums[j + 3])));
          const p = matApply(ctm, v(num(nums[j + 4]), num(nums[j + 5]))); j += 6;
          if (st.cur) { st.cur.ops.push({ k: 'curve', c1, c2, p }); st.last = p; }
        } else if (cf === O.curveTo2) {
          const c2 = matApply(ctm, v(num(nums[j]), num(nums[j + 1])));
          const p = matApply(ctm, v(num(nums[j + 2]), num(nums[j + 3]))); j += 4;
          if (st.cur) { st.cur.ops.push({ k: 'curve', c1: st.last, c2, p }); st.last = p; }
        } else if (cf === O.curveTo3) {
          const c1 = matApply(ctm, v(num(nums[j]), num(nums[j + 1])));
          const p = matApply(ctm, v(num(nums[j + 2]), num(nums[j + 3]))); j += 4;
          if (st.cur) { st.cur.ops.push({ k: 'curve', c1, c2: st.last, p }); st.last = p; }
        }
        else if (cf === O.closePath) { if (st.cur) st.cur.closed = true; }
        else if (cf === O.rectangle) {
          // PDF 的 rectangle 是闭合子路径（evaluator 内部自动 closePath）
          if (st.cur && st.cur.ops.length) emit(st.cur);
          const x = num(nums[j]), y = num(nums[j + 1]), w = num(nums[j + 2]), h = num(nums[j + 3]); j += 4;
          if (w === 0 || h === 0) { st.cur = null; continue; }
          st.cur = {
            start: matApply(ctm, v(x, y)),
            ops: [
              { k: 'line', p: matApply(ctm, v(x + w, y)) },
              { k: 'line', p: matApply(ctm, v(x + w, y + h)) },
              { k: 'line', p: matApply(ctm, v(x, y + h)) },
            ],
            closed: true,
          };
          st.last = matApply(ctm, v(x, y + h));
        }
      }
    }
    else if (f === O.stroke || f === O.fill || f === O.fillStroke) {
      if (st.cur && st.cur.ops.length) emit(st.cur);
      st.cur = null;
    }
    else if (f === O.paintImageXObject || f === O.paintInlineImageXObject) imageOps++;
  }
  if (st.cur && st.cur.ops.length) emit(st.cur);

  const vecCount = raw.segs.length + raw.arcs.length + raw.circles.length + raw.closed.length;
  return { ...raw, scanned: imageOps > 0 && vecCount < SCAN_VEC_MAX, imageOps };
}

/* ------------------------------------------------------------ 主入口 */

const PT_TO_M = 0.0254 / 72;                       // 1pt = 0.3528mm（PDF 物理单位）
const SCALE_CANDIDATES = [1, 2, 5, 10, 20, 25, 50, 100, 200];

/**
 * PDF 没有单位/比例字段（DXF 有 INSUNITS）→ 图纸比例只能用几何自洽性推断
 * （R1：「比例尺要用户给，没给用门洞 0.7–1.0m 推断」）：
 * 标准候选 [1:1…1:200] 对「真实世界合理区间」计分：
 *   - door 类弧半径 ∈ [0.4, 1.2]m（门扇/门洞）
 *   - door 类直线（门扇画成直线）∈ [0.4, 1.8]m
 *   - 整图长边 ∈ [2, 30]m（住宅套型）
 * 取违反最少的候选（并列取小）；全违反也返回得分最低者并给警告。
 */
export function inferPdfScale(raw: Raw): { scale: number; method: 'heuristic' | 'fixed'; warnings: string[] } {
  const warnings: string[] = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const feed = (x: number, y: number) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  raw.segs.forEach(s => { feed(s.a.x, s.a.y); feed(s.b.x, s.b.y); });
  raw.arcs.forEach(a => { feed(a.c.x - a.r, a.c.y - a.r); feed(a.c.x + a.r, a.c.y + a.r); });
  raw.circles.forEach(c => { feed(c.c.x - c.r, c.c.y - c.r); feed(c.c.x + c.r, c.c.y + c.r); });
  raw.closed.forEach(c => c.pts.forEach(p => feed(p.x, p.y)));
  const extentPt = Number.isFinite(minX) ? Math.max(maxX - minX, maxY - minY) : 0;

  const doorArcs = raw.arcs.filter(a => a.cls === 'door');
  const doorLines = raw.segs.filter(s => s.cls === 'door');
  const hasDoor = doorArcs.length > 0 || doorLines.length > 0;

  let best = 1, bestScore = Infinity;
  for (const N of SCALE_CANDIDATES) {
    const km = PT_TO_M * N;                        // pt → m（含比例）
    let score = 0;
    for (const a of doorArcs)
      if (a.r * km < 0.4 || a.r * km > 1.2) score += 2;
    for (const s of doorLines) {
      const l = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) * km;
      if (l < 0.4 || l > 1.8) score += 1;
    }
    if (extentPt > 0) {
      const e = extentPt * km;
      if (e < 2 || e > 30) score += 2;
    }
    if (score < bestScore || (score === bestScore && N < best)) { bestScore = score; best = N; }
  }
  if (!hasDoor)
    warnings.push('未检出门元素——图纸比例仅按整图量级推断，可能有偏差（可在对话框改）');
  else if (bestScore > 0)
    warnings.push(`推断图纸比例 1:${best}（部分门元素超出合理区间，请在对话框确认/修改）`);
  return { scale: best, method: 'heuristic', warnings };
}

export interface ImportPdfOptions {
  name?: string;
  /** 手动图纸比例（1:50 → 50）；缺省用 inferPdfScale 启发式。 */
  scale?: number;
}

function emptyDoc(name?: string): ProjectDoc {
  return {
    schema: 1, name: name ?? '导入户型', units: 'cm', ceilingH: 8.8, northRotation: 0,
    walls: [], windows: [], doors: [], solids: [], rooms: [], fixtures: [],
    patio: null, env: { preset: 'seattle-city', mode: 'day' },
    hidden: { walls: [], windows: [], doors: [], solids: [] },
  };
}

/**
 * PDF operatorList → ProjectDoc + ImportInfo。
 *   unit 恒 'pt'（PDF 坐标是物理单位，method='fixed'）；
 *   图纸比例 = opts.scale（手动，method='fixed'）或 inferPdfScale（启发式）。
 * 扫描件（info.scanned）：doc = 空文档占位，UI 走降级提示（S7 图片描摹），不 apply。
 */
export function importPdf(ops: PdfOpList, page: PdfPageInfo, O: OpsTable, opts: ImportPdfOptions = {}): ImportResult {
  const raw = extractRawPdf(ops, O);
  const kM = UNIT_TO_M.pt;

  if (raw.scanned) {
    return {
      doc: emptyDoc(opts.name),
      info: {
        unit: 'pt', unitMethod: 'fixed',
        extent: { w: Math.round(page.w * kM * 10000) / 10000, h: Math.round(page.h * kM * 10000) / 10000 },
        counts: { walls: 0, doors: 0, windows: 0, solids: 0, rooms: 0, runs: 0 },
        warnings: [
          `这是扫描件（${raw.imageOps} 张位图、几乎无矢量几何）——PDF 通道读不出墙体。`,
          '请走「图片底图 + 磁吸描摹」通道（roadmap S7，OpenCV.js）。',
        ],
        scanned: true,
      },
    };
  }

  const warnings: string[] = [];
  if (raw.skipped.texts) warnings.push(`过滤 ${raw.skipped.texts} 个文字字形路径（小 bbox 密度启发式）`);
  if (raw.skipped.ellipses) warnings.push(`跳过 ${raw.skipped.ellipses} 个椭圆`);

  const inf = opts.scale
    ? { scale: opts.scale, method: 'fixed' as const, warnings: [] as string[] }
    : inferPdfScale(raw);
  const r = buildDocFromRaw(raw, {
    name: opts.name,
    unit: 'pt', method: 'fixed',           // PDF 坐标天然是物理单位
    scale: inf.scale, scaleMethod: inf.method,
    warnings: [...warnings, ...inf.warnings],
  });
  r.info.scanned = false;                  // 显式：非扫描件（扫描件分支在上面已 return）
  return r;
}
