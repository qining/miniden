# 研究：户型输入 → 3D 自动生成 & 软件工程审计

日期：2026-09-17 · 状态：研究/提案（未实施）

## 0. 结论速览

1. **行业共识交互模式是「机器出初稿、人工在编辑器里修」**——Planner 5D / 酷家乐 / Vloor 无一宣称一键完美。我们已有最强的「人工修」一半（墙/柱/门编辑器），缺的是「机器出初稿」的输入通道。
2. **输入通道应分四层递进**：手动绘制（已有）→ CAD 向量导入（DXF/PDF，质量最高）→ 图片底图+吸附描摹（行业兜底）→ ML 识别（可选，建议走云端 API，不进单文件）。
3. **最大的一仗是数据模型**：把硬编码的 `WALLS/FIXED/DOORS + USERGEO 索引覆盖` 重构成 **带稳定 id 的 Project 文档（JSON schema）**。这一步解锁后面所有功能，并顺手消除 AGENTS §1.2 的索引错位地雷。窗户必须先升格为一等实体（现状是墙链里的 `'g'` 子段，窗台/过梁高度写死）。
4. **户外景色**：10 个预设 = 5 种基底景观 × 昼夜，延续「程序化生成 + 固定种子」哲学（零成本、离线、确定性可回归）；后期可加 CC0 HDRI（Poly Haven）真实景选项。
5. **工程审计**：测试是强项（208 条 headless 断言），缺的是基础设施全家桶——模块/构建、TS、单测、CI、lint、LICENSE、README。P0 建议：**esbuild「源模块→单文件产物」架构**（保住「双击即开」的产品灵魂）+ TypeScript schema + vitest 单测 + GitHub Actions CI（含 calib md5 门禁）。

---

## 1. 现状盘点（本次扩展的地基）

### 1.1 数据模型

| 数据 | 形状 | 备注 |
|---|---|---|
| `WALLS` | `W(x1,y1,x2,y2,'w'|'g')` + `WSPLIT(...)`，~66 段 | 图纸 px 坐标（Y 向下）；`'g'` = 玻璃子段 |
| `FIXED` | `{name, poly:CP([...]), fill}` | 台面/柱/楔块等实心多边形 |
| `DOORS` | `DR(x1,y1,x2,y2,'swing',side,hinge?,dark?)` | **无 id，按数组下标寻址** |
| `USERGEO` | `hiddenW/ovW/hiddenP/ovP/hiddenD/ovD`（索引寻址）+ `walls[]/doors[]`（用户新增） | 按 `planner_userGeo_v1` 持久化；**改内置数组顺序会错位**（§1.2 地雷） |
| `PATIO` / `LABELS` | 阳台多边形 / 房间标注 | |
| 版本闸门 | `GEO_VERSION=3`、`USERGEO_VERSION=1` | 坐标系/内置条目变动时 bump |

**窗户现状**（本次要改的核心）：不是独立实体。窗户 = 墙链里的 `'g'` 子段；3D 端 `markGlassKinds()` 把 `'g'` 再分成三类——`fc` 落地窗（通高）、`steel` 西北钢梁带、普通窗（**窗台 0.67m / 过梁 2.25m 写死**）。没有款式、框色、开启方向、单窗高度差。2D 端只是把 `'g'` 段画成浅色条。

**日夜/环境现状**：`#dnDay` / `#dnNight` 按钮 → `cityPanorama(night)`——程序化 2048×1024 等距柱状全景 canvas（固定种子 1007/1007+7919），一处消费（`const tex = cityPanorama(night)`，做场景环境贴图/窗外景）。**西雅图城景是唯一景**。

**编辑能力现状**（§8.2）：画墙/画柱/改内置墙、门位置宽度（门垛联动）、手柄恒定屏幕尺寸、吸附、拖动快照。这些能力是「用户修户型」一半的基础设施，**已存在且被 111 条断言保护**。

### 1.2 Repo 形态

- `planner.html` **13,363 行 / 796KB**（JS 12,995 / CSS 201 / HTML 159），207 个顶层 function、44 个大写常量、**0 模块、0 依赖**（`lib/three.min.js` r147 + `OrbitControls.js` 已本地化，624KB）
- git：133 commits，remote `qining/planner`；`.gitignore` 精细（测试台/参考图/中间产物分级入库）
- 测试资产：`work/t_walledit.html`（111）/ `work/t_3d.html`（65）/ `work/t_pt.html`（32）headless Chrome 集成测试 + `check-item.py` 单件体检 + calib md5 门禁
- **缺失**：package.json、CI、ESLint、Prettier、TypeScript、单元测、LICENSE、README（10 字符）、docs/（AGENTS.md 74KB 是给 agent 的，没有给人看的架构文档）

---

## 2. 竞品怎么做的（2026-09 调研）

| 产品 | 输入通道 | 机制 | 值得借鉴 |
|---|---|---|---|
| **Planner 5D**（AI） | jpg/png/**pdf/dwg/dxf**/tif 上传 | 云端 AI 识别（发邮件通知 = 异步），产出**可编辑** 3D 工程；另有 AI Studio「增强/重绘户型图」（保留尺寸标注/房间名） | 格式覆盖面（CAD 双格式）；「识别→编辑」两段式；户型图预处理（补尺寸标注）提升识别率 |
| **Floorplanner** | 底图（jpg/png/pdf）**手动描摹**；自动转换**外包**给 Vloor（按 credit 计费的第三方服务，近实时出墙/门/窗，输入类型 sketch/handsketch/pointcloud） | 1:1 标度校准：用户对已知尺寸的两点标定，之后描摹即真实尺度 | 自己不做识别、外包 ML——**识别与编辑器解耦**；标度标定交互 |
| **酷家乐**（群核） | (a) **实景照片/全景图 → 户型**：上传后自动判别单图/全景，可选「清除软装」得净户型，生成后设层高、校验朝向；(b) **DWG/DXF/天正 T3 上传** → 自动识别墙体+门窗，单位自动检测（mm/m/ft/in），建议 ≤10MB、先删无关图层 | (a) 是 CV 重建（3D 实景级）；(b) 是 CAD 图层语义识别 | (b) 的 CAD 要求清单（单位检测、图层清理、尺寸阈值「墙宽≈240mm」自检）可直接照抄；「生成后可调层高/朝向」是户型文档必须有的两个参数 |
| **Vloor**（维也纳） | 户型图片 → 墙/门/窗 | 纯 ML 服务（API + credit） | 该赛道最成熟的「图片→矢量」供应商，可作为我们 P3 的潜在后端 |
| **RoomSketcher** | 底图描摹（自家）+ 付费 AI 识别 | 同上模式 | （搜索被限流，未展开；模式与前几家一致） |

**共性结论**：
1. 没有任何一家宣称一键完美——**人工修正环节是标配**，我们的墙编辑器正是这一环。
2. CAD 向量输入（DXF/DWG）是**质量最高的输入**（几何精确、带图层语义），各家都优先推荐；图片识别是量最大的入口但质量参差。
3. 识别结果都进**同一套编辑器**——输入通道只是 Project 文档的「生产者」，编辑器是「消费者」，两者靠 schema 解耦。

---

## 3. 技术路线

### 3.1 输入通道矩阵

| 通道 | 输入 | 浏览器内可行性 | 精度 | 工程量 | 优先级 |
|---|---|---|---|---|---|
| **P0 手动绘制** | 用户画墙/柱/门/窗（底图可垫） | ✅ 已有，111 断言保护 | 完全准确 | 扩展窗户绘制 | 立即 |
| **P1 DXF 导入** | .dxf（CAD 导出） | ✅ `dxf-parser` npm **1.1.2 / MIT**，浏览器可用，解析 LINE/LWPOLYLINE/ARC/CIRCLE/TEXT/**图层与块** | 精确（真矢量+图层名） | 中：图层名→语义映射 + 墙中线合并 | 高 |
| **P1 PDF 导入** | .pdf（CAD 导出的矢量 PDF） | ✅ `pdf.js` `page.getOperatorList()` 取路径操作符（l/c/re）→ 线段集 → 聚类成墙；**扫描件无效**（纯位图，降级走 P2） | 矢量源时精确 | 中大：路径→线段→平行线对合并成墙带 | 高 |
| **P2 图片底图+吸附** | jpg/png 户型图 | ✅ canvas 上传 + `OpenCV.js`（WASM ~10MB，jsDelivr 可托管）Canny/HoughLinesP 找墙带；描摹笔尖**磁吸**到暗带（类似现有吸附，对象换成图像特征） | 依赖图质量 | 大：图像处理管线+吸附体验 | 中（行业兜底，量大质参差） |
| **P3 ML 识别** | jpg/png | ⚠️ onnxruntime-web（WASM+WebGPU）能跑 junction 检测 CNN，但模型几十 MB，**与「单文件离线」定位冲突**；建议走云端 API（自训或接 Vloor 类服务） | 接近生产（见下） | 大（或 0，若外包） | 低（最后做） |

**P3 研究现状**（截至 2026-09）：
- **Raster-to-Vector**（ICCV 系）：junction 检测 + 整数规划聚合，**90% 精度/召回，自称进入生产区间**（github.com/art-programmer/FloorplanTransformation）
- **Raster-to-Graph**（EG 2024）：自回归图预测，输出结构+语义（墙/门/窗/房间）
- **FloorplanVLM**（2026）：VLM 直接输出**结构化 JSON 拓扑**——与我们目标 schema 同构
- **neural_floorplan**：SegFormer 7 类语义掩码 → 墙图
- 结论：学术上「图片→带语义矢量」已接近可用，但**全部是研究代码**，产品级只有 Vloor 这类付费 SaaS。

### 3.2 目标数据模型（本次扩展的地基）

把「内置户型」从常量硬编码重构成 **Project 文档**（schema v1，id 寻址，替换索引覆盖）：

```js
{
  schema: 1,
  name: '西雅图 2室2卫',
  units: 'cm',              // 显示单位，内部仍存英尺（沿用现状）
  ceilingH: 8.8,            // 层高 ft（酷家乐：生成后必设参数）
  northRotation: 0,         // 户型朝向（酷家乐：生成后校验项）
  walls:  [{ id:'w01', kind:'wall'|'glass', thick:11.2, geom: seg|arc }],    // 替代 W()/USERGEO.ovW
  columns:[{ id:'c01', geom: polygon|arc(360°), note }],                  // 替代 FIXED
  doors:  [{ id:'d01', wallId:'w01', pos: 0.4, width: 30, type:'swing', side:1, hinge:1, dark:false }], // 替代 DR()/索引
  windows:[{ id:'n01', wallId:'w01', pos: 0.5, width: 122, sill: 67, head: 225,
             style:'fixed'|'slide'|'casement'|'awning'|'fullHeight',
             frame:'#1c2528', glass:0.18 }],                               // ★ 新实体
  patio:  { geom: polygon },
  rooms:  [{ id:'r01', label:'主卧', labelPos:[x,y], dims:'401×335' }],
  env:    { preset:'seattle-city', mode:'day'|'night' }                    // ★ 环境预设
}
```

### 3.2.1 几何原语集（硬要求：原语是存储，近似只在消费端）

| 原语 | 参数 | 用途 |
|---|---|---|
| `seg` | `x1,y1,x2,y2` | 直墙（含任意锐角/钝角折线链） |
| `arc` | `cx,cy,r,a0,a1,dir` | 弧墙、圆窗、门扇摆幅弧；`a1-a0=360°` 即整圆（圆柱/圆窗） |
| `polygon` | `[pts]` | 异形柱、阳台、房间轮廓 |

**契约**（用户拍板：曲线必须原语化，不允许折线近似入库）：
1. **原语是唯一事实源**，文档里绝不存折线展开结果——否则尺寸标注（弧长 r·Δθ 精确值）、编辑手柄、将来 CAD 回导都会错
2. 所有消费者（2D SVG / 3D 挤出 / 碰撞 / 磁吸 / 标注）调用**同一个** `expand(geom)→段链` 函数，折线粒度由各消费者自己定（2D 出图可以粗，碰撞要细）——单一展开点，逻辑不散落
3. 各端原生渲染仍走真曲线：2D 用 SVG path `A` 指令、3D 用 partial cylinder 挤出、标注用解析弧长——展开只服务碰撞/吸附这类逐段算法
4. **编辑手柄**：arc = 2 端点 + 1 方向点（三点定弧），端点磁吸到墙 junction；polygon = 逐顶点手柄（现状「画柱/异形」的升级）
5. **CV 检测端直接输出原语**：整圆走 `HoughCircles`、弧段走边缘采样点圆拟合、墙走 Hough 直线——检测结果就是 `seg/arc/polygon`，不是像素折线

闭环自测相应加一组样本：斜墙 + 锐角折线 + 方柱 + 圆柱 + 一段弧墙 + 门窗缺口，逐特征比对 ground truth（我们的矢量数据渲染成图即 ground truth）。

要点：
- **id 寻址**：用户编辑直接改文档里的条目（有 id），不再索引覆盖 → §1.2 的「内置数组重排即错乱」地雷**结构性消失**（版本闸门保留，但只守 schema 大版本）
- 当前户型 = 该 schema 的一个实例（一次性迁移脚本从 `WALLS/FIXED/DOORS` 生成 v1 文档，之后常量退役、`eff*()` 改为读文档）
- **schema 版本号 + 迁移链**（`migrate(v0→v1→...)`）：USERGEO_VERSION 的教训通用化——任何字段增删走迁移函数，不靠用户数据碰运气
- JSON Schema 描述 + 载入时校验（非法文档拒绝并提示哪条错，而不是静默坏图）
- 序列化进 IndexedDB（见 §5 P1-10）；导出/导入 JSON（现有「导出布局」能力扩到整工程）

### 3.3 窗户实体（2D/3D/面板三端）

**参数**（竞品通用 + 建筑常识）：
- 几何：所在墙 + 位置（沿墙 0..1）、宽度、**窗台高、过梁高**（现状写死 67/225cm → 每窗可调）
- 款式：固定玻璃 / 推拉 / 内开（casement，可开 30-90°）/ 上悬 / 落地（通高，替代现有 `fc` 隐式标记）
- 框：颜色（深铝/白/木纹）、框宽；玻璃：透明度/反射度
- 可选：窗帘（后续，不在本期）

**三端行为**：
- 2D：墙带上画白色窗带 + 款式符号（推拉=双竖线、内开=弧线、固定=单线）——现状 `'g'` 段只有颜色，区分不出款式
- 3D：框（型材截面挤出）+ 玻璃（transmission/opacity）+ 内开扇的旋转组（用 §5.4.7 的「Group 只管转向」规矩，避免复合欧拉角）；落地款保留钢梁逻辑（现有 `steel` 带独立保留）
- 属性面板：选中窗 → 宽度/窗台/过梁滑块 + 款式下拉 + 框色（沿用现有灯具色温面板的模式）
- **2D 图例新增 kind 相关**：窗户是建筑构件不是家具，走 `eff*()` 几何出口（2D/3D 共用同一文档），**不**进 CATALOG/kind 体系

### 3.4 户外景色（10 预设 + 昼夜）

**保持程序化哲学**（离线、单文件、固定种子可回归——repo 已验证的原则）：
`cityPanorama(night)` 泛化为 `panorama(preset, mode)`，preset × mode 矩阵：

| 预设 | day | night |
|---|---|---|
| 西雅图城市（现有，保留种子 1007/18798） | ✅ 已有 | ✅ 已有 |
| 郊区别墅（低层+树冠+远山） | 新 | 新 |
| 山林（树线+薄雾） | 新 | 新（月光+星空） |
| 海景（地平线+水面反光） | 新 | 新（城市/灯塔灯光） |
| 公园庭院（近景树冠+草坪色） | 新 | 新 |

= **10 个组合**。实现：每个预设一个生成函数（共享天空渐变/太阳月/云/建筑/树/水面组件函数），种子各不同；`panorama()` 带 `_skyCache[preset+mode]` 缓存（沿用现有缓存模式）。

**光照联动**：昼夜切换已经改灯光（`applyLightMode`）；环境预设再叠加**环境色温/亮度**（海景偏冷、山林偏绿、夜景更暗），通过现有 `uEnvInt` / 环境贴图强度调，不动管线。

**可选二期**：真实 HDRI——**Poly Haven**（数百张 **CC0** 等距柱状 HDRI，免登录下载；4K EXR 下采样成 2K JPEG 约 200-400KB/张，10 张 ~3MB 进 repo 或按需懒加载）。CC0 = 无版权无署名要求，商用安全。程序化做默认（零成本、确定性），HDRI 做「真实感」开关。

### 3.5 落地顺序（每步独立可交付，全走现有四道验证关）

1. **Project schema v1**：迁移当前户型为文档实例；`eff*()` 改读文档；id 寻址替换 USERGEO 索引层（保留旧数据一次性迁移）
2. **窗户实体**：文档字段 + 2D 符号 + 3D 框/玻璃/款式 + 属性面板 + 选墙放窗交互
3. **墙/柱编辑扩展到 user project**：现有编辑器对象从「内置+覆盖」切到「文档直编」（交互层大多复用）
4. **10 环境预设**（程序化）+ 昼夜/环境联动光照
5. **DXF 导入**（dxf-parser：图层名映射 → 文档；单位检测照抄酷家乐清单）
6. **PDF 向量导入**（pdf.js getOperatorList → 线段聚类 → 文档；扫描件检测后提示转 P2）
7. **图片底图 + 磁吸描摹**（OpenCV.js 墙带吸附；可选）
8. **ML 识别**（云端 API 选项；或挂 Vloor 类服务；最后做）

---

## 4. 软件工程审计

### 4.1 现状评分

| 维度 | 现状 | 评价 |
|---|---|---|
| 版本控制 | git 133 commits + 精细 .gitignore + 远端 GitHub | ✅ 好 |
| 集成测试 | 3 测试台 208 断言 + check-item.py + calib md5 门禁 | ✅ **强**（远超同规模项目平均） |
| 确定性 | 种子化贴图（渲染可 md5 回归） | ✅ **强** |
| 文档（agent） | AGENTS.md 74KB + SKILL.md 作业指导书 + 软链双 agent 兼容 | ✅ **强** |
| 模块化 | 0（单文件 13k 行 JS，207 顶层函数平铺） | ❌ |
| 构建/依赖 | 无（three 手工 vendored） | ❌ |
| 类型安全 | 无（纯 JS，schema 靠人肉） | ❌ |
| 单元测试 | 0（只有端到端 headless） | ❌ |
| CI | 无（所有门禁靠本地手跑） | ❌ |
| Lint/格式 | 无 | ❌ |
| LICENSE | 无（**vendored three.js 是 MIT，有署名义务**） | ❌ |
| README（人） | 10 字符 | ❌ |

**一句话**：测试文化与 agent 文档是一流的，工程基础设施是零。风险集中在单文件（任何大改动都是 800KB 文本手术，无边界可守）和门禁全靠手跑（人忘了跑 = 无保护）。

### 4.2 改进清单（按优先级）

**P0 —— 本次户型扩展的前置条件**

1. **模块化的正确姿势：「源模块 → 单文件产物」**
   - `src/` ES modules：`schema/`（project 文档+校验+迁移）、`geometry/`（墙线运算/吸附/门垛，纯函数）、`state/`（store+持久化）、`render2d/`、`render3d/`（静态场景/家具/门窗/光）、`textures/`、`catalog/`、`models/`（MODELS 注册表）、`ui/`
   - **esbuild** 一行命令 bundle 回自包含 `planner.html`（inline 全部 JS + 可选 inline three）——**「双击即开、离线」的产品灵魂不变**，源码获得模块边界
   - three r147 从 `lib/` 提升为 npm 依赖（`three@0.147.0`），构建时内联；OrbitControls 用对应版本 examples/jsm
   - **增量迁移**：一次搬一个模块（先 `textures/`、再 `geometry/`…），每次搬完跑三测试台 + calib md5，绿灯再下一个。**禁止 big-bang 重写**
2. **TypeScript**：schema 类型是本次扩展的生命线（Window/Door/Wall/Project 的字段约束）。esbuild 直接吃 TS，`tsc --noEmit` 做类型门禁。策略：`src/` 新代码全 TS，迁移一个模块转一个；`planner.html` 单体退役前允许混合
3. **Project 文档 = JSON Schema + 迁移链**（见 §3.2）：`validate(doc)` 载入时跑，`migrate(doc)` 按 schema 版本号升级；schema 文件本身就是文档
4. **单元测试（vitest）**：现在纯函数（几何、`fmtLen`、吸附、`ptPickGrid`、schema 迁移）**零覆盖**，全靠 208 条端到端（慢且粒度粗）。vitest + jsdom 覆盖纯函数层（目标：schema/geometry 两模块行覆盖 >80%）；headless 测试台保留为 E2E 层
5. **CI（GitHub Actions）**：PR 触发：`tsc --noEmit` → `eslint` → `vitest` → esbuild 构建 → **headless Chrome 三测试台 + calib md5 门禁**（ubuntu-latest 自带 Chrome，加 `--use-angle=swiftshader`；AGENTS §5.2 的坑在 Linux 同样适用，需先把 macOS 专属路径参数化）。**calib md5 进 CI 是这次审计性价比最高的一条**——它现在只在人记得跑的时候才跑

**P1 —— 质量与可维护性**

6. **ESLint + Prettier**：Prettier 先行（一次独立 commit 全量格式化，diff 巨大但机器可审）；ESLint 开 `no-unused-vars`/`no-undef`/`no-irregular-whitespace`——13k 行无 lint 必然有死变量/笔误
7. **LICENSE + 第三方归属**：加 LICENSE（项目自己的许可）；`THIRD-PARTY.md` 列 three.js（MIT, © Three.js authors）、OrbitControls（MIT）、（若用）dxf-parser（MIT）、OpenCV.js（Apache-2.0）、pdf.js（Apache-2.0）
8. **README（人看的）**：功能列表、截图、打开方式、快捷键、license、指向 docs/ 与 AGENTS.md
9. **docs/ 架构文档**：数据流图（`Project doc → eff*() → 2D/3D`）、模块边界说明、schema 参考——把 AGENTS.md 里给 agent 的架构知识提炼出给人看的版本
10. **持久化升级 localStorage → IndexedDB**：localStorage 5MB 上限 + 同步 API；工程文档（含未来底图缩略图）会超。写一个 `storage.js` 门面（接口不变，实现换），迁移现有 key（`planner_v1`/`planner_userGeo_v1`/`planner_panels_v1`）

**P2 —— nice to have**

11. i18n（UI 字符串硬编码中文；目录名保留原文拼写）
12. PWA/service worker（file:// 已经可用，优先级低）
13. 包体预算进 CI（esbuild 报告，796KB 基线，超阈值报警）
14. 启动性能标记（首帧/目录渲染时间，console + 可选 onscreen）
15. `work/` 665MB 研究产物：ref/ 图片考虑 LFS 或拆独立 repo

### 4.3 关键权衡（决策时的约束）

- **「单文件零依赖」是产品灵魂**（用户双击即用、离线、无构建步骤才能分享）→ 构建系统必须产出单文件，不能变成「npm dev 起服务器才能看」
- **确定性（种子化）是回归测试的前提** → 任何重构/新贴图必须守 `srand()` 纪律，calib md5 是最终裁判
- **门禁已证明有效**（208 断言 + md5 抓出过真 bug）→ 方向是**自动化**（CI）而不是加更多手跑步骤
- **迁移风险排序**：schema 化 > 模块化 > TS > 其余。schema 是产品需求本身（户型文档），其余是手段

---

## 5. 参考来源

**竞品**
- Planner 5D AI：planner5d.com/ai；support.planner5d.com 文章 14434484（上传格式 jpg/png/pdf/dwg/dxf/tif）、15501753（AI Studio 户型生成）
- Floorplanner：help.floorplanner.com 文章 2410818（Backdrop 1:1 标定）、2411010（Vloor 转换服务）；floorplanner.readme.io（Vloor API：image_type sketch/handsketch/pointcloud）
- 酷家乐帮助中心：3FO4K4WEYGII（实景/全景图→户型，清软装选项、层高/朝向修正）、3FO4K4VYBNVO（CAD 上传要求：DWG/DXF/T3、单位自动检测、≤10MB、删无关图层、墙宽≈240mm 自检）
- Vloor：vloor.com（维也纳，图片→墙/门/窗 ML 服务）

**ML/开源**
- Raster-to-Vector（github.com/art-programmer/FloorplanTransformation，~90% P/R）
- Raster-to-Graph（EG 2024，github.com/SizheHu/Raster-to-Graph）
- FloorplanVLM（arXiv 2602.06507，VLM→JSON 拓扑）
- neural_floorplan（github.com/daegeun-kim，SegFormer 7 类 + 墙图）

**库**
- dxf-parser **1.1.2**（MIT，npm；仓库 gdsestimating/dxf-parser）：Header/2D 实体/图层/块/TEXT
- pdf.js：`page.getOperatorList()`（矢量 PDF 路径提取）
- OpenCV.js（WASM，jsDelivr 托管）：Canny/HoughLinesP
- Poly Haven（polyhaven.com/hdris）：数百张 **CC0** 等距柱状 HDRI，免登录
