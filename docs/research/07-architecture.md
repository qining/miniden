# R7. 整体架构（现状解剖 → 目标模块图）

日期：2026-09（研究/架构草案）· 关联 ADR-0004（单文件产物）· 服务 E1

## 1. 现状解剖（2026-09 实测，714KB 版）

```
planner.html  714KB  +  lib/three.min.js 608KB + OrbitControls 26KB
                                   = 完整产物 ≈1.35MB（双击即开）
┌── CSS 12KB（全部手写，无 token）┐
├── HTML 8KB ────────────────────┤
└── JS 694KB（12,992 行，207 个顶层函数，55 个 UPPER const，0 模块）
```

JS 区块测量（锚点行号 → 大小）：

| 区块 | 行号 | 大小 | 内容 |
|---|---|---|---|
| 户型几何 + CATALOG 数据 | L264–L492 | **85KB** | WALLS/DOORS/FIXED + **275 条目（276B/条）** |
| 状态/持久化 + 2D | L492–L2073 | **111KB** | state、USERGEO、eff*()、build2D、furnShape、墙编辑器 |
| 3D 静态场景 | L2073–L3165 | **31KB** | buildStatic3D、门窗、洁具、厨房、26 个贴图函数（散布 L2169–L8671） |
| PT 照片级渲染 | L3165–L4627 | **59KB** | BVH/着色器/累积/降噪（裸 GLSL + WebGL2） |
| **MODELS 建模注册表** | L4627–L11243 | **327KB（= JS 的 47%）** | 131 个模型函数，平均 2.5KB/个 |
| 家具运行时 | L11243–L11994 | **44KB** | modelCtx(7.3) + furn3D(30.2) + sync3D(3.8) + furnThumb(5.6) |
| UI | L11994–L12992 | **46KB** | 目录卡片、属性面板、对话框、事件绑定 |

**关键结构事实**（决定模块边界）：
- **单一数据出口**：`WALLS/FIXED/DOORS + USERGEO → effWalls()/effFixed()/effDoors()`，
  2D 与 3D 共用（AGENTS §7）——这个边界必须保留
- **模型层已天然解耦**：`MODELS[specId] = (C) => {...}`，只依赖 `modelCtx`
  的 ~20 个辅助 + `C.spec`——**拆成独立文件是纯搬运，零行为改动**
- **贴图函数是全局单例缓存**（`_xxxTex` + `srand` 种子）——模块化时必须保留
  惰性单例语义（不能变成模块求值期副作用）
- 三个渲染世界：2D SVG（DOM）、3D WebGL2（three r147）、PT（裸 WebGL2 GLSL）
  ——前两个共享几何，PT 独立吃 mesh 列表

## 2. 目标模块图（esbuild 单文件，ADR-0004）

```
src/
├── schema/        ★ 地基（R1/S1）
│   ├── project.ts     Project 文档类型（ADR-0005）+ JSON Schema
│   ├── primitives.ts  seg/arc/polygon 原语（ADR-0002）
│   ├── expand.ts      唯一的 geom→段链 展开函数（所有消费者走这里）
│   └── migrate.ts     版本迁移链（内置户型/USERGEO → v1）
├── geo/           纯函数，零 DOM/GL（可 worker）
│   ├── wallband.ts    平行线对→墙带、T 型口咬合、门垛联动（从 wallEdit 迁）
│   └── snap.ts        吸附（屏幕像素半径；数据源可插拔：CAD/图像/栅格）
├── data/          纯数据
│   ├── catalog.json   275 条目（从 CATALOG 数组抽出，R8 的增长点）
│   └── models-index.json  specId → 模型代码键（R8 的解耦点）
├── models/        131+ 模型函数（一个文件一族；共享几何函数如 sapiens-apple 提层）
├── textures/      26 个程序化贴图（惰性单例，种子不变 → calib 不变）
├── render2d/      build2D / furnShape / 尺寸标注 / calib
├── render3d/      buildStatic3D / furn3D / sync3D / furnThumb / 光照
├── pt/            BVH / GLSL / 累积 / 降噪（WebGL2 后端；R3：未来可插拔 WebGPU）
├── import/        dxf.ts / pdf.ts / cv.ts（R1/R2；全部跑 worker）
├── storage/       IndexedDB 门面 + 导入导出（R6）
├── ui/            panels / toolbar / dialogs / 键盘（R9 token 化 CSS 同源）
└── main.ts        装配 + hash 模式（#3d/#calib/#dump/#ui...）
```

**依赖方向（无环）**：
`schema → geo → data/models → render2d/render3d/pt → ui → main`
纯层（schema/geo/data/textures）禁 import `three`/`document`——这条由
ESLint import-boundary 规则强制（E2），违规即 CI 红。

## 3. 线程模型

| 线程 | 负载 | 迁移依据 |
|---|---|---|
| 主线程 | UI、SVG、WebGL2 渲染、PT 调度 | 不动（按需渲染已让静止 GPU=0） |
| Worker A（按需） | DXF/PDF 解析（R1）、OpenCV WASM（R2） | 重 CPU，postMessage 传结构化克隆/Transferable |
| Worker B（可选，二期） | BVH 构建（现在 CPU ~百 ms） | R3：WebGPU 时代移 compute |

**约束**：worker 产物必须**确定性**（同输入同输出）——否则破坏像素回归
（贴图种子、排序稳定化、禁止 Math.random，AGENTS §11 的规矩平移过去）。

## 4. 迁移策略（为什么这样切是安全的）

1. **每块搬运都是「搬家」不是「重写」**：区块边界已被 208 断言 + calib md5
   冻结（§2 流程）。搬运后跑同一套门禁，行为不变 = 门禁全绿
2. **顺序**：先抽 `schema/geo`（写新，测试先行——它们是新代码），
   再搬 `models/`（纯搬运，最大块），最后 `ui/render*`（牵 DOM，最后动）
3. **lib/ 处理**：`three@0.147.0` + OrbitControls 走 npm → esbuild 内联
   （产物里仍是单文件；min+gzip 后 three ≈160KB，比现在裸 608KB 小 4×）
4. **calib 的锚**：`body.calib` 锁布局（§5.4.6）+ 种子贴图 + 几何不变
   → 迁移前后 md5 必须逐字节相同（这是整个迁移的**验收定义**）

## 5. 不变量清单（迁移期间一条都不能破）

- `#calib` md5 `1ac26921871db50ef1c055674c10e6e7`（几何视图）
- t3d 65 / walledit 111 / tpt 32 断言（行为）
- 贴图种子表（1001-1008, 1011-1028, 1030, …）——**只增不改**
- `GEO_VERSION=3` / `USERGEO_VERSION=1` 闸门（迁移时 bump 并写 migrate）
- 按需渲染（静止 GPU=0）+ 交互降分辨率（§11）
- 双击即开 / 离线 / 零网络

## 来源

- 本 repo `planner.html` 逐区块实测（本文 §1 表格，锚点行号可复现）
- AGENTS.md §7/§11（结构地图与性能实测）；ADR-0002/0004/0005
