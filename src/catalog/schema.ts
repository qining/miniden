/* =====================================================================
   src/catalog/schema.ts — 目录条目 schema（S10 ①：目录扩展协议的稳定契约）

   为什么现在要把它写成代码而不只是文档：目录要从 275 件长到 5,000 件（R8-5K），
   而条目数据一旦出文件（扩展包），「条目长什么样」就不再是内部约定而是**对外契约**。
   没有可执行的校验，坏包会在界面上表现为「卡片是空的 / 家具尺寸离谱 / 模型建不出来」，
   排查成本全落在用户身上。

   校验分两级（这是刻意的）：
     · **error**  = 这条条目不能被使用（缺 id / 尺寸不是正数 / 颜色不是 hex）→ 整条拒收
     · **warning** = 能用但可疑（陌生的 kind → 会走通用回退建模、未知字段、缺价格）→ 收下并如实报告
   为什么不能把 warning 升级成 error：kind 列表会随建模增长，收紧它会让旧包在新版本里失效。

   字段口径与 app.html 里的内置目录完全一致（同一份口径两处实现 = 迟早分叉，
   所以内置目录也被同一套校验扫一遍：bench 的 `cat-schema-*` 断言守着这条）。

   纯度：不 import three / document（R7）。
   ===================================================================== */

export const ENTRY_SCHEMA = 1;

/** 尺寸上下限（cm）。上限 1200 = 4m：目录里最大的条目是 2.4m 的床/爬行垫；
    再大的多半是笔误（99999cm 那种），拒收比让用户在界面上被一个笔误盖住整张平面图好。
    与检视面板的 CF_MIN_CM/CF_MAX_CM 同一口径（bug 猎 轮㉓ #41）。 */
export const ENTRY_MIN_CM = 1;
export const ENTRY_MAX_CM = 1200;
export const ENTRY_MAX_PRICE = 100000;

export type IssueLevel = 'error' | 'warning';

export interface CatalogIssue {
  level: IssueLevel;
  /** 条目 id（或包 id） */
  where: string;
  field: string;
  message: string;
}

export interface CatalogEntry {
  id: string;
  cat: string;
  name: string;
  w: number;
  d: number;
  h: number;
  kind: string;
  model?: string;
  price?: number;
  priceCA?: number;
  caNA?: boolean;
  caVar?: string;
  color?: string;
  color2?: string;
  seatH?: number;
  wood?: string;
  dimmable?: boolean;
  url?: string;
  note?: string;
  /** 扩展包来源标记（R8-5K-2）：内置条目没有这个字段 */
  sourcePack?: string;
  [extra: string]: unknown;
}

/** 内置目录当前用到的 kind 全集（2026-10 实测 57 个）。
    只用于「陌生 kind」的 warning，不作为白名单闸门。 */
export const KNOWN_KINDS: readonly string[] = [
  'accentConsole',
  'armchair',
  'balanceBike',
  'ballPit',
  'bed',
  'bedMetal',
  'bookcase',
  'cart',
  'ceilingLight',
  'chair',
  'climber',
  'clothesRail',
  'coatRack',
  'coffeeTable',
  'crib',
  'desk',
  'deskSitStand',
  'downlight',
  'dresser',
  'easel',
  'goal',
  'lamp',
  'magTiles',
  'nightstand',
  'officeChair',
  'pendant',
  'pikler',
  'playCouch',
  'playKitchen',
  'playMat',
  'playset',
  'recliner',
  'rideOn',
  'rocking',
  'rug',
  'sandTable',
  'scooter',
  'shelf',
  'shoeCab',
  'sideTable',
  'sofa',
  'sofaL',
  'sportsZone',
  'stool',
  'swivelChair',
  'tableDrawer',
  'tableFold',
  'tableRect',
  'tableRound',
  'trampoline',
  'tubChair',
  'tvBench',
  'vanityLight',
  'wagon',
  'walker',
  'wobble',
  'xylophone',
];

export const KNOWN_WOODS: readonly string[] = ['pine', 'beech', 'birch', 'oak', 'walnut'];

/** 公寓自带的固定灯具（§5.4.2）：这些 kind 本来就不该有价格，不是漏采。
    与 app.html 的 isLight() 同一口径（两处实现要一致，bench 的 cat-schema-* 守着）。 */
export const BUILTIN_LIGHT_KINDS: readonly string[] = ['downlight', 'ceilingLight', 'vanityLight', 'pendant'];

/** 已知的可选字段（未知字段只 warn，不 reject：schema 要能向前兼容） */
const KNOWN_FIELDS = new Set([
  'id',
  'cat',
  'name',
  'w',
  'd',
  'h',
  'kind',
  'model',
  'price',
  'priceCA',
  'caNA',
  'caVar',
  'color',
  'color2',
  'seatH',
  'wood',
  'dimmable',
  'url',
  'note',
  'cct',
  'lum',
  'glassShelf',
  'spShelves',
  'noCal',
  'sourcePack',
  'noPrice', // 「这件没有独立售价」的显式声明（见 validateEntry 的 price 提醒）
  'seat', // 通用建模的座高（kind:'stool' 读 spec.seat）
  'col2', // 旧别名（内置目录里有 9 条用过）：归一化成 color2，见 validateEntry
]);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KIND_RE = /^[a-z][A-Za-z0-9]{0,31}$/;
const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export interface EntryCheck {
  entry?: CatalogEntry;
  issues: CatalogIssue[];
  ok: boolean;
}

/** 校验一条目录条目。返回归一化后的条目（可选字段只在有值时存在）与问题清单。 */
export function validateEntry(raw: unknown, whereHint?: string): EntryCheck {
  const issues: CatalogIssue[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { issues: [{ level: 'error', where: whereHint || '?', field: '', message: '条目必须是对象' }], ok: false };
  }
  const e = Object.assign({}, raw as Record<string, unknown>);
  const where = isStr(e.id) && e.id ? e.id : whereHint || '?';
  const push = (level: IssueLevel, field: string, message: string) => issues.push({ level, where, field, message });

  /* 旧别名 col2 → color2：内置目录里有 9 条写的其实是 col2，而消费端（furn3D 的
     `spec.color2`、缩略图签名）读的是 color2 —— 那个字段从来没生效过（E19 轮⑩ 同类：
     定义了但没人读的字段）。对外契约只留 color2，别名自动归一化并明说。 */
  if (e.col2 !== undefined) {
    if (e.color2 === undefined) {
      e.color2 = e.col2;
      push('warning', 'col2', 'col2 是旧别名（内置目录曾误用过），已按 color2 处理 —— 请改写 color2');
    } else {
      push('warning', 'col2', '同时给了 col2 与 color2：按 color2 处理');
    }
    delete e.col2;
  }

  // ---- id ----
  if (!isStr(e.id) || !e.id) push('error', 'id', '缺少 id');
  else if (!ID_RE.test(e.id)) push('error', 'id', `id 只能用字母/数字/._-，且不超过 64 字符（当前 "${e.id}"）`);

  // ---- cat / name ----
  if (!isStr(e.cat) || !e.cat.trim()) push('error', 'cat', '缺少分类（cat）');
  else if (e.cat.length > 60) push('error', 'cat', '分类名过长（>60 字符）');
  if (!isStr(e.name) || !e.name.trim()) push('error', 'name', '缺少名称（name）');
  else if (e.name.length > 140) push('error', 'name', '名称过长（>140 字符）');

  // ---- 尺寸 ----
  const dims: Array<'w' | 'd' | 'h'> = ['w', 'd', 'h'];
  for (const k of dims) {
    const v = e[k];
    if (!isNum(v)) push('error', k, `${k} 必须是数字（cm）`);
    else if (v < ENTRY_MIN_CM || v > ENTRY_MAX_CM)
      push('error', k, `${k}=${v}cm 超出 ${ENTRY_MIN_CM}–${ENTRY_MAX_CM}cm 的合理范围`);
  }

  // ---- kind / model ----
  if (!isStr(e.kind) || !e.kind) push('error', 'kind', '缺少 kind（决定 2D 图例 / 材质 / 通用回退建模）');
  else if (!KIND_RE.test(e.kind)) push('error', 'kind', `kind 只能用字母开头的 [A-Za-z0-9]（当前 "${e.kind}"）`);
  else if (!KNOWN_KINDS.includes(e.kind))
    push('warning', 'kind', `陌生的 kind "${e.kind}"：能放能搜，但建模会走通用回退、2D 图例是通用矩形`);
  if (e.model !== undefined && (!isStr(e.model) || !ID_RE.test(e.model)))
    push('error', 'model', 'model 必须是合法的模型名');

  // ---- 价格（§5.4.1：哪个币种有当地实价就直接用，只有另一边才折算） ----
  for (const k of ['price', 'priceCA'] as const) {
    const v = e[k];
    if (v === undefined) continue;
    if (!isNum(v) || v < 0 || v > ENTRY_MAX_PRICE) push('error', k, `${k} 必须是 0–${ENTRY_MAX_PRICE} 的数字`);
  }
  if (e.caNA !== undefined && typeof e.caNA !== 'boolean') push('error', 'caNA', 'caNA 必须是布尔');
  /* caVar 两种写法都合法：true = 「加元有标价但那是同系列的另一个配置」（只举旗）；
     字符串 = 同时把那句话写给用户看（卡片 title）。消费端：fmtPrice 里 !!spec.caVar，
     标题里 typeof caVar === 'string' 才用。 */
  if (e.caVar !== undefined && typeof e.caVar !== 'boolean' && !(isStr(e.caVar) && e.caVar.length <= 240))
    push('error', 'caVar', 'caVar 必须是布尔，或 ≤240 字符的说明文本');
  if (e.noPrice !== undefined && e.noPrice !== true)
    push('error', 'noPrice', 'noPrice 只用来显式声明「没有独立售价」，写 true 或不写');
  if (
    e.price === undefined &&
    e.priceCA === undefined &&
    e.caNA !== true &&
    e.noPrice !== true &&
    !BUILTIN_LIGHT_KINDS.includes(String(e.kind))
  )
    push('warning', 'price', '没有任何价格：界面会显示为空（固定灯具本来就该没有价格，其它条目通常是漏采了）');

  // ---- 颜色 / 材质 ----
  for (const k of ['color', 'color2'] as const) {
    const v = e[k];
    if (v === undefined) continue;
    if (!isStr(v) || !HEX_RE.test(v)) push('error', k, `${k} 必须是 #hex（如 "#D4C4A8"）`);
  }
  if (e.wood !== undefined && !KNOWN_WOODS.includes(String(e.wood)))
    push('warning', 'wood', `陌生的 wood "${String(e.wood)}"：会退回默认木纹`);
  if (e.seatH !== undefined && (!isNum(e.seatH) || e.seatH < ENTRY_MIN_CM || e.seatH > 120))
    push('error', 'seatH', 'seatH 必须在 1–120cm');
  if (e.dimmable !== undefined && typeof e.dimmable !== 'boolean') push('error', 'dimmable', 'dimmable 必须是布尔');

  // ---- 链接 / 备注 ----
  if (e.url !== undefined) {
    if (!isStr(e.url) || e.url.length > 300) push('error', 'url', 'url 必须是 ≤300 字符的文本');
    else if (!/^https?:\/\//.test(e.url)) push('error', 'url', 'url 必须以 http:// 或 https:// 开头');
  }
  if (e.note !== undefined && (!isStr(e.note) || e.note.length > 400))
    push('error', 'note', 'note 必须是 ≤400 字符的文本');

  // ---- 未知字段：warn 不 reject（schema 要向前兼容） ----
  for (const k of Object.keys(e)) {
    if (!KNOWN_FIELDS.has(k) && k !== 'sourcePack') push('warning', k, `未知字段 "${k}"（会被保留但不消费）`);
  }

  if (issues.some((i) => i.level === 'error')) return { issues, ok: false };

  const out: CatalogEntry = {
    id: String(e.id),
    cat: String(e.cat).trim(),
    name: String(e.name).trim(),
    w: Number(e.w),
    d: Number(e.d),
    h: Number(e.h),
    kind: String(e.kind),
  };
  for (const k of [
    'model',
    'price',
    'priceCA',
    'caNA',
    'caVar',
    'color',
    'color2',
    'seatH',
    'wood',
    'dimmable',
    'url',
    'note',
    'cct',
    'lum',
    'glassShelf',
    'spShelves',
    'noCal',
    'noPrice',
    'seat',
  ] as const) {
    if (e[k] !== undefined) out[k] = e[k] as never;
  }
  for (const k of Object.keys(e)) if (!KNOWN_FIELDS.has(k)) out[k] = e[k];
  return { entry: out, issues, ok: true };
}

/** 一组条目的 id 重复检查（包内自检；跨包/与内置的冲突由 mergeCatalog 处理） */
export function duplicateIds(entries: readonly CatalogEntry[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.id)) dup.add(e.id);
    seen.add(e.id);
  }
  return Array.from(dup);
}
