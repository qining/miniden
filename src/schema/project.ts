/* =====================================================================
   src/schema/project.ts — Project 文档（schema v1，ADR-0005）

   把「内置户型」从常量硬编码 + 索引覆盖（USERGEO）重构成 id 寻址的
   JSON 文档。设计文档：docs/design/floorplan-input-and-eng-audit.md §3.2。

   关键决策（与 design §3.2 草图的差异，均已记入该文档）：
   - 链缺口（原 'g' 窗段 / 'd' 门洞段）**不是** wall 实体，而是独立的
     window / door 实体：v1 里窗段与门段和墙段一一平铺（每个原数组
     位置由 chainIndex 冻结），S2「选墙放窗」时才把父墙合并、窗/门改
     用 wallId+pos 定位。这样迁移保持逐字节无损（docToLegacy 能精确
     复原渲染层消费的旧线格式）。
   - door 带自己的 leaf span（geom），内置门与门洞段端点略有出入
     （入户门 0.2px 内缩）时必须各自保留：leaf = geom，链缺口 = gapGeom。
   - solids 取代 design 的 columns（柱是 solids.column=true）；
     fixtures（卫浴洁具）与 rooms 也入文档。
   - 单位：存储一律 ft；units 是显示偏好。

   纯模块：禁 import three / document（R7）。
   ===================================================================== */

import type { Geom, Pt } from './primitives';

export type WallKind = 'wall' | 'thin' | 'opening' | 'passage';   // opening=门洞(t:'d')，passage=开口(t:'o')，thin=细线(t:'i')
export type WindowStyle = 'fixed' | 'slide' | 'casement' | 'awning';
export type DoorKind = 'swing' | 'double' | 'slide' | 'bifold';
export type FixtureType = 'counter' | 'basin' | 'toilet' | 'tub' | 'shower' | 'mirror';
export type EntitySrc = 'builtin' | 'user';

export interface Wall {
  id: string;
  kind: WallKind;
  geom: Geom;                    // seg / arc（墙是一维链）
  thick?: number;                // ft；缺省 = 渲染层默认（墙 6.5px / 细线 3.5px / 窗 3.5px，按 S 换算）
  src?: EntitySrc;
  chainIndex?: number;           // 原 WALLS 数组下标（迁移无损用；用户实体缺省）
  userIndex?: number;            // 原 USERGEO 数组下标（用户实体；投影 _i 用）
  wdPx?: number;                 // 原 wd（图纸 px，人录值如 3/3.5/6.5/8）：无损回投影用；S3 渲染层重做后移除
}

export interface Window {
  id: string;
  geom: Geom;                    // 精确跨度（原 'g' 段端点）——投影/量尺寸用
  wallId?: string | null;        // 所属父墙（v1: 相邻共线墙段；S2: 合并后的长墙）
  pos: number;                   // 0..1，沿父墙（v1 恒 0.5；S2 起为真语义）
  width: number;                 // ft
  sill: number;                  // ft（窗台高；fullHeight = 0）
  head: number;                  // ft（过梁顶高；fullHeight = 层高）
  style: WindowStyle;        // fixed/slide/casement/awning（落地不走 style，用 fullHeight）
  fullHeight?: boolean;      // 落地（sill=0 / head=层高）；legacy 的 fc 标志
  frame: string;             // 框色
  glass: number;             // 玻璃不透明度 0..1
  steel?: boolean;           // 钢梁带（西北斜墙，legacy 标记）
  src?: EntitySrc;
  chainIndex?: number;
  userIndex?: number;
  thick?: number;                // ft（物理厚度；wdPx/sc 换算）
  wdPx?: number;                 // 原 wd（图纸 px）：无损回投影用
}

export interface Door {
  id: string;
  geom: Geom;                    // leaf span（原 DR 端点）
  gapGeom?: Geom;                // 链缺口（原 'd' 段端点）；无洞门（bifold 挂在实心块上）缺省
  wallId?: string | null;
  pos: number;                   // 0..1（v1 恒 0.5）
  width: number;                 // ft（= gap 或 leaf 长度，S2 起为真语义）
  kind: DoorKind;
  hinge?: 0 | 1;
  side?: 1 | -1;
  dark?: boolean;                // 深木色（入户门）
  src?: EntitySrc;
  chainIndex?: number;
  userIndex?: number;
}

export interface Solid {
  id: string;
  name?: string;
  geom: Geom;                    // v1: poly；圆形柱 = fullCircle arc（S3 起）
  fill: string;
  noCal?: boolean;
  column?: boolean;
  ovWrapped?: boolean;           // 迁移兼容：legacy effFixed 把 ovP 覆盖的 poly 存成 {poly:pts} 对象（非数组）；
                                 // 文档 geom 恒为真多边形，此标记仅让 docToLegacy 复刻旧行为。S3 渲染层重做后移除
  src?: EntitySrc;
  chainIndex?: number;           // 原 FIXED 数组下标
  userIndex?: number;            // 原 USERGEO.polys 下标
}

export interface Room {
  id: string;
  label: string;
  pos: Pt;
  wd?: number;                   // ft
  dp?: number;                   // ft
  d?: string;                    // #calib 专用原始字符串（必须保留，校准字节不变）
  rot?: number;
  small?: boolean;
  chainIndex?: number;           // 原 LABELS 数组下标
}

export interface Fixture {
  id: string;
  t: FixtureType;
  x1: number; y1: number; x2: number; y2: number;   // ft（原 FX 图纸 px 已换算）
  dir?: string;                  // 马桶朝向
  fa?: string;                   // 镜面/浴缸朝向
  open?: string;                 // 淋浴开口方向
  chainIndex?: number;
}

export interface EnvState {
  preset: string;                // 环境预设（R3：seattle-city / …）
  mode: 'day' | 'night';
}

export interface ProjectDoc {
  schema: 1;
  name: string;
  units: 'ft' | 'cm';            // 显示单位（存储恒为 ft）
  ceilingH: number;              // ft（酷家乐「生成后必设」）
  northRotation: number;         // 度（酷家乐「生成后校验」）
  sc?: number;                   // 图纸 px/ft（仅迁移自 legacy 底图的户型有；导入户型无）
  walls: Wall[];
  windows: Window[];
  doors: Door[];
  solids: Solid[];
  patio: { geom: Geom } | null;
  rooms: Room[];
  fixtures: Fixture[];
  env: EnvState;
  hidden: { walls: string[]; windows: string[]; doors: string[]; solids: string[] };
}

/* ---------------------------------------------------------------------
   id 生成
   ------------------------------------------------------------------- */

const ID_PREFIX: Record<string, string> = {
  wall: 'w', window: 'n', door: 'd', solid: 's', room: 'r', fixture: 'f',
};

/** 下一个未占用的稳定 id（w01, w02, …）。 */
export function nextId(doc: Pick<ProjectDoc, 'walls' | 'windows' | 'doors' | 'solids' | 'rooms' | 'fixtures'>, kind: keyof typeof ID_PREFIX): string {
  const p = ID_PREFIX[kind];
  const list = kind === 'wall' ? doc.walls : kind === 'window' ? doc.windows : kind === 'door' ? doc.doors : kind === 'solid' ? doc.solids : kind === 'room' ? doc.rooms : doc.fixtures;
  let n = list.length + 1;
  const used = new Set(list.map(e => e.id));
  while (used.has(`${p}${String(n).padStart(2, '0')}`)) n++;
  return `${p}${String(n).padStart(2, '0')}`;
}

/** 全新空白文档（新户型的起点；S5/S6 导入也从这个壳开始填）。 */
export function blankDoc(name = '未命名户型'): ProjectDoc {
  return {
    schema: 1,
    name,
    units: 'cm',
    ceilingH: 8.8,
    northRotation: 0,
    walls: [], windows: [], doors: [], solids: [],
    patio: null,
    rooms: [],
    fixtures: [],
    env: { preset: 'seattle-city', mode: 'day' },
    hidden: { walls: [], windows: [], doors: [], solids: [] },
  };
}

/* ---------------------------------------------------------------------
   validate —— 载入时跑（ADR-0005）。返回错误列表，空 = 有效。
   ------------------------------------------------------------------- */

export type ValidationError = { path: string; message: string };

function isNum(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }
function isStr(v: unknown): v is string { return typeof v === 'string'; }

export function validate(doc: unknown): ValidationError[] {
  const errs: ValidationError[] = [];
  const fail = (path: string, message: string) => errs.push({ path, message });
  if (typeof doc !== 'object' || doc === null) return fail('doc', '不是对象'), errs;
  const d = doc as Record<string, unknown>;

  if (d.schema !== 1) fail('schema', `必须是 1，实际 ${String(d.schema)}`);
  if (!isStr(d.name)) fail('name', '必须是字符串');
  if (d.units !== 'ft' && d.units !== 'cm') fail('units', '必须是 ft|cm');
  if (!isNum(d.ceilingH) || d.ceilingH <= 0) fail('ceilingH', '必须是正数（ft）');
  if (!isNum(d.northRotation)) fail('northRotation', '必须是数（度）');

  const checkEntities = (arr: unknown, path: string, ids: string[]) => {
    if (!Array.isArray(arr)) { fail(path, '必须是数组'); return; }
    for (let i = 0; i < arr.length; i++) {
      const e = arr[i] as Record<string, unknown>;
      if (typeof e !== 'object' || e === null) { fail(`${path}[${i}]`, '不是对象'); continue; }
      if (!isStr(e.id) || !e.id) { fail(`${path}[${i}].id`, 'id 必须是非空字符串'); continue; }
      if (ids.includes(e.id)) fail(`${path}[${i}].id`, `重复 id ${e.id}`);
      ids.push(e.id);
      if (e.geom && typeof e.geom !== 'object') fail(`${path}[${i}].geom`, 'geom 必须是原语对象');
    }
  };

  const wallIds: string[] = [];
  checkEntities(d.walls, 'walls', wallIds);
  checkEntities(d.windows, 'windows', []);
  checkEntities(d.doors, 'doors', []);
  checkEntities(d.solids, 'solids', []);
  checkEntities(d.rooms, 'rooms', []);
  checkEntities(d.fixtures, 'fixtures', []);

  // 引用完整性
  for (const [k, arr] of [['windows', d.windows], ['doors', d.doors]] as const) {
    if (!Array.isArray(arr)) continue;
    arr.forEach((e, i) => {
      const w = e as Record<string, unknown>;
      if (w.wallId != null && !isStr(w.wallId)) fail(`${k}[${i}].wallId`, 'wallId 必须是 id 字符串');
      if (w.wallId && !wallIds.includes(w.wallId as string)) fail(`${k}[${i}].wallId`, `引用不存在的墙 ${String(w.wallId)}`);
      if (!isNum(w.pos) || w.pos < 0 || w.pos > 1) fail(`${k}[${i}].pos`, 'pos 必须在 0..1');
      if (!isNum(w.width) || w.width <= 0) fail(`${k}[${i}].width`, 'width 必须是正数');
      if (k === 'windows') {
        if (!isNum(w.sill) || w.sill < 0) fail(`windows[${i}].sill`, 'sill 必须 ≥0');
        if (!isNum(w.head) || w.head < 0) fail(`windows[${i}].head`, 'head 必须 ≥0');
        if (isNum(w.sill) && isNum(w.head) && w.sill >= w.head) fail(`windows[${i}]`, 'sill 必须 < head');
        const st = w.style;
        if (st !== 'fixed' && st !== 'slide' && st !== 'casement' && st !== 'awning')
          fail(`windows[${i}].style`, `style 非法: ${String(st)}`);
        if (w.glass != null && (!isNum(w.glass) || (w.glass as number) < 0 || (w.glass as number) > 1))
          fail(`windows[${i}].glass`, 'glass 必须在 0..1');
      } else {
        const dk = w.kind;
        if (dk !== 'swing' && dk !== 'double' && dk !== 'slide' && dk !== 'bifold')
          fail(`doors[${i}].kind`, `kind 非法: ${String(dk)}`);
      }
    });
  }

  if (d.patio != null) {
    const p = d.patio as Record<string, unknown>;
    if (typeof p.geom !== 'object' || p.geom === null) fail('patio.geom', 'geom 必须是原语对象');
  }

  const env = d.env as Record<string, unknown> | undefined;
  if (typeof env !== 'object' || env === null) fail('env', 'env 必须是对象');
  else {
    if (!isStr(env.preset)) fail('env.preset', '必须是字符串');
    if (env.mode !== 'day' && env.mode !== 'night') fail('env.mode', '必须是 day|night');
  }

  const hidden = d.hidden as Record<string, unknown> | undefined;
  if (typeof hidden !== 'object' || hidden === null) fail('hidden', 'hidden 必须是对象');
  else {
    for (const k of ['walls', 'windows', 'doors', 'solids']) {
      if (!Array.isArray(hidden[k]) || !hidden[k].every(isStr)) fail(`hidden.${k}`, '必须是 id 字符串数组');
    }
  }
  return errs;
}

/* ---------------------------------------------------------------------
   JSON Schema（draft-07）——给外部生产者（S5/S6 导入）与文档站用
   ------------------------------------------------------------------- */

export function projectSchema(): object {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'MiniDen Project (schema v1)',
    type: 'object',
    required: ['schema', 'name', 'units', 'ceilingH', 'northRotation', 'walls', 'windows', 'doors', 'solids', 'rooms', 'fixtures', 'env', 'hidden'],
    properties: {
      schema: { const: 1 },
      name: { type: 'string' },
      units: { enum: ['ft', 'cm'] },
      ceilingH: { type: 'number', exclusiveMinimum: 0 },
      northRotation: { type: 'number' },
      sc: { type: 'number', exclusiveMinimum: 0 },
      walls: { type: 'array', items: { $ref: '#/definitions/wall' } },
      windows: { type: 'array', items: { $ref: '#/definitions/window' } },
      doors: { type: 'array', items: { $ref: '#/definitions/door' } },
      solids: { type: 'array', items: { $ref: '#/definitions/solid' } },
      patio: { oneOf: [{ type: 'null' }, { type: 'object', required: ['geom'], properties: { geom: { $ref: '#/definitions/geom' } } }] },
      rooms: { type: 'array', items: { $ref: '#/definitions/room' } },
      fixtures: { type: 'array', items: { $ref: '#/definitions/fixture' } },
      env: { type: 'object', required: ['preset', 'mode'], properties: { preset: { type: 'string' }, mode: { enum: ['day', 'night'] } } },
      hidden: {
        type: 'object',
        properties: {
          walls: { type: 'array', items: { type: 'string' } },
          windows: { type: 'array', items: { type: 'string' } },
          doors: { type: 'array', items: { type: 'string' } },
          solids: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    definitions: {
      geom: {
        oneOf: [
          { type: 'object', required: ['t', 'x1', 'y1', 'x2', 'y2'], properties: { t: { const: 'seg' }, x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' } } },
          { type: 'object', required: ['t', 'cx', 'cy', 'r', 'a0', 'a1', 'dir'], properties: { t: { const: 'arc' }, cx: { type: 'number' }, cy: { type: 'number' }, r: { type: 'number', exclusiveMinimum: 0 }, a0: { type: 'number' }, a1: { type: 'number' }, dir: { enum: [1, -1] } } },
          { type: 'object', required: ['t', 'pts'], properties: { t: { const: 'poly' }, pts: { type: 'array', minItems: 3, items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } } } } },
        ],
      },
      wall: { type: 'object', required: ['id', 'kind', 'geom'], properties: { id: { type: 'string' }, kind: { enum: ['wall', 'thin', 'opening', 'passage'] }, geom: { $ref: '#/definitions/geom' }, thick: { type: 'number', exclusiveMinimum: 0 } } },
      window: {
        type: 'object',
        required: ['id', 'geom', 'pos', 'width', 'sill', 'head', 'style', 'frame', 'glass'],
        properties: {
          id: { type: 'string' }, geom: { $ref: '#/definitions/geom' },
          wallId: { type: ['string', 'null'] }, pos: { type: 'number', minimum: 0, maximum: 1 },
          width: { type: 'number', exclusiveMinimum: 0 }, sill: { type: 'number', minimum: 0 }, head: { type: 'number', minimum: 0 },
          style: { enum: ['fixed', 'slide', 'casement', 'awning'] },
          fullHeight: { type: 'boolean' },
          frame: { type: 'string' }, glass: { type: 'number', minimum: 0, maximum: 1 }, steel: { type: 'boolean' },
        },
      },
      door: {
        type: 'object',
        required: ['id', 'geom', 'pos', 'width', 'kind'],
        properties: {
          id: { type: 'string' }, geom: { $ref: '#/definitions/geom' }, gapGeom: { $ref: '#/definitions/geom' },
          wallId: { type: ['string', 'null'] }, pos: { type: 'number', minimum: 0, maximum: 1 },
          width: { type: 'number', exclusiveMinimum: 0 }, kind: { enum: ['swing', 'double', 'slide', 'bifold'] },
          hinge: { enum: [0, 1] }, side: { enum: [1, -1] }, dark: { type: 'boolean' },
        },
      },
      solid: { type: 'object', required: ['id', 'geom', 'fill'], properties: { id: { type: 'string' }, name: { type: 'string' }, geom: { $ref: '#/definitions/geom' }, fill: { type: 'string' }, noCal: { type: 'boolean' }, column: { type: 'boolean' } } },
      room: { type: 'object', required: ['id', 'label', 'pos'], properties: { id: { type: 'string' }, label: { type: 'string' }, pos: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } }, wd: { type: 'number' }, dp: { type: 'number' }, d: { type: 'string' }, rot: { type: 'number' }, small: { type: 'boolean' } } },
      fixture: { type: 'object', required: ['id', 't', 'x1', 'y1', 'x2', 'y2'], properties: { id: { type: 'string' }, t: { enum: ['counter', 'basin', 'toilet', 'tub', 'shower', 'mirror'] }, x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' } } },
    },
  };
}
