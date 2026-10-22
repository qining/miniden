/* E10 × S14 E2E 钓出来的数据丢失：写进主存（IndexedDB）有 200ms 防抖，pagehide 时才 flush，
   而卸载期间发起的 IDB 事务常常来不及提交。刷新后 warm() 看到「LS 新、主存旧」，
   按「主存为准」用旧值把 LS 的新值盖掉 —— 改完马上刷新，最后那一下就没了
   （E2E outlet-tool：拖动后的 at 8.86，刷新后变回拖动前的 6.85，约三次一回）。
   修：每个键「LS 比主存新」这件事同步记在 LS 里（set / remove 时记、主存写成功后划掉），
   warm 时被记着的键以 LS 为准并回灌主存。 */
import { describe, it, expect } from 'vitest';
import { createStore, LS_AHEAD_KEY, type KVBackend, type StorageLike } from '../../src/storage/store';

function fakeLs(seed: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}
function fakeIdb(seed: Record<string, string> = {}): KVBackend & { map: Map<string, string>; failWrites: boolean } {
  const map = new Map<string, string>(Object.entries(seed));
  const b = {
    name: 'indexedDB',
    map,
    failWrites: false,
    read: async (keys: string[]) => {
      const out: Record<string, string> = {};
      for (const k of keys) if (map.has(k)) out[k] = map.get(k)!;
      return out;
    },
    write: async (k: string, v: string) => {
      if (b.failWrites) return false;
      map.set(k, v);
      return true;
    },
    remove: async (k: string) => {
      map.delete(k);
      return true;
    },
  };
  return b;
}

describe('store: 页面卸载前主存没写完 → 刷新后不许用主存的旧值盖掉 LS 的新值', () => {
  it('set 之后没 flush 就「刷新」：新页面读到的是新值，并回灌主存', async () => {
    const ls = fakeLs();
    const idb = fakeIdb({ k: 'v1' });
    const a = createStore({ idb, ls, warmKeys: ['k'], debounceMs: 10000 });
    await a.warm();
    a.set('k', 'v2'); // LS 镜像同步写了，主存写还在防抖里 —— 此刻页面被刷新
    expect(idb.map.get('k')).toBe('v1');
    const b = createStore({ idb, ls, warmKeys: ['k'], debounceMs: 0 });
    await b.warm();
    expect(b.get('k')).toBe('v2');
    expect(ls.map.get('k')).toBe('v2');
    expect(idb.map.get('k')).toBe('v2'); // 回灌
    expect(JSON.parse(ls.map.get(LS_AHEAD_KEY) || '[]')).not.toContain('k'); // 回灌成功后划掉
  });

  it('remove 之后没 flush 就刷新：删掉的东西不许从主存里复活', async () => {
    const ls = fakeLs({ k: 'v1' });
    const idb = fakeIdb({ k: 'v1' });
    const a = createStore({ idb, ls, warmKeys: ['k'], debounceMs: 10000 });
    await a.warm();
    a.remove('k');
    const b = createStore({ idb, ls, warmKeys: ['k'], debounceMs: 0 });
    await b.warm();
    expect(b.get('k')).toBeNull();
    expect(idb.map.has('k')).toBe(false);
  });

  it('flush 成功之后标记被划掉：之后主存与 LS 不一致时仍按「主存为准」（外部改动的收敛口径不变）', async () => {
    const ls = fakeLs();
    const idb = fakeIdb();
    const a = createStore({ idb, ls, warmKeys: ['k'], debounceMs: 10000 });
    await a.warm();
    a.set('k', 'v2');
    await a.flush();
    expect(JSON.parse(ls.map.get(LS_AHEAD_KEY) || '[]')).not.toContain('k');
    ls.map.set('k', '外部改过的LS值');
    const b = createStore({ idb, ls, warmKeys: ['k'], debounceMs: 0 });
    await b.warm();
    expect(b.get('k')).toBe('v2');
  });

  it('flush 写主存途中又写了一次：只有「写进主存的就是最新值」时才划掉标记', async () => {
    const ls = fakeLs();
    const idb = fakeIdb();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const write0 = idb.write;
    idb.write = async (k, v) => {
      await gate; // 主存写入卡在半路
      return write0(k, v);
    };
    const a = createStore({ idb, ls, warmKeys: ['k'], debounceMs: 10000 });
    await a.warm();
    a.set('k', 'v2');
    const p = a.flush();
    await Promise.resolve();
    await Promise.resolve(); // 让 flush 越过 backend() 并取走待写队列（v2 已在写）
    a.set('k', 'v3'); // 写到一半又改了
    release();
    await p;
    expect(idb.map.get('k')).toBe('v2');
    expect(JSON.parse(ls.map.get(LS_AHEAD_KEY) || '[]')).toContain('k'); // v3 还没进主存
    const b = createStore({ idb, ls, warmKeys: ['k'], debounceMs: 0 });
    await b.warm();
    expect(b.get('k')).toBe('v3');
  });

  it('太大没镜像进 LS 的值不打标记（LS 里没有它，以 LS 为准就等于把它删掉）', async () => {
    const ls = fakeLs();
    const idb = fakeIdb({ big: 'old' });
    const a = createStore({ idb, ls, warmKeys: ['big'], debounceMs: 10000, mirrorLimit: 4 });
    await a.warm();
    a.set('big', 'xxxxxxxxxx');
    expect(JSON.parse(ls.map.get(LS_AHEAD_KEY) || '[]')).not.toContain('big');
    const b = createStore({ idb, ls, warmKeys: ['big'], debounceMs: 0, mirrorLimit: 4 });
    await b.warm();
    expect(b.get('big')).toBe('old'); // 丢的是没来得及写的那一下（LS 里本来就没有它），但不会被删
  });
});
