import { describe, expect, it } from 'vitest';
import {
  buildShoppingList,
  csvCell,
  shoppingCSV,
  shoppingTail,
  shoppingText,
  type ShopInput,
} from '../../src/catalog/shopping';

const buy = (over: Partial<ShopInput> = {}): ShopInput => ({
  kind: 'buy',
  key: 'kivik-3',
  level: '',
  levelOrder: 0,
  cat: '沙发 / 单椅',
  catOrder: 3,
  name: 'KIVIK 三人沙发',
  dims: { w: 228, d: 95, h: 83 },
  url: 'https://www.ikea.com/x',
  price: { v: 899, exact: true },
  ...over,
});

const money = (v: number) => 'US$' + v.toFixed(2);

describe('采购清单聚合', () => {
  it('同一层 × 同一件 = 一行（数量 + 小计）；不同层分开', () => {
    const l = buildShoppingList([
      buy(),
      buy(),
      buy({ level: '二层', levelOrder: 1 }),
      buy({ key: 'lack', name: 'LACK 边几', cat: '茶几 / 边几', catOrder: 8, price: { v: 15, exact: true } }),
    ]);
    expect(l.rows.map((r) => [r.level, r.name, r.qty, r.subtotal])).toEqual([
      ['', 'KIVIK 三人沙发', 2, 1798],
      ['', 'LACK 边几', 1, 15],
      ['二层', 'KIVIK 三人沙发', 1, 899],
    ]);
    expect(l.total).toBe(899 * 3 + 15);
    expect(l.buy).toBe(4);
    expect(l.levels).toBe(2);
  });

  it('排序：楼层 → 分类序 → 名称；目录里没有的件排在本层最后', () => {
    const l = buildShoppingList([
      buy({ key: 'g', kind: 'ghost', name: '某下架件', cat: '?', catOrder: 0, price: null }),
      buy({ key: 'b', name: 'B', catOrder: 5 }),
      buy({ key: 'a', name: 'A', catOrder: 5 }),
      buy({ key: 'c', name: 'C', catOrder: 1 }),
    ]);
    expect(l.rows.map((r) => r.name)).toEqual(['C', 'A', 'B', '某下架件']);
  });

  it('公寓自带灯具不进行、不进件数；目录里没有的件成行但不计价、不进采购件数', () => {
    const l = buildShoppingList([
      buy(),
      buy({ kind: 'builtin', key: 'dl', name: '筒灯', price: null }),
      buy({ kind: 'ghost', key: 'gone', name: '?', price: { v: 50, exact: true } }),
    ]);
    expect(l.rows).toHaveLength(2);
    expect(l.builtin).toBe(1);
    expect(l.ghost).toBe(1);
    expect(l.buy).toBe(1);
    expect(l.total).toBe(899); // 目录里没有的件就算带了价也不算
    const g = l.rows.find((r) => r.ghost);
    expect(g?.unit).toBeNull();
    expect(g?.why).toMatch(/目录里没有/);
  });

  it('没价的件进采购件数；加拿大无售与其它无价分开数；没价原因按调用方给的写', () => {
    const l = buildShoppingList([
      buy({ key: 'x', price: null, caNA: true }),
      buy({ key: 'tv', price: null, noPriceWhy: '通用尺寸件，不计价' }),
      buy({ key: 'y', price: null }),
    ]);
    expect([l.buy, l.na, l.unknown, l.total]).toEqual([3, 1, 2, 0]);
    expect(l.rows.map((r) => r.why).sort()).toEqual(['加拿大无售', '无价', '通用尺寸件，不计价'].sort());
  });

  it('汇率折算 ≈ 与另一配置 * 按件数进尾巴（与界面合计同一顺序）', () => {
    const l = buildShoppingList([
      buy({ price: { v: 100, exact: false } }),
      buy({ price: { v: 100, exact: false } }),
      buy({ key: 'v', price: { v: 50, exact: true, variant: true } }),
      buy({ kind: 'builtin', key: 'dl' }),
      buy({ kind: 'ghost', key: 'gone' }),
      buy({ key: 'n', price: null, caNA: true }),
      buy({ key: 'u', price: null }),
    ]);
    expect(shoppingTail(l)).toEqual([
      '2 件按汇率折算',
      '1 件带 * = 加拿大在售的是另一配置',
      '1 件加拿大无售',
      '1 件无价',
      '1 件房子自带的灯不计价',
      '1 件目录里没有（不计价）',
    ]);
    expect(l.rows.find((r) => r.name === 'KIVIK 三人沙发' && r.qty === 2)?.approx).toBe(true);
  });

  it('非有限价当作没价（不让 NaN 污染合计）', () => {
    const l = buildShoppingList([buy({ price: { v: Number.NaN, exact: true } }), buy({ key: 'ok' })]);
    expect(l.total).toBe(899);
    expect(l.unknown).toBe(1);
  });
});

describe('CSV', () => {
  it('单元格：加引号、引号转义、公式字符前加单引号（CSV 注入）', () => {
    expect(csvCell('KIVIK')).toBe('"KIVIK"');
    expect(csvCell('22" 显示器')).toBe('"22"" 显示器"');
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell('+1')).toBe('"\'+1"');
    expect(csvCell('-5')).toBe('"\'-5"');
    expect(csvCell('@SUM(A1)')).toBe('"\'@SUM(A1)"');
    expect(csvCell(899)).toBe('"899"');
    expect(csvCell(69.989999)).toBe('"69.99"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(Number.NaN)).toBe('""');
  });

  it('表头带币种、一行一组、最后一行合计（备注 = 尾巴）、BOM + CRLF', () => {
    const l = buildShoppingList([buy(), buy(), buy({ key: 'u', name: '自定义柜', price: null, url: '' })]);
    const csv = shoppingCSV(l, { currency: 'US$' });
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[lines.length - 1]).toBe('');
    expect(lines[0]).toBe(
      '"楼层","分类","名称","数量","单价（US$）","小计（US$）","尺寸（cm，宽×深×高）","链接","备注"'
    );
    expect(lines[1]).toBe('"","沙发 / 单椅","KIVIK 三人沙发","2","899","1798","228×95×83","https://www.ikea.com/x",""');
    expect(lines[2]).toContain('"自定义柜","1","",""');
    expect(lines[2]).toContain('"无价"');
    expect(lines[3]).toBe('"","","合计","3","","1798","","","1 件无价"');
  });

  it('备注列把 ≈ / * / 没价原因 / 额外说明拼在一起', () => {
    const l = buildShoppingList([buy({ price: { v: 10, exact: false, variant: true }, note: '另一面料' })]);
    expect(shoppingCSV(l, { currency: 'CA$' })).toContain('"≈ 按汇率折算；* 加拿大在售的是另一配置；另一面料"');
  });
});

describe('纯文本', () => {
  it('单层：一件一行（数量 > 1 写乘式）；合计行与界面同一说法', () => {
    const l = buildShoppingList([
      buy(),
      buy(),
      buy({ key: 't', name: '电视 55″', price: null, noPriceWhy: '通用尺寸件，不计价', url: '' }),
    ]);
    const t = shoppingText(l, { title: '采购清单', money });
    expect(t.split('\n')).toEqual([
      '采购清单',
      '· KIVIK 三人沙发 — US$899.00 × 2 = US$1798.00 https://www.ikea.com/x',
      '· 电视 55″（通用尺寸件，不计价）',
      '',
      '采购 3 件 · 合计约 US$1798.00（1 件无价）',
    ]);
  });

  it('多层：按楼层分组；汇率折算的价与合计带 ≈', () => {
    const l = buildShoppingList([
      buy({ level: '一层', price: { v: 100, exact: false } }),
      buy({ level: '二层', levelOrder: 1, key: 'b', name: '床', url: '' }),
    ]);
    expect(shoppingText(l, { title: 'T', money }).split('\n')).toEqual([
      'T',
      '',
      '【一层】',
      '· KIVIK 三人沙发 — ≈US$100.00 https://www.ikea.com/x',
      '',
      '【二层】',
      '· 床 — US$899.00',
      '',
      '采购 2 件 · 合计约 ≈US$999.00（1 件按汇率折算）',
    ]);
  });

  it('没价的件数量 > 1 也写数量', () => {
    const l = buildShoppingList([buy({ price: null }), buy({ price: null })]);
    expect(shoppingText(l, { title: 'T', money })).toContain('· KIVIK 三人沙发 × 2（无价）');
  });
});

describe('地板用量（E19 轮㊲：界面上是同一张清单的最后一节，导出不能少了它）', () => {
  const floors = [
    { name: '自然橡木 · 人字拼', area: 10.43, unit: 'm²', areaText: '10.4 m²', rooms: ['客厅', '卧室'] },
    { name: '白色哑光砖 60×60', area: 5.9, unit: 'm²', areaText: '5.9 m²', rooms: ['卫生间'] },
  ];
  it('CSV：合计行之前，每种地板一行（分类 =「地板」、数量 = 面积、备注写单位与用在哪几间）；合计行不变', () => {
    const l = buildShoppingList([buy()]);
    const lines = shoppingCSV(l, { currency: 'US$', floors }).slice(1).split('\r\n');
    expect(lines[2]).toBe(
      '"","地板","自然橡木 · 人字拼","10.43","","","","","按房间面积（m²），不含损耗；用在：客厅、卧室"'
    );
    expect(lines[3]).toBe('"","地板","白色哑光砖 60×60","5.9","","","","","按房间面积（m²），不含损耗；用在：卫生间"');
    expect(lines[4]).toBe('"","","合计","1","","899","","",""');
  });
  it('纯文本：合计行之后单独一节，标题与界面同一说法', () => {
    const t = shoppingText(buildShoppingList([buy()]), { title: 'T', money, floors }).split('\n');
    expect(t.slice(-4)).toEqual([
      '',
      '地板用量（按房间面积，不含损耗）',
      '· 自然橡木 · 人字拼 — 10.4 m²（客厅、卧室）',
      '· 白色哑光砖 60×60 — 5.9 m²（卫生间）',
    ]);
  });
  it('没铺地板（不传 / 空数组）：两种输出与以前逐字一致', () => {
    const l = buildShoppingList([buy()]);
    expect(shoppingCSV(l, { currency: 'US$', floors: [] })).toBe(shoppingCSV(l, { currency: 'US$' }));
    expect(shoppingText(l, { title: 'T', money, floors: [] })).toBe(shoppingText(l, { title: 'T', money }));
  });
});
