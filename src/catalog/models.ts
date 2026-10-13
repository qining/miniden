/* =====================================================================
   S10 Phase 2（2026-10-13）：包模型的**懒编译 + LRU 驻留**

   实测过的规模（本轮探针 / Node 同引擎测量）：
     · 协议上限 = 32 包 × 500 模型 = 16,000 个模型函数、10.4MB 源码
     · 16,000 个模型逐条编译 ≈ 122ms（V8）——编译本身不是瓶颈
     · 但 Phase 1 在**启动时**就把每个已存包的每个模型编译好常驻：
       用户可能一件都不用，却为它们付了内存（16,000 个闭包 + 捕获作用域）
   所以懒编译的目的不是省编译时间，是**让驻留量与真实使用量成正比**。

   判据（写进 docs/design/catalog-extension.md §11）：
     · 启动装载：一律懒编译（用到才编译）
     · 导入路径：编译一次（为了在确认框里如实报「解析失败 N 个」，
       也因为刚导入的包接下来大概率要用）——编译结果直接 seed 进缓存
     · 驻留上限 MAX_RESIDENT_MODELS：超了就按 LRU 淘汰，用到再编译（4ms/500 个）
     · 编译失败只编译一次并记住（坏源码不会被每次建模都重编译一遍）
   ===================================================================== */

import { compileModel, type ParsedPack } from './packs';

export const MAX_RESIDENT_MODELS = 400;

export interface ModelSource {
  pack: string;
  src: string;
}

/** modelKey → 源码 + 归属包。内置模型不在这张表里（modelFor() 先查内置，内置赢）。 */
export type ModelIndex = Map<string, ModelSource>;

export function buildModelIndex(packs: readonly ParsedPack[]): ModelIndex {
  const idx: ModelIndex = new Map();
  for (const p of packs) {
    for (const [key, src] of Object.entries(p.models)) {
      if (idx.has(key)) continue; // 先到先得，与 mergeCatalog 的条目口径一致
      idx.set(key, { pack: p.pack, src });
    }
  }
  return idx;
}

export interface ModelCacheStats {
  /** 当前驻留的模型函数数 */
  resident: number;
  /** 本会话成功编译过的次数（含被淘汰后重新编译） */
  compiled: number;
  /** 命中驻留的次数 */
  reused: number;
  /** 因驻留上限被淘汰的次数 */
  evicted: number;
  /** 已知编译失败的模型数（每个只编译一次） */
  failed: number;
}

export interface ModelCache {
  /** 取模型函数；没有源码 / 编译失败 → null（调用方退回 kind 通用回退建模） */
  get(key: string): ((C: unknown) => void) | null;
  /** 是否已驻留（不触发编译） */
  has(key: string): boolean;
  /** 换一份源码索引（加载 / 移除包后）：丢掉索引里已不存在的驻留项 */
  setIndex(next: ModelIndex): void;
  /** 移除某个包的全部驻留模型，返回移除数 */
  dropPack(packId: string): number;
  /** 把已编译好的函数放进缓存（导入路径用，避免用第一次再编译） */
  seed(key: string, fn: (C: unknown) => void): void;
  stats(): ModelCacheStats;
  /** 某个包已知的编译失败（如实报告用） */
  failuresFor(packId: string): Array<{ model: string; error: string }>;
  /** 某个包当前驻留的模型数 */
  residentFor(packId: string): number;
}

export function createModelCache(index0: ModelIndex, opts?: { limit?: number }): ModelCache {
  const limit = Math.max(1, opts?.limit ?? MAX_RESIDENT_MODELS);
  let index = index0;
  const resident = new Map<string, (C: unknown) => void>();
  const srcOf = new Map<string, string>(); // 驻留函数是从哪份源码编译来的（换包后靠它判断能不能留）
  const failures = new Map<string, string>();
  let compiled = 0;
  let reused = 0;
  let evicted = 0;

  // Map 的迭代顺序 = 插入顺序；命中时 delete + set 把它挪到最后 = LRU 的「最近使用」端
  const touch = (key: string, fn: (C: unknown) => void, src?: string) => {
    resident.delete(key);
    resident.set(key, fn);
    if (src !== undefined) srcOf.set(key, src);
    while (resident.size > limit) {
      const oldest = resident.keys().next().value;
      if (oldest === undefined || oldest === key) break;
      resident.delete(oldest);
      srcOf.delete(oldest);
      evicted++;
    }
  };

  return {
    get(key: string) {
      const hit = resident.get(key);
      if (hit !== undefined) {
        touch(key, hit);
        reused++;
        return hit;
      }
      if (failures.has(key)) return null; // 坏源码不重复编译
      const entry = index.get(key);
      if (!entry) return null;
      const c = compileModel(entry.src);
      if (c.error || !c.fn) {
        failures.set(key, c.error || '编译失败');
        return null;
      }
      compiled++;
      touch(key, c.fn, entry.src);
      return c.fn;
    },
    has: (key) => resident.has(key),
    setIndex(next: ModelIndex) {
      index = next;
      // 同一个 model 名可能已经是新版本的内容：源码对不上就绝不能继续用旧函数
      for (const key of Array.from(resident.keys())) {
        if (index.get(key)?.src !== srcOf.get(key)) {
          resident.delete(key);
          srcOf.delete(key);
        }
      }
      for (const key of Array.from(failures.keys())) if (!index.has(key)) failures.delete(key);
    },
    dropPack(packId: string) {
      let n = 0;
      for (const key of Array.from(resident.keys())) {
        if (index.get(key)?.pack === packId) {
          resident.delete(key);
          srcOf.delete(key);
          n++;
        }
      }
      for (const key of Array.from(failures.keys())) {
        if (index.get(key)?.pack === packId) {
          failures.delete(key);
          n++;
        }
      }
      return n;
    },
    seed(key: string, fn: (C: unknown) => void) {
      failures.delete(key);
      const entry = index.get(key);
      touch(key, fn, entry ? entry.src : '');
    },
    stats: () => ({ resident: resident.size, compiled, reused, evicted, failed: failures.size }),
    failuresFor(packId: string) {
      const out: Array<{ model: string; error: string }> = [];
      for (const [key, error] of failures) if (index.get(key)?.pack === packId) out.push({ model: key, error });
      return out;
    },
    residentFor(packId: string) {
      let n = 0;
      for (const key of resident.keys()) if (index.get(key)?.pack === packId) n++;
      return n;
    },
  };
}

/**
 * 导入路径：把一个包的模型全部编译一遍。
 * 目的只有一个 —— 在确认框里如实报「解析失败 N 个」（轮㉙ 的断言），
 * 顺便把成功的 seed 进缓存（用户刚导入的包接下来大概率要用）。
 */
export function precompilePack(
  p: ParsedPack,
  cache: ModelCache
): { ok: number; errors: Array<{ model: string; error: string }> } {
  const errors: Array<{ model: string; error: string }> = [];
  let ok = 0;
  for (const [key, src] of Object.entries(p.models)) {
    const c = compileModel(src);
    if (c.error || !c.fn) {
      errors.push({ model: key, error: c.error || '编译失败' });
      continue;
    }
    ok++;
    cache.seed(key, c.fn);
  }
  return { ok, errors };
}
