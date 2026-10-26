/* =====================================================================
   src/storage/layouts.ts — 方案（S24c，research/13 U8；纯函数层）

   为什么需要它：一份户型原先只有一套家具摆法。想比较「沙发靠窗 / 沙发靠墙」两种，
   只能导出布局文件再导回来，或者新建一份户型从头摆。

   口径：
     · 户型几何（墙 / 门窗 / 洁具 / 楼层 …）只有一份，所有方案共用 —— 改墙，所有方案都跟着；
     · 每套方案各有自己的家具（坐标都落在同一份几何上）、采购清单、撤销记录。

   存放：都在这份户型的家具存档里（planner_v1:<planId>）——
       { geo, items, customCat, unit, lay? }
     items = **当前方案**的家具（与 S24c 之前的格式逐字一致：旧版本读到的就是当前这一套）；
     lay   = { v:1, cur, seq, list:[{id,name}], other:{ <id>: items[] } }（other 不含 cur）。
   只有一套、而且还是缺省的「方案 1」时不写 lay ⇒ 存档与 S24c 之前逐字节相同。
   为什么不拆成每套一个键：整图缩放 / 移动这一层 / 删楼层要同时改所有方案的家具 ——
   一个键 = 一次写，要么全成要么全不成；家具存档是 KB 级，十几套也远低于镜像上限。

   id 只增不复用（seq）：撤销记录按方案 id 存，删掉的方案的 id 若被新方案复用，
   旧记录就会套到新方案上。

   纯度：不碰存储 / DOM（R7）。家具数组对这一层是不透明的，只做浅校验。
   ===================================================================== */

export const LAYOUTS_SCHEMA = 1;
/** 一份户型最多几套方案。上限的理由：所有方案都在同一个存档键里，且这个键要镜像进 localStorage。 */
export const MAX_LAYOUTS = 12;
export const DEFAULT_LAYOUT_ID = 'L1';
export const NAME_MAX = 40;

export const layoutName = (n: number): string => '方案 ' + n;

export interface LayoutMeta {
  id: string;
  name: string;
}

export interface LayoutSet {
  cur: string;
  /** 下一个新方案的编号（id = 'L' + seq）；只增不减 */
  seq: number;
  list: LayoutMeta[];
  /** 非当前方案的家具（当前方案的家具在调用方手里） */
  other: Record<string, unknown[]>;
}

/** 调用方拿回来的结果：新的方案集 + 切换之后「当前方案」的家具 */
export interface LayoutMove {
  set: LayoutSet;
  items: unknown[];
}

const isId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(v);
export const cleanName = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 && s.length <= NAME_MAX ? s : null;
};
const itemsOf = (v: unknown): unknown[] =>
  Array.isArray(v) ? v.filter((x) => !!x && typeof x === 'object' && !Array.isArray(x)) : [];
const idNum = (id: string): number => {
  const m = /^L(\d{1,9})$/.exec(id);
  return m ? +m[1] : 0;
};

export function defaultLayouts(): LayoutSet {
  return { cur: DEFAULT_LAYOUT_ID, seq: 2, list: [{ id: DEFAULT_LAYOUT_ID, name: layoutName(1) }], other: {} };
}

/** 解析存档里的 lay。坏数据不抛错：认不出就当「只有缺省一套」——存档里的 items 永远属于当前方案，
   所以最坏也只是「别的方案没读出来」，当前这套一件不丢。 */
export function normalizeLayouts(raw: unknown): LayoutSet {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultLayouts();
  const o = raw as Record<string, unknown>;
  const seen = new Set<string>();
  const list: LayoutMeta[] = [];
  for (const e of Array.isArray(o.list) ? (o.list as unknown[]) : []) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    const name = cleanName(r.name);
    if (!isId(r.id) || !name || seen.has(r.id)) continue;
    seen.add(r.id);
    list.push({ id: r.id, name });
    if (list.length >= MAX_LAYOUTS) break;
  }
  let cur = isId(o.cur) ? o.cur : '';
  if (!list.length) return defaultLayouts();
  /* 当前方案不在列表里（手改过的存档）：items 照样属于它 —— 补一条，而不是把 items 安到别的方案头上 */
  if (!seen.has(cur)) {
    if (!cur) cur = 'L' + (Math.max(0, ...list.map((l) => idNum(l.id))) + 1);
    list.unshift({ id: cur, name: uniqueName(list, layoutName(1)) });
    if (list.length > MAX_LAYOUTS) list.length = MAX_LAYOUTS;
  }
  const other: Record<string, unknown[]> = {};
  const src =
    o.other && typeof o.other === 'object' && !Array.isArray(o.other) ? (o.other as Record<string, unknown>) : {};
  for (const l of list) if (l.id !== cur) other[l.id] = itemsOf(src[l.id]);
  const maxN = Math.max(0, ...list.map((l) => idNum(l.id)));
  const seq = Math.max(typeof o.seq === 'number' && Number.isFinite(o.seq) ? Math.floor(o.seq) : 0, maxN + 1, 2);
  return { cur, seq, list, other };
}

/** 是不是「只有缺省的方案 1」（这时存档里不写 lay，与 S24c 之前逐字节相同） */
export function isDefaultLayouts(set: LayoutSet): boolean {
  return set.list.length === 1 && set.list[0].id === DEFAULT_LAYOUT_ID && set.list[0].name === layoutName(1);
}

/** 存档里的 lay 字段；null = 不写 */
export function serializeLayouts(set: LayoutSet): Record<string, unknown> | null {
  if (isDefaultLayouts(set)) return null;
  const other: Record<string, unknown[]> = {};
  for (const l of set.list) if (l.id !== set.cur) other[l.id] = set.other[l.id] || [];
  return {
    v: LAYOUTS_SCHEMA,
    cur: set.cur,
    seq: set.seq,
    list: set.list.map((l) => ({ id: l.id, name: l.name })),
    other,
  };
}

export function layoutById(set: LayoutSet, id: string): LayoutMeta | null {
  return set.list.find((l) => l.id === id) ?? null;
}

/** 某一套方案的家具（当前那套由调用方传进来） */
export function layoutItems(set: LayoutSet, curItems: unknown[], id: string): unknown[] {
  if (id === set.cur) return curItems;
  return set.other[id] || [];
}

function uniqueName(list: LayoutMeta[], want: string): string {
  const taken = new Set(list.map((l) => l.name));
  if (!taken.has(want)) return want;
  for (let k = 2; k < 1000; k++) {
    const s = (want + ' (' + k + ')').slice(-NAME_MAX);
    if (!taken.has(s)) return s;
  }
  return want;
}

/** 新方案的缺省名字：「方案 N」里最小的没被占用的 N */
export function nextLayoutName(set: LayoutSet): string {
  const taken = new Set(set.list.map((l) => l.name));
  for (let n = 1; n <= MAX_LAYOUTS + 1; n++) if (!taken.has(layoutName(n))) return layoutName(n);
  return uniqueName(set.list, layoutName(set.list.length + 1));
}

/** 新建一套方案并切过去。items = 新方案的家具（复制当前 = 调用方传一份深拷贝；空白 = []）。满了返回 null。 */
export function addLayout(
  set: LayoutSet,
  curItems: unknown[],
  opt: { name?: string; items: unknown[] }
): LayoutMove | null {
  if (set.list.length >= MAX_LAYOUTS) return null;
  const id = 'L' + set.seq;
  const name = uniqueName(set.list, cleanName(opt.name) || nextLayoutName(set));
  const other = { ...set.other, [set.cur]: curItems };
  delete other[id];
  return {
    set: { cur: id, seq: set.seq + 1, list: [...set.list, { id, name }], other },
    items: itemsOf(opt.items),
  };
}

/** 切到另一套方案。id 不存在 / 就是当前 → null。 */
export function switchLayout(set: LayoutSet, curItems: unknown[], id: string): LayoutMove | null {
  if (id === set.cur || !layoutById(set, id)) return null;
  const other = { ...set.other, [set.cur]: curItems };
  const items = other[id] || [];
  delete other[id];
  return { set: { ...set, cur: id, other }, items };
}

/** 删一套方案。最后一套不可删（null）。删的是当前方案 → 切到它前面那套（没有就后面那套）。 */
export function removeLayout(set: LayoutSet, curItems: unknown[], id: string): LayoutMove | null {
  const i = set.list.findIndex((l) => l.id === id);
  if (i < 0 || set.list.length <= 1) return null;
  const list = set.list.filter((l) => l.id !== id);
  const other = { ...set.other };
  delete other[id];
  if (id !== set.cur) return { set: { ...set, list, other }, items: curItems };
  const next = list[Math.max(0, i - 1)];
  const items = other[next.id] || [];
  delete other[next.id];
  return { set: { ...set, cur: next.id, list, other }, items };
}

/** 改名。名字空 / 超长 / 与别的方案重名 → null（调用方说出原因）。 */
export function renameLayout(set: LayoutSet, id: string, name: string): LayoutSet | null {
  const n = cleanName(name);
  if (!n || !layoutById(set, id)) return null;
  if (set.list.some((l) => l.id !== id && l.name === n)) return null;
  return { ...set, list: set.list.map((l) => (l.id === id ? { ...l, name: n } : l)) };
}
