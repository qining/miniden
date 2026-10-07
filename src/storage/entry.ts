/* =====================================================================
   src/storage/entry.ts — 浏览器端入口（E10：IIFE bundle 的唯一入口）

   编译（scripts/build-storage.mjs）：esbuild → IIFE → 注入 app.html 的
   `<script id="miniden-storage">` 块，挂到 globalThis.MINIDEN_STORE：

       window.MINIDEN_STORE = { warm, get, set, remove, lsGet, lsRemove, flush, ... }

   主脚本用 `const STORE = window.MINIDEN_STORE` 消费（键集合由主脚本 warm 进来，
   因为只有它知道户型指纹）。build.mjs 每次构建校验嵌入块与最新编译逐字节一致。

   纯度：不 import three / document（R7）——globalThis 上的 indexedDB / localStorage /
   addEventListener 都按最小声明取用。
   ===================================================================== */

import { createStore, openIdb, type StorageLike } from './store';

const g = globalThis as Record<string, unknown>;
const lsRaw =
  g.localStorage && typeof (g.localStorage as StorageLike).getItem === 'function'
    ? (g.localStorage as StorageLike)
    : null;

const store = createStore({ idb: openIdb(), ls: lsRaw });

(g as { MINIDEN_STORE?: unknown }).MINIDEN_STORE = store;

/* 排队写入有个 200ms 防抖；页面隐藏/关闭前必须落盘，否则最后一次编辑会丢。 */
if (typeof g.addEventListener === 'function') {
  const on = g.addEventListener as (type: string, fn: (e?: unknown) => void) => void;
  const flushNow = () => {
    try {
      void store.flush();
    } catch (_e) {
      /* 落盘失败已经在 stats 里 */
    }
  };
  on('pagehide', flushNow);
  on('visibilitychange', () => {
    const doc = g.document as { visibilityState?: string } | undefined;
    if (doc && doc.visibilityState === 'hidden') flushNow();
  });
}
