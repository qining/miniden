# 架构总览（现状 · E9）

> 这是**给人读的当前架构**。它描述代码现在长什么样、数据往哪流、边界在哪、哪些红线不能碰。
> 给 agent 的操作知识（怎么跑门禁、踩坑清单）在根目录 `AGENTS.md`；
> 2026-09 的「目标模块图」在 [research/07-architecture.md](../research/07-architecture.md)，
> 本文 §9 逐条对照它哪些已落地、哪些还没。
>
> 数据基准：2026-10-07 · `app.html` 15,704 行 / 978KB · 目录 280 条目 / 146 个模型函数 / 20 类。

---

## 1. 一句话架构

**一个事实来源，两个入口，三条渲染路径，一个几何出口。**

- **一个事实来源**：`app.html`。改代码只改它。
- **两个入口**：公开入口（generic 户型）与个人入口（真实户型），都由 `build.mjs` 从它生成。
- **三条渲染路径**：2D SVG（DOM）· 3D WebGL2（three r147）· 照片级路径追踪（裸 GLSL，WebGL2）。
- **一个几何出口**：`effWalls() / effFixed() / effDoors() / effFixtures()`。
  2D 与 3D 读的是同一份投影，任何新消费端都必须走这里。

---

## 2. 文件与产物地图

| 文件 | 入库 | 户型 | 形态 | 角色 |
|---|---|---|---|---|
| `app.html` | ✓ | generic | 源形式（`lib/` 外链） | **唯一事实来源**；clone 后直接打开就是公开入口 |
| `planner.html`（根目录） | ✓（含真实坐标，已批准的豁免） | mine | 源形式 = app.html + mine 替换 | 日常打开的那个；改完 app.html 刷新即见 |
| `dist/app.html` | ✗ | generic | 单文件 bundle | **公开 / 用户入口**（可托管、可分享） |
| `dist/planner.html` | ✗ | mine | 单文件 bundle | 个人入口单文件；ui-gate 与 dist bench 用它 |
| `src/schema/*.ts` | ✓ | — | TypeScript | 文档层（类型 / 校验 / 迁移 / 几何原语） |
| `src/geo/*.ts` | ✓ | — | TypeScript | 导入层（DXF / PDF / 描摹 / 共享几何归一化） |
| `src/*/dist-*.js` | ✓ | — | esbuild 产物 | 编译后的模块，被 `build.mjs` 嵌进 HTML 的 `<script id="miniden-schema|geo">` |
| `lib/` | ✓ | — | vendored UMD | three r147 · OrbitControls · pdf.js(+worker) · dxf-parser |
| `bench/*.js` | ✓ | 无关 | 测试脚本 | plan-independent 断言源（注入 3 个入口） |
| `private/bench/t_walledit.js` | ✗ | mine | 测试脚本 | 含真实户型坐标断言，只能本地跑 |
| `private/**` | ✗ | mine | — | 照片 / 图纸 / mine.json / 布局源 / golden 基线 |
| `data/plans/generic.json` | ✓ | generic | JSON | 入库的通用户型（`app.html` 的 `#miniden-plan` 必须与它逐字节一致，构建守卫） |
| `work/` | ✗ | — | 生成物 | bench HTML、探针、压力测试布局 |

**隐私分区**（AGENTS §1.4）：左列「必须干净」由构建硬断言 + 审查保证 ——
`app.html`、`dist/app.html`、`bench/`、`tests/`、`docs/`、`data/plans/generic.json`；
右列「允许含真实户型」是已知且被接受的 —— `planner.html`、`dist/planner.html`、`private/**`。

---

## 3. 数据流

### 3.1 主链（几何）

```
#miniden-plan (JSON, 内嵌在 HTML 里)
   │  committed = data/plans/generic.json   ← 构建守卫逐字节比对
   │  本地构建时 build.mjs 注入 private/plans/mine.json
   ▼
PLAN 常量（L572）  ── SC / CEIL_H / FLOORPTS / WALLS / INNER / DOORS / FIXED / LABELS / FX / PATIO / ISL / CALIB
   │
   │  freshDoc() 用 PLAN 播种 ProjectDoc（内置实体 + 户型专属快照 planOf(k)）
   ▼
DOC : ProjectDoc  ← 唯一的几何状态（id 寻址；内置实体也在里面，可被编辑/隐藏）
   │  编辑层（wallEdit.sel / doorView / segView / pushUser*）直写 DOC 实体
   │  导入层（applyImportedDoc）整体替换 DOC
   ▼
docToLegacy(DOC)  ── 投影键集合冻结（oracle 测试守着；新文档字段不得进投影）
   ▼
effWalls() / effFixed() / effDoors() L1127-1143        ← 几何出口（CALIB 下直接返回内置常量）
effFixtures() L1143                                    ← 例外：直接返回 DOC.fixtures（洁具不走投影）
   │                    │                     │
   ▼                    ▼                     ▼
2D SVG               3D 场景              路径追踪
build2D L1583        buildStatic3D L4039   ptCollect → ptBuildBVH L4734
wallPolys 咬合        门窗/洁具/厨房/柱      → 打包 RGBA32F 纹理
furnShape 图例        furn3D + MODELS       → 分块累积 → À-Trous 降噪
drawWallEdit L2699    sync3D L14122         → ACES + sRGB
   │                    │
   └── 命中测试 / 手柄 ──┴── 拾取 / 拖动（同一份几何，同一套坐标）
```

**为什么投影层还在**：渲染代码是段式的（`{x1,y1,x2,y2,t}`），文档是实体式的（id + geom）。
`docToLegacy` 是这两层之间唯一的翻译点，它的输出键集合与历史 `eff*` 逐字节等价 ——
这是 calib md5 能保持不变的原因（ADR-0005 的「文档层升级、渲染层不动」）。

消费端需要文档才有的字段（窗户 `style/frame/sill/head`、实体 `column`）时，
用投影里的 `_id` 回查文档：`entById(s._id).style`。**新的文档字段一律不进投影。**

### 3.2 输入支路（四条路都汇到同一个咽喉）

```
.dxf ──┐
.pdf ──┼─→ src/geo/*（纯函数，零 DOM/GL）→ RawGeo → buildDocFromRaw → ProjectDoc
描摹 ──┘        单位推断 / 图层分类 / 共线归并 / 形状分类（柱 vs 柜体带 vs 房间）
截图描摹 ────────────────────────────────────────────────┘
                                                    ▼
                                    applyImportedDoc(doc, info)   ← 单一咽喉
                                    validate(doc) + checkGeoms(doc)
                                    + info.warnings（丢弃了什么、按什么判据、默认值）
```

**判据纪律**（ADR-0002 + AGENTS §8.2）：实体只能来自「用户画的」或「导入读到的几何」。
形状分类允许（对读到的轮廓做几何判据），启发式猜测不允许；任何被丢弃的输入必须进 `info.warnings`。

### 3.3 持久化支路

```
DOC ──saveDoc()──→ localStorage['planner_doc_v1:' + PLAN_FP]
state.items ─────→ localStorage['planner_v1:'   + PLAN_FP]
面板宽度/折叠 ───→ localStorage['planner_panels_v1']

PLAN_FP = fnv(name + sc + floorpts + walls + doors.length)   ← 按户型分桶，避免存档串户型
旧单键（planner_doc_v1 / planner_v1 / planner_userGeo_v1）：只读兼容，采用前 docMatchesPlan() 逐坐标核对
```

**目录是 app 数据，摆法才是用户数据**：280 条目录（商品/尺寸/价格/模型代码）在 `app.html` 里，
与 localStorage 无关；localStorage 里只有「哪件商品摆在哪个坐标」。
所以户型 JSON 带 `layout`（随文件走）：个人入口有，公开入口必须 `layout:null`（构建硬断言）。
`load()` 优先级：本户型指纹存档 → 旧单桶存档（只读）→ `PLAN.layout` 播种，
**播种只在指纹键完全不存在时发生**（存过档哪怕存的是空数组也不播种）。

---

## 4. 模块边界

### 4.1 已抽出的纯层（可测、可进 worker）

| 模块 | 大小 | 职责 | 依赖约束 |
|---|---|---|---|
| `src/schema/primitives.ts` | 7.4KB | seg/arc/poly 原语、`expand()`（唯一 geom→段链出口）、弧工具 | 无 DOM、无 three |
| `src/schema/project.ts` | 37.8KB | ProjectDoc 类型、`validate()`、`checkGeoms()`、id 分配（`nextId`） | 无 DOM |
| `src/schema/migrate.ts` | 17.5KB | 版本迁移链（legacy → v1）、`docToLegacy()` 与它的字节等价 oracle | 无 DOM |
| `src/geo/import-common.ts` | 34.9KB | 共享归一化：单位推断、图层分类、共线墙带归并、形状分类、`buildDocFromRaw` | 无 DOM |
| `src/geo/import-dxf.ts` | 8.9KB | DXF 实体 → RawGeo（含 bulge→arc） | 无 DOM |
| `src/geo/import-pdf.ts` | 22.4KB | PDF 内容流 OPS → 路径 → 弧拟合 → RawGeo | 无 DOM |
| `src/geo/image-trace.ts` | 13.0KB | 截图描摹：Otsu / Sobel+NMS / hysteresis / Hough | 无 DOM |

这七块由 **183 条 vitest** 覆盖（纯函数层），`tsc --noEmit` 严格模式，Prettier 格式化。

### 4.2 `app.html` 内部区块（行号是 2026-10-07 的锚点，会随改动漂移）

| 区块 | 锚点 | 内容 |
|---|---|---|
| 内嵌模块 | L537 / L544 | `<script id="miniden-schema">` / `<script id="miniden-geo">`（构建嵌入） |
| 户型 JSON | L553 | `<script type="application/json" id="miniden-plan">` |
| 户型常量 | L572 | `PLAN` 解析 + `SC/CEIL_H/FLOORPTS/WALLS/…` |
| 目录数据 | L678 | `CATALOG`（280 条目 / 20 类 / 57 kind） |
| 状态与持久化 | L1013 | `PLAN_FP`、`DOC_KEY`、`freshDoc`、`docMatchesPlan`、`loadDoc`、`saveDoc` |
| 几何出口 | L1127 | `effWalls / effFixed / effDoors / effFixtures` |
| 导入咽喉 | L1195 | `applyImportedDoc` |
| 2D | L1583 | `build2D`、`wallPolys` L1493、`furnShape` L1728、`drawFurniture` L2052、量尺寸（`meas` L14556） |
| 墙体编辑器 | L2699 | `drawWallEdit`（命中区/手柄）、`wallEditDown` L2960、`doorLinkage` L1366、`snapPt` L2366 |
| 贴图 | L3536 | 程序化 CanvasTexture（`srand` 固定种子 + 惰性单例缓存） |
| 3D 静态场景 | L4039 | `buildStatic3D`、门窗、洁具、厨房、柱 |
| 路径追踪 | L4734 | `ptBuildBVH`、`ptBuild` L4895、着色器、分块累积、降噪 |
| 建模注册表 | L6265 | `MODELS`（146 个模型函数，约占 JS 的 47%） |
| 家具运行时 | L13421 | `mergeByMaterial`、`modelCtx` L13467、`furn3D` L13600、`sync3D` L14122、`furnThumb` L14209 |
| UI | L14337+ | `buildCatalog` 卡片网格、属性面板、`setView` L14622、视角/日夜、对话框、事件绑定 |

**为什么还没拆文件**：`MODELS` 只依赖 `modelCtx` 的 ~20 个辅助 + `C.spec`，
贴图是全局惰性单例 —— 这两块拆出去是纯搬运；但 `render2d/render3d/ui` 互相引用 DOM 与 `state`，
拆分的真正成本在「classic script → ESM 的作用域语义差异」（AGENTS §5.7 的七个坑）。
当前策略：**纯层已经抽出并测试；DOM 层保持单文件，靠 bench 门禁而不是靠模块边界**。

### 4.3 依赖方向

```
src/schema  →  src/geo  →  app.html(数据/几何出口)  →  render2d / render3d / pt  →  ui
     ↑ 无环；纯层禁止 import three / document（vitest 在 node 里跑它们 = 事实上的强制）
```

---

## 5. 构建管线（`build.mjs`）

```
app.html（唯一事实来源）
  ├─ 守卫 1：嵌入的 schema 块 == src/schema 最新编译      （不一致直接报错）
  ├─ 守卫 2：嵌入的 geo 块   == src/geo 最新编译
  ├─ 守卫 3：#miniden-plan 块 == data/plans/generic.json   （plan 漂移 = 报错）
  ├─ classic 脚本 → ESM：顶层函数去重（复刻 classic 语义）
  │                     + globalThis 镜像（getter/setter 闭包，覆盖全部顶层声明）
  ├─ lib/ 内联：three + OrbitControls + dxf-parser + pdf.js(+worker)
  │              （注入串一律 $ → $$ 转义，AGENTS §5.1）
  ├─ esbuild 捆成单文件
  ├─ 注入 mine plan + private/ 路径修复 → dist/planner.html
  ├─ 硬断言：dist/app.html 不含 private/ 引用 · 户型名 = generic-2br · plan.layout 为空
  ├─ 重新生成根目录 planner.html（有 private/plans/mine.json 时）
  └─ 重新生成 8 个 bench HTML（3 脚本 × source/dist/dist-generic；一律剥掉 layout）
```

**dist 变体是同步门禁，不是冗余**：同一套 plan-independent 断言跑 source(mine) / dist(mine) /
dist(generic) 三份。新工具或新家具换个户型就坏 → 立刻红。

---

## 6. 门禁矩阵

| 门禁 | 本地（有 private/） | CI（无 private/） | 守什么 |
|---|---|---|---|
| `tsc --noEmit` | ✓ | ✓ | 纯层类型 |
| ESLint + Prettier | ✓ | ✓ | JS 工具面 lint；全手写代码面格式 |
| `vitest run` | 183 | 176（7 条 fixture 门控跳过） | schema/geo 语义 |
| `npm run build` 守卫 | ✓ | ✓ | 嵌入块与 src 一致、plan 不漂移、公开入口隐私 |
| `size:check`（E13） | ✓ | ✓ | 包体预算棘轮 |
| `t_walledit` 253×2 | ✓ | ✗（含真实坐标断言） | 2D 交互、门联动、导入、对话框 |
| `t_3d` 120×3 | ✓ | ✓ | 3D 拾取/拖动、全目录建模+贴图体检、缩略图 |
| `t_pt` 33×3 | ✓ | ✓ | 光追 BVH/着色器/降噪/萤火虫/白家具可辨识度 |
| `#calib` md5 | ✓ | ✗（需 private 底图） | **户型几何逐字节不变**（AGENTS §1.1） |
| `ui:gate` 8 态 | ✓ vs mine golden | ✓ 自建 generic 基线双截 | 本地 = 视觉回归；CI = 渲染确定性 + 页面可渲 |

**「--update 之后的 8/8 @ 0.0000% 什么都不证明」**：重拍基线会把回归焊进基线。
重构类改动的验收必须对**改动前的版本**独立做一次像素对比（AGENTS §3）。

---

## 7. 不变量清单（红线）

1. `#calib` md5 `1ac26921871db50ef1c055674c10e6e7` —— 几何视图逐字节不变；新视觉元素一律不进 calib
2. **投影键集合冻结** —— `docToLegacy` 输出与 legacy `eff*` 逐字节等价；新文档字段不进投影
3. **贴图种子表只增不改** —— 渲染确定性是像素回归的前提（`srand()` + `rnd01()`）
4. **两个版本号不混用** —— `GEO_VERSION`（家具存档闸门）/ `DOC_DATA_VERSION`（内置实体结构闸门）
5. **plan-independent** —— 入库的 bench 不得写死某户型的数量或坐标；断数量与运行时投影比
6. **双击即开 / 离线 / 零网络** —— 依赖只有 `lib/`，无构建步骤也能跑源形式
7. **隐私分区** —— 新的个人数据默认进 `private/`；公开侧由构建硬断言守
8. **包体预算是棘轮** —— 上调是显式动作，必须写进提交信息

---

## 8. 术语表

| 术语 | 含义 |
|---|---|
| **ProjectDoc / DOC** | 唯一的几何状态：id 寻址的实体集合（walls / windows / doors / solids / fixtures / runs / rooms / hidden / plan） |
| **投影（projection）** | `docToLegacy` 把 DOC 翻译成渲染层吃的段式对象；`eff*()` 是它的对外门面 |
| **内置实体 vs 用户实体** | 内置 = 从 plan JSON 播种（可编辑、可隐藏，不可「删干净」）；用户 = 画出来或导入读到的（`src:'user'`，可删） |
| **carrier** | 承载门洞的那段 `'d'/'o'` 墙段；门拖动时它跟着走，门垛按增量平移 |
| **CALIB** | `#calib` 校准视图：锁死旧版面板布局、只画几何、`effDoors()` 返回 `[]` |
| **PLAN_FP** | 户型指纹（name+sc+floorpts+walls+doors.length 的 hash），用于把存档按户型分桶 |
| **plan-independent** | 换户型照样全绿的性质；入库 bench 的准入条件 |
| **黄金截图 / golden** | `#ui:<state>` 规范态截图基线（8 态），本地 mine、CI 自建 generic |

---

## 9. 与 R7 目标模块图的差距

| R7 设想（2026-09） | 现状（2026-10-07） |
|---|---|
| `src/schema/`（project/primitives/expand/migrate） | ✅ 已落地（`expand` 在 `primitives.ts` 内） |
| `src/geo/`（wallband/snap） | ⚠️ 部分：导入侧已抽出（`import-common` 含墙带归并）；**`wallband`/`snap` 仍在 `app.html` 的 wallEdit 里** |
| `src/data/catalog.json` | ❌ `CATALOG` 仍是 `app.html` 里的数组（85KB 级） |
| `src/models/`、`src/textures/` | ❌ 仍在 `app.html`（MODELS 146 个 / 贴图 26 个） |
| `src/render2d|render3d|pt|ui|main` | ❌ 未拆（classic→ESM 语义坑，AGENTS §5.7） |
| `src/import/`（dxf/pdf/cv，跑 worker） | ⚠️ dxf/pdf/描摹已抽出且纯函数化，**但仍在主线程跑**，cv/OpenCV 未做 |
| `src/storage/`（IndexedDB 门面） | ❌ 仍是 localStorage（= **E10**） |
| lib/ 走 npm → esbuild 内联 | ⚠️ 已内联进 dist，但源仍是 `lib/` vendored 文件（不是 npm 依赖） |
| worker 线程模型 | ❌ 未做 |
| 迁移不变量清单 | ✅ 全部在守（本文 §7） |

**结论**：R7 的「纯层先抽、DOM 层最后动」策略执行了一半 —— 纯层（schema/geo）已经抽出、
测试覆盖 183 条、可进 worker；DOM 层保持单文件，靠 bench 三入口门禁 + calib md5 保证行为不变。
下一步若要继续拆，性价比最高的两块是 `CATALOG` 数据外置（纯搬运、零行为风险）
与 `MODELS` 分族成文件（最大块、纯搬运），而不是先动 render/ui。

---

## 10. 相关文档

- [roadmap.md](../roadmap.md) —— 工作项与状态
- [research/07-architecture.md](../research/07-architecture.md) —— 目标模块图（R7）
- [research/06-persistence-and-sync.md](../research/06-persistence-and-sync.md) —— 持久化与同步（E10 的前置研究）
- [decisions/0004-single-file-artifact.md](../decisions/0004-single-file-artifact.md) —— 单文件产物
- [decisions/0005-project-schema-v1.md](../decisions/0005-project-schema-v1.md) —— ProjectDoc = id 寻址 JSON
- `AGENTS.md` §7（代码结构地图）、§1.1/§1.2（红线）、§5.7（classic→ESM 的坑）
