/* E10 持久化门面单测：迁移语义、主存优先、降级回退、同步读回退。
   没有真 IndexedDB —— 用假后端注入（store.ts 把后端做成可注入正是为了这一层可测）。 */
import { describe, it, expect } from 'vitest';
import {
  createStore,
  lsBackend,
  idbBackend,
  openIdb,
  DEGRADED_FLAG,
  type KVBackend,
  type StorageLike,
  type IdbDbLike,
  type IdbRequestLike,
} from '../../src/storage/store';

/** 假 localStorage（Map 版）。 */
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

/** 假 IndexedDB 后端（直接实现 KVBackend）。failWrites 让它写失败，用来测降级。 */
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

/** 假 IndexedDB 数据库（走 idbBackend 适配器，测的是适配器本身）。 */
function fakeIdbDb(seed: Record<string, string> = {}): IdbDbLike & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed));
  /* IDB 请求对象：回调是「先赋值、后异步触发」。假实现用 defineProperty 复刻这个时序，
     否则 reqPromise 挂上 onsuccess 之后没人调用它 → 测试挂到超时。 */
  const req = (result?: unknown) => {
    const r: { result?: unknown; onsuccess?: ((e?: unknown) => void) | null } = { result, onsuccess: null };
    Object.defineProperty(r, 'onsuccess', {
      configurable: true,
      get: () => null,
      set: (fn: ((e?: unknown) => void) | null) => {
        if (typeof fn === 'function') queueMicrotask(() => fn());
      },
    });
    return r;
  };
  const store = {
    get: (k: string) => req(map.has(k) ? map.get(k) : undefined),
    put: (v: string, k?: string) => {
      if (k !== undefined) map.set(k, v);
      return req(k);
    },
    delete: (k: string) => {
      map.delete(k);
      return req(undefined);
    },
  };
  return { map, transaction: () => ({ objectStore: () => store }) };
}

describe('store: LS → IDB 迁移（只复制，绝不删）', () => {
  it('IDB 空 + LS 有值 → 复制进 IDB，LS 原样留着，读到的还是那份值', async () => {
    const ls = fakeLs({ 'planner_doc_v1:fp': '{"a":1}' });
    const idb = fakeIdb();
    const s = createStore({ idb, ls, warmKeys: ['planner_doc_v1:fp'], debounceMs: 0 });
    const st = await s.warm();
    expect(s.get('planner_doc_v1:fp')).toBe('{"a":1}');
    expect(idb.map.get('planner_doc_v1:fp')).toBe('{"a":1}');
    expect(ls.map.get('planner_doc_v1:fp')).toBe('{"a":1}'); // 迁移不删旧键（AGENTS：删了就是毁用户数据）
    expect(st.migrated).toBe(1);
    expect(st.conflicts).toBe(0);
  });

  it('两边都有且不同（IDB 写一直成功）→ 以主存为准，并把 LS 收敛成同一个值', async () => {
    const ls = fakeLs({ k: 'LS值' });
    const idb = fakeIdb({ k: 'IDB值' });
    const s = createStore({ idb, ls, warmKeys: ['k'], debounceMs: 0 });
    const st = await s.warm();
    expect(s.get('k')).toBe('IDB值');
    expect(ls.map.get('k')).toBe('IDB值');
    expect(st.conflicts).toBe(1);
  });

  it('warm 只处理显式给出的键：旧单桶键 / planner_userGeo_v1 不会被搬进 IDB', async () => {
    const ls = fakeLs({ planner_doc_v1: '旧单桶', planner_userGeo_v1: '旧格式', 'planner_doc_v1:fp': '新键' });
    const idb = fakeIdb();
    const s = createStore({ idb, ls, warmKeys: ['planner_doc_v1:fp'], debounceMs: 0 });
    await s.warm();
    expect(idb.map.has('planner_doc_v1')).toBe(false);
    expect(idb.map.has('planner_userGeo_v1')).toBe(false);
    expect(idb.map.has('planner_doc_v1:fp')).toBe(true);
    // 旧键仍可只读
    expect(s.lsGet('planner_doc_v1')).toBe('旧单桶');
  });
});

describe('store: 降级（IDB 写失败过 → 以 LS 为准并回灌）', () => {
  it('LS 里有降级标记 → 用 LS 的值覆盖 IDB 里的旧值，回灌成功后撤标记', async () => {
    const ls = fakeLs({ k: 'LS新值', [DEGRADED_FLAG]: '1' });
    const idb = fakeIdb({ k: 'IDB旧值' });
    const s = createStore({ idb, ls, warmKeys: ['k'], debounceMs: 0 });
    const st = await s.warm();
    expect(s.get('k')).toBe('LS新值');
    expect(st.conflicts).toBe(1);
    expect(idb.map.get('k')).toBe('LS新值');
    expect(s.degraded()).toBe(false); // 回灌成功 → 主存重新可信
    expect(ls.map.has(DEGRADED_FLAG)).toBe(false);
  });

  it('回灌也失败 → 标记留着（下次载入仍以 LS 为准）', async () => {
    const ls = fakeLs({ k: 'LS新值', [DEGRADED_FLAG]: '1' });
    const idb = fakeIdb({ k: 'IDB旧值' });
    idb.failWrites = true;
    const s = createStore({ idb, ls, warmKeys: ['k'], debounceMs: 0 });
    await s.warm();
    expect(s.degraded()).toBe(true);
    expect(ls.map.get(DEGRADED_FLAG)).toBe('1');
    expect(idb.map.get('k')).toBe('IDB旧值');
  });

  it('flush 写失败 → 立降级标记；标记不在同一会话里撤，要等下一次载入成功回灌', async () => {
    const ls = fakeLs();
    const idb = fakeIdb();
    idb.failWrites = true;
    const s = createStore({ idb, ls, warmKeys: [], debounceMs: 0 });
    await s.warm();
    s.set('k', 'v1');
    await s.flush();
    expect(s.degraded()).toBe(true);
    expect(ls.map.get(DEGRADED_FLAG)).toBe('1');
    expect(idb.map.has('k')).toBe(false);
    idb.failWrites = false;
    s.set('k', 'v2');
    await s.flush();
    expect(idb.map.get('k')).toBe('v2');
    expect(s.degraded()).toBe(true); // 中途写成功不代表失败过的键已同步
    const s2 = createStore({ idb, ls, warmKeys: ['k'], debounceMs: 0 });
    await s2.warm();
    expect(s2.degraded()).toBe(false);
    expect(ls.map.has(DEGRADED_FLAG)).toBe(false);
  });
});

describe('store: 同步读回退与写入镜像', () => {
  it('warm 还没完成时 get() 直接读 localStorage（与旧行为一致，初始化流程不必 async）', () => {
    const ls = fakeLs({ k: 'LS值' });
    const s = createStore({
      idb: new Promise(() => {
        /* 永不完成 */
      }),
      ls,
      debounceMs: 0,
    });
    expect(s.get('k')).toBe('LS值');
    expect(s.has('k')).toBe(true);
    expect(s.get('missing')).toBe(null);
  });

  it('set() 同时进缓存 + 排队主存 + 镜像 LS；超过 mirrorLimit 只进主存', async () => {
    const ls = fakeLs();
    const idb = fakeIdb();
    const s = createStore({ idb, ls, debounceMs: 0, mirrorLimit: 10 });
    s.set('small', '12345');
    s.set('big', 'x'.repeat(11));
    expect(s.get('small')).toBe('12345'); // 同步可读，不等异步
    expect(ls.map.get('small')).toBe('12345');
    expect(ls.map.has('big')).toBe(false); // 太大：不占 LS 预算
    await s.flush();
    expect(idb.map.get('small')).toBe('12345');
    expect(idb.map.get('big')).toBe('x'.repeat(11)); // 这正是换 IndexedDB 的意义
    const st = s.stats();
    expect(st.lsMirrors).toBe(1);
    expect(st.skippedMirror).toBe(1);
  });

  it('remove() 清缓存 + 清 LS，并在 flush 里删主存', async () => {
    const ls = fakeLs({ k: 'v' });
    const idb = fakeIdb({ k: 'v' });
    const s = createStore({ idb, ls, warmKeys: ['k'], debounceMs: 0 });
    await s.warm();
    s.remove('k');
    expect(s.get('k')).toBe(null); // 缓存里记的是「已删除」，不会回退去读 LS
    expect(ls.map.has('k')).toBe(false);
    await s.flush();
    expect(idb.map.has('k')).toBe(false);
  });

  it('lsGet / lsRemove 只碰 localStorage：不进缓存、不迁移、不写主存', async () => {
    const ls = fakeLs({ legacy: '旧值' });
    const idb = fakeIdb();
    const s = createStore({ idb, ls, debounceMs: 0 });
    expect(s.lsGet('legacy')).toBe('旧值');
    expect(s.get('legacy')).toBe('旧值'); // get 的回退也是 LS，但不会把值挂进主存
    s.lsRemove('legacy');
    expect(ls.map.has('legacy')).toBe(false);
    await s.flush();
    expect(idb.map.size).toBe(0);
  });

  it('IndexedDB 不可用 → 全部走 localStorage（旧行为），backend 如实报告', async () => {
    const ls = fakeLs({ k: 'v' });
    const s = createStore({ idb: Promise.resolve(null), ls, warmKeys: ['k'], debounceMs: 0 });
    const st = await s.warm();
    expect(s.backend()).toBe('localStorage');
    expect(s.get('k')).toBe('v');
    s.set('k2', 'v2');
    await s.flush();
    expect(ls.map.get('k2')).toBe('v2');
    expect(st.idbWrites).toBe(0);
  });

  it('localStorage 也不可用（隐私模式）→ 不抛错，backend = none', async () => {
    const boom: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    const s = createStore({ idb: Promise.resolve(null), ls: boom, warmKeys: ['k'], debounceMs: 0 });
    await s.warm();
    expect(s.backend()).toBe('none');
    expect(s.get('k')).toBe(null);
    s.set('k', 'v');
    expect(s.get('k')).toBe('v'); // 内存缓存仍然工作（本次会话不丢）
    await s.flush();
  });
});

describe('store: 补载入（主存给了页面刚才没读到的值）', () => {
  it('LS 被清过而 IDB 还有值 → warm 通知页面重新载入', async () => {
    const ls = fakeLs(); // 页面同步读：什么都没有
    const idb = fakeIdb({ 'planner_doc_v1:fp': '{"saved":true}' });
    const s = createStore({ idb, ls, warmKeys: ['planner_doc_v1:fp'], debounceMs: 0 });
    let seen: string[] = [];
    s.onHydrate((keys) => (seen = keys));
    const st = await s.warm();
    expect(seen).toEqual(['planner_doc_v1:fp']);
    expect(st.hydrated).toBe(1);
    expect(s.get('planner_doc_v1:fp')).toBe('{"saved":true}');
  });

  it('两边值一样 → 不打扰页面（绝大多数情况）', async () => {
    const ls = fakeLs({ k: 'v' });
    const idb = fakeIdb({ k: 'v' });
    const s = createStore({ idb, ls, warmKeys: ['k'], debounceMs: 0 });
    let called = 0;
    s.onHydrate(() => called++);
    const st = await s.warm();
    expect(called).toBe(0);
    expect(st.hydrated).toBe(0);
  });

  it('warm 之后注册回调也立刻收到（页面注册时机不敏感）', async () => {
    const idb = fakeIdb({ k: '只在主存' });
    const s = createStore({ idb, ls: fakeLs(), warmKeys: ['k'], debounceMs: 0 });
    await s.warm();
    let seen: string[] = [];
    s.onHydrate((keys) => (seen = keys));
    expect(seen).toEqual(['k']);
  });
});

describe('store: idbBackend 适配器（真 IndexedDB 的最小面）', () => {
  it('read 只返回存在的键；write 用 out-of-line 键；remove 删掉', async () => {
    const db = fakeIdbDb({ a: 'A' });
    const b = idbBackend(db);
    expect(b.name).toBe('indexedDB');
    expect(await b.read(['a', 'b'])).toEqual({ a: 'A' });
    expect(await b.write('c', 'C')).toBe(true);
    expect(db.map.get('c')).toBe('C');
    expect(await b.remove('a')).toBe(true);
    expect(db.map.has('a')).toBe(false);
  });

  it('transaction 抛错（库被关）→ read 返回空、write 返回 false（不抛）', async () => {
    const db: IdbDbLike = {
      transaction: () => {
        throw new Error('Database closed');
      },
    };
    const b = idbBackend(db);
    expect(await b.read(['a'])).toEqual({});
    expect(await b.write('a', 'x')).toBe(false);
  });

  it('lsBackend 探测失败（setItem 抛）→ null，门面退回纯内存', async () => {
    expect(lsBackend(null)).toBe(null);
    expect(
      lsBackend({
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceeded');
        },
        removeItem: () => undefined,
      })
    ).toBe(null);
  });
});

/* 假 IDBFactory：open 是原型方法且依赖 this —— 跟真 Chrome 一样，
   把它取下来裸调会当场 TypeError。openIdb 要是丢了接收者，这里就会红。 */
class FakeIdbFactory {
  dbs = new Map<string, Map<string, string>>();
  open(name: string, _ver = 1): IdbRequestLike {
    const dbs = this.dbs; // this === undefined 时抛 TypeError（正是真宿主的行为）
    const req: IdbRequestLike = {};
    queueMicrotask(() => {
      let store = dbs.get(name);
      const isNew = !store;
      if (!store) {
        store = new Map<string, string>();
        dbs.set(name, store);
      }
      const s = store;
      const rq = (result: unknown) => {
        const r: IdbRequestLike = { result };
        queueMicrotask(() => r.onsuccess && r.onsuccess());
        return r;
      };
      const db: IdbDbLike = {
        transaction: () => ({
          objectStore: () => ({
            get: (k: string) => rq(s.get(k)),
            put: (v: string, k?: string) => {
              if (k !== undefined) s.set(k, v);
              return rq(k);
            },
            delete: (k: string) => {
              s.delete(k);
              return rq(undefined);
            },
          }),
        }),
      };
      req.result = db;
      if (isNew && req.onupgradeneeded) req.onupgradeneeded();
      if (req.onsuccess) req.onsuccess();
    });
    return req;
  }
}

describe('store: openIdb（浏览器宿主方法）', () => {
  const withFactory = async (fn: () => Promise<void>) => {
    const g = globalThis as Record<string, unknown>;
    const prev = g.indexedDB;
    g.indexedDB = new FakeIdbFactory();
    try {
      await fn();
    } finally {
      g.indexedDB = prev;
    }
  };

  it('open 必须带接收者调用 → 拿到 indexedDB 后端并能读写', async () => {
    await withFactory(async () => {
      const b = await openIdb();
      expect(b).not.toBeNull();
      expect(b!.name).toBe('indexedDB');
      expect(await b!.write('k', 'v')).toBe(true);
      expect(await b!.read(['k', 'nope'])).toEqual({ k: 'v' });
      expect(await b!.remove('k')).toBe(true);
      expect(await b!.read(['k'])).toEqual({});
    });
  });

  it('门面端到端：主存可用时 backend = indexedDB（不是静默退回 localStorage）', async () => {
    await withFactory(async () => {
      const ls = fakeLs({ k: 'LS值' });
      const s = createStore({ idb: openIdb(), ls, warmKeys: ['k'], debounceMs: 0 });
      const st = await s.warm();
      expect(s.backend()).toBe('indexedDB');
      expect(st.migrated).toBe(1); // LS 的旧值被复制进主存
      expect(ls.map.get('k')).toBe('LS值'); // 旧键不删
    });
  });

  it('warm 还在路上时页面自己写过 → warm 不得拿主存旧值覆盖这个写（竞态）', async () => {
    const mem = new Map<string, string>();
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    const slowIdb: KVBackend = {
      name: 'indexedDB',
      read: async (keys) => {
        await gate;
        const out: Record<string, string> = {};
        for (const k of keys) out[k] = 'IDB旧';
        return out;
      },
      write: async (k, v) => {
        mem.set(k, v);
        return true;
      },
      remove: async (k) => {
        mem.delete(k);
        return true;
      },
    };
    const ls = fakeLs({ k: 'LS旧' });
    const s = createStore({ idb: Promise.resolve(slowIdb), ls, warmKeys: ['k'], debounceMs: 0 });
    const warmP = s.warm();
    s.set('k', '页面新'); // warm 未完成时的写（真实页面就是这种时序）
    release();
    await warmP;
    expect(s.get('k')).toBe('页面新');
    expect(ls.map.get('k')).toBe('页面新'); // 关键：LS 没被主存旧值盖掉
    expect(mem.get('k')).toBe('页面新'); // 主存最终跟上页面的值
    expect(s.stats().hydrated).toBe(0); // 页面手里已经是最新值 → 不该报补载入
  });

  it('indexedDB 不存在 → null（门面退回 LS）', async () => {
    const g = globalThis as Record<string, unknown>;
    const prev = g.indexedDB;
    g.indexedDB = undefined;
    try {
      expect(await openIdb()).toBe(null);
    } finally {
      g.indexedDB = prev;
    }
  });
});
