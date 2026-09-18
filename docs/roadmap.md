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
| S2 | **窗户实体**：文档字段 + 2D 符号 + 3D 框/玻璃/款式 + 属性面板 + 选墙放窗 | doc 字段已就位（`style`/`fullHeight`/`steel`，S1）；2D/3D 款式渲染、属性面板、选墙放窗交互待建 | 依赖 S1（已满足） |
| S3 | **墙/柱编辑切到文档直编**：交互层复用现有编辑器 | **随 S1 Phase 2b 完**（墙/柱/门/窗编辑全部直写文档实体，`restoreBuiltins` = #wRestore） | 依赖 S1 |
| S4a | **昼夜光照联动**（homeowner 的核心问题：白天够不够亮/晚上温不温馨）+ 2–3 个高频环境预设 | todo | 依赖 S1（`env` 字段）；S4 里价值最高、先做 |
| S4b | 10 环境预设全矩阵（5 景观 × 昼夜，程序化） | todo | 打磨项，可后移 |
| S5 | **DXF 导入**：图层名映射 → 文档；单位自动检测 + **一次确认**；产出 = 立即可用初稿（调性：快捷的主要体现） | todo | 依赖 S1 + R1 |
| S6 | **PDF 向量导入**：operatorList → 线段聚类 → 文档；扫描件检测降级 | todo | 依赖 S1 + R1 |
| S7 | **图片底图 + 磁吸描摹**（OpenCV.js） | todo | 依赖 S1 + R2 |
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
| E16 | **UI 黄金截图门禁**（R10）：`#ui` hash 模式 + 8 张黄金基线 + 像素 diff 工具（本地 ≤0.3% / CI 确定性 md5） | todo | S9 的前置 |

## 已完成（本次会话前）

- 13 件大玩具/家具入目录 + SAPIENS 系列 29 件（275 条目，20 类）
- 三测试台 208 断言 + calib md5 门禁全绿
- 命名决定（ADR-0001）+ 文档体系建立（本目录）
- **R1–R10 研究全部完成**（research/ 十篇，2026-09）——实施（S/E 系列）的前置研究就绪
- **R8-5K 规模要求（2026-09-17，用户决策）**：目录规划规模定为 **5,000 件**；五条硬要求写入 R8 §5（数据/模型代码出文件、schema 预留、场景预算解耦、缩略图零预生成、验证分层），S10 验收基准
- **ADR-0006 产品调性 + 路线图重新校准**（2026-09-17）：time-to-insight 定义、S4 拆分、S8→v2+、S10/E14/E17 新增；R10 v2（交互流程 + 人眼可见性）
- 日期勘误：早期文档误写的 2026-07 全部订正为 2026-09（实际写作日期）
