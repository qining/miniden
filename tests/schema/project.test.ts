import { describe, it, expect } from 'vitest';
import { validate, checkGeoms, blankDoc, nextId, projectSchema, type ProjectDoc } from '../../src/schema/project';
import { docToLegacy, migrateLegacyToV1 } from '../../src/schema/migrate';
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

  it('墙 ↔ 窗互转保留 id：新墙避开窗里那个「w…」、新窗避开墙里那个「n…」（E19 轮㊷）', () => {
    const doc = blankDoc();
    doc.walls.push({ id: 'w01', kind: 'wall', geom: seg() }, { id: 'w02', kind: 'wall', geom: seg(2) });
    // w03 被换成了窗（winFromWall 把实体搬进 windows、id 不变）
    doc.windows.push({
      id: 'w03',
      geom: seg(4),
      wallId: null,
      pos: 0.5,
      width: 1,
      sill: 2,
      head: 7,
      style: 'fixed',
    } as never);
    expect(nextId(doc, 'wall')).toBe('w04');
    // 反过来：n01 被换成了墙
    doc.walls.push({ id: 'n01', kind: 'wall', geom: seg(6) });
    expect(nextId(doc, 'window')).toBe('n02');
  });
});

describe('validate —— 拒绝非法文档', () => {
  const bad = (patch: (d: ProjectDoc) => void): ProjectDoc => {
    const d = blankDoc();
    patch(d);
    return d;
  };

  it('schema 版本', () => {
    const d = bad((x) => {
      (x as { schema: number }).schema = 2;
    });
    expect(validate(d).map((e) => e.path)).toContain('schema');
  });

  it('id 重复', () => {
    const d = bad((x) => {
      x.walls.push({ id: 'w01', kind: 'wall', geom: seg() });
      x.walls.push({ id: 'w01', kind: 'wall', geom: seg(2) });
    });
    const errs = validate(d);
    expect(errs.some((e) => e.path === 'walls[1].id' && /重复/.test(e.message))).toBe(true);
  });

  it('窗 sill ≥ head', () => {
    const d = bad((x) =>
      x.windows.push({
        id: 'n1',
        geom: seg(2),
        wallId: null,
        pos: 0.5,
        width: 1.5,
        sill: 3,
        head: 2,
        style: 'fixed',
        frame: '#111',
        glass: 0.2,
      })
    );
    expect(validate(d).some((e) => /sill/.test(e.message) && /head/.test(e.message))).toBe(true);
  });

  it('窗 style 非法', () => {
    const d = bad((x) =>
      x.windows.push({
        id: 'n1',
        geom: seg(2),
        pos: 0.5,
        width: 1.5,
        sill: 0.5,
        head: 2.2,
        style: 'sash' as never,
        frame: '#111',
        glass: 0.2,
      })
    );
    expect(validate(d).some((e) => e.path === 'windows[0].style')).toBe(true);
  });

  it('glass 越界', () => {
    const d = bad((x) =>
      x.windows.push({
        id: 'n1',
        geom: seg(2),
        pos: 0.5,
        width: 1.5,
        sill: 0.5,
        head: 2.2,
        style: 'fixed',
        frame: '#111',
        glass: 1.5,
      })
    );
    expect(validate(d).some((e) => e.path === 'windows[0].glass')).toBe(true);
  });

  it('门 kind 非法（窗不再误伤：kind 检查只对 doors）', () => {
    const d = bad((x) =>
      x.doors.push({
        id: 'd1',
        geom: seg(2),
        pos: 0.5,
        width: 1,
        kind: 'magic' as never,
      })
    );
    const errs = validate(d);
    expect(errs.some((e) => e.path === 'doors[0].kind')).toBe(true);
    expect(errs.some((e) => e.path === 'windows[0].kind')).toBe(false);
  });

  it('wallId 悬空引用', () => {
    const d = bad((x) =>
      x.windows.push({
        id: 'n1',
        geom: seg(2),
        wallId: 'w99',
        pos: 0.5,
        width: 1.5,
        sill: 0.5,
        head: 2.2,
        style: 'fixed',
        frame: '#111',
        glass: 0.2,
      })
    );
    expect(validate(d).some((e) => e.path === 'windows[0].wallId' && /不存在/.test(e.message))).toBe(true);
  });

  it('pos 越界', () => {
    const d = bad((x) =>
      x.windows.push({
        id: 'n1',
        geom: seg(2),
        pos: 1.2,
        width: 1.5,
        sill: 0.5,
        head: 2.2,
        style: 'fixed',
        frame: '#111',
        glass: 0.2,
      })
    );
    expect(validate(d).some((e) => e.path === 'windows[0].pos')).toBe(true);
  });

  it('hidden 非字符串数组', () => {
    const d = bad((x) => {
      (x.hidden as { walls: unknown[] }).walls = [1, 2];
    });
    expect(validate(d).some((e) => e.path === 'hidden.walls')).toBe(true);
  });

  it('env 缺失', () => {
    const d = bad((x) => {
      delete (x as { env?: unknown }).env;
    });
    expect(validate(d).some((e) => e.path === 'env')).toBe(true);
  });
});

describe('validate —— 洁具字段（S6 前置：rot 进文档）', () => {
  const fx = (patch: object = {}): ProjectDoc => {
    const d = blankDoc();
    d.fixtures.push({
      id: 'f01',
      t: 'toilet',
      x1: 1,
      y1: 1,
      x2: 2,
      y2: 2,
      ...patch,
    });
    return d;
  };

  it('fixture 带 rot 通过校验', () => {
    expect(validate(fx({ rot: 45 }))).toEqual([]);
    expect(validate(fx({}))).toEqual([]); // rot 缺省 = 轴对齐
  });

  it('rot 非数被拒', () => {
    const errs = validate(fx({ rot: 'N' as never }));
    expect(errs.some((e) => e.path === 'fixtures[0].rot')).toBe(true);
  });

  it('坐标非数被拒', () => {
    const errs = validate(fx({ x2: '9' as never }));
    expect(errs.map((e) => e.path)).toContain('fixtures[0].x2');
  });

  it('fixture id 重复被拒', () => {
    const d = fx();
    d.fixtures.push({ id: 'f01', t: 'tub', x1: 3, y1: 3, x2: 4, y2: 4 });
    expect(validate(d).some((e) => e.path === 'fixtures[1].id' && /重复/.test(e.message))).toBe(true);
  });
});

describe('S11 —— floorOutline（户型文档导出/导入）', () => {
  it('可选字段，缺省不影响校验', () => {
    expect(validate(blankDoc())).toEqual([]);
  });

  it('带合法轮廓通过校验，且导出/导入往返逐字段相等', () => {
    const d = blankDoc('我家');
    d.floorOutline = [
      [0, 0],
      [20, 0],
      [20, 15],
      [0, 15],
    ] as unknown as Pt[][];
    expect(validate(d)).toEqual([]);
    const round = JSON.parse(JSON.stringify(d)) as ProjectDoc;
    expect(validate(round)).toEqual([]);
    expect(round).toEqual(d);
  });

  it('少于 3 个点被拒', () => {
    const d = blankDoc();
    d.floorOutline = [
      [0, 0],
      [10, 0],
    ] as unknown as Pt[][];
    expect(validate(d).some((e) => e.path === 'floorOutline')).toBe(true);
  });

  it('点不是 [x, y] 被拒', () => {
    const d = blankDoc();
    d.floorOutline = [
      [0, 0],
      [10, 0],
      ['x', 0],
    ] as unknown as unknown as Pt[][];
    expect(validate(d).some((e) => e.path === 'floorOutline[2]')).toBe(true);
    const d2 = blankDoc();
    d2.floorOutline = [
      [0, 0],
      [10, 0],
      [10, 5, 5],
    ] as unknown as unknown as Pt[][];
    expect(validate(d2).some((e) => e.path === 'floorOutline[2]')).toBe(true);
  });

  it('不进 docToLegacy 投影（S1 字节等价红线：投影键集冻结）', () => {
    const d = blankDoc();
    d.floorOutline = [
      [0, 0],
      [10, 0],
      [10, 5],
    ] as unknown as Pt[][];
    expect(Object.keys(docToLegacy(d))).toEqual(['walls', 'fixed', 'doors']);
  });

  it('JSON Schema 导出含 floorOutline', () => {
    const s = projectSchema() as Record<string, any>;
    expect(s.properties.floorOutline).toBeTruthy();
    expect(s.required).not.toContain('floorOutline'); // 纯增量可选字段
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
    d.solids.push({
      id: 's1',
      name: '柱',
      geom: fullCircle(5, 5, 1.1),
      fill: '#0c0d0f',
      column: true,
    });
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
      windowBand: [
        [10, 20],
        [14, 22],
      ],
      patioPatch: [
        [0, 0],
        [3, 0],
        [0, 3],
      ],
      islLabel: { p: [30, 12], w: 9.6, d: 2.4, calib: '9.6×2.4' },
      isl: {
        a: [24, 27.8],
        b: [40, 27.8],
        e: [40, 30],
        cp2: [32, 31],
        d: [24, 30],
      },
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
    expect(validate(blankDoc())).toEqual([]); // 没有 plan 也合法
  });

  it('非法材质档被拒', () => {
    const d = good();
    (d.plan!.kitchen![0] as any).m = 'marble';
    expect(validate(d).some((e) => e.path === 'plan.kitchen[0].m')).toBe(true);
  });

  it('缺 box 或 cyl 被拒', () => {
    const d = good();
    (d.plan!.kitchen![0] as any).box = undefined;
    expect(validate(d).some((e) => e.path === 'plan.kitchen[0]')).toBe(true);
  });

  it('cyl 必须是 [r, len]（ft）', () => {
    const d = good();
    (d.plan!.kitchen![1] as any).cyl = [0.045, 2.7, 10];
    expect(validate(d).some((e) => e.path === 'plan.kitchen[1].cyl')).toBe(true);
  });

  it('inner 段坐标不是数被拒', () => {
    const d = good();
    (d.plan!.inner![0] as any).y2 = 'x';
    expect(validate(d).some((e) => e.path === 'plan.inner[0].y2')).toBe(true);
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
    d.runs = [
      {
        id: 'rn01',
        path: [
          [2, 1],
          [8, 1],
          [8, 4],
        ] as unknown as Pt[] as any,
        depth: 1.97,
        topH: 2.95,
        h: 2.62,
        modules: [
          { at: 1.5, type: 'sink', w: 1.8 },
          { at: 5, type: 'cooktop', w: 2.0 },
        ],
        src: 'user',
      },
    ];
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
    const d = blankDoc();
    d.runs = undefined;
    expect(validate(d)).toEqual([]); // 旧文档没有 runs 也合法
  });

  it('path 少于 2 点被拒', () => {
    const d = good();
    (d.runs![0] as any).path = [[2, 1]];
    expect(validate(d).some((e) => e.path === 'runs[0].path')).toBe(true);
  });

  it('path 点不是 [x, y] 被拒', () => {
    const d = good();
    (d.runs![0] as any).path = [
      [2, 1],
      [8, 'x'],
    ] as any;
    expect(validate(d).some((e) => e.path === 'runs[0].path[1]')).toBe(true);
  });

  it('depth / topH 非正数被拒', () => {
    const d = good();
    (d.runs![0] as any).depth = 0;
    (d.runs![0] as any).topH = -1;
    const errs = validate(d);
    expect(errs.some((e) => e.path === 'runs[0].depth')).toBe(true);
    expect(errs.some((e) => e.path === 'runs[0].topH')).toBe(true);
  });

  it('module type 非法被拒', () => {
    const d = good();
    (d.runs![0].modules![0] as any).type = 'bookcase';
    expect(validate(d).some((e) => e.path === 'runs[0].modules[0].type')).toBe(true);
  });

  it('runs 不进 docToLegacy 投影（投影键集冻结）', () => {
    const d = good();
    expect(Object.keys(docToLegacy(d))).toEqual(['walls', 'fixed', 'doors']);
  });

  it('nextId 给 run 用 rn 前缀且不撞 room 的 r', () => {
    const d = blankDoc();
    expect(nextId(d, 'run')).toBe('rn01');
    d.runs = [
      {
        id: 'rn01',
        path: [
          [0, 0],
          [1, 0],
        ],
        depth: 2,
        topH: 3,
      },
    ];
    expect(nextId(d, 'run')).toBe('rn02');
    expect(nextId(d, 'room')).toBe('r01');
  });
});

/* ---- bug 猎 #5：validate 必须拒掉非法洁具类型（消费端按 t 分支，未知 t = 隐形件）---- */
describe('validate — fixtures[].t 枚举（bug 猎 #5）', () => {
  const base = () => {
    const d = blankDoc('t');
    d.fixtures = [{ id: 'f1', t: 'toilet', x1: 0, y1: 0, x2: 2, y2: 1 }];
    return d;
  };
  it('合法类型通过', () => {
    expect(validate(base())).toEqual([]);
  });
  it('S26：洗手台 vanity（带 form / wcm / mount / cab）与百叶 / 罗马帘窗帘、房间墙砖 / 墙纸 / 单面墙都过校验', () => {
    const d = base();
    d.fixtures.push({
      id: 'f2',
      t: 'vanity',
      x1: 3,
      y1: 0,
      x2: 5,
      y2: 1.5,
      form: 'vessel',
      wcm: 80,
      mount: 'hang',
      cab: '#2f3e55',
    } as never);
    expect(validate(d)).toEqual([]);
    for (const style of ['blindWood', 'blindAlu', 'roman']) {
      const w = blankDoc('w');
      w.windows = [
        {
          id: 'n1',
          geom: { t: 'seg', x1: 0, y1: 0, x2: 4, y2: 0 },
          pos: 0.5,
          width: 4,
          sill: 2,
          head: 7,
          style: 'fixed',
          frame: '#fff',
          glass: 0.2,
          curtain: { style, color: '#b48a5a' },
        } as never,
      ];
      expect(validate(w)).toEqual([]);
    }
    const bad = blankDoc('b');
    bad.windows = [
      {
        id: 'n1',
        geom: { t: 'seg', x1: 0, y1: 0, x2: 4, y2: 0 },
        pos: 0.5,
        width: 4,
        sill: 2,
        head: 7,
        style: 'fixed',
        frame: '#fff',
        glass: 0.2,
        curtain: { style: 'venetian', color: '#fff' },
      } as never,
    ];
    expect(validate(bad).some((e) => /curtain\.style/.test(e.path))).toBe(true);
  });
  it('未知类型 / 缺失 t 被拒', () => {
    const d = base();
    (d.fixtures[0] as { t: string }).t = 'bidet';
    const errs = validate(d);
    expect(errs.some((e) => e.path === 'fixtures[0].t')).toBe(true);
    const d2 = base();
    delete (d2.fixtures[0] as { t?: string }).t;
    expect(validate(d2).some((e) => e.path === 'fixtures[0].t')).toBe(true);
  });
  it('migrate 对未知 legacy t 归一成 counter（不会把脏数据带进文档）', () => {
    const doc = migrateLegacyToV1({
      sc: 11.2,
      walls: [],
      inner: [],
      doors: [],
      fixed: [],
      labels: [],
      fx: [{ t: 'bidet', x1: 0, y1: 0, x2: 11.2, y2: 22.4 }],
      patio: [],
    });
    expect(doc.fixtures[0].t).toBe('counter');
    expect(validate(doc)).toEqual([]);
  });
});

/* ---- bug 猎 #10：validate 只验「geom 是个对象」，不验它内部字段。
   缺字段 / NaN 会让 expand() 产出 NaN → 构件在 2D/3D 里消失且不报错。
   checkGeoms 补上这一层，只挂在导入闸门（不动 loadDoc 的 usable，避免删用户存档）。 ---- */
describe('checkGeoms —— 几何字段形状（bug 猎 #10）', () => {
  const base = (): ProjectDoc => {
    const d = blankDoc();
    d.walls.push({ id: 'w01', kind: 'wall', geom: seg() });
    d.solids.push({
      id: 's01',
      geom: {
        t: 'poly',
        pts: [
          [0, 0],
          [2, 0],
          [2, 1],
        ],
      },
      fill: '#0c0d0f',
    });
    d.doors.push({
      id: 'd01',
      geom: seg(0.9),
      gapGeom: { t: 'seg', x1: 3, y1: 0, x2: 3.9, y2: 0 },
      pos: 0.5,
      width: 0.9,
      kind: 'swing',
    });
    return d;
  };

  it('合法文档（含 seg / poly / gapGeom）通过', () => {
    expect(checkGeoms(base())).toEqual([]);
  });
  it('内置户型迁移出来的文档通过（不给真实数据找茬）', () => {
    const doc = migrateLegacyToV1({
      sc: 11.2,
      walls: [{ x1: 0, y1: 0, x2: 112, y2: 0, t: 'w' }],
      inner: [],
      doors: [],
      fixed: [
        {
          name: '柱',
          poly: [
            [0, 0],
            [11, 0],
            [11, 11],
          ],
          fill: '#0c0d0f',
        },
      ], // legacy poly = [x, y] 数组（与 plan JSON 同形）
      labels: [],
      fx: [],
      patio: [],
    });
    expect(checkGeoms(doc)).toEqual([]);
    const lp = docToLegacy(doc).fixed[0]!.poly as Pt[]; // legacy 投影：poly 数组（或 {poly} 包裹）
    expect(Array.isArray(lp) && lp.length).toBe(3);
  });
  it('validate 放行、checkGeoms 拒：seg 缺 x2/y2（这就是那条缺口）', () => {
    const d = base();
    (d.walls[0].geom as { x2?: number }).x2 = undefined as unknown as number;
    expect(validate(d).some((e) => /geom/.test(e.path))).toBe(false); // 旧闸门看不见
    const errs = checkGeoms(d);
    expect(errs.map((e) => e.path)).toContain('walls[0].geom.x2');
  });
  it('NaN 坐标被拒（expand 会产出 NaN → 构件隐形）', () => {
    const d = base();
    (d.solids[0].geom as { pts: Pt[] }).pts = [
      [0, 0],
      [Number.NaN, 0],
      [2, 1],
    ];
    expect(checkGeoms(d).map((e) => e.path)).toContain('solids[0].geom.pts[1]');
  });
  it('arc：r≤0 / dir 非法 / 缺 a0 被拒；fullCircle 通过', () => {
    const ok = base();
    ok.solids.push({
      id: 's02',
      geom: fullCircle(1, 1, 0.5),
      fill: '#8a919c',
      column: true,
    });
    expect(checkGeoms(ok)).toEqual([]);
    for (const patch of [
      (g: Record<string, unknown>) => (g.r = 0),
      (g: Record<string, unknown>) => (g.dir = 0),
      (g: Record<string, unknown>) => delete g.a0,
    ]) {
      const d = base();
      const g = fullCircle(1, 1, 0.5) as unknown as Record<string, unknown>;
      patch(g);
      d.solids.push({ id: 's02', geom: g as never, fill: '#8a919c' });
      expect(checkGeoms(d).length).toBeGreaterThan(0);
    }
  });
  it('geom.t 不是 seg|arc|poly 被拒；doors.gapGeom 也查', () => {
    const d = base();
    (d.walls[0] as { geom: unknown }).geom = { t: 'circle', r: 1 };
    expect(checkGeoms(d).map((e) => e.path)).toContain('walls[0].geom.t');
    const d2 = base();
    (d2.doors[0] as { gapGeom: unknown }).gapGeom = {
      t: 'seg',
      x1: 0,
      y1: 0,
      x2: '3.9',
      y2: 0,
    };
    expect(checkGeoms(d2).map((e) => e.path)).toContain('doors[0].gapGeom.x2');
  });
  it('geom 必填（缺了就不是原语链）', () => {
    const d = base();
    delete (d.solids[0] as { geom?: unknown }).geom;
    expect(checkGeoms(d).map((e) => e.path)).toContain('solids[0].geom');
  });
});

/* =====================================================================
   S14：电源插座（挂在墙面 / 台面挡水墙 / 台柜上的点状实体）
   ===================================================================== */
describe('outlet 实体（S14）', () => {
  const good = () => {
    const d = blankDoc('插座');
    d.outlets = [
      {
        id: 'ol01',
        x: 3.2,
        y: 0.15,
        rot: 90,
        h: 1,
        kind: 'std',
        n: 2,
        host: 'wall',
        hostId: 'w01',
        at: 3.2,
        side: 1,
        src: 'user',
      },
      {
        id: 'ol02',
        x: 5,
        y: 2,
        rot: 270,
        h: 3.45,
        kind: 'gfci',
        host: 'run',
        hostId: 'rn01',
        at: 3,
        side: 0,
        dh: 0.5,
        src: 'user',
      },
      {
        id: 'ol03',
        x: 7,
        y: 2,
        rot: 0,
        h: 2.9,
        kind: 'usb',
        n: 1,
        host: 'fx',
        hostId: 'f01',
        at: 0.2,
        side: 2,
        dh: 0.5,
        src: 'user',
      },
    ];
    return d;
  };

  it('合法插座通过校验且 JSON 往返逐字段相等', () => {
    const d = good();
    expect(validate(d)).toEqual([]);
    const round = JSON.parse(JSON.stringify(d)) as ProjectDoc;
    expect(validate(round)).toEqual([]);
    expect(round).toEqual(d);
  });

  it('outlets 是纯增量可选字段（旧文档没有也合法，且不进 required）', () => {
    const s = projectSchema() as Record<string, any>;
    expect(s.properties.outlets).toBeTruthy();
    expect(s.definitions.outlet).toBeTruthy();
    expect(s.required).not.toContain('outlets');
    const d = blankDoc();
    expect(d.outlets).toBeUndefined();
    expect(validate(d)).toEqual([]);
  });

  it('坐标 / 朝向不是数被拒', () => {
    const d = good();
    (d.outlets![0] as any).x = 'a';
    (d.outlets![0] as any).rot = null;
    const errs = validate(d);
    expect(errs.some((e) => e.path === 'outlets[0].x')).toBe(true);
    expect(errs.some((e) => e.path === 'outlets[0].rot')).toBe(true);
  });

  it('离地高度必须在 (0, 12ft]：负数 / 0 / 穿出天花都拒', () => {
    for (const h of [0, -1, 13, NaN]) {
      const d = good();
      d.outlets![0].h = h;
      expect(validate(d).some((e) => e.path === 'outlets[0].h')).toBe(true);
    }
  });

  it('类型 / 联数 / 宿主非法被拒（消费端按它们分支，未知值会渲成隐形件）', () => {
    const d = good();
    (d.outlets![0] as any).kind = 'tesla';
    (d.outlets![1] as any).n = 4;
    (d.outlets![2] as any).host = 'ceiling';
    const errs = validate(d);
    expect(errs.some((e) => e.path === 'outlets[0].kind')).toBe(true);
    expect(errs.some((e) => e.path === 'outlets[1].n')).toBe(true);
    expect(errs.some((e) => e.path === 'outlets[2].host')).toBe(true);
  });

  it('宿主相对位置非法被拒（at 负数 / side 越界 / dh 不是数）', () => {
    const d = good();
    d.outlets![0].at = -1;
    d.outlets![1].side = 7;
    (d.outlets![2] as any).dh = 'x';
    const errs = validate(d);
    expect(errs.some((e) => e.path === 'outlets[0].at')).toBe(true);
    expect(errs.some((e) => e.path === 'outlets[1].side')).toBe(true);
    expect(errs.some((e) => e.path === 'outlets[2].dh')).toBe(true);
  });

  it('重复 id 被拒', () => {
    const d = good();
    d.outlets![1].id = 'ol01';
    expect(validate(d).some((e) => e.path === 'outlets[1].id')).toBe(true);
  });

  it('outlets 不进 docToLegacy 投影（投影键集冻结）', () => {
    expect(Object.keys(docToLegacy(good()))).toEqual(['walls', 'fixed', 'doors']);
  });

  it('nextId 给插座用 ol 前缀', () => {
    const d = good();
    expect(nextId(d, 'outlet')).toBe('ol04');
    expect(nextId(blankDoc(), 'outlet')).toBe('ol01');
  });
});

/* =====================================================================
   S15：点位家族（电源 / 网络电视 / 水 / 燃气 / 风）+ 地面 / 天花安装面
   ===================================================================== */
import { POINT_KINDS, OUTLET_KINDS } from '../../src/schema/project';

describe('点位类型表（S15）', () => {
  const CATS = ['power', 'data', 'water', 'gas', 'air'];
  const HOSTS = ['wall', 'run', 'fx', 'floor', 'ceiling'];

  it('16 类，每一类的名称 / 类别 / 安装面 / 缺省高度 / 面板尺寸 / 遮挡口径都齐', () => {
    expect(OUTLET_KINDS.length).toBe(16);
    for (const k of OUTLET_KINDS) {
      const d = POINT_KINDS[k];
      expect(d, k).toBeTruthy();
      expect(d.name.length, k).toBeGreaterThan(0);
      expect(CATS, k).toContain(d.cat);
      expect(d.hosts.length, k).toBeGreaterThan(0);
      for (const h of d.hosts) expect(HOSTS, k).toContain(h);
      expect(d.h, k).toBeGreaterThanOrEqual(0);
      expect(d.plate.length, k).toBe(2);
      expect(d.plate[0] > 0 && d.plate[1] > 0, k).toBe(true);
      expect(typeof d.blocks, k).toBe('boolean');
      expect((d.gang ?? 1) >= 1, k).toBe(true);
    }
  });

  it('用户点名的每一样都在表里：同轴、网线、上水、下水、地漏、烘干机排风、送 / 回风口、油烟机排风', () => {
    for (const k of ['coax', 'lan', 'supply', 'drain', 'floorDrain', 'dryerVent', 'supplyVent', 'returnVent', 'hood'])
      expect(OUTLET_KINDS).toContain(k as never);
  });

  it('「被挡住」只对电源 / 网络 / 开关 / 送回风口成立；上下水、燃气、排风口前面站着家电是正确的摆法', () => {
    for (const k of ['std', 'usb', 'gfci', 'w240', 'switch', 'coax', 'lan', 'supplyVent', 'returnVent'])
      expect(POINT_KINDS[k as keyof typeof POINT_KINDS].blocks, k).toBe(true);
    for (const k of ['supply', 'drain', 'floorDrain', 'gas', 'dryerVent', 'hood', 'exhaust'])
      expect(POINT_KINDS[k as keyof typeof POINT_KINDS].blocks, k).toBe(false);
  });

  it('每一类装在它的第一个安装面上都通过校验（地面 h=0、天花 h=层高）', () => {
    const d = blankDoc('点位');
    d.outlets = OUTLET_KINDS.map((k, i) => {
      const def = POINT_KINDS[k];
      const host = def.hosts[0];
      const o: Record<string, unknown> = {
        id: `ol${i + 1}`,
        x: 1 + i,
        y: 1,
        rot: 0,
        kind: k,
        src: 'user',
        host,
      };
      o.h = host === 'floor' ? 0 : host === 'ceiling' ? d.ceilingH : def.h / 30.48;
      if (host === 'wall') Object.assign(o, { hostId: 'w01', at: 1, side: 1 });
      return o as never;
    });
    expect(validate(d)).toEqual([]);
  });

  it('装在它不允许的安装面上被拒（上水不能装地上、地漏不能装墙上、开关不能装天花）', () => {
    const d = blankDoc('点位');
    d.outlets = [
      { id: 'ol01', x: 1, y: 1, rot: 0, h: 0, kind: 'supply', host: 'floor' },
      {
        id: 'ol02',
        x: 2,
        y: 1,
        rot: 0,
        h: 1,
        kind: 'floorDrain',
        host: 'wall',
        hostId: 'w01',
        at: 1,
        side: 1,
      },
      {
        id: 'ol03',
        x: 3,
        y: 1,
        rot: 0,
        h: 8.8,
        kind: 'switch',
        host: 'ceiling',
      },
    ] as never;
    const errs = validate(d);
    for (const i of [0, 1, 2])
      expect(
        errs.some((e) => e.path === `outlets[${i}].host`),
        `outlets[${i}]`
      ).toBe(true);
  });

  it('地面安装面允许 h=0；墙面安装面 h=0 仍然拒（墙上的面板不能埋进地里）', () => {
    const d = blankDoc('点位');
    d.outlets = [
      {
        id: 'ol01',
        x: 1,
        y: 1,
        rot: 0,
        h: 0,
        kind: 'supplyVent',
        host: 'floor',
      },
      {
        id: 'ol02',
        x: 2,
        y: 1,
        rot: 0,
        h: 0,
        kind: 'std',
        host: 'wall',
        hostId: 'w01',
        at: 1,
        side: 1,
      },
    ] as never;
    const errs = validate(d);
    expect(errs.some((e) => e.path === 'outlets[0].h')).toBe(false);
    expect(errs.some((e) => e.path === 'outlets[1].h')).toBe(true);
  });

  it('联数超过这一类的上限被拒（网线口最多 2 联、上水只有 1）', () => {
    const d = blankDoc('点位');
    d.outlets = [
      {
        id: 'ol01',
        x: 1,
        y: 1,
        rot: 0,
        h: 1,
        kind: 'lan',
        n: 3,
        host: 'wall',
        hostId: 'w01',
        at: 1,
        side: 1,
      },
      {
        id: 'ol02',
        x: 2,
        y: 1,
        rot: 0,
        h: 3.6,
        kind: 'supply',
        n: 2,
        host: 'wall',
        hostId: 'w01',
        at: 2,
        side: 1,
      },
      {
        id: 'ol03',
        x: 3,
        y: 1,
        rot: 0,
        h: 1,
        kind: 'std',
        n: 3,
        host: 'wall',
        hostId: 'w01',
        at: 3,
        side: 1,
      },
    ] as never;
    const errs = validate(d);
    expect(errs.some((e) => e.path === 'outlets[0].n')).toBe(true);
    expect(errs.some((e) => e.path === 'outlets[1].n')).toBe(true);
    expect(errs.some((e) => e.path === 'outlets[2].n')).toBe(false);
  });

  it('JSON Schema 的枚举与类型表同步（16 类 · 5 种安装面）', () => {
    const s = projectSchema() as Record<string, any>;
    expect([...s.definitions.outlet.properties.kind.enum].sort()).toEqual([...OUTLET_KINDS].sort());
    expect([...s.definitions.outlet.properties.host.enum].sort()).toEqual([...HOSTS].sort());
  });
});

/* =====================================================================
   S16：房间轮廓与地板（rooms[].poly / rooms[].floor / 整层 floorMat）
   ===================================================================== */
describe('房间与地板（S16）', () => {
  const good = () => {
    const d = blankDoc('地板');
    d.rooms = [
      {
        id: 'r01',
        label: '客厅',
        pos: [5, 4],
        poly: [
          [0.2, 0.2],
          [11.8, 0.2],
          [11.8, 9.8],
          [0.2, 9.8],
        ],
        floor: { mat: 'oakHerring', angle: 45 },
        src: 'user',
      },
      {
        id: 'r02',
        label: '',
        pos: [15, 4],
        poly: [
          [12.2, 0.2],
          [19.8, 0.2],
          [19.8, 9.8],
        ],
        floor: { mat: 'tileWhite60' },
      },
    ] as never;
    d.floorMat = 'oakNatural';
    return d;
  };

  it('合法的房间轮廓 + 地板 + 整层缺省地板通过校验，JSON 往返逐字段相等', () => {
    const d = good();
    expect(validate(d)).toEqual([]);
    const round = JSON.parse(JSON.stringify(d));
    expect(validate(round)).toEqual([]);
    expect(round).toEqual(d);
  });

  it('全是纯增量可选字段：旧文档没有它们照样合法；JSON Schema 里有定义、不在 required', () => {
    const s = projectSchema() as Record<string, any>;
    expect(s.properties.floorMat).toBeTruthy();
    expect(s.definitions.room.properties.poly).toBeTruthy();
    expect(s.definitions.room.properties.floor).toBeTruthy();
    expect(s.required).not.toContain('floorMat');
    expect(validate(blankDoc())).toEqual([]);
  });

  it('轮廓少于 3 点 / 点不是 [x, y] 被拒', () => {
    const d = good();
    (d.rooms[0] as any).poly = [
      [0, 0],
      [1, 1],
    ];
    (d.rooms[1] as any).poly = [
      [0, 0],
      [1, 'x'],
      [2, 2],
    ];
    const errs = validate(d);
    expect(errs.some((e) => e.path === 'rooms[0].poly')).toBe(true);
    expect(errs.some((e) => e.path === 'rooms[1].poly[1]')).toBe(true);
  });

  it('地板：mat 必须是 1–40 字符的文本、angle 必须是数；整层 floorMat 同样', () => {
    const d = good();
    (d.rooms[0] as any).floor = { mat: '' };
    (d.rooms[1] as any).floor = { mat: 'x', angle: 'a' };
    (d as any).floorMat = 3;
    const errs = validate(d);
    expect(errs.some((e) => e.path === 'rooms[0].floor.mat')).toBe(true);
    expect(errs.some((e) => e.path === 'rooms[1].floor.angle')).toBe(true);
    expect(errs.some((e) => e.path === 'floorMat')).toBe(true);
  });

  it('rooms 的轮廓与地板不进 docToLegacy 投影（投影键集冻结）', () => {
    expect(Object.keys(docToLegacy(good()))).toEqual(['walls', 'fixed', 'doors']);
  });
});

/* =====================================================================
   S21：窗帘（windows[].curtain）与墙色（rooms[].wallColor）
   ===================================================================== */
describe('窗帘与墙色（S21）', () => {
  const win = (curtain?: unknown) => ({
    id: 'n1',
    geom: seg(4),
    wallId: null,
    pos: 0.5,
    width: 4,
    sill: 2.2,
    head: 7.4,
    style: 'fixed' as const,
    frame: '#111',
    glass: 0.2,
    ...(curtain === undefined ? {} : { curtain: curtain as never }),
  });
  const docWith = (curtain?: unknown, wallColor?: unknown) => {
    const d = blankDoc('窗帘');
    d.windows.push(win(curtain));
    d.rooms = [
      {
        id: 'r01',
        label: '卧室',
        pos: [2, 2],
        poly: [
          [0, 0.2],
          [4, 0.2],
          [4, 4],
          [0, 4],
        ],
        ...(wallColor === undefined ? {} : { wallColor: wallColor as never }),
      },
    ] as never;
    return d;
  };

  it('四种款式 + 颜色 + 可选的挂向通过校验，JSON 往返逐字段相等；墙色 #rgb / #rrggbb 都收', () => {
    for (const style of ['drape', 'sheer', 'drapeSheer', 'roller']) {
      const d = docWith({ style, color: '#c9b79c', side: -1 }, '#e8dfd0');
      expect(validate(d)).toEqual([]);
      const round = JSON.parse(JSON.stringify(d));
      expect(validate(round)).toEqual([]);
      expect(round).toEqual(d);
    }
    expect(validate(docWith({ style: 'drape', color: '#abc' }, '#fff'))).toEqual([]);
  });

  it('纯增量可选字段：旧文档没有它们照样合法；JSON Schema 里有定义、不在 required', () => {
    expect(validate(docWith())).toEqual([]);
    const s = projectSchema() as Record<string, any>;
    expect(s.definitions.window.properties.curtain.properties.style.enum).toEqual([
      'drape',
      'sheer',
      'drapeSheer',
      'roller',
    ]);
    expect(s.definitions.window.required).not.toContain('curtain');
    expect(s.definitions.room.properties.wallColor).toBeTruthy();
    expect(s.definitions.room.required || []).not.toContain('wallColor');
  });

  it('款式 / 颜色 / 挂向非法被拒，路径指到具体字段', () => {
    const paths = (d: ProjectDoc) => validate(d).map((e) => e.path);
    expect(paths(docWith({ style: 'blinds', color: '#fff' }))).toContain('windows[0].curtain.style');
    expect(paths(docWith({ style: 'drape', color: 'beige' }))).toContain('windows[0].curtain.color');
    expect(paths(docWith({ style: 'drape', color: '#fff', side: 0 }))).toContain('windows[0].curtain.side');
    expect(paths(docWith(null))).toContain('windows[0].curtain');
    expect(paths(docWith(undefined, 'white'))).toContain('rooms[0].wallColor');
    expect(paths(docWith(undefined, '#12345'))).toContain('rooms[0].wallColor');
  });

  it('窗帘与墙色不进 docToLegacy 投影（投影键集冻结）', () => {
    expect(Object.keys(docToLegacy(docWith({ style: 'drape', color: '#fff' }, '#eee')))).toEqual([
      'walls',
      'fixed',
      'doors',
    ]);
  });
});

import { dropDanglingWallRefs } from '../../src/schema/project';
describe('dropDanglingWallRefs（S22a #91：门窗的 wallId 指着已经删掉的墙）', () => {
  const win = (id: string, wallId: string | null) =>
    ({
      id,
      geom: seg(8),
      wallId,
      pos: 0.5,
      width: 1,
      sill: 2,
      head: 7,
      style: 'fixed',
      frame: '#000',
      glass: 0.2,
    }) as never;
  const door = (id: string, wallId: string | null) =>
    ({ id, geom: seg(10), wallId, pos: 0.5, width: 3, kind: 'swing' }) as never;

  it('悬空的置空、还在的留着；返回改了几处；改完过 validate', () => {
    const doc = blankDoc();
    doc.walls.push({ id: 'w01', kind: 'wall', geom: seg() });
    doc.windows.push(win('n01', 'w01'), win('n02', 'w09'));
    doc.doors.push(door('d01', 'w08'), door('d02', null));
    expect(validate(doc).map((e) => e.path)).toEqual(['windows[1].wallId', 'doors[0].wallId']);
    expect(dropDanglingWallRefs(doc)).toBe(2);
    expect(doc.windows.map((w) => w.wallId)).toEqual(['w01', null]);
    expect(doc.doors.map((d) => d.wallId)).toEqual([null, null]);
    expect(validate(doc)).toEqual([]);
    expect(dropDanglingWallRefs(doc)).toBe(0); // 幂等
  });

  it('逐层：其余层按它自己的 walls 判；当前层的外壳（没有内容）不动', () => {
    const doc = blankDoc() as ProjectDoc & { levels: unknown[]; level: string };
    doc.walls.push({ id: 'w01', kind: 'wall', geom: seg() });
    doc.windows.push(win('n01', 'w01'));
    doc.levels = [
      { id: 'L1', name: '一层', elev: 0 },
      {
        id: 'L2',
        name: '二层',
        elev: 9,
        walls: [{ id: 'w05', kind: 'wall', geom: seg() }],
        windows: [win('n05', 'w01')],
        doors: [door('d05', 'w05')],
      },
    ];
    doc.level = 'L1';
    expect(dropDanglingWallRefs(doc)).toBe(1);
    const l2 = doc.levels[1] as { windows: Array<{ wallId: unknown }>; doors: Array<{ wallId: unknown }> };
    expect(l2.windows[0].wallId).toBe(null); // 二层的窗指着一层的墙：在它那一层里是悬空的
    expect(l2.doors[0].wallId).toBe('w05');
    expect(doc.windows[0].wallId).toBe('w01');
  });

  it('非对象 / 缺数组不炸', () => {
    expect(dropDanglingWallRefs(null)).toBe(0);
    expect(dropDanglingWallRefs({})).toBe(0);
    expect(dropDanglingWallRefs({ windows: [null, 3, { wallId: 'w1' }] })).toBe(1);
  });
});

import { WINDOW_STYLES } from '../../src/schema/project';
describe('S22b 窗的款式与外观（提拉 / 内开内倒 / 推拉扇数 / 开启侧 / 磨砂）', () => {
  const docWin = (extra: Record<string, unknown>) => {
    const doc = blankDoc();
    doc.windows.push({
      id: 'n01',
      geom: seg(4),
      wallId: null,
      pos: 0.5,
      width: 4,
      sill: 2.2,
      head: 7.4,
      style: 'fixed',
      frame: '#f2f1ec',
      glass: 0.18,
      ...extra,
    } as never);
    return doc;
  };
  const paths = (d: ProjectDoc) => validate(d).map((e) => e.path);

  it('新款式与可选字段合法', () => {
    expect(WINDOW_STYLES).toEqual(['fixed', 'slide', 'casement', 'awning', 'hung', 'tilt']);
    expect(validate(docWin({ style: 'hung' }))).toEqual([]);
    expect(validate(docWin({ style: 'tilt', hand: 'r' }))).toEqual([]);
    expect(validate(docWin({ style: 'slide', panes: 3 }))).toEqual([]);
    expect(validate(docWin({ style: 'casement', hand: 'pair', frost: true }))).toEqual([]);
  });

  it('非法值被拒，路径指到具体字段', () => {
    expect(paths(docWin({ style: 'bay' }))).toContain('windows[0].style');
    expect(paths(docWin({ style: 'slide', panes: 5 }))).toContain('windows[0].panes');
    expect(paths(docWin({ style: 'casement', hand: 'left' }))).toContain('windows[0].hand');
    expect(paths(docWin({ style: 'tilt', hand: 'pair' }))).toContain('windows[0].hand');
    expect(paths(docWin({ frost: 'yes' }))).toContain('windows[0].frost');
  });

  it('JSON Schema 跟着带上；不进 docToLegacy 投影', () => {
    const s = projectSchema() as Record<string, any>;
    expect(s.definitions.window.properties.style.enum).toEqual(WINDOW_STYLES);
    expect(s.definitions.window.properties.panes.enum).toEqual([2, 3, 4]);
    expect(s.definitions.window.properties.hand.enum).toEqual(['l', 'r', 'pair']);
    expect(s.definitions.window.properties.frost.type).toBe('boolean');
    expect(s.definitions.window.required).not.toContain('panes');
    const proj = docToLegacy(docWin({ style: 'slide', panes: 4, frost: true }));
    expect(Object.keys(proj)).toEqual(['walls', 'fixed', 'doors']);
  });
});

/* ---- S27b：踢脚线 / 天花 / 墙裙 / 地面铺法（全部可选；旧档没有这些字段照样过） ---- */
describe('validate — S27b 房间收边', () => {
  const room = (extra: Record<string, unknown>) => {
    const d = blankDoc('t');
    d.rooms = [{ id: 'r1', label: '卧室', pos: [1, 1], ...extra } as never];
    return d;
  };
  it('合法：踢脚线（关键字色 / #hex）、天花（wall / #hex）、墙裙、铺法', () => {
    expect(validate(room({ base: { c: 'white', h: 8, st: 'flat' } }))).toEqual([]);
    expect(validate(room({ base: { c: '#3a3a3a', h: 12, st: 'profile' } }))).toEqual([]);
    expect(validate(room({ ceil: 'wall' }))).toEqual([]);
    expect(validate(room({ ceil: '#f4f2ee' }))).toEqual([]);
    expect(validate(room({ wains: { st: 'bead', h: 90, c: '#efe9df' } }))).toEqual([]);
    expect(validate(room({ floor: { mat: 'oakBond', lay: 's' } }))).toEqual([]);
  });
  it('非法值逐项被拒（路径指到那个字段）', () => {
    const paths = (d: ReturnType<typeof room>) => validate(d).map((e) => e.path);
    expect(paths(room({ base: { c: 'pink', h: 8 } }))).toContain('rooms[0].base.c');
    expect(paths(room({ base: { c: 'white', h: 80 } }))).toContain('rooms[0].base.h');
    expect(paths(room({ base: { c: 'white', h: 8, st: 'ogee' } }))).toContain('rooms[0].base.st');
    expect(paths(room({ ceil: 'blue' }))).toContain('rooms[0].ceil');
    expect(paths(room({ wains: { st: 'stone', h: 90, c: '#ffffff' } }))).toContain('rooms[0].wains.st');
    expect(paths(room({ wains: { st: 'panel', h: 10, c: '#ffffff' } }))).toContain('rooms[0].wains.h');
    expect(paths(room({ floor: { mat: 'oakBond', lay: 'b4' } }))).toContain('rooms[0].floor.lay');
  });
});
