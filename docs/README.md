# docs/ — 设计文档 / 决策 / 路线图

本目录是 MiniDen 的**工程知识仓库**（人看的）。给 agent 看的操作知识在根目录 `AGENTS.md`
与 `.claude/skills/`，两边分工：

| | 受众 | 内容 |
|---|---|---|
| `docs/`（本目录） | 人（+ 需要背景知识的 agent） | 为什么这么做、决定了什么、下一步做什么 |
| `AGENTS.md` / `SKILL.md` | agent | 怎么动手、验证流程、踩坑清单 |

## 目录结构

| 路径 | 放什么 | 生命周期 |
|---|---|---|
| `research/` | **研究笔记**：竞品深潜、库评估、技术可行性。每个主题一个文件，编号 `NN-主题.md`。允许带「待定/存疑」结论 | 写完即冻结（只追加修订记录），结论被采纳后在设计文档里引用 |
| `design/` | **设计文档**：某个功能的完整设计（数据模型、交互、验证方案）。实现启动前写好，实现中保持更新 | 活跃 → 实现完成后标「已实施」并链接首个 commit |
| `decisions/` | **ADR**（Architecture Decision Record）：最终决策，编号 `NNNN-短名.md`，不可回滚（要反悔 = 新 ADR 替代） | 接受后基本冻结 |
| `roadmap.md` | **实施路线图**：工作项 + 优先级 + 状态（`todo / doing / done+commit`） | 持续滚动 |

## 流转

```
research/（可行性证据）
   ↓ 结论被采纳
design/（完整设计）
   ↓ 设计中拍板的不可逆选择
decisions/（ADR 记录）
   ↓ 设计落地
roadmap.md（状态推进）→ 代码 + AGENTS.md 沉淀
```

规则：
- **ADR 只记「已拍板且回滚代价高」的决定**；可逆的普通设计选择留在 design 文档里
- research 文档里**引用来源必须带 URL**，实测数据必须带日期
- 新 ADR 编号递增，旧 ADR 不改写（反悔写新 ADR 并标 `supersedes`）

## 索引

### decisions/
| # | 标题 | 日期 |
|---|---|---|
| [0001](decisions/0001-miniden-naming.md) | 项目命名：planner → MiniDen | 2026-09-17 |
| [0002](decisions/0002-geometric-primitives.md) | 几何原语是存储，近似只在消费端 | 2026-09-17 |
| [0003](decisions/0003-input-channels-layered.md) | 户型输入通道四层递进 | 2026-09-17 |
| [0004](decisions/0004-single-file-artifact.md) | 单文件产物架构（esbuild 源→HTML） | 2026-09-17 |
| [0005](decisions/0005-project-schema-v1.md) | Project 文档 = id 寻址 JSON（schema v1） | 2026-09-17 |
| [0006](decisions/0006-product-positioning.md) | 产品调性：homeowner 面向、快捷 = time-to-insight（用户不建模/概念以分钟计）、扩展代码优先（skill 是交付物非依赖）、范围内精度拉满；施工图域不做 | 2026-09-17 |

### design/
| 文档 | 状态 |
|---|---|
| [floorplan-input-and-eng-audit.md](design/floorplan-input-and-eng-audit.md) | 研究/提案（未实施；含工程审计 P0-P2） |

### research/

| # | 文档 | 结论摘要 |
|---|---|---|
| 01 | [DXF/PDF 向量导入](research/01-dxf-pdf-import.md) | dxf-parser 1.1.2 够用（图层/块/头变量全有）；pdf.js OPS 常数值已实测；单位检测 = $INSUNITS + 墙厚 240/24 启发式 + 用户确认（照抄酷家乐）；DWG 不做 |
| 02 | [图片描摹/ML](research/02-image-tracing-ml.md) | OpenCV.js 白名单构建 ~2MB 懒加载；Vloor = Floorplanner 专属（远端 URL+credits+对方格式，不推荐）；学术墙 F1 ~0.86-0.90，P3 = 自家云函数 + SegFormer 类，最后做 |
| 03 | [3D 渲染管线](research/03-3d-rendering-pipeline.md) | WebGPU 无 ray query（issue #535 仍 open）→ 软件 BVH 仍是唯一路；three.js WebGPURenderer 2026 已 production-ready，但我们保持 r147/WebGL2（ptRender 是裸 GLSL，迁 TSL = 重写）；OIDN 归入未来 WebGPU 二期 |
| 04 | [目录与商品数据](research/04-catalog-and-product-data.md) | IKEA 无官方 API（只有社区逆向）→ 保持 Chrome 渲染抓取；程序化建模 vs GLTF 的体积算术（30-50MB vs 796KB）→ 程序化是差异化，不换方向 |
| 05 | [编辑器 UX](research/05-editor-ux.md) | 存储对象式（wall 实体+子件 = schema v1）/ 几何求值段式（展开给现有渲染管线）= 文档层升级、渲染层不动；undo/redo = 文档快照环（KB 级 doc，50 档）；窗户「选墙放窗」交互要点 |
| 06 | [持久化与同步](research/06-persistence-and-sync.md) | localStorage → IndexedDB 门面（E10）；导出 = JSON(+ZIP 底图)；云同步 v2+（CRUD 起步，Yjs 留作未来）；隐私底线：户型数据默认只在本机 |
| 07 | [整体架构](research/07-architecture.md) | 实测解剖：MODELS 327KB = JS 的 47%；目标模块图（schema→geo→data/models→render*→ui→main，无环）；worker 线程模型；迁移不变量清单（calib md5/种子/版本号） |
| 08 | [家具库 scalability](research/08-catalog-scalability.md) | 增长成本：配色变体 0KB / 新家族 2.5KB；先触顶的是 **GPU 三角负载**不是文件（对策：LOD 分级/实例化/单件 40k 硬顶）；1,500+ 条目后走「目录扩展包」；新发现 work/ 644MB 入库需治理 |
| 09 | [UI 整体风格](research/09-ui-style.md) | 现状 = 冷调深色 pro-tool（截图实测）；竞品坐标：P5D 亮色 consumer / HBM 渲染即产品 / 酷家乐深色 pro；提案 **Warm Dark**（暖炭黑 + 单 accent + token 表）；token 先行三步执行序 |
| 10 | [UI 验收标准](research/10-ui-acceptance.md) | 五道关：行为断言 / calib 不变性 / **黄金截图（`#ui` 新门禁，8 状态）** / 交互体检（键盘等）/ 卫生（token 纪律 + 体积预算）；明确不验收项（跨浏览器像素/响应式/a11y 全项） |
