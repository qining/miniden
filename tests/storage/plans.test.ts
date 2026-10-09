/* E26 多户型注册表（src/storage/plans.ts）：纯函数单测。
   重点守两条红线：
   1) 内置户型的 planId == 内置指纹 ⇒ 存档键不变（现有用户数据不需要迁移）
   2) 内置户型不可删、注册表坏数据不抛错 */
import { describe, expect, it } from 'vitest';
import {
  MAX_PLANS,
  PLANS_KEY,
  docKeyFor,
  hasPlan,
  itemsKeyFor,
  newPlanId,
  normalizeRegistry,
  planById,
  removePlan,
  renamePlan,
  serializeRegistry,
  setActive,
  sortedPlans,
  touchPlan,
  trimRegistry,
  upsertPlan,
} from '../../src/storage/plans';

const FP = 'k3x9q'; // 内置户型指纹（单测里就是个固定串）

describe('键名口径', () => {
  it('内置户型的键 = 原来的指纹键（不迁移、不换键）', () => {
    expect(docKeyFor(FP)).toBe('planner_doc_v1:' + FP);
    expect(itemsKeyFor(FP)).toBe('planner_v1:' + FP);
  });
  it('自包含户型用生成 id，键与内置互不覆盖', () => {
    const id = newPlanId(1_700_000_000_000, () => 0.5);
    expect(id.startsWith('p')).toBe(true);
    expect(id).not.toBe(FP);
    expect(docKeyFor(id)).not.toBe(docKeyFor(FP));
  });
  it('newPlanId 在固定 rand 下确定（单测可复现）', () => {
    expect(newPlanId(1, () => 0.25)).toBe(newPlanId(1, () => 0.25));
    expect(newPlanId(1, () => 0.25)).not.toBe(newPlanId(1, () => 0.75));
  });
});

describe('normalizeRegistry', () => {
  it('坏数据 / 空数据 → 只含内置户型的干净注册表（不抛错）', () => {
    for (const raw of [null, undefined, 'x', 42, [], {}, { plans: 'no' }, { plans: [null, {}, { id: '' }] }]) {
      const reg = normalizeRegistry(raw, FP, '通用户型');
      expect(reg.plans.length).toBe(1);
      expect(reg.plans[0].id).toBe(FP);
      expect(reg.plans[0].origin).toBe('builtin');
      expect(reg.active).toBe(FP);
      expect(reg.v).toBe(1);
    }
  });
  it('内置条目缺失时补上（内置永远在列表里）', () => {
    const reg = normalizeRegistry(
      { v: 1, active: 'p1', plans: [{ id: 'p1', name: '我家', origin: 'imported', createdAt: 5, updatedAt: 6 }] },
      FP
    );
    expect(reg.plans.map((p) => p.id)).toEqual([FP, 'p1']);
    expect(planById(reg, FP)!.origin).toBe('builtin');
    expect(reg.active).toBe('p1');
  });
  it('active 指向不存在的户型 → 回落到内置', () => {
    const reg = normalizeRegistry(
      { v: 1, active: 'ghost', plans: [{ id: 'p1', name: 'A', origin: 'blank', createdAt: 1, updatedAt: 1 }] },
      FP
    );
    expect(reg.active).toBe(FP);
  });
  it('重复 id 去重（后出现的胜出）', () => {
    const reg = normalizeRegistry(
      {
        v: 1,
        active: 'p1',
        plans: [
          { id: 'p1', name: '旧名', origin: 'blank', createdAt: 1, updatedAt: 1 },
          { id: 'p1', name: '新名', origin: 'blank', createdAt: 2, updatedAt: 9 },
        ],
      },
      FP
    );
    expect(reg.plans.filter((p) => p.id === 'p1').length).toBe(1);
    expect(planById(reg, 'p1')!.name).toBe('新名');
  });
  it('counts 缺字段补 0，负数/NaN 归 0', () => {
    const reg = normalizeRegistry(
      {
        v: 1,
        active: FP,
        plans: [
          {
            id: 'p1',
            name: 'A',
            origin: 'blank',
            createdAt: 1,
            updatedAt: 1,
            counts: { walls: -3, doors: NaN, items: 7.9 },
          },
        ],
      },
      FP
    );
    expect(planById(reg, 'p1')!.counts).toEqual({ walls: 0, doors: 0, fixtures: 0, items: 7 });
  });
  it('名字超长 / 非字符串 → 整条丢弃（不产生半条脏数据）', () => {
    const reg = normalizeRegistry(
      {
        v: 1,
        active: FP,
        plans: [
          { id: 'p1', name: 'x'.repeat(200), origin: 'blank', createdAt: 1, updatedAt: 1 },
          { id: 'p2', name: 12, origin: 'blank', createdAt: 1, updatedAt: 1 },
        ],
      },
      FP
    );
    expect(planById(reg, 'p1')).toBeNull();
    expect(planById(reg, 'p2')).toBeNull();
  });
});

describe('upsertPlan', () => {
  const base = normalizeRegistry(null, FP, '通用户型');
  it('新建即设为当前', () => {
    const reg = upsertPlan(base, { id: 'p1', name: '我家', origin: 'imported', now: 100 });
    expect(reg.active).toBe('p1');
    expect(reg.plans.length).toBe(2);
    expect(planById(reg, 'p1')!.origin).toBe('imported');
  });
  it('已存在 → 保留 createdAt 与原 origin（导入第二次不该把它变成 blank）', () => {
    const first = upsertPlan(base, { id: 'p1', name: '我家', origin: 'imported', now: 100 });
    const second = upsertPlan(first, { id: 'p1', name: '我家 v2', origin: 'blank', now: 200 });
    const p = planById(second, 'p1')!;
    expect(p.createdAt).toBe(100);
    expect(p.updatedAt).toBe(200);
    expect(p.origin).toBe('imported');
    expect(second.plans.filter((x) => x.id === 'p1').length).toBe(1);
  });
  it('非法 id / 名字 → 注册表原样返回（不写坏）', () => {
    expect(upsertPlan(base, { id: '', name: 'A', origin: 'blank', now: 1 }).plans.length).toBe(1);
    expect(upsertPlan(base, { id: 'p1', name: '', origin: 'blank', now: 1 }).plans.length).toBe(1);
  });
  it('counts 写进去（列表上能读出「墙 12 · 门 3」）', () => {
    const reg = upsertPlan(base, {
      id: 'p1',
      name: 'A',
      origin: 'blank',
      now: 1,
      counts: { walls: 12, doors: 3, fixtures: 2, items: 9 },
    });
    expect(planById(reg, 'p1')!.counts).toEqual({ walls: 12, doors: 3, fixtures: 2, items: 9 });
  });
});

describe('删除 / 重命名 / 切换', () => {
  const base = upsertPlan(normalizeRegistry(null, FP), { id: 'p1', name: '我家', origin: 'imported', now: 100 });
  it('内置不可删（出厂入口不能消失）', () => {
    expect(removePlan(base, FP)).toBeNull();
  });
  it('删当前户型可以，active 自动落到内置（界面不会空）', () => {
    const after = removePlan(base, 'p1');
    expect(after).not.toBeNull();
    expect(after!.plans.map((p) => p.id)).toEqual([FP]);
    expect(after!.active).toBe(FP);
  });
  it('删非当前户型不动 active', () => {
    const onBuiltin = setActive(base, FP);
    const after = removePlan(onBuiltin, 'p1');
    expect(after!.active).toBe(FP);
  });
  it('最后一份不可删（注册表永远至少剩内置）', () => {
    const onlyBuiltin = removePlan(base, 'p1')!;
    expect(removePlan(onlyBuiltin, FP)).toBeNull();
  });
  it('重命名非法名字被拒', () => {
    expect(renamePlan(base, 'p1', '')).toBeNull();
    expect(renamePlan(base, 'ghost', 'ok')).toBeNull();
    expect(renamePlan(base, 'p1', ' 客厅那套 ')!.plans.find((p) => p.id === 'p1')!.name).toBe(' 客厅那套 ');
  });
  it('setActive 不存在的 id 原样返回', () => {
    expect(setActive(base, 'ghost').active).toBe(base.active);
  });
  it('touchPlan 只动时间/计数，不新增条目', () => {
    const t = touchPlan(base, 'p1', { now: 300, counts: { walls: 1, doors: 0, fixtures: 0, items: 0 } });
    expect(t.plans.length).toBe(base.plans.length);
    expect(planById(t, 'p1')!.updatedAt).toBe(300);
    expect(touchPlan(base, 'ghost', { now: 1 })).toBe(base);
  });
});

describe('容量上限', () => {
  it('超过 MAX_PLANS 淘汰最旧的非内置、非当前；内置与当前保留', () => {
    let reg = normalizeRegistry(null, FP);
    for (let i = 0; i < MAX_PLANS + 6; i++) {
      reg = upsertPlan(reg, { id: 'p' + i, name: '户型 ' + i, origin: 'blank', now: 1000 + i });
    }
    expect(reg.plans.length).toBe(MAX_PLANS);
    expect(hasPlan(reg, FP)).toBe(true); // 内置保留
    expect(hasPlan(reg, 'p' + (MAX_PLANS + 5))).toBe(true); // 当前（最后 upsert 的）保留
    expect(hasPlan(reg, 'p0')).toBe(false); // 最旧的被淘汰
  });
  it('trimRegistry 幂等', () => {
    const reg = normalizeRegistry(null, FP);
    expect(trimRegistry(reg).plans.length).toBe(reg.plans.length);
  });
});

describe('序列化往返 / 展示顺序', () => {
  it('serialize → normalize 往返保真', () => {
    let reg = upsertPlan(normalizeRegistry(null, FP, '通用户型'), {
      id: 'p1',
      name: '我家',
      origin: 'imported',
      now: 100,
      counts: { walls: 8, doors: 2, fixtures: 3, items: 11 },
    });
    reg = renamePlan(reg, 'p1', '我家（改过）')!;
    const back = normalizeRegistry(JSON.parse(serializeRegistry(reg)), FP, '通用户型');
    expect(back.plans).toEqual(reg.plans);
    expect(back.active).toBe(reg.active);
  });
  it('内置排最前，其余按最近使用倒序', () => {
    let reg = normalizeRegistry(null, FP);
    reg = upsertPlan(reg, { id: 'pa', name: 'A', origin: 'blank', now: 10 });
    reg = upsertPlan(reg, { id: 'pb', name: 'B', origin: 'imported', now: 50 });
    expect(sortedPlans(reg).map((p) => p.id)).toEqual([FP, 'pb', 'pa']);
  });
  it('PLANS_KEY 是独立于户型指纹的键（注册表必须能在 warm 完成前同步读到）', () => {
    expect(PLANS_KEY).toBe('planner_plans_v1');
    expect(PLANS_KEY.includes(':')).toBe(false);
  });
});
