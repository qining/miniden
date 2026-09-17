# 0004. 单文件产物架构（源模块化 → esbuild → 单 HTML）

- 日期：2026-07-17
- 状态：已接受（P0 级，户型扩展的前置条件）

## 背景

产品灵魂是「**双击即开、离线、无构建步骤才能分享**」：
用户拿到一个 HTML 文件就能用。但源码是 13k 行单文件 JS（207 个顶层
函数平铺，0 模块），任何大改动都是 800KB 文本手术，无边界可守；
纯 JS 无类型，schema 靠人肉。两者冲突必须解决，而解法不能牺牲单文件。

## 决策

1. **源码模块化**：`src/` ES modules，按职责切分——
   `schema/`（文档+校验+迁移）、`geometry/`（墙线运算/吸附/门垛，纯函数）、
   `state/`（store+持久化）、`render2d/`、`render3d/`、`textures/`、
   `catalog/`、`models/`、`ui/`
2. **esbuild 一行命令** bundle 回自包含 `planner.html`
   （inline 全部 JS + 内联 three）；`three@0.147.0` 从 `lib/` 提升为 npm 依赖
3. **增量迁移**：一次搬一个模块（先 `textures/`、再 `geometry/`…），
   每次搬完跑三测试台 + calib md5，绿灯再下一个。**禁止 big-bang 重写**
4. TypeScript：`src/` 新代码全 TS（schema 类型是户型扩展的生命线），
   `tsc --noEmit` 门禁；单体退役前允许混合
5. 包体预算进 CI（796KB 基线，超阈值报警）

## 后果

- 开发体验：模块边界 + 类型 + 单测（vitest 覆盖纯函数层）
- 分发体验：不变（还是一个 HTML）
- 代价：引入构建步骤（开发机才需要）；CI 必须完整复现
  「build → headless 三测试台 → calib md5」链路
- 迁移纪律是成败关键：calib md5 + 208 断言是每一步的裁判
