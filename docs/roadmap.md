# MiniDen 路线图

状态：`todo` → `doing` → `done(<commit>)`。
依赖关系：S1 是一切的前提；E 系列（工程）与 S 系列（产品）可交替推进，
但 E1（esbuild 模块化）建议先于 S1 的 schema 模块落地（schema 直接写 TS）。

## 研究（R 系列，产出 docs/research/）

| # | 主题 | 状态 | 产出 |
|---|---|---|---|
| R1 | DXF/PDF 导入可行性深潜：dxf-parser 实体/图层/单位细节、pdf.js operatorList 提取、酷家乐单位检测清单 | done | research/01 |
| R2 | 图片描摹/ML：OpenCV.js WASM 能力与体积、Vloor API、学术 SOTA（raster→vector 精度现状） | done | research/02 |
| R3 | 3D 渲染管线：WebGPU ray query 状态、浏览器光追/降噪 SOTA、three.js WebGPURenderer、HDRI 源（Poly Haven） | done | research/03 |
| R4 | 家具目录与商品数据：竞品目录结构、GLTF vs 程序化建模（单文件约束下）、IKEA/零售商数据源 | done | research/04 |
| R5 | 编辑器 UX：墙体编辑模式（段式 vs 对象式）、吸附、undo/redo 设计、多户型管理 | done | research/05 |
| R6 | 持久化与同步：localStorage→IndexedDB、导入导出、云同步选项 | done | research/06 |

## 产品功能（S 系列，顺序 = 依赖序）

| # | 工作项 | 状态 | 备注 |
|---|---|---|---|
| S1 | **Project schema v1**：户型迁移为文档实例；`eff*()` 改读文档；id 寻址替换 USERGEO 索引层；旧数据一次性迁移 | todo | ADR-0005；**第一优先** |
| S2 | **窗户实体**：文档字段 + 2D 符号 + 3D 框/玻璃/款式 + 属性面板 + 选墙放窗 | todo | 依赖 S1 |
| S3 | **墙/柱编辑切到文档直编**：交互层复用现有编辑器 | todo | 依赖 S1 |
| S4 | **10 环境预设**（程序化，5 景观 × 昼夜）+ 昼夜/环境联动光照 | todo | 依赖 S1（`env` 字段） |
| S5 | **DXF 导入**：图层名映射 → 文档；单位自动检测 | todo | 依赖 S1 + R1 |
| S6 | **PDF 向量导入**：operatorList → 线段聚类 → 文档；扫描件检测降级 | todo | 依赖 S1 + R1 |
| S7 | **图片底图 + 磁吸描摹**（OpenCV.js） | todo | 依赖 S1 + R2 |
| S8 | **ML 识别**（云端 API / Vloor） | todo | 最后 |

## 工程（E 系列）

**P0 —— S1 的前置/伴随**

| # | 工作项 | 状态 |
|---|---|---|
| E1 | **esbuild「源模块 → 单文件」**：`src/` 模块化（textures→geometry→… 增量迁移），`three@0.147.0` 转 npm 依赖内联 | todo |
| E2 | **TypeScript**：schema/geometry 先行，`tsc --noEmit` 门禁 | todo（与 E1 交织） |
| E3 | **JSON Schema + 迁移链**：`validate()`/`migrate()`，schema 文件即文档 | todo（= S1 的实现载体） |
| E4 | **vitest 单测**：纯函数层（schema/geometry/`fmtLen`/吸附/`ptPickGrid`），目标行覆盖 >80% | todo |
| E5 | **GitHub Actions CI**：tsc → eslint → vitest → build → headless 三测试台 + **calib md5 门禁**（macOS 路径先参数化） | todo |

**P1 —— 质量**

| # | 工作项 | 状态 |
|---|---|---|
| E6 | ESLint + Prettier（Prettier 单独一个格式化 commit） | todo |
| E7 | LICENSE + THIRD-PARTY.md（three/OrbitControls MIT 署名义务；dxf-parser MIT；OpenCV.js Apache-2.0；pdf.js Apache-2.0） | todo |
| E8 | README（人看的）：功能/截图/打开方式/快捷键/指向 docs 与 AGENTS | todo |
| E9 | docs/ 架构文档：数据流图、模块边界（从 AGENTS.md 提炼人读版） | todo |
| E10 | 持久化 localStorage → IndexedDB（`storage.js` 门面 + 迁移 3 个现有 key） | todo |

**P2 —— nice to have**

| # | 工作项 | 状态 |
|---|---|---|
| E11 | i18n（UI 字符串；目录名保留原文拼写） | todo |
| E12 | PWA/service worker | todo |
| E13 | 包体预算进 CI（796KB 基线） | todo（E5 的扩展） |
| E14 | 启动性能标记（首帧/目录渲染） | todo |
| E15 | `work/` 665MB 研究产物：ref/ 图片 LFS 或独立 repo | todo |

## 已完成（本次会话前）

- 13 件大玩具/家具入目录 + SAPIENS 系列 29 件（275 条目，20 类）
- 三测试台 208 断言 + calib md5 门禁全绿
- 命名决定（ADR-0001）+ 文档体系建立（本目录）
- **R1–R6 研究全部完成**（research/ 六篇，2026-07）——实施（S/E 系列）的前置研究就绪
