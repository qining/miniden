/* =====================================================================
   src/schema/levels.ts — S17（ADR-0007）：楼层的文档变换（纯函数，就地修改传入的文档）

   一份户型 = 若干楼层。**当前层的内容在文档顶层**（walls / windows / doors / … 这些 LEVEL_KEYS），
   其余层的内容存在各自的 levels[i] 里；当前层在 levels[] 里只留外壳（id / name / elev / slab）。
   这样现有的 100+ 处「读 DOC.walls」的代码一行不改就作用于当前层；存档 / 导出 / 撤销快照
   仍是整份文档的 JSON，自然带上所有楼层与「当前是哪一层」。

   没有 levels 的文档 = 单层，与以前逐字节一致。

   纯度：不碰 DOM / three（R7）；vitest 直接测。
   ===================================================================== */

import { LEVEL_KEYS, type Level, type ProjectDoc, type Wall, type Window } from './project';

export { LEVEL_KEYS };
/** ft：楼板厚（地面构造 + 楼板），新加的楼层缺省用它 */
export const SLAB_DEFAULT = 1.0;
export const BASE_LEVEL_ID = 'lv1';

type Content = Partial<Pick<ProjectDoc, (typeof LEVEL_KEYS)[number]>>;
type Bag = Record<string, unknown>;

export function hasLevels(doc: ProjectDoc): boolean {
  return Array.isArray(doc.levels) && doc.levels.length > 0;
}

/** 单层文档 → 一层楼的文档（原内容 = lv1，标高 0）。已经有楼层则不动。 */
export function enableLevels(doc: ProjectDoc, name = '一层'): ProjectDoc {
  if (hasLevels(doc)) return doc;
  doc.levels = [{ id: BASE_LEVEL_ID, name, elev: 0 }];
  doc.level = BASE_LEVEL_ID;
  return doc;
}

export function sortedLevels(doc: ProjectDoc): Level[] {
  return (doc.levels || []).slice().sort((a, b) => a.elev - b.elev);
}

export function activeLevel(doc: ProjectDoc): Level | null {
  return (doc.levels || []).find((l) => l.id === doc.level) || null;
}

/** 某一层的内容视图：当前层 = 文档本身（顶层），其余层 = 它的 levels[i] */
export function levelContentOf(doc: ProjectDoc, id: string): Content | null {
  if (!hasLevels(doc)) return id === BASE_LEVEL_ID ? (doc as Content) : null;
  const lv = doc.levels!.find((l) => l.id === id);
  if (!lv) return null;
  return lv.id === doc.level ? (doc as Content) : (lv as Content);
}

/** 这一层的层高（当前层读顶层的 ceilingH） */
export function levelCeil(doc: ProjectDoc, lv: Level): number {
  return lv.id === doc.level ? doc.ceilingH : (lv.ceilingH ?? doc.ceilingH);
}

/** 一层新楼的空内容 */
export function emptyContent(ceilingH: number): Content {
  return {
    walls: [],
    windows: [],
    doors: [],
    solids: [],
    rooms: [],
    fixtures: [],
    runs: [],
    outlets: [],
    stairs: [],
    patio: null,
    hidden: { walls: [], windows: [], doors: [], solids: [] },
    ceilingH,
  };
}

/** 必填的顶层键（换出去以后顶层也得有个合法的空值） */
const REQUIRED: Bag = {
  walls: () => [],
  windows: () => [],
  doors: () => [],
  solids: () => [],
  rooms: () => [],
  fixtures: () => [],
  patio: () => null,
  hidden: () => ({ walls: [], windows: [], doors: [], solids: [] }),
};

/** 切层：当前层的内容存回它的外壳，目标层的内容换进顶层。目标不存在 / 就是当前层 → false，文档不动。 */
export function activateLevel(doc: ProjectDoc, id: string): boolean {
  if (!hasLevels(doc) || id === doc.level) return false;
  const target = doc.levels!.find((l) => l.id === id);
  const cur = doc.levels!.find((l) => l.id === doc.level);
  if (!target || !cur) return false;
  const D = doc as unknown as Bag,
    C = cur as unknown as Bag,
    T = target as unknown as Bag;
  for (const k of LEVEL_KEYS) if (D[k] !== undefined) C[k] = D[k];
  for (const k of LEVEL_KEYS) {
    if (T[k] !== undefined) D[k] = T[k];
    else if (k in REQUIRED) D[k] = (REQUIRED[k] as () => unknown)();
    else if (k === 'ceilingH') D[k] = C.ceilingH ?? D[k];
    else delete D[k];
    delete T[k];
  }
  doc.level = id;
  return true;
}

function nextLevelId(doc: ProjectDoc): string {
  const used = new Set((doc.levels || []).map((l) => l.id));
  let n = (doc.levels || []).length + 1;
  while (used.has('lv' + n)) n++;
  return 'lv' + n;
}

export interface AddLevelOpts {
  where: 'above' | 'below';
  name?: string;
  /** ft；缺省 = 当前层的层高 */
  ceilingH?: number;
  /** 要带到新层的墙（复制件；典型 = 下层的外墙） */
  walls?: Wall[];
  /** 要带到新层的窗（复制件；典型 = 下层外墙上的窗——楼上楼下常是同一列窗） */
  windows?: Window[];
}

/** 加一层（不切过去）。往上：标高 = 最上一层标高 + 它的层高 + 楼板厚；往下：标高 = 最下一层标高 − (新层层高 + 楼板厚)。 */
export function addLevel(doc: ProjectDoc, opts: AddLevelOpts): Level {
  enableLevels(doc);
  const lv = sortedLevels(doc);
  const ceil = opts.ceilingH ?? doc.ceilingH;
  const id = nextLevelId(doc);
  let elev: number;
  if (opts.where === 'above') {
    const top = lv[lv.length - 1];
    elev = top.elev + levelCeil(doc, top) + SLAB_DEFAULT;
  } else {
    const bot = lv[0];
    elev = bot.elev - (ceil + (bot.slab ?? SLAB_DEFAULT));
  }
  const name = opts.name || (opts.where === 'above' ? `${doc.levels!.length + 1} 层` : '地下室');
  const content = emptyContent(ceil);
  if (opts.walls && opts.walls.length) content.walls = JSON.parse(JSON.stringify(opts.walls));
  if (opts.windows && opts.windows.length) content.windows = JSON.parse(JSON.stringify(opts.windows));
  const entry: Level = { id, name, elev, ...(content as object) } as Level;
  doc.levels!.push(entry);
  doc.levels!.sort((a, b) => a.elev - b.elev);
  return entry;
}

/** 重排标高：地面层（离 0 最近的那层）定为 0，往上 / 往下按层高 + 楼板厚紧贴着排 */
export function relayout(doc: ProjectDoc): void {
  if (!hasLevels(doc)) return;
  const lv = sortedLevels(doc);
  let b = 0;
  for (let i = 1; i < lv.length; i++) if (Math.abs(lv[i].elev) < Math.abs(lv[b].elev)) b = i;
  lv[b].elev = 0;
  for (let i = b + 1; i < lv.length; i++)
    lv[i].elev = lv[i - 1].elev + levelCeil(doc, lv[i - 1]) + (lv[i].slab ?? SLAB_DEFAULT);
  for (let i = b - 1; i >= 0; i--)
    lv[i].elev = lv[i + 1].elev - (levelCeil(doc, lv[i]) + (lv[i + 1].slab ?? SLAB_DEFAULT));
  doc.levels!.sort((a, c) => a.elev - c.elev);
}

export function setLevelCeiling(doc: ProjectDoc, id: string, h: number): boolean {
  if (!hasLevels(doc)) {
    if (id !== BASE_LEVEL_ID) return false;
    doc.ceilingH = h;
    return true;
  }
  const lv = doc.levels!.find((l) => l.id === id);
  if (!lv) return false;
  if (lv.id === doc.level) doc.ceilingH = h;
  else lv.ceilingH = h;
  relayout(doc);
  return true;
}

/** 删一层。只剩一层不能删；删的是当前层就先切到相邻层（上面优先）。删完重排标高。 */
export function removeLevel(doc: ProjectDoc, id: string): { ok: boolean; reason?: string; removed?: Level } {
  if (!hasLevels(doc) || doc.levels!.length <= 1) return { ok: false, reason: '只剩这一层，不能删' };
  const lv = sortedLevels(doc);
  const i = lv.findIndex((l) => l.id === id);
  if (i < 0) return { ok: false, reason: '没有这一层' };
  if (doc.level === id) activateLevel(doc, (lv[i + 1] || lv[i - 1]).id);
  const removed = doc.levels!.find((l) => l.id === id)!;
  doc.levels = doc.levels!.filter((l) => l.id !== id);
  relayout(doc);
  return { ok: true, removed };
}

/** 逐层遍历：fn(内容视图, 楼层外壳, 是否当前层)。单层文档也走一次（lv1 = 文档本身）。 */
export function forEachLevel(doc: ProjectDoc, fn: (view: Content, lv: Level, active: boolean) => void): void {
  if (!hasLevels(doc)) {
    fn(doc as Content, { id: BASE_LEVEL_ID, name: '一层', elev: 0 }, true);
    return;
  }
  for (const lv of sortedLevels(doc)) {
    const active = lv.id === doc.level;
    fn(active ? (doc as Content) : (lv as Content), lv, active);
  }
}

/* ---------- S17b：矢量图纸（DXF / 矢量 PDF）导入为一层 + 整层平移 ---------- */

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
type Geomish = {
  t: string;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  cx?: number;
  cy?: number;
  pts?: number[][];
};
function moveGeom(g: Geomish | undefined | null, dx: number, dy: number): void {
  if (!g) return;
  if (g.t === 'seg') {
    g.x1 = r4((g.x1 as number) + dx);
    g.y1 = r4((g.y1 as number) + dy);
    g.x2 = r4((g.x2 as number) + dx);
    g.y2 = r4((g.y2 as number) + dy);
  } else if (g.t === 'arc') {
    g.cx = r4((g.cx as number) + dx);
    g.cy = r4((g.cy as number) + dy);
  } else if (g.t === 'poly' && Array.isArray(g.pts)) g.pts = g.pts.map((p) => [r4(p[0] + dx), r4(p[1] + dy)]);
}
const movePts = (pts: number[][] | undefined, dx: number, dy: number) =>
  Array.isArray(pts) ? pts.map((p) => [r4(p[0] + dx), r4(p[1] + dy)]) : pts;

/** 整层平移（就地改）：这一层所有带坐标的东西一起挪 —— 墙 / 窗 / 门（含门洞缺口）/ 柱与异形墙 / 房间（标签点 + 轮廓）/
    洁具（包围盒）/ 台面（path）/ 点位（缓存坐标；挂墙 / 台面 / 台柜的本来就是相对宿主，跟着宿主走）/ 楼梯 / 地板轮廓 / 底图 / 阳台。
    view = levelContentOf(doc, id)（当前层就是文档顶层） */
export function translateLevelContent(view: Content, dx: number, dy: number): void {
  if (!dx && !dy) return;
  const V = view as unknown as Record<string, any>;
  for (const w of V.walls || []) moveGeom(w.geom, dx, dy);
  for (const w of V.windows || []) moveGeom(w.geom, dx, dy);
  for (const d of V.doors || []) {
    moveGeom(d.geom, dx, dy);
    moveGeom(d.gapGeom, dx, dy);
  }
  for (const s of V.solids || []) moveGeom(s.geom, dx, dy);
  for (const r of V.rooms || []) {
    if (Array.isArray(r.pos)) r.pos = [r4(r.pos[0] + dx), r4(r.pos[1] + dy)];
    if (r.poly) r.poly = movePts(r.poly, dx, dy);
  }
  for (const f of V.fixtures || []) {
    f.x1 = r4(f.x1 + dx);
    f.x2 = r4(f.x2 + dx);
    f.y1 = r4(f.y1 + dy);
    f.y2 = r4(f.y2 + dy);
  }
  for (const r of V.runs || []) r.path = movePts(r.path, dx, dy);
  for (const o of V.outlets || []) {
    o.x = r4(o.x + dx);
    o.y = r4(o.y + dy);
  }
  for (const s of V.stairs || []) s.path = movePts(s.path, dx, dy);
  if (V.floorOutline) V.floorOutline = movePts(V.floorOutline, dx, dy);
  if (V.baseImage) {
    V.baseImage.ox = r4(V.baseImage.ox + dx);
    V.baseImage.oy = r4(V.baseImage.oy + dy);
  }
  if (V.patio && V.patio.geom) moveGeom(V.patio.geom, dx, dy);
}

/** 一层内容的包围盒（墙 / 窗 / 门 / 柱 / 地板轮廓；弧按外接方）；什么都没有 = null */
export function levelBBox(view: Content): { x0: number; y0: number; x1: number; y1: number } | null {
  const V = view as unknown as Record<string, any>;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  const add = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  const geom = (g: Geomish | undefined | null) => {
    if (!g) return;
    if (g.t === 'seg') {
      add(g.x1 as number, g.y1 as number);
      add(g.x2 as number, g.y2 as number);
    } else if (g.t === 'arc') {
      const r = (g as unknown as { r: number }).r;
      add((g.cx as number) - r, (g.cy as number) - r);
      add((g.cx as number) + r, (g.cy as number) + r);
    } else if (g.t === 'poly') for (const p of g.pts || []) add(p[0], p[1]);
  };
  for (const k of ['walls', 'windows', 'doors', 'solids']) for (const e of V[k] || []) geom(e.geom);
  for (const p of V.floorOutline || []) add(p[0], p[1]);
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

export interface AddLevelFromOpts {
  where: 'above' | 'below';
  name?: string;
  /** 导入内容整体平移（ft），用来先摆到这份户型的地板中央 */
  dx?: number;
  dy?: number;
}

/** 把一份单层文档（DXF / 矢量 PDF 导入读出来的）当成新的一层加进来（不切过去）。
    内容深拷贝、先整体平移 (dx, dy)；层高取它自己的 ceilingH。src 自己就有楼层 = 不收（返回 null：只收单层的图纸）。
    楼层之间的实体 id 各管各的（每层单独校验），所以不重编 id。 */
export function addLevelFromDoc(doc: ProjectDoc, src: ProjectDoc, opts: AddLevelFromOpts): Level | null {
  if (hasLevels(src)) return null;
  const S = src as unknown as Bag,
    content: Bag = {};
  for (const k of LEVEL_KEYS) if (S[k] !== undefined) content[k] = JSON.parse(JSON.stringify(S[k]));
  translateLevelContent(content as Content, opts.dx || 0, opts.dy || 0);
  const ceil =
    typeof content.ceilingH === 'number' && content.ceilingH > 0 ? (content.ceilingH as number) : doc.ceilingH;
  const lv = addLevel(doc, { where: opts.where, name: opts.name, ceilingH: ceil });
  const L = lv as unknown as Bag;
  // 层高已按上面的口径（合法才用导入那份的）交给 addLevel 了：这里不能再照抄一遍，否则导入那份的 0 / 负数会把它盖掉
  for (const k of LEVEL_KEYS) if (k !== 'ceilingH' && content[k] !== undefined) L[k] = content[k];
  if (!L.hidden) L.hidden = { walls: [], windows: [], doors: [], solids: [] };
  if (L.patio === undefined) L.patio = null;
  return lv;
}
