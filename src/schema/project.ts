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

export type WallKind = 'wall' | 'thin' | 'opening' | 'passage'; // opening=门洞(t:'d')，passage=开口(t:'o')，thin=细线(t:'i')
export type WindowStyle = 'fixed' | 'slide' | 'casement' | 'awning';
export type DoorKind = 'swing' | 'double' | 'slide' | 'bifold';
export type FixtureType = 'counter' | 'basin' | 'toilet' | 'tub' | 'shower' | 'mirror';
export const FIXTURE_TYPES: FixtureType[] = ['counter', 'basin', 'toilet', 'tub', 'shower', 'mirror'];
export type EntitySrc = 'builtin' | 'user';

export interface Wall {
  id: string;
  kind: WallKind;
  geom: Geom; // seg / arc（墙是一维链）
  thick?: number; // ft；缺省 = 渲染层默认（墙 6.5px / 细线 3.5px / 窗 3.5px，按 S 换算）
  src?: EntitySrc;
  chainIndex?: number; // 原 WALLS 数组下标（迁移无损用；用户实体缺省）
  userIndex?: number; // 原 USERGEO 数组下标（用户实体；投影 _i 用）
  wdPx?: number; // 原 wd（图纸 px，人录值如 3/3.5/6.5/8）：无损回投影用；S3 渲染层重做后移除
}

export interface Window {
  id: string;
  geom: Geom; // 精确跨度（原 'g' 段端点）——投影/量尺寸用
  wallId?: string | null; // 所属父墙（v1: 相邻共线墙段；S2: 合并后的长墙）
  pos: number; // 0..1，沿父墙（v1 恒 0.5；S2 起为真语义）
  width: number; // ft
  sill: number; // ft（窗台高；fullHeight = 0）
  head: number; // ft（过梁顶高；fullHeight = 层高）
  style: WindowStyle; // fixed/slide/casement/awning（落地不走 style，用 fullHeight）
  fullHeight?: boolean; // 落地（sill=0 / head=层高）；legacy 的 fc 标志
  frame: string; // 框色
  glass: number; // 玻璃不透明度 0..1
  steel?: boolean; // 钢梁带（西北斜墙，legacy 标记）
  src?: EntitySrc;
  chainIndex?: number;
  userIndex?: number;
  thick?: number; // ft（物理厚度；wdPx/sc 换算）
  wdPx?: number; // 原 wd（图纸 px）：无损回投影用
}

export interface Door {
  id: string;
  geom: Geom; // leaf span（原 DR 端点）
  gapGeom?: Geom; // 链缺口（原 'd' 段端点）；无洞门（bifold 挂在实心块上）缺省
  wallId?: string | null;
  pos: number; // 0..1（v1 恒 0.5）
  width: number; // ft（= gap 或 leaf 长度，S2 起为真语义）
  kind: DoorKind;
  hinge?: 0 | 1;
  side?: 1 | -1;
  dark?: boolean; // 深木色（入户门）
  src?: EntitySrc;
  chainIndex?: number;
  userIndex?: number;
}

export interface Solid {
  id: string;
  name?: string;
  geom: Geom; // v1: poly；圆形柱 = fullCircle arc（S3 起）
  fill: string;
  noCal?: boolean;
  column?: boolean;
  ovWrapped?: boolean; // 迁移兼容：legacy effFixed 把 ovP 覆盖的 poly 存成 {poly:pts} 对象（非数组）；
  // 文档 geom 恒为真多边形，此标记仅让 docToLegacy 复刻旧行为。S3 渲染层重做后移除
  src?: EntitySrc;
  chainIndex?: number; // 原 FIXED 数组下标
  userIndex?: number; // 原 USERGEO.polys 下标
}

export interface Room {
  id: string;
  label: string;
  pos: Pt;
  wd?: number; // ft
  dp?: number; // ft
  d?: string; // #calib 专用原始字符串（必须保留，校准字节不变）
  rot?: number;
  small?: boolean;
  chainIndex?: number; // 原 LABELS 数组下标
}

export interface Fixture {
  id: string;
  t: FixtureType;
  x1: number;
  y1: number;
  x2: number;
  y2: number; // ft（包围盒，rot=0 时即轴对齐矩形）
  dir?: string; // 马桶朝向
  fa?: string; // 镜面/浴缸朝向
  open?: string; // 淋浴开口方向
  rot?: number; // 度：绕占地中心旋转（0/缺省 = 轴对齐；S6 洁具工具用）
  src?: 'user'; // 用户放置的洁具（内置 = 缺省/chainIndex 存在）；S6 删除权限用
  chainIndex?: number;
}

export type RunModule = 'sink' | 'cooktop' | 'fridge' | 'dishwasher' | 'open';
const RUN_MODULES: RunModule[] = ['sink', 'cooktop', 'fridge', 'dishwasher', 'open'];

/* S12：台面/柜体 run（厨房台面、浴室柜、中岛）——用户自己画的一条沿墙折线。
   以前厨房柜体是 AI 从图纸读出来后硬编码的，用户改不了。现在它是文档实体：
   path = 柜体前沿折线（靠墙那一侧），柜体向户型内侧伸出 depth；
   topH = 台面高（厨房 base 80+3cm、中岛 90cm、浴室柜 74cm），h = 柜体高（缺省 = topH）。
   纯增量可选字段：不进 docToLegacy 投影（投影键集冻结），消费端走 effRuns()。 */
export interface Run {
  id: string;
  path: Pt[]; // ft（≥2 点，靠墙侧前沿）
  depth: number; // ft（柜体深度，从 path 向户型内侧）
  topH: number; // ft（台面高）
  h?: number; // ft（柜体高；缺省 = topH）
  modules?: Array<{ at: number; type: RunModule; w?: number }>; // at = 沿 path 的距离（ft）
  src?: EntitySrc;
  userIndex?: number;
}

export interface EnvState {
  preset: string; // 环境预设（R3：seattle-city / …）
  mode: 'day' | 'night';
}

/* S7：用户底图（扫描件/照片/扫描 PDF 页）——描摹通道的参考层。
   data = JPEG dataURL（降采样 ≤2048px、体积 ≤2MB，localStorage 可容）；
   mPerPx = 标定后的米/像素（两点标定或手动）；(ox,oy) = 图像左上角的文档坐标（ft，y 下）；
   rot = 顺时针 90° 步进（手机照片常见横拍）。
   纯增补可选字段：旧文档无此字段 = 无底图，不 bump DOC_DATA_VERSION（
   导入户型文档不能因版本 bump 被丢弃重迁移）。 */
export interface BaseImage {
  data: string; // data:image/jpeg;base64,…
  w: number; // 解码后像素宽
  h: number;
  mPerPx: number; // 米/像素（>0）
  ox: number; // ft
  oy: number; // ft
  rot?: 0 | 90 | 180 | 270; // 默认 0
}

/* S11b：户型专属构件 / 参考的快照（纯增量可选字段，不进 docToLegacy 投影）。
   这些是「只有某一份户型才有」的东西：标题、参考照片、校准底图、落地窗带、
   阳台补板、中岛轮廓与标注、厨房构件。以前它们只存在于 plan JSON（= 内置户型的种子），
   所以导出/导入的文档拿到别的机器上会丢。现在它们随文档走，消费端一律走 planOf()。 */
export interface KitchenPart {
  m: 'cab' | 'top' | 'steel' | 'chrome' | 'seam' | 'black'; // 材质档
  box?: [number, number, number]; // ft（BoxGeometry 尺寸）
  cyl?: [number, number]; // ft（半径, 高）
  seg?: number; // 圆柱细分（缺省 10，与原硬编码一致）
  p: [number, number, number]; // ft（mesh position = 中心）
  rz?: 90; // 绕 z 转 90°（横放的杆）
  sh?: boolean; // castShadow
  rc?: boolean; // receiveShadow
}

export interface PlanExtras {
  roomSummary?: string;
  refPhoto?: string; // 只能带路径：浏览器无法把本地文件读进 JSON
  calib?: { img: string; w: number; h: number }; // w/h 是图纸 px（不是文件分辨率）
  windowBand?: number[][]; // 图纸 px 折线
  patioPatch?: number[][]; // 图纸 px 三角形
  islLabel?: { p: number[]; w: number; d: number; calib: string };
  isl?: { a: number[]; b: number[]; e: number[]; cp2: number[]; d: number[] }; // 图纸 px
  kitchen?: KitchenPart[];
  inner?: Array<{ x1: number; y1: number; x2: number; y2: number; wd?: number }>; // 图纸 px（内部示意墙：投影范围外的特例，不经 effWalls）
}

export interface ProjectDoc {
  schema: 1;
  name: string;
  units: 'ft' | 'cm'; // 显示单位（存储恒为 ft）
  ceilingH: number; // ft（酷家乐「生成后必设」）
  northRotation: number; // 度（酷家乐「生成后校验」）
  sc?: number; // 图纸 px/ft（仅迁移自 legacy 底图的户型有；导入户型无）
  dataV?: number; // 内置数据版本（常量集变动时 bump；载入时不符 → 丢弃用户文档重新迁移）
  walls: Wall[];
  windows: Window[];
  doors: Door[];
  solids: Solid[];
  patio: { geom: Geom } | null;
  rooms: Room[];
  fixtures: Fixture[];
  runs?: Run[]; // S12：台面/柜体 run（纯增量可选字段，不进投影）
  env: EnvState;
  baseImage?: BaseImage; // S7：用户底图（可选）
  floorOutline?: Pt[][]; // S11：地板轮廓（ft 多边形，导出/导入往返用）。纯增量可选字段，不进 docToLegacy 投影
  plan?: PlanExtras; // S11b：户型专属构件/参考快照（同上，不进投影）
  hidden: { walls: string[]; windows: string[]; doors: string[]; solids: string[] };
}

/* ---------------------------------------------------------------------
   id 生成
   ------------------------------------------------------------------- */

const ID_PREFIX: Record<string, string> = {
  wall: 'w',
  window: 'n',
  door: 'd',
  solid: 's',
  room: 'r',
  fixture: 'f',
  run: 'rn',
};

/** 下一个未占用的稳定 id（w01, w02, …）。 */
export function nextId(
  doc: Pick<ProjectDoc, 'walls' | 'windows' | 'doors' | 'solids' | 'rooms' | 'fixtures' | 'runs'>,
  kind: keyof typeof ID_PREFIX
): string {
  const p = ID_PREFIX[kind];
  const list =
    (kind === 'wall'
      ? doc.walls
      : kind === 'window'
        ? doc.windows
        : kind === 'door'
          ? doc.doors
          : kind === 'solid'
            ? doc.solids
            : kind === 'room'
              ? doc.rooms
              : kind === 'fixture'
                ? doc.fixtures
                : doc.runs) ?? [];
  let n = list.length + 1;
  const used = new Set(list.map((e) => e.id));
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
    walls: [],
    windows: [],
    doors: [],
    solids: [],
    patio: null,
    rooms: [],
    fixtures: [],
    runs: [],
    env: { preset: 'seattle-city', mode: 'day' },
    hidden: { walls: [], windows: [], doors: [], solids: [] },
  };
}

/* ---------------------------------------------------------------------
   validate —— 载入时跑（ADR-0005）。返回错误列表，空 = 有效。
   ------------------------------------------------------------------- */

export type ValidationError = { path: string; message: string };

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

export function validate(doc: unknown): ValidationError[] {
  const errs: ValidationError[] = [];
  const fail = (path: string, message: string) => errs.push({ path, message });
  if (typeof doc !== 'object' || doc === null) return (fail('doc', '不是对象'), errs);
  const d = doc as Record<string, unknown>;

  if (d.schema !== 1) fail('schema', `必须是 1，实际 ${String(d.schema)}`);
  if (!isStr(d.name)) fail('name', '必须是字符串');
  if (d.units !== 'ft' && d.units !== 'cm') fail('units', '必须是 ft|cm');
  if (!isNum(d.ceilingH) || d.ceilingH <= 0) fail('ceilingH', '必须是正数（ft）');
  if (!isNum(d.northRotation)) fail('northRotation', '必须是数（度）');

  const checkEntities = (arr: unknown, path: string, ids: string[]) => {
    if (!Array.isArray(arr)) {
      fail(path, '必须是数组');
      return;
    }
    for (let i = 0; i < arr.length; i++) {
      const e = arr[i] as Record<string, unknown>;
      if (typeof e !== 'object' || e === null) {
        fail(`${path}[${i}]`, '不是对象');
        continue;
      }
      if (!isStr(e.id) || !e.id) {
        fail(`${path}[${i}].id`, 'id 必须是非空字符串');
        continue;
      }
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
  if (d.runs !== undefined) checkEntities(d.runs, 'runs', []); // S12：纯增量可选字段，旧文档无此字段 = 无 run

  // 台面/柜体 run（S12）：前沿折线 + 深度 + 台面高
  if (Array.isArray(d.runs)) {
    (d.runs as Array<Record<string, unknown>>).forEach((e, i) => {
      const p = e.path;
      if (!Array.isArray(p) || p.length < 2) fail(`runs[${i}].path`, 'path 必须是 ≥2 个 [x, y]（ft）');
      else
        p.forEach((q, j) => {
          if (!Array.isArray(q) || q.length !== 2 || !isNum(q[0]) || !isNum(q[1]))
            fail(`runs[${i}].path[${j}]`, '必须是 [x, y]（ft）');
        });
      for (const k of ['depth', 'topH', 'h']) {
        if (e[k] !== undefined && (!isNum(e[k]) || (e[k] as number) <= 0))
          fail(`runs[${i}].${k}`, `${k} 必须是正数（ft）`);
      }
      if (e.depth !== undefined && (e.depth as number) > 4)
        fail(`runs[${i}].depth`, `depth 超过合理柜体深度（${e.depth} ft）`);
      if (e.topH !== undefined && (e.topH as number) > 8)
        fail(`runs[${i}].topH`, `topH 超过合理台面高（${e.topH} ft）`);
      if (e.modules !== undefined) {
        if (!Array.isArray(e.modules)) {
          fail(`runs[${i}].modules`, '必须是数组');
          return;
        }
        (e.modules as Array<Record<string, unknown>>).forEach((m, j) => {
          if (typeof m !== 'object' || m === null) {
            fail(`runs[${i}].modules[${j}]`, '不是对象');
            return;
          }
          if (!isNum(m.at) || (m.at as number) < 0)
            fail(`runs[${i}].modules[${j}].at`, 'at 必须是 ≥0 的数（沿 path 的 ft）');
          if (RUN_MODULES.indexOf(m.type as RunModule) < 0)
            fail(`runs[${i}].modules[${j}].type`, `type 非法: ${String(m.type)}`);
          if (m.w !== undefined && (!isNum(m.w) || (m.w as number) <= 0))
            fail(`runs[${i}].modules[${j}].w`, 'w 必须是正数（ft）');
        });
      }
    });
  }

  // 洁具字段（矩形四角 + 旋转）
  if (Array.isArray(d.fixtures)) {
    (d.fixtures as Array<Record<string, unknown>>).forEach((e, i) => {
      // t 必须合法：消费端（2D drawFixtures / 3D 洁具建模）按 t 分支，未知 t 渲成隐形件
      if (FIXTURE_TYPES.indexOf(e.t as FixtureType) < 0) fail(`fixtures[${i}].t`, `非法洁具类型: ${String(e.t)}`);
      for (const k of ['x1', 'y1', 'x2', 'y2']) {
        if (e[k] !== undefined && !isNum(e[k])) fail(`fixtures[${i}].${k}`, `${k} 必须是数（ft）`);
      }
      if (e.rot !== undefined && !isNum(e.rot)) fail(`fixtures[${i}].rot`, 'rot 必须是数（度）');
    });
  }

  // 引用完整性
  for (const [k, arr] of [
    ['windows', d.windows],
    ['doors', d.doors],
  ] as const) {
    if (!Array.isArray(arr)) continue;
    arr.forEach((e, i) => {
      const w = e as Record<string, unknown>;
      if (w.wallId != null && !isStr(w.wallId)) fail(`${k}[${i}].wallId`, 'wallId 必须是 id 字符串');
      if (w.wallId && !wallIds.includes(w.wallId as string))
        fail(`${k}[${i}].wallId`, `引用不存在的墙 ${String(w.wallId)}`);
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

  // S7：用户底图（可选）
  if (d.baseImage != null) {
    const bi = d.baseImage as Record<string, unknown>;
    if (typeof bi !== 'object' || bi === null) fail('baseImage', '必须是对象');
    else {
      if (typeof bi.data !== 'string' || bi.data.length < 22) fail('baseImage.data', '必须是 dataURL 字符串');
      if (!isNum(bi.w) || (bi.w as number) < 8) fail('baseImage.w', '必须是 ≥8 的像素宽');
      if (!isNum(bi.h) || (bi.h as number) < 8) fail('baseImage.h', '必须是 ≥8 的像素高');
      if (!isNum(bi.mPerPx) || (bi.mPerPx as number) <= 0) fail('baseImage.mPerPx', '必须是正数（米/像素）');
      if (!isNum(bi.ox)) fail('baseImage.ox', '必须是数（ft）');
      if (!isNum(bi.oy)) fail('baseImage.oy', '必须是数（ft）');
      if (bi.rot !== undefined && bi.rot !== 0 && bi.rot !== 90 && bi.rot !== 180 && bi.rot !== 270)
        fail('baseImage.rot', '必须是 0|90|180|270');
    }
  }

  // S11：地板轮廓（可选，纯增量字段 —— docToLegacy 不投影它）
  if (d.floorOutline !== undefined) {
    if (!Array.isArray(d.floorOutline)) fail('floorOutline', '必须是点数组');
    else {
      if (d.floorOutline.length < 3) fail('floorOutline', '至少 3 个点');
      d.floorOutline.forEach((p, i) => {
        if (!Array.isArray(p) || p.length !== 2 || !isNum(p[0]) || !isNum(p[1]))
          fail(`floorOutline[${i}]`, '必须是 [x, y]（ft）');
      });
    }
  }

  // S11b：户型专属构件快照（可选，纯增量字段 —— docToLegacy 不投影它）
  if (d.plan !== undefined) {
    if (typeof d.plan !== 'object' || d.plan === null || Array.isArray(d.plan)) fail('plan', '必须是对象');
    else {
      const pl = d.plan as Record<string, unknown>;
      for (const k of ['roomSummary', 'refPhoto'])
        if (pl[k] !== undefined && !isStr(pl[k])) fail(`plan.${k}`, '必须是字符串');
      if (pl.calib !== undefined) {
        const c = pl.calib as Record<string, unknown>;
        if (typeof c !== 'object' || c === null) fail('plan.calib', '必须是对象');
        else {
          if (!isStr(c.img)) fail('plan.calib.img', '必须是字符串（图纸底图路径）');
          if (!isNum(c.w) || (c.w as number) <= 0) fail('plan.calib.w', '必须是正数（图纸 px）');
          if (!isNum(c.h) || (c.h as number) <= 0) fail('plan.calib.h', '必须是正数（图纸 px）');
        }
      }
      const pt = (v: unknown, path: string) => {
        if (!Array.isArray(v) || v.length !== 2 || v.some((q) => !isNum(q))) fail(path, '必须是 [x, y]（图纸 px）');
      };
      const pts = (v: unknown, path: string, n?: number) => {
        if (!Array.isArray(v)) {
          fail(path, '必须是点数组');
          return;
        }
        v.forEach((p, i) => {
          if (!Array.isArray(p) || (n && p.length !== n) || p.some((q) => !isNum(q)))
            fail(`${path}[${i}]`, n ? `必须是 [${Array(n).fill('x').join(', ')}]（图纸 px）` : '必须是数字点');
        });
      };
      if (pl.windowBand !== undefined) pts(pl.windowBand, 'plan.windowBand', 2);
      if (pl.patioPatch !== undefined) pts(pl.patioPatch, 'plan.patioPatch', 2);
      if (pl.islLabel !== undefined) {
        const L = pl.islLabel as Record<string, unknown>;
        if (typeof L !== 'object' || L === null) fail('plan.islLabel', '必须是对象');
        else {
          pt(L.p, 'plan.islLabel.p');
          if (!isNum(L.w)) fail('plan.islLabel.w', '必须是数');
          if (!isNum(L.d)) fail('plan.islLabel.d', '必须是数');
          if (!isStr(L.calib)) fail('plan.islLabel.calib', '必须是字符串');
        }
      }
      if (pl.isl !== undefined) {
        const I = pl.isl as Record<string, unknown>;
        if (typeof I !== 'object' || I === null) fail('plan.isl', '必须是对象');
        else for (const k of ['a', 'b', 'e', 'cp2', 'd']) pt(I[k], `plan.isl.${k}`);
      }
      if (pl.inner !== undefined) {
        if (!Array.isArray(pl.inner)) fail('plan.inner', '必须是数组');
        else
          pl.inner.forEach((s, i) => {
            const sg = s as Record<string, unknown>;
            if (typeof sg !== 'object' || sg === null) {
              fail(`plan.inner[${i}]`, '不是对象');
              return;
            }
            for (const k of ['x1', 'y1', 'x2', 'y2'])
              if (!isNum(sg[k])) fail(`plan.inner[${i}].${k}`, '必须是数（图纸 px）');
            if (sg.wd !== undefined && !isNum(sg.wd)) fail(`plan.inner[${i}].wd`, '必须是数');
          });
      }
      if (pl.kitchen !== undefined) {
        if (!Array.isArray(pl.kitchen)) fail('plan.kitchen', '必须是数组');
        else
          pl.kitchen.forEach((e, i) => {
            const kp = e as Record<string, unknown>;
            if (typeof kp !== 'object' || kp === null) {
              fail(`plan.kitchen[${i}]`, '不是对象');
              return;
            }
            if (['cab', 'top', 'steel', 'chrome', 'seam', 'black'].indexOf(kp.m as string) < 0)
              fail(`plan.kitchen[${i}].m`, `材质档非法: ${String(kp.m)}`);
            if (!kp.box && !kp.cyl) fail(`plan.kitchen[${i}]`, '必须有 box 或 cyl');
            if (kp.box && !(Array.isArray(kp.box) && kp.box.length === 3 && kp.box.every((q) => isNum(q))))
              fail(`plan.kitchen[${i}].box`, '必须是 [w, h, d]（ft）');
            if (kp.cyl && !(Array.isArray(kp.cyl) && kp.cyl.length === 2 && kp.cyl.every((q) => isNum(q))))
              fail(`plan.kitchen[${i}].cyl`, '必须是 [r, len]（ft）');
            if (kp.seg !== undefined && (!isNum(kp.seg) || (kp.seg as number) < 3))
              fail(`plan.kitchen[${i}].seg`, '必须是 ≥3 的细分');
            if (!(Array.isArray(kp.p) && kp.p.length === 3 && kp.p.every((q) => isNum(q))))
              fail(`plan.kitchen[${i}].p`, '必须是 [x, y, z]（ft）');
          });
      }
    }
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

/** 几何字段形状检查。validate() 只验「geom 是个对象」，这里验它内部字段：
 *  缺字段 / NaN 会让 expand() 产出 NaN，整个构件在 2D/3D 里消失而且不报错。
 *
 *  只用于**导入闸门**（户型文档导入 / DXF·PDF 导入确认）：
 *  loadDoc 的 usable() 不调它——把已有存档判坏等于 removeItem 删用户数据。 */
export function checkGeoms(doc: unknown): ValidationError[] {
  const errs: ValidationError[] = [];
  const fail = (path: string, message: string) => errs.push({ path, message });
  if (typeof doc !== 'object' || doc === null) return (fail('doc', '不是对象'), errs);
  const d = doc as Record<string, unknown>;
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const one = (g: unknown, path: string) => {
    if (typeof g !== 'object' || g === null) return fail(path, 'geom 必须是原语对象');
    const e = g as Record<string, unknown>;
    if (e.t === 'seg') {
      for (const k of ['x1', 'y1', 'x2', 'y2']) if (!num(e[k])) fail(`${path}.${k}`, `${k} 必须是有限数（ft）`);
    } else if (e.t === 'arc') {
      for (const k of ['cx', 'cy', 'a0', 'a1']) if (!num(e[k])) fail(`${path}.${k}`, `${k} 必须是有限数`);
      if (!num(e.r) || (e.r as number) <= 0) fail(`${path}.r`, 'r 必须是正数（ft）');
      if (e.dir !== 1 && e.dir !== -1) fail(`${path}.dir`, 'dir 必须是 1 或 −1');
    } else if (e.t === 'poly') {
      const p = e.pts;
      if (!Array.isArray(p) || p.length < 2) return fail(`${path}.pts`, 'pts 必须是 ≥2 个 [x, y]');
      p.forEach((q, j) => {
        if (!Array.isArray(q) || q.length !== 2 || !num(q[0]) || !num(q[1]))
          fail(`${path}.pts[${j}]`, '必须是 [x, y]（ft）');
      });
    } else {
      fail(`${path}.t`, `geom.t 必须是 seg|arc|poly，实际 ${String(e.t)}`);
    }
  };
  for (const k of ['walls', 'windows', 'doors', 'solids'] as const) {
    const arr = d[k];
    if (!Array.isArray(arr)) continue;
    arr.forEach((raw, i) => {
      if (typeof raw !== 'object' || raw === null) return;
      const e = raw as Record<string, unknown>;
      if (e.geom === undefined) return fail(`${k}[${i}].geom`, 'geom 必填');
      one(e.geom, `${k}[${i}].geom`);
      if (k === 'doors' && e.gapGeom !== undefined) one(e.gapGeom, `doors[${i}].gapGeom`);
    });
  }
  if (d.patio != null && typeof d.patio === 'object') {
    const p = d.patio as Record<string, unknown>;
    if (p.geom !== undefined) one(p.geom, 'patio.geom');
  }
  return errs;
}

export function projectSchema(): object {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'MiniDen Project (schema v1)',
    type: 'object',
    required: [
      'schema',
      'name',
      'units',
      'ceilingH',
      'northRotation',
      'walls',
      'windows',
      'doors',
      'solids',
      'rooms',
      'fixtures',
      'env',
      'hidden',
    ],
    properties: {
      schema: { const: 1 },
      name: { type: 'string' },
      units: { enum: ['ft', 'cm'] },
      ceilingH: { type: 'number', exclusiveMinimum: 0 },
      northRotation: { type: 'number' },
      sc: { type: 'number', exclusiveMinimum: 0 },
      dataV: { type: 'number', minimum: 1 },
      walls: { type: 'array', items: { $ref: '#/definitions/wall' } },
      windows: { type: 'array', items: { $ref: '#/definitions/window' } },
      doors: { type: 'array', items: { $ref: '#/definitions/door' } },
      solids: { type: 'array', items: { $ref: '#/definitions/solid' } },
      patio: {
        oneOf: [
          { type: 'null' },
          { type: 'object', required: ['geom'], properties: { geom: { $ref: '#/definitions/geom' } } },
        ],
      },
      rooms: { type: 'array', items: { $ref: '#/definitions/room' } },
      fixtures: { type: 'array', items: { $ref: '#/definitions/fixture' } },
      runs: { type: 'array', items: { $ref: '#/definitions/run' } },
      env: {
        type: 'object',
        required: ['preset', 'mode'],
        properties: { preset: { type: 'string' }, mode: { enum: ['day', 'night'] } },
      },
      floorOutline: {
        type: 'array',
        minItems: 3,
        items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
      },
      plan: {
        type: 'object',
        properties: {
          roomSummary: { type: 'string' },
          refPhoto: { type: 'string' },
          calib: {
            type: 'object',
            required: ['img', 'w', 'h'],
            properties: {
              img: { type: 'string' },
              w: { type: 'number', exclusiveMinimum: 0 },
              h: { type: 'number', exclusiveMinimum: 0 },
            },
          },
          windowBand: { type: 'array', items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } } },
          patioPatch: {
            type: 'array',
            minItems: 3,
            items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
          },
          islLabel: {
            type: 'object',
            required: ['p', 'w', 'd', 'calib'],
            properties: {
              p: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
              w: { type: 'number' },
              d: { type: 'number' },
              calib: { type: 'string' },
            },
          },
          isl: {
            type: 'object',
            required: ['a', 'b', 'e', 'cp2', 'd'],
            properties: {
              a: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
              b: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
              e: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
              cp2: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
              d: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
            },
          },
          kitchen: {
            type: 'array',
            items: {
              type: 'object',
              required: ['m', 'p'],
              properties: {
                m: { enum: ['cab', 'top', 'steel', 'chrome', 'seam', 'black'] },
                box: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } },
                cyl: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
                seg: { type: 'integer', minimum: 3 },
                p: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } },
                rz: { enum: [90] },
                sh: { type: 'boolean' },
                rc: { type: 'boolean' },
              },
            },
          },
          inner: {
            type: 'array',
            items: {
              type: 'object',
              required: ['x1', 'y1', 'x2', 'y2'],
              properties: {
                x1: { type: 'number' },
                y1: { type: 'number' },
                x2: { type: 'number' },
                y2: { type: 'number' },
                wd: { type: 'number' },
              },
            },
          },
        },
      },
      baseImage: {
        type: 'object',
        required: ['data', 'w', 'h', 'mPerPx', 'ox', 'oy'],
        properties: {
          data: { type: 'string' },
          w: { type: 'integer', minimum: 8 },
          h: { type: 'integer', minimum: 8 },
          mPerPx: { type: 'number', exclusiveMinimum: 0 },
          ox: { type: 'number' },
          oy: { type: 'number' },
          rot: { enum: [0, 90, 180, 270] },
        },
      },
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
          {
            type: 'object',
            required: ['t', 'x1', 'y1', 'x2', 'y2'],
            properties: {
              t: { const: 'seg' },
              x1: { type: 'number' },
              y1: { type: 'number' },
              x2: { type: 'number' },
              y2: { type: 'number' },
            },
          },
          {
            type: 'object',
            required: ['t', 'cx', 'cy', 'r', 'a0', 'a1', 'dir'],
            properties: {
              t: { const: 'arc' },
              cx: { type: 'number' },
              cy: { type: 'number' },
              r: { type: 'number', exclusiveMinimum: 0 },
              a0: { type: 'number' },
              a1: { type: 'number' },
              dir: { enum: [1, -1] },
            },
          },
          {
            type: 'object',
            required: ['t', 'pts'],
            properties: {
              t: { const: 'poly' },
              pts: {
                type: 'array',
                minItems: 3,
                items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
              },
            },
          },
        ],
      },
      wall: {
        type: 'object',
        required: ['id', 'kind', 'geom'],
        properties: {
          id: { type: 'string' },
          kind: { enum: ['wall', 'thin', 'opening', 'passage'] },
          geom: { $ref: '#/definitions/geom' },
          thick: { type: 'number', exclusiveMinimum: 0 },
        },
      },
      window: {
        type: 'object',
        required: ['id', 'geom', 'pos', 'width', 'sill', 'head', 'style', 'frame', 'glass'],
        properties: {
          id: { type: 'string' },
          geom: { $ref: '#/definitions/geom' },
          wallId: { type: ['string', 'null'] },
          pos: { type: 'number', minimum: 0, maximum: 1 },
          width: { type: 'number', exclusiveMinimum: 0 },
          sill: { type: 'number', minimum: 0 },
          head: { type: 'number', minimum: 0 },
          style: { enum: ['fixed', 'slide', 'casement', 'awning'] },
          fullHeight: { type: 'boolean' },
          frame: { type: 'string' },
          glass: { type: 'number', minimum: 0, maximum: 1 },
          steel: { type: 'boolean' },
        },
      },
      door: {
        type: 'object',
        required: ['id', 'geom', 'pos', 'width', 'kind'],
        properties: {
          id: { type: 'string' },
          geom: { $ref: '#/definitions/geom' },
          gapGeom: { $ref: '#/definitions/geom' },
          wallId: { type: ['string', 'null'] },
          pos: { type: 'number', minimum: 0, maximum: 1 },
          width: { type: 'number', exclusiveMinimum: 0 },
          kind: { enum: ['swing', 'double', 'slide', 'bifold'] },
          hinge: { enum: [0, 1] },
          side: { enum: [1, -1] },
          dark: { type: 'boolean' },
        },
      },
      solid: {
        type: 'object',
        required: ['id', 'geom', 'fill'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          geom: { $ref: '#/definitions/geom' },
          fill: { type: 'string' },
          noCal: { type: 'boolean' },
          column: { type: 'boolean' },
        },
      },
      room: {
        type: 'object',
        required: ['id', 'label', 'pos'],
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          pos: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
          wd: { type: 'number' },
          dp: { type: 'number' },
          d: { type: 'string' },
          rot: { type: 'number' },
          small: { type: 'boolean' },
        },
      },
      fixture: {
        type: 'object',
        required: ['id', 't', 'x1', 'y1', 'x2', 'y2'],
        properties: {
          id: { type: 'string' },
          t: { enum: ['counter', 'basin', 'toilet', 'tub', 'shower', 'mirror'] },
          x1: { type: 'number' },
          y1: { type: 'number' },
          x2: { type: 'number' },
          y2: { type: 'number' },
          dir: { type: 'string' },
          fa: { type: 'string' },
          open: { type: 'string' },
          rot: { type: 'number' },
        },
      },
      run: {
        type: 'object',
        required: ['id', 'path', 'depth', 'topH'],
        properties: {
          id: { type: 'string' },
          path: {
            type: 'array',
            minItems: 2,
            items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
          },
          depth: { type: 'number', exclusiveMinimum: 0 },
          topH: { type: 'number', exclusiveMinimum: 0 },
          h: { type: 'number', exclusiveMinimum: 0 },
          modules: {
            type: 'array',
            items: {
              type: 'object',
              required: ['at', 'type'],
              properties: {
                at: { type: 'number', minimum: 0 },
                type: { enum: ['sink', 'cooktop', 'fridge', 'dishwasher', 'open'] },
                w: { type: 'number', exclusiveMinimum: 0 },
              },
            },
          },
          src: { enum: ['builtin', 'user'] },
          userIndex: { type: 'integer' },
        },
      },
    },
  };
}
