/* =====================================================================
   src/storage/store.ts — E10：持久化门面（localStorage → IndexedDB）

   为什么换：localStorage 的预算是整个源约 5MB，而且「清浏览器数据 / 换浏览器 /
   无痕窗口」都会看不见（S13 已经因此把内置布局搬进户型 JSON）。户型文档接下来要
   长出新东西（floorOutline、描图特征、更大的 layout），第一个撞的就是 LS 预算。
   IndexedDB 配额以百 MB 计，但它是异步 API —— 所以这里把它包成**同步读、异步写**
   的门面，让 app 的初始化流程（今天全程同步）不必改成 async。

   四条红线：
   1. 读永远同步：warm() 还没完成时 get() 直接读 localStorage —— 与旧行为逐字节一致
      （#calib / #ui: 的像素基线因此不受影响）。
   2. 迁移只复制、绝不删：旧键（含单桶 planner_doc_v1 / planner_v1 / planner_userGeo_v1）
      原样留在 localStorage（AGENTS：删了就是毁用户数据）。门面用 lsGet/lsRemove
      明确表达「这是旧键，只读，不参与迁移」。
   3. IDB 写失败 → 在 localStorage 里留降级标记，下次载入以 LS 为准并把值回灌 IDB。
      否则「IDB 是主存但存的是旧值」会在下一次打开时覆盖掉用户的新存档。
   4. 每次写同时镜像进 LS（体积在预算内时）：旧代码路径、以及 IDB 被屏蔽的浏览器
      仍然看得到同一份数据。

   纯度：不 import three / document（R7）。IndexedDB 与 Storage 用最小结构化声明
   （tsconfig 的 lib 只有 ES2020，没有 DOM 类型），所以本模块能在 node 里用假后端测。
   ===================================================================== */

/** localStorage 的最小面（测试里用假对象注入）。 */
export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** 键值后端。实现：lsBackend（同步包成 Promise）、idbBackend。 */
export interface KVBackend {
  readonly name: string;
  /** 只读显式给出的键（不做全库扫描：本源的键是已知的，扫全库会读到别的应用的键）。 */
  read(keys: string[]): Promise<Record<string, string>>;
  write(k: string, v: string): Promise<boolean>;
  remove(k: string): Promise<boolean>;
}

/** IndexedDB 的最小声明（没有 DOM lib 也能编译；真机由浏览器提供）。 */
export interface IdbRequestLike {
  onsuccess?: ((e?: unknown) => void) | null;
  onerror?: ((e?: unknown) => void) | null;
  onupgradeneeded?: ((e?: unknown) => void) | null;
  onblocked?: ((e?: unknown) => void) | null;
  result?: unknown;
}
export interface IdbStoreLike {
  get(k: string): IdbRequestLike;
  put(v: string, k?: string): IdbRequestLike;
  delete(k: string): IdbRequestLike;
}
export interface IdbDbLike {
  transaction?: (store: string, mode?: string) => { objectStore: (n: string) => IdbStoreLike } | undefined;
  createObjectStore?: (name: string, opts?: { keyPath?: string; autoIncrement?: boolean }) => unknown;
  close?: () => void;
}

export const IDB_DB = 'miniden-planner';
export const IDB_STORE = 'miniden_kv';
/** LS 里的降级标记：上一次 IDB 写失败过 → 下次载入以 LS 为准。 */
export const DEGRADED_FLAG = 'planner_store_degraded';

/** 探测过、可用的 localStorage 后端；不可用（隐私模式/配额）返回 null。 */
export function lsBackend(raw: StorageLike | null | undefined): KVBackend | null {
  if (!raw || typeof raw.getItem !== 'function') return null;
  try {
    raw.setItem('__miniden_probe', '1');
    raw.removeItem('__miniden_probe');
  } catch (_e) {
    return null;
  }
  return {
    name: 'localStorage',
    read: async (keys) => {
      const out: Record<string, string> = {};
      for (const k of keys) {
        try {
          const v = raw.getItem(k);
          if (typeof v === 'string') out[k] = v;
        } catch (_e) {
          /* 读不到的键当作不存在 */
        }
      }
      return out;
    },
    write: async (k, v) => {
      try {
        raw.setItem(k, v);
        return true;
      } catch (_e) {
        return false;
      }
    },
    remove: async (k) => {
      try {
        raw.removeItem(k);
        return true;
      } catch (_e) {
        return false;
      }
    },
  };
}

function reqPromise<T>(make: () => IdbRequestLike | null): Promise<T | undefined> {
  return new Promise((resolve) => {
    let r: IdbRequestLike | null = null;
    try {
      r = make();
    } catch (_e) {
      resolve(undefined);
      return;
    }
    if (!r) {
      resolve(undefined);
      return;
    }
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => resolve(undefined);
  });
}

/** 只关心「请求成功还是失败」。delete() 的 result 本来就是 undefined，
    用 result 判成败会把「删成功」误判成失败（写路径才恰好能用 result）。 */
function reqDone(make: () => IdbRequestLike | null): Promise<boolean> {
  return new Promise((resolve) => {
    let r: IdbRequestLike | null = null;
    try {
      r = make();
    } catch (_e) {
      resolve(false);
      return;
    }
    if (!r) {
      resolve(false);
      return;
    }
    r.onsuccess = () => resolve(true);
    r.onerror = () => resolve(false);
  });
}

export function idbBackend(db: IdbDbLike, storeName: string = IDB_STORE): KVBackend {
  const store = (mode: string): IdbStoreLike | null => {
    if (!db.transaction) return null;
    let tx: { objectStore: (n: string) => IdbStoreLike } | undefined;
    try {
      tx = db.transaction(storeName, mode);
    } catch (_e) {
      return null;
    }
    if (!tx || typeof tx.objectStore !== 'function') return null;
    try {
      return tx.objectStore(storeName);
    } catch (_e) {
      return null;
    }
  };
  return {
    name: 'indexedDB',
    read: async (keys) => {
      const out: Record<string, string> = {};
      for (const k of keys) {
        const s = store('readonly');
        if (!s) break;
        const v = await reqPromise<string>(() => s.get(k));
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    },
    write: async (k, v) => {
      const s = store('readwrite');
      if (!s) return false;
      return reqDone(() => s.put(v, k));
    },
    remove: async (k) => {
      const s = store('readwrite');
      if (!s) return false;
      // 删失败必须报 false：门面据此标降级。报 true 的后果是 LS 里删了、主存里还在 →
      // 下次载入又把本该消失的存档读回来（loadDoc 里 remove(DOC_KEY) 就是这条路径）。
      return reqDone(() => s.delete(k));
    },
  };
}

/** 打开 IndexedDB 并建好对象库；不可用（无 API / 被屏蔽 / 被阻塞）时 resolve(null)。 */
export function openIdb(
  dbName: string = IDB_DB,
  version = 1,
  storeName: string = IDB_STORE
): Promise<KVBackend | null> {
  const g = globalThis as Record<string, unknown>;
  const factory = g.indexedDB as { open?: (n: string, v?: number) => IdbRequestLike } | undefined;
  if (!factory || typeof factory.open !== 'function') return Promise.resolve(null);
  // 必须 bind：把宿主方法取下来裸调会丢 this → Chrome 当场抛 TypeError
  // （"Can only call IDBFactory.open on an IDBFactory"），被下面的 catch 接住 → 静默退回 localStorage。
  // （TS 的属性收窄在闭包里会失效，所以不能直接 factory.open(...)；bind 同时解决类型与 this。）
  const open = factory.open.bind(factory);
  return new Promise((resolve) => {
    let req: IdbRequestLike;
    try {
      req = open(dbName, version);
    } catch (_e) {
      resolve(null);
      return;
    }
    if (!req) {
      // 防御：某些环境（隐私模式垫片）会让 open() 返回空。不挡住的话下面赋值直接抛，
      // 整个 openIdb 变成 rejected promise → 存储永远 ready 不了。
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result as IdbDbLike | undefined;
      if (db && typeof db.createObjectStore === 'function') {
        try {
          db.createObjectStore(storeName);
        } catch (_e) {
          /* 已存在（版本没变过）*/
        }
      }
    };
    req.onsuccess = () => {
      const db = req.result as IdbDbLike | undefined;
      if (!db || typeof db.transaction !== 'function') {
        resolve(null);
        return;
      }
      resolve(idbBackend(db, storeName));
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

export interface StoreOptions {
  /** 主存后端：已就绪的后端、或打开它的 Promise（classic script 里不能用顶层 await）。 */
  idb: KVBackend | null | Promise<KVBackend | null>;
  /** 回退 + 镜像 + 旧键来源。不可用时传 null。 */
  ls?: StorageLike | null;
  /** 参与「LS → IDB 迁移」的键（只复制，不删 LS）。 */
  warmKeys?: string[];
  /** 超过这个字符数就不镜像进 LS（LS 预算是整个源约 5MB）。 */
  mirrorLimit?: number;
  degradedFlag?: string;
  debounceMs?: number;
}

export interface StoreStats {
  migrated: number;
  conflicts: number;
  idbWrites: number;
  idbFails: number;
  lsMirrors: number;
  lsFails: number;
  skippedMirror: number;
  hydrated: number;
}

export interface Store {
  /** 预热：读主存 + 迁移旧键。可多次调用（累加键集合）。 */
  warm(keys?: string[]): Promise<StoreStats>;
  /** 最近一次 warm 的完成（没 warm 过则等第一次）。 */
  ready(): Promise<StoreStats>;
  get(k: string): string | null;
  set(k: string, v: string): void;
  remove(k: string): void;
  has(k: string): boolean;
  /** 旧键专用：只读 localStorage，不迁移、不写、不进缓存。 */
  lsGet(k: string): string | null;
  lsRemove(k: string): void;
  flush(): Promise<StoreStats>;
  /** 主存的值和页面刚才同步读到的值不一样 → 通知（页面据此重新载入一次）。 */
  onHydrate(cb: (keys: string[]) => void): void;
  stats(): StoreStats;
  degraded(): boolean;
  backend(): string;
}

export function createStore(o: StoreOptions): Store {
  const mirrorLimit = o.mirrorLimit ?? 1500000;
  const debounceMs = o.debounceMs ?? 200;
  const flag = o.degradedFlag ?? DEGRADED_FLAG;
  const ls = o.ls ?? null;
  const cache = new Map<string, string | null>();
  const pendingW = new Map<string, string>();
  const pendingD = new Set<string>();
  const touched = new Set<string>(); // warm 完成前页面自己写过的键（它们比 warm 起点读到的值更新）
  const warmKeys = new Set<string>(o.warmKeys ?? []);
  const hydrateCbs: Array<(keys: string[]) => void> = [];
  const hydrated = new Set<string>();
  const st: StoreStats = {
    migrated: 0,
    conflicts: 0,
    idbWrites: 0,
    idbFails: 0,
    lsMirrors: 0,
    lsFails: 0,
    skippedMirror: 0,
    hydrated: 0,
  };

  let idb: KVBackend | null = null;
  let opening: Promise<KVBackend | null> | null = null;
  let degraded = false;
  let warmPromise: Promise<StoreStats> | null = null;
  let timer: unknown = null;

  const lsGetRaw = (k: string): string | null => {
    if (!ls) return null;
    try {
      const v = ls.getItem(k);
      return typeof v === 'string' ? v : null;
    } catch (_e) {
      return null;
    }
  };
  const lsSetRaw = (k: string, v: string): boolean => {
    if (!ls) return false;
    try {
      ls.setItem(k, v);
      return true;
    } catch (_e) {
      return false;
    }
  };
  const markDegraded = () => {
    degraded = true;
    lsSetRaw(flag, '1');
  };
  const clearDegraded = () => {
    if (!degraded) return;
    degraded = false;
    try {
      ls?.removeItem(flag);
    } catch (_e) {
      /* 标记清不掉不影响正确性：下一次 warm 会重新判定 */
    }
  };

  function schedule() {
    if (debounceMs <= 0) {
      void flush();
      return;
    }
    if (timer !== null) return;
    const g = globalThis as Record<string, unknown>;
    if (typeof g.setTimeout !== 'function') {
      void flush();
      return;
    }
    timer = (g.setTimeout as unknown as (fn: () => void, ms: number) => unknown)(() => {
      timer = null;
      void flush();
    }, debounceMs);
  }

  async function backend(): Promise<KVBackend | null> {
    if (idb) return idb;
    if (!opening) opening = Promise.resolve(o.idb ?? null).then((b) => (idb = b ?? null));
    return opening;
  }

  function warm(keys?: string[]): Promise<StoreStats> {
    for (const k of keys ?? []) warmKeys.add(k);
    if (!warmPromise) {
      warmPromise = (async () => {
        const remote = await backend();
        const list = Array.from(warmKeys);
        const store = remote ? await remote.read(list) : {};
        const local: Record<string, string> = {};
        for (const k of list) {
          const v = lsGetRaw(k);
          if (v !== null) local[k] = v;
        }
        degraded = lsGetRaw(flag) === '1';
        let syncFailed = false;
        for (const k of list) {
          const r = store[k];
          const l = local[k];
          if (touched.has(k)) {
            // 页面在 warm 完成前已经自己写过这个键：这个值比 warm 起点读到的 LS / 主存值都新。
            // 这里必须让路：不拿主存值覆盖 cache，也不把主存值回写 LS（那会摸掉刚发生的写）。
            // 主存的补齐交给 flush()：pendingW / pendingD 里已经有它。
            continue;
          }
          if (r !== undefined && !degraded) {
            cache.set(k, r);
            if (l !== undefined && l !== r) {
              st.conflicts++;
              if (r.length <= mirrorLimit) lsSetRaw(k, r); // 收敛：主存为准（每次写都镜像过，这里只修外部改动）
            }
          } else if (l !== undefined) {
            cache.set(k, l);
            if (remote) {
              if (r === undefined) st.migrated++;
              else if (r !== l) st.conflicts++;
              const ok = await remote.write(k, l);
              if (!ok) {
                markDegraded();
                syncFailed = true;
              }
            }
          } else if (r !== undefined) {
            cache.set(k, r);
          }
          // 页面刚才同步读到的是 LS 的值（或什么都没有），而主存给的是另一个值 → 需要补载入
          const cur = cache.get(k);
          if (cur !== undefined && cur !== l) {
            hydrated.add(k);
            st.hydrated++;
          }
        }
        /* 降级标记只由「一次成功的 LS→IDB 回灌」撤销：会话中途某次写成功不代表之前失败过的
           键已经同步，提前撤标记等于让旧主存值在下一次载入时覆盖用户的新存档。 */
        if (degraded) {
          if (syncFailed) lsSetRaw(flag, '1');
          else clearDegraded();
        }
        if (hydrated.size) for (const cb of hydrateCbs) cb(Array.from(hydrated));
        return { ...st };
      })();
    }
    return warmPromise;
  }

  async function flush(): Promise<StoreStats> {
    if (timer !== null) {
      const g = globalThis as Record<string, unknown>;
      if (typeof g.clearTimeout === 'function') (g.clearTimeout as unknown as (t: unknown) => void)(timer);
      timer = null;
    }
    const remote = await backend();
    const ws = Array.from(pendingW.entries());
    const ds = Array.from(pendingD);
    pendingW.clear();
    pendingD.clear();
    if (!remote) return { ...st };
    for (const [k, v] of ws) {
      const ok = await remote.write(k, v);
      if (ok) st.idbWrites++;
      else {
        st.idbFails++;
        markDegraded();
      }
    }
    for (const k of ds) {
      const ok = await remote.remove(k);
      if (ok) st.idbWrites++;
      else {
        st.idbFails++;
        markDegraded();
      }
    }
    return { ...st };
  }

  return {
    warm,
    ready: () => warm(),
    get(k) {
      if (cache.has(k)) return cache.get(k) ?? null;
      return lsGetRaw(k); // warm 还没完成：与旧行为一致（同步读 localStorage）
    },
    set(k, v) {
      cache.set(k, v);
      touched.add(k);
      pendingW.set(k, v);
      pendingD.delete(k);
      if (v.length <= mirrorLimit) {
        if (lsSetRaw(k, v)) st.lsMirrors++;
        else st.lsFails++;
      } else st.skippedMirror++; // 太大：只进主存（这正是换 IndexedDB 的意义）
      schedule();
    },
    remove(k) {
      cache.set(k, null);
      touched.add(k);
      pendingW.delete(k);
      pendingD.add(k);
      try {
        ls?.removeItem(k);
      } catch (_e) {
        /* 旧键删不掉不影响主存 */
      }
      schedule();
    },
    has(k) {
      if (cache.has(k)) return cache.get(k) !== null;
      return lsGetRaw(k) !== null;
    },
    lsGet: lsGetRaw,
    lsRemove(k) {
      try {
        ls?.removeItem(k);
      } catch (_e) {
        /* 同上 */
      }
    },
    flush,
    onHydrate(cb) {
      hydrateCbs.push(cb);
      if (hydrated.size) cb(Array.from(hydrated));
    },
    stats: () => ({ ...st }),
    degraded: () => degraded,
    backend: () => (idb ? idb.name : lsBackend(ls) ? 'localStorage' : 'none'),
  };
}
