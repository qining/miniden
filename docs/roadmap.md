# MiniDen 路线图

状态：`todo` → `doing` → `done(<commit>)`。
依赖关系：S1 是一切的前提；E 系列（工程）与 S 系列（产品）可交替推进，
但 E1（esbuild 模块化）已迈出第一步（2026-09-17）：**管线等价性证明完成**（dist 单文件与 source 逐字节等价：calib md5 + 三台测试台全绿，见 AGENTS §5.7）；后续 src/ 模块化时直接写 TS。

> **调性（ADR-0006，一切取舍的最高判据）**：给 homeowner 做简单规划；
> 「快捷」= **time-to-insight**（用户不建模；形成「我家」的概念以分钟计；
> 施工图级细节不做）；扩展**代码优先**（skill 是交付物，不是依赖；运行时零 AI）；
> 范围内把精度/准确度/可用度拉满。优先级冲突时用它裁。

## 研究（R 系列，产出 docs/research/）

| # | 主题 | 状态 | 产出 |
|---|---|---|---|
| R1 | DXF/PDF 导入可行性深潜：dxf-parser 实体/图层/单位细节、pdf.js operatorList 提取、酷家乐单位检测清单 | done | research/01 |
| R2 | 图片描摹/ML：OpenCV.js WASM 能力与体积、Vloor API、学术 SOTA（raster→vector 精度现状） | done | research/02 |
| R3 | 3D 渲染管线：WebGPU ray query 状态、浏览器光追/降噪 SOTA、three.js WebGPURenderer、HDRI 源（Poly Haven） | done | research/03 |
| R4 | 家具目录与商品数据：竞品目录结构、GLTF vs 程序化建模（单文件约束下）、IKEA/零售商数据源 | done | research/04 |
| R5 | 编辑器 UX：墙体编辑模式（段式 vs 对象式）、吸附、undo/redo 设计、多户型管理 | done | research/05 |
| R6 | 持久化与同步：localStorage→IndexedDB、导入导出、云同步选项 | done | research/06 |
| R7 | 整体架构：planner.html 区块实测解剖（MODELS=327KB/47%）→ 目标模块图（schema/geo/data/models/render*/ui，无环依赖）+ 线程模型 + 迁移不变量 | done | research/07 |
| R8 | 家具库 scalability：增长成本模型（变体 0KB/新家族 2.5KB）；四个真瓶颈（单文件软顶~3-5MB、GPU 三角负载先触顶、卡片 UI、**work/ 644MB 入库**）；规模路线图（500→1,500→10k+） | done | research/08 |
| R9 | UI 整体风格：现状盘点（截图实测）vs 竞品坐标（P5D 亮色/HBM 渲染即产品/酷家乐深色 pro）→ 提案 **Warm Dark** + design token 初稿 + 组件清单 + 三步执行序 | done | research/09 |
| R10 | UI 改动验收标准（v2 用户增补）：**七道关**——行为断言/calib 不变性/黄金截图（`#ui` 8 状态）/**交互流程（先点 A→再点 B→发生 C：流程脚本+每步反馈断言+HCI 十维度+核心流程动作数回归）**/**人眼可见性（agent 说可见≠人看得到：几何/遮挡/截图放大三层探针）**/交互体检/卫生 | done | research/10 |

## 产品功能（S 系列，顺序 = 依赖序）

| # | 工作项 | 状态 | 备注 |
|---|---|---|---|
| S1 | **Project schema v1**：户型迁移为文档实例；`eff*()` 改读文档；id 寻址替换 USERGEO 索引层；旧数据一次性迁移 | **完**：Phase 1（`src/schema/` 纯函数 + 等价性 oracle 单测，1bb1637）→ Phase 2a（eff* 文档驱动 + 双写持久化，74aaefe）→ Phase 2b（编辑层全面 id 寻址：USERGEO 彻底退役，持久化单键 `planner_doc_v1`，内置实体直写文档、旧 ov*/hidden 仅作投影兼容；回归 112+65+32 源+dist 双绿） | ADR-0005；**第一优先** |
| S2 | **窗户实体**：文档字段 + 2D 符号 + 3D 框/玻璃/款式 + 属性面板 + 选墙放窗 | **完**（本次提交）：款式面板（固定/推拉/平开/上悬 + 通高 + 黑钢/白框，直写文档）；2D 款式符号（推拉=双平行线、平开=中缝铰链开扇弧、上悬=横档刻度，`!CALIB` 门控保校准基线）；3D 按款式建框（平开=双扇四边框+中梃+把手、推拉=双扇+对开缝、上悬=亮子横档、框色随文档，对 mergeByMaterial 感知的顶点数断言）；选墙放窗 = 选中墙改类型 g / 画墙工具选 g（S1 2b 已有路径）。注：`style` 不进 legacy 投影（字节等价约束），消费端经 `_id` 回查文档实体 | 依赖 S1（已满足） |
| S3 | **墙/柱编辑切到文档直编**：交互层复用现有编辑器 | **随 S1 Phase 2b 完**（墙/柱/门/窗编辑全部直写文档实体，`restoreBuiltins` = #wRestore） | 依赖 S1 |
| S4a | **昼夜光照联动**（homeowner 的核心问题：白天够不够亮/晚上温不温馨）+ 2–3 个高频环境预设 | **完**（本次提交）：`setDayNight`/`setPreset` 直写 `DOC.env.{mode,preset}`（单键持久化，载入即恢复）；工具条「白天/夜晚」旁加「城市/郊野/海景」段；`cityPanorama` 泛化为 `panorama(preset, night)`（seattle-city 种子逐字节不变）；新预设 suburban（低层+树冠+远山，夜=山谷暖带）/ seaview（水面+天际线，夜=灯光倒影），HZ 统一 0.54；环境色温表 `ENV_TINT` 叠加到 fp 分支的 amb/hemi（city 行=原值，光追/室内画面零变化）；光追环境光自动随预设（共用 `three.panorama`）。bench：t3d +11 / walledit +3（含确定性抽像素比对） | 依赖 S1（`env` 字段）；S4 里价值最高、先做 |
| S4b | 10 环境预设全矩阵（5 景观 × 昼夜，程序化） | todo | 打磨项，可后移 |
| S5 | **DXF 导入**：图层名映射 → 文档；单位自动检测 + **一次确认**；产出 = 立即可用初稿（调性：快捷的主要体现） | **完**（2026-09，`5775789`）：`src/geo/import-dxf.ts`（esbuild IIFE 内联，页面零 AI/零网络）：图层名映射（中英双语/前缀子串，WALL/DOOR/WINDOW/COL/ROOM/轴网/家具/标注七类）→ 双线墙带配对（投影重叠+距离→真实墙厚）→ 单线默认 10cm → 门洞=缺口+DOOR 层门扇 + 铰链/朝向推断（竖直门洞）→ 窗默认 fixed/窗台 0.9/顶 2.4 → 柱（CIRCLE/LWPOLYLINE）→ 房间环（面积≥ 5m²→room 否则 column，含名称 TEXT）；单位自动检测（`$INSUNITS` → 墙厚中位数启发式 mm/cm/m/in/ft，尺度自适应上限；无法判断按 mm + 警告）；一次确认对话框（单位可手动覆盖后重算）→ `applyImportedDoc` 整套替换（schema 校验、清家具、「重置内置」可整体回内置）；2D/3D 地板/相机/FP 用 `floorPts()`（导入=包围盒+0.8ft），阳台/厨房/手绘层隐藏；vendored dxf-parser@1.1.2 UMD（`scripts/build-dxf-lib.mjs`）。测试：vitest 91（既有 53：schema/doc/DXF 单测 + 38 真实 DXF 集成测试 `tests/fixtures/integration/`：ezdxf/LibreDWG/QCAD 4 个真实文件，锚定真实数据暴露的 4 个缺陷修复：INSUNITS 6/7 缺映射、闭合墙面轮廓配对、方向向量抵消、'colors' 层误判柱；`e918e48`）+ 浏览器 bench +10（t_walledit×2 全绿）；calib 不变 | 依赖 S1 + R1（R1 = 图纸结构调研） |
| S5b | **洁具放置工具**（导入户型的安全网；ADR-0006：识别漏掉=可恢复错误，不是终态）：6 类（台柜/洗手盆/马桶/浴缸/淋浴/镜子）点击放置，台柜/镜子自动贴最近实墙（长边平行墙、法向偏移=墙半厚+件半深、rot=墙角）；选中后拖移 / 方向键 1cm 微调（Shift 5cm）/ 数字输入旋转角（0=轴对齐）/ Delete 删用户件（内置件拒删+提示）；schema 加 `Fixture.rot`（度）与 `src:'user'`，DOC_DATA_VERSION 1→2（v1 内置文档丢弃重迁移，13 件 rot 缺省无损）；2D 每件 `<g data-fx>` 旋转渲染 + 加厚命中区；3D 仅 rot≠0 包 `THREE.Group`（rotation.y = -rot，绕占地中心，`noMerge` 让 mergeByMaterial 跳过该子树；rot=0 保持平铺路径——3D 截图与 HEAD 逐像素一致）；顺修 `fit2DToContent` viewBox 单位 bug（ft 未乘 S，导入后视图被放大 22×） | **完**（`0ecaa53`）：t_walledit +12 / t_3d +3 断言，源+dist 全绿，calib 不变 | 依赖 S5；为 S6/S7 导入铺路 |
| S6 | **PDF 向量导入**：operatorList → 线段聚类 → 文档；扫描件检测降级 | **完**（本次提交）：pdf.js 4.10 vendor（`lib/pdf.*.js`，dist 内联为 JSON 块懒执行）；颜色映射语义（蓝=窗/红=门）；比例推断（门弧 0.4–1.2m + 图幅，候选 1..200，可手动覆盖）；扫描件（位图主导）检测 + S7 提示；119 vitest（+24）+ bench s6p×10（源+dist）；calib 逐字节不变 | 依赖 S1 + R1；导入后的洁具用 S5b 放置工具兜底 |
| S7 | **图片底图 + 磁吸描摹**（扫描件/单色 PDF 的降级通道） | **完**（本次提交）：**不用 OpenCV.js**（单文件/离线约束下 ~2MB 库太重），改为纯 JS 确定性管线（R2 记录的升级路径保留）：`src/geo/image-trace.ts`——Otsu（逐存在值中点，避经典 0/255 双峰陷阱）→ Canny-lite（3×3 Sobel、4 量化 NMS 两遍、双阈值滞后 8 连通）→ 投影 Hough（120 角×2px，去重，minLen 尺度自适应）→ 线段列表；`imgTransform()` 像素↔ft（90° 步进旋转，中心锚定）。文档：`ProjectDoc.baseImage?`（dataURL ≤2.5MB + w/h/mPerPx/ox/oy/rot，**不加版本号**——纯增量可选字段，docToLegacy 不投影）；UI：「导入底图」（图片≤2048px 降采样+JPEG 压缩进文档，两点标定实际距离，0/90/180/270 旋转）→ `applyImportedDoc` 整套替换（零几何文档，地板=底图包围盒，fit2D 适配）；「特征线」按钮提取（内存缓存 key=dataURL）→ 2D 绿色线段层（家具层下）+ 画墙磁吸（snapPt 端点之后/墙中心线之前，≈7 屏幕 px）；「移动底图」按住拖+方向键 10cm/Shift 2.5cm/Esc；**S6 扫描件 PDF 桥**：page.render 栅格化 page 1 → 同一底图流（toast 提示后开标定对话框）。CALIB 全路径 gated（md5 基线不变）；导入/重置时 S7 状态复位。测试：vitest 127（+8：水平/竖直/45°/空白/反色/确定性/transform×2）+ bench s7×11（源+dist 184/184：导入流/标定/提取 134 段/图层/磁吸确定性/移动） | 依赖 S1 + R2；S6 扫描件分支已接入 |
| S8 | **ML 识别**（自家云函数，非 Vloor——R2） | v2+ | 调性校准：ML 重，仅当 P0–P2 覆盖不足 |
| S9 | **UI Warm Dark 重构**（R9 方案）：token 先行（零视觉变化）→ 换值（暖底/accent 收敛）→ 品牌位 MiniDen + 渐进披露（日常操作表层/pro 操作第二层） | todo | 依赖 E16（先有黄金门禁再动样式） |
| S10 | **目录扩展协议**（调性：扩展代码优先，skill 是交付物不是依赖）：① 目录条目 JSON schema（稳定）② 建模指南人读版（从 skill 提炼：modelCtx API + 建模三律）③ check-item CLI 化（增/验/删，无 AI 可用）④ 目录扩展包格式（外部 json+js 包，UI 可加载，R8） | todo（**验收基准 = R8-5K 五条**：规划规模 **5,000 件**，用户决策 2026-09-17；实现可后置，但 R8-5K-2 的 schema 预留须从 S1 起生效） | 依赖 S1；skill 本身保留在 repo 作为交付物（README 说明） |

## 工程（E 系列）

**P0 —— S1 的前置/伴随**

| # | 工作项 | 状态 |
|---|---|---|
| E1 | **esbuild「源模块 → 单文件」**：step 1 完成（`build.mjs`：planner.html 内联脚本 + lib/ 内联 → dist/planner.html 单文件，**行为逐字节等价**已证明：calib md5 + t_walledit 111/111 + t_3d 65/65，classic→ESM 六个坑沉淀在 AGENTS §5.7；three 用**本地 lib/**而非 npm——零版本漂移，待 src/ 模块化时再转 npm）；剩：`src/` 增量模块化（textures→geometry→…） | 进行中 |
| E2 | **TypeScript**：schema 层已完成（`src/schema/`，tsc strict 干净 + 31 单测，S1 Phase 1）；其余模块随 E1 模块化推进 | 进行中 |
| E3 | **JSON Schema + 迁移链**：Phase 1 已完成（validate()/migrate()/JSON Schema draft-07 导出，等价性硬验收 31 单测绿）；Phase 2 = planner.html 接入（见 S1） | 进行中 |
| E4 | **vitest 单测**：vitest 接入完成 + schema 层 31 单测（含等价性/可重放性/原语误差）；其余纯函数（`fmtLen`/吸附/`ptPickGrid`）随模块化补齐 | 进行中 |
| E5 | **GitHub Actions CI**：tsc → eslint → vitest → build → headless 三测试台 + **calib md5 门禁**（macOS 路径先参数化） | todo |

**P1 —— 质量 + 快捷（ADR-0006：快捷是一等特征）**

| # | 工作项 | 状态 |
|---|---|---|
| E6 | ESLint + Prettier（Prettier 单独一个格式化 commit） | todo |
| E7 | LICENSE + THIRD-PARTY.md（three/OrbitControls MIT 署名义务；dxf-parser MIT；OpenCV.js Apache-2.0；pdf.js Apache-2.0） | todo |
| E8 | README（人看的）：功能/截图/打开方式/快捷键/指向 docs 与 AGENTS；**包含 add-catalog-item skill 作为交付物的说明** | todo |
| E9 | docs/ 架构文档：数据流图、模块边界（从 AGENTS.md 提炼人读版） | todo |
| E10 | 持久化 localStorage → IndexedDB（`storage.js` 门面 + 迁移 3 个现有 key） | todo |
| E14 | **快捷 SLO 套件**（ADR-0006：顶层 = 用户时间，不是原始性能）：首次 ≤3 分钟（打开→放家具→3D 印象）；导入 ≤3 分钟（上传→可用初稿）；子指标：启动 <1.5s、切视图 <300ms、拖拽 <16ms/帧、50 件场景内存 <1.5GB、DXF 10MB <3s（带进度）、目录包 1000 条 <1s。每项都要实测数字，不凭感觉 | todo |
| E17 | **快捷 SLO 的 CI 门禁**（E14 的用户时间指标进 CI：进程墙钟 + 完成标记法，AGENTS §11；回归即红） | todo |

**P2 —— nice to have**

| # | 工作项 | 状态 |
|---|---|---|
| E11 | i18n（UI 字符串；目录名保留原文拼写） | todo |
| E12 | PWA/service worker | todo |
| E13 | 包体预算进 CI（796KB 基线） | todo（E5 的扩展） |
| E15 | `work/` 644MB 研究产物治理：**ref/ 保留入库**（建模 source of truth），过程产物（check_*.png/tv_*.png）移出跟踪或 LFS；交付后清理政策写进 AGENTS（R8 §3.4） | todo |
| E16 | **UI 黄金截图门禁**（R10）：`#ui` hash 模式 + 8 张黄金基线 + 像素 diff 工具（本地 ≤0.3% / CI 确定性 md5） | **完**（本次提交）：`#ui:<state>` 规范化 8 态（2d / 2d-sel(Lunix 选中) / 3d / fp / night / ft / collapsed / dlg，全新内置文档+空布局+冻结光标，全 CALIB-gated）；`scripts/ui-gate.mjs`（pngjs）：截图→与 `work/golden/*.png` 比（≤0.3%、单通道容差 4），超限出红色 diff 图；`--update` 显式重拍；`--selftest` 同态双截 md5 必须一致——**本机实测 8/8 字节级确定**（含 3D/swiftshader，0.3% 留作跨 Chrome 版本余量）；npm `ui:gate` / `ui:gate:update` / `ui:gate:selftest`；窗口 1700×1100 固定（换窗口=重拍基线）。基线目检过（八态均与预期一致）；calib/bench 全绿 | S9 的前置；CI 侧（ubuntu 基线+md5 门禁）随 E5 落地 |

## 已完成（本次会话前）

- 13 件大玩具/家具入目录 + SAPIENS 系列 29 件（275 条目，20 类）
- 三测试台 208 断言 + calib md5 门禁全绿
- 命名决定（ADR-0001）+ 文档体系建立（本目录）
- **R1–R10 研究全部完成**（research/ 十篇，2026-09）——实施（S/E 系列）的前置研究就绪
- **R8-5K 规模要求（2026-09-17，用户决策）**：目录规划规模定为 **5,000 件**；五条硬要求写入 R8 §5（数据/模型代码出文件、schema 预留、场景预算解耦、缩略图零预生成、验证分层），S10 验收基准
- **ADR-0006 产品调性 + 路线图重新校准**（2026-09-17）：time-to-insight 定义、S4 拆分、S8→v2+、S10/E14/E17 新增；R10 v2（交互流程 + 人眼可见性）
- 日期勘误：早期文档误写的 2026-07 全部订正为 2026-09（实际写作日期）
