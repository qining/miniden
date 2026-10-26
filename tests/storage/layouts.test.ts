/* S24c 方案（src/storage/layouts.ts）：纯函数单测。
   守三条红线：
   1) 只有缺省的「方案 1」时不写 lay ⇒ 家具存档与 S24c 之前逐字节相同（老用户的存档不迁移）
   2) 坏数据不抛错，而且存档里的 items（当前方案）一件不丢
   3) id 只增不复用（撤销记录按 id 存，复用 = 旧记录套到新方案上） */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT_ID,
  MAX_LAYOUTS,
  NAME_MAX,
  addLayout,
  defaultLayouts,
  isDefaultLayouts,
  layoutById,
  layoutItems,
  layoutName,
  nextLayoutName,
  normalizeLayouts,
  removeLayout,
  renameLayout,
  serializeLayouts,
  switchLayout,
  type LayoutSet,
} from '../../src/storage/layouts';

const it1 = { uid: 1, ref: 'sofa', x: 3, y: 4, rot: 0 };
const it2 = { uid: 2, ref: 'bed', x: 9, y: 2, rot: 90 };

describe('缺省 / 序列化', () => {
  it('缺省 = 只有「方案 1」，序列化为 null（存档里不写 lay）', () => {
    const s = defaultLayouts();
    expect(s.cur).toBe(DEFAULT_LAYOUT_ID);
    expect(s.list).toEqual([{ id: 'L1', name: '方案 1' }]);
    expect(isDefaultLayouts(s)).toBe(true);
    expect(serializeLayouts(s)).toBeNull();
  });
  it('改过名字的单套方案要写（否则刷新后名字没了）', () => {
    const s = renameLayout(defaultLayouts(), 'L1', '沙发靠窗')!;
    const out = serializeLayouts(s)!;
    expect(out).not.toBeNull();
    expect(normalizeLayouts(JSON.parse(JSON.stringify(out))).list).toEqual([{ id: 'L1', name: '沙发靠窗' }]);
  });
  it('往返：多套方案、各自的家具、当前是哪套、seq', () => {
    let s: LayoutSet = defaultLayouts();
    const a = addLayout(s, [it1], { items: [it2] })!;
    s = a.set;
    const raw = JSON.parse(JSON.stringify(serializeLayouts(s)));
    const back = normalizeLayouts(raw);
    expect(back.cur).toBe('L2');
    expect(back.seq).toBe(3);
    expect(back.list.map((l) => l.name)).toEqual(['方案 1', '方案 2']);
    expect(back.other).toEqual({ L1: [it1] }); // 当前方案（L2）的家具不在 other 里
  });
});

describe('normalizeLayouts：坏数据', () => {
  it('不认识的东西 → 缺省（不抛错）', () => {
    for (const raw of [
      null,
      undefined,
      'x',
      3,
      [],
      {},
      { list: 'no' },
      { list: [null, 1, {}, { id: '', name: 'a' }] },
    ]) {
      const s = normalizeLayouts(raw);
      expect(isDefaultLayouts(s)).toBe(true);
    }
  });
  it('当前方案不在列表里：补一条给它（存档里的 items 属于它，不能安到别的方案头上）', () => {
    const s = normalizeLayouts({ cur: 'L7', list: [{ id: 'L2', name: '方案 2' }], other: { L2: [it2] } });
    expect(s.cur).toBe('L7');
    expect(s.list.map((l) => l.id)).toEqual(['L7', 'L2']);
    expect(s.other.L2).toEqual([it2]);
    expect(s.seq).toBe(8);
  });
  it('cur 缺失：生成一个不撞的 id', () => {
    const s = normalizeLayouts({
      list: [
        { id: 'L1', name: '方案 1' },
        { id: 'L4', name: 'B' },
      ],
      other: { L1: [it1] },
    });
    expect(s.cur).toBe('L5');
    expect(s.list[0]).toEqual({ id: 'L5', name: '方案 1 (2)' });
    expect(s.other.L1).toEqual([it1]);
  });
  it('重复 id / 坏名字 / 超长名字丢掉；other 里不是对象的件丢掉；other 不含当前方案', () => {
    const s = normalizeLayouts({
      cur: 'L1',
      list: [
        { id: 'L1', name: '方案 1' },
        { id: 'L1', name: '重复' },
        { id: 'L2', name: '' },
        { id: 'L3', name: 'x'.repeat(NAME_MAX + 1) },
        { id: 'bad id!', name: 'y' },
        { id: 'L4', name: '  留下  ' },
      ],
      other: { L1: [it2], L4: [it1, null, 5, [1], 'z'] },
    });
    expect(s.list).toEqual([
      { id: 'L1', name: '方案 1' },
      { id: 'L4', name: '留下' },
    ]);
    expect(s.other).toEqual({ L4: [it1] });
  });
  it('超过上限的方案截掉', () => {
    const list = Array.from({ length: MAX_LAYOUTS + 5 }, (_, i) => ({ id: 'L' + (i + 1), name: 'n' + i }));
    const s = normalizeLayouts({ cur: 'L1', list });
    expect(s.list.length).toBe(MAX_LAYOUTS);
  });
  it('seq 不小于已有 id 的编号 + 1（只增不复用）', () => {
    const s = normalizeLayouts({
      cur: 'L1',
      seq: 2,
      list: [
        { id: 'L1', name: 'a' },
        { id: 'L9', name: 'b' },
      ],
    });
    expect(s.seq).toBe(10);
  });
});

describe('新建 / 复制 / 切换', () => {
  it('新建：当前方案的家具收进 other，切到新方案；缺省名字是最小的空号', () => {
    const a = addLayout(defaultLayouts(), [it1], { items: [] })!;
    expect(a.set.cur).toBe('L2');
    expect(a.items).toEqual([]);
    expect(a.set.other.L1).toEqual([it1]);
    expect(layoutById(a.set, 'L2')!.name).toBe('方案 2');
    const b = addLayout(a.set, a.items, { items: [it2] })!;
    expect(layoutById(b.set, 'L3')!.name).toBe('方案 3');
    expect(b.items).toEqual([it2]);
    expect(layoutItems(b.set, b.items, 'L2')).toEqual([]);
    expect(layoutItems(b.set, b.items, 'L1')).toEqual([it1]);
  });
  it('名字撞了自动加 (2)；给了名字就用它', () => {
    const a = addLayout(defaultLayouts(), [], { name: '方案 1', items: [] })!;
    expect(layoutById(a.set, 'L2')!.name).toBe('方案 1 (2)');
    const b = addLayout(a.set, [], { name: '靠窗', items: [] })!;
    expect(layoutById(b.set, 'L3')!.name).toBe('靠窗');
  });
  it('删掉中间那套后，新方案补空号的名字，但 id 不复用', () => {
    let s = addLayout(defaultLayouts(), [], { items: [] })!.set; // L2 方案 2
    s = addLayout(s, [], { items: [] })!.set; // L3 方案 3
    s = removeLayout(s, [], 'L2')!.set;
    expect(nextLayoutName(s)).toBe('方案 2');
    const a = addLayout(s, [], { items: [] })!;
    expect(a.set.cur).toBe('L4');
    expect(layoutById(a.set, 'L4')!.name).toBe('方案 2');
  });
  it('满了返回 null', () => {
    let s: LayoutSet = defaultLayouts();
    for (let k = 1; k < MAX_LAYOUTS; k++) s = addLayout(s, [], { items: [] })!.set;
    expect(s.list.length).toBe(MAX_LAYOUTS);
    expect(addLayout(s, [], { items: [] })).toBeNull();
  });
  it('切换：两套之间来回，家具各是各的', () => {
    const a = addLayout(defaultLayouts(), [it1], { items: [it2] })!;
    const back = switchLayout(a.set, a.items, 'L1')!;
    expect(back.items).toEqual([it1]);
    expect(back.set.other).toEqual({ L2: [it2] });
    const again = switchLayout(back.set, back.items, 'L2')!;
    expect(again.items).toEqual([it2]);
    expect(again.set.other).toEqual({ L1: [it1] });
  });
  it('切到自己 / 不存在的 id → null', () => {
    const s = defaultLayouts();
    expect(switchLayout(s, [], 'L1')).toBeNull();
    expect(switchLayout(s, [], 'L9')).toBeNull();
  });
});

describe('删除 / 改名', () => {
  it('最后一套不可删', () => {
    expect(removeLayout(defaultLayouts(), [it1], 'L1')).toBeNull();
  });
  it('删当前方案 → 切到它前面那套；删第一套 → 切到后面那套', () => {
    let s = addLayout(defaultLayouts(), [it1], { items: [it2] })!.set; // 当前 L2
    const r = removeLayout(s, [it2], 'L2')!;
    expect(r.set.cur).toBe('L1');
    expect(r.items).toEqual([it1]);
    expect(r.set.list.map((l) => l.id)).toEqual(['L1']);
    s = switchLayout(s, [it2], 'L1')!.set; // 当前 L1
    const r2 = removeLayout(s, [it1], 'L1')!;
    expect(r2.set.cur).toBe('L2');
    expect(r2.items).toEqual([it2]);
    expect(r2.set.other).toEqual({});
  });
  it('删别的方案：当前不变', () => {
    const s = addLayout(defaultLayouts(), [it1], { items: [it2] })!.set; // 当前 L2
    const r = removeLayout(s, [it2], 'L1')!;
    expect(r.set.cur).toBe('L2');
    expect(r.items).toEqual([it2]);
    expect(r.set.other).toEqual({});
  });
  it('改名：去空白；空 / 超长 / 与别的方案重名 → null；与自己同名可以', () => {
    const s = addLayout(defaultLayouts(), [], { items: [] })!.set;
    expect(renameLayout(s, 'L2', '  靠墙 ')!.list[1].name).toBe('靠墙');
    expect(renameLayout(s, 'L2', '   ')).toBeNull();
    expect(renameLayout(s, 'L2', 'x'.repeat(NAME_MAX + 1))).toBeNull();
    expect(renameLayout(s, 'L2', '方案 1')).toBeNull();
    expect(renameLayout(s, 'L2', '方案 2')).not.toBeNull();
    expect(renameLayout(s, 'L9', 'a')).toBeNull();
  });
  it('layoutName', () => {
    expect(layoutName(3)).toBe('方案 3');
  });
});
