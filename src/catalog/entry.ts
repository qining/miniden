/* =====================================================================
   src/catalog/entry.ts — 浏览器端入口（S10：目录扩展协议的纯函数层）

   编译（scripts/build-catalog.mjs）：esbuild → IIFE → 注入 app.html 的
   `<script id="miniden-catalog">` 块，挂到 globalThis.MINIDEN_CATALOG：

       window.MINIDEN_CATALOG = { validateEntry, validatePack, compileModel,
                                  mergeCatalog, PACKS_KEY, packKeyFor,
                                  normalizeRegistry, serializeRegistry,
                                  upsertPackMeta, removePackMeta, packMetaFor,
                                  KNOWN_KINDS, … }

   主脚本消费方式（app.html）：
     · 目录 = [...CATALOG, ...packEntries, ...state.customCat]（catalogAll()）
     · 建模 = MODELS[key] || packModelCache.get(key) || kind 通用回退
       （Phase 2：包模型懒编译 + LRU 驻留，见 models.ts）
     · 注册表 planner_packs_v1 存元数据（v2 带内容指纹），包内容存 planner_pack:<packId>
   build.mjs 每次构建校验本块与最新编译逐字节一致。

   纯度：不 import three / document（R7）——包里的模型代码由调用方编译执行，
   本模块只提供校验 / 合并 / 编译。
   ===================================================================== */

import * as schema from './schema';
import * as packs from './packs';
import * as models from './models';

const g = globalThis as Record<string, unknown>;

(g as { MINIDEN_CATALOG?: unknown }).MINIDEN_CATALOG = {
  ...schema,
  ...packs,
  ...models,
};
