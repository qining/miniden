/* =====================================================================
   src/catalog/shopping.ts — S20：采购清单导出（纯函数，不碰 DOM / 存储）

   gap 审计 G13（docs/research/11-home-furnishing-gaps.md）：homeowner 摆完一屋子家具，下一步是「买」——
   要一张能贴进聊天 / 备忘录、能用 Excel 打开的清单（楼层、数量、单价、链接）。

   分工：app.html 把摆放的每一件解析成 ShopInput（目录条目 / 价格 / 楼层 / 没价的原因都按 app 的口径给），
   这里只做聚合（同一层 × 同一件 = 一行）、排序、合计与两种输出格式。计件与合计口径和界面
   「采购 N 件 · 合计约 …（…）」一致：
     · 公寓自带的灯具不进行、不进采购件数（尾巴里写件数）；
     · 目录里没有的件单独成行、不计价、不进采购件数（尾巴里写件数）；
     · 汇率折算的单价算进合计，但标 ≈；caVar（加拿大在售的是另一配置）标 *；
     · 没价的件照样进采购件数（加元视图下「加拿大无售」与「无价」分开数）。
   ===================================================================== */

export interface ShopPrice {
  /** 当前币种下的单价 */
  v: number;
  /** false = 当地没有实际标价，按汇率折算 */
  exact: boolean;
  /** true = 加拿大在售的是同型号的另一配置（caVar） */
  variant?: boolean;
}

export interface ShopInput {
  /** 'buy' = 要买的件；'builtin' = 公寓自带（固定灯具，不计价）；'ghost' = 目录里没有这件 */
  kind: 'buy' | 'builtin' | 'ghost';
  /** 聚合键：目录 id；自定义件用「名称 + 尺寸」；目录里没有的件用它引用的 id */
  key: string;
  /** 楼层名（单层户型 = ''） */
  level: string;
  /** 楼层排序（低层在前） */
  levelOrder: number;
  cat: string;
  /** 分类排序（目录 CAT_ORDER 里的序；没列的放最后） */
  catOrder: number;
  name: string;
  /** 宽 × 深 × 高（cm）；未知 = null */
  dims: { w: number; d: number; h: number } | null;
  url?: string;
  price: ShopPrice | null;
  /** 没价时的原因（'通用尺寸件，不计价' / '无价' …）；有价时忽略 */
  noPriceWhy?: string;
  /** 没价是因为「加拿大无售」（加元视图）：尾巴里与「无价」分开数 */
  caNA?: boolean;
  /** 额外备注（如 caVar 的说明文本） */
  note?: string;
}

export interface ShopRow {
  level: string;
  cat: string;
  name: string;
  qty: number;
  /** 单价；没价 = null */
  unit: number | null;
  /** 小计 = 单价 × 数量；没价 = null */
  subtotal: number | null;
  approx: boolean;
  variant: boolean;
  dims: string;
  url: string;
  /** 没价的原因 / 目录里没有（有价时为空） */
  why: string;
  /** 额外备注 */
  extra: string;
  ghost: boolean;
}

export interface ShopList {
  rows: ShopRow[];
  /** 合计（有价的件；含汇率折算） */
  total: number;
  /** 采购件数（不含公寓自带、不含目录里没有的） */
  buy: number;
  approx: number;
  variant: number;
  /** 没价：加拿大无售 */
  na: number;
  /** 没价：其它原因 */
  unknown: number;
  builtin: number;
  ghost: number;
  /** 出现了几个楼层（> 1 时文本输出按楼层分组） */
  levels: number;
}

const num = (v: number) => +v.toFixed(1);
const dimStr = (d: ShopInput['dims']) => (d ? `${num(d.w)}×${num(d.d)}×${num(d.h)}` : '');

/** 聚合 + 排序 + 合计 */
export function buildShoppingList(inputs: readonly ShopInput[]): ShopList {
  const out: ShopList = {
    rows: [],
    total: 0,
    buy: 0,
    approx: 0,
    variant: 0,
    na: 0,
    unknown: 0,
    builtin: 0,
    ghost: 0,
    levels: 0,
  };
  const groups = new Map<string, { inp: ShopInput; qty: number }>();
  const levelSet = new Set<string>();
  for (const inp of inputs) {
    if (inp.kind === 'builtin') {
      out.builtin++;
      continue;
    }
    levelSet.add(inp.level);
    const priced = inp.kind === 'buy' && !!inp.price && Number.isFinite(inp.price.v);
    if (inp.kind === 'ghost') out.ghost++;
    else {
      out.buy++;
      if (priced && inp.price) {
        out.total += inp.price.v;
        if (!inp.price.exact) out.approx++;
        if (inp.price.variant) out.variant++;
      } else if (inp.caNA) out.na++;
      else out.unknown++;
    }
    const k = [inp.kind, inp.levelOrder, inp.level, inp.key].join('\u0000');
    const g = groups.get(k);
    if (g) g.qty++;
    else groups.set(k, { inp, qty: 1 });
  }
  out.levels = levelSet.size;
  const list = [...groups.values()];
  list.sort(
    (a, b) =>
      a.inp.levelOrder - b.inp.levelOrder ||
      (a.inp.kind === 'ghost' ? 1 : 0) - (b.inp.kind === 'ghost' ? 1 : 0) ||
      a.inp.catOrder - b.inp.catOrder ||
      a.inp.cat.localeCompare(b.inp.cat) ||
      a.inp.name.localeCompare(b.inp.name)
  );
  for (const { inp, qty } of list) {
    const ghost = inp.kind === 'ghost';
    const p = !ghost && inp.price && Number.isFinite(inp.price.v) ? inp.price : null;
    out.rows.push({
      level: inp.level,
      cat: inp.cat,
      name: inp.name,
      qty,
      unit: p ? p.v : null,
      subtotal: p ? p.v * qty : null,
      approx: !!p && !p.exact,
      variant: !!p && !!p.variant,
      dims: dimStr(inp.dims),
      url: inp.url || '',
      why: ghost ? '目录里没有这件（不计价）' : p ? '' : inp.caNA ? '加拿大无售' : inp.noPriceWhy || '无价',
      extra: inp.note || '',
      ghost,
    });
  }
  return out;
}

/** 合计尾巴：与界面「采购 N 件 · 合计约 …（…）」同一组说明、同一顺序 */
export function shoppingTail(list: ShopList): string[] {
  const tail: string[] = [];
  if (list.approx) tail.push(`${list.approx} 件按汇率折算`);
  if (list.variant) tail.push(`${list.variant} 件带 * = 加拿大在售的是另一配置`);
  if (list.na) tail.push(`${list.na} 件加拿大无售`);
  if (list.unknown) tail.push(`${list.unknown} 件无价`);
  if (list.builtin) tail.push(`${list.builtin} 件固定灯具不计价`);
  if (list.ghost) tail.push(`${list.ghost} 件目录里没有（不计价）`);
  return tail;
}

/** CSV 单元格：一律加引号、引号成对转义；`= + - @`（及制表 / 回车）开头的前面加 `'`，
    防 Excel / Numbers 把它当公式执行（CSV 注入：自定义件的名字是用户输入） */
export function csvCell(v: string | number | null | undefined): string {
  let s = v == null ? '' : typeof v === 'number' ? (Number.isFinite(v) ? String(+v.toFixed(2)) : '') : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

export interface CsvOpts {
  /** 单价列的币种标签（'US$' / 'CA$'） */
  currency: string;
}

/** CSV：带 BOM（Excel 打开中文不乱码）、CRLF 行尾；最后一行是合计（备注列 = 合计尾巴） */
export function shoppingCSV(list: ShopList, opts: CsvOpts): string {
  const head = [
    '楼层',
    '分类',
    '名称',
    '数量',
    `单价（${opts.currency}）`,
    `小计（${opts.currency}）`,
    '尺寸（cm，宽×深×高）',
    '链接',
    '备注',
  ];
  const lines = [head.map(csvCell).join(',')];
  for (const r of list.rows) {
    const note = [r.approx ? '≈ 按汇率折算' : '', r.variant ? '* 加拿大在售的是另一配置' : '', r.why, r.extra]
      .filter(Boolean)
      .join('；');
    lines.push([r.level, r.cat, r.name, r.qty, r.unit, r.subtotal, r.dims, r.url, note].map(csvCell).join(','));
  }
  lines.push(['', '', '合计', list.buy, '', list.total, '', '', shoppingTail(list).join('；')].map(csvCell).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export interface TextOpts {
  title: string;
  /** 金额格式化（调用方给，带币种符号，如 US$69.99） */
  money: (v: number) => string;
}

/** 纯文本（贴进聊天 / 备忘录）：一件一行，多层时按楼层分组；≈ / * 的含义写在合计尾巴里 */
export function shoppingText(list: ShopList, opts: TextOpts): string {
  const L: string[] = [opts.title];
  let lastLevel: string | null = null;
  for (const r of list.rows) {
    if (list.levels > 1 && r.level !== lastLevel) {
      L.push('', `【${r.level || '未分层'}】`);
      lastLevel = r.level;
    }
    const pre = r.approx ? '≈' : '';
    const star = r.variant ? '*' : '';
    let price = '';
    if (r.unit != null && r.subtotal != null)
      price =
        ' — ' + pre + opts.money(r.unit) + star + (r.qty > 1 ? ` × ${r.qty} = ${pre}${opts.money(r.subtotal)}` : '');
    else if (r.qty > 1) price = ` × ${r.qty}`;
    const note = [r.why, r.extra].filter(Boolean).join('；');
    L.push(`· ${r.name}${price}${note ? `（${note}）` : ''}${r.url ? ' ' + r.url : ''}`);
  }
  const tail = shoppingTail(list);
  L.push(
    '',
    `采购 ${list.buy} 件 · 合计约 ${list.approx ? '≈' : ''}${opts.money(list.total)}` +
      (tail.length ? `（${tail.join('、')}）` : '')
  );
  return L.join('\n');
}
