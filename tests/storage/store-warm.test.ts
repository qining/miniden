/* E26：warm 可重入（切户型时新键要能被同步进来）。
   守的红线：第二次 warm 只处理未同步过的键；主存里有而 LS 没有的新键必须补载入，
   否则切过去读到空 → 把用户存好的那份关在主存里，界面上凭空出现一份空户型。 */
import { describe, expect, it } from 'vitest';
import { createStore, type StorageLike } from '../../src/storage/store';

function fakeLs(seed: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  } as StorageLike & { map: Map<string, string> };
}

function fakeIdb(seed: Record<string, string> = {}): { map: Map<string, string>; reads: string[][] } {
  const map = new Map<string, string>(Object.entries(seed));
  const reads: string[][] = [];
  return {
    map,
    reads,
    // 门面用的是 idbBackend(db)；这里直接给一个 KVBackend 形状（createStore 接受已适配的后端）
  };
}

const kvBackend = (idb: { map: Map<string, string>; reads: string[][] }) => ({
  name: 'idb-fake',
  async read(keys: string[]) {
    idb.reads.push(keys.slice());
    const out: Record<string, string> = {};
    for (const k of keys) if (idb.map.has(k)) out[k] = idb.map.get(k)!;
    return out;
  },
  async write(k: string, v: string) {
    idb.map.set(k, v);
    return true;
  },
  async remove(k: string) {
    idb.map.delete(k);
    return true;
  },
});

describe('warm 可重入', () => {
  it('第二次 warm 的新键：主存有 / LS 被清 → 补载入并通知（只通知新键）', async () => {
    const idb = fakeIdb({ 'planner_doc_v1:p1': '{"name":"我家"}' });
    const ls = fakeLs({ 'planner_doc_v1:fp0': '{"name":"内置"}' });
    const store = createStore({ idb: kvBackend(idb), ls, debounceMs: 0 });
    const hydrated: string[][] = [];
    store.onHydrate((keys) => hydrated.push(keys));

    await store.warm(['planner_doc_v1:fp0']);
    expect(store.get('planner_doc_v1:fp0')).toBe('{"name":"内置"}');

    // 切到一个只存在主存里的户型
    await store.warm(['planner_doc_v1:p1']);
    expect(store.get('planner_doc_v1:p1')).toBe('{"name":"我家"}');
    expect(hydrated.flat()).toContain('planner_doc_v1:p1');
    // 第一轮已经处理过的键不能在第二轮再通知一次（否则页面会莫名重载）
    expect(hydrated[hydrated.length - 1]).toEqual(['planner_doc_v1:p1']);
  });

  it('已同步过的键不再重复读主存（第二轮只读新键）', async () => {
    const idb = fakeIdb({ a: '1', b: '2' });
    const ls = fakeLs();
    const store = createStore({ idb: kvBackend(idb), ls, debounceMs: 0 });
    await store.warm(['a']);
    await store.warm(['a', 'b']);
    expect(idb.reads).toEqual([['a'], ['b']]);
    expect(store.get('b')).toBe('2');
  });

  it('没有新键的 warm 是空操作（ready() 反复调用不产生额外读）', async () => {
    const idb = fakeIdb({ a: '1' });
    const store = createStore({ idb: kvBackend(idb), ls: fakeLs(), debounceMs: 0 });
    await store.warm(['a']);
    const n = idb.reads.length;
    await store.ready();
    await store.ready();
    expect(idb.reads.length).toBe(n);
  });

  it('LS→IDB 回灌在第二轮同样发生（新键只在 LS 里）', async () => {
    const idb = fakeIdb();
    const ls = fakeLs({ 'planner_v1:p1': '{"items":[]}' });
    const store = createStore({ idb: kvBackend(idb), ls, debounceMs: 0 });
    await store.warm(['x']);
    await store.warm(['planner_v1:p1']);
    expect(idb.map.get('planner_v1:p1')).toBe('{"items":[]}');
    expect(store.stats().migrated).toBe(1);
    // LS 只复制不删
    expect(ls.map.get('planner_v1:p1')).toBe('{"items":[]}');
  });

  it('页面在第二轮 warm 前自己写过这个键 → 主存的旧值不能覆盖它', async () => {
    const idb = fakeIdb({ 'planner_doc_v1:p1': '{"name":"主存旧值"}' });
    const ls = fakeLs();
    const store = createStore({ idb: kvBackend(idb), ls, debounceMs: 0 });
    await store.warm(['a']);
    store.set('planner_doc_v1:p1', '{"name":"刚写的"}');
    await store.warm(['planner_doc_v1:p1']);
    expect(store.get('planner_doc_v1:p1')).toBe('{"name":"刚写的"}');
    await store.flush();
    expect(idb.map.get('planner_doc_v1:p1')).toBe('{"name":"刚写的"}');
  });

  it('并发调用 warm 串成一条链（同一轮新键合一次读，不并发读主存）', async () => {
    const idb = fakeIdb({ a: '1', b: '2', c: '3' });
    const store = createStore({ idb: kvBackend(idb), ls: fakeLs(), debounceMs: 0 });
    const r = await Promise.all([store.warm(['a']), store.warm(['b']), store.warm(['c'])]);
    // 三次调用在同一拍里把键加进集合 → 第一轮一次读完，后两轮无新键不产生读
    expect(idb.reads).toEqual([['a', 'b', 'c']]);
    expect(r.every((s) => typeof s.migrated === 'number')).toBe(true);
    expect(store.get('c')).toBe('3');
  });
});
