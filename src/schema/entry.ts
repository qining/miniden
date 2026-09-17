/* =====================================================================
   src/schema/entry.ts — 浏览器端入口（IIFE bundle 的唯一入口）

   编译（scripts/build-schema.mjs）：esbuild → IIFE → 注入 planner.html
   的 `<script id="miniden-schema">` 块，挂到 globalThis.MINIDEN：

       window.MINIDEN = { Primitives, Project, Migrate }

   planner.html 主脚本用 `const SCHEMA = window.MINIDEN` 消费。
   build.mjs 每次构建时重新编译并校验嵌入块与最新输出逐字节一致
   （src/ 是唯一事实来源，嵌入块是 vendored 副本）。

   纯度：本模块树禁 import three / document（R7 红线）——
   所以它可以在主脚本之前作为裸 classic script 独立执行。
   ===================================================================== */

import * as Primitives from './primitives';
import * as Project from './project';
import * as Migrate from './migrate';

(globalThis as { MINIDEN?: unknown }).MINIDEN = { Primitives, Project, Migrate };
