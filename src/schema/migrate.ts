/* =====================================================================
   src/schema/migrate.ts — 一次性迁移：legacy（常量 + USERGEO 索引覆盖）→ v1 文档
   以及反向投影：v1 文档 → legacy 线格式（渲染层过渡期消费，Phase 2 用）

   无损性（本模块的验收定义，tests/schema/migrate.test.ts 守着）：
       docToLegacy(migrate(legacy, userGeo))  ≡  effWalls/effFixed/effDoors()
   —— 对空 USERGEO 与任意合成 USERGEO 都逐字段相等（含 _src/_i）。
   要点：所有端点数值**原样透传**（不做重算/舍入）；ov 覆盖用
   Object.assign 复刻原语义；隐藏条目留在实体数组里、由 hidden.* 过滤。

   纯模块：禁 import three / document（R7）。
   ===================================================================== */

import { dist, segLen, type Pt, type Geom, type Seg } from './primitives';
import type {
  ProjectDoc, Wall, Window, Door, Solid,
  WindowStyle, DoorKind, FixtureType,
} from './project';
import { blankDoc, nextId } from './project';

/* ---------------------------------------------------------------------
   legacy 形状（= planner.html 现状；fixture 里存的就是这个）
   注意（e73cb45 起）：几何主体已是 ft 原生（W/WSPLIT/DR/CP 定义时就 /SC）；
   仅 FX 仍是图纸 px。wd 仍是图纸 px（6.5 / 3.5 / 自定义）。
   ------------------------------------------------------------------- */

export interface LegacySeg {
  x1: number; y1: number; x2: number; y2: number;   // ft
  t: 'w' | 'g' | 'd' | 'o' | 'i';   // o = 开口（用户手绘，与门洞 'd' 的区别：3D 无过梁）
  wd?: number;          // 图纸 px（缺省按类型：墙 6.5 / 窗 3.5）
  fc?: boolean;         // 落地（全高）
  slider?: boolean;     // 推拉
  steel?: boolean;      // 钢梁带
}
export interface LegacyDoor {
  x1: number; y1: number; x2: number; y2: number;   // ft
  kind: string; hinge: number; side: number; wood: boolean;
}
export interface LegacyFixed { name?: string; poly: Pt[]; fill: string; noCal?: boolean }  // ft
export interface LegacyLabel { p: Pt; t: string; wd?: number; dp?: number; d?: string; rot?: number; small?: boolean }  // ft
export interface LegacyFx { t: string; x1: number; y1: number; x2: number; y2: number; dir?: string; fa?: string; open?: string }  // 图纸 px

export interface LegacyGeo {
  sc: number;                     // 图纸 px/ft（= 11.2；fixture 里存 meta.sc）
  walls: LegacySeg[];
  inner: LegacySeg[];
  doors: LegacyDoor[];
  fixed: LegacyFixed[];
  labels: LegacyLabel[];
  fx: LegacyFx[];                 // 图纸 px
  patio: Pt[];                    // ft
  isl?: unknown;                  // 中岛（文档范围外，留档）
}

export interface LegacyUserGeo {
  walls: Partial<LegacySeg>[];
  polys: { name?: string; pts: Pt[] }[];
  doors: Partial<LegacyDoor>[];
  hiddenW: number[]; hiddenP: number[]; hiddenD: number[];
  ovW: Record<string, Partial<LegacySeg>>;
  ovP: Record<string, { poly: Pt[] }>;
  ovD: Record<string, Partial<LegacyDoor>>;
}

export const EMPTY_USERGEO: LegacyUserGeo = {
  walls: [], polys: [], doors: [],
  hiddenW: [], hiddenP: [], hiddenD: [],
  ovW: {}, ovP: {}, ovD: {},
};

/* ---------------------------------------------------------------------
   常量（与 planner.html 一致）
   ------------------------------------------------------------------- */

const FT_PER_M = 1 / 0.3048;
const SILL_M = 0.67;     // 窗台高（现状全局写死）
const HEAD_M = 2.25;     // 过梁顶高（现状全局写死）
const GAP_TOL = 0.05;    // ft；门扇端点与门洞段的匹配容差（入户门 ~0.2px 内缩）
const DEFAULT_FRAME = '#1c2528';
const DEFAULT_GLASS = 0.18;

const segGeom = (s: { x1: number; y1: number; x2: number; y2: number }): Seg =>
  ({ t: 'seg', x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 });

const merge = <T extends object>(base: T, ov?: Partial<T>): T => (ov ? Object.assign({}, base, ov) : { ...base });

/* ---------------------------------------------------------------------
   migrate：legacy + USERGEO → v1 文档
   ------------------------------------------------------------------- */

export function migrateLegacyToV1(geo: LegacyGeo, user: LegacyUserGeo = EMPTY_USERGEO): ProjectDoc {
  const sc = geo.sc;
  const doc = blankDoc('西雅图 2室2卫');
  doc.sc = sc;
  const { walls, windows, doors, solids, rooms, fixtures } = doc;

  // —— 链段：w/i → wall；g → window；d → 缺口（配到门上，否则 opening）——
  const gapByIndex = new Map<number, LegacySeg>();
  for (let i = 0; i < geo.walls.length; i++) {
    const s = geo.walls[i];
    if (s.t === 'd') gapByIndex.set(i, merge(s, user.ovW[i]));
  }
  // 门扇 ↔ 门洞 配对（端点容差；双向尝试）
  const gapOfDoor = (d: LegacyDoor): { seg: LegacySeg; index: number } | null => {
    for (const [i, g] of gapByIndex) {
      const a = [[g.x1, g.y1], [g.x2, g.y2]] as Pt[];
      const b = [[d.x1, d.y1], [d.x2, d.y2]] as Pt[];
      if ((dist(a[0], b[0]) < GAP_TOL && dist(a[1], b[1]) < GAP_TOL) ||
          (dist(a[0], b[1]) < GAP_TOL && dist(a[1], b[0]) < GAP_TOL)) return { seg: g, index: i };
    }
    return null;
  };

  const winFromSeg = (s: LegacySeg, i: number, src: 'builtin' | 'user', sc: number, uIdx?: number): Window => {
    const fullHeight = !!s.fc;
    const style: WindowStyle = s.slider ? 'slide' : 'fixed';
    return {
      id: src === 'builtin' ? `n${i + 1}` : nextId({ walls, windows, doors, solids, rooms, fixtures }, 'window'),
      geom: segGeom(s),
      wallId: null,
      pos: 0.5,
      width: segLen(segGeom(s)),
      sill: fullHeight ? 0 : SILL_M * FT_PER_M,
      head: fullHeight ? doc.ceilingH : HEAD_M * FT_PER_M,
      style,
      fullHeight,
      frame: s.steel ? '#2b2f36' : DEFAULT_FRAME,
      glass: DEFAULT_GLASS,
      steel: s.steel || undefined,
      src,
      chainIndex: src === 'builtin' ? i : undefined,
      userIndex: uIdx,
      thick: s.wd != null ? s.wd / sc : undefined,
      wdPx: s.wd ?? undefined,
    };
  };

  for (let i = 0; i < geo.walls.length; i++) {
    const s = merge(geo.walls[i], user.ovW[i]);
    if (s.t === 'w' || s.t === 'i') {
      walls.push({
        id: `w${i + 1}`,
        kind: s.t === 'i' ? 'thin' : 'wall',
        geom: segGeom(s),
        thick: s.wd != null ? s.wd / sc : undefined,
        wdPx: s.wd ?? undefined,
        src: 'builtin',
        chainIndex: i,
      });
    } else if (s.t === 'g') {
      windows.push(winFromSeg(s, i, 'builtin', sc));
    } else { // 'd'/'o'：缺口。v1 链上保留为实体（门扇另在 doors[]）；
      // 重放路径会把用户开口段物化进内置列表，wd 必须保留否则重放丢字段
      walls.push({
        id: `w${i + 1}`,
        kind: s.t === 'd' ? 'opening' : 'passage',
        geom: segGeom(s),
        thick: s.wd != null ? s.wd / sc : undefined,
        wdPx: s.wd ?? undefined,
        src: 'builtin',
        chainIndex: i,
      });
    }
  }
  // 内置细线（INNER）与中岛（ISL）同为文档范围外特例：INNER 由 build2D
  // 独立消费（不经 effWalls），并入文档链会改变投影输出；S3 文档成为唯一
  // 几何源时再收编（kind 'thin' + 独立图层标记）。

  // 用户新增链段（USERGEO.walls：w/g/i 混合，_i 用原数组下标）
  user.walls.forEach((u, i) => {
    const s = u as LegacySeg;
    if (s.t === 'g') {
      windows.push(winFromSeg(s, i, 'user', sc, i));
    } else {
      walls.push({
        id: nextId(doc, 'wall'),
        kind: s.t === 'i' ? 'thin' : s.t === 'd' ? 'opening' : s.t === 'o' ? 'passage' : 'wall',
        geom: segGeom(s),
        thick: s.wd != null ? s.wd / sc : undefined,
        wdPx: s.wd ?? undefined,
        src: 'user',
        userIndex: i,
      });
    }
  });

  // —— 门扇（含 USERGEO.doors）——
  const doorFromLegacy = (d: LegacyDoor, i: number, src: 'builtin' | 'user', uIdx?: number): Door => {
    const gap = src === 'builtin' ? gapOfDoor(d) : null;
    const kind: DoorKind = (['swing', 'double', 'slide', 'bifold'].includes(d.kind) ? d.kind : 'swing') as DoorKind;
    return {
      id: src === 'builtin' ? `d${i + 1}` : nextId(doc, 'door'),
      geom: segGeom(d),
      gapGeom: gap ? segGeom(gap.seg) : undefined,
      wallId: gap ? `w${gap.index + 1}` : null,
      pos: 0.5,
      width: segLen(segGeom(gap ? gap.seg : d)),
      kind,
      hinge: (d.hinge === 0 || d.hinge === 1) ? d.hinge : 0,
      side: (d.side === 1 || d.side === -1) ? d.side : 1,
      dark: d.wood || undefined,
      src,
      chainIndex: src === 'builtin' ? i : undefined,
      userIndex: uIdx,
    };
  };
  for (let i = 0; i < geo.doors.length; i++) {
    const d = merge(geo.doors[i], user.ovD[i]);
    doors.push(doorFromLegacy(d, i, 'builtin'));
  }
  user.doors.forEach((d, i) => doors.push(doorFromLegacy(d as LegacyDoor, i, 'user', i)));

  // —— 实心块（FIXED + USERGEO.polys）——
  for (let i = 0; i < geo.fixed.length; i++) {
    const f = geo.fixed[i];
    const ov = user.ovP[i];
    // 容忍两种 poly 形态：真数组（常规）或 {poly:数组}（legacy effFixed 对 ovP 覆盖的包裹形态，
    // 可重放性：doc→legacy 再 migrate 时输入就是包裹形态）
    const rawPoly = (x: unknown): Pt[] | null =>
      Array.isArray(x) ? x as Pt[] : (x && typeof x === 'object' && Array.isArray((x as {poly?: unknown}).poly) ? (x as {poly: Pt[]}).poly : null);
    const ovPts = ov ? (ov as { poly?: unknown }).poly ?? null : null;
    const pts = (ovPts && rawPoly(ovPts)) ?? rawPoly(f.poly) ?? f.poly;
    solids.push({
      id: `s${i + 1}`,
      name: f.name || undefined,
      geom: { t: 'poly', pts: pts.map(p => [p[0], p[1]] as Pt) },
      fill: f.fill,
      noCal: f.noCal || undefined,
      column: f.name === '柱' ? true : undefined,
      ovWrapped: (ovPts || rawPoly(f.poly) !== f.poly) ? true : undefined,
      src: 'builtin',
      chainIndex: i,
    });
  }
  user.polys.forEach((p, i) => solids.push({
    id: nextId(doc, 'solid'),
    name: p.name || undefined,
    geom: { t: 'poly', pts: p.pts.map(q => [q[0], q[1]] as Pt) },
    fill: '#0c0d0f',
    src: 'user',
    chainIndex: i,
    userIndex: i,
  }));

  // —— 阳台 / 房间 / 洁具 / 环境 ——
  if (geo.patio.length >= 3) doc.patio = { geom: { t: 'poly', pts: geo.patio.map(p => [p[0], p[1]] as Pt) } };
  geo.labels.forEach((l, i) => rooms.push({
    id: `r${i + 1}`,
    label: l.t,
    pos: [l.p[0], l.p[1]],
    wd: l.wd,
    dp: l.dp,
    d: l.d || undefined,
    rot: l.rot,
    small: l.small || undefined,
    chainIndex: i,
  }));
  geo.fx.forEach((f, i) => fixtures.push({
    id: `f${i + 1}`,
    t: (['counter', 'basin', 'toilet', 'tub', 'shower', 'mirror'].includes(f.t) ? f.t : 'counter') as FixtureType,
    x1: f.x1 / sc, y1: f.y1 / sc, x2: f.x2 / sc, y2: f.y2 / sc,
    dir: f.dir, fa: f.fa, open: f.open,
    chainIndex: i,
  }));

  // —— hidden（索引 → id）——
  user.hiddenW.forEach(i => {
    const s = geo.walls[i];
    if (s.t === 'g') doc.hidden.windows.push(`n${i + 1}`);
    else doc.hidden.walls.push(`w${i + 1}`);
  });
  user.hiddenP.forEach(i => doc.hidden.solids.push(`s${i + 1}`));
  user.hiddenD.forEach(i => doc.hidden.doors.push(`d${i + 1}`));

  return doc;
}

/* ---------------------------------------------------------------------
   docToLegacy：v1 文档 → legacy 线格式（渲染层过渡期消费）
   输出与 effWalls/effFixed/effDoors 的返回完全同形（含 _src/_i）。
   ------------------------------------------------------------------- */

export type LegacySegOut = LegacySeg & { _src: 'b' | 'u'; _i: number };
export type LegacyFixedOut = { name: string; poly: Pt[] | { poly: Pt[] }; fill: string; noCal?: boolean; _src: 'b' | 'u'; _i: number };
export type LegacyDoorOut = LegacyDoor & { _src: 'b' | 'u'; _i: number };

export interface LegacyProjection {
  walls: LegacySegOut[];
  fixed: LegacyFixedOut[];
  doors: LegacyDoorOut[];
}

const geomToSeg = (g: Geom): Seg => {
  if (g.t === 'seg') return { t: 'seg', x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2 };
  throw new Error('docToLegacy: legacy 投影只支持 seg（arc/poly 由消费端 expand，S3 起）');
};

export function docToLegacy(doc: ProjectDoc): LegacyProjection {
  const walls: LegacySegOut[] = [];
  const hiddenW = new Set(doc.hidden.walls);
  const hiddenWin = new Set(doc.hidden.windows);
  const hiddenDoor = new Set(doc.hidden.doors);
  const hiddenSol = new Set(doc.hidden.solids);

  // 链：内置在前（按 chainIndex = 原数组序），用户在后（按 userIndex = 原 USERGEO.walls 序）；
  // 窗与墙在**同一索引空间**内交错（legacy effWalls 把窗 inline 在原位，用户窗不能掉到队尾）
  const chain: (Wall | Window)[] = [...doc.walls, ...doc.windows];
  chain.sort((a, b) => {
    const as = a.src === 'builtin' ? 0 : 1, bs = b.src === 'builtin' ? 0 : 1;
    const ai = a.src === 'builtin' ? (a.chainIndex ?? 0) : (a.userIndex ?? 0);
    const bi = b.src === 'builtin' ? (b.chainIndex ?? 0) : (b.userIndex ?? 0);
    return (as - bs) || (ai - bi);
  });
  for (const e of chain) {
    const isWin = !('kind' in e);
    if (isWin) {
      const w = e as Window;
      if (hiddenWin.has(w.id)) continue;
      const g = geomToSeg(w.geom);
      // 键序必须与 effWalls 一致：t → fc → slider → steel → wd → _src/_i
      walls.push({
        x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, t: 'g',
        ...(w.fullHeight ? { fc: true } : {}),
        ...(w.style === 'slide' ? { slider: true } : {}),
        ...(w.steel ? { steel: true } : {}),
        ...(w.thick != null ? { wd: w.wdPx ?? (doc.sc ? w.thick * doc.sc : undefined) } : {}),
        _src: w.src === 'user' ? 'u' : 'b',
        _i: w.chainIndex ?? (w.userIndex as number),
      });
    } else {
      const w = e as Wall;
      if (hiddenW.has(w.id)) continue;
      const g = geomToSeg(w.geom);
      walls.push({
        x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2,
        t: w.kind === 'thin' ? 'i' : w.kind === 'opening' ? 'd' : w.kind === 'passage' ? 'o' : 'w',
        ...(w.thick != null ? { wd: w.wdPx ?? (doc.sc ? w.thick * doc.sc : undefined) } : {}),
        _src: w.src === 'user' ? 'u' : 'b',
        _i: w.chainIndex ?? (w.userIndex as number),
      });
    }
  }

  // 实心块
  const fixed: LegacyFixedOut[] = [];
  const orderSolids = (a: Solid, b: Solid) => {
    const ab = a.src === 'builtin' ? (a.chainIndex ?? 0) : Number.MAX_SAFE_INTEGER;
    const bb = b.src === 'builtin' ? (b.chainIndex ?? 0) : Number.MAX_SAFE_INTEGER;
    return ab - bb;
  };
  [...doc.solids].sort(orderSolids).forEach(s => {
    if (hiddenSol.has(s.id)) return;
    const pts = s.geom.t === 'poly' ? s.geom.pts.map(p => [p[0], p[1]] as Pt) : [];
    fixed.push({
      name: s.src === 'user' ? '' : (s.name || ''),   // legacy effFixed 丢弃用户 poly 名（复刻）
      poly: (s.ovWrapped ? { poly: pts } : pts),
      fill: s.fill,
      ...(s.noCal ? { noCal: s.noCal } : {}),
      _src: s.src === 'user' ? 'u' : 'b',
      _i: s.chainIndex ?? (s.userIndex as number),
    });
  });

  // 门扇（leaf span；USERGEO.doors 追加在后）
  const doors: LegacyDoorOut[] = [];
  [...doc.doors].sort((a, b) => {
    const ab = a.src === 'builtin' ? (a.chainIndex ?? 0) : Number.MAX_SAFE_INTEGER;
    const bb = b.src === 'builtin' ? (b.chainIndex ?? 0) : Number.MAX_SAFE_INTEGER;
    return ab - bb;
  }).forEach(d => {
    if (hiddenDoor.has(d.id)) return;
    const g = geomToSeg(d.geom);
    doors.push({
      x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2,
      kind: d.kind,
      hinge: d.hinge ?? 0,
      side: d.side ?? 1,
      wood: !!d.dark,
      _src: d.src === 'user' ? 'u' : 'b',
      _i: d.chainIndex ?? (d.userIndex as number),
    });
  });

  return { walls, fixed, doors };
}
