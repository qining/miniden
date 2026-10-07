/* =====================================================================
   src/geo/import-common.ts — Raw 原语 → ProjectDoc（S5/S6 共享管线）

   S5 的 import-dxf 把「DXF 实体 → Raw」和「Raw → ProjectDoc」写在一起；
   S6（PDF 导入）发现后半段（墙带配对 / 门洞 / 窗 / 柱 / 房间 / 变换）
   与格式无关，输入只有 Raw（源单位、y-up、逐段 cls）→ 抽到这里共享。

   **行为不变约束**：本文件是 import-dxf 对应代码的逐语句搬移
   （detectBands / transform / 映射全原样），95 条现有测试 + 3 个集成
   DXF 用例是行为基线。

   纯函数：禁 import three / document / localStorage（R7 模块图）。
   ===================================================================== */
import type { ProjectDoc, Wall, Window, Door, Solid, Room, Run } from '../schema/project';
import { fullCircle } from '../schema/primitives';

/* ---------------------------------------------------------------- 类型 */

export type Unit = 'mm' | 'cm' | 'm' | 'in' | 'ft' | 'yd' | 'mi' | 'pt';
export type UnitMethod = 'insunits' | 'heuristic' | 'fallback' | 'user' | 'fixed';
export type LayerClass = 'wall' | 'door' | 'window' | 'col' | 'furn' | 'room' | 'axis' | 'other';

export interface ImportInfo {
  unit: Unit;
  unitMethod: UnitMethod;
  extent: { w: number; h: number }; // m（换算后）
  counts: { walls: number; doors: number; windows: number; solids: number; rooms: number; runs: number };
  warnings: string[];
  /** 扫描件（S6 PDF）：doc 是空文档占位，UI 走降级提示，不 apply。 */
  scanned?: boolean;
  /** PDF：图纸比例（1:50 → 50）；DXF 无此字段（单位即实物单位） */
  scale?: number;
  scaleMethod?: UnitMethod;
}
export interface ImportResult {
  doc: ProjectDoc;
  info: ImportInfo;
}

export interface RawSeg {
  a: V2;
  b: V2;
  cls: LayerClass;
}
export interface RawArc {
  c: V2;
  r: number;
  s: number;
  e: number;
  cls: LayerClass;
  full: boolean;
}
export interface RawCircle {
  c: V2;
  r: number;
  cls: LayerClass;
}
export interface RawClosed {
  pts: V2[];
  cls: LayerClass;
}

export interface Raw {
  segs: RawSeg[];
  arcs: RawArc[];
  circles: RawCircle[];
  closed: RawClosed[];
  skipped: { ellipses: number; inserts: number; texts: number; other: number };
}

/* ---------------------------------------------------------------- 常量 */

export const UNIT_TO_M: Record<Unit, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  in: 0.0254,
  ft: 0.3048,
  yd: 0.9144,
  mi: 1609.344,
  pt: 0.0254 / 72,
};
export const M_TO_FT = 1 / 0.3048;
const FT_TO_M = 0.3048; // 文档单位 ft → m（detectBands 内部用米做阈值）

// 墙带配对参数（米）
const WALL_T_MIN = 0.04,
  WALL_T_MAX = 0.9; // 允许的墙厚区间
const PARALLEL_TOL = (1.5 * Math.PI) / 180; // 平行判定角度容差
const OVERLAP_FRAC = 0.5; // 配对最小投影重叠（较短段的比例）
const MERGE_GAP = 0.06; // 同墙段合并容差
const MIN_WALL_LEN = 0.3; // 最短墙段（m）
const DOOR_GAP_MIN = 0.55,
  DOOR_GAP_MAX = 1.6; // 门洞宽度区间
const LEAF_TOL = 0.35; // 门扇端点吸附容差
const WIN_TOL = 0.25; // 窗与墙中线距离容差
const SOLID_AREA = 4.0; // m²：< 柱/异形，≥ 房间轮廓
const COUNTER_H_M = 0.9; // 从图纸读出的柜体带的默认台面高（用户可改）
const DEFAULT_THICK = 0.1; // 单线墙默认厚（m）

/* ---------------------------------------------------------------- 工具 */

export interface V2 {
  x: number;
  y: number;
}
const v = (x: number, y: number): V2 => ({ x, y });
const sub = (a: V2, b: V2): V2 => v(a.x - b.x, a.y - b.y);
const add = (a: V2, b: V2): V2 => v(a.x + b.x, a.y + b.y);
const mul = (a: V2, s: number): V2 => v(a.x * s, a.y * s);
const dot = (a: V2, b: V2) => a.x * b.x + a.y * b.y;
const cross = (a: V2, b: V2) => a.x * b.y - a.y * b.x;
const len = (a: V2) => Math.hypot(a.x, a.y);
const norm = (a: V2): V2 => {
  const l = len(a) || 1;
  return v(a.x / l, a.y / l);
};
const distFt = (a: V2, b: V2) => Math.hypot(b.x - a.x, b.y - a.y);

const angleDiff = (a: number, b: number) => {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};
const f2 = (x: number) => Math.round(x * 10000) / 10000;
const d2r = Math.PI / 180;

/** 两线段是否平行（含反向）。 */
export function isParallel(a: V2, b: V2, c: V2, d: V2): boolean {
  const da = norm(sub(b, a)),
    db = norm(sub(d, c));
  const diff = Math.abs(angleDiff(Math.atan2(da.y, da.x), Math.atan2(db.y, db.x)));
  return diff < PARALLEL_TOL || Math.PI - diff < PARALLEL_TOL;
}
/** 点 p 到直线 a→b 的有符号距离（左正右负，相对 a→b 方向）。 */
export function signedDist(p: V2, a: V2, b: V2): number {
  return cross(norm(sub(b, a)), sub(p, a));
}
/** 两条（近似共线）线段的投影重叠 / 较短段长度。 */
export function overlapFrac(a: V2, b: V2, c: V2, d: V2): number {
  const La = len(sub(b, a)),
    Lb = len(sub(d, c));
  if (La < 1e-9 || Lb < 1e-9) return 0;
  const o = norm(sub(b, a));
  const t0 = dot(sub(c, a), o),
    t1 = dot(sub(d, a), o);
  const i0 = Math.max(0, Math.min(t0, t1)),
    i1 = Math.min(La, Math.max(t0, t1));
  return Math.max(0, i1 - i0) / Math.min(La, Lb);
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}
function mergeIntervals(ivs: { u0: number; u1: number }[], gapFt: number) {
  ivs.sort((a, b) => a.u0 - b.u0);
  const out: { u0: number; u1: number }[] = [];
  for (const iv of ivs) {
    const last = out[out.length - 1];
    if (last && iv.u0 - last.u1 <= gapFt) last.u1 = Math.max(last.u1, iv.u1);
    else out.push({ u0: iv.u0, u1: iv.u1 });
  }
  return out;
}

/* ---------------------------------------------------------------- 图层 */

/**
 * 图层名 → 语义类（DXF 用；PDF 用 classifyPdfColor 映射到同一集合）。
 * COL 严格匹配词边界：'colors'（QCAD 色样层）不能命中 'col'（真实集成数据里发生的误判）；
 * 'COL' / 'COLS' / 'COLUMN' / 'COLUMNS' / 'WALL-COLS' 都要命中。
 */
export function classifyLayer(name: string | undefined): LayerClass {
  const n = String(name ?? '').toUpperCase();
  if (!n || n === '0') return 'other';
  if (/WALL|墙/.test(n)) return 'wall';
  if (/DOOR|门/.test(n)) return 'door';
  if (/WIN|窗/.test(n)) return 'window';
  if (/\bCOL(?:S|UM(?:NS?)?)?\b|柱/.test(n)) return 'col';
  if (/FURN|家具/.test(n)) return 'furn';
  if (/ROOM|房间/.test(n)) return 'room';
  if (/AXIS|轴网|GRID|DIM|标注|TEXT|文字|HATCH|填充/.test(n)) return 'axis';
  return 'other';
}

/* ---------------------------------------------------------------- 单位 */

export interface UnitDetect {
  unit: Unit;
  method: UnitMethod;
}

/** 量级表（R1：酷家乐启发式）——240mm 砖墙在各单位下的标称值。
 *  pt（PDF 原生点）：240mm = 68.03pt。 */
export const UNIT_NOMINAL: Record<Unit, number> = {
  mm: 240,
  cm: 24,
  m: 0.24,
  in: 9.45,
  ft: 0.787,
  yd: 0.2625,
  mi: 0.000149,
  pt: 68.03,
};

/**
 * 墙厚样本必须是**源单位**数值（未换算）。
 * 把样本按邻近度分簇（同一量级内 ±35%），每个簇的中位数各对一次量级表，
 * 取「最佳簇」（分数最低）：户型里常见 120 内墙 + 240 外墙两种厚度，
 * 也可能混进「两堵平行墙」的远距样本——用分数而不是数量选簇，
 * 远距样本的簇对任何标称值分数都差，自然被排掉。
 */
export function detectUnitsFromSamples(wallThickSamplesSrc: number[]): {
  unit: Unit;
  method: 'heuristic' | 'fallback';
} {
  if (wallThickSamplesSrc.length) {
    const s = [...wallThickSamplesSrc].sort((a, b) => a - b);
    const groups: number[][] = [];
    for (const x of s) {
      const g = groups[groups.length - 1];
      if (g && x / g[g.length - 1]! - 1 < 0.35) g.push(x);
      else groups.push([x]);
    }
    let best: Unit = 'mm',
      bestScore = Infinity;
    for (const g of groups) {
      const est = median(g);
      (Object.keys(UNIT_NOMINAL) as Unit[]).forEach((u) => {
        const sc = Math.abs(est / UNIT_NOMINAL[u] - 1);
        if (sc < bestScore) {
          bestScore = sc;
          best = u;
        }
      });
    }
    if (bestScore < 1.5) return { unit: best, method: 'heuristic' };
  }
  return { unit: 'mm', method: 'fallback' };
}

/** 平行墙段间距样本（源单位）：供单位启发式。距离上限 = 包围盒短边的 30%（尺度自适应）。
 *  样本口径：平行 + 投影重叠 ≥ 0.5（与 detectBands 配对一致）——平行但相距超过短边
 *  30% 的是「两堵平行墙」，不是墙的两侧（绝对米值阈值不适用于源单位样本）。 */
export function wallThicknessSamples(raw: Raw): number[] {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const s of raw.segs) {
    for (const p of [s.a, s.b]) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  const shortSide = Number.isFinite(minX) ? Math.min(maxX - minX, maxY - minY) : Infinity;
  const cap = 0.3 * shortSide;
  const ws = raw.segs.filter((s) => s.cls === 'wall' || s.cls === 'other');
  const out: number[] = [];
  for (let i = 0; i < ws.length && out.length < 300; i++) {
    for (let j = i + 1; j < ws.length && out.length < 300; j++) {
      if (!isParallel(ws[i].a, ws[i].b, ws[j].a, ws[j].b)) continue;
      const d = Math.abs(signedDist(ws[j].a, ws[i].a, ws[i].b));
      if (d <= 1e-9 || d > cap) continue;
      if (overlapFrac(ws[i].a, ws[i].b, ws[j].a, ws[j].b) < OVERLAP_FRAC) continue;
      out.push(d);
    }
  }
  return out;
}

/* ---------------------------------------------------- 变换（ft、y-down） */

interface TSeg {
  a: V2;
  b: V2;
  cls: LayerClass;
  src: number;
}
interface TArc {
  c: V2;
  r: number;
  s: number;
  e: number;
  cls: LayerClass;
  full: boolean;
}
interface TCircle {
  c: V2;
  r: number;
  cls: LayerClass;
}
interface TClosed {
  pts: V2[];
  cls: LayerClass;
}

interface Transformed {
  segs: TSeg[];
  arcs: TArc[];
  circles: TCircle[];
  closed: TClosed[];
  extentM: { w: number; h: number };
  /** 过滤段 → 原始段下标（门扇兜底候选要区分「图纸 door 层」和「墙带成员」） */
  srcIdx: number[];
}

export function transform(raw: Raw, unit: Unit, scale = 1): Transformed {
  const k = UNIT_TO_M[unit] * scale * M_TO_FT; // 源单位 → ft（含图纸比例）
  const kM = UNIT_TO_M[unit] * scale; // 源单位 → m
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const feed = (p: V2) => {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };
  raw.segs.forEach((s) => {
    feed(s.a);
    feed(s.b);
  });
  for (const a of raw.arcs) {
    feed(add(a.c, v(a.r, a.r)));
    feed(add(a.c, v(-a.r, -a.r)));
    feed(add(a.c, v(a.r, -a.r)));
    feed(add(a.c, v(-a.r, a.r)));
  }
  for (const c of raw.circles) {
    feed(add(c.c, v(c.r, c.r)));
    feed(add(c.c, v(-c.r, -c.r)));
  }
  raw.closed.forEach((c) => c.pts.forEach(feed));
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 1;
    maxY = 1;
  }
  // y-up → y-down：(x, y) → (x−minX, −(y−maxY)) 使翻转后 y 最小角在 0
  const flip = (p: V2): V2 => v((p.x - minX) * k, (maxY - p.y) * k);
  const tf: Transformed = {
    segs: [],
    // y 翻转 (x,y)→(x,−y) 把角度 φ 映成 −φ 并且扫掠方向反转：
    // 弧的像 = 角度区间 [−e, −s]（沿 θ 增大方向）。只翻点不翻角会让消费端
    // （expand / SVG A）画出镜像弧、甚至补弧（bug 猎 #7）。
    // 整圆无所调（s/e 无意义，且取反会把 e−s 变成 −2π）。
    arcs: raw.arcs.map((a) => ({
      c: flip(a.c),
      r: a.r * k,
      s: a.full ? a.s : -a.e,
      e: a.full ? a.e : -a.s,
      cls: a.cls,
      full: a.full,
    })),
    circles: raw.circles.map((c) => ({ c: flip(c.c), r: c.r * k, cls: c.cls })),
    closed: raw.closed.map((c) => ({ pts: c.pts.map(flip), cls: c.cls })),
    extentM: { w: (maxX - minX) * kM, h: (maxY - minY) * kM },
    srcIdx: [],
  };
  // segs 与 srcIdx 用同一过滤条件（原始长度 > 2cm），保证下标一一对应
  const keep = raw.segs.map((s2) => len(sub(s2.b, s2.a)) * kM > 0.02);
  tf.srcIdx = raw.segs.map((_, i) => i).filter((i) => keep[i]);
  tf.segs = raw.segs
    .filter((_, i) => keep[i])
    .map((s, ri) => ({ a: flip(s.a), b: flip(s.b), cls: s.cls, src: tf.srcIdx[ri] }));
  return tf;
}

/* ------------------------------------------------------------ 墙带配对 */

export interface Band {
  dir: V2; // 主方向（单位）
  origin: V2; // 中线基准点（过 bbox 原点系的法向偏移处）
  offset: number; // 中线在法向上的坐标（dot(p, nrm)）
  thick: number; // ft
  intervals: { u0: number; u1: number }[]; // 沿线坐标（ft）
  memberSrc: number[]; // 参与段的原始下标（transform.srcIdx 同域）
}

/**
 * 平行线对 → 墙带（R1）：union-find 聚类；每带 = 主方向 + 中线 + 厚度 +
 * 沿线区间（端点间的小缝合并，门/窗大缝保留）。输入必须是 y-down ft。
 */
export function detectBands(segs: TSeg[]): Band[] {
  const wallIdx = segs
    .map((s, i) => (s.cls === 'wall' || s.cls === 'other' ? i : -1))
    .filter((i) => i >= 0 && distFt(segs[i].a, segs[i].b) >= MIN_WALL_LEN * M_TO_FT);
  const parent = wallIdx.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a: number, b: number) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const pairDs: { i: number; j: number; d: number }[] = []; // d = 米
  for (let a = 0; a < wallIdx.length; a++) {
    const A = segs[wallIdx[a]];
    for (let b = a + 1; b < wallIdx.length; b++) {
      const B = segs[wallIdx[b]];
      if (!isParallel(A.a, A.b, B.a, B.b)) continue;
      const dM = Math.abs(signedDist(B.a, A.a, A.b)) * FT_TO_M; // ft → m（输入是 ft）
      if (dM < WALL_T_MIN || dM > WALL_T_MAX) continue;
      if (overlapFrac(A.a, A.b, B.a, B.b) < OVERLAP_FRAC) continue;
      union(a, b);
      pairDs.push({ i: a, j: b, d: dM });
    }
  }
  const clusters = new Map<number, number[]>();
  wallIdx.forEach((_, i) => {
    const r = find(i);
    (clusters.get(r) ?? clusters.set(r, []).get(r)!).push(i);
  });
  const bands: Band[] = [];
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    const mSet = new Set(members);
    const ds = pairDs.filter((p) => mSet.has(p.i) || mSet.has(p.j)).map((p) => p.d);
    if (!ds.length) continue;
    const thickM = median(ds);
    // 方向：成员段可能反向（闭合轮廓边一左一右）——直接相加会抵消成 (0,0)，
    // 导致所有带被 mergeCollinearBands 归并成一条（真实 CAD 墙面数据暴露）。
    // 抵消时回退到最长成员段的方向（同一条线，取最长最稳）。
    let dx = 0,
      dy = 0,
      bestMi = members[0]!,
      bestL = -1;
    for (const mi of members) {
      const s = segs[wallIdx[mi]];
      const d = norm(sub(s.b, s.a));
      dx += d.x;
      dy += d.y;
      const L = distFt(s.a, s.b);
      if (L > bestL) {
        bestL = L;
        bestMi = mi;
      }
    }
    const L = Math.hypot(dx, dy);
    const dir = L < 1e-9 ? norm(sub(segs[wallIdx[bestMi]].b, segs[wallIdx[bestMi]].a)) : v(dx / L, dy / L);
    const nrm = v(-dir.y, dir.x);
    let off = 0;
    for (const mi of members) {
      const mid = mul(add(segs[wallIdx[mi]].a, segs[wallIdx[mi]].b), 0.5);
      off += dot(mid, nrm);
    }
    off /= members.length;
    const ivs: { u0: number; u1: number }[] = [];
    for (const mi of members) {
      const u0 = dot(segs[wallIdx[mi]].a, dir),
        u1 = dot(segs[wallIdx[mi]].b, dir);
      ivs.push({ u0: Math.min(u0, u1), u1: Math.max(u0, u1) });
    }
    bands.push({
      dir,
      origin: mul(nrm, off),
      offset: off,
      thick: thickM * M_TO_FT,
      intervals: mergeIntervals(ivs, MERGE_GAP * M_TO_FT),
      memberSrc: members.map((mi) => segs[wallIdx[mi]].src),
    });
  }
  // 共线带合并：union-find 只连「重叠」的平行对——同一条墙线被门洞/窗分成几段时
  // 会产生多个「同线」的带，这里按 (方向, 法向偏移) 归组后合并区间，门洞才能被看到。
  return mergeCollinearBands(bands);
}

function mergeCollinearBands(bands: Band[]): Band[] {
  if (bands.length < 2) return bands;
  const groups = new Map<string, Band[]>();
  for (const b of bands) {
    // 规范化方向到 [0, π)：翻转使 (x>0 或 x==0 且 y>0)。
    // 关键：dir 翻时 offset 必须跟着翻——法向 = dir 旋转 90°，翻 dir 就是翻法向，
    // 中线坐标跟着反号。旧版只归一化 dir，同一条墙线被门洞切成两簇、两簇段方向相反时
    // key 对不上（+0.394 vs −0.394）→ 不合并 → 缺口不存 → 导入户型丢门（bug 猎 #6）。
    let dx = b.dir.x,
      dy = b.dir.y;
    let koff = b.offset;
    if (dx < 0 || (dx === 0 && dy < 0)) {
      dx = -dx;
      dy = -dy;
      koff = -koff;
    }
    const key = `${dx.toFixed(3)}|${dy.toFixed(3)}|${(Math.abs(koff) < 1e-9 ? 0 : koff).toFixed(3)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(b);
  }
  const out: Band[] = [];
  for (const g of groups.values()) {
    if (g.length === 1) {
      out.push(g[0]);
      continue;
    }
    // 合并到第一条带的框架：反向带的沿线坐标取反（u → −u，区间端点跟着交换）、
    // 法向偏移取反。否则两套框架的区间会被当作同一坐标轴合并，墙会错位。
    const ref = g[0];
    const ivs: { u0: number; u1: number }[] = [];
    const srcs: number[] = [];
    let off = 0;
    const ths: number[] = [];
    for (const b of g) {
      const same = dot(b.dir, ref.dir) >= 0;
      for (const iv of b.intervals) ivs.push(same ? { u0: iv.u0, u1: iv.u1 } : { u0: -iv.u1, u1: -iv.u0 });
      srcs.push(...b.memberSrc);
      off += same ? b.offset : -b.offset;
      ths.push(b.thick);
    }
    off /= g.length;
    const dir = ref.dir;
    out.push({
      dir,
      origin: mul(v(-dir.y, dir.x), off),
      offset: off,
      thick: median(ths),
      intervals: mergeIntervals(ivs, MERGE_GAP * M_TO_FT),
      memberSrc: srcs,
    });
  }
  return out;
}

/* ------------------------------------------------------------ 主映射 */

export interface BuildDocOptions {
  name?: string;
  unit: Unit;
  method: UnitMethod;
  warnings?: string[];
  /** 图纸比例（PDF：1:50 → 50）；DXF 恒为 1 */
  scale?: number;
  scaleMethod?: UnitMethod;
}

/**
 * Raw（源单位、y-up、逐段 cls）→ ProjectDoc + ImportInfo（S5/S6 共享）。
 * 单位 = opts.unit（DXF：INSUNITS/启发式/用户；PDF：固定 pt）；
 * 全部几何换算成文档原生 ft（y-down），实体 src:'user' + userIndex。
 */
export function buildDocFromRaw(raw: Raw, opts: BuildDocOptions): ImportResult {
  const warnings = [...(opts.warnings ?? [])];
  const unit = opts.unit;
  const method = opts.method;
  const scale = opts.scale ?? 1;

  const tf = transform(raw, unit, scale);
  const maxDim = Math.max(tf.extentM.w, tf.extentM.h);
  if (maxDim < 0.5)
    warnings.push(`整图量级偏小（${tf.extentM.w.toFixed(1)}×${tf.extentM.h.toFixed(1)}m），单位可能没检测对`);
  else if (maxDim > 200)
    warnings.push(`整图量级偏大（${tf.extentM.w.toFixed(0)}×${tf.extentM.h.toFixed(0)}m），单位可能没检测对`);

  // 噪点过滤：< 2% 最大边（且 ≥10cm）的段
  const minLenFt = Math.max(0.1 * M_TO_FT, maxDim * 0.02 * M_TO_FT);
  const segs = tf.segs.filter((s) => distFt(s.a, s.b) >= minLenFt);
  const circles = tf.circles.filter((c) => c.r >= 0.05 * M_TO_FT);

  // ---- 墙 ----
  const bands = detectBands(segs);
  const walls: Wall[] = [];
  const wallSeq = { n: 0 };
  const mkWallId = () => 'w' + String(++wallSeq.n).padStart(2, '0');
  const bandWallId: (string | null)[] = bands.map(() => null);
  {
    for (let bi = 0; bi < bands.length; bi++) {
      const bd = bands[bi];
      for (const iv of bd.intervals) {
        const a = pointOnLine(bd, iv.u0),
          b = pointOnLine(bd, iv.u1);
        if (distFt(a, b) < minLenFt) continue;
        const id = mkWallId();
        bandWallId[bi] = id;
        walls.push({
          id,
          kind: bd.thick < 0.07 * M_TO_FT ? 'thin' : 'wall',
          geom: { t: 'seg', x1: a.x, y1: a.y, x2: b.x, y2: b.y },
          thick: f2(bd.thick),
          src: 'user',
          userIndex: walls.length,
        });
      }
    }
    // 未入带的单线墙（只算墙类层）
    const inBand = new Set<number>();
    for (let i = 0; i < segs.length; i++)
      for (let bi = 0; bi < bands.length; bi++)
        if (segOnBand(segs[i], bands[bi])) {
          inBand.add(i);
          break;
        }
    for (let i = 0; i < segs.length; i++) {
      if (inBand.has(i)) continue;
      if (segs[i].cls !== 'wall' && segs[i].cls !== 'other') continue;
      walls.push({
        id: mkWallId(),
        kind: 'wall',
        geom: { t: 'seg', x1: segs[i].a.x, y1: segs[i].a.y, x2: segs[i].b.x, y2: segs[i].b.y },
        thick: f2(DEFAULT_THICK * M_TO_FT),
        src: 'user',
        userIndex: walls.length,
      });
    }
  }

  // ---- 门（墙带缺口 [0.55,1.6]m）----
  // 门扇吸附：优先 door 层；找不到再用 other 层的「游离段」兜底（但游离段
  // 必须先被 door 类候选耗尽，否则会误吃）。
  const doors: Door[] = [];
  {
    let n = 0;
    for (let bi = 0; bi < bands.length; bi++) {
      const bd = bands[bi];
      const ivs = bd.intervals;
      for (let k = 0; k + 1 < ivs.length; k++) {
        const gap0 = ivs[k].u1,
          gap1 = ivs[k + 1].u0;
        const gapM = (gap1 - gap0) * FT_TO_M;
        if (gapM < DOOR_GAP_MIN || gapM > DOOR_GAP_MAX) continue;
        const a = pointOnLine(bd, gap0),
          b = pointOnLine(bd, gap1);
        let leaf: { a: V2; b: V2; hinge: 0 | 1 } | null = null;
        for (const cand of segs) {
          if (cand.cls === 'wall' || cand.cls === 'window' || bd.memberSrc.includes(cand.src)) continue;
          const la = distFt(cand.a, cand.b) * FT_TO_M;
          if (la < 0.4 || la > 1.8) continue;
          const dC = norm(sub(cand.b, cand.a));
          const ang = Math.abs(angleDiff(Math.atan2(dC.y, dC.x), Math.atan2(bd.dir.y, bd.dir.x)));
          if (Math.abs(ang - Math.PI / 2) > 30 * d2r) continue;
          if (distFt(cand.a, a) < LEAF_TOL * M_TO_FT || distFt(cand.b, a) < LEAF_TOL * M_TO_FT) {
            leaf = { a: cand.a, b: cand.b, hinge: 0 };
            break;
          }
          if (distFt(cand.a, b) < LEAF_TOL * M_TO_FT || distFt(cand.b, b) < LEAF_TOL * M_TO_FT) {
            leaf = { a: cand.b, b: cand.a, hinge: 1 };
            break;
          }
        }
        if (!leaf) {
          const nrm = v(-bd.dir.y, bd.dir.x);
          const L = Math.min(gapM, 0.9) * M_TO_FT;
          leaf = { a, b: add(a, mul(nrm, L)), hinge: 0 };
        }
        const uMid = (gap0 + gap1) / 2;
        const uStart = ivs[0].u0,
          uEnd = ivs[ivs.length - 1].u1;
        const pos = uEnd > uStart ? Math.max(0, Math.min(1, (uMid - uStart) / (uEnd - uStart))) : 0.5;
        const side: 1 | -1 = cross(bd.dir, sub(leaf.b, leaf.a)) > 0 ? 1 : -1;
        doors.push({
          id: 'd' + String(++n).padStart(2, '0'),
          geom: { t: 'seg', x1: leaf.a.x, y1: leaf.a.y, x2: leaf.b.x, y2: leaf.b.y },
          gapGeom: { t: 'seg', x1: a.x, y1: a.y, x2: b.x, y2: b.y },
          wallId: bandWallId[bi],
          pos: f2(pos),
          width: f2(distFt(leaf.a, leaf.b)),
          kind: 'swing',
          hinge: leaf.hinge,
          side,
          src: 'user',
          userIndex: doors.length,
        });
      }
    }
  }

  // ---- 窗（window 层段 × 墙带 / 单线墙）----
  // 单线墙（未入带的墙候选段）也当「墙线」用：窗压在它上面即可。
  const windows: Window[] = [];
  {
    let n = 0;
    for (const s of segs) {
      if (s.cls !== 'window') continue;
      const w = distFt(s.a, s.b) * FT_TO_M;
      if (w < 0.3 || w > 6) continue;
      let placed = false;
      for (let bi = 0; bi < bands.length && !placed; bi++) {
        const bd = bands[bi];
        if (!segOnBand(s, bd, WIN_TOL * M_TO_FT)) continue;
        placed = true;
        const u0 = dot(s.a, bd.dir),
          u1 = dot(s.b, bd.dir);
        const uMid = (u0 + u1) / 2;
        const uStart = bd.intervals[0].u0,
          uEnd = bd.intervals[bd.intervals.length - 1].u1;
        const pos = uEnd > uStart ? Math.max(0, Math.min(1, (uMid - uStart) / (uEnd - uStart))) : 0.5;
        windows.push({
          id: 'win' + String(++n).padStart(2, '0'),
          geom: { t: 'seg', x1: s.a.x, y1: s.a.y, x2: s.b.x, y2: s.b.y },
          wallId: bandWallId[bi],
          pos: f2(pos),
          width: f2(w * M_TO_FT),
          sill: f2(0.9 * M_TO_FT),
          head: f2(2.4 * M_TO_FT),
          style: 'fixed',
          frame: '#17181b',
          glass: 0.75,
          src: 'user',
          userIndex: windows.length,
        });
      }
      if (placed) continue;
      // 单线墙兜底
      for (let i = 0; i < segs.length; i++) {
        const wl = segs[i];
        if (wl.cls !== 'wall' && wl.cls !== 'other') continue;
        if (bands.some((b) => b.memberSrc.includes(wl.src))) continue;
        const wdir = norm(sub(wl.b, wl.a));
        const wline: Band = {
          dir: wdir,
          origin: mul(v(-wdir.y, wdir.x), dot(wl.a, v(-wdir.y, wdir.x))),
          offset: dot(wl.a, v(-wdir.y, wdir.x)),
          thick: DEFAULT_THICK * M_TO_FT,
          intervals: [],
          memberSrc: [wl.src],
        };
        if (!segOnBand(s, wline, WIN_TOL * M_TO_FT)) continue;
        const d = wdir;
        const u0 = dot(s.a, d),
          u1 = dot(s.b, d);
        const uMid = (u0 + u1) / 2;
        const uA = dot(wl.a, d),
          uB = dot(wl.b, d);
        const uStart = Math.min(uA, uB),
          uEnd = Math.max(uA, uB);
        const pos = uEnd > uStart ? Math.max(0, Math.min(1, (uMid - uStart) / (uEnd - uStart))) : 0.5;
        const wall = walls.find(
          (x) =>
            x.geom.t === 'seg' &&
            Math.abs(x.geom.x1 - wl.a.x) < 0.001 &&
            Math.abs(x.geom.y1 - wl.a.y) < 0.001 &&
            Math.abs(x.geom.x2 - wl.b.x) < 0.001 &&
            Math.abs(x.geom.y2 - wl.b.y) < 0.001
        );
        windows.push({
          id: 'win' + String(++n).padStart(2, '0'),
          geom: { t: 'seg', x1: s.a.x, y1: s.a.y, x2: s.b.x, y2: s.b.y },
          wallId: wall?.id ?? null,
          pos: f2(pos),
          width: f2(w * M_TO_FT),
          sill: f2(0.9 * M_TO_FT),
          head: f2(2.4 * M_TO_FT),
          style: 'fixed',
          frame: '#17181b',
          glass: 0.75,
          src: 'user',
          userIndex: windows.length,
        });
        placed = true;
        break;
      }
    }
  }

  // ---- 柱 / 房间（闭合环 + 圆）----
  const solids: Solid[] = [];
  const rooms: Room[] = [];
  const runs: Run[] = [];
  let nNonCol = 0; // 图纸未归入柱层的小闭合轮廓数（警告用，见下方）
  {
    let ns = 0,
      nr = 0,
      nn = 0;
    for (const c of tf.closed) {
      const areaM2 = polyAreaM(c.pts);
      // S12：家具层的「浅而长」闭合轮廓 = 从图纸**读**出来的柜体带（不是猜厨房在哪）。
      // 判据只看形状：一个方向 ≤0.75m（柜体深度量级）、另一个方向 ≥1.0m（沿墙长度）。
      // 靠墙的那条长边当 path（前沿贴墙），深度取轮廓在该方向上的实际延伸。
      if (c.cls === 'furn') {
        const rr = runFromContour(c.pts, bands);
        if (rr) {
          rr.id = 'rn' + String(++nn).padStart(2, '0');
          rr.userIndex = runs.length;
          runs.push(rr);
          continue;
        }
      }
      if (areaM2 < SOLID_AREA) {
        /* 「柱」的判据是图纸自己的分类（col 层），不是面积大小。真实图纸里小面积闭合轮廓
           多半是家具/设备轮廓（QCAD 样例 29 个、无一在 col 层），把它们立成到顶的墙就是错的。
           column 决定这件东西在 3D 里立不立起来、以及它算不算结构实体。 */
        const isCol = c.cls === 'col';
        if (!isCol) nNonCol++;
        solids.push({
          id: 'p' + String(++ns).padStart(2, '0'),
          name: isCol ? '柱' : '',
          geom: { t: 'poly', pts: c.pts.map((p) => [f2(p.x), f2(p.y)] as [number, number]) },
          fill: '#8a919c',
          column: isCol,
          src: 'user',
          userIndex: solids.length,
        });
      } else {
        const ctr = polyCentroid(c.pts);
        const bb = polyBboxM(c.pts);
        rooms.push({
          id: 'rm' + String(++nr).padStart(2, '0'),
          label: `房间 ${nr}`,
          pos: [f2(ctr.x), f2(ctr.y)],
          wd: f2(bb.w * M_TO_FT),
          dp: f2(bb.d * M_TO_FT),
        });
      }
    }
    for (const c of circles) {
      if (c.r * FT_TO_M < 1.5) {
        solids.push({
          id: 'p' + String(++ns).padStart(2, '0'),
          name: '柱',
          geom: fullCircle(f2(c.c.x), f2(c.c.y), f2(c.r)),
          fill: '#8a919c',
          column: true,
          src: 'user',
          userIndex: solids.length,
        });
      }
    }
  }

  if (raw.skipped.inserts) warnings.push(`跳过 ${raw.skipped.inserts} 个块引用（未展开，门/窗符号可能缺失）`);
  // bug 猎 #9：图纸没说是柱的闭合轮廓只在 2D 画成灰色块，3D 不立实体——必须说出来，
  // 否则用户看到的是「3D 里少了个东西」而且不知道为什么。
  if (nNonCol)
    warnings.push(
      `${nNonCol} 个闭合轮廓读成 2D 灰色块（图纸未归入柱层 → 3D 不立实体）；若是柱/墙块，请用墙体工具画闭合轮廓`
    );
  if (raw.skipped.ellipses) warnings.push(`跳过 ${raw.skipped.ellipses} 个椭圆`);
  // v1 的墙/门/窗只认直线段（ADR-0002：弧墙是将来）——弧被丢弃必须说出来，
  // 否则用户只看到「墙少了一截」而不知道为什么（bug 猎 #8）。
  if (tf.arcs.length) warnings.push(`${tf.arcs.length} 段圆弧未读入（v1 只读直线段）——曲线墙请在编辑器里用短段描出`);
  if (walls.length === 0) warnings.push('未检出墙体——请检查图层/单位，或在编辑器里手画');
  if (runs.length)
    warnings.push(`${runs.length} 个家具轮廓按柜体带读入（深度取轮廓实际延伸、台面高默认 0.9m，可在「台面」工具里改）`);

  return {
    doc: {
      schema: 1,
      name: opts.name ?? '导入户型',
      units: 'cm',
      ceilingH: 8.8,
      northRotation: 0,
      walls,
      windows,
      doors,
      solids,
      rooms,
      fixtures: [],
      runs,
      patio: null,
      env: { preset: 'seattle-city', mode: 'day' },
      hidden: { walls: [], windows: [], doors: [], solids: [] },
    },
    info: {
      unit,
      unitMethod: method,
      extent: { w: f2(tf.extentM.w), h: f2(tf.extentM.h) },
      counts: {
        walls: walls.length,
        doors: doors.length,
        windows: windows.length,
        solids: solids.length,
        rooms: rooms.length,
        runs: runs.length,
      },
      warnings,
      ...(opts.scale !== undefined || opts.scaleMethod !== undefined ? { scale, scaleMethod: opts.scaleMethod } : {}),
    },
  };
}

/* ------------------------------------------------------------ 辅助 */

/** 家具层闭合轮廓 → 台面 run（读几何，不猜位置）。返回的 doc 坐标是 ft。 */
function runFromContour(pts: V2[], bands: Band[]): Run | null {
  if (pts.length < 3) return null;
  const bb = polyBboxM(pts);
  const mn = Math.min(bb.w, bb.d),
    mx = Math.max(bb.w, bb.d);
  if (mn > 0.75 || mx < 1.0) return null; // 不是柜体带形状（床/桌子会走 solid）
  const edges: { a: V2; b: V2; L: number; onWall: boolean }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i],
      b = pts[(i + 1) % pts.length];
    const L = len(sub(b, a));
    if (L < 1e-6) continue;
    edges.push({ a, b, L, onWall: bands.some((bd) => segOnBand({ a, b }, bd, 0.06 * M_TO_FT)) });
  }
  if (!edges.length) return null;
  const wallEdges = edges.filter((e) => e.onWall);
  const pick = (wallEdges.length ? wallEdges : edges).sort((x, y) => y.L - x.L)[0];
  const d = norm(sub(pick.b, pick.a));
  const n = v(-d.y, d.x);
  let maxOff = 0;
  for (const p of pts) maxOff = Math.max(maxOff, Math.abs(dot(sub(p, pick.a), n)));
  if (maxOff < 0.1) return null;
  return {
    id: '',
    src: 'user',
    path: [
      [f2(pick.a.x), f2(pick.a.y)],
      [f2(pick.b.x), f2(pick.b.y)],
    ],
    depth: f2(maxOff),
    topH: f2(COUNTER_H_M * M_TO_FT),
    h: f2(0.6 * M_TO_FT),
  };
}

function pointOnLine(bd: Band, u: number): V2 {
  return add(bd.origin, mul(bd.dir, u));
}
/** 段是否在墙带上（近平行 + 中线偏移在容差内）。输入 y-down ft。 */
export function segOnBand(s: { a: V2; b: V2 }, bd: Band, tolFt = 0.05 * M_TO_FT): boolean {
  const d = norm(sub(s.b, s.a));
  const diff = Math.abs(angleDiff(Math.atan2(d.y, d.x), Math.atan2(bd.dir.y, bd.dir.x)));
  if (diff > PARALLEL_TOL && Math.PI - diff > PARALLEL_TOL) return false;
  const nrm = v(-bd.dir.y, bd.dir.x);
  const bandTol = tolFt + bd.thick;
  return Math.abs(dot(s.a, nrm) - bd.offset) < bandTol && Math.abs(dot(s.b, nrm) - bd.offset) < bandTol;
}
function polyAreaM(pts: V2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i],
      q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  // pts 已是 ft（transform 后）→ ft² → m²
  return Math.abs(a / 2) / (M_TO_FT * M_TO_FT);
}
function polyCentroid(pts: V2[]): V2 {
  let x = 0,
    y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return v(x / pts.length, y / pts.length);
}
function polyBboxM(pts: V2[]): { w: number; d: number } {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  // pts 是 ft → 返回 m
  return { w: (maxX - minX) / M_TO_FT, d: (maxY - minY) / M_TO_FT };
}
