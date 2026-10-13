/* S10 Phase 2：包模型的懒编译 + LRU 驻留 + 编译失败记账
 *
 * 为什么必须单测：懒编译把「什么时候付编译成本」从启动挪到使用时。
 * 写错一处的表现不是「报错」，而是「建模静默退回通用造型」——
 * 用户在界面上只会看到一件方块，查不到原因（§5.1 的静默回退实例同一种症状）。
 */
import { describe, it, expect } from 'vitest';
import { validatePack } from '../../src/catalog/packs';
import { buildModelIndex, createModelCache, precompilePack, MAX_RESIDENT_MODELS } from '../../src/catalog/models';

const packOf = (pack: string, models: Record<string, string>) => {
  const entries = Object.keys(models).map((k, i) => ({
    id: `${k}-${i}`,
    cat: '茶几 / 边几',
    name: `件 ${i}`,
    w: 45,
    d: 45,
    h: 50,
    kind: 'sideTable',
    price: 10,
    model: k,
  }));
  const r = validatePack({ pack, name: pack, version: 1, entries, models });
  if (!r.ok || !r.pack) throw new Error('fixture 包没通过校验: ' + JSON.stringify(r.issues));
  return r.pack;
};

const OK_SRC = '(C)=>{ C.box(1,1,1,null,0,0,0); }';
const BAD_SRC = '(C)=>{ 这不是 JS ((( ';

describe('Phase 2 模型索引', () => {
  it('索引只存源码，不产生任何编译产物', () => {
    const p = packOf('p1', { m1: OK_SRC, m2: OK_SRC });
    const idx = buildModelIndex([p]);
    expect([...idx.keys()].sort()).toEqual(['m1', 'm2']);
    expect(idx.get('m1')?.src).toBe(OK_SRC);
    expect(idx.get('m1')?.pack).toBe('p1');
  });

  it('同 model 名跨包：先到先得（与 mergeCatalog 的条目口径一致）', () => {
    const a = packOf('pa', { dup: OK_SRC });
    const b = packOf('pb', { dup: '(C)=>{ C.box(2,2,2,null,0,0,0); }' });
    const idx = buildModelIndex([a, b]);
    expect(idx.get('dup')?.pack).toBe('pa');
    expect(idx.get('dup')?.src).toBe(OK_SRC);
  });
});

describe('Phase 2 懒编译缓存', () => {
  it('取之前驻留为 0；取一次才编译一次；再取是命中', () => {
    const p = packOf('p1', { m1: OK_SRC });
    const cache = createModelCache(buildModelIndex([p]));
    expect(cache.stats()).toMatchObject({ resident: 0, compiled: 0, reused: 0, evicted: 0, failed: 0 });
    expect(cache.has('m1')).toBe(false);
    const f1 = cache.get('m1');
    expect(typeof f1).toBe('function');
    expect(cache.stats()).toMatchObject({ resident: 1, compiled: 1, reused: 0 });
    const f2 = cache.get('m1');
    expect(f2).toBe(f1); // 同一个函数对象，不是重新编译的
    expect(cache.stats()).toMatchObject({ resident: 1, compiled: 1, reused: 1 });
  });

  it('没有源码的 model 名返回 null（调用方退回 kind 通用回退建模）', () => {
    const cache = createModelCache(buildModelIndex([]));
    expect(cache.get('nope')).toBeNull();
    expect(cache.stats().compiled).toBe(0);
  });

  it('坏源码只编译一次，失败被记住并如实报出', () => {
    const p = packOf('p1', { bad: BAD_SRC });
    const cache = createModelCache(buildModelIndex([p]));
    expect(cache.get('bad')).toBeNull();
    expect(cache.get('bad')).toBeNull();
    expect(cache.get('bad')).toBeNull();
    const s = cache.stats();
    expect(s.compiled).toBe(0);
    expect(s.failed).toBe(1); // 三次取用只编译一次
    const f = cache.failuresFor('p1');
    expect(f.length).toBe(1);
    expect(f[0].model).toBe('bad');
    expect(f[0].error.length).toBeGreaterThan(0);
  });

  it('驻留超过上限按 LRU 淘汰；被淘汰的再用会重新编译', () => {
    const n = 6;
    const models: Record<string, string> = {};
    for (let i = 0; i < n; i++) models['m' + i] = OK_SRC;
    const cache = createModelCache(buildModelIndex([packOf('p1', models)]), { limit: 3 });
    for (let i = 0; i < n; i++) cache.get('m' + i);
    expect(cache.stats()).toMatchObject({ resident: 3, compiled: n, evicted: n - 3 });
    // 驻留的应该是最后用到的三个
    expect([0, 1, 2].some((i) => cache.has('m' + i))).toBe(false);
    expect([3, 4, 5].every((i) => cache.has('m' + i))).toBe(true);
    cache.get('m0');
    expect(cache.stats().compiled).toBe(n + 1); // 重新编译
    expect(cache.has('m3')).toBe(false); // m3 被 m0 挤出去
  });

  it('命中即「刚用过」：反复用的那个不会被淘汰', () => {
    const models: Record<string, string> = { hot: OK_SRC, a: OK_SRC, b: OK_SRC, c: OK_SRC };
    const cache = createModelCache(buildModelIndex([packOf('p1', models)]), { limit: 2 });
    cache.get('hot');
    cache.get('a');
    cache.get('hot'); // hot 挪到最近使用端
    cache.get('b'); // 淘汰的应该是 a
    expect(cache.has('hot')).toBe(true);
    expect(cache.has('a')).toBe(false);
  });

  it('默认上限就是协议里写的那个', () => {
    const models: Record<string, string> = {};
    for (let i = 0; i < MAX_RESIDENT_MODELS + 5; i++) models['m' + i] = OK_SRC;
    const cache = createModelCache(buildModelIndex([packOf('p1', models)]));
    for (let i = 0; i < MAX_RESIDENT_MODELS + 5; i++) cache.get('m' + i);
    expect(cache.stats().resident).toBe(MAX_RESIDENT_MODELS);
  });
});

describe('Phase 2 包移除 / 索引更换后的残留', () => {
  it('dropPack 清掉该包的驻留与失败记录，别包的不动', () => {
    const a = packOf('pa', { ma: OK_SRC, mb: BAD_SRC });
    const b = packOf('pb', { mc: OK_SRC });
    const cache = createModelCache(buildModelIndex([a, b]));
    cache.get('ma');
    cache.get('mb');
    cache.get('mc');
    expect(cache.stats()).toMatchObject({ resident: 2, failed: 1 });
    const removed = cache.dropPack('pa');
    expect(removed).toBe(2); // 1 个驻留 + 1 个失败记录
    expect(cache.has('ma')).toBe(false);
    expect(cache.failuresFor('pa').length).toBe(0);
    expect(cache.has('mc')).toBe(true);
    expect(cache.stats().failed).toBe(0);
  });

  it('setIndex 丢掉索引里已不存在的驻留项（换包后不能留旧编译产物）', () => {
    const v1 = packOf('p1', { m1: '(C)=>{ C.box(1,1,1,null,0,0,0); }' });
    const cache = createModelCache(buildModelIndex([v1]));
    const old = cache.get('m1');
    expect(cache.has('m1')).toBe(true);
    // 同一个包 id 换了内容（新版本）：索引必须换，旧函数不能继续被用
    const v2 = packOf('p1', { m1: '(C)=>{ C.box(9,9,9,null,0,0,0); }' });
    cache.setIndex(buildModelIndex([v2]));
    expect(cache.has('m1')).toBe(false);
    const fresh = cache.get('m1');
    expect(typeof fresh).toBe('function');
    expect(fresh).not.toBe(old);
    expect(cache.stats().compiled).toBe(2);
  });

  it('setIndex 不会把索引里还在的驻留项丢掉（重建索引是常态，不能每次都重编译）', () => {
    const p = packOf('p1', { m1: OK_SRC });
    const cache = createModelCache(buildModelIndex([p]));
    const f = cache.get('m1');
    cache.setIndex(buildModelIndex([p]));
    expect(cache.get('m1')).toBe(f);
    expect(cache.stats().compiled).toBe(1);
  });
});

describe('Phase 2 导入路径的预编译（确认框里的「解析失败 N 个」必须是真的）', () => {
  it('成功 seed 进缓存（用到时不再编译），失败如实计数', () => {
    const p = packOf('p1', { ok1: OK_SRC, ok2: OK_SRC, bad1: BAD_SRC });
    const cache = createModelCache(buildModelIndex([p]));
    const r = precompilePack(p, cache);
    expect(r.ok).toBe(2);
    expect(r.errors.map((e) => e.model)).toEqual(['bad1']);
    expect(cache.stats().resident).toBe(2);
    expect(cache.stats().compiled).toBe(0); // seed 进来的，不是 get() 编译的
    expect(cache.get('ok1')).toBeTypeOf('function');
    expect(cache.stats().compiled).toBe(0); // 用到时命中 seed 的函数
    expect(cache.get('bad1')).toBeNull();
    expect(cache.stats().failed).toBe(1);
  });
});
