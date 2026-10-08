/* =====================================================================
   E10 存储门面：后端适配层与失败路径（覆盖「兜底/降级/镜像上限」这些平时走不到的分支）
   语义层（迁移、竞态、补载入）在 tests/storage/store.test.ts；这里补的是「后端本身」。
   ===================================================================== */
import { describe, it, expect } from 'vitest';
import { lsBackend, idbBackend, openIdb, createStore } from '../../src/storage/store';
import type { IdbDbLike, IdbRequestLike, IdbStoreLike } from '../../src/storage/store';

/** 最小 StorageLike（Map  backing），用于直接喂 lsBackend */
function mapLS(fail = false) {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => {
      if (fail) throw new Error('LS 被禁用');
      return m.has(k) ? m.get(k)! : null;
    },
    setItem: (k: string, v: string) => {
      if (fail) throw new Error('LS 写不进（配额满）');
      m.set(k, v);
    },
    removeItem: (k: string) => {
      if (fail) throw new Error('LS 删不掉');
      m.delete(k);
    },
  };
}

describe('lsBackend：探测与适配', () => {
  it('没有 raw / 没有 getItem / 探测写入就抛 → 一律 null（不半吊子接上）', () => {
    expect(lsBackend(null)).toBeNull();
    expect(lsBackend(undefined)).toBeNull();
    expect(lsBackend({} as never)).toBeNull();
    expect(lsBackend(mapLS(true) as never)).toBeNull();
  });

  it('正常时 read/write/remove 都走通（write 失败要报 false，门面才知道要降级）', async () => {
    const ls = mapLS();
    const b = lsBackend(ls as never)!;
    expect(b.name).toBe('localStorage');
    ls.m.set('a', '1');
    expect(await b.read(['a', 'missing'])).toEqual({ a: '1' });
    expect(await b.write('b', '2')).toBe(true);
    expect(ls.m.get('b')).toBe('2');
    expect(await b.remove('b')).toBe(true);
    expect(ls.m.has('b')).toBe(false);
  });

  it('探测写入用的键必须被清掉（不能在用户机器上留垃圾）', async () => {
    const ls = mapLS();
    lsBackend(ls as never);
    expect(ls.m.has('__miniden_probe')).toBe(false);
  });
});

describe('idbBackend：事务/请求失败要变成 false，不能抛出去', () => {
  const fakeStore = (fail: boolean): IdbDbLike => {
    const data = new Map<string, string>();
    const store: IdbStoreLike = {
      get: (k: string) => {
        const r: IdbRequestLike = { onsuccess: null, onerror: null };
        queueMicrotask(() => {
          if (fail) {
            (r as IdbRequestLike & { error?: Error }).error = new Error('读失败');
            r.onerror?.();
          } else {
            r.result = data.get(k);
            r.onsuccess?.();
          }
        });
        return r;
      },
      put: (v: string, k: string) => {
        const r: IdbRequestLike = { onsuccess: null, onerror: null };
        queueMicrotask(() => {
          if (fail) {
            (r as IdbRequestLike & { error?: Error }).error = new Error('写失败');
            r.onerror?.();
          } else {
            data.set(k, v);
            r.onsuccess?.();
          }
        });
        return r;
      },
      delete: (k: string) => {
        const r: IdbRequestLike = { onsuccess: null, onerror: null };
        queueMicrotask(() => {
          if (fail) r.onerror?.();
          else {
            data.delete(k);
            r.onsuccess?.();
          }
        });
        return r;
      },
    };
    return {
      transaction: () => ({ objectStore: () => store }),
      close: () => {},
    };
  };

  it('读写删都成功时返回 true', async () => {
    const b = idbBackend(fakeStore(false));
    expect(await b.write('k', 'v')).toBe(true);
    expect(await b.read(['k'])).toEqual({ k: 'v' });
    expect(await b.remove('k')).toBe(true);
  });

  it('请求 onerror → false（门面上面据此标降级）', async () => {
    const b = idbBackend(fakeStore(true));
    expect(await b.write('k', 'v')).toBe(false);
    expect(await b.read(['k'])).toEqual({});
    expect(await b.remove('k')).toBe(false);
  });

  it('transaction 抛 / objectStore 抛 / 没有 transaction → false 而不是异常', async () => {
    const throwing: IdbDbLike = {
      transaction: () => {
        throw new Error('库已关');
      },
    };
    expect(await idbBackend(throwing).write('k', 'v')).toBe(false);
    const noStore: IdbDbLike = {
      transaction: () => ({
        objectStore: () => {
          throw new Error('store 不存在');
        },
      }),
    };
    expect(await idbBackend(noStore).write('k', 'v')).toBe(false);
    expect(await idbBackend({} as unknown as IdbDbLike).write('k', 'v')).toBe(false);
    expect(await idbBackend({ transaction: () => null } as unknown as IdbDbLike).read(['k'])).toEqual({});
  });
});

describe('openIdb：所有「开不起来」的路径都要变成 null（然后门面退回 localStorage）', () => {
  // openIdb 从 globalThis.indexedDB 取工厂（浏览器就是这么给的）
  const withFactory = async (make: (name: string, ver?: number) => IdbRequestLike | null) => {
    const g = globalThis as Record<string, unknown>;
    const saved = g.indexedDB;
    g.indexedDB = { open: make };
    try {
      return await openIdb();
    } finally {
      g.indexedDB = saved;
    }
  };

  it('open() 抛 → null', async () => {
    expect(
      await withFactory(() => {
        throw new Error('IDB 被禁用');
      })
    ).toBeNull();
  });

  it('open() 返回 null → null', async () => expect(await withFactory(() => null)).toBeNull());

  it('onerror / onblocked（版本比别的标签低）→ null', async () => {
    const mk = (fire: 'err' | 'blocked') => () => {
      const r: IdbRequestLike = { onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => (fire === 'err' ? r.onerror?.() : r.onblocked?.()));
      return r;
    };
    expect(await withFactory(mk('err'))).toBeNull();
    expect(await withFactory(mk('blocked'))).toBeNull();
  });

  it('onsuccess 但库不能开事务 → null（半残的库不如不用）', async () => {
    expect(
      await withFactory(() => {
        const r: IdbRequestLike = { onsuccess: null, onerror: null };
        queueMicrotask(() => {
          r.result = {} as IdbDbLike; // 没有 transaction
          r.onsuccess?.();
        });
        return r;
      })
    ).toBeNull();
  });

  it('onupgradeneeded 要自己建 store（首次开库）', async () => {
    let created = '';
    const store: IdbStoreLike = { get: () => null as never, put: () => null as never, delete: () => null as never };
    const db: IdbDbLike = {
      createObjectStore: (n: string) => {
        created = n;
      },
      transaction: () => ({ objectStore: () => store }),
    };
    const b = await withFactory(() => {
      const r: IdbRequestLike = { onsuccess: null, onerror: null };
      queueMicrotask(() => {
        r.result = db;
        r.onupgradeneeded?.();
        r.onsuccess?.();
      });
      return r;
    });
    expect(b?.name).toBe('indexedDB');
    expect(created).toBe('miniden_kv');
  });
});

describe('门面在后端失败时的行为（降级标记 / 镜像上限 / 无远端）', () => {
  it('主存写失败 → idbFails 计数 + 降级标记写进 LS（下次载入优先信 LS）', async () => {
    const ls = mapLS();
    const badDb: IdbDbLike = {
      transaction: () => {
        throw new Error('库坏了');
      },
    };
    const s = createStore({ ls: ls as never, idb: Promise.resolve(idbBackend(badDb)), mirrorLimit: 1000 });
    s.set('k', 'v');
    const st = await s.flush();
    expect(st.idbFails).toBe(1);
    expect(s.degraded()).toBe(true);
    expect(ls.m.get('planner_store_degraded')).toBe('1');
    // 值本身仍在内存 + LS 镜像里（用户不会突然「存档没了」）
    expect(s.get('k')).toBe('v');
    expect(ls.m.get('k')).toBe('v');
  });

  it('没有主存（IDB 不可用）→ 纯 localStorage 模式，backend() 报 localStorage', async () => {
    const ls = mapLS();
    const s = createStore({ ls: ls as never, idb: Promise.resolve(null) });
    s.set('k', 'v');
    const st = await s.flush();
    expect(st.idbWrites).toBe(0);
    expect(st.idbFails).toBe(0);
    expect(s.degraded()).toBe(false);
    expect(s.backend()).toBe('localStorage'); // 同步返回名字字符串
    expect(ls.m.get('k')).toBe('v');
  });

  it('超过镜像上限的键：写主存 + 内存，不写 LS（LS 配额 5MB 是硬墙）', async () => {
    const ls = mapLS();
    const writes: string[] = [];
    const spy = {
      getItem: (k: string) => ls.getItem(k),
      setItem: (k: string, v: string) => {
        writes.push(k);
        ls.setItem(k, v);
      },
      removeItem: (k: string) => ls.removeItem(k),
    };
    const big = 'x'.repeat(2_000_000);
    const s = createStore({ ls: spy as never, idb: Promise.resolve(null), mirrorLimit: 1_500_000 });
    s.set('big', big);
    const st = await s.flush();
    expect(st.skippedMirror).toBe(1);
    expect(writes).not.toContain('big'); // 没往 LS 里塞
    expect(s.get('big')).toBe(big); // 但内存里有，本会话读得到
  });

  it('防抖：连按三次只落一次主存（拖动时不刷爆 IDB）；LS 镜像仍是每次同步写', async () => {
    const ls = mapLS();
    let idbWrites = 0;
    const idb = {
      name: 'indexedDB',
      read: async () => ({}),
      write: async () => {
        idbWrites++;
        return true;
      },
      remove: async () => true,
    };
    const s = createStore({ ls: ls as never, idb: Promise.resolve(idb), debounceMs: 25 });
    s.set('k', '1');
    s.set('k', '2');
    s.set('k', '3');
    expect(ls.m.get('k')).toBe('3'); // LS 镜像同步：旧代码路径 / bench 立刻读得到当前值
    await new Promise((r) => setTimeout(r, 80)); // 等防抖自己跑完
    expect(idbWrites).toBe(1); // 主存只落最后一次
  });

  it('remove() 在没有主存时也要把 LS 里的值删掉（旧 removeItem 的语义）', async () => {
    const ls = mapLS();
    ls.m.set('k', 'v');
    const s = createStore({ ls: ls as never, idb: Promise.resolve(null) });
    await s.warm(['k']);
    s.remove('k');
    expect(s.get('k')).toBeNull();
    expect(ls.m.has('k')).toBe(false);
  });
});
