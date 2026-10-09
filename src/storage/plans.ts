/* =====================================================================
   src/storage/plans.ts — 多户型注册表（E26，纯函数层）

   为什么需要它：一份浏览器里原先只有一份户型的存档 —— 存档键是
   `planner_doc_v1:<内置户型指纹>`，而「导入户型」把导入的文档写进**同一个键**。
   结果：导入你自己的图纸会覆盖你对内置户型的编辑（只能「重置内置」回到出厂几何，
   用户改动找不回来）。想同时保留「这套内置户型」和「我自己那套」做不到。

   注册表 = 一份小 JSON（永远镜像进 localStorage，KB 级）：
     { v:1, active:"<planId>", plans:[ {id,name,origin,createdAt,updatedAt,counts} ] }

   planId 口径（关键：**内置户型的 id 就是原来的户型指纹**）：
     · 内置户型  → 内置 PLAN 的指纹（与 PLAN_FP 完全相同）
       ⇒ 现有用户的存档键一个都不变，不需要任何迁移，也不会因为换键而「家具凭空消失」。
     · 自包含户型（新建空白 / 导入）→ 创建时生成的稳定 id（p + 时间 + 随机）
   文档键 = planner_doc_v1:<planId>，家具键 = planner_v1:<planId>。

   纯度：不 import three / document（R7）。注册表的读写走调用方传进来的 get/set。
   ===================================================================== */

export const PLANS_KEY = 'planner_plans_v1';
export const PLANS_SCHEMA = 1;
/** 注册表容量上限：超过就按 updatedAt 淘汰最旧的非内置、非当前条目。
    上限存在的理由：注册表永远镜像进 localStorage（它必须能在 warm 完成前同步读到），
    无上限就会变成「几百个空户型」把 LS 预算吃掉。 */
export const MAX_PLANS = 24;

export type PlanOrigin = 'builtin' | 'imported' | 'blank';

export interface PlanCounts {
  walls: number;
  doors: number;
  fixtures: number;
  items: number;
}

export interface PlanMeta {
  id: string;
  name: string;
  origin: PlanOrigin;
  createdAt: number;
  updatedAt: number;
  counts?: PlanCounts;
}

export interface PlanRegistry {
  v: number;
  active: string;
  plans: PlanMeta[];
}

export const docKeyFor = (id: string): string => 'planner_doc_v1:' + id;
export const itemsKeyFor = (id: string): string => 'planner_v1:' + id;

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;
const isName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 120;
const isOrigin = (v: unknown): v is PlanOrigin => v === 'builtin' || v === 'imported' || v === 'blank';
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function readCounts(v: unknown): PlanCounts | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
  return { walls: n(o.walls), doors: n(o.doors), fixtures: n(o.fixtures), items: n(o.items) };
}

function readPlan(v: unknown): PlanMeta | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!isId(o.id) || !isName(o.name) || !isOrigin(o.origin)) return null;
  const createdAt = isTime(o.createdAt) ? o.createdAt : 0;
  const p: PlanMeta = {
    id: o.id,
    name: o.name,
    origin: o.origin,
    createdAt,
    updatedAt: isTime(o.updatedAt) ? o.updatedAt : createdAt,
  };
  const c = readCounts(o.counts);
  if (c) p.counts = c;
  return p;
}

/** 内置户型在注册表里的条目（不存在时补一个）。内置条目永远存在：
    它是「出厂户型」的入口，删掉它等于让用户回不到出厂状态。 */
function ensureBuiltin(reg: PlanRegistry, builtinId: string, builtinName: string): PlanRegistry {
  if (!isId(builtinId)) return reg;
  if (reg.plans.some((p) => p.id === builtinId)) return reg;
  return {
    ...reg,
    plans: [{ id: builtinId, name: builtinName, origin: 'builtin', createdAt: 0, updatedAt: 0 }, ...reg.plans],
  };
}

/** 解析注册表。坏数据不抛错 —— 返回一份只含内置户型的干净注册表。
   （注册表坏了不能把用户拖进「打不开」：内置户型永远可用。） */
export function normalizeRegistry(raw: unknown, builtinId: string, builtinName = '内置户型'): PlanRegistry {
  let plans: PlanMeta[] = [];
  let active = '';
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.plans)) plans = (o.plans as unknown[]).map(readPlan).filter((p): p is PlanMeta => p !== null);
    if (isId(o.active)) active = o.active;
  }
  // 去重（后出现的覆盖先出现的）+ 顺序稳定
  const byId = new Map<string, PlanMeta>();
  for (const p of plans) byId.set(p.id, p);
  plans = Array.from(byId.values());
  const reg: PlanRegistry = { v: PLANS_SCHEMA, active, plans };
  const withBuiltin = ensureBuiltin(reg, builtinId, builtinName);
  if (!withBuiltin.plans.some((p) => p.id === withBuiltin.active)) {
    withBuiltin.active = isId(builtinId) ? builtinId : (withBuiltin.plans[0]?.id ?? '');
  }
  return trimRegistry(withBuiltin);
}

/** 容量上限：淘汰最旧的非内置、非当前户型。内置与当前永远保留。 */
export function trimRegistry(reg: PlanRegistry): PlanRegistry {
  if (reg.plans.length <= MAX_PLANS) return reg;
  const keep = new Set<string>([reg.active]);
  for (const p of reg.plans) if (p.origin === 'builtin') keep.add(p.id);
  const droppable = reg.plans.filter((p) => !keep.has(p.id)).sort((a, b) => a.updatedAt - b.updatedAt);
  const drop = new Set(droppable.slice(0, reg.plans.length - MAX_PLANS).map((p) => p.id));
  return { ...reg, plans: reg.plans.filter((p) => !drop.has(p.id)) };
}

export function serializeRegistry(reg: PlanRegistry): string {
  return JSON.stringify({ v: PLANS_SCHEMA, active: reg.active, plans: reg.plans });
}

export function planById(reg: PlanRegistry, id: string): PlanMeta | null {
  return reg.plans.find((p) => p.id === id) ?? null;
}

/** 注册表里是否已有这个 id（调用方据此决定「新建」还是「覆盖」）。 */
export function hasPlan(reg: PlanRegistry, id: string): boolean {
  return reg.plans.some((p) => p.id === id);
}

/** 新增或更新一条户型，并把它设为当前。已存在的条目保留 createdAt 与原 origin。 */
export function upsertPlan(
  reg: PlanRegistry,
  meta: { id: string; name: string; origin: PlanOrigin; now: number; counts?: PlanCounts }
): PlanRegistry {
  if (!isId(meta.id) || !isName(meta.name)) return reg;
  const prev = planById(reg, meta.id);
  const next: PlanMeta = {
    id: meta.id,
    name: meta.name,
    origin: prev ? prev.origin : meta.origin,
    createdAt: prev ? prev.createdAt : meta.now,
    updatedAt: meta.now,
  };
  if (meta.counts) next.counts = meta.counts;
  const plans = prev ? reg.plans.map((p) => (p.id === meta.id ? next : p)) : [...reg.plans, next];
  return trimRegistry({ ...reg, active: meta.id, plans });
}

/** 只更新时间/计数（切回去看一眼也算「最近用过」）。 */
export function touchPlan(
  reg: PlanRegistry,
  id: string,
  patch: { now?: number; counts?: PlanCounts; name?: string }
): PlanRegistry {
  const p = planById(reg, id);
  if (!p) return reg;
  const next: PlanMeta = { ...p };
  if (patch.now !== undefined) next.updatedAt = patch.now;
  if (patch.counts) next.counts = patch.counts;
  if (patch.name !== undefined && isName(patch.name)) next.name = patch.name;
  return { ...reg, plans: reg.plans.map((x) => (x.id === id ? next : x)) };
}

export function setActive(reg: PlanRegistry, id: string): PlanRegistry {
  if (!hasPlan(reg, id)) return reg;
  return { ...reg, active: id };
}

/** 删除一条户型。内置不可删（出厂入口）；最后一份不可删（删完界面上没有户型可用）。
   删的是当前户型时 active 自动落到内置（没内置就落到剩下的任意一份）。返回 null = 拒绝。 */
export function removePlan(reg: PlanRegistry, id: string): PlanRegistry | null {
  const p = planById(reg, id);
  if (!p) return null;
  if (p.origin === 'builtin') return null;
  if (reg.plans.length <= 1) return null;
  const plans = reg.plans.filter((x) => x.id !== id);
  let active = reg.active;
  if (active === id) {
    const fallback = plans.find((x) => x.origin === 'builtin') || plans[0];
    active = fallback ? fallback.id : '';
  }
  return { ...reg, active, plans };
}

export function renamePlan(reg: PlanRegistry, id: string, name: string): PlanRegistry | null {
  if (!hasPlan(reg, id)) return null;
  if (!isName(name)) return null;
  return { ...reg, plans: reg.plans.map((p) => (p.id === id ? { ...p, name } : p)) };
}

/** 自包含户型的稳定 id。rand 由调用方注入（0..1），便于单测确定性。 */
export function newPlanId(now: number, rand: () => number): string {
  const r = Math.floor(rand() * 1e9).toString(36);
  return 'p' + now.toString(36) + r;
}

/** 列表展示顺序：内置在最前，其余按最近使用倒序。 */
export function sortedPlans(reg: PlanRegistry): PlanMeta[] {
  return [...reg.plans].sort((a, b) => {
    if (a.origin === 'builtin' && b.origin !== 'builtin') return -1;
    if (b.origin === 'builtin' && a.origin !== 'builtin') return 1;
    return b.updatedAt - a.updatedAt;
  });
}
