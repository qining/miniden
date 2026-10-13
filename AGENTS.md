# AGENTS.md — MiniDen 开发指南

写给接手这个 repo 的 AI agent。这份文档记录**实测有效的流程、踩过的坑、以及验证方法论**。
读完再动手，能省掉大量返工。

---

## 0. 这是什么

项目名 **MiniDen**（迷你窝，ADR-0001）。
单文件 Web 应用（13,000+ 行，~870KB），给一套**高层 2室2卫公寓**做家具规划（具体城市/楼层属于隐私，不进 repo）：

- **2D SVG 平面编辑器**：拖放家具、编辑墙体/门/柱、标准建筑图例
- **3D 渲染**（Three.js r147，本地 `lib/`，离线可用）：娃娃屋视角 + 室内第一人称漫游
- **照片级渲染**：GPU 浮点渐进累积（软阴影/环境光/抗锯齿）
- **家具库**：**275 条目**（20 类；268 件专属建模 / 131 个模型函数（36 个共用）/ 7 件通用回退）

依赖只有 `lib/three.min.js` 和 `lib/OrbitControls.js`（已本地化）。没有构建步骤，直接用浏览器打开。

### 0.1 仓库自带的 agent 资产（都随 git 走）

| 路径 | 是什么 |
|---|---|
| `.claude/skills/add-catalog-item/SKILL.md` | **加家具/灯具/地毯/游具入库的作业指导书**（唯一一份，下面两个 agent 都读它）。详细版是本文 §8.1，冲突以 §8.1 为准 |
| `.claude/skills/add-catalog-item/check-item.py` | 单件体检 + 全量回归：`python3 .claude/skills/add-catalog-item/check-item.py <条目id>` / `--regress` |
| `.agents/skills` → `../.claude/skills` | **给 pi coding agent 用的软链**（git 存 mode 120000）。pi 只扫 `.agents/skills`，不认 `.claude/`；Claude Code 反过来不认 `.agents/`。软链让两边共用同一份文件，改一处两边同时生效 |
| `bench/t_3d.js` `bench/t_pt.js` `bench/t_planbuild.js` + `private/bench/t_walledit.js` | 四个自动化测试台脚本（§3）。**bench/*.js 入库且 plan-independent**；t_walledit 含真实户型几何断言，只能在 private/（§1.4） |
| `data/plans/generic.json` | 入库的通用户型（2室1卫，无个人数据）；`private/plans/mine.json` = 真实户型（gitignore，逐位精确提取，§1.4） |
| `build.mjs` + `package.json` | 构建管线：**一个事实来源 `app.html` → 两个入口**（E18，§0.3）。esbuild 捆成单文件 `dist/app.html`（公开）+ `dist/planner.html`（个人，注入 mine plan + 修复 private/ 路径）+ 根目录 `planner.html`（个人入口源形式），并重新生成 **12 个 bench HTML**（§3、§5.7） |
| `scripts/ui-gate.mjs` | E16 UI 黄金截图门禁：截 **dist**（本地=mine / CI=generic）对 golden（§3） |
| `scripts/run-bench.mjs` | bench 运行器（本地 + CI 通用）：窗口/budget/pre-id 与 §3 表格一致；FAIL 自动原样重跑一次（§3 瞬态口径）；`CI=true` 时切 google-chrome + `--no-sandbox` |
| `.github/workflows/ci.yml` | E5 CI（generic 子集，§3）：npm ci → tsc → vitest → build → bench ×6 → ui-gate 双截（CI 自建 generic 基线 = 确定性门禁，不是视觉回归门禁）；calib md5 门禁需 private 资产→留本地 |
| `private/golden/` | mine 的 UI 黄金基线（gitignore；`--update` 重拍） |
| `work/headful_test.py` | 真显卡光追验证（§5.5） |
| `work/layouts/*.json` | 4 套压力测试布局 |

**两个 agent 的差异**（实测自 pi 0.85.1 / Claude Code 2.1.233 的安装源码）：

| | Claude Code | pi |
|---|---|---|
| 读哪个指令文件 | `CLAUDE.md` | `AGENTS.md`（候选序 `AGENTS.override.md → AGENTS.md → AGENTS.MD → CLAUDE.md`，同目录只取**第一个**命中）|
| skill 目录 | `.claude/skills/` | `.agents/skills/`（从 cwd 逐级上溯**到 git root 为止**）或 `.pi/skills/`（只认 cwd 那一层）|
| 首次加载 | 直接可用 | **要先信任项目**：交互模式跑一次 `/trust` 然后重启；非交互（`-p` / `--mode json` / `--mode rpc`）不弹框，必须显式加 `--approve`，否则**静默不加载、不报错** |

所以给 pi 看的约束必须写进 `AGENTS.md`（本文），写进 `CLAUDE.md` 它看不到。

### 0.3 两个入口，一个事实来源（E18，2026-10-05）

**只有一个代码文件：`app.html`（入库）。所有工具/功能/家具只写一次，两个入口同时生效。**

| 文件 | 入库? | 户型 | 形态 | 是什么 |
|---|---|---|---|---|
| `app.html` | **✓ 唯一事实来源** | generic（通用户型） | 源形式（`lib/` 外链） | 改代码就改它；clone 后直接打开就是公开入口 |
| `planner.html`（根目录） | **✓ 入库**（含真实户型坐标，见 §1.4） | **mine（西雅图公寓）** | 源形式 = app.html + mine 替换 | **你日常打开的那个**；改完 app.html 刷新即见，不用先 build。`npm run build` 每次把它重新生成一遍（所以它会跟着 app.html 一起出现在 diff 里） |
| `dist/app.html` | ✗ | generic | 单文件 bundle | **公开 / 用户入口**（可托管、可分享）；构建硬断言它不含任何 `private/` 资源引用、户型必须是 `generic-2br` |
| `dist/planner.html` | ✗ | mine | 单文件 bundle | 个人入口单文件；`ui-gate` 黄金截图与 dist bench 用它 |

- **同步不靠人记**：同一套 plan-independent bench 跑三份页面 —— source(mine) / dist(mine) / **dist(generic)**。新工具或新家具换个户型就坏，`work/t_3d_app.html` / `work/t_pt_app.html` 立刻红。
- **断言必须 plan-independent**：不得写死某个户型的数量/坐标（踩过：镜子数量 mine 3 / generic 1）。要断数量就与运行时投影比（`const n = FX.filter(...).length`）。
- `planner.html` 入库 ⇒ 换机器 / 没有 `private/` 时它照样存在（就是仓库里那份公寓版）。有 `private/plans/mine.json` 时 `npm run build` 会把它重新生成一遍；没有时构建**不动它**。
- **`private/` 是每个 worktree 各自一份**（gitignore 的未跟踪目录，不随 worktree 共享）。新 worktree 里从主检出复制，或软链：`ln -s /Users/dako/planner/private private`。没有 `private/plans/mine.json` 时构建自动跳过个人入口（CI/公开环境就是这个状态）。
- **遥远的未来删掉这个公寓** = 删 `private/` + 删 build.mjs 里 `hasMine` 分支 + 删 `private/bench/t_walledit.js`；`app.html` 与 `dist/app.html` 不受影响。

### 0.2 项目状态与文档（非加目录类的工作先读这里）

**产品调性 = 一切取舍的最高判据（ADR-0006）**：
对象是 homeowner（不是专业设计师，AutoCAD/UE 域不做）；「快捷」= **time-to-insight**
（用户不建模、形成「我家」的概念以分钟计、施工图级细节不做）；
扩展**代码优先**（运行时零 AI，skill 是交付物不是依赖）；范围内把精度拉满。

文档体系（全在 `docs/`，README 是索引）：

| 读什么 | 什么时候读 |
|---|---|
| `docs/roadmap.md` | **开工前**：工作顺序（R = 研究 done / S = 产品功能 / E = 工程）；文头调性 blockquote 是判据 |
| `docs/decisions/0001–0006` | 遇到「为什么这样决定」时；0006 调性最高 |
| `docs/research/01–10` | 需要「依据」时（各结论的调研过程/数据） |
| `docs/design/` | 户型输入 → 3D 的设计总文档 |

**当前位置**：R1–R10 研究全部完成；S 系列全部落地（S1–S7 + S9 Warm Dark 2a–2d）。**S10（隐私 + plan 外部化，2026-09）**：个人数据全部移入 `private/`（§1.4）；户型几何外置为 `#miniden-plan` JSON（committed=generic / 本地构建注入 mine）；bench 分层（入库 plan-independent / private plan-specific）；ui-gate 截 dist。**S11（2026-10-05）**：户型文档导出/导入（「工具 ⌄」→「导出户型 / 导入户型」+ `#docModal` 一次性确认，走 `applyImportedDoc` 同一条路；`ProjectDoc.floorOutline?` 纯增量可选字段保地板轮廓逐坐标保真）。**S11b（2026-10-05）**：导出必须无限制 → `ProjectDoc.plan?`（户型专属快照：roomSummary/refPhoto/calib/windowBand/patioPatch/islLabel/isl/kitchen/inner，同样不进投影），`freshDoc()` 从 PLAN 播种、消费端走 `planOf(k)`（文档优先、回退 PLAN）；厨房硬编码块数据化（顺带清除了公开文件里的真实坐标）。**S12（2026-10-05）**：放置类实体只认两个来源——用户画 / 导入读到的几何，不写启发式猜测；`Run` 台面柜体带实体 + 工具、DXF/PDF `furn` 轮廓按形状分类落地为 run、钢框窗改成窗实体的 `steel` 标志（`steelBands()` 与历史 windowBand 重合时只画一次）。**E18（2026-10-05）**：两个入口一个事实来源（§0.3）。**S13（2026-10-06）**：布局跟着 app 走——户型 JSON 新增 `layout`（内置布局），`load()` 在「这台浏览器对这份户型从没存过档」时用它播种（§1.2）；公开入口 `layout:null`（build.mjs 硬断言），测试台一律剥掉 layout（保持确定性 + plan-independence），`#calib` 不播种（§1.1）。待办：无（`git filter-repo` 已执行，见下）。**E5（2026-10-06）**：GitHub Actions CI 上线（`.github/workflows/ci.yml`，generic 子集：tsc → vitest → build → bench ×9 → ui-gate 双截；见 §3）。**P1 收尾（2026-10-06）**：git filter-repo 历史清除 + force-push 已执行（§1.4）；E7 LICENSE/THIRD-PARTY、E8 README、E13 包体预算门禁同期落地。**E6（2026-10-07）**：ESLint 10 + Prettier 3.9 落地（格式化单独提交；TS 侧因 typescript-eslint 不支持 TS7 暂由 tsc strict + Prettier 覆盖，见 §2）。**E19（2026-10-07~13）**：多轮 bug 猎（二十九轮：schema / 导入管线 / 3D 消费端 / 校验层 / 交互层 / $INSUNITS 码表 / 导入启发式的单位口径 / 存储后端成败判据 / DXF 圆弧 / 目录数据不变量 / 目录字段的消费端 / 整图重标定的载体与派生字段 / 窗外环境的消费端 / 存储与多户型的交叉口 / 两个功能各自的接缝 / 目录侧栏的用户状态 / 撤销环的手势判据 / 检视面板的口径 / 按屏幕尺寸恒定的叠加层与标注的归属 / 编辑模式跨视图 / 3D 拖动 × 撤销 × 光追冻结 / 换户型时编辑层的作废 / 目录扩展协议自己的门禁 / 目录包与布局导入的消费端），63 个真 bug + 2 处防御性统一，方法论见 §5.1.1。**E20（2026-10-07）**：可测性/覆盖率治理——覆盖率棘轮进 CI（`vitest.config.mjs` thresholds，只许涨不许跌）+ `scripts/storage-probe.mjs`（真实 IDB 落盘门禁，headful 真实时间，理由同 §5.5）。**E9（2026-10-07）**：`docs/design/architecture.md`（人读版架构：数据流 / 模块边界 / 构建守卫 / 门禁矩阵 / 不变量红线）。**E14+E17（2026-10-07）**：快捷 SLO 套件（`scripts/slo.mjs`，七项实测数字）+ 它的 CI 门禁。**E10（2026-10-07）**：持久化从 localStorage 换成 IndexedDB 主存（存储门面，见 §1.2）。**E21（2026-10-08）**：真实输入 E2E（`scripts/e2e.mjs` + `scripts/e2e-flows.mjs`，14 条流程 / 60 断言，两个入口 + CI 口径各 60/60）——第四种证据：真实鼠标/键盘/confirm/文件选择/下载/刷新，见 §3；它抓到并修了 3 个真实交互缺口（§5.1）。**E22（2026-10-08）**：`bench/t_planbuild.js`（plan-independent 户型构建 bench，120 断言×3 入口）——把「画墙 / 开门 / 放洁具 / 导入后编辑」这条 2D 主路径的断言从 private 那份里挑到入库侧，CI（generic）从此覆盖它（§3）。**E23（2026-10-09）**：撤销/重做（快照环 50 步 + 手势级合并，「撤销」按钮 + Ctrl/⌘+Z・Y，30+ 处变更点接入）。**E24（2026-10-09）**：导入后重标定 + 数值改长度——工具条重构（互斥控件组叠在同一格、编辑提示搬到画布左下角固定槽，原先提示文字被挤成 9px 宽 = 错误零反馈），「长 __ cm」一个输入框同时驱动「改这段」与「整图按此缩放」（后者两步确认、仅导入户型、可撤销）。**E25（2026-10-09）**：光追门禁的取景钉住——出图视野 `uAspect = rw/rh` 以前跟着窗口布局走，CI（76x94）与本地（73x97）比的不是同一张取景的图 → 萤火虫门禁在 CI 假红；现在 `ptOpts.size` 钉住出图尺寸（界面不传、行为不变），见 §3 与 §5.5。**E26（2026-10-09）**：多户型 + 首次引导——一份浏览器里可以存好几份户型（注册表 `planner_plans_v1`，内置户型的 id 就是旧指纹 `PLAN_FP`，所以**零迁移**；导入不再覆盖当前户型而是新建一份并切过去），「工具 ⌄ → 户型」里切换 / 重命名 / 新建空白 / 两步删除；首次打开弹一张三条路的引导卡（只一次，校准/bench/#ui: 一律不弹）。见 §1.2。**E27（2026-10-10）**：测试从真空开始 + 流程顺序对齐产品顺序——bench 第 13 节「彻底的从零开始」（空白户型 → 画一圈墙含窗与门洞 → 门 → 洁具 → 家具 → 3D → 存档往返 → 切回内置 → 删除）与 E2E `from-scratch` 流程（含 bench 给不了的**真实刷新**）；17 条 E2E 流程按「打开 → 引导 → 建房 → 洁具 → 家具 → …」排序（家具不再排在户型构建之前）；顺带堵住一个爆炸半径很大的隐患（非法洁具枚举值进文档 → validate 失败 → `loadDoc` 删档回退空文档 = 整栋房子静默消失）。见 §3 与 §5.1。**E28（2026-10-10）**：一条走完产品承诺的 E2E 流程（`demo-full`：空白引导卡 → 画出一套两室 + 卫 + 过道 → 四扇门 → 洁具 → 内置灯具 → 家具 → 撤销两步 → 3D → 室内 → 光追 → 导出 JSON → 刷新还在 → 删掉那份户型）+ 两个真 bug：**贴墙吸附与画出来的墙不一致**（`wd` 只有一个消费单位 = viewBox px / `S=22`，以前拿图纸 px / `SC=11.2` 换算 → 洁具离墙面 4.3cm，而导入户型的真实墙厚干脆不参与渲染）与**第一人称默认落点硬编码在内置户型的客厅**（自包含户型里它在户型外，点「室内」先看见自家外墙背面）。见 §5.1。**E19 轮⑰（2026-10-10）**：bug 猎对准「最新、最没被猎过」的那三个面（E24 整图重标定 × E26 多户型 × E23 撤销），抓到整图缩放的三个漏项：**家具不跟着搬**（家具不在 `ProjectDoc` 里，它走 `planner_v1:<id>` 另一条存档 → ×2 后留在旧坐标、跑到墙外）、**门的 `width` 不跟着几何走**（几何 ×2 而 `width` 没动 → 声明值只有实际开口的一半，导出/导入读它就读到一半）、**窗厚不跟着墙厚走**（墙 1.570ft 而窗 0.656ft → 窗陷进墙里）。见 §5.1 新增的三行。**S4b（2026-10-10）**：窗外环境补齐成 **10 个预设（5 景观 × 昼夜）**——山林（层叠山脊 + 薄雾 + 针叶树线，夜=星空月亮 + 月照雾辉光带）与公园庭院（近景树冠 + 修剪草坪 + 园路，夜=沿园路的暖路灯带）落地，种子 2103/10022、2104/10023；`ENV_TINT` 补两行环境色温；顶栏「城市/郊野/海景」旁加「山林/庭院」。§5.4.8 的三条规则全部可测化（t_3d 新增 10 条 `s4b-*`，见 §5.4.8）。**E19 轮⑱（2026-10-10）**：bug 猎对准刚落地最没被猎过的面——**窗外环境 / 昼夜这套 `DOC.env` 存档的消费端**，两个真 bug：①**同一个值两个消费端，一个有一个没有**——`panorama()` 对预设名查了表，`applyLightMode()` 的室内分支直接 `ENV_TINT[three.preset].day` → 存档里一个陌生预设名（导入一份手改过的户型 JSON、或将来重命名预设后的旧存档）就能让点「室内」当场 `TypeError`，顶栏后续按钮全失灵；修在**文档入口**（`loadDoc` 三条 return 路径 + `applyImportedDoc` 都过 `cleanDocEnv`，不收紧 `validate`）+ 消费端兜底。②**光追进行中顶栏照样能点**——样本累积跑到一半换窗外景/昼夜/开关灯 = 出图里混两种光照（谁都不是）且界面不告知；现在入口拒收 + toast 说清「先点取消」（不用 `confirm()`，headless 会挂）。另记一条注释与实现不符（`setPreset` 声称「雾色一起换」而雾色硬编码）：改注释不改画面（雾界 130/430ft 在室内本来惰性，改它就要重拍黄金基线）。见 §5.1 新增的五行与 §5.4.8 第 4 条。**E19 轮⑲（2026-10-10）**：bug 猎对准 **E26 多户型 × E10 存储门面 × E23 撤销环的交叉口**，两个真 bug，都是**数据丢失**类：①**`loadDoc()` 的回退只有一种形状 = 内置公寓**——切到一个「存档读不动」或「存档缺失」的自包含户型（新建空白 / 导入）时它拿到整套公寓，而同一个 `switchPlan` 末尾的 `saveGeo()` 立刻把这套公寓写进那份户型自己的键，而 `usable()` 失败那一步还先 `STORE.remove()` 删掉了唯一能修 / 能取回的原存档（bench 读数：那份空白户型的 `name` 直接变成「2室2卫」）。修：回退按户型形状分派（自包含户型回退成 `blankDoc(注册表里的名字)`），坏存档不再删（保留原样 + 告知用户怎么办），旧单桶 `planner_doc_v1` / `planner_userGeo_v1` 属于内置户型、自包含户型不认领。②**「读不到」不等于「没有」**——`switchPlan` 里 `STORE.warm()` 不 await，紧接着的同步读读到空，但那份存档可能只存在 IndexedDB 里（LS 被清过 / 超过 1.5M 镜像上限 / 配额满）；回退出来的文档被写回去 = 把用户那份盖掉。真实门禁实测（`storage-probe` 阶段 2：真实 IDB + 真实刷新 + 真实切户型）：切之前 1,704,429B → 切之后 **5,221B**（内容 = 内置通用户型），而且 `saveGeo` 先动了这个键 → warm 完成后 hydrate 被 `touched` 跳过 → **第二次切也回不来**。修：门面加 `warming(keys)`，app 侧用 `planArchiveUnknown` 记住「这份户型的存档还在读」，期间 `save()`/`saveGeo()` 不写，warm 完成后解除并重新载入。**不得做成「warming 就挡住所有写」**：那会把「存不存得进去」绑在 warm 能不能完成上（虚拟时间下真实 I/O 比虚拟时钟慢很多 → 三处 bench 当场红过）。见 §5.1 新增的三行与 §5.1.1。**E19 轮⑳（2026-10-11）**：bug 猎先列 **E2E 覆盖边界**（16 条流程覆盖 12 个界面，但台面工具(S12) / 编辑层撤销(E23) / 环境预设(S4a/b) / 光追(PT) 四个已交付功能零真实鼠标覆盖），只补前两条流程，当场钓出七个 bug：①**柜体在哪一侧用全局平均猜**（`runNormal` 拿 `floorCentroid()` 定向 → 凹型（L 型）户型的质心被另一条臂拉走，沿内边画的台面穿墙画到室外）——改成沿法线两侧各探 0.4/1.2/3.0ft 用 `insideFloorPt()` 投票；②**模块中心只夹到 path 末端**（冰箱中心 6.95ft → 跳 0.95ft 在柜体外，2D 一块悬空板、3D 半个冰箱飘在地板上）与**重标定后不重新夹**（模块是真实尺寸、不跟着户型缩）；③**装不下也照放**（1.2ft 台面收 2.0ft 冰箱）→ 现在拒放并给出可核对的理由；④**删用户洁具 / 删用户台面不进撤销环**（误删按不回来）；⑤**pointerdown 就算一步手势**（只点一下没拖动也会把「撤销」点亮而按下去什么都没发生 = 零反馈，R10）——`markDragGesture` 把进环时机推迟到真正开始动；⑥**命中判定只写在台面工具分支里**（「选择/调整」模式点台面选不中，而台面命中区排在洁具之后 → 放在台面上的洁具永远点不中）——现在两种模式都可选中，命中顺序改成台面在下、洁具在上（小目标赢），并补上悬停(橙)/选中(绿)高亮；⑦**面板给了控件而代码没接**（`#runCtl` 含模块下拉在「选中台面」时就显示，可放置代码只在台面工具分支里 → 下拉摆着、点了只起手拖动）。bench 185→199×3，E2E 192→220（CI）/ 127→141（个人入口）。见 §5.1 新增的八行与 §5.1.1。**E19 轮㉑（2026-10-11）**：bug 猎对准**目录侧栏**（挑家具的主界面：搜索 / 折叠 / 缩略图 / 自定义件 / 价格与选中态），四个真 bug，全部先探针量出硬数字再修：①**重建列表把用户状态一起重建掉**——`buildCatalog` 每次重建都从「只有第一个分类展开」开始，切币种 / 清空搜索 / 撤销 / 导入布局都会把用户展开的分类全折叠（实测 3 组 → 1 组）；现在展开状态存在 `catOpenState`，记的是状态而不是「打开过的集合」（用户主动收起的那组同样记住），搜索期间的「全展开」是临时的不写进用户状态。②**新分组默认折叠 ⇒ 用户刚造的东西看不见**——自定义家具排在最后一组，点「添加」后卡片 `display:none`、rect 0×0，目录里毫无痕迹（零反馈 = 设计缺陷，R10）；现在造出来就展开那一组并滚到位。③**输入校验用 `alert()`**（宽 / 深留空）——真实浏览器里是模态打断，bench / E2E 一旦覆盖这条路径就把整条测试链路挂死在 0% CPU（§5.1 老红线的新实例）；改成 toast + 把焦点送到缺的那一格。④**外部资源没确认成功就拆兜底**——自定义件的图片打不开时卡片背景被清成 transparent，成了一块 184×138 的空白格子，连用户自己选的颜色都不显示；现在兜底色先垫着，`Image().onload` 确认成功才清。t_3d 138→144×3 入口，E2E 加一条 `catalog-custom`（141→148 个人入口 / 110→117 CI 口径）。见 §5.1 新增的七行与 §5.1.1。**E19 轮㉒（2026-10-11）**：bug 猎对准 **E23 撤销环自己的手势判据**——`pushUndo(gestureKey)` 把「同一个手势」与「同一种动作」混成一个键，于是**离散动作被合并**：连放两个洁具 / 目录里连点两次同一件商品 / 属性面板按两次「+90°」/ 键盘连按两次 R / 同一段墙连改两次类型（实墙→门洞→开口）/ 同一块台面连放两个模块，**撤销一次同时撤掉两件事**；最坏的一种是「撤销按钮亮着、按下去什么都没发生」= 零反馈（R10）。修：`pushUndo(key, eachGesture)` 两个身份分开（34 个离散动作站点标注、连续手势照旧合并），并把「按了但什么都没变」的判据交还给原有的快照相等检查。bench 199→209×3（七条先红后绿 + 两条对照组：复制两次本来就该是两步、连按 5 次方向键仍只算一步），E2E `undo-redo` 加「连放两件 → Ctrl+Z 只撤最后那件 → 再按一次撤第一件」（148→151/入口，CI 口径 117→120）。顺带修一条 E2E 自身的不稳（下载目录整个入口共用、Chrome 重名改名让「与快照比新文件」判不出来：全量跑偶发红、单跑全绿）。见 §5.1 新增的五行与 §5.1.1。**E19 轮㉓（2026-10-11）**：bug 猎对准**检视面板**（用户直接往状态里写数字的那个界面：尺寸 / 颜色 / 色温 / 亮度 / 旋转），六个真 bug，根因都是「面板没有自己的口径层」：①**自定义件尺寸没有上下限**——宽填 99999cm 收进去 → 2D 图例 72178px = 户型宽度的 72 倍，整张平面图被一个笔误盖住；0.1cm → 0.07px（看不见、点不中、删不掉）；h=-5cm → 3D 包围盒 y −0.164..0.000ft（整件在地板下面）。②**颜色 / 色温 / 亮度改动不进撤销环**——Ctrl+Z 撤掉的是「放件」那一步 → 家具整个消失。③**旋转三个口径不一致**——框存原始 720、滑块显示 0，再按 +90° 跳到 90；键盘 `[` `]` 能产生负角度。④**死步**——在旋转框里重打同一个数字也占一步 → 「撤销按钮亮着、按下去什么都没发生」（零反馈，R10）。⑤**焦点在提交式控件里 Ctrl+Z 被门控挡掉**——真键盘实测 ring=3、按完 rot 与框都不变；修成区分两类面：自由文本框（搜索框、自定义件名称）里 Ctrl+Z 留给浏览器撤销打字，数字 / 颜色 / 滑块里它必须是全局撤销。⑥**撤销后面板不跟着回去**——`restoreState()` 只 `refresh()` 不 `updateProps()`，且焦点还在面板输入框里时 `updateProps` 故意不覆盖 → 「框里 0 / 实际 45°」。另记一条**我自己差点带进去的新 bug**：归一化后无条件回写输入框会吃掉小数点（逐字符打 45.5 → 「45.」被写成「45」→ 接着打 5 得 185°），反证跑过（无条件回写版 185°、无空值守卫版 0°）。bench 209→226×3，E2E 加一条 `props-panel`（151→160/入口）。见 §5.1 新增的六行与 §5.1.1。**E19 轮㉔（2026-10-11）**：bug 猎对准**量尺寸工具与「按屏幕尺寸恒定」的叠加层**，两个根因共 7 个可测症状：①**重画与取景变化不同步**——标注线宽与字号在绘制时除以当时的 `getScreenCTM().a`，而 viewBox 一变没人重画：滚轮处理器只补了 `wallEdit`、漏了 `meas`，`fit2DToContent()` 两个都不补还把它放在 `build2D()` 之后（先按旧缩放画、再改取景）。实测：放大 5 格后标注 1.600→2.577px / 字号 10→16.1px；重新取景后 1.600→4.150px / 10→25.9px、手柄 1.000→2.594px；整图重标定 ×2 后反而缩一半（0.876/5.474px）。②**标注不跟着它量到的那份几何走**——导入后图上还挂着 16 个旧元素（跨的是另一份户型的坐标）；×2 重标定后墙 67.190ft 而标注仍跨 33.596ft（端点偏差 21.316ft）；撤销那次缩放后几何回去了而标注不回。修：`fit2DToContent()` 末尾补 `drawMeasure()+drawWallEdit()`、滚轮补 `drawMeasure()`；`rescaleDocPlan` 用同一中心缩 `meas` 端点（读数自动重算）；换户型 / 导入 / 新建 / 重置内置 调 `measDropForGeometry()`；`snapState` 带上 `meas.list`。顺带把 `const meas` 的声明移到取景管线旁边（它的消费端全在文件更靠前的位置，const 的暂时性死区按声明行算）。bench 226→239×3，E2E 新流程 `measure-tool`（160→167/入口）。本轮另记一条**断言自欺**：`pb-overlays-constant-after-refit` 第一版「意外绿」——fit 把 viewBox 改回了基准值 + 页面里 ResizeObserver 的 70ms 自愈重画，测出的 1.600px 是巧合不是修好；改成确定性序列（先缩小 10 格、用应用自己的重画立基准、再 fit、中间不 tick）。见 §5.1 新增的五行与 §5.1.1。**E19 轮㉕（2026-10-12）**：bug 猎对准**编辑模式 × 3D 视图**（一个 2D 模式跨视图之后还剩下什么），两个根因三个症状：①`setView` 只藏 SVG，模式的工具条与快捷键都留着——3D 画布上糊着一排按不动的「画墙/画柱/门/洁具」按钮（实测 `display=flex`），而快捷键继续隔空改几何（按三次方向键 → 墙被挪 3cm、撤销环 +1；按 Delete → 墙从文档里消失，而 3D 里那堵墙还立着）——用户看不见被改的东西 = 零反馈（R10）；②`geoChanged()` 只把 3D 标脏，重建要等下一次 `setView`——用户正看着 3D 时改了墙/门/洁具，画面还是旧的（实测 `staticGroup` 没换对象、顶点 55965→55965、新墙处射线打不到）。修：快捷键分支门控在 `state.view==='2d'`（非 2D 只保留 Esc，其余按键落到家具快捷键分支，3D 里选中的家具照常可删可转）、`#wallbar` 可见性 = `(wallEdit.on && v==='2d')`（模式本身保留、按钮还亮着 = 模式可见）、`geoChanged` 在 3D 在场时调 `schedule3DRebuild()`（与 `setView` 同一条 setTimeout，谁先跑谁消费 `geoDirty3D`；光追进行中不补建，与 bug #26 同因）。bench 239→248×3（四条先红后绿 + 两条对照组），E2E 新流程 `edit-in-3d`（167→176/入口）。见 §5.1 新增的四行与 §5.1.1。**E19 轮㉖（2026-10-12）**：bug 猎对准 **3D 拖动 × 撤销 × 光追冻结**（轮㉕ 把编辑模式收进视图之后，3D 自己的交互面），三个真 bug：①**撤销环的手势身份在 3D 拖动上没跟上 #33/#40**（pointerdown 就 `pushUndo` → 只点一下也占一步、撤销按钮亮着而按下去什么都没发生；手势键是稳定串 `drag3d:<uid>` → 连着拖同一件两次并成一步，实测撤销一次退 27.07cm）；②**3D 拖动没有「点击 vs 拖动」的屏幕像素阈值**（§8.2 给 2D 定了 ≥5px，3D 漏了）——点住家具手抖 1px 就挪 3.02cm 并落盘；③**光追进行中它依赖的那份场景没冻结**（#26 只守了光照三个入口：切视角实测 `state.view` fp→doll、相机被挪 3.280ft，滚轮走动 / Delete 删家具 / 面板改旋转都照接 → 交出的图属于一个已经不存在的房间而进度条照样跑到 100%）。修：`markDragGesture` 每次手势一个递增序号（手势内照旧合并、手势之间不合并）、3D 拖动改成「先阈值、再快照、后变异」、`photoFrozen()` 守住视角 / 相机 / 走动 / 家具变异的全部入口（拒接 + toast 说清「先点取消」）。t_3d 144→148、t_pt 38→45，E2E 新流程 `photo-freeze`（176→186/入口）。见 §5.1 新增的四行与 §5.1.1。**E19 轮㉗（2026-10-12）**：bug 猎对准 **E26 多户型 × 编辑层的交接面**（轮㉕/㉖ 把「模式跨视图」收完之后，下一个问题是「模式跨户型」），两个真 bug：①**换户型的作废只写在一条路径上**——`switchPlan` 清了编辑层而 `createBlankPlan` 没清：新建空白户型后 `wallEdit.sel` 仍指向上一份户型的墙（实测 `sel={"kind":"w","id":"w2"}` 而这份户型 walls=0），工具条继续描述它（「内置墙 · 长 167 cm · 厚 9cm ｜ 拖圆点=改端点 · Delete=删除」）、`#doorCtl` 还亮着带旧值（`#dWidth=87cm`、类型「平开」）；按 Delete → 界面说「已删除」而文档一个字节没变（walls 0→0、hidden 0→0）还往撤销环塞一步死快照（#54）。②**进行中的画墙链跨户型泄漏成几何**——在内置户型画到一半（`drawPts=[[28.28,21.37],…]`）→ 新建空白户型 → 再点一下 + 回车 → 这份户型多出一段来自另一份户型坐标的墙（DOC.walls 0→1）（#55）。修：`invalidateEditLayer()` 一处定义、四处共用（切过去 / 新建空白 / 撤销回另一份 / 开关编辑模式；以前四处各写、其中一处还漏了两项）+ 数据层判据 `selAlive(s)` + `deleteSel` 拒做并如实说明 + 工具条自愈。bench 248→258×3（四条先红后绿 + 三条对照组），E2E `multi-plan` 加三步（16→18/入口，断的是**提示文案**而不是只断 sel）。方法论上的新东西：**同一条判据要一次写全它的每一条路径**（「换户型要作废编辑层」本来就有，只缺新建那一条），以及**断界面提示文案而不只断状态量**（sel 已清而文案还挂着，用户看到的正是文案）。见 §5.1 新增的四行与 §5.1.1。**S10 Phase 1（2026-10-12）：目录扩展协议**——把一批商品装进目录不需要改 `app.html`：设计文档 `docs/design/catalog-extension.md`；条目 schema 与包协议在 `src/catalog/schema.ts` + `src/catalog/packs.ts`（内置目录与外部包**共用同一份校验**，编译产物灌进 `<script id="miniden-catalog">`，`build.mjs` 断言嵌入块与 `src/catalog/` 最新编译一致）；「工具 ⌄」里「导入目录包 / 移除包」（一次性确认弹窗摊开包名/来源/条目数/模型数 + 本地执行代码的信任提示；移除是两步确认）；包模型走同一个 `modelCtx` 且**不豁免内置三律**；内置目录永远赢（撞 id 的包条目被丢弃并如实报告）；条目消失后显示层给诚实占位（2D 虚线灰块 + `?`、3D 灰盒、面板「目录里没有这件（仍在布局里）」、价格「—」）；CLI `npm run catalog:check`（内置目录体检 / 体检一个包文件，坏条目即退出码 1）。内置目录现在 **280 条 / 146 模型 / 0 error / 0 warning**。顺带被新门禁钓出三个 bug（#56 schema 与消费端不同步、#57 幽灵件炸掉整个 2D 家具层、#58 导入条目藏在折叠分组里），见 §5.1 与 §5.1.1 轮㉘。Phase 2（5,000 件规模还缺：懒编译模型、场景预算解耦、缩略图并发预算、来源核验、包升级路径）见该文档 §11。**E19 轮㉙（2026-10-13）**：bug 猎对准**目录包与布局导入的消费端**（协议建好之后，真实使用它的那一面），六个真 bug：#59 移除包的提示只数当前户型（另外两份户型里的家具静默变幽灵）；#60 导入到上限时先入内存再拒写注册表 → 幽灵包（当场能用、刷新就没、主存里留孤儿存档删不掉）；#61 内置/包/自定义三个来源拼成查找表不查重 → 自制件被解析成别人的商品、两张卡片共用缩略图；#63 移除提示说「不再显示与计价」而占位就摆在图上；#64 导入布局 = 整体替换用户数据而零反馈，坏文件（没有 items 数组）把布局清空；#65 幽灵件在「采购 N 件」与采购清单里都没有归属（图上有、清单里没有 → 从清单里删不掉）。另记一条**被撤回的假 bug**（探针绕过真实入口自己拼流程 → 差点把正确实现「修」坏）与一条测试前提坑（bench 页 `save()` 是空操作）。t_3d 164→176×3，E2E 新流程 `layout-import`（196→203/入口）。见 §5.1 新增的八行与 §5.1.1。加目录条目照 §8.1 / skill 走。

---

## 1. 铁律（违反会造成不可逆损失）

### 1.1 `#calib` 校准输出必须逐字节不变

户型几何经过 **30 轮独立 AI 审查迭代**才与官方图纸对齐（最终 PASS）。任何改动之后必须验证：

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless --disable-gpu --screenshot=/tmp/ck.png --window-size=2400,1500 \
  --virtual-time-budget=9000 "file:///Users/dako/planner/planner.html#calib" 2>/dev/null
sips -c 1360 1674 --cropOffset 72 369 /tmp/ck.png --out /tmp/ckc.png >/dev/null 2>&1
md5 -q /tmp/ckc.png
# 必须等于 1ac26921871db50ef1c055674c10e6e7（基线 r31）
# 注：calib 底图来自 plan JSON 的 `calib:{img,w,h}`——**w/h 是图纸 px（591×480），
# 不是文件分辨率**（写成 2048×1370 会把底图放大 3.5 倍潎满全画布，md5 整体变掉）
# 只验几何，不受 UI 影响（body.calib 锁死旧版面板宽度，§5.4.6）
```

（`file:///Users/dako/planner/planner.html` = 根目录个人入口 = mine 户型，§0.3。
   **必须从仓库根目录打开**：否则 `private/plan/clean_plan.jpg` 解析不到，md5 会是另一个值。）

**新增的视觉元素一律不能进 calib 视图**。做法：
- FIXED 条目加 `noCal:true`
- 或在绘制处判断 `if(!CALIB) ...`
- 或让 CALIB 分支沿用原来的颜色（例：中岛描边写成 `stroke:CALIB?'#4a5058':'#6b655d'`）
- 或让数据在 CALIB 下不参与（S13 实例：`load()` 的内置布局播种 gated 在 `!CALIB`——
  基线 md5 是在干净浏览器（无存档、无播种）下拍的，播种会把 32 件家具画进 calib，md5 直接变）

如果确实要改动户型几何（用户明确指出图纸有误时），必须：
1. 记录**意图坐标**（不是"以底图为准"，而是明确写出这段几何应该是什么）
2. 更新基线 md5 并在提交信息里说明
3. 已有先例：西北斜墙落地窗带按实拍照片覆盖官方图（豁免区 plan x<135, y150-290）

### 1.2 两个版本号不能混用

| 常量 | 作用 | 何时 bump |
|---|---|---|
| `GEO_VERSION`(=3) | 家具存档 `planner_v1` 的版本闸门 | 户型坐标系变动 |
| `DOC_DATA_VERSION` | 户型文档 `planner_doc_v1` 的数据版本（旧 `planner_userGeo_v1` 自动一次性迁移进来） | **内置实体结构/几何变动时**（旧文档按版本丢弃、回退 freshDoc） |

**持久化是单键**：`planner_doc_v1` = 完整 `ProjectDoc`（内置+用户实体都在文档里，id 寻址）。编辑内置实体 = 直写文档实体（不再走 ov* 覆盖层）；删除内置 = 记入 `doc.hidden.*`。旧的 `planner_v1`（家具）与 `planner_userGeo_v1`（只读迁移源）分开。历史上「用户编辑按数组下标寻址」的坑（`USERGEO.ovW[i]`，往 `WALLS` 中间插墙就错位）已随 S1 Phase 2b 彻底消除。

**存到哪去是门面决定的（E10）**：上面那些键现在一律走 `STORE`（`src/storage/store.ts` →
app.html 的 `<script id="miniden-storage">`）：主存 IndexedDB `miniden-planner` / `miniden_kv`，
localStorage 是镜像与回退。**同步读 / 异步写**：`warm()` 未完成前 `get()` 直接读 LS（与旧行为
逐字节一致，所以像素基线不动）；旧单桶键与 `planner_userGeo_v1` 走 `lsGet/lsRemove`，**不迁移也不删**。
改持久化代码前先读 `docs/design/architecture.md` §3.3 的**六条**红线（迁移只复制 / 降级标记只由成功回灌撤销 /
补载入要门控 / LS 镜像必须同步写 / `warm()` 必须可重入 / **「读不到」不等于「不存在」**）。
最后一条是 E19 轮⑲ 加上的：`warm()` 未完成时那份存档可能只存在主存里（LS 被清过 / 超过 1.5MB 镜像上限 /
LS 配额满），这时回退出来的文档与布局**不许写回去**（写一次就把用户那份盖掉，实测 1.7MB → 5.2KB 且再也回不来）；
分界靠门面的 `warming(keys)`，warm 完成后解除并重新载入。同理，**回退的形状必须跟着户型走**：
自包含户型（空白 / 导入）回退成它自己的空白文档，不是内置公寓；读不动的存档保留不删。

**一份浏览器里可以存好几份户型（E26）**：上面那些键不再是全局单键，而是**当前户型的键**：
`planner_doc_v1:<户型id>` / `planner_v1:<户型id>`，谁是当前户型记在注册表 `planner_plans_v1` 里；**目录包是「这台浏览器的目录扩展」而不是「这份户型的存档」**：注册表 `planner_packs_v1` + 每包一个 `planner_pack:<id>`（S10，见 `docs/design/catalog-extension.md`），所以 §1.2 的「存档还在读」闸门不管包键。

| 要点 | 事实 |
|---|---|
| 内置户型的 id | 就是旧的指纹 `PLAN_FP`（name+sc+floorpts+walls+门数）——**所以老用户的存档零迁移**，键名一个字节都没变 |
| 自包含户型（空白 / 导入）的 id | 新生成：`'p' + Date.now().toString(36) + 随机` |
| 注册表 | KB 级 JSON，**永远镜像进 LS**（开机时 `warm()` 还没完就得以它决定当前户型），上限 24 份（满员挤掉最旧的非内置非当前） |
| 导入的语义 | **新建一份户型并切过去**，不再把导入的几何写进当前户型的键（以前就是这里把用户对内置户型的编辑抹掉的） |
| 内置布局播种 | 只在 `PLAN_ID === BUILTIN_PLAN_ID` 且该户型从未存过档时发生（空白/导入户型不会被塞进 32 件公寓家具） |
| 切户型 | 不刷新页面：换 `PLAN_ID/DOC_KEY/ITEMS_KEY` → `STORE.warm(新键)` → 重读 DOC+家具 → **清空撤销环**（切户型不是一次编辑，跨户型撤销会写错键） |
| 撤销快照 | 带 `p:PLAN_ID, r:PLAN_REG`：导入后 Ctrl+Z 把「哪份户型 + 注册表」一起退回去，不会把上一份的文档写进新键 |
| 删除 | 两步确认（第一下只亮确认态，无 `confirm()`）；内置不可删、最后一份不可删；删的是当前户型时 active 自动回到内置 |
| 首次引导卡 | 只在「什么都没存过 + 注册表只有内置 + `md_firstRun` 未写」时弹；`CALIB / IMGONLY / #ui: / bench / testgeo / plan=` 一律不弹（像素基线与点击不能被动，§1.1） |

注册表本身是纯函数模块 `src/storage/plans.ts`（不碰浏览器 API，vitest 直接测），
经 `MINIDEN_PLANS` 挂到 globalThis。`STORE.warm()` 因此改成**可重入的链**（`warmChain` + `warmed` 集），
否则切户型时新键永远读不到 IDB（旧实现是 `if(!warmPromise)` 一次性）。

**家具目录是 app 数据，摆法才是用户数据（S13）**：275 条目录（商品/尺寸/价格/模型代码）在 `app.html` 里，永远跟着文件走，与 localStorage 无关；localStorage 里只有「哪件商品摆在哪个坐标」。而 localStorage 不是可靠的长期存放（清浏览器数据 / 换浏览器 / 无痕窗口 / 代码换代都会看不见），所以户型 JSON 带 `layout`（这份户型的内置布局，随文件走）。`load()` 优先级：本户型存档 → 旧单桶存档（只读兼容，且只在内置户型下查）→ `PLAN.layout` 播种；**播种只在指纹键完全不存在时发生**（存过档哪怕存的是空数组也不播种，否则删空家具一刷新就被复活）。个人入口 `planner.html`/`dist/planner.html` 带 layout，公开入口 `app.html`/`dist/app.html` 必须 `layout:null`（build.mjs 硬断言）；测试台页面一律被 build 剥掉 layout。

### 1.3 用户明确说过的偏好

- **默认空白**：打开时不预置任何家具，参考方案只放在下拉里
- **死循环警戒**（用户多次指出）：发现自己第二次重复同一个工具调用或同一句措辞，立即停下——先确认上一步是否真的生效（rc/输出/文件变化），再换一个不同的做法；不要原样重试
- **永远给完整 URL**：`file:///Users/dako/planner/planner.html#3d`，不要写相对路径
- 实拍照片 `704.jpg`/`705.jpg` 是**实际单元**（深色地板）；`708.jpg` 是样板间（浅地板）——**以实拍为准**

### 1.4 隐私边界（2026-09，repo 是**公开**的）

`qining/miniden` 是 public repo。**个人数据（实拍照片、扫描图纸、户型坐标、
布局 JSON）绝不能出现在任何入库文件里，更不能进 git 历史**：

- `private/` 全目录 gitignore：`plans/mine.json`（真实户型，23KB）、`photos/`、
  `plan/`（clean_plan.jpg 等）、`bench/t_walledit.js`、`golden/`、`calib/`、`ref/`。
- 入库的 `app.html` 里 `#miniden-plan` 块 = `data/plans/generic.json`（通用 2室1卫，
  无个人数据）。`build.mjs` 本地构建时若 `private/plans/mine.json` 存在就把它注入
  dist（**dist/ 始终 gitignore，注入永不入库**）并重新生成根目录 `planner.html`；
  否则用 generic（CI/公开环境）。
- **`planner.html`（个人入口）现在入库**（用户 2026-10-05：「先把 planner.html 也确保在 repo 里面存着」）。
  它 = `app.html` + mine 替换，**含真实户型坐标**——与历史里已有的同一份数据（commit `e73cb45`
  的硬编码几何）同级，用户已明确暂缓 `git filter-repo`。所以现在的红线是**分区**的：

  | 必须干净（构建硬断言 / 审查） | 允许含真实户型（已知、被接受，直到将来删掉这个公寓） |
  |---|---|
  | `app.html`（事实来源）、`dist/app.html`（公开入口）、`bench/*.js`、`tests/`、`docs/`、`data/plans/generic.json` | `planner.html`（个人入口）、`dist/planner.html`、`private/**` |

  新的个人数据（照片、图纸扫描、真实户型截图/基线）**仍然一律进 `private/`**，不要顺手放进入库文件。
  将来删掉这个公寓 = 删 `planner.html` + `private/` + `build.mjs` 的 `hasMine` 分支 + `private/bench/t_walledit.js`。
- **S13：内置布局（家具摆位）跟着个人入口走**。布局源数据 = `private/plans/mine-layout.json`（gitignore），
  `build.mjs` 把它注入个人入口的 `#miniden-plan` 块（`plan.layout`）——所以 `planner.html` 里除了户型坐标
  还有家具摆位坐标，**与户型坐标同一豁免、同一个删除口径**。公开侧硬断言：`dist/app.html` 的
  `plan.layout` 必须空（build 报错），测试台页面一律被 `stripPlanLayout()` 剥掉布局，
  `t_3d` 的 `s13-bench-layout-stripped` 与 `t_walledit` 的 `s13-*` 断言守着这条。
- **mine.json 必须逐位精确**（§5.1 有坑）：它是从原版硬编码常量**用 node eval 原代码
  提取**的（floorpts/walls/… 与浏览器运行时逐位一致，已用 #dump 全字段核对）。
  手绘/Python 转算的值会有末位漂移 → 2D auto-fit viewBox 整体位移 → ui-gate 18% 假红。
- **历史已清（P1 收尾，2026-10-06）**：`git filter-repo` + force-push 已执行。剔除：实拍照片（704/705/708/709）、图纸扫描（clean_plan/clean4x）、旧 `work/golden/`（mine UI 基线）、旧 bench HTML（内嵌 mine plan JSON）、`tests/fixtures/legacy-geo.json`、`work/vih/`、过程探针（threeview_probe/_mkpt）；`planner.html` 历史版本全部剔除、**只保留 HEAD 一份（用户授权豁免）**；旧 commit 消息与 AGENTS/docs 历史版本里的个人词（旧默认名/城市+楼层/钢带真实坐标）已脱敏。**注意：清史后所有 commit 哈希已变**，文档里引用的旧哈希（如 `e73cb45`）仅作历史注记，新哈希见 `.git/filter-repo/commit-map` 时代的勘误提交。个人资产备份在 `~/backups/miniden-seattle-20261006/`（含清史前全历史 mirror）。
- 新增任何「真实户型相关」的产物（截图/基线/坐标）默认放 `private/`，
  入库前问自己：「这个文件给陌生人看，泄露了我的家吗？」

---

## 2. 开发流程（每次改动都走一遍）

> **所有建模/采集/验证工作都直接在主会话里做，不委派 subagent。**
> 大件任务按 §8.1 的步骤逐件推进即可。
> 实证（2026-09-19）：连「纯机械的全量回归」委派给 subagent 也翻车——弱后端模型花满 1 小时超时，
> 在反复调试**它自己生成坏的脚本**（`$`/引号被它的写入路径转义腐化，即 §5.1 的 `$'` 坑的镜像），
> 一条 bench 都没跑完。慢 ≠ 适合委派；**需要连续精确命令序列 + 失败判读的活，主会话自己做**（
> 逐个 bench 串行跑，每个几秒到十分钟，中间还能随时介入）。

```bash
cd /Users/dako/planner

# 0) 代码卫生（E6）：npm run lint（ESLint，JS 工具面）· npm run format:check（Prettier）
#    格式化只动 src/ tests/ scripts/ bench/ build.mjs；app.html/planner.html 字节敏感不格式化
#    （完整排除清单见 .prettierignore；TS 文件暂不进 ESLint，typescript-eslint 不支持 TS7）

# 1) 改代码（见 §7 编辑技巧）

# 2) 语法检查——必做，比打开浏览器快得多
python3 -c "
import re
html = open('app.html').read()
m = re.search(r'<script>\n(.*?)</script>', html, re.S)
open('/tmp/planner_check.js','w').write(m.group(1))
" && node --check /tmp/planner_check.js && echo "SYNTAX OK"

# 2b) 构建（E1/S10/E18 起）：node build.mjs
#     → dist/app.html（公开入口 generic）+ dist/planner.html（个人入口单文件，注入 mine + private/ 路径修复）
#       + 根目录 planner.html（个人入口源形式）；无 private/ 时个人入口退回 generic
#     + 重新生成 12 个 bench HTML（4 脚本 × source/dist/公开入口，work/ 下 gitignore）
#     改完 app.html / bench/*.js 之后必跑（dist 与根 planner.html 都是构建产物，不同步就是过期副本）

# 3) 交互测试台（t_walledit 259 / t_3d 176 / t_planbuild 258 / t_pt 45 条断言，见 §3；dist 变体同断言，见 §5.7；
#    推荐直接 node scripts/run-bench.mjs）
# 4) 校准回归（§1.1）
# 5) 视觉验证（截图 + 放大目检，见 §4）
# 5b) UI 改动（样式/组件/交互流程）：跑七道验收关（见 §8.4），
#     重点：交互流程脚本 + 人眼可见性三层探针
# 6) commit（用户没要求就不要 push；要 push 时先确认）
```

**绝不能**只做截图冒烟就认为交互功能可用。教训见 §5.1。

---

## 3. 自动化交互测试台（最重要的资产）

用 **真实命中测试 + 合成 PointerEvent** 驱动 UI。**S10 起测试脚本与 bench HTML 分离**：

| 脚本（源） | 位置 | 覆盖 | 断言 | 输出 `<pre id>` | 窗口 / virtual-time |
|---|---|---|---|---|---|
| `t_walledit.js` | **`private/bench/`（gitignore）**——含真实户型几何坐标断言 | 2D：墙/柱/门/洁具编辑、门垛联动、S5/S6 导入、双币种、视图/单位/面板、S7 描图、对话框、E10 存储 | 259 | `wetest` | 1700x1100 / 100000（dist 120000） |
| `t_planbuild.js` | `bench/`（入库，plan-independent） | **E22 户型构建**：进入编辑模式、选中/命中/抖动点击不脏内置、拖整段(Esc 回滚)/拖端点、画墙(右键不加点/Backspace/Enter/太短拒收)、画柱→2D 命中+3D 立到顶、门系统(款式/开向/滑动联动/调宽/方向键安全边界)、洁具(放置/贴墙契约/拖动/微调/删除权限)、编辑→3D 一致性、**导入后编辑**、持久化往返；**E24 数值改长 + 整图重标定**：工具条不溢出、编辑提示看得见、预填当前长度、改这段（起点不动）/下限拒收/挂在段上的门窗不许甲出去、内置户型禁用整图缩放、导入户型两步确认缩放（构件数不变、门跟着走、可撤销）；**E26 多户型**：从内置户型开始、列表可见、内置不可删、新建空白户型（真的空 / 不拿内置户型的地板轮廓 / 不播种内置家具 / 键与内置分开）、空白户型里能画墙且地板轮廓跟着走、切回内置户型**用户编辑还在**、两份互不干扰、重命名不动内置、删除两步确认、导入新建一份且内置存档不被摸、Ctrl+Z 把户型与列表一起退回去、引导卡在 bench 里不弹、户型行不溢出；**E27 彻底的从零开始**：空白户型 → 画一圈墙（底边一段窗 + 顶边一段门洞）→ 门放上 → 马桶/洗手盆/镜子（镜子贴画的墙）→ 三件家具 → 3D 里墙立到顶且家具在场景里 → 存档往返 → 切回内置（那份房子与内置互不干扰、内置没被脏）→ 删掉那份户型；另加「非法洁具类型不许进文档」的爆炸半径断言（一个非法 `t` 会让 validate 失败，而 loadDoc 对 validate 失败的文档是删档回退空文档）；**E28 贴墙契约改为独立测量**（`pbDrawnThick()` 从 `wallPolys()` 量「画出来的墙有多厚」，不再照抄实现公式）与**第一人称落点必须在户型内**；**E19 轮⑰ 整图重标定的载体与派生字段**（家具跟着搬、门 `width` 跟着缩放、窗厚与墙厚同比例——墙厚从 `wallPolys()` 量、窗厚从投影 `wd` 量，两条路交叉）；**E19 轮⑱ 导入文档的 env.preset 洗名**；**E19 轮⑲ 存档读不动 / 缺失时不许把内置公寓写进自包含户型**（回退形状、坏存档不被覆盖也不被删、缺失时不认领旧单桶存档、坏了也删得掉）；**E19 轮⑳ 台面是一等可编辑对象**（凹型户型的柜体侧靠探点投票而不是质心、模块中不悬出末端、装不下就拒放并说明、台面在「选择/调整」里可选中可删、台面在下洁具在上的命中顺序、模块放置在两种工具模式下都接、删洁具/删台面进撤销环、只点一下没拖不算一步）；**E19 轮㉒ 撤销一次只退一件事**（连放两个洁具 / 连点两次同一商品 / 两次 +90° / 两次键盘 R / 同一段墙连改两次类型 / 同一台面连放两个模块，各自都是独立一步，撤销一次只撤最后那件；两条对照组断言守住「连续手势照旧只算一步」与「复制两次本来就该是两步」）；**E19 轮㉓ 检视面板的口径**（颜色/色温/亮度各占一步撤销、打 720 后框与滑块读同一个数且 +90° 落在 90、逐字符打 45.5 得 45.5 而不是 185、清空框/打「-」不把家具转到 0°、重打同一个数字不产生死步、99999/0.1/h=-5 全拒且户型不被一个笔误盖住、焦点在数字框里 Ctrl+Z 生效而搜索框里不被抢走、撤销后面板跟着回去）；**E19 轮㉔ 按屏幕尺寸恒定的叠加层与标注的归属**（放大 5 格 / 缩小 10 格 / 重新取景 / 整图重标定四条路径后标注线宽与字号必须还是 1.600px / 10.00px，手柄还是 1.000px / 1.500px；导入与切户型后旧标注归零；重标定后标注跟着墙走（端点偏差 0.000ft、读数从 1024cm 变 2048cm）；撤销那次缩放时标注一起回去）；**E19 轮㉕ 编辑模式 × 3D 视图**（3D 俯瞰里编辑工具条必须不可见、「编辑墙体」按钮必须还亮着 = 模式可见；在 3D 里连按三次方向键 / Delete 不得改几何也不得进撤销环；3D 在场时几何变了必须重建静态场景（`staticGroup` 换对象、顶点 55965→56001、新墙处射线命中 y=8.80ft）；两条对照组：2D 里工具条可见、2D 里微调照常生效）；**E19 轮㉗ 换户型时编辑层的作废**（新建空白户型后 sel=null / drawPts=0 / 门与洁具控件不亮着；悬空 sel 按 Delete → walls 0→0、hidden 0→0、撤销环不变、提示「这个构件不在当前户型里，选中已取消」而不是「已删除」；三条对照组：同一户型里画两点链照常 +1、切户型同样作废、选中时工具条确实描述它） | 258 | `pbtest` | 1700x1100 / 200000（dist 220000） |
| `t_3d.js` | `bench/`（入库，plan-independent） | 3D：拾取/拖动/旋转、开关灯、**全目录建模+贴图体检**、缩略图、S5/S6 导入、双击进室内、座椅体检、**目录侧栏用户状态**（展开的分类不被重建冲掉、刚造的自定义件必须看得见、输入校验不许用阻塞弹窗、图片加载失败不许变空白）、**S4a/S4b 窗外环境**（10 预设尺寸/互异/确定性、地平线一致、窗口切片可读、夜景全宽辉光、按钮生效与持久化、顶栏单行不溢出）、**S4c 预设消费端**（陌生预设名不炸室内光照、存档/导入读进来时被洗成合法名、光追中途不许换环境）、**3D 拖动的点击判据**（手抖 1~2px 不许挪家具、只点一下不许进撤销环、连着拖同一件两次必须是两步撤销）、**S10 目录扩展协议**（内置目录 0 error 0 warning、校准/测试台不加载包、包级与条目级两层校验、坏条目不连坐整包、条目真的进目录、**包模型必须守内置三律**（填充率 92~102% / 贴地 / 重心归零）、通用回退建模、内置赢、编译失败退回、刷新后还在、移除后如实说明、幽灵件 2D/3D/面板/可删）、**S10 包协议的消费端**（移除提示覆盖全部户型、上限在入口拒收且不产生幽灵包/孤儿存档、目录 id 全局唯一、导入布局撞 id 拒收、替换必须报「几件 → 几件」、坏文件不许清空、幽灵件必须进合计与采购清单并能从那里删掉、确认框声称的模型失败数必须与真实一致） | 176 | `t3d` | 1400x950 / 170000 |
| `t_pt.js` | `bench/`（入库，plan-independent） | 光追：GL 能力探针、BVH、着色器、进度、降噪、**取景钉住**、萤火虫/NaN 判别、分块自适应、**白家具可辨识度**（满家具客厅）、**S4c 光追期间不许换环境**（预设/昼夜/开关灯被拒 + 告知、取消真的提前停下）、**S4d 光追期间整份场景冻结**（切视角 / 双击走过去 / 滚轮走动 / Delete 删家具 / 改旋转全被拒且界面说明为什么、三角形数不变、取消真的提前停） | 45 | `tpt` | 1200x850 / 600000 |

**Plan-independence 规则**（bench 脚本入库的前提）：
- 所有坐标目标**从运行时派生**：`floorPts()`（`FLOORPTS` 常量的别名）的 bbox 中心，
  或 `LABELS` 里的房间标签（`p` = 房间中心）。
- **例外（t_pt）**：t_pt 的家具布局与相机**锚定「客厅」标签中心**，不能用 floorPts bbox 中心
  ——bbox 中心 ≠ 房间中心，平移过去家具就移出租界，firefly 从 43 涨到 75 破限
  （2026-09 实测：HEAD 原版锚点恰是客厅标签位置，用标签派生后逐像素复现）。
- **统计量门禁必须钉住取景与尺寸**（E25）：光追出图尺寸 `rw/rh` 来自画布 client 尺寸按
  `maxPx` 缩放，而 `uAspect = rw/rh` 就是**出图视野**——窗口布局（字体度量→面板/顶栏宽度）
  决定了光追看到多大范围的场景。CI 上量到 76x94、本地 73x97，同一个「萤火虫衰减比」
  门禁在两个平台比的其实是两张不同取景的图（本地 0.21%→0.04%，CI 0.18%→0.17%，要求 <0.75 倍
  → 假红，而且两侧都逐次完全一致，看起来像真回归）。现在 bench 传 `ptRender(...,{size:[73,97]})`
  钉住出图，并有 `pt-bench-framing-pinned` 断言守着。**推论**：任何拿像素统计量做门禁的 bench，
  都要先把产生这些像素的条件（取景、尺寸、采样数）固定下来，否则红/绿只反映跑它的那台机器。
- t_walledit 含真实户型坐标断言（门/墙的具体位置），**只能放 private/**（§1.4）；
  CI 只跑 t_3d / **t_planbuild** / t_pt（generic plan 上同样全绿——这就是 plan-independence 的验收）。
  **E22 的动机就在这里**：t_planbuild 之前，「画墙 / 开门 / 放洁具」这条 2D 主路径的断言
  只存在于 private 那份里，公开入口那侧零覆盖。
  **E5 CI**（`.github/workflows/ci.yml`）：用 `node scripts/run-bench.mjs` 跑 9 个 bench；
  ui-gate 在 CI 里先 `--update` 自建 generic 基线再 gate 比对（双截 0.0000% = 验渲染确定性，
  **不验视觉回归**，§3 开头的「--update 什么都不证明」同样适用于 CI）；
  calib md5 门禁需要 private/ 资产，CI 跑不了，留在本地（§1.1）。

**生成**：`node build.mjs` 把四个脚本注入 **source(mine) / dist(mine) / dist(generic)** 三份页面，
产出 `work/t_*.html` + `work/t_*_dist.html` + `work/t_*_app.html`（12 个，全 gitignore，每次构建重新生成）。
**`*_app.html` 是 E18 的同步门禁**：同一套断言跑在公开入口 `dist/app.html`（generic 户型）上。
**脚本改了就重跑 build.mjs，不要手工维护 HTML 副本**。注入用 Python `str.replace`
（`$` 陷阱见 §5.1）+ 注入后 `node --check`。

**两个测试台不能合并**：2D 全套跑完再构建 3D 场景会超出单次 `--virtual-time-budget`，
页面根本不输出结果（症状是 `NO TEST OUTPUT`，很容易误判成页面崩溃）。
每次跑之前先 `pkill -f 'Google Chrome.app.*--headless'`（别误杀 playwright 的 headless-shell）。

**`t_pt` 的 `pt-kallax-visible` 探针会偶发全黑**（均值 0 / 标准差 0，headless 瞬态；
CI 的 Linux 软件 GL 上更易触发，慢 runner 上会连击）：bench 内置自愈（读到全黑 0/0 →
重渲，最多 5 次、间隔 2s，断言读数里带「渲染尝试 N 次」），`scripts/run-bench.mjs` 还会对
FAIL 的 bench 整体原样重跑一次；两层都红才是真红。**只有「整块全黑」这个签名重试**：
真回归的签名是「均值不为 0 而标准差太小」（白格架与白墙糊成一片），那条当场红、不重试、
不掩盖。实测边界（CI run 38197749463，一个只改 .md 的提交）：旧口径（内部 3 次 + 整页 1 次）
在慢 runner 上四次全黑把整条 CI 判红，重跑就全绿；重试上限抬到 5 次后不再出现这种连击。

**Chrome ≥140 软件 WebGL 需显式 opt-in**：`--use-angle=swiftshader` 之外还要
`--enable-unsafe-swiftshader`，否则 Linux runner 上 PT 的 float FBO 路径变 no-op
（症状：图全黑均值 ≈4、亮像素≈窗面积、跑得快）。run-bench 已内置。

**dist 变体**（E1 起）：验收口径 = source 与 dist **同样全绿**——dist 绿了才说明构建
管线（plan 注入/ESM 重构）没改变行为。经典脚本→ESM 的坑见 §5.7。

**E16 黄金截图**（`scripts/ui-gate.mjs`）：截 **dist**（本地 = mine 注入；CI 无 private/
= generic）对 `private/golden/`（mine 基线，gitignore）或 CI 自建基线。
**截图态里一切异步渲染的东西必须同步渲完**（`#ui:*` 下目录缩略图走同步路径，见 §5.1）——
否则「双截一致」证明的是运气，不是确定性。
**ui-gate 截 dist 不是 source**（source 里是 generic plan，对 mine 基线必然 18%+ 假红）。
标题/样式有意改动后 `--update` 重拍（显式动作，提交信息里说明）。

**`--update` 之后的「8/8 @ 0.0000%」什么都不证明**（P1 实测踩过）：基线被重拍成
「改动后的样子」，回归就被焊进基线里了。**重构类改动（plan 外部化/模块化/重排）
的验收不能只看 ui-gate**，要对**改动前的版本**独立做一次像素对比：
`git show HEAD~1:app.html > _prev.html` → 同窗口同 `#ui:<state>` 各截一张 →
pngjs 逐像素比。P1 那次就是这样才抓到「2D 0.79% / 3D 1.23%」的真回归
（基线 mtime 比 diff 图还新 = 跑红之后补拍的，是个有用的取证信号）。
改完记得 `rm _prev.html`。

### 运行

**推荐：`node scripts/run-bench.mjs [bench.html...]`**（窗口/budget/pre-id 与下表一致，
自动重跑瞬态，失败时输出 chrome 的 GL 诊断）。下面是等价的 ad-hoc 形式：

```bash
R=/Users/dako/orca/workspaces/planner/add-catalog   # worktree 路径（bench HTML 必须从 worktree 跑）
run() {
  "$CHROME" --headless --use-angle=swiftshader --allow-file-access-from-files \
    --dump-dom --virtual-time-budget=$2 --window-size=$3 \
    "file://$R/work/$1" 2>/dev/null | python3 -c "
import sys,re,html
t=sys.stdin.read(); m=re.search(r'<pre id=\"$4\">(.*?)</pre>', t, re.S)
r=html.unescape(m.group(1)) if m else 'NO TEST OUTPUT'
lines=r.split(chr(10)); fails=[l for l in lines if l.startswith(('FAIL','EXC'))]
print('  $1: tests',len([l for l in lines if l.startswith(('PASS','FAIL'))]),'| fails:',len(fails))
for f in fails[:5]: print('   ',f)"
}
run t_walledit.html 100000 1700,1100 wetest
run t_walledit_dist.html 120000 1700,1100 wetest
run t_planbuild.html 200000 1700,1100 pbtest
run t_planbuild_dist.html 220000 1700,1100 pbtest
run t_3d.html 170000 1400,950 t3d
run t_3d_dist.html 170000 1400,950 t3d
run t_pt.html 600000 1200,850 tpt
run t_pt_dist.html 600000 1200,850 tpt
```

每个 bench 跑完之间 `pkill -f 'Google Chrome.app.*--headless'`（swiftshader 僵尸抢 CPU）。

### E21：真实输入 E2E（第四种证据，2026-10-08）

bench 的证据类型是「合成 PointerEvent + `--virtual-time-budget`」：它证明**逻辑对**，
不证明**人点得动**。E21 补的是另一头 —— 真实输入喂给真实页面：

```bash
npm run e2e            # headful：能看着它点（每步 620ms；--speed=0 加速，--fast 即 0）
                       #   默认跑两个入口：dist/planner.html（个人）+ dist/app.html（公开）
npm run e2e:all        # 四个入口全跑：dist/planner · dist/app · planner.html · app.html
npm run e2e:public     # 只跑公开入口 dist/app.html（generic 户型）
npm run e2e:ci         # CI 口径：--headless=new + swiftshader，入口 dist/app.html + app.html
node scripts/e2e.mjs --entry=src-app --fast   # 只跑入库的源文件 app.html
node scripts/e2e.mjs --flow=view-3d-fp --fast   # 只跑一条（调试）
node scripts/e2e.mjs --keep-state               # 保留上一个 flow 的状态（调试用）
```

**入口口径（E18：一个事实来源 → 两个入口）**：`--entry=` 可选
`planner`(dist/planner.html) · `app`(dist/app.html) · `src-planner`(planner.html) · `src-app`(app.html) ·
`both`(默认) · `all`，逗号可组合。入口文件不存在时跳过并打印（CI 里没有 `private/` → 没有 `dist/planner.html`）。本地默认两个入口各跑一遍（203/203）；CI 跑公开侧两个
（`dist/app.html` 构建产物 + `app.html` 入库源文件）——**只改源不重捆、或只重捆不修源，这里就红**。

报告：`work/e2e/report.html`（每步截图 + 断言 + 弹窗记录）+ `work/e2e/log.json`（gitignore）。
27 条流程 / 203 断言；**默认两个入口各 203/203（406/406），四个入口全跑 812/812**。CI 口径 **26 条 / 172 断言 × 2 入口 = 344/344**：`demo-full` 带 `ciSkip`（它含一步真 GPU 光追，断言里用的是未钉住取景的像素统计——E25 的口径说这种数字在软件 GL 上只反映机器），而它每个环节的断言已经分别被 bench 第 13 节与 `from-scratch` / `view-3d-fp` / `persistence-reload` / `doc-export-import` 在 CI 里守住。

**流程顺序就是产品顺序（E27）**：打开 → 首次引导 → **从零建房** → 画墙 → 放洁具 → 放家具 →
单位/货币/搜索/自定义件 → 目录包 → 导入布局 → 量尺寸 → 3D → 光追冻结 → 持久化 → 面板 → 导入导出 → 多户型。
家具排在户型构建之后不是排版问题：以前每条流程都跑在内置户型上（打开就有一整套房），
所以「没有图纸的人从空白画布开始」这条产品承诺从来没有被真实输入测过。

它比 bench 多出来的真实东西：`Input.dispatchMouseEvent/dispatchKeyEvent/insertText`
（trusted event）、`Page.javascriptDialogOpening` + `handleJavaScriptDialog`
（**真 confirm()** —— bench 里阻塞弹窗根本不能出现，§5.1）、`DOM.setFileInputFiles`
（真选文件）、`Browser.setDownloadBehavior`（真下载落盘）、`Page.reload`（真刷新）。

**口径（与 bench 同源的红线）**：
- 断言全部 plan-independent：坐标从 `FLOORPTS` / 元素 rect 运行时派生，不写死户型数字。
- **每个 flow 前清存档**（localStorage + IndexedDB 再重载）：不隔离时上一个 flow 写进存档的
  户型/家具会漏进下一个（实测墙段数 72→66），跨次运行之间也不确定（profile 是复用的）。
- 断言读「用户看得到的东西」：卡片文字、合计文案、悬停 `title`、SVG 里的红描边、
  3D 场景里的光源强度、相机眼高、下载文件名、确认弹窗正文。DOM 存在不算证据（§8.4）。
- 依赖只有 Node 内置 `WebSocket` + `fetch`（不装 playwright/puppeteer）。

### 写测试的关键手法

```js
// 真实命中：用 elementFromPoint 找到实际接收事件的元素
const fire=(type,cx,cy,extra)=>{ const tgt=document.elementFromPoint(cx,cy)||svgEl;
  tgt.dispatchEvent(new PointerEvent(type, Object.assign({clientX:cx,clientY:cy,
    bubbles:true,cancelable:true,pointerId:1,isPrimary:true,button:0,buttons:1}, extra||{}))); };

// 图纸坐标 → 屏幕坐标
const SPT=(fx,fy)=>{ const ctm=svgEl.getScreenCTM();
  const p=new DOMPoint(fx*S, fy*S).matrixTransform(ctm); return [p.x,p.y]; };

// headless 里 setPointerCapture 会抛，先打补丁
const origCap=Element.prototype.setPointerCapture;
Element.prototype.setPointerCapture=function(id){ try{ origCap.call(this,id); }catch(e){} };
```

**断言按钮「开/关」状态要先读当前值再断言翻转**：别的代码路径可能已经切过它
（实测：进编辑墙体会自动开底图对照，bench 再点按钮断言 `.on` 就反了）。
写成 `before = el.classList.contains('on'); el.click(); assert contains('on') === !before`。

**断言里不要写死材质颜色常量**——改了材质就会假失败。已经因为这个踩过两次（门材质调色后测试红）。要么断言结构（mesh 数量、类型），要么改材质时同步更新测试常量。

---

## 4. 验证方法论（按可靠性排序）

### 4.1 像素探针（最可靠，用于几何校准）

写一个临时 HTML 用 canvas `getImageData` 扫描暗带边缘，Chrome headless `--dump-dom` 读结果：

```js
const files = ['ov_r30.png','img_plan.png'];       // 叠加图 vs 纯底图，同帧同坐标
const probes = [ ['row',Y,X0,X1], [X,Y0,Y1] ];     // 行扫 / 列扫
// lum<120 判为暗；输出每条扫描线上的暗带区间
```
`OVL` = 矢量+0.6透明底图的并集，`IMG` = 纯底图。比较边缘位置差即偏差。
底图抗锯齿有 1-2px 毛边，**用多条探针取中位**，不要单点定论。

### 4.2 坐标映射标定（不要反解，要正向标定）

千万别从墙特征反解图纸→像素的映射（多解且易错）。正确做法：在副本里于**已知图纸坐标**画 4 个绿色标记点，同管线截图后聚类定位，一次解出：

```
ov = plan × 2.8165 + (4.7, 7.9)      # 对应 2400×1500 截图裁 (369,72) 1674×1360 的标准管线
```

### 4.3 连通域 / Hough / 网格叠加

- **连通域**：找洁具、找孤立色块（注意洁具轮廓常与墙连通，会合并成大块）
- **Hough 变换**：用户在图上画的标注线 → 精确直线方程（做过：从用户手绘橙线解出门线斜率 0.450）
- **网格叠加**：把图纸坐标网格画在底图上直接读数（比目测强，但不如探针精确）

### 4.4 视觉目检（必要但不充分）

```bash
sips -c 高 宽 --cropOffset Y X 输入.png --out /tmp/x.png    # 注意参数顺序！offset 为 0 时要写 1
sips -z 高 宽 /tmp/x.png --out /tmp/x_big.png               # 放大
```
然后 `Read` 图片。**小裁剪会误判**——曾因裁得太小把连续的墙看成断开，扩大裁剪范围后发现是好的。

---

## 5. 踩过的坑（血泪清单）

### 5.1 流程类

| 坑 | 后果 | 正确做法 |
|---|---|---|
| 只做截图冒烟就交付交互功能 | 用户反馈"根本不工作" | 必须写自动化交互测试台 |
| 凭 DOM 查询（querySelector/textContent）声称「已显示/可见」，用户说「我看不到」 | DOM 存在 ≠ 人眼可见：被盖住（z-index）/ 在裁剪或折叠区外 / 对比度不足 / 只是已关闭的瞬态 | 可见性声称必须过三层探针（几何/遮挡/截图放大目检），见 §8.4 |
| macOS **没有 `timeout` 命令** | rc=127，命令根本没跑，`echo done` 掩盖了失败，看到的是旧文件 | 不要用 `timeout`；检查 rc |
| 测试页是改动前生成的副本 | 测出旧行为，浪费一轮调试 | 每次改完 app.html 都重新生成测试页 |
| 批量 replace 时文本已漂移 | 静默 MISS | 每次 replace 都统计 miss 数并打印 |
| `pkill -f headless` 误杀 **browser 工具的 playwright `chrome-headless-shell`**（路径里含 headless） | 浏览器会话被断、且杀不干净上一轮 Chrome 僵尸 | 精确匹配：`pkill -f 'Google Chrome.app.*--headless'` |
| **headless 里 `alert()`/`confirm()` 永久阻塞页面**（无人应答，进程存活但 0% CPU、dump-dom 永远空） | bench 挂死，症状与「页面崩溃」相似但 CPU 为 0 | 交互路径（会被 bench 执行到的）一律不用阻塞弹窗（改 toast/内联提示，2026-09-18 的 S6 bug 猎里 `setUnderlay` 在导入户型下 alert 就是这样把 bench 挂死的）；诊断挂死：看 `ps` 里 Chrome CPU——0% = 阻塞等待（弹窗/网络），高 = 在算 |
| 用 Python **`re.sub`** 或 Node **`String.replace`** 做注入/替换，而替换文本里含 **`$'`** | `$` 序列是两者的共同陷阱（Node 的字符串/正则替换都会解释 `$'`/`` `$ ``/`$n`/`$$`，**和 Python re.sub 一样**；Python `str.replace` 才是安全的）：`$'` 展开为「匹配点之后的整个字符串」——测试台里 `'…CA$'`（字符串以 $ 结尾）被替换成 `</html>`，单引号串跨行 → 整个 bench SyntaxError、一行都不跑，症状是 `NO TEST OUTPUT` 且无任何报错。**2026-09 再踩实例**：S6 把 pdf.js 1.77MB 压缩库 `JSON.stringify` 后塞进 `replace('</head>', …)` 的替换串——压缩代码里的模板串 `` $` `` 展开成「`</head>` 之前的整个文档」（DOCTYPE+CSS 灌进 JSON 块，220 个裸换行 → `JSON.parse` 炸、dist bench 异常）。**vendored 大库是 `$` 序列的最大来源** | 文本注入一律用 Python `str.replace`；用 JS 的 `replace` 注入时替换串先 `.replace(/\$/g,'$$$$')` 转义（build.mjs 的 bench 注入/dxf 内联/pdfJsInline 块都已做）；注入后对产物跑 `node --check`，JSON 块跑 `JSON.parse` 自检 |
| **`$` 转义只许一层：`'$$$$'`（4 个），不是 `'$$$$$$'`（6 个）** | 6 个 `$` → 第一层 replace 产出每 $ 3 个 → 外层 replace 把 `$$` 解回 `$` 后剩裸 `$` 与下一字符重新拼出 `$'` → 再次展开腐化（S10 实测：t_walledit 198→0 全挂，HTML 里出现 `CA$$1,029`） | 写 `$` 转义时数一遍：一层 = 4 个 `$`；拿不准就先在 node 里跑一次往返自检（注入→提取→比对原串） |
| **CSS 规则级替换丢失右花括号**（S9 token 化实例） | `.glass{stroke:#7fb8ff;}` → `.glass{stroke:var(--drw-glass);`（替换串漏了 `}`）：CSS 解析器把**下一条规则 `.roomlabel{...}` 整个吞进 `.glass`** 当声明——房间标签样式静默失效；**计算的几何/CTM 完全不变**，只有黄金截图（2D 状态文字位移/变宽）和 calib md5 抓得到 | 改 CSS 一律**整规则替换**（selector 到右括号完整包住）；批量替换后跑**规则结构 diff**（选择器集合+每规则声明集合）+ `npm run ui:gate`；「几何探针全同但画面变了」= 样式解析问题，不是布局问题 |
| 从 dist 文件自身抽 bench 再重注入 dist | 传播旧污染（bench 一旦被 `$'` 展开腐化，每次「从自身重抽」都把它原样带进新产物） | bench 只从 source 测试台抽（build.mjs 已这样做；ad-hoc 脚本别另起炉灶） |
| bench 再生成只重写部分 `lib/` 相对路径（漏 dxf-parser） | `window.DxfParser` 未加载，导入链路抛异常，**把后面所有测试段也带崩**（症状：s5 全 FAIL + EXC，s6 一行没跑） | 重写规则要覆盖 head 里**所有** lib 引用（three/OrbitControls/dxf-parser）；bench 段之间加防御：前段失败不让后段跳段 |
| **视图状态跨段泄漏**：bench 里某段放大/平移/导入后，后续点击坐标在视口外 | `elementFromPoint` 打空→落到 svg 根→放置类工具「凭空」在点击坐标放了件（症状：多出无法解释的 user 实体，且坐标恰好=点击点）；同一点击想选旧件却选不中 | 每段点击类测试开头先复位视图（`fit2DToContent()`）再 `drawWallEdit()`；诊断「多出来的件」先看它的坐标=哪次点击 |
| **放置/选中类工具：新实体要重画命中区**（overlay 是命中唯一来源） | 放置后不调 `drawWallEdit()`：新件无命中区→再点它=又叠一件；而旧件的命中区还在（切工具时画的）→「有时点得中有时点不中」极难查 | 任何改实体的工具分支末尾都 `geoChanged()+drawWallEdit()`（S6 洁具工具踩过） |
| `<select>` 值跨测试段粘滞（fxType='mirror' 留在下一次点击） | 后续点击全按上个类型放置，断言「放了马桶」变成「放了镜子」 | 每段放置前显式设 `#xxType` 值，不依赖默认值 |
| **viewBox 单位 = ft×S**（所有 2D 绘制都乘 S） | `fit2DToContent` 直接用 ft 算 bbox → 导入后视图放大 S（22）倍，用户只见一个墙角（S5 潜在 bug，S6 bench 才暴露） | 任何写 viewBox 的代码都用 ft×S 单位；拿不准就和初始 viewBox（1232×1012 = 56×46 ft × 22）对量纲 |
| **plan 坐标末位漂移 → auto-fit 视图整体位移**（S10） | Python/手算的 `px/11.2` 与浏览器 V8 逐位不同（末位 1 ulp）：calib（固定像素管线）看不出来，但 **2D auto-fit viewBox / 3D 相机取景**的 extent 变了 → 整体平移 → ui-gate 18~53% 假红，症状极像「UI 崩了」 | plan JSON 一律**用 node eval 原版代码提取**（V8 对 V8 逐位一致），再用 `#dump`/页面内探针与浏览器运行时值全字段比对（JSON.stringify 相等才算过） |
| **calib 底图 w/h 写成文件分辨率**（2048×1370，实为 591×480 图纸 px） | SVG `<image>` 按 w/h 铺：放大 3.5 倍后潎满全画布，calib md5 整体变掉（diff 197k 像素、全画布、非位移） | 底图尺寸是**图纸 px**（与 viewBox 同量纲）；改 calib 字段后立刻跑 §1.1 md5 |
| **把几何外置成 plan 数据时漏掉「某户型专属」的硬编码构件**（P1 实测：3D 落地窗带钢梁 `C(x1,y1)…`（真实坐标已随 P1 清史从历史剔除） + 2D 黑方块示意 + 阳台楔形补板 + 中岛标签位） | 只按 `docImported()` 门控、不按 plan 门控 → 换个户型照画不误：钢梁斜穿整个户型，看着像「地板和墙错位」；而且真实坐标还留在公开文件里 | 外置几何后 `grep -nE 'C\([0-9]'`（以及任何裸数字坐标）扫一遍消费端，每处问「这是所有户型都有的，还是某一户专属？」——专属的一律挪进 plan JSON 并用 `PLAN.xxx` 存在性门控；验收：**generic 户型目检 2D+3D**（mine 全绿不代表 generic 没炸） |
| **localStorage 存档不带户型标识**（P1：`planner_v1`/`planner_doc_v1` 单桶） | plan 外置后，mine 的存档被原样回放到 generic 上（斜墙/阳台/柱 + 满屋家具叠在通用户型里）；用户以为「渲染坏了」 | 键按户型指纹分桶（`planner_doc_v1:<fp>`，fp = name+sc+floorpts+walls 的 hash）；旧单桶键**只读兼容且不删**（它属于另一份户型，删了就是毁用户数据），采用前用 `docMatchesPlan()` 逐坐标核对内置实体 |
| plan-independent 的 bench 里写死了某个户型的数量（镜子断言 `===3`） | 换户型就假红（generic 只有 1 面镜子），而 CI 只跑 generic → CI 永远红、本地永远绿 | 断言与**运行时投影**比（`const n = FX.filter(...).length`）或从 `floorPts()`/`LABELS` 派生；每个写死的户型数字都要问「另一个户型也是这个吗」 |
| JS 正则字面量里未转义的 `/`（写成 `/(\.\./)?private\//`） | 字符类外的 `/` 直接结束字面量 → `Invalid regular expression: Unterminated group`，构建脚本连加载都失败 | 正则里的斜杠一律 `\/`；写完 `node --check` 一遍 |
| bench 里顶层 `const` 命名撞已有声明（bx1/bx 等） | 整段 bench SyntaxError、一行不跑，症状 = NO TEST OUTPUT | bench 是新代码但跑在既有函数作用域里：新变量名先 grep 一遍 bench 全文再定 |
| 返回文档时用字面量 `runs: []` 而不是简写变量 `runs` | `info.counts.runs` 是 1、`doc.runs` 却是空数组——push 进的是局部变量，文档里是另一个数组，测试读不到 | 文档字段用简写（`runs,`）；写完立刻打印 `doc.runs` 与 `counts.runs` 对一下 |
| `segOnBand(seg, band, tol)` 吃**单个** Band | 传 `bands` 数组 → `bd.dir` undefined → `Cannot read properties of undefined (reading 'y')` | 遍历数组：`bands.some(bd => segOnBand({a,b}, bd, tol))` |
| 米/英尺混用（文档字段一律 ft） | `topH: f2(COUNTER_H_M)`（米）写进文档 → 0.9 被当 0.9ft，差 3.3 倍 | 常量是米就 `f2(COUNTER_H_M * M_TO_FT)`；对照 `polyBboxM`（返回米）与 `f2`（ft）确认量纲 |
| 以为窗有 `effWindows()`（其实没有） | `steelBands()` 在首次 `build2D()` 时 ReferenceError → 整段 bench 崩 | 窗走 `effWalls()` 投影（`t:'g'` + `_id`）或 `DOC.windows`；读 `DOC` 的函数要 TDZ 守护（`freshDoc()` 在 `loadDoc()` 内跑） |
| 合并感知的顶点数断言写成恰好 24 | `mergeByMaterial` 会把单成员桶重排，增量不保证恰好 24（实测 36） | 断言增量 ≥24 + 用包围盒/材质色定位，别依赖单 mesh 的 `parameters` |
| 把几何常量改成函数（`const PATIO` → `const PATIO = () => ...`）时漏改一处下标用法（`PATIO[ia]`） | 不报错但渲染少构件（3D 阳台栏板消失）；`undefined[0]` 在 try/catch 里会静默吞掉，症状是「场景 mesh 数从 50+ 变 4」 | 改名后 `grep -n 'PATIO\|BAND\|PATCH\|ISL\|INNER'` 逐处改成调用；消费端在 `loadDoc()` 路径上被调用的函数还要做 **TDZ 安全**（`DOC` 尚未赋值时读 `DOC.plan` 会 `ReferenceError: Cannot access 'DOC' before initialization`，整个 IIFE 挂掉 → calib 底图不画 → 100% 像素差） |
| 逐字段比较「文档 vs 导出 JSON」时可选字段一边是 `undefined`（`JSON.stringify(undefined)` 返回 undefined 而非字符串） | 假红：导出补的 `floorOutline` 在文档里不存在，两边永远不等（S11 实测） | 比较前先按「该字段两边是否都有值」分支，或两边从同一个来源取（如都走 `floorPts()`） |
| `grid-area:ctx`（单个名字）当成「命名区域」用 | 没定义 `grid-template-areas` 时它指的是**名为 ctx 的栅格线**；找不到就退回自动摆放 → 四个控件组各占一列（并排），而不是叠在同一格。症状：改了 CSS 后工具条宽度完全没变（kidsSum 逐像素相同），极易误判成「规则没生效」 | 要把多个元素叠在同一格就写 `grid-area:1 / 1`（行 1 / 列 1）；改完用 `getBoundingClientRect().x` 逐个量一遍确认它们真的重叠 |
| 工具条末尾 `flex:1` 的状态/错误文字（`#wMsg`）在窄窗口被压成 9px 宽 | 控件先 shrink 到极限，剩下的空间为 0；`overflow:hidden`+`text-overflow:ellipsis` 把整句错误缩成一个点 —— **错误提示等于零反馈**（R10：零反馈的动作 = 设计缺陷），而它一直绿着没人发现 | 状态/错误文字不要和控件抢同一行 flex 空间：给它一个固定槽（画布左下角绝对定位 overlay，与 `#hint` 共用一个位），配 `#x:empty{display:none}` 让空态不占位；断言里加一条 `bar.scrollWidth <= bar.clientWidth`（溢出 = 末尾控件被剪掉） |
| 断言可见性读 `.style.visibility`（inline style） | 把可见性机制从 inline style 改成 CSS 类（`.on{visibility:visible}`）后，inline 是空串 → 断言 `===''==='visible'` 红，而页面其实是对的；另外 `getComputedStyle(el).visibility` 对 `display:none` 的元素仍返回 `'visible'`（那是计算值，不是渲染结果）—— 拿 visibility 判「看不看得见」会漏掉 display:none | 可见性断言一律走 `getComputedStyle()`（同时吃 inline、类、继承）；判隐藏用 `display`，判重叠用 `visibility`；`pointer-events:none` 的元素会被 `elementFromPoint` 跳过，遮挡探针不能拿它当「被盖住」的证据 |
| 新加的**数值输入**路径没抄既有**手势**路径的约束 | 「改这段」原先无长度下限，能造出 1cm 碎片墙（2D 看不见、3D 一根针、碰撞里是噪声），而画墙时 `applyDrawWallChain` 早就跳过 <0.05ft 的段 —— 同一个编辑器两条路给出不同合法集 | 给一个已有操作加输入口时，先把既有手势路径的夹取/下限/上限抄一遍（下限、`DOOR_MIN`、`STUB_MIN`、承载墙长度），并在提示里告诉用户这个口径从哪来 |
| **归一化「方向」时没跟着归一化法向偏移与沿线坐标**（`mergeCollinearBands`：dir 翻成 [0,π)，`offset`/`intervals` 原样） | 法向 = dir 旋转 90°，翻 dir 就是翻法向 → 中线坐标必须反号、沿线 `u` 必须取反并交换端点。同一条墙线被门洞切成两簇、两簇段方向相反时（真实 CAD 极常见）key 对不上（+0.394 vs −0.394）→ 不合并 → 沿线缺口不存在 → **导入户型丢门**（bug 猎 #6，6m 墙 + 0.9m 门洞：旧版 2 带 / 0 门） | 一个「框架」里的所有量要么一起翻、要么都不翻；合并前先归一到同一框架（`u → −u`、`off → −off`）。单簇输出保持逐字节不变，既有投影 oracle 才不受影响 |
| **y 翻转只翻点、不翻弧角**（`transform`：`(x,y)→(x,−y)` 后 `s/e` 原样保留） | φ 被映成 −φ 且扫掠方向反转，弧的像应是 `[−e, −s]`；消费端（`expand` / SVG `A`）会画出**镜像弧或补弧**。当前 `tf.arcs` 未被消费（v1 不导入弧墙）= 潜伏雷，将来收编弧墙时必炸 | 坐标变换必须同时变换所有派生量（角度、法线、绕序、UV 朝向）。整圆例外（取反会把 `e−s` 变成 −2π） |
| **管线静默丢弃输入**（DXF/PDF 的圆弧被扔掉，一声不响） | 用户只看到「墙少了一截」，不知道原因，也不会去补画；而测试把「无警告」当成了正确行为（qcad_example00 真实含 12 段弧） | 任何被丢弃的输入都要进 `info.warnings` 并说明判据与后果（「N 段圆弧未读入（v1 只读直线段）——曲线墙请用短段描出」） |

| **在「靠 private fixture 门控」的测试文件里用普通 `describe` 加新测试**（同文件已有 `const d = fx ? describe : describe.skip`） | 本地全绿、**CI 红**：新测试解引用 `legacy`（fixture 缺失时是 null）→ `Cannot read properties of null (reading 'sc')`（E19 实测：CI run 37596752776 三红）。`describe.skip` 只挡住 `it` 体，不挡写在它外面的代码 | 新测试优先**不依赖 private fixture**（自己合成一份小 LegacyGeo）——CI 也能跑，覆盖面反而变大；确实需要真实几何的才放进 `d(...)`。本地验 CI 行为：`git archive HEAD \| tar -x -C /tmp/ci-sim` + 软链 node_modules + 在那里跑 vitest（无 private/ = CI 环境） |
| **实体 id 前缀有两个生产者，查找器只认一个**（导入管线给实心块用 `'p01'`（沿用 legacy FIXED 的柱 id），`nextId(DOC,'solid')` 用 `'s01'`，而 `entById` 只映射 `w/n/d/s`） | `entById('p01')` 返回 null ⇒ 导入实体在编辑层「不存在」：`srcU()` 把它判成内置结构（拒删）、hover 不亮、`deleteSel` 从「移除」变成「隐藏」、`entById(f._id).column` 读不到 → **3D 也不立实体**（bug 猎 #9）。症状分散在四个不相干的入口，很难联想到一起 | 加新 id 前缀时 grep 一遍查找器；或者一律走 `SCHEMA.Project.nextId(doc, kind)`（单一来源）。查 id 的函数要按「类别 → 数组」映射，别把前缀当唯一事实 |
| **消费端拿渲染属性当结构判据**（3D 结构块 / 2D 命中区都写成 `fill ∈ {#0c0d0f,#15171a}`） | 那是**内置户型**的填充色常量；导入管线的实心块填充色是 `#8a919c` → 导入的柱子 2D 画了、3D 没有、而且点不中（探针：层高高度水平射线命中 16.35ft 的远处墙而不是 1.00ft 的柱）。换个户型就丢构件，与「外置几何时漏掉户型专属构件」同一类病 | 判据要落在**文档字段**（`column` / `src` / `_src`），颜色只是渲染属性。写 `fill===` 前先问「另一个来源生成的同类实体也是这个颜色吗」 |
| **用「包围盒覆盖」做 3D 存在性断言** | `mergeByMaterial` 把同材质 mesh 合并成一个桶，桶包围盒覆盖全图 → 任何室内点都被「覆盖」，断言永远绿；反过来，探针里 `half` 取得比被测件本身还大 → 永远不覆盖，假红 | 3D 存在性用**射线**（在接近层高的高度打水平射线，柱必须挡光）或**按材质桶的顶点增量**；两者都与合并无关、也与户型无关 |
| **`validate` 只验「geom 是个对象」，不验它内部字段** | 缺 `x2` / NaN 坐标 / `dir` 非法 / `poly.pts` 里混入 `{x,y}` 对象，都能过闸门；而 `expand()` 碰到它们产出 NaN → **构件在 2D/3D 里消失而且不报错**（与「arc 实心块投影成空 poly」同一症状家族）。用户只看到「图上少了个东西」 | 形状检查单独一个函数（`checkGeoms`），只挂在**导入闸门**（`applyImportedDoc`，四条导入路径都走它）；不挂 `loadDoc` 的 `usable()`——把已有存档判坏等于 `removeItem` 删用户数据。验数值一律用 `Number.isFinite`（`typeof === 'number'` 让 NaN 过关） |
| **整体滑动门的夹取只取一端的下界 + 另一端的上界** | 门整体滑动 = 两端**同时**位移 dd，dd 必须同时落在两个端的允许范围里（交集）。只取 `range(0)[0]` 与 `range(1)[1]` 在常见拓扑下恰好等价（门的 carrier 洞让一端往前无约束、另一端往后无约束），所以**永远不会暴露**；一旦一根垛同时贴到门两端（导入户型里墙线跨过门符号、或拖动墙端叠到门上）键盘就能把墙垛压到 `STUB_MIN` 以下而鼠标拖动不会 —— **同一动作两条路径不一致** | 夹取取交集：`max(max(r0[0],r1[0]), min(min(r0[1],r1[1]), dd))`（鼠标路径本来就是这个）。判定这类「等价但不对称」的怀疑靠探针：两份户型逐门量两种夹取的最大差异（实测 0.000ft） |
| **把宿主方法取下来裸调**（`const open = indexedDB.open; open(name, ver)`） | 浏览器宿主方法要求接收者：丢 `this` 当场 `TypeError: Can only call IDBFactory.open on an IDBFactory`，被外层 `catch` 接住后**静默退回回退路径**（实测：门面报 `backend=localStorage` 且无任何报错，查不到原因）。诱导因素：TS 的属性收窄在闭包里失效（`if (typeof factory.open==='function')` 在 `new Promise(...)` 里不算了），于是人把方法拷到局部变量 | 绑接收者：`factory.open.bind(factory)`（既满足类型又保住 `this`）。给这类「宿主 API + 闭包」代码写回归测试时，假对象要把方法放在**原型上并用 `this`**（普通对象字面量测不出这个坑） |
| **测试台里 `await` 真实 I/O**（IndexedDB / 网络） | 测试台跑在 `--virtual-time-budget` 下，而 IDB 回调是真实 I/O：虚拟时间跑完时它可能还没到 → 整个测试台出不来。特征是非单调：**budget 100000 无输出、140000 全绿、200000 又无输出**，看着像「页面随机挂」 | 不 await：只触发、按**轮询次数**等结果（virtual time 冻结 `performance.now()`/`Date.now()`，时间判据不可用 —— 与 §5.5 fence 兜底同一条）。读不到就如实报 NA，不谎称验过 |
| **headless Chrome 用默认 profile** | 两个独立代价：（a）上一轮的 localStorage / IndexedDB 被带进下一轮 → 本地跑与 CI（干净容器）不同口径，同一页面两种 profile 下断言结果不同；（b）被 kill 的 Chrome 在默认 profile 里留下 `SingletonLock`，后续 headless 跑在 0% CPU 上挂死 —— 症状与「alert() 阻塞」一模一样，极易误判成页面 bug（本轮实际浪费一轮：t_3d_dist 看着挂了，其实 DOM 已 dump 出来 120/120 全绿，只是进程退不出去） | `run-bench.mjs` 每个 bench 一个临时 `--user-data-dir`（跑前删、跑后删）。杀 Chrome 只用精确匹配 `pkill -f 'Google Chrome.app.*--headless'` |

| **规范类常量表凭记忆写**（DXF `$INSUNITS` 码表错位一格：写成 `1=mm 2=cm 3=m 4=in`，规范实际是 `1=Inches 2=Feet 3=Miles 4=Millimeters 5=Centimeters 6=Meters 19=Yards`） | AutoCAD/Fusion 导出的 mm 图纸（`$INSUNITS=4`）被读成**英寸** → 25.4× 尺度错 → 240mm 墙厚变 6.1m → 整个户型「未检出墙体」；更糟的是 **fixture 按错误实现生成**（`apartment-mm.dxf` 写 1、集成测试断言 4=英寸），bug 被固化成「测试全绿」 | 规范/协议类映射表**当场核对来源**（Autodesk DXF Reference / ezdxf），不要凭记忆；修这类 bug 必须同时**重新生成 fixture 与集成期望**（否则测试还在守旧值）。顺带：真实 fixture 的单位改了，期望值要按事实重算（hack_canada=米、libredwg/qcad_example00=毫米，房间数/量级警告跟着变） |
| **headful Chrome 用独立 profile 却不压首启流程** | Chrome 弹「登录 Chrome」对话框卡住：页面根本不加载、SLO 一个 POST 都收不到、7 分钟超时，症状像「脚本写错了」 | headful 必须 `--no-first-run --no-default-browser-check --disable-sync --disable-features=SigninPromo,DesktopFirstRun` + 独立 `--user-data-dir`（不给独立 dir 则 URL 被交给已在运行的 Chrome、子进程立刻退出，同样收不到 POST） |
| **headful 测量还带着 `--use-angle=swiftshader`** | 测的是软件光栅化而不是用户显卡：进 3D 首帧 11.1s vs 真显卡 1.07s、拖拽 14fps vs 120fps。用它下「启动超标 / 帧率不够」的结论完全是假的 | headless（CI、可复现）才加 swiftshader；headful 一律用真显卡。CI 口径因此是**回归门禁**（抓 5× 级劣化），用户侧绝对值只能本地 headful 验 |
| **生成大 fixture 时在循环里 `arr.join('\n').length` 判体积** | 每轮重新 join 整个数组 = O(n²)，10MB 生成跑到超时（400s 没结束） | 增量字节计数（push 时累加长度）；生成脚本也要 `time` 一下看数量级 |
| **墙段短于 `MIN_WALL_LEN`(0.3m) 不参与墙带配对**（管线阈值，不是 bug） | 描摹/打印导出类图纸把一段墙拆成几十个小段 → 全部被过滤 → 「未检出墙体」（有警告，不静默，但用户不知道为什么） | 已知局限，写进 SLO fixture 的注释；将来要做的是**共线相接段的预归并**（在 `detectBands` 之前），记在 roadmap 待办，别在 SLO 工作里顺手改 |
| **单位标称表手拄**（`UNIT_NOMINAL.pt` 写 68.03，实际 240mm = **680.3**pt） | 手拄表与主换算表（`UNIT_TO_M`）不同步，错的偏偏是「看起来最正常」那一格：点制图纸读不成 pt → 退回 mm 启发式 → **整套户型放大 10 倍**（240mm 墙变 680mm），而 calib/2D 截图看着都「像对的」 | 派生，不要手拄：`0.24 / UNIT_TO_M[u]`。任何「一张表描述另一张表的同一批量」的地方都是重复事实，迟早漂移（同 §1.2 两个版本号不能混用） |
| **阈值写在错误的单位空间**（`if (maxOff < 0.1) return null;` 而 `maxOff` 是 ft） | 意图是 10cm，裸 `0.1` 在 ft 空间 = 3.05cm → 图纸里的细线/符号轮廓被认成台面柜体带（图上凭空多出柜体） | 阈值一律写成「意图单位 × 换算」（`0.1 * M_TO_FT`）并在注释写死意图；对照消费端的量纲（`polyBboxM` 返回米、`f2` 是英尺） |
| **「每个带一个 id」的数组，而后写覆盖先写**（`bandWallId[bi] = id` 在 `for (const iv of intervals)` 里） | 一条墙带被门缝切成两段时只留下最后一个 id → 落在第一段上的门/窗被指到第二段墙：编辑器选窗高亮错墙、门垛联动错墙，且**两份户型都不报错** | 一个带多个区间就要 带×区间 的 id 矩阵；按「点落在哪个区间」取，都不含时取最近区间。写完自问「这个数组的下标语义是什么」 |
| **用 `request.result` 判 IDB 请求成败**（`delete()` 的 result 本来就是 `undefined`） | 删除失败也返回 true → 门面以为删掉了（缓存/镜像/主存三处状态与真实主存不一致），降级标记也不立。写路径恰好能用 result（put 返回 key），所以**只有删路径暴露** | 判成败只看 `onsuccess` / `onerror` 哪个 fired（`reqDone()`），与 result 无关。别把「写路径能用的判据」顺手搬到读/删路径 |
| **DXF 圆弧的 `e` 没写回修正后的扫角**（`sweep += 2π` 只用于判 full，`e` 留原始值） | 跨 0°/360° 接缝的弧（`endAngle < startAngle`）与负 bulge 弧，下游 `expand`/SVG `A` 算出**负扫角** → 画出补弧：用户看到「墙多出一大截」。修了 sweep 却不写回 e，等于白修 | 产弧的两条路径（ARC / bulge）都过同一个 `normArc`；扫角为负 = 同一段弧反向走 = 点集不变 → 交换 s/e 即保真。变换（y 翻转）还要 `(−e,−s)`（§5.1 框架归一化要整套翻） |
| **实物是圆的，碰撞检测与 2D 图例却按方盒算**（`obbCorners` 的 round 名单漏了 `trampoline`） | 方盒角比内切圆外凸 `(√2−1)·r ≈ 41%` 半径：圆蹦床(⌀221.6cm) 与凳子斜 45° 摆，中心距 4.950ft > 半径和 4.373ft（物理不接触）却报 `obbOverlap=true` → 界面凭空描红「重叠」；同一处形状不一致还体现在平面图把 7 英尺圆蹦床画成方块 | **形状口径必须三处一致**：`obbCorners` 的 round 名单（碰撞）、`furnShape` 的图例分支（2D）、模型本身（3D）。加新 kind 时若 `w===d` 且实物是圆的，三处都要问一遍 | | **同品类两个 kind 的 2D 图例不一致**（`bedMetal` 落到通用矩形，`bed` 有床垫/枕头/被子四段） | 「加新 kind 要管三处」（furnMats / furnShape / vSpan）只保证**有**分支，不保证**与同类读法一致**；铁架床条目本身就是「架 + 床垫」，读起来却不是床 | 加 kind 时多问一句：目录里有没有语义同类的 kind？它的图例长什么样？（`catalog-legend-bedmetal` 就是拿图元数比出来的） | | **用静态正则数 `furnShape` 的 kind 分支** | 静态抽取假报：`furnShape` 是 `if(kind===…)` 长链 + 数组 `includes` + `isLight()` 分组，正则漏判 → 报告「34 个 kind 没有图例」，实际只有 3 个 | **目录不变量要运行时量**：`furnShape(item, spec).querySelectorAll('*').length` 与「通用回退基线」（同一 spec 换成不存在的 kind）比，差值 =0 就是回退（`bench/t_3d.js` 的目录不变量段） |
| **目录数据模型里定义的字段没有任何消费端**（`caVar` 出现在 9 个条目里，`grep -n caVar app.html` 只有数据行） | §5.4.1 写明「caVar = 加拿大有标价，但那是同型号的另一个面料/配置，界面上给提示」——提示从来没实现：加元视图把 KIVIK 深灰的「另一配置价」CA$849 当成这件的实价显示，既无 ≈（它确实是货架实价）也无任何说明 | **写完数据字段必须 grep 一遍消费端**（`grep -n "字段名" app.html` 里除了数据行以外有没有读到它）；`priceOf` 现在返回 `{v, exact, variant}`，`*` 号在出现的地方就地解释（合计尾部 `N 件带 * = 加拿大在售的是另一配置`） |
| **黄金截图态里「异步渲染的东西」没等它渲完**（目录缩略图走 IntersectionObserver 排队 + 每帧 16ms 分批） | CI 双截 `2d-sel` 差 10.691%（同一份代码下一个提交全绿 = 不是回归，是截图态不确定）。逐区像素定位是关键：左面板 45.16% / 画布 0.00% / 右面板 0.00% / 顶栏 0.00%，且位移搜索最佳解是 dx=dy=0 → 不是 viewBox 位移（那类是 18~53% 全图平移），而是「一边缩略图渲完了、一边还没渲」。IO 回调时机 + `--virtual-time-budget` 冻结 `performance.now()`（分批循环实际渲多少件随之不定） | `#ui:*` 截图态一律**同步渲**（`observeThumbs` 里按 `getBoundingClientRect()` 只渲有尺寸的卡片）；普通交互路径保持 IO + 分批。**门禁红了先做逐区差异 + 位移搜索定性，再决定是修代码还是修门禁** |
| **黄金基线里藏着「没渲完的占位块」**（改同步渲后 2d/2d-sel/ft 差 9.846%，其余五态不变） | 原先 mine 基线的目录格子是纯色占位块 → 这条门禁从来没有覆盖过缩略图，而它正是最容易被光照/取景/缓存改坏的东西 | 重拍基线是显式动作（`ui:gate:update` + 提交信息说明变化）；**重拍后要问「新基线比旧的多覆盖了什么」**，并目检新基线里该出现的东西真的出现了 |
| **覆盖率棘轮的阈值按本地数字定，而本地有 `private/fixtures/`** | 本地 96.68% 的 `migrate.ts`，CI 只有 77.48%：它的无损对照测试要真实 `eff*` 输出（private fixture）→ CI 里整段跳过。结果 CI 覆盖率红，而**红的是「用户存档会不会丢」那条路的覆盖只存在于有私人数据的机器上** | 定阈值前先跑 CI 口径（`git archive HEAD \| tar -x` + 无 `private/`）；**门控测试覆盖的分支必须有合成数据的非门控版本**（`tests/schema/migrate-synthetic.test.ts` 就是这么补的：通用形状合成存档把 墙/窗/门洞/通道/覆盖/隐藏/洁具/patio/损坏存档 跑全，77.48%→95.36%） |
| **改了 `src/**` 但没 commit，而 `app.html` 的内嵌块已经带上新代码** | HEAD 里内嵌 geo/schema/storage 块 ≠ 已提交源码的新鲜编译 → **干净检出跑 `npm run build` 直接红**（CI 红，本地全绿，因为本地工作区是完整的）。更糟：bug 猎的修复只在工作区，commit 里找不到 | 提交前 `git status` 核对 `src/**` 与 `app.html` 是否同批；验收口径加一条：`git archive HEAD \| tar -x` 到临时目录 + 软链 node_modules + 跑 `geo:build`/`schema:build`/`storage:build`/`build.mjs` + `vitest run`（这就是 CI 环境） |
| **CDP `Runtime.evaluate` 的 `returnByValue` 对不可序列化对象返回 `undefined`**（等待条件写成 `three && three.scene`） | 探针里 `three.scene` 明明存在（210 个 mesh），`waitFor` 却永远等不到 → 报「3D 场景就绪超时」。`returnByValue` 只能带回可 JSON 化的值，THREE.Scene 带循环引用 → `result.value` 缺失 → 判成 false | 等待条件一律包一层 `Boolean(expr)`（`(()=>{try{return Boolean(expr)}catch(e){return false}})()`）。要读对象就在表达式里自己转成数字/布尔（`Object.keys(three).length`、`(()=>{let n=0;…;return n})()`） |
| **E2E 流程之间不清存档**（同一个 profile 连着跑 14 条流程） | 上一个 flow 导入的户型 / 放的家具漏进下一个 flow：`dxf-restore-walls` 的「起点墙段数」读到 66 而不是 72，断言怎么改都红；跨次运行也不确定（profile 复用） | 每条流程开头 `localStorage.clear()` + `indexedDB.deleteDatabase('miniden-planner')` 再 `Page.reload`（`t.freshState()`）。**任何「与起点比较」的断言，起点必须是干净起点** |
| **`state.view` 立刻变，3D 状态不是**（`setView` 把 `init3D/buildStatic3D/sync3D/setCamMode` 放在 `setTimeout(…, 40)` 里派发） | 断言 `state.view==='fp'` 通过后马上读 `three.cam.position.y`，读到的是娃娃屋的 42ft → 报「眼高不对」，其实页面还在切场景 | 断言 3D 状态要等**那个状态本身**（`three.camMode==='fp'`、场景 mesh 数 >20），不要等 `state.view`；读场景用带重试的 `evalRetry`（场景重建期间 `three` 会短暂为 null） |
| **同一屏上两处文字用不同单位**（切英尺后房间标注是 `13' 2"`，目录卡片还是 `137 cm`） | 用户以为单位切换「只影响了一半界面」。根因：`build2D()` 重画了标注，目录卡片是 `buildCatalog()` 时按 `fmtLen(state.unit)` 生成的，不重建就停在旧单位 | 改「显示口径」时要枚举**所有渲染该口径的地方**（平面图、目录卡片、检视面板、工具条），逐个确认都重建；黄金态 `#ui:ft` 同步加 `buildCatalog()`，让黄金态与「用户真的点了按钮」同形 |
| **黄金基线把一个 bug 拍了进去**（`#ui:ft` 旧基线里目录卡片是 cm） | 修好之后 ui-gate 差 0.188%（在阈值内，但**不是 0**）——如果只看「PASS」就会漏掉「基线本身是错的」这件事 | 基线 diff 不为 0 时先**裁同一区域新旧各一张目检**，确认变化正是意图（这次是 `209 cm×211 cm` → `6' 10"×6' 11"`），再显式 `ui:gate:update` 重拍并在提交信息里写清变化 |
| **`entById(id)` 返回的是文档实体本身，不是快照**，而 bench 拿它做「改前 / 改后」对比 | `const b = entById(id); …改…; const a = entById(id);` 里 `a === b`（同一个对象）→ `a.geom.x2 - b.geom.x2` 恒等于 0 → 「方向键把激活端推了 1cm」这类断言永远读到 0 位移，**怎么修都红、怎么坏也不绿**（假断言） | 前后对比必须先把几何取成**数字**（`const x0 = e.geom.x2` 或 `snap()` 返一个半新对象）。同理 `effDoors()` 返的是每次新建的投影副本（可当快照），两套语义别混用 |
| **工具模式的 pointerdown 早退分支让「拖拽」在工具下不可用**（`wallEdit.tool==='door'` 点已有门 = 选中后 `return`） | bench 在 door 工具下拖门体→ 完全不动，看上去像拖动逻辑坏了。实际拖移动只在 `select` 工具下成立（而 `.dEnd` 手柄在 door 工具下能拖，因为手柄检测在工具分支之前） | 写点击/拖动类断言前先读命中分支的**早退顺序**（手柄检测 → 工具分支 → 放置）；需要拖实体就 `setTool('select')` |
| **Raycaster 从封闭体内部往外打，只会打到背面 → 被 `material.side` 剔** | 验证「柱在 3D 里立到顶」：从柱内 (0,1,0) 向上打 → 先撞天花板底面（FrontSide 法线朝下 = 背面）→ 被剔后继续 → 又撞柱底面背面 → 报「无命中」，看着像柱没建 | 验竖直构件从**天花板上方**往下打（`CEIL_H + 1.5`, dir `(0,-1,0)`）：天花板底面是背面被剔 → 射线穿过 → 第一个命中就是柱/门洞过梁顶面（法线 +y） |
| **基线顶点数在变异之后才取**（3D 重建是异步的） | `setView('3d')` 里 `buildStatic3D()` 已把新柱烘进去，再取 `vBefore` 就与 `vAfter` 相等 → 「顶点增量」断言永远红 | 基线必须在**变异之前**采（或先切 3D 采基线 → 切回 2D 变异 → 再切 3D 采对比）；存在性用射线命中作主断言，顶点数只作旁证（§5.1 bbox 覆盖不可靠） |
| **把「合法夹取」当成 bug 断言**（内置门的 1cm 方向键微调常被 `STUB_MIN` 夹住） | 新门垛长 1cm < STUB_MIN=5.5cm → `range()` 把位移夹到 0，这是**设计行为**（不让用户用键盘压出比阈值更薄的门垛）。断言「一定能动 1cm」在两份户型上都红 | 先量「能不能动」（INFO 如实报），再断不变量：位移不得超过一步、门不得短于 `DOOR_MIN`、门垛不得为负。**要验逐厘米精度，就造一个无约束的对象**（用户开口 + 用户门），而不是在受约束的内置件上硬断 |
| **存储 API 自己矛盾：守卫拒删「当前」，调用方删的正是「当前」**（`removePlan` 写了 `if(reg.active===id) return null`，`deleteCurrentPlan` 传的正是 `PLAN_ID`） | 删除功能永远删不掉，而且不报错（`null` 被当成「用户取消」），界面只弹一句误导的提示 | 写守卫前先问「谁会、以什么状态调它」；「当前 X」这类语义要拆开：内置不可删 / 最后一份不可删 / 删当前时 active 自动转移到内置 —— 三条是不同的规则，不能合成一条「不能删自己」 |
| **多户型下还用 `resetDoc()+saveGeo()` 当「回到内置」** | 它把内置几何写进**当前（导入的）户型的键**，把刚导入 / 刚重标定的那份抹掉；而且 `PLAN_ID` 还停在导入户型上，后面每一节断言都跑在那份户型上（症状：注册表莫名多出户型、断言的基线墙数对不上） | 回到内置走 `switchPlan(BUILTIN_PLAN_ID)`（真实 UI 路径）；bench 里凡是「换了户型」的节，结尾都要显式切回去 |
| **bench 用临时 `run()` 助手而不是 `scripts/run-bench.mjs`** | 临时助手不带 `--user-data-dir` → 用默认 profile → 上一轮的 localStorage / IndexedDB 带进来。E26 实例：注册表里攒着上一轮建的空白户型，bench 从一份「上一轮留下的户型」开始跑，断言只是在测上一轮的垃圾（症状：`plans=3`、`active=p…`），看起来像新功能坏了 | 跑 bench 一律 `node scripts/run-bench.mjs`（每个 bench 一个临时 profile，跑前删跑后删）；多状态功能要在 bench 开头加一条「起点态」断言（`pb-plan-starts-builtin`），起点不对就先红给你看 |
| **量一个 `display:none` 容器的 `scrollWidth/clientWidth`** | 两者都是 0 → `0 <= 0+1` 永远绿，断言绿得毫无意义（工具条溢出门禁等于没有） | 断言溢出前先把它展开（`setProTools(true)` / 真实点开），再量 |
| **E2E 流程（Node 侧）直接写页面里的名字**（`pickPlan(BUILTIN_PLAN_ID)`） | `BUILTIN_PLAN_ID` 是页面里的名字，Node 侧 ReferenceError → 整条流程异常中止（症状：前面半条流程全绿，突然 FAIL flow） | 页面常量先 `await t.eval('BUILTIN_PLAN_ID')` 取回本地变量再用；写进 `t.eval`/`t.waitFor` 的字符串里才可以直接引用 |
| **E2E 无条件点「工具 ⌄」** | `#btnMore` 是个开关：上一轮流程留着展开时，这一点的动作是「关掉它」，后面点 `#planSel` 就点不到（跨流程粘滞，单跑一条时又总是好的） | 展开第二层写成 `ensurePro()`：先读 `getComputedStyle(...).display`，只在关着的时候点 |
| **编辑模式下读 `#hint`** | E24 起 `body.wedit #hint{display:none}`（画布左下角那个固定槽让位给编辑提示 `#wMsg`）→ 断言读到空串，看着像「提示没出来」 | 读提示前先确认当前模式该读哪个元素：自由态 `#hint`、编辑态 `#wMsg`；bench 里那条断言已经同时读两个（`display` 一个 none 一个有尺寸） |
| **所有测试都跑在内置户型上**（打开就有一整套房：23 墙 / 4 门 / 洁具） | 「没有图纸的人从空白画布开始」这条产品承诺从来没有被真实输入测过：画完一圈墙后地板轮廓会不会跟着走、门能不能上到画的开口上、镜子能不能贴到画的墙上、画的墙在 3D 里会不会立起来——全都没断言（E27） | 测试顺序要跟着产品顺序走（户型构建 → 洁具 → 家具），并且**必须有一条真的从真空开始的流程**（空白户型 → 画 → 装 → 3D → 真刷新后还在）；只测「已有房子的局部编辑」不等于测了这款产品 |
| **吸附类断言对着「我以为的那面墙」量，而且期望值的坐标系写错**（`(9/SC + 0.3)/2` 把 9 **cm** 当图纸 px） | 断言红，看着像「贴墙契约错了」，其实是断言自己错了：实测 rot=90 完全对，期望值 0.552ft 算自一个不存在的 0.8ft 墙厚 | 吸附类断言先找**实际吸附到的那个对象**（遍历候选取最近），再从那个对象的字段里取墙厚 / 偏移；写期望值时逐个参数问「这个数的单位到底是什么」（§5.1 cm/ft/图纸px 那几行的同一个坑） |
| **`getComputedStyle(子元素).display` 不继承父级的 `display:none`** | 用子元素判「容器已展开」永远为真 → `ensureProTools()` 认为已经开着、不去点开关，后面每个点击都打在隐藏控件上（症状：单跑一条流程时时好时坏，跟上一轮留的状态有关） | 判展开必须读**真正被 `display:none` 的那个容器**（`#proTools`）；要判一个控件看不看得见，用几何探针（rect 在视口 + `elementFromPoint` 命中它）而不是它的 computed display |
| **非法枚举值写进文档**（`pushUserFixture` 以前用 `FX_DEFS[type] || FX_DEFS.counter` 兼容尺寸，却把非法 `t` 原样写进 `DOC.fixtures`） | `SCHEMA.Project.validate` 失败 → `loadDoc` 的 `usable()` 为假 → **`STORE.remove(DOC_KEY)` + 回退空文档**：整栋房子在下次打开时静消失。这个状态界面上到不了（`#fxType` 选项是静态的），但爆炸半径是全部用户数据 | 爆炸半径大的字段要在**单一生产者处**就挡住并给反馈（而不是在下游兼容）；下游的「兼容默认值」只能兼容尺寸这类可重算的量，不能替非法枚举值背书。验它的断言要直说「戳的是 UI 到不了的状态，验的是爆炸半径而不是可达性」 |
| **把 `pushUndo()` 从变异前挪到变异后**（为了「失败时不消耗一步撤销」） | 快照环存的是**变异前**的状态；挪到后面就是把「已经改完的状态」存进撤销栈，撤销等于没做任何事（不报错，只是退不动） | 快照型撤销的 push 永远在变异之前；要避开无效撤销步，就把校验放在 push **之前**（先拒非法输入，再 push，再变异） |
| **断言照抄实现里的公式**（贴墙契约写成 `expectOff = (docE.thick ?? (s.wd||6.5)/SC)/2 + d/2`，与 `fixtureWallSnap` 里一模一样） | 断言只能证明**代码自洽**，永远抓不到「代码与现实不符」：bug 猎 #20 就藏在这里——吸附用真实墙厚（0.788ft）而 2D/3D 画的是默认 9cm，洁具离**画出来的**墙面 15cm，而 bench 全绿 | 契约类断言必须**独立测量现实**：`bench/t_planbuild.js` 的 `pbDrawnThick()` 从 `wallPolys()` 的多边形里找与目标墙方向对齐（`|dot(u, 边方向)| > 0.9`）且重心落在段上的那块，量它的法向张度 = 屏幕上真的画了多厚（与 2D 填充 / 3D 挤出用的是同一份几何） |
| **同一个编辑器里两套长度口径**（legacy 投影的 `wd` 被 `wallPolys` 除以 `S = 22`（viewBox px/ft），而 `fixtureWallSnap` / `_segProxy` / `pushUserWall` / `rescaleDocPlan` 拿 `SC = 11.2`（图纸 px/ft）换算） | 内置户型看不出来（它没有 `wd`，一律走 6.5px 默认）：导入户型的真实墙厚被读成不到一半，而投影干脆不出 `wd`（导入文档没有 `sc`）→ 2D/3D 全画成默认 9cm，而吸附按真实厚算 → 洁具浮在墙外 15cm | `wd` 只有一个消费单位 = viewBox px（`S`）：投影 `wd = wdPx ?? thick*S`、代理 `thick = wdPx/S`、吸附半厚 `= (s.wd ?? 6.5)/S`。新写任何 `wd`↔`thick` 换算先 grep 一遗 `SC` 与 `S`，问「这个量最终被谁除」 |
| **硬编码的「默认落点」只对内置户型成立**（第一人称 `three.fpPos || new THREE.Vector3(22, EYE_H, 27)`） | 用户自己画的 / 导入的户型里 (22,27)ft 在户型外面：点「室内」先看见自家外墙背面（光追也是），而 bench 只验眼高不验落点 → 全绿 | 自包含户型的默认站内点从几何算（`fpHomePos()`：地板轮廓内「离所有墙最远」的格点；`fpLookOut()`：24 方向射线取未被挡住最长的那个）。内置户型保留历史锚点（calib / 黄金基线 / 已有第一人称测试全不动）；落点类断言要断「在户型内」（`pb-zero-fp-inside-plan`）而不只断高度 |
| **临时 bench 探针自己定窗口尺寸**（手写的 `--window-size=1400,950` 跑 `work/t_planbuild.html`） | 面板布局随窗口宽度变 → 检视面板里控件的位置与可见性变 → `pb-fx-rot-input`、`pb-fx-arrow-nudge-1cm` 假红（同一页面在 `run-bench.mjs` 的 1700x1100 下全绿） | 跑 bench 页面一律用 `scripts/run-bench.mjs`（它带 `--user-data-dir` 与各自的 budget / 窗口）；要手跑就拄它的参数，不要临时拍一个 |
| **「变换整个户型」的操作只枚举了一种载体**（`rescaleDocPlan` 只摸 `DOC.*` 实体） | 家具不在 ProjectDoc 里（它走 `planner_v1:<id>` 另一条存档）→ 整图缩放 ×2 后家具留在旧坐标：跑到墙外 / 房间错位（bug 猎 #22）。写的时候很自然——「缩放户型 = 缩放文档」，而用户看到的画面里家具也是户型的一部分 | 任何「整图变换」先列载体清单：文档实体、**文档外的存档**（家具 `state.items`）、底图、注册表。家具与洁具同一条规则：位置按同一个中心缩放，真实尺寸（w/d）与 rot 不动 |
| **缩放了线段几何，没缩放描述这段几何的字段**（`d.geom`/`d.gapGeom` 缩放了，`d.width` 没动；窗的 `width` 缩放了而 `thick`/`wdPx` 没动） | 门的声明值只有实际开口的一半（`width=2.953` vs 开口 `5.910`ft）→ 导出/导入读 `width` 就读到一半（bug 猎 #23）；窗比它所在的墙薄一大截（墙 1.570ft、窗 0.656ft）→ 2D/3D 里窗陷进墙里（#24）。同一节代码里窗的 `width` 缩放了、门没缩——这类「同一家族少一个字段」很难靠眼睛找 | 写变换时把 schema 里**携带尺寸语义的字段**逐条过一遍（`width` / `thick` / `wdPx` / `pos` / `modules[].at`），问「它是坐标、还是对坐标的描述」；断言用**两条不同的路交叉**（墙厚从 `wallPolys()` 多边形量、窗厚从投影 `wd` 量），只靠一条就是照抄实现 |
| **拿变换之前的对象去量变换之后**（`iw = effWalls()[…]` 在缩放前拓，缩放后还用 `iw` 算厚度） | `pbDrawnThick(iw)` 在旧坐标上找不列多边形 → `NaN` → 断言读成 `?`（假红，看起来像「测量函数坏了」） | 前后对比必须各自现取（`effWalls().find(q=>q._id===id)`），或者在变换前就先把「前」的量算完存下来 |
| **同一个值两个消费端，一个有一个没有**（`panorama()` 对 `three.preset` 查了表，`applyLightMode()` 的室内分支直接 `ENV_TINT[three.preset].day`） | 预设名一旦陌生（旧存档 / 手改过的导入 JSON / 将来重命名预设），点「室内」当场 `TypeError: Cannot read properties of undefined (reading 'day')`，顶栏后续按钮全失灵（#25） | 清洗放在**文档入口**（`loadDoc` 三条 return 路径 + `applyImportedDoc` 都过 `cleanDocEnv`），消费端再各自兜底一层；新写一个读 `DOC.env` 的函数时先 grep 同字段的其他读法，问「它们兜底一致吗」 |
| **存档字段只验类型不验取值**（`validate` 对 `env.preset` 只要求「是个字符串」） | 导入一份手改过的导出 JSON 就能把陌生预设名带进运行时（与 #5 非法洁具类型、#10 geom 内部字段同一个家族） | 枚举类字段在入口洗成合法值（查表），而不是把 `validate` 改严（判坏存档 = `loadDoc` 删用户数据，见上面那行） |
| **累积式渲染进行中还能改场景**（光追/照片级渲染跑的是样本均值，顶栏「城市/郊野/山林…」与「白天/夜晚」在跑的时候照样能点） | 跑到一半换环境 = 出图里混两种光照（谁都不是），而界面不会告诉你（#26） | 入口直接拒收（`if(three.photo){ photoBusy(什么); return; }` 盖住 `setPreset`/`setDayNight`/`setLights`）+ toast 说清怎么办（先点「取消」）；**不用 `confirm()`**（headless 会挂，§5.1）。新加任何「重算场景」的入口都要问一句「光追在跑时它该不该接」 |
| **注释声称的行为没实现**（`setPreset` 注释写「全景 + 环境色温 + 雾色一起换」，而雾色在 `applyLightMode` 里是硬编码 0xb9cfe2/0x0b1018） | 读注释的人会在错的假设上改代码（bug 猎探针实测：换预设时雾色不动） | 注释改成实话，并写清**为什么雾色不用跟预设**（雾的近/远界 130/430ft，室内几何进不了雾区，背景全景也不受雾影响）——要真改雾色就是重拍黄金基线的显式动作（§3） |
| **断言量了一个分不开两种结局的量**（拿 `onDone` 被调用当「跑完了」，而 `finish(true)`（取消）也调 `onDone`） | 断言永远红（看起来像「取消没生效」，其实取消真的生效了） | 量真正区分两者的量：`__PT_DIAG.spp < __PT_DIAG.want`（实测停在 0/400 spp）才能证明「真的提前停下」，见 §5.5 |
| **回退只有一种形状**（`loadDoc()` 读不到存档时一律 `freshDoc()` = 内置公寓，不管当前是哪份户型） | 自包含户型（空白 / 导入）的存档读不动时，用户看到别人家的房子，而 `switchPlan` 末尾的 `saveGeo()` 把这套公寓写进那份户型的键（原存档还被 `STORE.remove` 删了）——不可逆数据丢失（#27） | 回退必须按户型形状分派（自包含→`blankDoc`，内置→`freshDoc`）；读不动的存档**保留不删** + 告知用户出路；「属于内置户型」的旧存档（旧单桶 / 旧覆盖层）不得被别的户型认领 |
| **把「同步读不到」当成「不存在」**（异步主存里可能存着值：LS 被清过 / 超过镜像上限 / 配额满） | 切户型时 `warm()` 不 await → 回退出来的文档被写回主存 → 用户那份被盖掉；而且这个写动作让门面的 `touched` 生效 → hydrate 被跳过 → **再也回不来**（#28，实测 1.7MB → 5.2KB） | 区分「存档不存在」与「存档还在读」（门面 `warming(keys)`）；处于「还在读」时不许写，warm 完成后解除并重新载入 |
| **把写入闸门绑在一个可能永远不完成的异步上**（「warming 就挡住所有写」） | 虚拟时间下真实 I/O 比虚拟时钟慢很多 → warm 还没完成而断言已跑 → 用户改动永远存不进去（实测三处 bench 红：`s11-persisted` / `pb-plan-blank-preserved` / `pb-zero-from-scratch-survives`） | 闸门只在「危险真的存在」时生效（主存真的是 IndexedDB；主存就是 localStorage 时 `get()` 直读那份存放，读不到 = 真的没有）；并给一个解除路径（warm 完成后重新载入），不靠时间超时（虚拟时间冻结 `performance.now()`） |
| **拿全局平均量「哪一侧有地板」**（`runNormal` 用 `floorCentroid()` 决定柜体在 path 哪一侧） | 凹型（L 型）户型的质心被另一条臂拉走 → 沿内边画的台面穿墙画到室外（实测 L 型 `[[0,0],[12,0],[12,5],[5,5],[5,12],[0,12]]` 沿内边 `(5,5)→(5,12)`：旧法线 `(1.00,0.00)` → 柜体落在 x>5 的墙外）（#29） | 「哪一侧有地板」是局部几何问题，必须实测：沿法线两侧各探 0.4/1.2/3.0ft 用 `insideFloorPt()` 投票，质心只在两侧同进同出时兜底。断言用两侧探点（内侧 true、外侧 false），只断「带子在 bbox 里」抓不到 |
| **把中心夹到端点，而不是夹到「离端点至少半个宽度」**（`runDistAlong` 把 `at` 夹在 [0, L]） | 冰箱（宽 2.0ft）放在 7ft 台面末端 → 中心 6.95ft → 跨 5.95..7.95ft → 0.95ft 悬在柜体外（2D 一块悬空板、3D 半个冰箱飘在地板上）（#30） | 放「有宽度的块」到一条线上，夹的是中心：`[w/2, L-w/2]`（`clampRunModuleAt`）；修在**生产者**（放置代码），不在渲染端补。重标定后还要重新夹（模块是真实尺寸、不跟着户型缩） |
| **容器装不下也照放**（1.2ft 的台面收 2.0ft 的冰箱） | 模块比台面长 → 两头都悬出去，界面上看不出「放不下」这件事（#31） | 装不下就拒放并给出可核对的理由（「冰箱宽 61 cm，这条台面只有 36.6 cm —— 放不下，先加长台面」）；`clampRunModuleAt` 返回 null 是唯一判据 |
| **一族删除分支里漏了两个**（`deleteSel` 给墙/窗/门/多边形 `pushUndo`，删用户洁具与删用户台面两个分支没进环） | 误删按不回来（#32）。这类「同一函数里前两个分支 return 得早」的漏项靠读代码很难发现，靠 E2E 一条「删 → 撤销」流程当场就钓出来 | 任何「可撤销」的变更点用同一张清单核对（§8.1 那种「三处都要管」的口径）；测试必须走「改 → 撤销 → 逐位回去」，不只测「改」 |
| **pointerdown 就算一步手势**（所有拖拽在起手时 `pushUndo`：2D 家具移/转、3D 拖家具、墙/门/多边形/洁具/台面手柄） | 只点一下、没拖动，「撤销」按钮也点亮，按下去什么都没发生（#33）——零反馈 = 设计缺陷（R10），而且 50 步环里可能一半是空步 | 进环的时机 = 真正越过防误触阈值开始动的那一刻（`markDragGesture(drag, drag.undoKey)`）；手势键不变所以合并语义不变 |
| **命中判定只写在一个工具分支里**（`data-run` 的选中判定在台面工具分支内） | 「选择/调整」模式点台面选不中（#34）；而台面命中区排在洁具之后（最上层）→ 落在台面上的洁具永远点不中。症状是「有时点得中有时点不中」，最难查 | 新实体的命中判定要么在所有工具模式下都认，要么明确不画命中区；重叠时**小目标赢**（洁具在台面之上）；悬停/选中高亮照现有颜色语言（橙=悬停、绿=选中）补齐，否则「选中了但看不见」 |
| **面板给了控件、代码却没接**（`#runCtl` 含模块下拉，在「选中台面」时就显示；可放置代码只在台面工具分支里） | 选择模式下面板摆着「冰箱」下拉、点台面却只起手拖动，零反馈（#35） | 控件可见性判据与功能可达判据必须一致（`ctxOn(..., tool==='run' \|\| s.kind==='run')` 意味着两种模式都得能放模块）；把动作抽成函数（`tryPlaceRunModule`）让两个入口共用 |
| **E2E 选点被内置洁具挡住**（台面带正好压在内置浴室柜台面上） | 「点台面」测的其实是点洁具（INFO 读数 `.fxHit`），断言红得像「选中失败」 | 流程里的选点按运行时数据避开（台面带与 `DOC.fixtures` 包围盒相交就换一条墙），并在 INFO 里如实报「这个点上盖着什么」；选点策略不是断言 |
| **重建列表时把用户状态一起重建掉**（`buildCatalog` 每次重建都从「只有第一个分组展开」开始） | 切币种 / 清空搜索 / 撤销 / 导入布局都会重建目录 → 用户展开的三个分类当场全折叠（实测 3 组 → 1 组），得重新找（#36） | 任何「重建列表」的代码都要先问：用户在列表里的状态（展开 / 滚动 / 选中）是谁的。记的是**状态**而不是「打开过的集合」（`catOpenState`：用户主动收起的那一组同样要记住，否则它自己弹回来）；搜索期间的「全展开」是临时的，不写进用户状态 |
| **新出现的分组默认折叠 ⇒ 用户刚造的东西看不见**（自定义家具排在最后一组） | 点「添加」后卡片 `display:none`、rect 0×0，目录里毫无痕迹——用户不知道自己造没造出来（#37，零反馈 = 设计缺陷，R10） | 「用户刚创建的东西」必须出现在视野里：新分组立刻展开 + `scrollIntoView`。新增即高亮 / 滚到位不是可选项 |
| **输入校验用 `alert()`**（`#cfAdd` 宽 / 深留空） | 真实浏览器里它是一次模态打断；bench / E2E 一旦覆盖这条路径就把整条测试链路挂死在 0% CPU（§5.1 老红线的新实例，#38，探针读数 `alertCalls=["请填写宽度和深度（cm）"]`） | 交互路径一律非阻塞反馈：`toast()` + 把焦点送到缺的那一格。体检命令 `grep -nE "(^\|[^.\w])(alert\|confirm)\(" app.html`——还剩导入 / 光追 / 切户型几条路径在用，将来被 bench 覆盖时要一并处理 |
| **外部资源没确认成功就拆掉兜底**（`queueThumb` 的 `spec.img` 分支一上来 `backgroundColor='transparent'`） | 用户手填的图片地址打不开 → 卡片成了一块 184×138 的空白格子，连他自己选的颜色都不显示（#39，探针读数 `rgba(0,0,0,0)`） | 兜底色先垫在下面，`new Image().onload` 确认加载成功才清掉。用户填的 URL / 本地路径一律按「可能失败」设计 |
| **`classList.toggle()` 的返回值是「切换之后」的状态** | 第一版写成 `catOpenState.set(cat, !grp.classList.toggle('open'))` → 记的全是反的 → 三条断言当场红（改完才绿） | 别凭「toggle 返回它是否移除了」的直觉写；写完立刻用「初始开 / 初始关」两种情形各验一次 |
| **断言落在没被执行的那条路径上**（bench 里「卡片可见」靠 IntersectionObserver 触发缩略图，而刚展开的分组 IO 不一定触发） | 断言读到的其实是「inline 样式还没被改过」，绿得没有意义——它测的是「什么都没发生」 | 直接调应用自己的 `queueThumb(el, spec)`（同一条代码路径，不是重写一份）；断言前要先能说出「这段代码确实跑了」的证据 |
| **E2E 表达式里的 CSS 属性选择器引号顺序**（`'.ph[data-thumb=${JSON.stringify(id)}']`） | 生成的 JS 串在 `]` 之前就闭合 → 页面内 `SyntaxError: missing ) after argument list`，整条流程异常退出 | 写 `}]'` 而不是 `}'`；跨语言拼接（JS 串里塞 CSS 选择器）写完先在 node 里 `new Function` 过一遍 |
| **「同一个手势」与「同一种动作」用同一个键**（`pushUndo(gestureKey)` 对相同键合并，而离散动作的键在连续两次操作里必然相同：`fxPlace` 是常量、`addItem:<refId>`、`rot90:<uid>`、`key:rot:<uid>`、`segType:<id>`、`runMod:<runId>`） | 连放两个洁具 / 连点两次同一件商品 / 按两次 +90° / 同一段墙连改两次类型 / 同一台面连放两个模块 → **撤销一次同时撤掉两件事**；极端情形是撤销按钮亮着而按下去什么都没发生（#40，零反馈 = 设计缺陷，R10） | 手势键有两种身份就要有两个参数：`pushUndo(key, eachGesture)`。连续手势（拖动中、滑块、连续方向键）合并；离散动作每次各成一步并把 `lastGesture` 清空。「按了但什么都没变」不靠键合并挡，靠快照相等检查。改这类合并必须同时带**对照组断言**（复制两次本来就该是两步、连按 5 次方向键仍只算一步），否则会把对的那半也改坏 |
| **撤销之后读旧对象引用**（`restoreState` 把 `state.items` 换成从快照 JSON 重新解析出来的一批新对象） | 断言里 `const it = state.items[n-1]` 之后撤销、再读 `it.rot` → 读到的永远是撤销前的值，断言怎么改都说不清红在哪 | 撤销 / 重做之后一律按 uid 重新 `find`；写撤销类断言前先问「这个对象还是文档里那一个吗」 |
| **同一个落点第二次点击不是「放第二件」而是「选中已放的那件」** | 「连放两件」的测试在同一个坐标上点两次，第二次测的其实是选中（#40 的 bench 第一版就是这样写的，断言读数 1/1 而不是 1/2） | 放置类断言的落点从运行时几何里挑（离已有墙 / 洁具最远的内部点 + 离它最远的另一个，间距 ≥3ft），并在断言里报出间距 |
| **E2E 用「与目录快照比有没有新文件」判定下载，而下载目录整个入口共用一份** | 上一段流程写过同名文件 → Chrome 的重名改名规则一撞就判不出新文件：全量跑偶发红（`demo-export-file` 20s 无下载），单跑全绿。红在 CI 上会被当成回归 | 需要证明「这一步真的产出了文件」的流程，开头清空自己的输出目录，只认自己产出的那一个；判定不到就把入口路径重新展开再点一次（一次重试，不是循环重试） |
| **用户能直接往状态里写数字的界面没有上下限**（自定义家具的宽 / 深 / 高接受任意正数） | 99999cm 收进去 → 2D 图例 72178px = 户型宽度的 72 倍，整张平面图被一个笔误盖住；0.1cm → 0.07px（看不见、点不中、删不掉）；h=-5cm → 3D 包围盒 y −0.164..0.000ft（整件在地板下面）（#41） | 给尺寸类输入定物理上下限（5–1200cm：5cm = 把手尺度，1200cm = 长餐桌 / 整面柜尺度，目录最大 5m）；一次收集**全部**越界项，提示里带用户填的实际数字，焦点送到第一个坏格 |
| **改了状态但没登记撤销**（面板里的颜色 / 色温 / 亮度直接写 `it.col`/`it.cct`/`it.dim`） | Ctrl+Z 撤的是「放件」那一步 → 用户改个颜色一按撤销家具整个消失（#42） | 任何写 `state.items` / `DOC.*` 的入口都要 `pushUndo`；连续型（滑块拖动）用同一键合并，离散型用 `eachGesture` |
| **同一个量在多个控件里各自归一**（旋转框存 720、滑块存 `720%360`、键盘 `[` `]` 能累出负数） | 同一时刻框里 720 / 滑块 0，再按 +90° 跳到 90；框里 −0.5 / 滑块 359.5（#43） | 一个量一个归一函数（`normDeg` = mod 360 且非负），**所有**生产者与消费端都走它；写完 `grep` 一遍 `% 360` 看还有没有本地归一 |
| **归一后无条件回写用户正在输入的框** | 逐字符打 45.5：「45.」被回写成「45」→ 接着打 5 得到 455°→185°（面板自己宣称 0.1° 精度）（本轮反证实测）。同理无条件把空框 / 「-」当 0° 应用 → 家具先转没了再转回来 | 只在「文本本身不是这个角度的忠实写法」时改框里的字（`if(Number(el.value) !== v) el.value = v`）；空框 / `validity.badInput` 不应用也不占撤销步 |
| **全局快捷键的门控按「标签名」而不按「这个控件是什么面」**（`!['INPUT','SELECT','TEXTAREA'].includes(tag)` 一律挡掉） | 焦点留在旋转框里时撤销按钮亮着、按 Ctrl+Z 什么都没发生（真键盘实测 ring=3 / rot 不变 / 框不变，#45 零反馈） | 区分两类面：自由文本框（text/search/url/email/password/tel/textarea/select）里 Ctrl+Z 属于浏览器自己的撤销打字；提交式控件（number/color/range）里它必须递到应用级撤销 |
| **撤销/重做后只重画图形不重刷面板**（`restoreState()` 调 `refresh()` 不调 `updateProps()`） | 图已经回到 45° 而面板框里还写着 135（#46）；而 `updateProps` 故意不覆盖用户正在打的字 → 焦点还在面板里时补调也不生效 | 恢复状态时先 blur 面板内被聚焦的 INPUT，再 `updateProps()`；「面板与状态一致」得是断言（`pb-props-panel-follows-undo`） |
| **模拟 number input 的打字用 `el.value = '45.'`** | 浏览器把非法文本直接吞成空串 → 下一轮拼接从空串开始 → 测出来的是「赋值坏了」而不是「打字坏了」 | 真打字模拟用 `document.execCommand('insertText', false, ch)`；注意 `"45."` 在 number input 里其实是合法浮点写法（`Number('45.')=45`），真正非法的是空框与 `-` |
| **「按屏幕尺寸恒定」的叠加层在 viewBox 变化后不重画**（量尺寸标注 / 编辑手柄除以当时的 `getScreenCTM().a`；滚轮处理器只补了一类、`fit2DToContent()` 两类都不补且排在 `build2D()` 之后） | 放大 5 格后标注线宽 1.600→2.577px、字号 10→16.1px；重新取景后 1.600→4.150px / 10→25.9px、手柄 1.000→2.594px；整图重标定 ×2 后反而缩一半 0.876/5.474px（#47，违反 §5.4.4「标注按屏幕尺寸恒定」红线） | 重画必须与取景变化**同一步完成**：`fit2DToContent()` 末尾补 `drawMeasure()+drawWallEdit()`，每个改 viewBox 的处理器自己补；不能指望调用方记得补一刀 |
| **标注 / 注记类数据不跟着它跨的那份几何走**（`meas.list` 存在视图状态里，而它跨的是几何端点） | 导入后图上还挂着 16 个旧元素（跨的却是另一份户型的坐标）；×2 重标定后墙 67.190ft 而标注仍跨 33.596ft、端点偏差 21.316ft；撤销那次缩放后几何回去了而标注不回（#48） | 几何整份换掉（换户型 / 导入 / 新建 / 重置内置）→ 作废标注；几何被缩放 → 用**同一个中心**缩标注端点（读数由端点自动重算，不另存）；快照环里带上它，否则撤销只退一半 |
| **断言「意外绿」：测出来的值恰好等于基准值** | `pb-overlays-constant-after-refit` 第一版在修前就绿——`fit2DToContent()` 把 viewBox 改回了基准缩放，加上页面里 ResizeObserver 的 70ms 自愈重画，1.600px 是巧合 | 立基准必须在**与断言态不同的缩放**下，且中间不 `await tick()`（不给定时器机会）；写完先跑一次确认它**真的红** |
| 消费一个 `const` 的函数写在**声明行之前**（`fit2DToContent` 在 1676、`const meas` 在 15676） | 今天不炸（调用全在运行时），但任何将来在页面初始化里调它的改动当场 `ReferenceError`，而 `node --check` 全绿 | 被管线消费的 `const` 声明要放在管线旁边；新增消费端前先 `grep -n` 看声明行号 |
| **模式跨视图留着，而它的 UI 与快捷键没跟着视图收**（`setView` 只藏 SVG，`wallEdit.on` / `wallEdit.sel` / `#wallbar` 全留着） | 切到 3D 俯瞰后：编辑工具条糊在 3D 画布上（实测 `display` 仍是 `flex`）而它的「画墙/画柱/门/洁具」按钮在 3D 里什么都做不了；快捷键继续隔空改几何——按三次方向键 → 墙被挪 3cm、撤销环 +1；按 Delete → 墙从文档里消失，而 3D 里那堵墙还立着（#49；用户看不见被改的东西 = 零反馈，R10） | 模式的**作用域**要写进它的每一个入口：快捷键分支门控在 `state.view==='2d'`、工具条可见性 = `(wallEdit.on && v==='2d')`；模式本身可以保留（按钮还亮着 = 模式可见），但「看不见却能改」的通道一律关掉。新加任何「模式」时问一遍：切视图时它的 UI、快捷键、选中各自该不该跟着收 |
| **把「标脏」当成「已经重建」**（`geoChanged()` 只置 `geoDirty3D=true`，重建要等下一次 `setView`） | 用户正看着 3D 时改了墙 / 门 / 洁具，画面还是旧的（实测 `staticGroup` 没换对象、顶点数 55965→55965、新墙处射线打不到）（#50） | 脏标记必须配一个「在场就补建」的派发：`if(is3D()) schedule3DRebuild()`（与 `setView` 同一条 setTimeout 派发，谁先跑谁消费 `geoDirty3D`，不会重建两次）。补建要排除「累积式渲染进行中」（`three.photo`，与 bug #26 同因） |
| **新实体没有命中区就以为它能被选中**（`pushUserWall` + `geoChanged()` 之后不调 `drawWallEdit()`） | 探针里点新画的墙，`wallEdit.sel` 却是 `{"kind":"door","id":"d1"}`——命中的是隔壁门的命中区（§5.1 那条老红线在**写测试**时又踩了一次） | 任何改实体的分支末尾 `geoChanged()+drawWallEdit()`；写「选中它」的断言之前，先确认它的命中区真的存在 |
| **bench 的选点净空只算墙 / 洁具 / 柱，不算门**（`pbClearance`） | 门的命中区在墙垛缺口里，「户型中心附近」这种落点会选中门而不是目标构件，断言红得像是选中逻辑坏了 | 选点判据要覆盖**同一层里所有可命中的东西**；新写一段点击类断言之前，先看那一层都画了哪些命中区 |
| **门禁的自愈次数按本地经验定**（`pt-kallax-visible` 的全黑瞬态：内部重渲 3 次 + 整页重跑 1 次） | 慢 runner 上瞬态会连击：四次全黑把整条 CI 判红（一个只改 `.md` 的提交），重跑就全绿——红的是门禁自己，不是代码 | 自愈次数按**最弱环境**定（与「覆盖率阈值按 CI 定」同一口径），并把「试了几次」写进断言读数（健康跑就是 1 次，日志里能直接看出这一轮撞了几次）；重试只能绑在**瞬态的签名**上（整块全黑 0/0），不能绑在「断言失败」上 |
| bench 里走**真实文件入口**（`<input type=file>` + 处理器里的 `f.text()`）时用「等固定虚拟时间」等结果 | `--virtual-time-budget` 下虚拟时间跑得比真实 I/O 快：`await wait(100)×40` 在慢 runner 上可能只对应几十毫秒真实时间，文件还没读到 → 断言读到的是**上一条**操作的提示（CI run 38330561910 只在 `t_3d_dist.html` 红三条，读数分别是上一条的文案与「解析失败 NaN 个」= 弹窗根本没开；本地三个变体全绿） | 三件套：①测试自己先 `await file.text()` 把真实读取预热（同一个 `File` 对象）；②等**期望的那条提示**（`expectRe.test(toast)`）而不是「提示变过」——等旧文案消失会把上一条操作的残留当成通过；③没等到就重投一次（最多 3 次，只重试这个瞬态特征）；④把「投递 N 次」写进断言读数（健康 = 1 次，沿用 pt-kallax「渲染尝试 N 次」的口径） |
| **同一判据只写在两套实现的一侧**（AGENTS §8.2 的「点击 vs 拖动用屏幕像素 ≥5px」只落在 2D 拖动上，3D 拖动没有） | 3D 俯瞰里点住家具手抖 1px → 家具挪 3.02cm、2px → 3.71cm，并且 `save()` 落盘（#52）；用户以为「它自己跳了」 | 一条交互判据属于**这类操作**，不属于某个视图；加新视图/新交互面时把已有判据逐条对表（§8.2 现在补了 3D 那一栏） |
| **撤销手势键是稳定串**（`pushUndo('drag3d:'+uid)` 在 pointerdown 就压） | 只点一下没拖也占一步（撤销按钮亮着、按下去只弹「没有可撤销的改动」= 零反馈）；连着拖同一件两次并成一步（实测撤销一次退 27.07cm，两次拖动一起没了）（#51） | 连续手势：进环时机推迟到真正开始动（`markDragGesture`），并且**每次手势带一个递增序号**（手势内合并、手势之间不合并）；快照必须在变异之前压 |
| **一条依赖只守了它的部分入口**（#26 只挡住光照三个入口，而光追依赖的是「整份冻结的场景」：光照 / 相机 / 构件 / 材质四类） | 光追跑到一半切视角（实测 `state.view` fp→doll、相机被挪 3.280ft）、滚轮走动、Delete 删家具、面板改旋转都照接 → 交出的图属于一个已经不存在的房间，而进度条照样 100%（#53） | 冻结类守卫要**顺着那条依赖的消费端列完**再写：先问「渲染开始时把什么钉住了」，再 grep 谁能改那些东西，每个入口都守（`photoFrozen()`），并一律给出「先点取消」的下一步 |
| **测试里假定「投影 `state.items[0]` 得到的屏幕点」拾取的就是它**（满屋布局里那个点上真正被拾取的可能是压在它上面的另一件） | E2E 拖动断言在个人入口红（拖 90px → 挪 0.00ft）而在只有一个件的公开入口绿——红的是测试自己选错了目标 | 3D 目标要先问一次 `pickFurniture({clientX,clientY})`，用它答出来的那件当目标（坐标也从它取）；同理 2D 选点要覆盖同层所有命中区 |
| **换户型的作废只写在一条路径上**（`switchPlan` 清了编辑层，`createBlankPlan` 没清） | 新建空白户型后 `wallEdit.sel` 仍指向上一份户型的墙（实测 `sel={"kind":"w","id":"w2"}` 而这份户型 walls=0），工具条继续描述它（「内置墙 · 长 167 cm · 厚 9cm ｜ …Delete=删除」）、`#doorCtl` 还亮着带旧值；按 Delete 说「已删除」而文档一个字节没变（walls 0→0、hidden 0→0）还往撤销环塞一步死快照（#54） | 「换户型要作废编辑层」抽成一个函数（`invalidateEditLayer()`）：切过去 / 新建空白 / 撤销回另一份 / 开关编辑模式四处共用（以前四处各写一遍、其中一处还漏了两项）；判据本身放在数据层（`selAlive(s)`：选中指向的实体还在当前文档里吗），消费端（工具条、删除）自愈 |
| **进行中的绘制状态属于「上一份坐标」，跨户型带过来就变成几何**（`wallEdit.drawPts` 不清） | 在内置户型画到一半（`drawPts=[[28.28,21.37],…]`）→ 新建空白户型 → 再点一下 + 回车 → 这份户型多出一段来自另一份户型的墙（DOC.walls 0→1）（#55） | 与选中同一批作废；写「换户型」类断言时要**分别断「选中」与「进行中的绘制」**，它们是两个状态，漏一个看不出来 |
| **删除类动作的反馈必须与它真正做了什么一致** | 界面说「已删除」而文档没变 + 撤销环多一步 = 说谎（R10 红线）；用户接着按撤销还会看到第三件事被撤掉，完全对不上账 | 悬空引用一律拒做并如实说明（「这个构件不在当前户型里，选中已取消」）：不进撤销环、不改文档、不假装成功 |
| **断言「工具条描述的是哪个东西」要比文案，不能只比 `sel` 是不是 null** | 修前 `sel` 非 null 而描述文案也在，只断 `sel===null` 会漏掉「sel 已清但提示还挂着」那一半；而用户看到的恰好是文案 | 界面提示文案是断言对象（`/长 /.test(#wMsg)` vs `/悬停会亮出墙体/`），与状态量一起断 |
| **目录条目的 schema 与消费端不同步**（校验规则凭印象写，不逐字段对表消费端） | `caVar` 只允许字符串，而内置目录有 1 条写 `true`（合法写法，消费端是 `!!spec.caVar`）；`seat` 被通用建模读（`kind:'stool'`）却不在已知字段表 → 内置目录自己报 warning；固定灯具（公寓自带、本来无价）被报「没价格」提醒 40 次。内置目录过不了自己的 schema = **schema 错，不是目录错** | **schema 改完必须对内置目录跑一次全量体检**（`npm run catalog:check`）；「缺价格」是 warning、「显式 `noPrice:true`」是意图——沉默漏掉才是错误；字段是否合法以消费端为准（`grep` 一遍谁读它） |
| **目录条目消失后，显示层直接读 `spec.xxx`**（移除目录包 / 导入布局里的已下架商品） | `drawFurniture()` 的选中分支读 `spec.w` → `TypeError: Cannot read properties of undefined (reading 'w')` 把**整个 2D 家具层**停摆（一件幽灵件毁掉全部家具）；`updateProps()` 读 `s.name` 同样炸（#56） | `itemSpec()` 保持返回 null（价格合计与按包计数依赖这一点），但显示层必须有诚实的占位：2D 虚线灰块 + `?`（带 `data-uid`，可选可拖可删）、3D 灰色占位盒、面板「目录里没有这件（仍在布局里）」+ 价格「—」 |
| **导入的新条目落进默认折叠的分组** | 卡片 `display:none`、rect 0×0 —— 用户选了一个文件、确认框说「3 条」，目录里却一条都找不到（零反馈，R10；与轮㉑ 的自定义件同一根因） | 导入提交后 `revealCatalogEntries(ids)`：展开含新条目的分组 + 滚到位；**启动时装载不得强制展开**（否则每次刷新覆盖用户的展开状态） |
| **`const` 声明在它的第一处使用之后**（新增模块接线时最容易犯：新键名顺手放在文件靠后位置） | `const PACKS_KEY = CATPACK.PACKS_KEY;` 写在 1240 行，而 1140 行的 `STORE.warm([...PACKS_KEY])` 已经用它 → 模块求值当场 `ReferenceError` → **整个脚本块不执行**：页面白屏（截图 35KB vs 657KB），而 `node --check` 完全通过（它只验语法） | 新增顶层常量时，声明位置必须在**它最早的消费端之前**；验收靠 calib md5 回归（白屏 = md5 整体变掉），不要只靠语法检查 |
| **E2E 驱动挂在 CDP 调用上（CPU 0%、日志不动、页面本身完全响应）** | 同一个 profile 里存在**第二张页面**时（实测 Chrome 155 `headless=new` 会自己开 `chrome://settings/help`），我们的页面变成后台标签 → Chrome 不再给它提交帧 → `Input.dispatchMouseEvent` 的确认永远不回来。`Runtime.evaluate` / `Page.captureScreenshot` 照常响应，所以「页面还活着」**不是**「输入管道还通」的证据 | 每张流程开头关掉额外页面（自己的 targetId 从 `Target.getTargetInfo` 问，`/json/list` 的 id 与 Target 域的 targetId 可以不一致；再加「URL 是入口的绝不关」这道保险）+ **每个 CDP 调用必须有超时**并指名方法。诊断挂死：先连 DevTools 自己发一次同样的调用，再 `Target.closeTarget` 关掉额外页面复现 |
| **跨上下文计数的查询只查当前那一份**（`packPlacedCount()` 只数当前户型的 `state.items`） | 移除目录包的提示说「布局里有 1 件用的是它」，而另外两份户型里还有 2 件 —— 它们静默变成幽灵件，用户完全不知道发生了什么（#59） | 计数类提示必须查它**真正覆盖的范围**（`packPlacedAcross()` 顺着注册表读每份户型的存档），并分档说清「当前户型 N 件，另外 M 份户型里 K 件」 |
| **内存里的东西比存储里的注册表多**（导入到上限时先入内存、再拒写注册表） | 第 33、34 个包当场能用（卡片在、能摆放），刷新后凭空消失且没有任何解释；主存里还留下两个 196B 的孤儿存档 —— 注册表不列它，`removePackDoc` 就永远不会被调用，它删不掉（#60） | 上限要在**入口**判（确认框之前就说「已经加载了 32 个包：先移除一个再导入」），不许「先接受再静默丢弃」；任何写进存储的键都必须有注册表条目指向它 |
| **查找键没有查重**（三个来源拼成一个数组，后写覆盖先写） | 导入布局里的自定义件 id 与内置/包条目撞 → `catalogAll()` 里同一个 id 出现两次、`itemSpec()` 解析成别人的商品（尺寸价格全错）、两张卡片共用同一个 `data-thumb`（缩略图互相串）（#61） | 合并多来源的查找表必须查重（`Set` + 冲突记录）；用户文件里的 id 撞内置 = **拒收并列出撞了哪几个**，因为它读到的尺寸与价格会是别人的 |
| **反馈的措辞与它真正做的事不一致**（提示说「不再显示与计价」而占位就摆在图上） | 用户按了移除，家具还在（灰色占位），提示却说「不再显示」→ 用户以为没生效，又按一次（#63） | 提示必须描述**实际后果**（「它们仍在布局里，图上显示成灰色占位，只是不再计价」）；写提示时对着截图逐句核对，不要照抄设计意图 |
| **破坏性替换用户数据没有反馈 / 坏文件把数据清空**（导入布局 = 整体替换 `state.items`，而 `s.items \|\| []` 在形状不对时就是空数组） | 34 件家具一个字的提示都没有地变成 0 件；选一份「没有 items 数组」的文件同样把布局清空（#64） | 替换类动作必须报「几件 → 几件」+ 出路（撤销）；**形状校验在变异之前**，坏文件一律「没有改动任何东西」 |
| **图上有、清单里没有 = 那件东西没有归属**（幽灵件被 `updateTotals` 与 `updatePlacedList` 一起 `continue` 掉） | 采购合计说「采购 18 件」而布局里有 34 件（含 2 件幽灵）；幽灵件在采购清单里找不到 → 从那里删不掉，只能在图上找（#65） | 「不计价」与「不出现」是两件事：不计价的实体仍要有行、有标签、有删除入口；合计尾部如实写「N 件目录里没有（不计价）」 |
| **探针绕过真实入口自己拼一遍流程，得出「界面说谎」的假结论** | 探针直接调 `addPackDoc()` → 确认框当然显示「建模代码解析失败 0 个」（真实入口在弹窗之前就把模型编译过了）；差点把一条正确实现「修」坏（#62 撤回） | 怀疑「界面给的数字不对」时先跑**真实入口**（真按钮 + 真文件选择）再下结论；然后把这类不变量写成断言（`cat29-confirm-dialog-compile-count-honest`：确认框声称的失败数必须等于提交后真实编译失败数） |
| **测试台页面把 `save()` 换成空操作**（bench 里 `save = () => {}`） | 跨存档断言（读另一份户型的家具存档）永远读到 null，看起来像「跨户型计数坏了」，实际是测试从没写过那份存档 | 断言依赖「存储里有某样东西」时，测试自己写进去（`STORE.set(PLANS.itemsKeyFor(id), …)`）；**先确认前提成立，再怀疑被测代码** |

### 5.1.1 bug 猎方法论（2026-09~10 二十九轮，63 个真 bug + 2 处防御性统一，全走这条路）

**先写失败测试，再改代码**。每个 bug 都是「按代码读出来的怀疑」→ 写一条应当红的
vitest → 跑一次确认它按预期红（证明 bug 真存在、不是臆想）→ 修 → 转绿。
十五轮里 19 个 bug 中 18 个的失败测试在修前就红了，1 个（枚举校验）是
「构造畸形输入 → 崩溃/隐形件」类，同样先红后修。**没有一条是凭感觉改的。**

分轮口径（每轮一个高风险面，读完再动手）：① `src/schema`（纯函数层，最好测）
② `app.html` 持久化/编辑层（读逻辑、不写测试，找数据丢失类风险）
③ `build.mjs` / `scripts` 守卫（确认断言覆盖，不硬造 bug）④ `src/geo` 导入管线
⑤ 文档导出/导入往返 ⑥ `import-pdf.ts` 细读（无新 bug，但验了弧拟合/尺度推断）
⑦ **3D 消费端**（2D 有而 3D 没有的东西 = 消费端判据问题，靠探针页 + 射线量出硬数字再修）
⑧ **校验层的覆盖边界**（闸门验到什么程度？「不响但看不见」的几何类 bug 全部从这里漏过去）
⑨ **交互层：门联动/滑动夹取**（读出来的不对称要先用探针量它能不能在真户型上复现）
⑩ **外部规范对照**（`$INSUNITS` 这类「我们照抄的码表」逐条对回原始规范；顺带查 fixture/测试有没有把错误固化）
⑪ **导入启发式的单位口径**（手拄表 / 裸阈值 / 数组下标语义——三类都是「代码读起来没问题、量纲错了」）
⑫ **存储后端的成败判据**（IDB 请求的 result 语义：put 有 key、delete 没有）
⑬ **DXF 实体细节**（圆弧扫角、bulge 符号、变换后的角度——产弧的每一条路径都要归一）
⑭ **目录数据不变量**（280 条目 / 57 kind 的形状与图例口径：实物是圆的，碰撞检测与 2D 图例是不是也按圆算；
   同品类两个 kind 的图例读法是否一致。静态正则数分支会假报，必须运行时量图元数）
⑮ **目录字段有没有消费端**（价格口径：`caVar` / `caNA` / 无价条目 / 固定灯具不计价——「文档里写了、界面上给提示」的承诺是否真落地，靠 grep 字段名验消费端）。
⑯ **门禁自身的确定性**（CI 双截不一致时先逐区像素定位，分清「回归」与「截图态不确定」）
⑰ **新功能交叉面**（E24 整图重标定 × E26 多户型 × E23 撤销：新字段与派生字段同不同步）
⑱ **刚落地最没被猎过的面**（S4a/S4b 窗外环境的 `DOC.env` 消费端：同一个值的多个消费端兜底是否一致）
⑲ **存储与多户型的交叉口**（E26 注册表 × E10 主存门面 × E23 撤销环：「读不到」与「不存在」的分界、
   回退出来的文档能不能被写回主存）——这一轮的门禁不在 bench 里而在 `storage-probe`（真实 IDB +
   真实刷新 + 真实切户型），因为 bench 页面按定义就是「内置户型 + 空布局、不补水」。
⑳ **两个功能各自的接缝**（S12 台面工具 × E23 撤销环 × 命中区 z 序：先列 E2E 覆盖边界——
   16 条流程覆盖 12 个界面，但台面工具 / 编辑层撤销 / 环境预设 / 光追四个已交付功能零真实鼠标覆盖，
   然后只补前两条流程）。本轮 7 个 bug：#29/#30/#31 由探针实测（L 型内边法线 `(1.00,0.00)` → 柜体在墙外；
   冰箱中心 6.95ft → 悬出 0.95ft；1.2ft 台面收 2.0ft 冰箱）；#32/#34 由 4 条先写的 bench 断言实测红钓出；
   #33 由「只点一下没拖」的空撤销步；#35 由新 E2E 流程当场超时钓出（面板给了下拉、点了没反应）。
㉑ **目录侧栏（挑家具的主界面）**（搜索 / 折叠 / 缩略图 / 自定义件 / 价格与选中态）。本轮 4 个 bug 全部
   由探针页先量出硬数字再修：#36 展开 3 组 → 切币种后 1 组（`buildCatalog` 每次重建都从「只剩第一个」开始）；
   #37 造一件自定义家具后卡片 `display:none`、rect 0×0（新分组默认折叠，用户刚造的东西在目录里不存在）；
   #38 `#cfAdd` 的输入校验用 `alert()`（探针读数 `alertCalls=["请填写宽度和深度（cm）"]`，§5.1 阻塞弹窗红线的新实例）；
   #39 自定义件的图片打不开时卡片背景被清成 `rgba(0,0,0,0)`（184×138 的空白格子）。
   方法论上的新东西：**先审「用户状态归谁」**（列表重建时展开 / 滚动 / 选中是不是用户的），
   以及**断言必须落在真的被执行的那条路径上**（IO 没触发时「卡片可见」断言测的是「什么都没发生」）。
㉒ **撤销环的手势判据**（E23 交付之后回头看它自己的合并规则：一个键同时当「同一个手势」与
   「同一种动作」用）。本轮 1 个根因 bug（#40）在界面上是六个症状：连放两个洁具一次撤销全没、
   连点两次同一商品一次撤销全没、按两次 +90° 撤销退 180°、连按两次 R 撤销退 30°、同一段墙连改
   两次类型直接回到最初、同一台面连放两个模块一次撤销全没；最坏的一种是「撤销按钮亮着、按下去
   什么都没发生」= 零反馈（R10）。七条断言先红后绿（bench 199→209），其中两条是**对照组**
   （复制两次本来就该是两步、连按 5 次方向键仍只算一步）——改合并类逻辑必须同时守住「对的那半」。
   写测试时另外撞到两个坑（撤销后读旧对象引用、同一落点第二次点击其实是选中），都不是 app bug
   但都让断言测的不是它声称测的东西，一并记进 §5.1。
㉓ **检视面板（用户直接往状态里写数字的那个界面）**（尺寸 / 颜色 / 色温 / 亮度 / 旋转）。本轮 6 个 bug
   的共同根因是「面板没有自己的口径层」：#41 尺寸无上下限（99999cm → 图例 72178px = 户型宽的 72 倍；
   0.1cm → 0.07px；h=-5 → 整件在地板下）；#42 颜色/色温/亮度不登记撤销（Ctrl+Z 撤掉「放件」那步）；
   #43 旋转三个口径不一致（框 720 / 滑块 0 / 键盘能出负数）；#44 死步（重打同一个数字 → 撤销按钮亮着
   而按下去什么都没发生）；#45 焦点在提交式控件里 Ctrl+Z 被门控挡掉（真键盘实测 ring=3、什么都没变）；
   #46 撤销后面板不跟着回去（框里 0 / 实际 45°）。本轮的方法论亮点是**反证自己差点带进去的新 bug**：
   归一化后无条件回写输入框会吃掉小数点（打 45.5 → 185°），同一套断言在「无条件回写」与「无空值守卫」
   两个变体上各红一次，才确认修的是真成因（bench 209→226，E2E 151→160/入口）。
㉔ **量尺寸工具与「按屏幕尺寸恒定」的叠加层**（§5.4.4 那条红线到底有没有被守住）。本轮 2 个根因、7 个可测症状：
   #47 重画与取景变化不同步（滚轮只补 wallEdit 漏 meas；`fit2DToContent()` 两类都不补、还排在 `build2D()` 之后
   → 先按旧缩放画再改取景）；#48 标注不跟着它量到的那份几何走（导入 / 换户型不作废、整图缩放不跟着搬、
   撤销只退一半）。全部先探针量硬数字（1.600→2.577 / 4.150 / 0.876px；端点偏差 21.316ft）再写 13 条 bench 断言
   （7 红 6 绿，含两条对照组：wallEdit 本来就补了、撤销后墙与标注都回原值本来就该一致）。
   本轮的方法论亮点是**拓住一条自己写的假断言**：`pb-overlays-constant-after-refit` 第一版在修前就绿，
   因为 fit 把 viewBox 改回了基准缩放 + 页面里 ResizeObserver 的 70ms 自愈重画——绿的是巧合。
   改成确定性序列（先缩小 10 格、用应用自己的重画在新缩放下立基准、再 fit、中间不 tick）后它真的红了。
㉕ **编辑模式 × 3D 视图**（一个 2D 模式跨视图之后还剩下什么）。本轮 2 个根因、3 个可测症状：
   #49 `setView` 只藏 SVG，模式的工具条与快捷键都留着 → 3D 画布上糊着一排按不动的按钮（实测 `display=flex`）、
   快捷键隔空改几何（三次方向键 → 墙挪 3cm + 撤销环 +1；Delete → 墙从文档里消失而 3D 里那堵墙还立着）；
   #50 `geoChanged()` 只标脏不补建 → 用户正看着 3D 时改了构件，画面还是旧的（实测 `staticGroup` 没换对象、
   顶点 55965→55965、新墙处射线打不到）。四条断言先红后绿（bench 239→248）+ 两条对照组（2D 里工具条可见、
   2D 里微调照常生效）。方法论上的新东西：**「模式」的作用域要写进它的每一个入口**（UI 可见性、快捷键分支、
   选中状态三处各自都要问「切视图时它该不该跟着收」），以及**脏标记必须配一个「在场就补建」的派发**，
   否则「标脏了」和「画面更新了」之间那段距离只有真显卡 / 真用户才看得见。
㉖ **3D 拖动 × 撤销 × 光追冻结**（轮㉕ 把编辑模式收进视图之后，3D 自己的交互面）。本轮 3 个 bug：
   #51 撤销环的手势身份在 3D 拖动上没跟上 #33/#40（pointerdown 就 pushUndo → 只点一下也占一步；
   手势键是稳定串 `drag3d:<uid>` → 连着拖同一件两次并成一步，实测撤销一次退 27.07cm）；
   #52 3D 拖动没有「点击 vs 拖动」的屏幕像素阈值（§8.2 给 2D 定了 ≥5px，3D 漏了）——点住家具手抖
   1px 就挪 3.02cm 并落盘；#53 光追进行中它依赖的那份场景没冻结（#26 只守了光照三个入口；
   切视角实测 `state.view` fp→doll、相机被挪 3.280ft，走动 / Delete / 改旋转都照接）——交出的图
   属于一个已经不存在的房间而进度条照样跑到 100%。修：`markDragGesture` 每次手势一个递增序号
   （手势内照旧合并、手势之间不合并）、3D 拖动改成「先阈值、再快照、后变异」、`photoFrozen()` 守住
   视角 / 相机 / 走动 / 家具变异的全部入口（拒接 + toast，与 #26 同口径）。bench t_3d 144→148、
   t_pt 38→45，E2E 新流程 `photo-freeze`（176→186/入口）。方法论上的新东西：**一条依赖要顺着它的
   消费端列完**（「光追依赖一份冻结的场景」这条依赖有光照 / 相机 / 构件 / 材质四类入口，只守一类等于没守），
   以及**同一判据在 2D 与 3D 两套实现里要逐条对表**（§8.2 的屏幕像素阈值只写在 2D 那一侧）。
㉗ **换户型时编辑层的作废**（E26 多户型 × 编辑层的交接面：轮㉕/㉖ 把「模式跨视图」收完之后，
   下一个问题是「模式跨户型」）。本轮 2 个 bug：#54 **作废只写在一条路径上**——`switchPlan` 清了
   编辑层而 `createBlankPlan` 没清：新建空白户型后 `wallEdit.sel` 仍指向上一份户型的墙（实测
   `sel={"kind":"w","id":"w2"}` 而这份户型 walls=0），工具条继续描述它、`#doorCtl` 还亮着带旧值；
   按 Delete → 界面说「已删除」而文档一个字节没变（walls 0→0、hidden 0→0）还往撤销环塞一步死快照；
   #55 **进行中的画墙链跨户型泄漏成几何**（`drawPts=[[28.28,21.37],…]` 带进空白户型，再点一下 +
   回车 → DOC.walls 0→1）。修：`invalidateEditLayer()` 一处定义、四处共用（以前四处各写、其中一处
   还漏了两项）+ 数据层判据 `selAlive(s)` + `deleteSel` 拒做并如实说明 + 工具条自愈。bench 248→258×3
   （四条先红后绿 + 三条对照组），E2E `multi-plan` 加三步（16→18/入口）。方法论上的新东西：
   **同一条判据要一次写全它的每一条路径**（「换户型要作废编辑层」本来就有，只缺「新建」那一条），
   以及**断界面提示文案而不只断状态量**（sel 已清而文案还挂着，用户看到的正是文案）。
 ㉘ **目录扩展协议自己的门禁**（S10 Phase 1：新门禁上线时，第一个被它审的对象是内置目录自己）。本轮不是「找旧 bug」，而是**新写的校验层立刻反噬**：三个 bug 全部由新门禁当场钓出。#56 **schema 与消费端不同步**——`caVar` 只允许字符串而内置目录有 1 条写 `true`（合法写法，消费端 `!!spec.caVar`）、`seat` 被 `kind:'stool'` 的通用建模读却不在已知字段表、40 条固定灯具被报「没价格」（它们本来就没有独立售价）：内置目录过不了自己的 schema = **schema 错，不是数据错**；修法是逐字段回消费端对表 + 把「缺价格」降为 warning、加显式 `noPrice:true` 表达意图。#57 **幽灵件把整个 2D 家具层炸掉**——移除目录包后已摆放的家具失去规格，`drawFurniture()` 选中分支直接读 `spec.w` → TypeError 让全部家具消失（一件幽灵件毁掉整层），`updateProps()` 同样炸。#58 **导入的新条目藏在默认折叠的分组里**——卡片 rect 0×0，确认框说「3 条」而目录里一条都找不到（与轮㉑ 的自定义件同一根因，零反馈 R10）。方法论上的新东西：**新门禁的第一批产出通常是它自己的误判**，所以「内置目录必须 0 error 0 warning」本身就是一条该写的断言（它把 schema 的错判全部暴露出来）；以及**「条目消失」是一种真实状态而不是一种异常**——数据层如实返回 null，显示层必须给它一个诚实的占位。回归：vitest 339→379（+40 条协议测试）、t_3d 148→164×3（含「包模型必须守内置三律：填充率 92~102% / 贴地 / 重心归零」）、E2E 新流程 `catalog-pack`（189→196/入口：真实文件选择 + 确认弹窗文案 + 卡片三层探针 + 摆件 + 刷新 + 两步移除 + 幽灵件面板）。
 ㉙ **目录包与布局导入的消费端**（轮㉘ 把协议建起来之后，本轮猎的是「协议被真实使用时」的那一面：
   计数的覆盖范围、上限的判据位置、查找键的唯一性、措辞与实际后果、替换的反馈、消失实体的归属）。
   六个真 bug + 一处防御护栏：#59 移除包的提示只数当前户型（`packPlacedCount()` 读 `state.items`），
   另外两份户型里的 2 件静默变幽灵；#60 导入到上限时先入内存再拒写注册表 → 第 33/34 个包「当场能用、
   刷新就没」，主存里还留下两个 196B 的孤儿存档（注册表不列它 → `removePackDoc` 永不调用 → 删不掉）；
   #61 三个来源（内置 / 包 / 自定义）拼成查找表不查重 → 同一个 id 出现两次、`itemSpec()` 把自制件
   解析成别人的商品（尺寸价格全错）、两张卡片共用同一个 `data-thumb`；#63 移除提示说「不再显示与计价」
   而占位就摆在图上（用户以为没生效，又按一次）；#64 导入布局 = 整体替换 `state.items` 而零反馈，
   且 `s.items || []` 在「JSON 能解析但没有 items 数组」时把 34 件清空；#65 幽灵件被 `updateTotals`
   与 `updatePlacedList` 一起 `continue` 掉 → 合计说「采购 18 件」而布局里有 34 件，且它在清单里没有行
   就没有删除入口。防御：`addPackDoc` 被传成 validatePack 的结果而不是包本身时 `Object.entries(undefined)`
   炸掉整个启动路径 → 形状护栏。**本轮的方法论亮点是一条被撤回的「假 bug」**：#62 探针直接调
   `addPackDoc()`，确认框当然显示「建模代码解析失败 0 个」（真实入口在弹窗之前就把模型编译过了）——
   差点把一条正确实现「修」坏；跑过真实入口之后撤回，并把这条不变量写成断言
   （`cat29-confirm-dialog-compile-count-honest`：确认框声称的失败数必须等于提交后真实编译失败数）。
   另一条是**测试前提没成立时不要怀疑被测代码**：bench 页 `save = () => {}` 是空操作，跨户型存档
   从来没被写过，「跨户型计数坏了」看起来像 bug 而其实是测试没铺前提。
   回归：t_3d 164→176×3（12 条）· E2E 新流程 `layout-import` + `catalog-pack` 加三步
   （196→203/入口，CI 口径 165→172×2=344）· t_planbuild 258×3 · t_walledit 259×2 · t_pt 45×3 ·
   vitest 379 · calib md5 不变 · ui-gate 8/8 @ 0.0000%（未重拍）· storage-probe 全绿 ·
   lint 0 · format 干净 · tsc rc=0 · catalog:check 0 错误。

**修完必须确认 HEAD 自洽**：`src/**` 与 `app.html` 内嵌块同批提交，并用「干净检出 + 三个 build + vitest」复现 CI 口径（本轮就发现过两轮修复只在工作区、没进 commit）。
**量不出差异的怀疑就如实标成防御性统一，不冒充 bug**（第 ⑨ 轮：门整体滑动的夹取只取了
一端的下界 + 另一端的上界，逐门量两份户型的两种夹取 → 最大差异 0.000ft → 只统一写法，
并在提交信息里写清「为什么现在不会暴露」）。
**每轮结束跑完整回归**（bench ×9 + calib md5 + ui-gate +
lint/format/typecheck）再提交，根因写进提交信息（AGENTS §10）。

**UI 层的 bug 靠 bench 守，不靠 vitest**：vitest 测不到 `app.html` 里的消费端代码（它不在
可导入模块里）。本轮的 3D 立实体 / 2D 命中区两条分别进了 `bench/t_3d.js`（入库、三入口、
CI 跑）与 `private/bench/t_walledit.js`（本地跑）；语义层（`column` 判据）进 vitest。

顺带查到的**不是 bug 但值得记**的结论：`bandWallId[bi]` 记的是该带最后一个区间的墙 id
（门/窗的 `wallId` 因此不精确）——目前无消费端读它（`app.html` 三处 `wallId:null`），
`validate` 只验存在性；将来 S2 做「窗挂墙」时要先修这条。
`docToLegacy` 对实心块的 `{poly:[…]}` 包裹形态是**形状保持**（只当输入本身就是包裹时才包裹）：
真实 legacy 存档的 `ovP` 永远是数组 → `ovWrapped` 永不被置位 → 输出永远是数组 → 消费端安全。
fixture 里那个合成包裹（`ovP:{2:{poly:[…]}}`）不真实但与 oracle 兼容；现在在 `effFixed()`
出口摊平，所以两种形态都不会伤消费端。

### 5.2 浏览器/three.js 类

| 坑 | 症状 | 修法 |
|---|---|---|
| **CanvasTexture 没设 sRGB** | 贴图渲染发白、颜色不对 | `t.encoding=THREE.sRGBEncoding` |
| **ExtrudeGeometry 的 bevelSize 向外扩张** | 圆角体实际尺寸比请求大 2r | 基形先缩 2r（`rboxGeo` 已修） |
| **跨 WebGL 上下文共享纹理** | 渲染出全黑图 | 最终合成必须用同一个 renderer |
| **rAF 在无合成帧时被饿死** | 场景永不构建 / 动画卡住不动 | 关键路径改用 `setTimeout` 派发 |
| **OrbitControls 参与第一人称朝向** | 转头时相机升高、到边界后方向翻转 | FP 模式 `controls.enabled=false`，直接 `cam.lookAt` |
| `cross(fwd, up)` 就是"右" | WASD 左右相反 | 不要再 `.negate()` |
| ShapeGeometry 绕 X 转 +90° 后法线朝**下** | 天花板用 BackSide 会从上方可见、挡住俯视 | 用 FrontSide |
| 材质 `envMapIntensity` 太高 | 白墙"发光"、像自发光 | 墙面用 MeshPhysical + `specularIntensity:.05`, `envMapIntensity:.10`, `roughness:1.0` |
| 光源用 SpotLight 窄角 | 像舞台射灯，不像家里 | 家用灯具主体用 PointLight（全向）；筒灯叠 75° 宽角 + `penumbra:0.92` |
| `physicallyCorrectLights` 下强度是坎德拉 | 灯几乎不亮 | 点光 `I=lm/(4π)`；聚光 `I=lm/(2π(1-cosθ))` |
| 工具条高度变化（控件出现/文字换行） | 画布跳动、缓存的屏幕坐标失效 | 编辑类工具条固定单行高度（`nowrap`+`ellipsis`+定高），控件用 `visibility` 占位切换 |
| 工具模式的早退分支 | "加门模式下拖端点"完全失效 | 手柄/拖拽检测必须在工具分支**之前**；move 的早退要加 `&& !drag` |
| **Raycaster 不刷新 `matrixWorld`（r147）** | 刚移动完家具再点，射线打空或打到旧位置；按需渲染下尤其明显 | 射线前显式 `group.updateMatrixWorld(true)`（相机也要），不能指望 `renderer.render()` 已经跑过 |
| 3D bench 数 mesh / 读 `geometry.parameters` 断言 | `mergeByMaterial` 把同材质 mesh 合并成一个（顶点拼进新 BufferGeometry）：mesh 数对不上、`parameters` 消失（`BoxGeometry` 的 `parameters.height/depth` 没了），断言假红或假绿 | 对合并感知的断言：按**材质色**（`material.color.getHex()`）遍历 scene，数**顶点总量**（`geometry.attributes.position.count`）做对比（S2 窗框断言就是这么写的） |
| 俯视时吸顶灯永远挡在射线最前 | 娃娃屋视角点不中灯下方的沙发 | `pickFurniture` 命中链里优先取非灯具，全是灯才回退取灯 |
| **本机 3D 截图** | 黑屏 | 用 `--use-angle=swiftshader`（不带 `-webgl` 后缀），`--virtual-time-budget` 20000-30000；大 budget 会留下 400% CPU 僵尸进程，必要时 `pkill -f headless` |

### 5.3 几何/建模类

- **`sips` 的 `--cropOffset 0 0` 会被当成未设置** → 变成居中裁剪。用 1 代替 0。
- **`grep -o` 统计中文分类会误报**（多字节+空格），用 python `re.findall` 统计。
- **SVG `stroke-linecap` 必须是 `butt`**，`square` 会让每段墙端头外伸半个描边宽，系统性吃掉门洞。
- **墙体要画成实心多边形而不是描边线**：line+butt 在 T 型口/转角必留豁缝、厚度突变必出台阶。`wallPolys()` 做端头咬合。
- **T 型口延长量**：延长到对方远侧面时，斜交情况下端头矩形的横向半宽会斜着冒出对面，要扣除投影 `(o.half - w.half*sqrt(1-den²))/|den|`。
- **只有共线墙垛才跟随门移动**：垂直墙被绝对赋值会被拉斜；改成记录初始偏移、按增量平移。
- **夹取区间必须包含 0**：`range()` 返回反向区间时会把门推向相反方向。
- **条形/定向部件容易整轴写反 90°**（T 脚、板条、边带、臂、杆）：
  正面 3/4 视角下两个方向长得几乎一样，只有侧视图能露馅（且侧视图透视也
  容易看错，曾把居中的底架看成偏前）。建模前必须在 brief 里写死
  「沿哪个世界轴、平行长边还是短边」，建模后用**侧视角渲染图**核对，
  拿不准就逐 child 打 bbox 验证（`?nomerge`）。
- **可伸展/带达臂的件，占地必须含最大伸展**（臂灯、伸缩桌、可旋转件）：
  spec `w/d` 取官方 Length/reach，不是机身尺寸。RANARP 落地灯曾只录机身
  28×28，实际臂长 76cm——这类 spec 要**改目录条目本身**（note 里注明口径），
  不能在模型里把臂缩小去迁就错误的 spec。

---

## 5.4 材质与贴图（2026-09 补齐）

`app.html` 里所有贴图都是**程序化生成的 CanvasTexture**（离线可用、可确定性复现）：

| 函数 | 用途 | 备注 |
|---|---|---|
| `woodTexture()` | 地板：深冷灰褐宽板 | 对照 704/705 实拍 |
| `woodSpecies(name)` | 家具木纹：pine/beech/birch/oak/walnut | 按 `spec.wood` 选 |
| `grayOakTexture()` / `quartzTexture()` | 橱柜灰褐木纹 / 白石英台面 | |
| `fabricTexture()` | 织物 | 沙发/椅/灯罩 |
| `laminateTexture()` | 三聚氰胺/烤漆板 | 白色柜体的默认贴图 |
| `carpetTexture()` | 地毯绒面 | 法线强度要大（1.6）才有毛绒感 |
| `powderCoatTexture()` | 金属烤漆细橘皮 | 铁床架/推车 |
| `plasticTexture()` | 注塑件橘皮 | QUADRO 管件等 |
| `leatherTexture()` | 素皮/皮革毛孔 | 爬行垫的硅胶涂层面 |
| `brushedSteelTexture()` | 拉丝不锈钢 | 冰箱/五金 |
| `cityPanorama(night)` | 窗外全景 | 同时当光追的环境光 |

三条铁律：

1. **CanvasTexture 必须设 `t.encoding = THREE.sRGBEncoding`**，否则在 `outputEncoding=sRGB`
   下被当线性图，渲染发白。
2. **纯色材质一律不合格**。近景和光追里一眼假。曾经泛型建模的 25 个 kind 全是无贴图纯色板，
   现在有三道保障：
   - `furnMats(spec, col)`：泛型建模按 kind 统一发材质（贴图/粗糙度/金属度/envI）
   - `C.M(color, opts)`：专属模型的材质工厂，没显式指定贴图时按金属度自动兜底
   - `ensureTextured(root)`：建完模再扫一遍，补掉分支里就地 `new` 出来的漏网材质
   要显式退出，给材质挂 `userData.noTex` / `noNrm`。
3. **`envMapIntensity` 默认是 1，对彩色材质是灾难**。clearcoat + 高 env 会给彩色塑料罩一层白，
   饱和的红黄蓝绿直接变粉彩色（QUADRO 就栽过）。塑料 0.22-0.35、木头 0.6、金属 0.8-0.95。

贴图密度要随家具尺寸变，否则 40cm 床头柜和 200cm 沙发纹理一样大。用 `texScaled(base, ft, per)`：
把缩放吸附到固定几档再缓存——**每 clone 一次纹理都会多一次 GPU 上传，绝对不能按件克隆**。

### 5.4.8 程序化全景预设（S4a 经验，S4b 加预设时必读）

`panorama(preset, night)` 生成 2048×1024 等距柱状贴图（PMREM 环境光 + 室内背景 + 光追环境共用一张）。
四条从返工里换来的规则：

1. **地平线高度是物理量，所有预设必须一致**（`HZ=0.54`，与现有 city 相同）。从同一高层视角看，
   真地平线在同一个高度。seaview 初版用 0.42 → 辉光带被推到窗户可见切片之外，夜景全黑。
   判断窗口里能看到全景的哪一段：FP 视角眼高 5.35ft 平视 → 窗口显示大约 y 35%–60%。
2. **夜景必须有「全宽辉光带」**（横跨 0..W 的地平线渐变 + 散点灯）：
   单靠局部元素（几栋亮窗的楼）在远处读不出来；city 夜景能读就是靠这条。任何窗向都要能看见。
3. **辉光带要画在遮挡物之后**（山体/地面填充之后）：郊区夜景的暖带先画在山体前 → 被山体盖住，
   挪到山体+地面之后才出来。
4. **预设名是一张表，不是一串字符串**：`ENV_TINT`（色温）与 `PANORAMA_GEN`（生成器）与 `ENV_BTNS`（顶栏）
   必须同一套键，而 `ENV_TINT` 同时就是「合法预设名」的唯一清单——它现在住在 `loadDoc()` 前面，
   `cleanDocEnv()` 在文档进入应用的那一刻把 `env.preset` 洗成合法名（存档/导入只保证它「是个字符串」）。
   消费端（`applyLightMode` 的 fp 分支）再兜底一层。**雾色不跟预设走**（硬编码），因为雾的近/远界
   是 130/430ft，室内几何进不了雾区——注释得说实话（§5.1）。
   另：光追/照片级渲染进行中 `setPreset`/`setDayNight`/`setLights` 一律拒收（样本均值不能混两种光照，§5.5）。

验证窗口可见性的最快方法：临时页注入 `setView('fp'); setTimeout(()=>{setPreset(p); setDayNight(n)},2000)`
（setView 后 three 是异步建好的，立刻调 setPreset 会被 `if(!three) return` 丢掉）。
截图后裁窗口区域数亮度（mean/max lum），比全图缩放目检可靠。

**S4b（2026-10-10）：矩阵补齐成 10 个，并且三条规则全部进 bench**

| 预设 | 种子（昼/夜） | 关键构件 |
|---|---|---|
| `seattle-city` | 1007 / 8926（**钉死**，逐字节不变） | 天际线 + 夜全宽辉光带 |
| `suburban` | 2101 / 10020 | 低层 + 树冠 + 远山；夜=山谷暖带 |
| `seaview` | 2102 / 10021 | 水面 + 天际线；夜=灯光倒影 |
| `forest` | 2103 / 10022 | 四层山脊（大气透视：远=浅而偏蓝）+ 针叶树线剪影 + 薄雾带；夜=星空月亮 + 月照雾辉光带 + 零星山屋灯 |
| `courtyard` | 2104 / 10023 | 绿篱 + 中景树 + 修剪草坪条纹 + 园路梯形；夜=沿园路的暖路灯（光柱 + 地面光斑）+ 全宽辉光带 |

`bench/t_3d.js` 的 `s4b-*` 把三条规则变成可测断言（不靠目检）：

- **地平线一致**：`PANORAMA_GEN[p].toString()` 里抓 `HZ = Math.round(H*0.54)` 的系数，五个预设必须都是 0.54。
  （读生成器源码，不是「断言照抄实现」：改坏任何一个预设的地平线就红。）
- **任何窗向都看得见**：量贴图本身 y 35%–60% 切片的 mean/max 亮度（mean ≥ 25、max ≥ 150）。
  实测 mean：昼 146–192，夜 36–51；max 全部 185–236。
- **夜景全宽辉光带**：y 42%–62% 切片里逐列（步长 8）取最大亮度，统计 `<18` 的暗列数——新预设要求 **0**。
  历史 `seattle-city` 夜有 5 个暗列（种子钉死，改它=改基线）→ 只报不 gate。
- 另加：10 张尺寸 2048×1024、两两互异、清 `_skyCache` 重生成逐像素相同、`ENV_TINT` 每个预设都有行、
  两个新按钮生效且写进 `DOC.env`、顶栏单行不溢出。

加预设时踩到的（都已在渲染图里目检过）：

- **俯瞰的林地不是「草坪上撒豆子」**：稀疏圆斑（210 个、半径 8–30）读成一片绿地上的点阵。
  林冠必须**密集成片**（430 个重叠、半径随深度 10–56）+ 深色底，缝隙才读成树冠之间的阴影。
- **灌木不许长在园路里**：园路是个梯形 → 按 `t=(y-y0)/(H-y0)` 解出该行的左右边界，落在带内就重投（重试上限 8 次，否则死循环）。
- **辉光带画在遮挡物之后**（规则 3 的又一次实例）：forest 的月照雾带必须画在四层山脊 + 树线 + 地面 + 树冠之后，先画就被山体盖住。
- **FP 视图的 headless 截图在本机不可用**：`setView('fp')`（甚至 `setView('3d')` + 夜晚）在 swiftshader 下 0% CPU 挂死，
  连改动前的 `planner.html#3d` 也一样。所以昼夜/窗景的证据一律回到**量全景贴图本身**（上面那三条），
  别在「截一张室内图」上耗时间。
- **探针页必须每次从当前 `planner.html` 重新生成**：改完 CSS 忘了重建探针页，测出来的是旧样式 →
  得出「CSS 没生效」的假结论（实测白跑三轮）。同理 `work/doll_probe.html` 这种「从探针页复制出来的副本」不会跟着
  `_mk_fp_probe.py` 重新生成，要一并重建。
- **顶栏宽度**：加两个按钮后「3D 视图下单行」的窗口宽度阈值从 ~1350 移到 ~1380。
  `#topbar` 原先没有 `flex-wrap`，窄窗口下不是换行而是**标题内部折行**（48→66px）并且 `#envSeg` 被 `overflow:hidden` 裁掉（1024 下裁 5px）。
  现在 `#topbar{flex-wrap:wrap}` + 标题 `white-space:nowrap`：1700/1400 仍是单行 48px（黄金基线不受影响），
  ≤1360 干净地换两行 90px，**任何宽度都不裁切**。遗留：窄窗口下 2D(48)↔3D(90) 高度不同 → 切视图画布会跳
  （改动前 48↔66 也跳，只是幅度小）；彻底解法是 §5.2 的「控件用 `visibility` 占位」，本期未做。


## 5.4.1 价格与币种

目录条目的价格字段：

| 字段 | 含义 |
|---|---|
| `price` | 美国实际标价（USD） |
| `priceCA` | 加拿大实际标价（CAD） |
| `caVar` | 有加拿大价，但那是同型号的**另一个面料/配置**（界面上给提示） |
| `caNA` | 加拿大不售（加元视图显示「加拿大无售」，不做折算） |

**两地差价远不止一个汇率**，这是实测数据：目录里 102 件同时有两地实际标价，
`CAD/USD` 比值**从 0.59 一直到 1.64，中位数正好 1.00**，而同期汇率约 1.38。
按汇率折算几乎每件都是错的（BILLY：美国 $79，折算应是 CA$109，实际 CA$90）。
所以规则是：**哪个币种有当地实际标价就直接用，只有缺的那一边才折算，且必须标 `≈`**。

抓 IKEA 加拿大价的办法（`curl` 会被反爬掐掉价格字段，必须用 Chrome 渲染）：

```bash
"$CHROME" --headless --disable-gpu --virtual-time-budget=16000 --dump-dom \
  "https://www.ikea.com/ca/en/p/<slug>/" | grep -o '"product_prices":\["[0-9.]*"\]'
```

美国 slug 在加拿大常常不存在（不同货号），这时走站内搜索 API：

```bash
curl -sL "https://sik.search.blue.cdtapps.com/ca/en/search-result-page?q=<关键词>&size=12"
```

**抓完必须做异常值体检**：拿 `CA/US` 比值排序，落在 0.55~2.2 之外的多半是抓到了
系列落地页而不是商品页（MALM King 抓出 CA$25 就是这么来的）。

## 5.4.2 固定灯具不计价

筒灯 / 吸顶灯 / 镜前灯 / 吊灯是**公寓自带的**，跟购物无关。
`isBuiltIn(spec)` 就是 `isLight(spec)`（正好是那四个 kind，落地灯 `lamp` 不在内）：

- 目录里这些条目**没有 price / priceCA 字段**，价格列显示「公寓自带」
- 不进采购清单计数、不计入合计（合计尾部注明「N 件固定灯具不计价」）
- 但仍单列一节可点选/删除，仍可调色温亮度——只是跟钱无关

## 5.4.3 视图与单位（v3.3 重构）

**视图只有三档**：`state.view` = `'2d'` | `'doll'`(3D 俯瞰) | `'fp'`(室内)。
后两档共用同一个 WebGL 画布，只是相机模式不同，所以代码里问的是 `is3D()` 而不是
`state.view==='3d'`。`setView('3d')` 保留了兼容映射（→ `'doll'`），旧测试台不用改。

历史包袱：原来是「2D / 3D」两档 + 3D 之下再套「娃娃屋 / 室内视角」，白多一层。
`setCamMode()` 现在会同步回写 `state.view`——相机档位就是视图档位。

**光追只在室内视角出现**。俯瞰是掀了天花板的剖切图，路径追踪出来的光照根本不成立
（天光从掀掉的屋顶直接灌进来），所以 `#btnPT` / `#ptSeg` / `#ptDnSeg` 只在 `fp` 下显示。

**长度单位统一走 `fmtLen(ft, {precise})`**：
- `'cm'` → 公制厘米
- `'ft'` → 英尺+英寸，美国房产写法（`13' 2"`、`6"`、精确模式到 1/4 英寸 `1' 1/4"`）

内部一律用英尺存储，只在显示时换算。**房间尺寸标注不能写死字符串**——
`LABELS` 里存 `wd`/`dp` 英尺数值，画的时候才格式化，否则切单位数字不变
（这正是 v3.2 之前的 bug）。切单位要 `build2D()` 重画整张平面图，只重画家具不够。

## 5.4.4 2D 量尺寸

`meas` 状态机 + `#meas` 图层。点一下定起点、移动实时预览、再点落定，可连续量多条；
按住 Shift 锁定水平/垂直；Esc 或再点按钮退出；「清除」删除全部。
标注长度走 `fmtLen(..., {precise:true})`，跟着单位切换走。
标注的线宽/字号都要除以 `svg.getScreenCTM().a`，否则缩放后大小会跟着变。

## 5.4.5 侧栏

左右面板都能收起（收起后留一条竖 tab 点回来）和拖宽，宽度与折叠状态存在
`localStorage('planner_panels_v1')`。

**目录是卡片网格不是列表**。挑家具是个费眼的活，靠的是看图：
`.catGrid` 用 `repeat(auto-fill, minmax(150px,1fr))`，所以面板越宽每行卡片越多。
缩略图渲染分辨率 320×240（4:3），卡片按 `background-size:contain` 显示。

## 5.4.6 `#calib` 与 UI 布局的耦合（重要）

校准截图是**按固定像素偏移裁剪**的（2400×1500 窗口裁 `(72,369)` 的 1674×1360），
所以**任何改变画布宽度的 UI 改动都会让整张图位移**，md5 直接变——
v3.3 把目录面板从 270px 加宽到 400px，32.5% 的像素就对不上了。

解法不是更新基线，而是**让 `#calib` 锁死旧版布局**：`body.calib` 那几条 `!important`
把 `#catalog` 固定回 270px、`#props` 回 250px、隐藏分隔条/折叠条/面板头，
`applyPanels()` 在 CALIB 下直接 return。这样校准回归从此只验几何，不受 UI 影响。

同理，**房间尺寸标注在 CALIB 下必须用原始写死字符串**（`LABELS[].d`），
不能跟着单位切换变——`fmtLen` 格式化出来的 `13' 2"` 和原来的 `13'2"` 差一个空格，
足以让 md5 变掉。

排查位移类差异的办法：把 HEAD 版本也渲一张，两图逐像素 diff。
差异像素占比 30%+ 且包围盒覆盖全图 = 位移，不是局部改动。

## 5.4.7 家具建模的两条硬约束

**一、占地尺寸必须诚实**。`spec.w/d/h` 是 2D 图例、碰撞检测和采购清单共用的口径，
建模不能超出它，也不能虚报（声明一个大盒子让断言轻松通过）。
`t_3d.html` 的 `lunix-fits-footprint` / `lunix-footprint-not-inflated` 就是守这个的：
填充率必须落在 92%~102%。

如果一件家具**本来就带散件**（Lunix 那 14 块海绵，摆成沙发只用掉 8 块），
正确做法是**把散件也建出来、散放在旁边，然后把它们算进占地**，而不是不建。

两个配套要求：
- 散件位置**不能从 `spec.w/d` 反推**——改了 spec 又会改变包围盒，来回收敛不了。
  用相对主体的固定偏移摆，最后统一把整组水平重心归零。
- 模型末尾要做一次重心归零：`Box3.setFromObject(C.g)` 求中心，再把所有 children
  的 `position.x/z` 减掉。2D 图例和碰撞都假定家具原点 = 占地中心。

**二、所有部件必须贴地，不能沉到地板以下**。
`t_3d.html` 的 `lunix-on-floor` 断言 `bbox.min.y > -0.02`。

最容易翻车的是**复合欧拉角**：给一个 mesh 同时设 `rotation.x` 和 `rotation.y`，
three 按 XYZ 序复合（`R = Rx·Ry·Rz`），块会被转翻。两个实测案例：
- 三棱柱同时设 `rotation.x=-90°, rotation.z=0.55` → 沉到地下 17cm
- 半圆柱用 `CylinderGeometry(..., 0, PI)` + `rotation.set(-90°,0,-90°)` → 圆面朝下，
  整块沉一个半径（17.5cm）

正确姿势：
- **旋转和落地分开**：mesh 只负责"形状 + 抬到地面"，外面套一个 `Group` 只负责绕竖轴转向
- **能用形状表达就别用旋转**：半圆柱直接拿半圆 `Shape` 挤出（直边在 y=0），
  比拿圆柱转两下可靠得多
- `C.ext(..., 'xz')` 的挤出方向是 **-y**，要把 `position.y` 抬一个厚度

排查手法：逐 child 打 `Box3` 的 y 范围并按 max 排序，一眼能看出是谁

## 5.5 GPU 路径追踪（`ptRender`）

浏览器里**拿不到显卡的 RT core**：WebGPU 至今没有 ray query / ray tracing pipeline，
WebGL2 更没有。所以这是「用 GPU 的通用计算单元跑软件光追」——
自建 BVH → 打包进 RGBA32F 纹理 → 片元着色器栈式遍历 → 逐帧累积。

管线：`ptCollect()` 收集全场景三角形 → `ptBuildBVH()` 分箱 SAH → `ptBuild()` 打包纹理
→ G-buffer 两趟（albedo / 法线+深度）→ 分块累积 → À-Trous 降噪 → ACES + sRGB。

踩过的坑：

- **每帧 `renderer.setSize()` 会重建默认帧缓冲**，进度看起来完全不动。只在开头设一次。
- **`visibility()` 用「找最近交点」循环等于跑好几遍完整遍历**。阴影光线要写成 any-hit：
  撞到不透明面立刻返回，遇玻璃衰减后继续。
- **GPU 是异步的**，CPU 光按 `performance.now()` 判断会把命令队列排爆、界面失去响应。
  每帧的分块数要有硬上限。
- **进度卡住然后突然结束 = GPU 看门狗把上下文重置了**，不是噪声问题。
  用户看到的现象：进度停在某个百分比很久，然后一下子跑完，出图像只跑了一半、
  满屏点点。机理是单个分块的 draw 太长触发驱动重置，累积缓冲被清空，
  但采样计数还在涨，最后除以完整 spp 就得到一张欠曝多噪的图。三件事一起做：
  （a）分块细到 8×8，单个 draw 短到踩不到看门狗；
  （b）监听 `webglcontextlost`，丢了就停下来如实告诉用户完成了多少采样，
       而不是假装跑完；
  （c）用 `gl.fenceSync` 让 CPU 等 GPU 真画完再排下一批——
       `renderer.render()` 只是排队就返回，不等的话队列越堆越深，
       最后卡在某次提交上不动，进度条也跟着假死。
- **分块数不能拍脑袋定死**。同样 8×8，强显卡上一块 3ms、弱显卡上可能 300ms。
  实测决策表（`ptPickGrid` 的输出，标准档 900k 像素）：

  | 每像素耗时 | 选中格子 | 单块耗时 |
  |---|---|---|
  | 0.05–1 µs（强显卡）| 4×4 | 3–56ms |
  | 2 µs | 8×8 | 28ms |
  | 5–10 µs（弱显卡）| 16×16 | 18–35ms |
  | 20–50 µs（极弱）| 32×32 | 18–44ms |

  所以 **8×8 只在 2µs/像素附近是对的**，两头都不合适。做法是把决策抽成纯函数
  `ptPickGrid(perPx, px, minTX, maxTX, tileMax)` / `ptAdjustGrid(...)`：
  开跑前先画 1/64 画面标定一次选初始格子，之后每个**采样边界**（`tile===0`，
  保证每像素每轮恰好采一次）再按实测单块耗时校正。
  切到 32×32 仍超标就在进度条上提示用户降档。
  纯函数化不只是为了整洁——**真实 GPU 计时在 headless 下测不到**
  （虚拟时间冻结 `performance.now()`），只有把决策抽出来才测得了。
- **光追测试必须跑在有家具的场景上**。空屋只有 2.7 万三角形、2 盏灯，
  BVH 深度和光源采样的开销都不真实。`t_pt.html` 现在铺了一整套客厅（约 10 万三角形、
  22 件家具含 8 盏筒灯），另有 `work/pt_stress.py` 的 4 套布局（20/34/21/52 件，
  6 万~24.6 万三角形）做端到端压力测试，布局同时导出在 `work/layouts/*.json`，
  可以直接用界面的「导入布局」载进去手动看。
- **孤立亮点要区分萤火虫和 NaN**。判据是提高采样数后亮点是否衰减：
  实测 8spp 0.41% → 32spp 0.16%，说明是未收敛的高方差样本；NaN 被加法混合永久累进，
  完全不会衰减。所以亮点阈值要随 spp 收紧（`0.02/√spp`），不能定死。
- **满家具场景里「降噪降了多少」要换个读法**。拉普拉斯量的是高频能量，
  而边缘和贴图本身就贡献大量高频、降噪器又是保边的——空屋能降 63%，
  满屋 15~30% 就是正常的，不是降噪失效。
- **渲染这块必须用 headful 真机验证**（`work/headful_test.py`）。
  headless + swiftshader 测不到真东西：`fenceSync` 不 signal、虚拟时间冻结
  `performance.now()`、也没有真正的 GPU 看门狗。做法是起个本地 HTTP 服务器
  （headful 拿不到 `--dump-dom`），页面跑完把结果和出图 POST 回来。
  Apple M2 实测（D 布局 246,333 三角形 / 31 盏灯 / 52 件家具）：

  | 档位 | 采样 | 用时 | 分块 | 单块耗时 | 上下文 |
  |---|---|---|---|---|---|
  | 草稿 | 120/120 | 60s | 标定 16×16 → 运行中降到 8×8 | 6ms | 未丢失 |
  | 精细 | 900/900 | 398s | 4×4 | 29ms（峰值 62ms）| 未丢失 |

  单块 29ms 对 2s 的看门狗阈值有近 70 倍余量；栅栏节流在精细档生效了 12289 次。
- **两个只有真机才暴露的画质 bug**（headless 的小图看不出来）：
  1. **降噪的颜色相似度 σ 不能用绝对值**。室内日光场景的辐照度量级是 1~3，
     而原来的绝对 σ 只有 0.03 量级，于是每个邻居都被判成「边缘」拒绝，
     整个 À-Trous 形同虚设。要改成相对局部亮度：
     `exp(-dot(dc,dc) / (uSigC * (dot(c0,c0) + 0.05)))`。
  2. **深度权重要沿局部深度梯度比，不能直接比深度差**。天花板、地板这类掠射面上
     相邻像素深度本来就变化快，直接比会把邻居全拒掉——滤波恰好在最需要它的
     大片间接光区域失效。用中心差分估 `gz`，按 `z0 + dot(gz, off)` 外推后再比残差。
- **不要把光栅的假环境光原样叠到路径追踪上**。光栅视图靠 `amb + hemi` 假装全局光照，
  而光追是**真的**在算 GI——两者相加等于把房间塞进一个发光白球里：
  对比度整体被抹平、窗外城市糊成一片灰、**白色家具（KALLAX 这种白格架）
  直接和白墙融在一起看不见**（用户报的「KALLAX 快隐身」就是这个）。
  做法是只保留很小一份当天光残留（`AMB_FILL = 0.32`），
  同时把环境贴图权重给足（`uEnvInt` 0.42 → 1.0），让日光真的从窗户进来。
  `t_pt.html` 的 `pt-kallax-visible` 用「格架区域亮度标准差 > 18」守着这条——
  标准差小 = 糊成一片。
- **排查「光追里某个东西不见了」的顺序**：先查材质是不是被当成玻璃
  （`transparent && opacity<0.75` 会被赋 `trans=0.93`），
  再用 CPU 射线打一条过去看命中链，最后直接取环境贴图在该方向的像素值对照。
  这次查下来光追其实是对的——窗外偏暗是因为全景图在那个方向本来就是
  rgb(72,85,117) 的深蓝，问题在别处（环境光填充）。
- **出图视野跟着窗口布局走，而它决定噪声统计量**。`rw/rh` 由 `canvas.clientWidth/Height`
  按 `maxPx` 缩放算出，着色器里 `dc = (ndc.x·uTanHalf·uAspect, ndc.y·uTanHalf, -1)`，
  `uAspect = rw/rh` —— 画布长宽比一变，光追看到的场景范围就变，孤立亮点、均值/标准差
  这类量全部跟着变。要可比较就用 `ptOpts.size` 钉住出图尺寸（界面不传，行为不变）。
  排查这类问题先打 `window.__PT_DIAG`（实际完成采样 / 请求 / 画面尺寸 / 分块 / fence 是否退化
  / 上下文是否丢失）：没有这些量，「占比不对」无法区分「未收敛的萤火虫」「NaN 累进」
  「取景不同」三种解释（E25 实例：三者里只有取景不同）。
- **萤火虫要在降噪之前压掉**。À-Trous 的颜色权重会把孤立超亮样本当成边缘保留，
  越滤越突出。在解调 pass 里做一道 3×3 抑制：超过「八邻域最大值」和「均值×3」
  中较宽松者就压回去（邻域也亮的地方不动，真实高光不受影响）。
  实测孤立亮点 0.078% → 0.006%。
- **fence 必须能退化**。swiftshader 下 `clientWaitSync` 根本不 signal，
  死等会比不节流还慢（每步白等上百次轮询）。连续几次等不到就把 `useFence`
  关掉、退回按帧排一整轮。兜底判据要用**轮询次数**不能用时间——
  `--virtual-time-budget` 会冻结 `performance.now()`，基于时间的超时永远不触发。
- **NaN 必须在写出前挡掉**。加法混合会把 NaN 永久累进累积缓冲，那个像素从此
  是个洗不掉的亮点。`min`/`clamp` 碰到 NaN 行为未定义，挡不住，要显式
  `L = mix(vec3(0.0), L, vec3(equal(L, L)));`
- **降噪是画质的分水岭**。室内场景天光只能从窗户进来，弹射一次就逃出去的概率很低，
  低采样必然噪。À-Trous 按法线/深度/颜色差加权，**输入必须先除掉 albedo、滤完再乘回**，
  否则贴图细节被一起抹平。实测同样 8 spp 下噪点降 63%。
- **`--virtual-time-budget` 下 0ms 定时器链会饿死长间隔定时器**，`setInterval` 测不到进度。
  测 UI 文案变化要用 `MutationObserver`。

## 5.6 目录缩略图

侧边栏每件家具是用**独立的小 WebGLRenderer** 渲的 3/4 视角图（`furnThumb`），
不是色块。按需渲染（`IntersectionObserver` 滚到可视区才画）+ `_thumbCache` 缓存，
所以开局不卡、搜索重建列表时直接命中缓存。灯具单独处理成**仰视**——
吸顶灯俯视只能看到一个盘子。

取景分两遍：先按包围盒八角投影迭代贴合，再**渲一遍读 alpha 通道按真实剪影收紧并居中**。
只按包围盒取景会白留三四成画面——开放式框架（爬爬架）和平面旋转过的矩形（爬行垫）
的包围盒角全是空气。扁平件（`size.y < 0.22*max(x,z)`）要换成俯视，25° 仰角看地毯就是一条线。

**`physicallyCorrectLights = false` 时 three 会把光照乘 π 作补偿**，按物理直觉给的强度
会高出三倍多，浅色件直接推成纯白——沙色和石灰色两个配色的缩略图看起来一模一样。
缩略图渲染器这组光照值（amb .22 / hemi .28 / key .55 / fill .18）是实测调出来的，
`t_3d.html` 里有条 `thumb-color-variants-differ` 断言专门守着这个回归。

判断缩略图是否有内容要**解码后数不透明像素**，不能看 PNG 字节数：简单形状压得极小，
1.9KB 也可能是张正常的图。

### 5.7 经典脚本 → ESM（2026-09 E1 实测踩的 7 个坑）

E1 把 `app.html`（当时还叫 `planner.html`）的内联脚本搬进 esbuild 管线（bundle 出单文件 dist，行为必须逐字节等价）。
classic script 和 ESM 的**作用域语义差异**是全部麻烦的来源，七个坑都真的发生过：

| 坑 | 症状 | 修法 |
|---|---|---|
| **classic 顶层名有两层暴露**：var/function → window 属性；let/const → 全局词法环境（跨 script 共享但**不在** window）。ESM 把两层都变私有 | 注入脚本（测试台）报 `state is not defined` | 构建末生成 globalThis 镜像，覆盖**全部**顶层声明（只镜像 var/function 不够——`state`/`wallEdit` 都是 let） |
| **块注释里的 C 风格代码被逐行正则误当声明**（如 `const float PI`） | 幻影名在运行时 ReferenceError，**未捕获异常杀死整个 IIFE**，它后面的名字全部镜像不上（症状：早声明的名字在、晚声明的不在，且无任何报错——异常发生在 IIFE 内部） | 扫描前先剥块注释（把注释体换成等长空行，保持行号对齐）+ 每条镜像语句用 typeof 守护 |
| **一次性赋值快照对「会被重新绑定的 let」永久失效**（`three`：模块求值末是 null，场景异步建好后才重新赋值；`saveGeo`/`drawFurniture` 同理） | 注入脚本读到的永远是旧值（null）——`Cannot read properties of null (reading 'controls')` | 镜像用 `Object.defineProperty` + **getter 闭包**：每次外部访问都读当前模块绑定（活绑定） |
| **getter-only 镜像挡住写入方**：sloppy classic script 对无 setter 的全局属性赋值**静默失败**（不报错！） | 测试脚本 `uidSeq++` 不生效 → 两个家具拿到**同一个 uid** → furnMap 互相覆盖（场景只剩一件、位置错到另一件）→ 拾取/拖动全挂，且无任何报错 | var/let/function 名必须带 **setter 闭包**（`set: v => { name = v }`——闭包写模块绑定合法）；const 保持 getter-only（原 classic 里给 const 赋值本来就会 TypeError） |
| **`THREE` 本身也是外部脚本的裸名**（原由 three.min.js UMD 挂到 window） | 测试台报 `THREE is not defined` | 入口前言加 `globalThis.THREE = threeLib`（threeLib = UMD 的 module.exports，可变对象，OrbitControls 能挂上去） |
| **顶层函数重复声明**（classic 里合法：后声明者胜出；ESM 里 SyntaxError） | esbuild 直接报语法错，构建失败 | 构建前 dedupe：只保留最后一个声明（复刻 classic 语义）。结束行判定用代码风格规则（col-0 的 `}`），不用花括号扫描器（正则字面量/字符串会让它失同步） |
| **多声明器顶层行只镜像第一个名字**（`const ITEMS_KEY = …, ITEMS_KEY_OLD = …`；旧正则只认无初始化的 `const a, b, c` 列表） | **source 页全绿、dist 页红**：注入脚本裸用第二个名字报 `ITEMS_KEY_OLD is not defined`（classic 里它在全局词法环境所以可见，ESM 里私有且没镜像），很容易误判成“dist 行为不同” | 按 depth-0 逗号切段、每段取开头标识符（字符串/正则里的括号可能让 depth 失同步，但只会多产生幻影名，而幻影名被 typeof 守护接住）；关键字取声明自己的（`let` 被误标成 `const` 就没了 setter，又踩回上一个坑） |

排查这一类问题的关键手法：**mirror 块首尾各插一条 console.log 标记** + 在 bundle **之前**注入
console 转发器（error/warn 都要，转发器在 bundle 之后注册会漏掉 bundle 内部的同步异常）。
「早名字在、晚名字不在 + 无报错」这个组合特征 = 块中间被未捕获异常截断。

## 7. 代码结构地图

| 行号附近 | 区块 |
|---|---|
| ~300 | `<script type="application/json" id="miniden-plan">` **户型 JSON**（S10：committed=generic；构建时注入 mine）。平铺字段：`name/roomSummary?/sc/ceilingH/floorpts/walls/inner/doors/fixed/labels/fx/patio?/isl?/calib?/refPhoto?/detailedKitchen`；`walls/doors/labels/floorpts/patio/isl` 单位 ft，`fx` 单位图纸 px |
| ~537 | `<script id="miniden-storage">` **存储门面**（E10：由 `scripts/build-storage.mjs` 从 `src/storage/` 编译，勿手改；build.mjs 逐字节校验）。它不依赖 schema，所以排在 schema 块前面；dist 里经典脚本先于 deferred ESM 执行 → 主脚本能直接拿到 `window.MINIDEN_STORE` |
| ~538 | 户型常量（`PLAN` 解析 + `SC/FLOORPTS/WALLS/…/effDoors`，原 538–737 手写几何块已全部外置；`detailedKitchen` 门控硬编码厨房块） |
| 693 | 状态、持久化、`effWalls/effFixed/effDoors`（**唯一几何出口**）；`planOf(k)` + `planSnapshot()`（S11b：户型专属快照，文档优先、回退 PLAN） |
| 785 | 2D SVG 渲染（`wallPolys` / `build2D` / `furnShape` / `drawFurniture`） |
| 1499 | 墙体编辑器（`wallEditDown/Move/Up`、`doorLinkage`、吸附） |
| 1978 | 3D 渲染（贴图生成、`buildStatic3D`、门窗、洁具、厨房） |
| 2824 | 照片级渲染（GPU 浮点累积） |
| 2990 | 逐商品建模注册表 `MODELS` + `modelCtx` 建模 API |
| 4358 | UI（目录、检视面板、视角、日夜、加载提示） |

**几何数据流**：`#miniden-plan` JSON（S10：plan 外部化；committed=generic / 本地构建=mine，逐位精确）→ `PLAN` 常量 + `DOC`（`ProjectDoc`：内置+用户实体，id 寻址，S1 Phase 2b 后唯一几何状态）→ `effWalls()/effFixed()/effDoors()`（文档投影，等价于旧版 Object.assign 语义）→ 2D 和 3D **共用同一份**。户型专属构件（中岛/落地窗带/阳台补板/厨房柜体/inner 薄墙）与参考（roomSummary/refPhoto/calib）存在 `DOC.plan`（`planSnapshot()` 从 PLAN 播种，`planOf(k)` 读取），所以导出/导入能带走（S11b）；`plan` 同样**不进投影**。洁具（马桶/台盆/浴缸/淋浴/台柜/镜子）也走文档：`effFixtures()` 返回 `DOC.fixtures`（S1 迁移：图纸 px/SC → ft）——2D `drawFixtures` 换算回 px 画、3D 直接用 ft（与旧 `F2(FX)` 逐位一致，3D 截图逐字节相同）；导入户型 fixtures=[] 时 2D/3D 都不画。**S6（洁具放置工具）**：墙编辑工具条「洁具」按钮（`data-t="fx"`，`#fxCtl` 里选类型/转角）：点击空地放新件（台柜/镜子自动贴最近实墙：长边平行、法向偏移=墙半厚+件半深、rot=墙角；其余浮放）；点击已有件选中→拖移/方向键 1cm（Shift 5cm）/删（仅 `src:'user'` 件可删，内置件拒删）；2D 每件 `<g data-fx>` + `rotate()` 变换、命中区加厚；3D 每件一个 `THREE.Group`（`rotation.y = -rot·π/180`，绕占地中心，rot=0 也包组但世界坐标不变）。`Fixture` 有 `rot?:number`（度，0=轴对齐）与 `src?:'user'`（仅类型，不进 JSON schema），`DOC_DATA_VERSION=2`（v1 内置文档丢弃重迁移，13 件 rot 缺省无损）。编辑层（`wallEdit.sel={kind,id}`、`segView/winView/doorView` Proxy）直写文档实体。新增任何消费几何的代码，一律走 `eff*()`，不要直接读 `WALLS`/`FX`（`#dump` 和 CALIB 分支是故意的例外；`FX` 常量现在只是 S1 迁移源）。

**投影键集合是冻结的（S1 字节等价红线）**：`docToLegacy` 输出的键必须与 legacy `eff*` 逐字节一致（fixture oracle 守着），**新的文档字段不能加进投影**（例：窗户 `style`/`frame`/`sill`/`head` 都不在 `effWalls` 投影里）。消费端需要这些字段时，用投影里的 `_id` 回查文档实体：`entById(s._id).style`（2D/3D 的窗款式渲染就是这么做的）。纯增量可选字段（`baseImage?`、`floorOutline?`）不进投影，消费端直接读 `DOC.xxx`。

关键常量：`SC=11.2`（图纸px/ft）、`CEIL_H=8.8`（层高ft，S11b 起是 `let`，随文档走）、`EYE_H=5.35`（人眼高）、
`DOOR_MIN=0.5`、`STUB_MIN=0.18`、`LINK_TOL=0.5`。

---

## 8. 如何扩展

### 8.1 加家具（完整流程 —— 照着做，别跳步）

> **先看有没有现成的 skill**：`.claude/skills/add-catalog-item/`（随 repo 版本控制）。
> Claude Code 里打 `/add-catalog-item`、或者说「加个 XX 进去」会自动加载；
> 别的 agent 把 `SKILL.md` 当作业指导书读就行。
> 那是精简可执行版，**本节是详细版，两边冲突以本节为准**。

这一节是被返工逼出来的。**每一步都有一道验收关，过不去就别往下走**；
最后那份「常见翻车清单」里每一条都真的发生过。

---

#### 第 0 步：先把实物看清楚

**绝对不要凭印象建模。** 拿到商品链接后第一件事是把官方图抓下来**用眼睛看**
（Read 工具能直接渲染图片，看就是了）。

```bash
mkdir -p work/ref
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
curl -sL -A "$UA" --max-time 40 "<图片URL>?width=1200" -o /tmp/x.webp
sips -s format png /tmp/x.webp --out work/ref/<名字>.png >/dev/null
```

商品页多是 JS 渲染的，`curl` 抓不到图片 URL，用 Chrome 渲染后再抓：

```bash
"$CHROME" --headless --disable-gpu --virtual-time-budget=20000 --dump-dom "<商品页>" > /tmp/pg.html
grep -o '"hiRes":"https://[^"]*"' /tmp/pg.html | head          # Amazon
grep -oE 'cdn\.shopify\.com/s/files/[^"]+\.(jpg|png|webp)' /tmp/pg.html | head   # Shopify
```

**要看的不只是主图**：找那张「零件分解图 / 尺寸标注图」，它会告诉你
一共几块、每块什么形状、关键尺寸标在哪。Lunix 沙发的 14 块海绵、
Avenlur 爬爬架的 8 个功能件，都是从这类图里读出来的。

参考图存进 `work/ref/`（已入库），后面复核和以后改模型都要拿它对照。

> 验收关：你能用一句话说清「这东西由哪几个部件组成、各自什么形状、**每部件是一块板还是两块**
> （中央单板 vs 两侧各一）、板面朝哪个方向、**前视图轮廓**（梯形/A/V/矩形）」。说不清就再找图。

---

#### 第 1 步：抓真实数据（尺寸 / 价格 / 全部配色）

**不要凭印象编尺寸。** 各站点的实测手法：

| 站点 | 手法 |
|---|---|
| IKEA 美/加 | Chrome 渲染后从埋点里取：`grep -o '"product_prices":\["[0-9.]*"\]'`。**`curl` 会被反爬把价格字段掐掉**，标题却是对的，很容易误判 |
| IKEA 加拿大 slug 不存在 | 走站内搜索 API：`https://sik.search.blue.cdtapps.com/ca/en/search-result-page?q=<词>&size=12`（返回 JSON，含 `salesPrice.numeral` 和 `pipUrl`） |
| Amazon | `id="productTitle"`、`"priceAmount":`、`"public_title"`（配色/规格变体）、`prodDetails` 表里的 `Item Dimensions D x W x H` |
| Shopify 独立站 | `"public_title"` 取变体，`dimensionValuesDisplayData` 取配色全集 |
| 页面根本不写尺寸 | 用 WebSearch 查零售商列表页（Best Buy / Amazon 常有），**查到什么写什么，查不到就说查不到，不要编** |

尺寸一律记 **cm**（`w`/`d`/`h`），坐具另记 `seatH`（座高）。

> 验收关：宽/深/高、价格、**全部配色**三样齐了。缺哪样就明确写在交付说明里。

---

#### 第 2 步：写目录条目

```js
{id:'xxx-0', cat:'沙发 / 单椅', name:'名称 · 配色', w:139.7, d:69.9, h:53.8,
 price:275.57, priceCA:274.97, color:'#主色', color2:'#辅色', seatH:23.9,
 model:'xxx', kind:'playCouch', wood:'pine', url:'...', note:'...'}
```

| 字段 | 说明 |
|---|---|
| `w/d/h` | cm。**必须是「整件东西的实际占地」**，包括散在旁边的配件（见第 3 步） |
| `price` / `priceCA` | 美国 / 加拿大**当地实际标价**，不是汇率折算（见 §5.4.1） |
| `caVar` | 有加元价，但那是同型号的另一个面料/配置，界面上会提示 |
| `caNA` | 加拿大不售，加元视图显示「加拿大无售」 |
| `color` / `color2` | 主色 / 辅色，模型里用 `C.col` / `C.col2` |
| `model` | 指向 `MODELS[...]`。**同款不同色共用一个 `model`**，靠 `color` 区分 |
| `kind` | 决定 2D 图例、通用建模回退、材质选择、碰撞高度区间 |
| `wood` | `pine`/`beech`/`birch`/`oak`/`walnut`，选木纹贴图 |
| `seatH` | 坐具座高（cm） |
| `dimmable` | 可调光的落地灯：**要花钱买**但需要色温/亮度控件（见 §5.4.2） |
| `note` | 材质、功能、特殊说明。尺寸口径特殊时**一定要在这里写清楚** |

**同款不同色 = 每个配色一个独立条目**（用户明确要求要能挑选）。

现有分类（截至 v3.4）：沙发 / 单椅、餐桌椅 / 吧凳、床 / 床头柜、收纳 / 电视柜、
书桌 / 办公椅、灯具 / 照明、地毯 / 爬行垫、茶几 / 边几、儿童 / 爬爬架。
**不要把性质不同的东西合并成一类**（用户为此提过意见：地毯和茶几和灯具本来就不是一类）。

现有 `kind`：`armchair bed bedMetal bookcase cart ceilingLight chair climber coffeeTable
crib desk deskSitStand downlight dresser lamp nightstand officeChair pendant playCouch
playMat rug shelf shoeCab sideTable sofa sofaL stool swivelChair tableDrawer tableFold
tableRect tableRound tvBench vanityLight`。加新 `kind` 要同时管三处：
`furnMats()` 的材质分类、`furnShape()` 的 2D 图例、`vSpan()` 的高度区间。

**商品名照写原文拼写**（POÄNG / RÅSKOG / SÖDERHAMN / IDÅSEN），不要为了好搜写成 ASCII。
搜索层用 `foldText()` 把查询词和商品名两边都折成 ASCII 再比对，
`poang` / `POÄNG` / `poäng` 都能搜到。出现新语种字母就往 `FOLD_EXTRA` 里补一行。

---

#### 第 3 步：建模

`MODELS['xxx'] = (C) => {...}`。没注册的会回退到 `kind` 的通用造型（能用，但细节差一档）。

`C` 提供的工具（`modelCtx`）：

| 方法 | 用途 |
|---|---|
| `C.w/d/h` | 已换算成**英尺**的尺寸（`C.cm(x)` 把 cm 转英尺） |
| `C.col` / `C.col2` / `C.seatH` | 配色与座高 |
| `C.it` / `C.cct` / `C.lum` | 当前实例（灯具模型读色温/亮度用） |
| `C.M(color, opts)` | 材质工厂，见第 4 步 |
| `C.box/rb/cyl/tube/sph/torus` | 方盒 / 圆角盒 / 圆柱 / 胶囊管 / 球 / 环 |
| `C.ext(pts, depth, mat, x,y,z, plane, bevel)` | 任意多边形挤出，`plane` 取 `'xy'`(默认,沿+z) / `'xz'`(平放,**沿 -y**) / `'zy'` |
| `C.lathe` / `C.cushion` / `C.legT` / `C.bar` / `C.knob` / `C.caster` | 旋转体 / 软包坐垫 / 锥形腿 / 长条拉手 / 球形拉手 / 脚轮 |
| `C.rep(n, fn)` | 阵列 |
| `C.m.{wood,fab,chrome,steel,black,white,plastic,leather,glass}` | 常用材质库 |

细节要求：**「几个方块拼一下」不算建模**。用户明确要求过「每个家具都需要单独建模，
从商品图片对着建」。参考量级：一件家具 2000–15000 三角形，
桌椅这类简单件也该有倒角、腿部收分、把手、缝线一类的细节。

**两条硬约束（详见 §5.4.7，这里只列结论）**：

1. **占地必须诚实**：包围盒对 `spec.w/d/h` 的填充率要落在 **92%~102%**。
   既不能超出（2D 图例和碰撞会错），也不能虚报（声明个大盒子糊弄断言）。
   本来就带散件的（Lunix 14 块海绵摆成沙发只用 8 块）——
   **把散件也建出来散放在旁边，然后把它们算进占地**，不是不建。
2. **所有部件贴地**：`bbox.min.y > -0.02`。

配套两条：
- 散件位置**不能从 `spec.w/d` 反推**（改 spec 又会改包围盒，来回收敛不了），
  用相对主体的固定偏移摆
- 模型末尾做一次水平重心归零。**模型里有旋转件时必须按真实顶点求 bbox**：
  `Box3.setFromObject` 对旋转 mesh 用的是局部包围盒的 8 个角点（过度估计），
  其中心与 `mergeByMaterial` 后真实顶点 bbox 的中心不一致，归零会偏 1cm 量级
  （lunix 实例：偏 7.9cm，`*-centered` 断言红）：

```js
C.g.updateMatrixWorld(true);
const bb = new C.THREE.Box3();
C.g.traverse(o=>{
  if(o.isMesh && o.geometry){
    const pos = o.geometry.attributes.position, v = new C.THREE.Vector3();
    for(let i=0; i<pos.count; i++){ v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); bb.expandByPoint(v); }
  }
});
const off = new C.THREE.Vector3(); bb.getCenter(off);
for(const ch of C.g.children){ ch.position.x -= off.x; ch.position.z -= off.z; }
```

**最容易翻车的是复合欧拉角**：给一个 mesh 同时设 `rotation.x` 和 `rotation.y/z`，
three 按 XYZ 序复合（`R = Rx·Ry·Rz`），块会被转翻、沉到地板以下。正确姿势：
- **旋转和落地分开**：mesh 只负责「形状 + 抬到地面」，外面套一个 `Group` 只负责绕竖轴转向
- **能用形状表达就别用旋转**：半圆柱直接拿半圆 `Shape` 挤出（直边落在 y=0），
  比拿 `CylinderGeometry` 转两下可靠得多

---

#### 第 4 步：材质与贴图（**不能跳过**）

有三道保障，但**别指望兜底**——兜底只保证「不是纯色平板」，好看要自己给：

1. `furnMats(spec, col)`：通用建模按 `kind` 统一发材质
2. `C.M(color, opts)`：没显式指定贴图时按金属度自动兜底
3. `ensureTextured(root)`：建完模再扫一遍，补掉分支里就地 `new` 的漏网材质

`C.M(color, opts)` 的 `opts`：

| opt | 效果 |
|---|---|
| `wood:'pine'` | 木纹贴图 + 法线 + 清漆 |
| `fabric:true` | 织物贴图 |
| `leather:true` | 素皮/皮革毛孔 |
| `plastic:true` | 注塑件橘皮 |
| `rough` / `metal` | 粗糙度 / 金属度 |
| `clear` / `clearRough` | 清漆层 |
| `sheen` / `sheenColor` | 丝绒/绒面高光 |
| `envI` | **环境反射强度** |
| `flat:true` | 显式退出贴图兜底 |

现成贴图：`woodSpecies(name)`（pine/beech/birch/oak/walnut）、`fabricTexture`、
`laminateTexture`（三聚氰胺板）、`carpetTexture`（地毯绒面）、`powderCoatTexture`（金属烤漆）、
`plasticTexture`、`leatherTexture`、`brushedSteelTexture`、`grayOakTexture`、`quartzTexture`、
`woodTexture`（地板）。

**该加新贴图就加，不要凑合。** 现有的凑不出实物质感（藤编、大理石、亚麻粗织、
磨砂玻璃、拉丝黄铜……）就新写一个：

```js
let _xxxTex = null;
function xxxTexture(){
  if(_xxxTex) return _xxxTex;
  srand(1016);                          // 固定种子！否则渲染不确定，回归测试失效（见 §11）
                                        // 已占用 1001~1015、2000+；挑个没用过的
  const N = 512, c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d');
  g.fillStyle = '#fdfcfa'; g.fillRect(0, 0, N, N);   // 基调接近白：靠 material.color 上色
  /* …用 rnd01() 画纹理… */
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 2);
  t.encoding = THREE.sRGBEncoding;       // 必须！否则被当线性图，渲染发白
  t.anisotropy = 8;
  _xxxTex = t; return t;
}
```

四条铁律：
1. **必须 `srand(种子)` 起头**，用 `rnd01()` 而不是 `Math.random()`——渲染确定性是回归测试的前提
2. **必须设 `t.encoding = THREE.sRGBEncoding`**，否则在 `outputEncoding=sRGB` 下渲染发白
3. **基调接近白**，颜色靠 `material.color` 相乘上色，这样一张贴图能服务所有配色
4. 法线贴图用 `normalFromTexture(tex, strength)`（有缓存，直接调）

**`envMapIntensity` 默认是 1，对彩色材质是灾难**。clearcoat + 高 env 会给彩色塑料罩一层白，
饱和的红黄蓝绿直接变粉彩色（QUADRO 就栽过）。参考值：塑料 0.22–0.35、织物 0.12–0.20、
木头 0.6、金属 0.8–0.95。

**贴图密度要随家具尺寸变**（40cm 床头柜和 200cm 沙发纹理不能一样大），
用 `texScaled(base, ftSize, per)`——它把缩放吸附到固定几档再缓存，
**绝对不能按件 clone 纹理**，每 clone 一次就多一次 GPU 上传。

同理，`sheen` 给大了整块会被冲成白的（Lunix 第一版 `.55` 就白了，`.22` 才对）。

---

#### 第 5 步：2D 图例

在 `furnShape()` 里给新 `kind` 加俯视符号。没加会落到通用圆角矩形——能用但读不出是什么。
参考 `climber` 那条：外框 + 横档示意 + 对角线。

---

#### 第 6 步：验证（四道关，全过才算完）

**关 1 —— 语法 + 全目录体检**（最省事，先跑这个）

```bash
python3 -c "
import re
h=open('app.html').read(); m=re.search(r'<script>\n(.*?)</script>', h, re.S)
open('/tmp/p.js','w').write(m.group(1))" && node --check /tmp/p.js
```

然后跑 `work/t_3d.html`，看这几条：

| 断言 | 守的是什么 |
|---|---|
| `catalog-all-build` | 每个目录条目都能建出模型，不抛错 |
| `catalog-all-textured` | 每件家具的材质都有 `map` |
| `catalog-all-normalmapped` | 都有 `normalMap` |
| `catalog-tri-avg` / `catalog-tri-max` | 三角形数没失控 |
| `thumb-renders` | 缩略图渲得出来、取景贴合 |

**关 2 —— 包围盒 / 填充率**（新家具一定要单独量）

```js
const g = furn3D({uid:-1, ref:sp.id, x:0, y:0, rot:0}, sp);
g.updateMatrixWorld(true);
const b = new THREE.Box3().setFromObject(g);
const sz = new THREE.Vector3(), ct = new THREE.Vector3();
b.getSize(sz); b.getCenter(ct);
// 填充率 sz.x/cm2ft(sp.w) 等三项要在 0.92~1.02
// 重心 ct.x, ct.z 要 ≈ 0；b.min.y 要 > -0.02
```

出问题时**逐 child 打 y 范围并按 max 排序**，一眼能看出是哪块沉下去了。

**关 3 —— 隔离渲染目检**（这一关最容易被跳过，但最有用）

```js
three.staticGroup.visible = false;                       // 别被墙挡住
three.scene.background = new THREE.Color(0x1b1f26); three.scene.fog = null;
const g0 = three.furnMap.values().next().value.g; g0.updateMatrixWorld(true);
const bb = new THREE.Box3().setFromObject(g0), sz = new THREE.Vector3(), ct = new THREE.Vector3();
bb.getSize(sz); bb.getCenter(ct);
const dir = new THREE.Vector3(0.5, 0.42, 1).normalize();
let dist = sz.length() * 0.5 / Math.tan(34 * Math.PI / 360) * 1.05;
const cs = []; for(let i = 0; i < 8; i++) cs.push(new THREE.Vector3(
  (i&1)?bb.max.x:bb.min.x, (i&2)?bb.max.y:bb.min.y, (i&4)?bb.max.z:bb.min.z));
three.cam.fov = 34;
for(let k = 0; k < 4; k++){                              // 按包围盒八角迭代贴合
  three.cam.position.copy(ct).addScaledVector(dir, dist); three.cam.lookAt(ct);
  three.cam.updateMatrixWorld(true);
  three.cam.matrixWorldInverse.copy(three.cam.matrixWorld).invert();
  three.cam.updateProjectionMatrix();
  let mx = 0; for(const c of cs){ const q = c.clone().project(three.cam);
    mx = Math.max(mx, Math.abs(q.x), Math.abs(q.y)); }
  dist *= mx / 0.86;
}
three.cam.position.copy(ct).addScaledVector(dir, dist); three.cam.lookAt(ct);
three.controls.target.copy(ct); three.controls.enabled = true; three.controls.update();
requestRender();
```

**两个必踩的坑**：
- 手摆完相机**必须同步 `controls.target` 再 `controls.update()`**。
  `OrbitControls.update()` 每帧会按它自己的内部状态把相机拉回去，画布会是空的
  （`controls.enabled=false` 也拦不住）
- 测试里给场景加光要克制：`physicallyCorrectLights=false` 时 three 会把光照乘 π 补偿，
  按物理直觉给的强度会高出三倍多，浅色件直接推成纯白，配色全看不出差别

**关 4 —— 和实拍图逐项比对（硬条件）：先三视图反推，再对 3/4 视角**（对着 `work/ref/` 里的图看）

**三视图是正交轮廓的仲裁者**（用户 2026-09 指出：永远只对 3/4 斜视角会分辨不出
建模错误——轮廓形状、部件朝向、悬空/穿透只有正交视图里才露馅）：

1. **从商品页照片反推三视图**：商品图多是 3/4 斜视角，先看够多的张（正面、侧面、背面、细节），
   反推出**前 / 左（侧）/ 俯**三个正交轮廓：主轮廓线、各部件相对位置与朝向、哪个面可见什么。
   **同时提取结构组成**（2026-09 木马/麋鹿返工教训）：每个部件是**一块板还是两块**
   （中央单板 vs 两侧各一，前视图会露馅：一板 vs 两平行板）、板面**朝向哪**
   （侧面可见 vs 正面可见）、**前视图是梯形/A/V 还是矩形**。
   大多数商品不给三视图，这一步就是 reverse engineering，反推完先在心里把轮廓说出来。
2. **把模型渲出同样的三个正交视角**（`work/threeview_probe.html`：ortho 相机，
   前=朝 -x 看前端 +x、侧=朝 -z、顶=朝下）与反推图逐项比：轮廓、比例、部件位置/朝向、悬空穿透。
3. 三视图对齐后再看 `check-item.py <条目id>` 的主/侧 3/4 图核对质感细节（纹理密度、
   颜色、sheen/envI 过曝）。某张正交视角找不到视角足够接近的参考图时，补抓变体图/细节特写再对照。

- [ ] **三视图对齐**：前/侧/俯轮廓与反推一致？（A 架是 A 不是 V、悬空件、穿透、嘴鼻/靠背朝向）
- [ ] 部件数量对不对？（14 块就得是 14 块）
- [ ] 各部件的**形状**对不对？（方 / 圆 / 楔形 / 带孔）
- [ ] 各部件的**相对位置和朝向**对不对？
- [ ] 比例对不对？（拿图上标注的尺寸比一比，别只看整体高度）
- [ ] 颜色对不对？（渲染出来发白就是 sheen / envMapIntensity 给大了）
- [ ] 材质像不像？（木纹 / 织物 / 塑料 / 金属，纹理密度合不合理）
- [ ] 特征细节在不在？（把手、缝线、螺丝、logo、脚垫）

**最后照 §2 走完整回归**：重新生成测试台 → 全跑 → `#calib` md5 核对 → 目检 → 提交。

---

#### 常见翻车清单（每条都真的发生过）

| 症状 | 原因 |
|---|---|
| 家具在 2D 图上比 3D 里小一圈 | 建模超出了 `spec.w/d`，或者散件没算进占地 |
| 家具半截埋进地板 | 复合欧拉角把块转翻了；`C.ext(...,'xz')` 忘了抬一个厚度（挤出方向是 -y） |
| 成品比 spec 大一圈 | `C.ext(..., bevel)` 的 `bevelSize` **向外扩**，轮廓要先减掉倒角量（深度它补偿了，截面没有） |
| 折线管件像一串香肠 | `C.tube` 的胶囊端帽正好收在端点上，首尾相接会在每个折点掐出一道腰 → 每段用 `C.tube(L + 2r, ...)` 搭接 |
| 家具偏在格子一角 | 模型末尾没做水平重心归零 |
| centered 断言偏 ~1cm（模型含旋转件） | 归零用 `Box3.setFromObject`：旋转 mesh 按局部包围盒 8 角点算 bbox（过度估计），中心 ≠ 合并后真实顶点 bbox 中心 | 归零改按真实顶点求 bbox（traverse + `fromBufferAttribute` + `applyMatrix4`） |
| 近看像塑料板 / 一眼假 | 材质没贴图。跑 `catalog-all-textured` 一查便知 |
| 彩色件全变粉彩色 | `envMapIntensity` 默认 1 + clearcoat，白光罩糊了颜色 |
| 场景渲出比商品照亮一大截（近白） | 照片像素 = albedo×摄影棚光照（实测 ~1.8×）；把受光像素当 albedo 写进 color，再被场景光照乘一遍 → 过曝（SC172 #505255 渲出近白） | 按**场景渲出结果**标定：调低 albedo 直到 check-item 渲染均值 ≈ 照片受光区均值（SC172 终值 #333538 → rgb(105) vs 照片 #49–#56）；判据是渲出图不是照片 |
| 贴图发白 | `CanvasTexture` 忘了 `encoding = sRGBEncoding` |
| 两个配色的缩略图长一样 | 光照过曝（`physicallyCorrectLights=false` 下 three 会乘 π） |
| 改了尺寸后包围盒也跟着变，怎么调都对不上 | 散件位置从 `spec.w/d` 反推了，形成循环 |
| 缩略图只看得见一个角 | 取景第二遍缩得过头；`furnThumb` 有剪影贴合保护，别绕过它 |
| 抓到的价格离谱（King 床架 $25） | 命中了系列落地页不是商品页。抓完做 CA/US 比值异常值体检 |
| 渲染两次结果不一致 | 新贴图用了 `Math.random()`，没走 `srand()` + `rnd01()` |
| T 脚/条形部件方向错 90° | 只看正面 3/4 图建模，两方向长得一样 | 建模前 brief 写死轴向（沿 x 还是 z），建模后**侧视角渲染图**核对 |
| 床/柜侧栏与前后板轴向写反（填充率 116%~254%） | **床长轴 = z(d)、宽 = x(w)**：侧栏沿 z、床头/脚板跨 x；两次把侧栏的 `C.box(w,h,d)` 写成 (len_z, h, Th)（UTÅKER、SAPIENS），SAPIENS 还把脚板放到了 x 方向 | brief 先写死「长轴=z」；侧栏永远 `C.box(Th, h, len_z, M, ±(W/2−Th/2), y, z_c)`，床头/脚板跨 x（W−8）放 z=±D/2；写完先自查一遍每个 box 的第一/第三参哪一个是床长向 |
| 占地缺了伸展部分（臂灯只占机身） | 采集时只录机身 w/d，没录官方 Length/reach | 采集时对伸展件核对 reach；spec 错了就改目录条目，不缩模型迁就 |
| 斜网/斜面整体高出占地一截 | 单 mesh 同时设 rotation.x/y/z：Euler XYZ 序按 Rz→Ry→Rx 复合，宽边也被倾斜 | 复合姿态拆成父子：子 mesh 只做一个轴的旋转，父 Group 做另一个（ SPORTSLIG 斜网用 group 绕 x 倾 + 内部绕 y 转） |
| 杆/管被抬到离地一米多 | C.box/C.cyl/C.rb 的 y 是**底对齐**：横放圆柱底 = 中心高 − len/2（len 是杆长不是半径），曾把 88cm 横杆写到 y 89cm | 先算中心高再减半个杆长：`C.cyl(r,r,len,mat,x, cy-len/2, z)` 再 `rotation.x=π/2` |
| 占地多出 2~3cm 且找不到超界件 | 圆截面（胶囊端帽/圆管）比它贴的平面凸出半径 r | 探针打印各 mesh 的 max.z/max.x 找圆件；把它整体后移一个 r 使凸缘贴平（横杆布套 r 2.7 超前面 2.7cm） |
| 多件套装「嵌套」和「总宽」矛盾 | 例：60+30=90 恰等于 spec 宽时，嵌套必然总宽不足 | 建模前先算整组 bbox span，选偏移落在 92~102% 填充窗内（VITTSJÖ 套几解法：span 85=94%） |
| 填充率超窗但不知哪个部件超了 | 灯环/绕线带/拉手这类细件外缘超出 spec | 别盲调参数：`?nomerge` 逐 child 打 bbox，找出最宽部件（VIDJA 铬环 R 13.1→12.5） |
| CatmullRom 曲线在长直线+短弧交界处过冲 | 长直线段只给两个端点，切线估计被大段拉偏，管壁越出路径（NIPÅSEN 圆角侧框外溢 0.4cm） | 长直线段按 ~40cm 间隔加密中间点再建 CatmullRomCurve3 |
| 绕序自检写在 `const geo = ...` **之前** | TDZ ReferenceError → `furn3D` 的 try/catch **静默回退成通用造型**（症状：填充率掉到 310 面、mesh 数=1，且没有任何报错），断言永远读不到标记 | 自检必须在 `geo` 声明之后；验证「模型真的跑了」要抓 console.warn 或数 mesh 数 |
| 法线符号自检按 `(a, b, b2)` 取三角形 | 和 `id.push(a, a2, b2, ...)` 的顶点顺序不一致 → 法线整个反号 → 正确的模型被判红 | 自检里的三角形顶点顺序必须逐字照抄 `id.push` 的第一组 |
| 自检里的索引写成 `pos[a+j2]` 而 `a` 已含 `j` | 双加 `j` → 取到别的环的点 → 法线/面心全错，占比读成 ~50% | 生成器和自检的索引变量必须逐字对齐（`a = i*P` 是环基址，不是环基址+j） |
| 顶点处理里写 `nor[i*3+2]` 读法线 z 分量 | BufferAttribute 对象**不支持按下标取底层数组元素**（`attr[i]` 是 undefined）→ `Math.min(1,undefined)=NaN` → 整个几何 NaN（症状：填充率 NaN%、模型消失，无报错） | 一律用 `attr.getX/getY/getZ(i)`（或 `attr.array[i*3+2]`）；改完先跑填充率探针 |
| 环状扫掠件（缝线绳圈）法线天然朝内 | 菱形截面 `[(-r,0),(0,r),(r,0),(0,-r)]` 的顺序决定管壁朝内还是朝外；朝内时**仍然渲染**（看到的是管的远壁），所以截图检查抓不到 | 截面点顺序要按 (profile dir)×(ring dir) 推一遍；`check-item.py` 的绕序断言会读 `geometry.userData.winding` |
| 用逐面「朝外占比」做通用绕序判据 | 环状件天然 ~50%（剖面质心在环中心），盖面会按期望法线自己翻把信号稀释成 42% 这种读不出结论的值 | 占比不能用。判据只能落在**侧面**（`swept()` 自己写 `userData.winding`），且必须跑 `?nomerge`——合并会新建 BufferGeometry 丢掉 userData |
| 自建 `BufferGeometry`（扫掠/旋转体）渲成**纯色平板**，贴图完全看不见 | 只设了 `position`，没有 `uv` 属性 → 所有面采样 (0,0)，贴图等于一个色块（Henredon Murphy 桶壳第一版） | 自建几何必须 `geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv),2))`；扫掠体按**真实弧长**铺 UV（u=环向累计弧长/TILE，v=剖面累计弧长/TILE），TILE 取实物尺寸（如 40cm）否则纹理密度随半径变化；盖面用**独立顶点 + 平面 UV**，共享顶点会让扇形被侧壁 UV 拉成放射状 |
| 盖面贴图变成**条纹**（俯视座垫像一块带木纹的平板） | 盖面 UV 用「该平面的两个轴」算，但**水平盖面**（法线 ±y）的环上所有点 y 相同 → `v=(p.y-cy)/TILE ≈ 0`，整张贴图被采样到一条线上 | 按法线分派：`horiz = |expected[1]| > 0.7` → 水平盖面用世界平面坐标 `(x/TILE, z/TILE)`；径向盖面才用面内基（径向 + y） |
| 扫掠体侧面**被背面剔除**（斜 45° 直接看穿座垫看见底座） | 环向顺序决定面法线朝向：在特征点算 `(剖面方向) × (环向方向)`，若朝内则整圈都是背面 → 被剔除，从外面看等于没有那层壁 | 加/改扫掠体后在特征点（前口、背中心）验一次法线朝向；反序时所有依赖法线的量（inset/offset 符号）必须跟着翻 |
| 反转环向顺序后座垫顶边顶到足迹之外（深度填充 102%） | 「内向法线」公式 `(-tz, tx)/L` 是**绑定环向顺序**的，反序后它变成外向 | 法线符号和环向顺序一起改；改完立刻跑填充率，0.7cm 量级的超界就是这个符号 |
| 传了 `dome` 参数但顶面仍是平板 | 开环盖面走 `cap(i, -1, expected)` 时没把 `dome` 传下去 → 同心环隆起分支永远不执行 | 开环两端盖面也要传 dome（只给末端；首端传了会往下隆） |
| 隆起盖面出现**放射折痕**，顶面读成平板 | 单顶点扇形盖面（apex + 环）：每个三角形从中心辐射，法线/UV 都沿半径变化，贴图被拉成放射状 | 隆起盖面用**同心环逐层收向中心**（K 层，`lift = dome·sin(f·π/2)`，边界 0 → 中心 dome），最后一层收成 apex 顶点 |
| 手建曲线点忘乘 `cm()`（cm 值被当英尺） | 钩子/管件放大 ~30 倍，bbox 爆到 200%+（NIPÅSEN J 钩撑到 395cm） | `Vector3` 曲线点与 `C.box`/`C.cyl` 参数一样逐个 `cm()`；填充率体检能立刻抓住 |
| 已换算值再包一层 `cm()`（双重转换） | 部件缩小 30 倍几乎看不见（Lil' Kick 轮胎/轮毂/花瓣半径缩到 0.1cm，轮子只剩幽灵圈） | 参数已是英尺（`R=cm(7.5)`）就直接用 `R`、`0.43*R`，不再套 `cm()`；渲染里「该大的部件很小」先查这个 |
| Group/holder 里的 `C.rb`/`C.cushion` 子件被抬高半高 | 后仰垫/腰枕整体偏高半厚（8 件沙发全部 y 溢出 114~128%） | 子件局部几何是 **y 0..h 底对齐**（不是居中）；要绕中心旋转先 `child.position.y -= cm(h/2)` 再进 holder |
| `C.cyl` 只传 7 个参数（漏了 y） | seg 落进 z 槽，腿/柱飞到 z=12ft（365cm），bbox z 爆 400%+ | 写全 8 个位置参数 `C.cyl(rTop,rBot,h,mat,x, 0, z, seg)`；bbox 探针「某轴爆炸 + 单条窄板」就是它 |
| 居中件偏了「一个半径」 | `C.rb`/`C.box` 的 x/z 是**中心点**不是角点：想让 11cm 块居中却写 (-5.5, 0, -5.5)，整块偏 5.5cm、上面部件悬空（DYVLINGE 镀铬底座） | 居中写 (0,0,0)，偏移用 ±w/2；bbox 探针「对称件整体偏半宽」就是它 |
| 位置参数忘包 `cm()`（把 cm 数字当英尺传） | `C.box(...,y=3,...)` 的 3 被当成 3ft=91cm，立杆整体抬高 88cm、bbox y 爆到 134%（UPPVIND 框架） | `C.box`/`C.cyl`/`C.rb` 的 x/y/z 和尺寸参数**一样**要 `cm()`；bbox 探针「某部件整体平移到不可能高度」先查这个 |
| 新条目 id/model 与既有条目撞 | 同系列不同品类共用命名空间：PS 2026 推车已有 `id:'ps2026-0'`/`model:'ps2026'`，再加同名的落地灯会让后写者覆盖前者（furn3D 按 model 查 MODELS） | 写入前 `grep "id:'xxx'"` + `grep "model:'xxx'"` 查唯一性，撞了就换键（如 `ps2026l`）；t_bbox 探针同一 id 出两行就是撞了 |
| 模型「不报错」但其实是通用回退造型 | `furn3D` 对注册模型异常是 **try/catch 静默回退**（只 console.warn），mesh 是自定义+通用的混合体 | 验证探针要抓 console.warn，或数 mesh 数/三角形数对照预期；「没抛错」不是验收标准（`Object3D` 没有 `.translate()` 方法，误调 `mesh.translate()` 就是这种炸法，改用 `geometry.translate()`） |
| 旋转件的 bbox 比名义尺寸高 | `Box3.setFromObject` 按局部包围盒 8 角点算旋转体（过度估计）：60cm 板倾 3.4°，bbox 竖直方向多 3.6cm | 倾垫/斜面板的正常现象，别当成建模错误；填充率余量本就吸收它 |
| rboxGeo 薄板退化（r ≈ h/2） | 基形先缩 2r 后接近扁平，圆角形状病态，成品尺寸漂移（17cm 座垫渲出 20.5cm） | 厚度 < 2r+余量 时改用直角 `C.box`，或选 r < h/2 留足基形厚度 |
| 缝线/条状件用 rboxGeo 把长度写进 d（`rboxGeo(长, 0.7, 17, …)`） | d 是 **z 深**：缝变成 17cm 深的横杆，从垫前面凸出 8.5cm（3/4 视角读成「浮空搁板」，正交侧视图才露馅） | rboxGeo(w,h,d)：w=横向长、h=竖直、d=沿 z 的凸出量；缝这类件 d 取凸出量（0.5~0.7） |
| C.ext 带 bevel 的板壳两侧起点不对称 | bevel 向挤出两端各扩 B：成品范围 `[x0-B, x0+depth+B]`。想让板恰好落在 [A, A+T]：depth=T-2B 且 **x0=A+B**。把左右壳都写 x0=A±(Tp/2…) 式对称式，一侧正好、另一侧整体偏 2B（ALDRYN 右壳薄 4cm，缝线悬在壳外） | 写完用探针量两侧外缘是否都在 ±W/2（或填充率 x 两侧分开看）；不对称 = 起点公式错 |
| bench 断言按模型材质 hex 过滤（`color.getHexString()==='282524'`） | 模型把 albedo 压暗/调色调后过滤空转，断言读 `?` 假红（ALDRYN 重建后 3 条红） | 结构性断言用**几何区域过滤**（y/z/x 窗口）而非材质颜色；颜色常量只用于「颜色本身」的断言 |
| rbox 的 r 逼近最窄边的一半（r≈w/2） | 基形缩 2r 后剩 ~8mm 薄片，roundedRectShape 的圆角半径还是大值 → 形状病态，bevel 向外膨胀回 **2× 请求宽**（SC172 扶手 13.5cm 渲出 26.8cm，填充率 113%） | 胶囊型厚薄板（r ≥ 最窄边/4）改用 `C.ext`：圆弧点画进轮廓（bevel=null）再拉伸；否则 r < 最窄边/4 |
| 2D 符号大得离谱（比实物大 S≈22 倍） | `furnShape()` 里 px/ft 混用：`wp=wf*S` 已是 px，却传给内部又乘 S 的 `R()`（S² 双重放大）；裸 `el()` 直接吃 px、`R()` 吃 ft | 一律先用 `wf`/`df`（英尺）算几何，传给裸 `el()` 时自己乘 `S`；`R()` 只喂英尺；加新 kind 图例后在放大视图里量一下符号实际像素（见 SKILL §5） |
| C.cyl 想当「中心在某高度」的横杆/顶杆 | C.cyl 是**底对齐**（add 时 y+h/2）：把中心高直接传给 y，144cm 杆被抬到 132cm（bbox 爆 155%）| 调用后 `m.position.y=cm(中心高)` 再转，或传 `中心高−len/2` |
| work/ 里堆满一次性探针 HTML（用户要手动清理）| 每次调试都在 version 控制目录新建探针页、用完不删；放 /tmp 又因相对 `lib/` 路径失效不可复用 | 复用**一个**探针模板：app.html 副本放 work/ + lib 改 `../lib`，同一命令末尾立即 `rm`；探针无输出先查页面目录与 lib 相对路径是否匹配 |
| C.box 的 x/z 也是中心点（同 C.rb） | 想让板居中却把 ±w/2 写成 x → 整板偏半个板长，bbox 爆 1.46×（BARLAST 十字底座两板都偏 -w/2，交叠区撑出 48cm） | 居中写 (0,0,0)；要偏置写 ±w/2 |
| 模型里出现实物没有的部件 / 把真人当成了产品的一部分 | 参考图里有小孩/成人（手抓栏杆、腿跨在架上、衣服颜色），把肢体/衣物误当结构，或"想当然"补了个支撑件（Lil' Climber 曾捏造一块 A 撑板） | 读参考图先分离人与产品：白底产品图为准，生活图里先圈出所有人体部位再提取结构；每个部件要能指着参考图说"这里是它"，指不出来就不建 |
| 部件互相穿插 / 悬空 / 高度不合使用者尺度 | 建模后没做常识体检，只看了填充率和贴地 | 建模完做常识三查：（a）非关节处不得互穿（滑梯末端不能插进拱门腿）；（b）每个部件有支撑或明确附着；（c）高度对照使用者体格（2-3 岁 ≈90cm；爬洞口 30-40cm；座高 25-35cm） |
| 扁压部件建成了 3D 环体 | 拱门弧带、扁平环形拉手是**压扁的板**（侧视图一条带），做成挤出圆环/torus 会厚出一倍还占错方向 | 侧视图里看部件是"一条带"还是"一个环"：一条带 = 扁板（extrude 环形轮廓板，厚度朝外） |
| 2D 图例外框变成椭圆/胶囊 | `el('rect').rx` 吃**原始像素**（`R()` 助手对 x/y/w/h 乘 S，但 rx 不乘）。写 `rx:5*S`（≈40px）而矩形高只有 16px，半径被钳制到半高 → 整框变椭圆 | rx 一律用 2~4 的小常数，不乘 S |
| 模型和商品名称宣称的品类/功能对不上 | 只对了参考图和填充率，没问“这名字说它是巴士滑梯游戏屋，我建的东西里巴士/滑梯/秋千/篮筐/洗盆齐不齐” | 验证加第四视角：**读商品名称（含功能词）**，把名称宣称的每个功能在模型/渲染图里逐项指认（“5-in-1” → 5 个功能件都得认得出）；认不出 = 不像 |
| “N-in-1” 把**名字暗示、实拍里没有**的独立件建了出来（87cm 篮球架杆） | 名字是营销枚举，照片才是权威：Costway 5-in-1 的“篮球”其实是巴士侧大环兼投篮目标，87cm 高来自青 A 架顶，根本没有独立 hoop 杆——第一版凭名字捏了根杆 | 对模型每个件**反向**核对产品照片：名字暗示的件若照片里找不到，多是既有件的双用途或营销话术——先确认该功能实际由哪个件承担、高度 spec 归因到实际最高件，再建模，别为凑名字/凑高度凭空建杆 |
| A 型架建成 V 型（上下颠倒） | 摇摆架/攀爬架立柱是**向上**外张（下窄上宽），建成向下外张就是 V | 前视图反推：宽端朝哪？A 型宽端朝上（前视图宽端在上、两立柱在底部靠拢） |
| 中央单板部件建成两块平行板（头/颈/靠背） | 参考图只数了「几个部件」没数「每部件几块板」（hape-horse/ekorre 的头颈都是中央单板，侧板只含身体） | 看参考图数板：前视图里是一板还是两板；板面朝侧面→中央单板挤出，两侧板轮廓只画到身体 |
| 前视图轮廓错（该梯形建成矩形） | 只从侧视图建模，没反推前视图（木马腿+摇轨前看是梯形：上窄=座处、下宽=摇轨最宽） | 外张件：侧板绕 x 轴 ±θ 倾斜，**绕 y=0（地面）为轴**（底部不动、顶部内收）；座/杆等随高度变化重算 z |
| 调过的 mesh 突然沉进地板/飞走 | helper（C.box 等）已设过 position，事后 `m.position.y = cm(x)` 是**替换**不是累加（竖条从 11.5 被改到 1.5，沉地 5cm） | 要平移用 `+=`，或把完整值传给 helper |
| 脚本批量替换删掉一大段代码 | 无界 `find("return C.g;")`：目标块不含该串时命中**下一个**模型的 return，删掉中间整段（一次删 39k 字符，靠 git checkout 救回） | 块边界用有界搜索：两个相邻 `MODELS['…']` marker 之间 rfind；改完先 `grep -c "MODELS\["` 核对数量 |

**自我生长**：会话中用户指出了 agent 自己没发现的问题、steering 后才修正时，
修正完必须沉淀一条**可泛化**的教训（对未来加家具的至少某一类情况有用）——
按 SKILL.md「自我生长」节的四步流程写入 skill 和本节，两处同步；
绑定到某一件家具的具体细节不进 skill。

### 8.2 加可编辑性

**实体只能来自两个来源：用户画，或导入读到的几何。** 任何「找最长的墙」「水槽靠窗」「灶台在对面」式的启发式规则一律不写——那是猜（用户 2026-10-05 明确否掉，他的户型就是反例）。允许的是：
- **形状分类**（对读到的轮廓做几何判据，如家具层闭合轮廓：一个方向 ≤0.75m、另一个方向 ≥1.0m → 柜体带），且必须给出可核对的警告说明判据和默认值；
- **渲染风格挂在实体标志上**（窗的 `steel` → 黑钢梁），不是独立的猜测算法；
- 与历史读入数据重合时**只画一次**（内置户型的钢梁位置逐字节不变，黄金基线不动）。


已有：画墙/画柱异形/改内置墙、门的位置与宽度（带墙垛联动）、灯的色温与亮度、家具旋转 0.1° 精度。

加新编辑能力时注意：
- 手柄要**恒定屏幕尺寸**（`k = svg.getScreenCTM().a`，所有尺寸除以 k），否则放大后手柄糊住底图
- 吸附半径要**随缩放收缩**（按屏幕像素算），否则放大了也无法精确定位
- 点击 vs 拖动的阈值用**屏幕像素**（≥5px），不要用世界坐标——1px 手抖会静默改坏几何
- 拖拽目标要在 pointerdown 时**快照**，move 里不要重新解引用（Esc/Delete 会让 sel 变 null）
- 纯选中**不要写 override**（延迟到首次真正移动才 materialize），否则点一下就把内置几何冻结
- **命中判定不得只写在一个工具分支里**（E19 轮⑳）：新实体的 `data-xxx` 要么在「选择/调整」
  模式下也认（通用 `sel` 分支），要么明确不画命中区；重叠时**小目标赢**（洁具在台面之上），
  并在 `drawWallEdit` 里把顺序写成「大的先画」；悬停/选中高亮照现有颜色语言（橙/绿）补齐
- **拖拽的 `pushUndo` 用 `markDragGesture(drag, drag.undoKey)`**（E19 轮⑳）：pointerdown 不算一步，
  真正越过 5px 阈值开始动才进环；新增任何 `start*` 拖拽都要带 `undoKey` 与 `moved:false`
- **新增删除分支时核对「可撤销」清单**（E19 轮⑳）：`deleteSel` 里每一个真正改数据的分支都要
  `pushUndo('del:'+id)`（拒删的分支不推）；测试必须走「改 → 撤销 → 逐位回去」，不只测「改」
- **换户型 / 撤销回另一份户型时作废编辑层**（E19 轮㉗）：`wallEdit.sel` / `drawPts` / `dEndSel` / `drag`
  存的是**上一份文档的实体 id 与上一份坐标**，不作废就会在新户型里变成悬空引用（工具条描述不存在的东西、
  进行中的画墙链变成这份户型的几何）。统一走 `invalidateEditLayer()`，并在 `deleteSel` / 工具条刷新处
  用 `selAlive()` 自愈——**删除与提示必须按「这个实体还在当前文档里吗」判**，不在就如实拒做

### 8.3 提高渲染效果

现有管线：ACES 色调映射 + PMREM 环境贴图 + 程序化贴图（木纹按树种/织物/石英/拉丝钢/城市全景）+ 法线贴图（Sobel 从颜色图算）+ 照片级渐进累积。

继续提升的方向：
- **材质**：`MeshPhysicalMaterial` 的 `clearcoat`（清漆）、`sheen`（丝绒）、`specularIntensity`（哑光漆）
- **贴图**：`woodSpecies(name)` 已支持 pine/beech/birch/oak/walnut，加新树种照着写
- **光照**：娃娃屋=均匀泛光（看清造型），室内=真实灯光（`applyLightMode()` 分流）
- **照片级渲染**：`photoRender(samples)`，采样数越高越干净；日光锥抖动出半影、半球天光采样近似 AO

调材质时**一定要对照实拍照片采样**（写个 canvas 取色脚本），不要凭感觉。
注意照片有曝光偏差，要找光照正常的区域采样，或用已知白色物体做归一化参考。

---

### 8.4 UI 改动（样式 / 新组件 / 交互流程）

验收 = `docs/research/10-ui-acceptance.md` 的**七道关**
（A 行为断言 / B calib 不变性 / C 黄金截图 / D 交互流程 / E 人眼可见性 /
F 交互体检 / G 卫生）。**关 C 已有工具（E16）**：UI 改动后必跑
`npm run ui:gate`（8 个 `#ui:*` 规范态截图 vs `work/golden/` 基线，≤0.3%）；
**改样式的提交必须显式 `npm run ui:gate:update` 重拍受影响基线并在提交说明里讲清变化**
（重拍是显式动作，不是默认通过）；基线 md5 双截一致由 `ui:gate:selftest` 守。
两条最容易自欺的重点：

1. **交互流程是一等验收对象**（「先点什么、再点什么、发生什么」）：
   每个新增/修改的流程要写**流程脚本**（逐步动作 → 期望反馈），在测试台
   跑起来，**每步都断言「状态变化 + 用户可见反馈」**；零反馈的动作 =
   设计缺陷，不是跳过。实现前过 R10 的 HCI 清单（步数/直接操纵/模式可见/
   可发现性/注意力/选择负荷/错误处理/一致性/精度辅助/Fitts）。
   核心流程维持「基准任务脚本」，断言完成动作数不回归。
2. **人眼可见性验证**（「agent 说能看到」≠「人看得到」）：
   任何「可见/已显示」声称必须过**三层探针**：
   ① 几何（rect 在视口且所有滚动/裁剪容器内，≥8×8px）
   ② 遮挡（`elementFromPoint(中心)` 命中目标或其后代 = 该点最上层）
   ③ 感知（**截图 + ≥2× 放大裁剪 + Read 目检**，文字对比度 ≥4.5:1）。
   DOM 查询不是可见性证据。这是 §10「用户圈图先放大确认」的反向应用：
   同一套放大裁剪技术，人说看到了要 agent 确认，agent 说看到了要（模拟）人眼确认。

---

## 9. 便捷命令速查

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
# 下面的 file:// 都是**个人入口**（根目录 planner.html = mine 户型，§0.3）；
# 公开入口 = dist/app.html（单文件）或 app.html（源形式）。

# 2D 截图
"$CHROME" --headless --disable-gpu --screenshot=/tmp/a.png --window-size=1700,1100 \
  --virtual-time-budget=12000 "file:///Users/dako/planner/planner.html" 2>/dev/null

# 3D 截图（必须 swiftshader）
"$CHROME" --headless --use-angle=swiftshader --screenshot=/tmp/b.png --window-size=1900,1200 \
  --virtual-time-budget=16000 "file:///Users/dako/planner/planner.html#3d" 2>/dev/null

# 读取页面内计算结果（配合注入脚本输出到 <pre id="r">）
"$CHROME" --headless --use-angle=swiftshader --allow-file-access-from-files --dump-dom \
  --virtual-time-budget=30000 "file:///path/test.html" 2>/dev/null | python3 -c "
import sys,re,html
t=sys.stdin.read(); m=re.search(r'<pre id=\"r\">(.*?)</pre>', t, re.S)
print(html.unescape(m.group(1)) if m else 'NO RESULT')"

# 导出几何做程序化分析
"$CHROME" --headless --disable-gpu --allow-file-access-from-files --dump-dom \
  --virtual-time-budget=5000 "file:///Users/dako/planner/planner.html#dump" 2>/dev/null
# → <pre id="dump">{W:墙段, F:地板点, S:结构块}</pre>，坐标是图纸px
```

**hash 模式**：`#calib` 校准叠加 / `#calibimg` 只显底图 / `#dump` 导出几何 / `#3d` 直接进 3D / `#a` `#b` 载入参考方案。

**参考资料**：`work/furniture_specs.json`（采集的商品数据）、`work/furniture_models.json`（agent 生成的建模代码）、
`704.jpg`/`705.jpg`（实拍）、`708.jpg`（样板间效果图）、`work/clean_plan.jpg`（官方图纸，校准基准）。

---

## 10. 交付习惯

- 回复用中文，先给结论再给细节
- 提到文件/页面**一定给完整 `file://` URL**
- 报告改动时说清楚"根因是什么"，不要只说"修好了"
- 测试数字要具体（"转头位移 0.0000ft、眼高恒定"比"修好了"有说服力）
- 用户圈图指出问题时，**先放大裁剪确认自己看到的和用户看到的是同一处**，再动手

---

## 11. 性能优化（2026-09 实测）

### 已做的优化与实测收益

| 优化 | 手法 | 实测 |
|---|---|---|
| **按材质合并几何** | `mergeByMaterial()`：把每件家具/静态场景的 mesh 按 (材质, 投影标志) 分桶，烘焙各自变换后拼成一个 BufferGeometry | draw call **724 → 66**，三角形数完全不变 |
| **增量家具同步** | `sync3D()` 维护 uid→group 映射 + 签名；签名没变只更新变换矩阵 | 拖动一次 **~300ms → 4.2ms（70×）** |
| **按需渲染** | `three.needsRender` 脏标记；只有相机/场景变化才画帧 | 静止时 GPU 占用归零（原先无条件 60fps） |
| **阴影按需更新** | `shadowMap.autoUpdate=false` + `requestShadowUpdate()` | 相机移动不再重算阴影贴图 |
| **交互期自适应分辨率** | 拖动/滚轮时 pixelRatio 降到 1.0，静止 220ms 后恢复满分辨率重绘 | 交互期像素量减少约 4×，静态画质不变 |
| **法线贴图上 GPU** | 一次 shader pass 出图，失败回退 CPU Sobel | 免去 512² × 8 邻域的 JS 循环 |
| **全量重建** | 上述叠加 | buildStatic3D+sync3Dfull **460ms → 144ms** |

### 关键约束：合并不能改变画面

- **透明材质不合并**：多层透明面依赖逐网格由远及近排序，合并会改变混合结果
- **单成员分组不重建**：只有一个 mesh 的桶保持原样，避免顶点浮点漂移导致贴图采样偏移（曾让地板木纹缝线整体位移 1px）
- 分桶键必须含 `castShadow`/`receiveShadow`/`renderOrder`
- 合并出来的几何打 `userData.mergedOwned=true`；`disposeOwned()` **只释放自有几何，绝不释放共享材质与贴图**
  （原代码每次 `sync3D` 都 `m.map.dispose()`，把缓存的木纹/织物贴图释放掉，导致反复重传 GPU）

### 性能测量在本环境的陷阱（很重要）

- **`--virtual-time-budget` 会冻结 `performance.now()`**，页面内同步计时全是 `0.0ms`，完全不可用
- **`--screenshot` 在 load 事件时就截图**，赶在 `load` 监听器之前，页面内基准跑不完
- **可行办法**：用**进程墙钟**（`time.time()` 包住整个 Chrome 进程）+ 页面写一个完成标记 `<pre id="done">`；
  **必须校验标记存在**，否则数字是"进程被提前结束"的假读数
- **SwiftShader 是软件光栅化器**，填充率瓶颈、不体现 draw call 的驱动开销 →
  合并的收益在这里测不出来，但在真实 GPU 上是实打实的 CPU 驱动开销下降

### 渲染确定性（新增，且是回归测试的前提）

所有程序化贴图原本用 `Math.random()`，导致**每次刷新木纹/天际线都不一样**——
既是 UX 问题，也让像素级回归比对失效（同代码跑两次就有 4.8% 显著差异，噪声淹没真实回归）。

现在用固定种子的 xorshift32（`srand()/rnd01()`），各贴图函数入口播种。
**验证方法**：同一页面渲染两次，md5 必须完全相同。有了它才能证明"优化前后逐字节一致"
（本轮合并优化就是这样验证的：`?nomerge` 与默认渲染的 md5 完全相同）。

`photoRender` 的采样抖动仍用 `Math.random()`——那里需要真随机。

### 调试开关

- `?nomerge` — 关闭几何合并，用于 A/B 对照
- 页面内可直接调 `sync3Dfull()` 强制全量重建家具

### 下一步可做的优化（尚未做）

- **InstancedMesh**：KALLAX 隔板、婴儿床栏杆、窗棂等重复构件可用实例化，进一步降低顶点量
- **材质全局去重**：目前 79 个材质实例，很多参数完全相同；注意有模型会在创建后改材质（如吊灯罩改 `side`），共享前必须审计
- **静态场景 LOD / 视锥剔除**：合并后剔除粒度变粗，场景更大时可按房间分组合并
- **Worker 预生成贴图**：目前贴图生成很快（实测接近免费），暂无必要
