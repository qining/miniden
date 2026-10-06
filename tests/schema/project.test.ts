import { describe, it, expect } from 'vitest';
import { validate, blankDoc, nextId, projectSchema, type ProjectDoc } from '../../src/schema/project';
import { docToLegacy } from '../../src/schema/migrate';
import type { Seg, Pt } from '../../src/schema/primitives';
import { fullCircle } from '../../src/schema/primitives';

/* =====================================================================
   project（ADR-0005）——validate() 载入时跑；id 稳定；JSON Schema 导出
   ===================================================================== */

const seg = (x2 = 1): Seg => ({ t: 'seg', x1: 0, y1: 0, x2, y2: 0 });

describe('blankDoc / nextId', () => {
  it('空白文档通过校验', () => {
    expect(validate(blankDoc())).toEqual([]);
  });

  it('nextId 递增且避开已占用 id', () => {
    const doc = blankDoc();
    expect(nextId(doc, 'wall')).toBe('w01');
    doc.walls.push({ id: 'w2', kind: 'wall', geom: seg() });
    doc.walls.push({ id: 'w1', kind: 'wall', geom: seg(2) });
    expect(nextId(doc, 'wall')).toBe('w03');
  });
});

describe('validate —— 拒绝非法文档', () => {
  const bad = (patch: (d: ProjectDoc) => void): ProjectDoc => {
    const d = blankDoc();
    patch(d);
    return d;
  };

  it('schema 版本', () => {
    const d = bad(x => { (x as { schema: number }).schema = 2; });
    expect(validate(d).map(e => e.path)).toContain('schema');
  });

  it('id 重复', () => {
    const d = bad(x => {
      x.walls.push({ id: 'w01', kind: 'wall', geom: seg() });
      x.walls.push({ id: 'w01', kind: 'wall', geom: seg(2) });
    });
    const errs = validate(d);
    expect(errs.some(e => e.path === 'walls[1].id' && /重复/.test(e.message))).toBe(true);
  });

  it('窗 sill ≥ head', () => {
    const d = bad(x => x.windows.push({
      id: 'n1', geom: seg(2), wallId: null, pos: 0.5, width: 1.5,
      sill: 3, head: 2, style: 'fixed', frame: '#111', glass: 0.2,
    }));
    expect(validate(d).some(e => /sill/.test(e.message) && /head/.test(e.message))).toBe(true);
  });

  it('窗 style 非法', () => {
    const d = bad(x => x.windows.push({
      id: 'n1', geom: seg(2), pos: 0.5, width: 1.5, sill: 0.5, head: 2.2,
      style: 'sash' as never, frame: '#111', glass: 0.2,
    }));
    expect(validate(d).some(e => e.path === 'windows[0].style')).toBe(true);
  });

  it('glass 越界', () => {
    const d = bad(x => x.windows.push({
      id: 'n1', geom: seg(2), pos: 0.5, width: 1.5, sill: 0.5, head: 2.2,
      style: 'fixed', frame: '#111', glass: 1.5,
    }));
    expect(validate(d).some(e => e.path === 'windows[0].glass')).toBe(true);
  });

  it('门 kind 非法（窗不再误伤：kind 检查只对 doors）', () => {
    const d = bad(x => x.doors.push({
      id: 'd1', geom: seg(2), pos: 0.5, width: 1, kind: 'magic' as never,
    }));
    const errs = validate(d);
    expect(errs.some(e => e.path === 'doors[0].kind')).toBe(true);
    expect(errs.some(e => e.path === 'windows[0].kind')).toBe(false);
  });

  it('wallId 悬空引用', () => {
    const d = bad(x => x.windows.push({
      id: 'n1', geom: seg(2), wallId: 'w99', pos: 0.5, width: 1.5,
      sill: 0.5, head: 2.2, style: 'fixed', frame: '#111', glass: 0.2,
    }));
    expect(validate(d).some(e => e.path === 'windows[0].wallId' && /不存在/.test(e.message))).toBe(true);
  });

  it('pos 越界', () => {
    const d = bad(x => x.windows.push({
      id: 'n1', geom: seg(2), pos: 1.2, width: 1.5, sill: 0.5, head: 2.2,
      style: 'fixed', frame: '#111', glass: 0.2,
    }));
    expect(validate(d).some(e => e.path === 'windows[0].pos')).toBe(true);
  });

  it('hidden 非字符串数组', () => {
    const d = bad(x => { (x.hidden as { walls: unknown[] }).walls = [1, 2]; });
    expect(validate(d).some(e => e.path === 'hidden.walls')).toBe(true);
  });

  it('env 缺失', () => {
    const d = bad(x => { delete (x as { env?: unknown }).env; });
    expect(validate(d).some(e => e.path === 'env')).toBe(true);
  });
});

describe('validate —— 洁具字段（S6 前置：rot 进文档）', () => {
  const fx = (patch: object = {}): ProjectDoc => {
    const d = blankDoc();
    d.fixtures.push({ id: 'f01', t: 'toilet', x1: 1, y1: 1, x2: 2, y2: 2, ...patch });
    return d;
  };

  it('fixture 带 rot 通过校验', () => {
    expect(validate(fx({ rot: 45 }))).toEqual([]);
    expect(validate(fx({}))).toEqual([]);   // rot 缺省 = 轴对齐
  });

  it('rot 非数被拒', () => {
    const errs = validate(fx({ rot: 'N' as never }));
    expect(errs.some(e => e.path === 'fixtures[0].rot')).toBe(true);
  });

  it('坐标非数被拒', () => {
    const errs = validate(fx({ x2: '9' as never }));
    expect(errs.map(e => e.path)).toContain('fixtures[0].x2');
  });

  it('fixture id 重复被拒', () => {
    const d = fx();
    d.fixtures.push({ id: 'f01', t: 'tub', x1: 3, y1: 3, x2: 4, y2: 4 });
    expect(validate(d).some(e => e.path === 'fixtures[1].id' && /重复/.test(e.message))).toBe(true);
  });
});

describe('S11 —— floorOutline（户型文档导出/导入）', () => {
  it('可选字段，缺省不影响校验', () => {
    expect(validate(blankDoc())).toEqual([]);
  });

  it('带合法轮廓通过校验，且导出/导入往返逐字段相等', () => {
    const d = blankDoc('我家');
    d.floorOutline = [[0, 0], [20, 0], [20, 15], [0, 15]] as unknown as Pt[][];
    expect(validate(d)).toEqual([]);
    const round = JSON.parse(JSON.stringify(d)) as ProjectDoc;
    expect(validate(round)).toEqual([]);
    expect(round).toEqual(d);
  });

  it('少于 3 个点被拒', () => {
    const d = blankDoc(); d.floorOutline = [[0, 0], [10, 0]] as unknown as Pt[][];
    expect(validate(d).some(e => e.path === 'floorOutline')).toBe(true);
  });

  it('点不是 [x, y] 被拒', () => {
    const d = blankDoc(); d.floorOutline = [[0, 0], [10, 0], ['x', 0]] as unknown as unknown as Pt[][];
    expect(validate(d).some(e => e.path === 'floorOutline[2]')).toBe(true);
    const d2 = blankDoc(); d2.floorOutline = [[0, 0], [10, 0], [10, 5, 5]] as unknown as unknown as Pt[][];
    expect(validate(d2).some(e => e.path === 'floorOutline[2]')).toBe(true);
  });

  it('不进 docToLegacy 投影（S1 字节等价红线：投影键集冻结）', () => {
    const d = blankDoc();
    d.floorOutline = [[0, 0], [10, 0], [10, 5]] as unknown as Pt[][];
    expect(Object.keys(docToLegacy(d))).toEqual(['walls', 'fixed', 'doors']);
  });

  it('JSON Schema 导出含 floorOutline', () => {
    const s = projectSchema() as Record<string, any>;
    expect(s.properties.floorOutline).toBeTruthy();
    expect(s.required).not.toContain('floorOutline');   // 纯增量可选字段
  });
});

describe('projectSchema（JSON Schema 导出）', () => {
  it('是 draft-07 且含关键定义', () => {
    const s = projectSchema() as Record<string, any>;
    expect(s.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(s.required).toContain('schema');
    expect(s.definitions.geom.oneOf.length).toBe(3);
    expect(s.properties).toHaveProperty('sc');
  });
});

describe('整圆原语进文档（ADR-0002：圆柱可用 arc 存）', () => {
  it('fullCircle 作为 solid.geom 通过校验', () => {
    const d = blankDoc();
    d.solids.push({ id: 's1', name: '柱', geom: fullCircle(5, 5, 1.1), fill: '#0c0d0f', column: true });
    expect(validate(d)).toEqual([]);
  });
});

/* =====================================================================
   S11b：plan 快照（户型专属构件/参考）——导出/导入必须带得走
   ===================================================================== */
describe('plan 快照（S11b）', () => {
  const good = () => {
    const d = blankDoc('我家');
    d.plan = {
      roomSummary: '2室1卫 · 通用户型',
      refPhoto: 'private/photos/704.jpg',
      calib: { img: 'private/plan/clean_plan.jpg', w: 591, h: 480 },
      windowBand: [[10, 20], [14, 22]],
      patioPatch: [[0, 0], [3, 0], [0, 3]],
      islLabel: { p: [30, 12], w: 9.6, d: 2.4, calib: '9.6×2.4' },
      isl: { a: [24, 27.8], b: [40, 27.8], e: [40, 30], cp2: [32, 31], d: [24, 30] },
      inner: [{ x1: 0, y1: 12, x2: 8, y2: 12, wd: 3 }],
      kitchen: [
        { m: 'cab', box: [9.6, 3.0, 2.41], p: [26.18, 1.5, 14.33], sh: true },
        { m: 'chrome', cyl: [0.045, 2.7], p: [19.69, 4.3, 15.85], seg: 10 },
        { m: 'chrome', cyl: [0.045, 2.45], p: [19.83, 1.5, 15.85], rz: 90 },
      ],
    };
    return d;
  };

  it('合法快照通过校验，且 JSON 往返逐字段相等', () => {
    const d = good();
    expect(validate(d)).toEqual([]);
    const round = JSON.parse(JSON.stringify(d)) as ProjectDoc;
    expect(validate(round)).toEqual([]);
    expect(round).toEqual(d);
  });

  it('plan 是纯增量可选字段（不在 required 里）', () => {
    const s = projectSchema() as Record<string, any>;
    expect(s.properties.plan).toBeTruthy();
    expect(s.required).not.toContain('plan');
    expect(validate(blankDoc())).toEqual([]);   // 没有 plan 也合法
  });

  it('非法材质档被拒', () => {
    const d = good();
    (d.plan!.kitchen![0] as any).m = 'marble';
    expect(validate(d).some(e => e.path === 'plan.kitchen[0].m')).toBe(true);
  });

  it('缺 box 或 cyl 被拒', () => {
    const d = good();
    (d.plan!.kitchen![0] as any).box = undefined;
    expect(validate(d).some(e => e.path === 'plan.kitchen[0]')).toBe(true);
  });

  it('cyl 必须是 [r, len]（ft）', () => {
    const d = good();
    (d.plan!.kitchen![1] as any).cyl = [0.045, 2.7, 10];
    expect(validate(d).some(e => e.path === 'plan.kitchen[1].cyl')).toBe(true);
  });

  it('inner 段坐标不是数被拒', () => {
    const d = good();
    (d.plan!.inner![0] as any).y2 = 'x';
    expect(validate(d).some(e => e.path === 'plan.inner[0].y2')).toBe(true);
  });

  it('plan 不进 docToLegacy 投影（S1 字节等价红线：投影键集冻结）', () => {
    const d = good();
    expect(Object.keys(docToLegacy(d))).toEqual(['walls', 'fixed', 'doors']);
  });
});

/* =====================================================================
   S12：台面/柜体 run（用户自己画的沿墙折线）
   ===================================================================== */
describe('run 实体（S12）', () => {
  const good = () => {
    const d = blankDoc('厨房');
    d.runs = [{
      id: 'rn01',
      path: [[2, 1], [8, 1], [8, 4]] as unknown as Pt[] as any,
      depth: 1.97, topH: 2.95, h: 2.62,
      modules: [{ at: 1.5, type: 'sink', w: 1.8 }, { at: 5, type: 'cooktop', w: 2.0 }],
      src: 'user',
    }];
    return d;
  };

  it('合法 run 通过校验且 JSON 往返逐字段相等', () => {
    const d = good();
    expect(validate(d)).toEqual([]);
    const round = JSON.parse(JSON.stringify(d)) as ProjectDoc;
    expect(validate(round)).toEqual([]);
    expect(round).toEqual(d);
  });

  it('runs 是纯增量可选字段（不在 required 里）', () => {
    const s = projectSchema() as Record<string, any>;
    expect(s.properties.runs).toBeTruthy();
    expect(s.required).not.toContain('runs');
    const d = blankDoc(); d.runs = undefined;
    expect(validate(d)).toEqual([]);   // 旧文档没有 runs 也合法
  });

  it('path 少于 2 点被拒', () => {
    const d = good();
    (d.runs![0] as any).path = [[2, 1]];
    expect(validate(d).some(e => e.path === 'runs[0].path')).toBe(true);
  });

  it('path 点不是 [x, y] 被拒', () => {
    const d = good();
    (d.runs![0] as any).path = [[2, 1], [8, 'x']] as any;
    expect(validate(d).some(e => e.path === 'runs[0].path[1]')).toBe(true);
  });

  it('depth / topH 非正数被拒', () => {
    const d = good();
    (d.runs![0] as any).depth = 0;
    (d.runs![0] as any).topH = -1;
    const errs = validate(d);
    expect(errs.some(e => e.path === 'runs[0].depth')).toBe(true);
    expect(errs.some(e => e.path === 'runs[0].topH')).toBe(true);
  });

  it('module type 非法被拒', () => {
    const d = good();
    (d.runs![0].modules![0] as any).type = 'bookcase';
    expect(validate(d).some(e => e.path === 'runs[0].modules[0].type')).toBe(true);
  });

  it('runs 不进 docToLegacy 投影（投影键集冻结）', () => {
    const d = good();
    expect(Object.keys(docToLegacy(d))).toEqual(['walls', 'fixed', 'doors']);
  });

  it('nextId 给 run 用 rn 前缀且不撞 room 的 r', () => {
    const d = blankDoc();
    expect(nextId(d, 'run')).toBe('rn01');
    d.runs = [{ id: 'rn01', path: [[0, 0], [1, 0]], depth: 2, topH: 3 }];
    expect(nextId(d, 'run')).toBe('rn02');
    expect(nextId(d, 'room')).toBe('r01');
  });
});
