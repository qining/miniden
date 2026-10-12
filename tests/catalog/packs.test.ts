/* S10 目录扩展协议（R8-5K）：条目 schema + 包校验 + 合并 + 模型编译 + 注册表
 *
 * 这一层为什么必须单测：目录条目一旦出文件（扩展包），「条目长什么样」就是对外契约。
 * 契约没有可执行校验，坏包在界面上的表现是「卡片空白 / 尺寸离谱 / 建模退回通用造型」，
 * 排查成本全落在用户身上。
 */
import { describe, it, expect } from 'vitest';
import {
  validateEntry,
  duplicateIds,
  KNOWN_KINDS,
  BUILTIN_LIGHT_KINDS,
  ENTRY_MIN_CM,
  ENTRY_MAX_CM,
} from '../../src/catalog/schema';
import {
  validatePack,
  compileModel,
  mergeCatalog,
  normalizeRegistry,
  serializeRegistry,
  upsertPackMeta,
  removePackMeta,
  packMetaFor,
  packKeyFor,
  PACKS_KEY,
  MAX_PACK_ENTRIES,
  MAX_PACK_MODELS,
  MAX_MODEL_SRC,
  MAX_PACK_MODELS_BYTES,
  MAX_PACKS,
} from '../../src/catalog/packs';

const good = () => ({
  id: 'demo-0',
  cat: '茶几 / 边几',
  name: '示例边几',
  w: 45,
  d: 45,
  h: 50,
  kind: 'sideTable',
  price: 39,
});
const errs = (r: ReturnType<typeof validateEntry>) => r.issues.filter((i) => i.level === 'error');
const warns = (r: ReturnType<typeof validateEntry>) => r.issues.filter((i) => i.level === 'warning');

describe('目录条目 schema', () => {
  it('合法条目通过并归一化', () => {
    const r = validateEntry(good());
    expect(r.ok).toBe(true);
    expect(errs(r)).toEqual([]);
    expect(r.entry).toMatchObject({ id: 'demo-0', w: 45, kind: 'sideTable' });
  });

  it('非对象 / 数组条目 → error', () => {
    for (const bad of [null, undefined, 42, 'x', []]) {
      expect(validateEntry(bad).ok).toBe(false);
    }
  });

  it('缺 id / 非法 id 字符 → error', () => {
    const noId = { ...good() };
    delete (noId as Record<string, unknown>).id;
    expect(errs(validateEntry(noId)).some((i) => i.field === 'id')).toBe(true);
    expect(validateEntry({ ...good(), id: 'bad id!' }).ok).toBe(false);
    expect(validateEntry({ ...good(), id: 'x'.repeat(65) }).ok).toBe(false);
  });

  it('缺 cat / name → error；过长 → error', () => {
    expect(validateEntry({ ...good(), cat: '  ' }).ok).toBe(false);
    expect(validateEntry({ ...good(), name: '' }).ok).toBe(false);
    expect(validateEntry({ ...good(), name: 'n'.repeat(141) }).ok).toBe(false);
  });

  it('尺寸必须是 1–1200cm 的正数（99999 那种笔误一律拒收）', () => {
    for (const k of ['w', 'd', 'h'] as const) {
      expect(validateEntry({ ...good(), [k]: '45' }).ok).toBe(false);
      expect(validateEntry({ ...good(), [k]: 0 }).ok).toBe(false);
      expect(validateEntry({ ...good(), [k]: -5 }).ok).toBe(false);
      expect(validateEntry({ ...good(), [k]: Number.NaN }).ok).toBe(false);
      expect(validateEntry({ ...good(), [k]: ENTRY_MAX_CM + 1 }).ok).toBe(false);
      expect(validateEntry({ ...good(), [k]: ENTRY_MIN_CM }).ok).toBe(true);
      expect(validateEntry({ ...good(), [k]: ENTRY_MAX_CM }).ok).toBe(true);
    }
  });

  it('陌生 kind 只提醒不拒收（kind 列表会增长，收紧它会让旧包失效）', () => {
    const r = validateEntry({ ...good(), kind: 'timeMachine' });
    expect(r.ok).toBe(true);
    expect(warns(r).some((i) => i.field === 'kind')).toBe(true);
    expect(KNOWN_KINDS).toContain('sideTable');
  });

  it('kind 命名不合法（大写 / 非法字符）→ error', () => {
    expect(validateEntry({ ...good(), kind: 'Side Table' }).ok).toBe(false);
    expect(validateEntry({ ...good(), kind: '1kind' }).ok).toBe(false);
  });

  it('model 名不合法 → error', () => {
    expect(validateEntry({ ...good(), model: 'bad model' }).ok).toBe(false);
    expect(validateEntry({ ...good(), model: 'ok.model-1' }).ok).toBe(true);
  });

  it('价格：负数 / 离谱值 → error；固定灯具没有价格是正常的', () => {
    expect(validateEntry({ ...good(), price: -1 }).ok).toBe(false);
    expect(validateEntry({ ...good(), priceCA: 'x' }).ok).toBe(false);
    const light = { ...good(), kind: 'downlight' };
    delete (light as Record<string, unknown>).price;
    const r = validateEntry(light);
    expect(r.ok).toBe(true);
    expect(warns(r).some((i) => i.field === 'price')).toBe(false);
    expect(BUILTIN_LIGHT_KINDS).toContain('downlight');
  });

  it('没有价格又不是固定灯具 → 提醒（通常是漏采）', () => {
    const e = { ...good() };
    delete (e as Record<string, unknown>).price;
    const r = validateEntry(e);
    expect(r.ok).toBe(true);
    expect(warns(r).some((i) => i.field === 'price')).toBe(true);
  });

  it('noPrice:true 是显式声明「没有独立售价」；写 false 是错用', () => {
    const e = { ...good(), noPrice: true };
    delete (e as Record<string, unknown>).price;
    expect(warns(validateEntry(e)).some((i) => i.field === 'price')).toBe(false);
    expect(validateEntry({ ...good(), noPrice: false }).ok).toBe(false);
  });

  it('caNA 必须是布尔；caVar 允许布尔或 ≤240 文本（两种写法界面都消费）', () => {
    expect(validateEntry({ ...good(), caNA: 'yes' }).ok).toBe(false);
    expect(validateEntry({ ...good(), caVar: true }).ok).toBe(true);
    expect(validateEntry({ ...good(), caVar: '加拿大只售无扶手款' }).ok).toBe(true);
    expect(validateEntry({ ...good(), caVar: 'x'.repeat(241) }).ok).toBe(false);
  });

  it('颜色必须是 #hex', () => {
    expect(validateEntry({ ...good(), color: 'red' }).ok).toBe(false);
    expect(validateEntry({ ...good(), color2: '#D4C4A8' }).ok).toBe(true);
  });

  it('旧别名 col2 自动归一化成 color2 并明说（内置目录曾有 9 条写错）', () => {
    const r = validateEntry({ ...good(), col2: '#202226' });
    expect(r.ok).toBe(true);
    expect(r.entry?.color2).toBe('#202226');
    expect(r.entry?.col2).toBeUndefined();
    expect(warns(r).some((i) => i.field === 'col2')).toBe(true);
  });

  it('url 必须是 http(s)；note 过长 → error', () => {
    expect(validateEntry({ ...good(), url: 'ftp://x/y' }).ok).toBe(false);
    expect(validateEntry({ ...good(), url: 'https://x/y' }).ok).toBe(true);
    expect(validateEntry({ ...good(), note: 'n'.repeat(401) }).ok).toBe(false);
  });

  it('seatH 越界 → error；陌生 wood 只提醒', () => {
    expect(validateEntry({ ...good(), seatH: 0 }).ok).toBe(false);
    expect(validateEntry({ ...good(), seatH: 121 }).ok).toBe(false);
    const r = validateEntry({ ...good(), wood: 'mahogany' });
    expect(r.ok).toBe(true);
    expect(warns(r).some((i) => i.field === 'wood')).toBe(true);
  });

  it('未知字段只提醒并保留（schema 要向前兼容）', () => {
    const r = validateEntry({ ...good(), futureField: 7 });
    expect(r.ok).toBe(true);
    expect(warns(r).some((i) => i.field === 'futureField')).toBe(true);
    expect(r.entry?.futureField).toBe(7);
  });

  it('duplicateIds 找包内重复', () => {
    const a = { ...good(), id: 'a' };
    expect(duplicateIds([a, { ...good(), id: 'a' }, { ...good(), id: 'b' }])).toEqual(['a']);
  });
});

describe('目录包校验', () => {
  const pack = () => ({
    pack: 'acme-2026',
    name: 'Acme 系列',
    version: 1,
    entries: [good()],
  });

  it('最小合法包通过，条目带上来源包标记', () => {
    const r = validatePack(pack());
    expect(r.ok).toBe(true);
    expect(r.pack?.entries[0].sourcePack).toBe('acme-2026');
    expect(r.pack?.name).toBe('Acme 系列');
  });

  it('缺 pack / 非法 pack id / 占用内置命名空间 → error', () => {
    const noId = pack();
    delete (noId as Record<string, unknown>).pack;
    expect(validatePack(noId).ok).toBe(false);
    expect(validatePack({ ...pack(), pack: 'bad id' }).ok).toBe(false);
    expect(validatePack({ ...pack(), pack: 'builtin' }).ok).toBe(false);
  });

  it('非对象 / 空 entries / 超上限 → error', () => {
    expect(validatePack('nope').ok).toBe(false);
    expect(validatePack({ ...pack(), entries: [] }).ok).toBe(false);
    const many = Array.from({ length: MAX_PACK_ENTRIES + 1 }, (_, i) => ({ ...good(), id: `x${i}` }));
    expect(validatePack({ ...pack(), entries: many }).ok).toBe(false);
  });

  it('两层判定：包层 error 整包不加载；条目层 error 只拒收那几条（不连坐）', () => {
    const r = validatePack({
      ...pack(),
      entries: [good(), { ...good(), id: 'broken', w: 99999 }, { ...good(), id: 'ok2' }],
    });
    expect(r.ok).toBe(true); // 包层没问题 → 能加载
    expect(r.pack?.entries.map((e) => e.id)).toEqual(['demo-0', 'ok2']);
    expect(r.entryIssues.some((i) => i.level === 'error' && i.where === 'broken')).toBe(true);
    expect(r.issues.filter((i) => i.level === 'error')).toEqual([]);
    // 包层 error（非法包 id）→ 整包不加载
    const badPack = validatePack({ ...pack(), pack: 'bad id', entries: [good()] });
    expect(badPack.ok).toBe(false);
    expect(badPack.pack).toBeUndefined();
  });

  it('全部条目都坏 = 这个包什么都没得加载 → 不通过', () => {
    const r = validatePack({ ...pack(), entries: [{ ...good(), id: 'x', w: 99999 }] });
    expect(r.ok).toBe(false);
    expect(r.entryIssues.some((i) => i.level === 'error')).toBe(true);
  });

  it('包内 id 重复 → error 且只保留第一条', () => {
    const r = validatePack({ ...pack(), entries: [good(), { ...good(), id: 'demo-0', name: '第二条' }] });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => /重复/.test(i.message))).toBe(true);
  });

  it('models：必须是「名字 → 函数源码字符串」，非字符串 / 非法名 → error', () => {
    expect(validatePack({ ...pack(), models: { m1: 42 } }).ok).toBe(false);
    expect(validatePack({ ...pack(), models: { 'bad name': '(C)=>{}' } }).ok).toBe(false);
    expect(validatePack({ ...pack(), models: { m1: '(C)=>{}' } }).ok).toBe(true);
  });

  it('models 尺寸上限：单个 / 数量 / 整包字节', () => {
    expect(validatePack({ ...pack(), models: { m1: 'x'.repeat(MAX_MODEL_SRC + 1) } }).ok).toBe(false);
    const many = Object.fromEntries(Array.from({ length: MAX_PACK_MODELS + 1 }, (_, i) => [`m${i}`, '(C)=>{}']));
    expect(validatePack({ ...pack(), models: many }).ok).toBe(false);
    const big = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`m${i}`, '(C)=>{' + 'a'.repeat(MAX_PACK_MODELS_BYTES / 4) + '}'])
    );
    expect(validatePack({ ...pack(), models: big }).ok).toBe(false);
  });

  it('version 必须是 ≥1 整数；name 1–80；homepage 必须 http(s)', () => {
    expect(validatePack({ ...pack(), version: 0 }).ok).toBe(false);
    expect(validatePack({ ...pack(), version: 1.5 }).ok).toBe(false);
    expect(validatePack({ ...pack(), name: 'n'.repeat(81) }).ok).toBe(false);
    expect(validatePack({ ...pack(), homepage: 'example.com' }).ok).toBe(false);
  });

  it('未知顶层字段只提醒', () => {
    const r = validatePack({ ...pack(), extra: 1 });
    expect(r.ok).toBe(true);
    expect(r.issues.some((i) => i.level === 'warning' && i.field === 'extra')).toBe(true);
  });
});

describe('模型编译', () => {
  it('函数表达式 → 可调用函数', () => {
    const c = compileModel('(C)=>{ C.seen = true; }');
    expect(c.error).toBeUndefined();
    const box: Record<string, unknown> = {};
    c.fn!(box);
    expect(box.seen).toBe(true);
  });

  it('语法错误 / 求值结果不是函数 → error（调用方退回 kind 通用建模）', () => {
    expect(compileModel('(C)=>{').error).toBeTruthy();
    expect(compileModel('1+1').error).toBeTruthy();
    expect(compileModel('undefined').error).toBeTruthy();
  });
});

describe('目录合并（内置赢）', () => {
  const base = [
    { id: 'builtin-1', cat: 'c', name: '内置', w: 10, d: 10, h: 10, kind: 'box' },
    { id: 'demo-0', cat: 'c', name: '内置同名', w: 10, d: 10, h: 10, kind: 'box' },
  ];
  const p1 = {
    pack: 'p1',
    name: 'p1',
    version: 1,
    entries: [
      { id: 'demo-0', cat: 'c', name: '包里的同名条目', w: 20, d: 20, h: 20, kind: 'box' },
      { id: 'new-1', cat: 'c', name: '新条目', w: 20, d: 20, h: 20, kind: 'box' },
    ],
    models: {},
  };
  const p2 = {
    pack: 'p2',
    name: 'p2',
    version: 1,
    entries: [{ id: 'new-1', cat: 'c', name: '第二个包也用它', w: 30, d: 30, h: 30, kind: 'box' }],
    models: {},
  };

  it('内置赢：包里的同 id 条目被跳过并逐条报告', () => {
    const r = mergeCatalog(base, [p1]);
    expect(r.entries.find((e) => e.id === 'demo-0')?.name).toBe('内置同名');
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].id).toBe('demo-0');
  });

  it('包条目带 sourcePack；两个包撞 id 时先加载的赢', () => {
    const r = mergeCatalog(base, [p1, p2]);
    expect(r.entries.find((e) => e.id === 'new-1')?.sourcePack).toBe('p1');
    expect(r.conflicts.map((c) => c.pack)).toEqual(['p1', 'p2']);
  });

  it('合并顺序：内置在前，包在后（目录分组因此稳定）', () => {
    const r = mergeCatalog(base, [p1]);
    expect(r.entries.slice(0, 2).map((e) => e.id)).toEqual(['builtin-1', 'demo-0']);
    expect(r.entries[2].id).toBe('new-1');
  });
});

describe('包注册表（存盘的元数据）', () => {
  it('normalizeRegistry 丢掉坏条目、按 id 去重', () => {
    const r = normalizeRegistry({
      v: 1,
      packs: [
        { pack: 'a', name: 'A', version: 1, entries: 3, models: 1, addedAt: 10 },
        { pack: 'a', name: 'A2', version: 2, entries: 5, models: 0, addedAt: 20 },
        { pack: 'bad id' },
        null,
        'x',
      ],
    });
    expect(r.packs).toHaveLength(1);
    expect(r.packs[0]).toMatchObject({ pack: 'a', name: 'A2', entries: 5 });
  });

  it('非对象 / 空 → 空注册表（不猜）', () => {
    for (const junk of [null, undefined, 'x', [], 42]) expect(normalizeRegistry(junk).packs).toEqual([]);
  });

  it('数量上限 MAX_PACKS', () => {
    const many = Array.from({ length: MAX_PACKS + 5 }, (_, i) => ({ pack: `p${i}`, name: `p${i}` }));
    expect(normalizeRegistry({ packs: many }).packs).toHaveLength(MAX_PACKS);
  });

  it('upsert 同包替换（新版本），新包追加；remove 只删指定包', () => {
    let r = normalizeRegistry({ packs: [] });
    r = upsertPackMeta(r, { pack: 'a', name: 'A', version: 1, entries: 3, models: 1, addedAt: 0 }, 111);
    r = upsertPackMeta(r, { pack: 'b', name: 'B', version: 1, entries: 2, models: 0, addedAt: 0 }, 222);
    expect(r.packs.map((p) => p.pack)).toEqual(['a', 'b']);
    expect(r.packs[0].addedAt).toBe(111);
    r = upsertPackMeta(r, { pack: 'a', name: 'A 新版', version: 2, entries: 9, models: 4, addedAt: 0 }, 333);
    expect(r.packs).toHaveLength(2);
    expect(r.packs[0]).toMatchObject({ name: 'A 新版', version: 2, entries: 9, addedAt: 333 });
    r = removePackMeta(r, 'b');
    expect(r.packs.map((p) => p.pack)).toEqual(['a']);
  });

  it('serialize / parse 往返一致', () => {
    const r = normalizeRegistry({
      packs: [{ pack: 'a', name: 'A', version: 1, entries: 3, models: 1, addedAt: 5 }],
    });
    expect(normalizeRegistry(JSON.parse(serializeRegistry(r)))).toEqual(r);
  });

  it('packMetaFor 统计条目与模型数；键名口径稳定', () => {
    const m = packMetaFor({
      pack: 'a',
      name: 'A',
      version: 1,
      entries: [{ id: 'x', cat: 'c', name: 'n', w: 1, d: 1, h: 1, kind: 'box' }],
      models: { m1: '(C)=>{}' },
    });
    expect(m).toMatchObject({ pack: 'a', entries: 1, models: 1 });
    expect(PACKS_KEY).toBe('planner_packs_v1');
    expect(packKeyFor('a')).toBe('planner_pack:a');
  });

  it('元数据里的数字被钳制（存盘被改坏也不会变成负数 / 天文数字）', () => {
    const r = normalizeRegistry({
      packs: [{ pack: 'a', entries: -5, models: 1e9, version: -3, addedAt: -9 }],
    });
    expect(r.packs[0]).toMatchObject({ entries: 0, models: MAX_PACK_MODELS, version: 1, addedAt: 0 });
  });
});
