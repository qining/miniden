import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  migrateLegacyToV1, docToLegacy, EMPTY_USERGEO,
  type LegacyGeo, type LegacyUserGeo,
} from '../../src/schema/migrate';
import { validate } from '../../src/schema/project';

/* =====================================================================
   migrate —— S1 的验收定义（无损迁移）：

       docToLegacy(migrate(legacy, userGeo))  ≡  effWalls/effFixed/effDoors()

   对照基准 = tests/fixtures/legacy-geo.json（scripts/make-fixtures.mjs 从
   planner.html 原文提取的 eff* 真实输出）。两个场景：空 USERGEO、合成
   USERGEO（覆盖/隐藏/新增）。逐字段相等（含 _src/_i）——浮点原样透传，
   所以是精确比较（JSON 序列化串比），不是近似。

   坐标约定（e73cb45 起）：WALLS/DOORS/FIXED/LABELS/PATIO 已是 ft 原生；
   仅 FX 是图纸 px（fixture 里 meta.sc = 11.2）。
   ===================================================================== */

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const fx = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/legacy-geo.json'), 'utf8'));

const toLegacy = (scenario: 'empty' | 'user'): LegacyGeo => ({
  sc: fx[scenario].meta.sc,
  ...fx[scenario].legacy,
});
const legacy = toLegacy('empty');
const deepStr = (x: unknown) => JSON.stringify(x);
const stripMeta = (arr: Record<string, unknown>[]) =>
  JSON.stringify(arr.map(({ _src, _i, ...rest }) => rest));

function checkEquivalence(userGeo: LegacyUserGeo, expected: { walls: unknown[]; fixed: unknown[]; doors: unknown[] }) {
  const doc = migrateLegacyToV1(legacy, userGeo);
  const proj = docToLegacy(doc);
  expect(validate(doc)).toEqual([]);
  expect(deepStr(proj.walls)).toBe(deepStr(expected.walls));
  expect(deepStr(proj.fixed)).toBe(deepStr(expected.fixed));
  expect(deepStr(proj.doors)).toBe(deepStr(expected.doors));
}

describe('migrate → docToLegacy ≡ eff*（空 USERGEO）', () => {
  it('三条 eff* 输出逐字段相等（72 链段 + 21 实心块 + 10 门扇，含 _src/_i）', () => {
    checkEquivalence(EMPTY_USERGEO, fx.empty.eff as never);
  });

  it('文档结构：id 稳定、链序保持、门洞配门扇', () => {
    const doc = migrateLegacyToV1(legacy, EMPTY_USERGEO);
    expect(doc.schema).toBe(1);
    expect(doc.sc).toBe(11.2);
    expect(doc.walls).toHaveLength(65);   // 72 链段 − 7 窗（窗另在 windows[]）
    expect(doc.walls[0].id).toBe('w1');
    expect(doc.windows).toHaveLength(7);
    // 9 个内置门洞都配到了门扇（wallId 非空）
    const openings = doc.walls.filter(w => w.kind === 'opening');
    expect(openings).toHaveLength(9);
    const gapIds = new Set(openings.map(o => o.id));
    const paired = doc.doors.filter(d => d.wallId && gapIds.has(d.wallId));
    expect(paired).toHaveLength(9);
    const unpaired = doc.doors.filter(d => !d.wallId && d.src === 'builtin');
    expect(unpaired.map(d => d.kind)).toEqual(['bifold']); // 衣柜折叠门挂在实心块上，无链缺口
    // 窗样式映射（fixture 实测分布：3 普通 + 3 落地钢梁 + 1 推拉落地）
    const styles = doc.windows
      .map(w => `${w.style}${w.fullHeight ? 'F' : ''}${w.steel ? 'S' : ''}`)
      .sort();
    expect(styles).toEqual(['fixed', 'fixed', 'fixed', 'fixedFS', 'fixedFS', 'fixedFS', 'slideF']);
    // 落地窗 sill=0 head=层高；普通窗 0.67m/2.25m
    for (const w of doc.windows) {
      if (w.fullHeight) { expect(w.sill).toBe(0); expect(w.head).toBe(doc.ceilingH); }
      else { expect(w.sill).toBeCloseTo(0.67 / 0.3048, 10); expect(w.head).toBeCloseTo(2.25 / 0.3048, 10); }
    }
    // 柱 / 房间 / 洁具 / 阳台
    expect(doc.solids.some(s => s.column && s.name === '柱')).toBe(true);
    expect(doc.rooms).toHaveLength(14);
    expect(doc.rooms[0].d).toBe("13'2\" × 11'0\"");   // #calib 专用原始字符串保留
    expect(doc.fixtures).toHaveLength(13);
    expect(doc.patio).not.toBeNull();
    // 隐藏列表为空
    expect(doc.hidden).toEqual({ walls: [], windows: [], doors: [], solids: [] });
  });
});

describe('migrate → docToLegacy ≡ eff*（合成 USERGEO：覆盖/隐藏/新增）', () => {
  const userGeo = fx.user.userGeo as LegacyUserGeo;

  it('三条 eff* 输出逐字段相等（_i 来自原 USERGEO 数组下标）', () => {
    checkEquivalence(userGeo, fx.user.eff as never);
  });

  it('ov 覆盖物化进实体、hidden 进过滤列表、新增实体 src=user', () => {
    const doc = migrateLegacyToV1(legacy, userGeo);
    // ovW['3']：端点增量平移、wd=8px→ft
    const w4 = doc.walls.find(w => w.chainIndex === 3);
    expect(w4).toBeDefined();
    expect(w4!.thick).toBeCloseTo(8 / 11.2, 12);
    // ovP['2']：poly 被替换
    const s3 = doc.solids.find(s => s.chainIndex === 2);
    expect(s3!.geom.t).toBe('poly');
    if (s3!.geom.t === 'poly') expect(s3!.geom.pts[0]).toEqual([1, 1]);
    // ovD['1']：side/hinge 覆盖
    const d2 = doc.doors.find(d => d.chainIndex === 1);
    expect(d2!.side).toBe(-1);
    expect(d2!.hinge).toBe(0);
    // hidden：索引 → id
    expect(doc.hidden.walls).toContain('w11');   // hiddenW [10]（'w' 段）
    expect(doc.hidden.solids).toContain('s6'); // hiddenP [5]
    expect(doc.hidden.doors).toContain('d4');  // hiddenD [3]
    // 新增（userIndex 保留原数组下标）
    const uWall = doc.walls.filter(w => w.src === 'user');
    expect(uWall).toHaveLength(1);
    expect(uWall[0].userIndex).toBe(0);
    const uWin = doc.windows.filter(w => w.src === 'user');
    expect(uWin).toHaveLength(1);
    expect(uWin[0].userIndex).toBe(1);
    expect(uWin[0].thick).toBeCloseTo(3.5 / 11.2, 12);
    expect(doc.solids.filter(s => s.src === 'user')).toHaveLength(1);
    expect(doc.doors.filter(d => d.src === 'user')).toHaveLength(1);
    // 隐藏实体仍在数组里（取消隐藏即恢复）
    expect(doc.walls.some(w => w.id === 'w11')).toBe(true);
    expect(doc.solids.some(s => s.id === 's6')).toBe(true);
    expect(doc.doors.some(d => d.id === 'd4')).toBe(true);
  });

  it('可重放性：doc → legacy 再 migrate，几何不变（_i/_src 重编号是预期）', () => {
    const doc1 = migrateLegacyToV1(legacy, userGeo);
    const proj1 = docToLegacy(doc1);
    // 把投影结果当新 legacy 输入（user 部分已物化进链/门/实心块，覆盖层置空）
    const replay = migrateLegacyToV1(
      {
        ...legacy,
        walls: proj1.walls as LegacyGeo['walls'],
        doors: proj1.doors as LegacyGeo['doors'],
        fixed: proj1.fixed as LegacyGeo['fixed'],
      },
      EMPTY_USERGEO,
    );
    const proj2 = docToLegacy(replay);
    expect(stripMeta(proj2.walls as unknown as Record<string, unknown>[])).toBe(stripMeta(proj1.walls as unknown as Record<string, unknown>[]));
    expect(stripMeta(proj2.fixed as unknown as Record<string, unknown>[])).toBe(stripMeta(proj1.fixed as unknown as Record<string, unknown>[]));
    expect(stripMeta(proj2.doors as unknown as Record<string, unknown>[])).toBe(stripMeta(proj1.doors as unknown as Record<string, unknown>[]));
  });
});
