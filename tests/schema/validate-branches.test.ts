/* =====================================================================
   validate() / checkGeoms() 的分支覆盖：导入闸门与载入闸门的每一条拒绝路径
   背景：validate 是「导入的文档能不能进界面」的唯一闸门（AGENTS §7），
   以前只测了顶层字段，runs.modules / baseImage / plan.* 这些分支一条没测过。
   ===================================================================== */
import { describe, it, expect } from 'vitest';
import { validate, checkGeoms, blankDoc, type ProjectDoc } from '../../src/schema/project';

const bad = (patch: (d: ProjectDoc) => void): ProjectDoc => {
  const d = blankDoc();
  patch(d);
  return d;
};
const paths = (d: ProjectDoc) => validate(d).map((e) => e.path);
const msgs = (d: ProjectDoc) => validate(d).map((e) => `${e.path}: ${e.message}`);

describe('validate —— 实体通用检查（checkEntities）', () => {
  it('类别不是数组 / 成员不是对象 / id 空 → 都报出来', () => {
    expect(paths(bad((d) => ((d as unknown as Record<string, unknown>).walls = '不是数组' as never)))).toContain(
      'walls'
    );
    expect(
      paths(
        bad((d) => {
          d.walls.push('不是对象' as never);
        })
      )
    ).toContain('walls[0]');
    expect(
      paths(
        bad((d) => {
          d.walls.push({ id: '', kind: 'wall', geom: { t: 'seg', x1: 0, y1: 0, x2: 1, y2: 0 } });
        })
      )
    ).toContain('walls[0].id');
  });

  it('同一个 id 用两次 → 报（id 是存档的唯一寻址方式）', () => {
    const dup = bad((d) => {
      const g = { t: 'seg', x1: 0, y1: 0, x2: 1, y2: 0 } as const;
      d.walls.push({ id: 'w01', kind: 'wall', geom: g });
      d.walls.push({ id: 'w01', kind: 'wall', geom: g });
    });
    expect(msgs(dup).some((m) => m.includes('walls[1].id') && m.includes('重复 id'))).toBe(true);
  });

  it('geom 不是对象 → 报（checkGeoms 之前 validate 先把结构挡住）', () => {
    expect(
      paths(
        bad((d) => {
          d.walls.push({ id: 'w01', kind: 'wall', geom: '线段' as never });
        })
      )
    ).toContain('walls[0].geom');
  });
});

describe('validate —— 台面柜体带（runs，S12）', () => {
  const runDoc = (mut: (r: Record<string, unknown>) => void) =>
    bad((d) => {
      const r: Record<string, unknown> = {
        id: 'r01',
        path: [
          [0, 0],
          [3, 0],
        ],
        depth: 0.6,
        topH: 3.0,
      };
      mut(r);
      (d as unknown as Record<string, unknown>).runs = [r];
    });

  it('合法的一组必须过（先确认基线，否则下面的断言什么都不证明）', () => {
    expect(paths(runDoc(() => {}))).toEqual([]);
  });

  it('path 少于 2 个点 / 点不是 [x, y] → 拒', () => {
    expect(paths(runDoc((r) => (r.path = [[0, 0]])))).toContain('runs[0].path');
    expect(
      paths(
        runDoc(
          (r) =>
            (r.path = [
              { x: 0, y: 0 },
              { x: 3, y: 0 },
            ])
        )
      )
    ).toContain('runs[0].path[0]');
  });

  it('depth / topH / h 必须是正数；depth 上限 4ft、topH 上限 8ft（米值混进来就是 3.3 倍错）', () => {
    expect(paths(runDoc((r) => (r.depth = 0)))).toContain('runs[0].depth');
    expect(paths(runDoc((r) => (r.depth = 9)))).toContain('runs[0].depth');
    expect(paths(runDoc((r) => (r.topH = 12)))).toContain('runs[0].topH');
    expect(paths(runDoc((r) => (r.h = -1)))).toContain('runs[0].h');
  });

  it('modules：不是数组 / 成员不是对象 / at<0 / type 非法 / w≤0', () => {
    expect(paths(runDoc((r) => (r.modules = 'x')))).toContain('runs[0].modules');
    expect(paths(runDoc((r) => (r.modules = ['x'])))).toContain('runs[0].modules[0]');
    expect(paths(runDoc((r) => (r.modules = [{ at: -1, type: 'sink' }])))).toContain('runs[0].modules[0].at');
    expect(paths(runDoc((r) => (r.modules = [{ at: 0.5, type: '洗碗机' }])))).toContain('runs[0].modules[0].type');
    expect(paths(runDoc((r) => (r.modules = [{ at: 0.5, type: 'sink', w: 0 }])))).toContain('runs[0].modules[0].w');
    expect(
      paths(
        runDoc(
          (r) =>
            (r.modules = [
              { at: 0.4, type: 'sink', w: 0.6 },
              { at: 2.0, type: 'cooktop' },
            ])
        )
      )
    ).toEqual([]);
  });
});

describe('validate —— 日夜环境（env）', () => {
  it('preset 必须是字符串、mode 只认 day|night', () => {
    expect(paths(bad((d) => ((d as unknown as Record<string, unknown>).env = { mode: '黄昏' } as never)))).toContain(
      'env.mode'
    );
    expect(
      paths(bad((d) => ((d as unknown as Record<string, unknown>).env = { preset: 12, mode: 'day' } as never)))
    ).toContain('env.preset');
    expect(paths(bad((d) => ((d as unknown as Record<string, unknown>).env = '白天' as never)))).toContain('env');
    expect(validate(Object.assign(blankDoc(), { env: { preset: 'seattle-city', mode: 'night' } }))).toEqual([]);
  });
});

describe('validate —— 用户底图（baseImage，S7）', () => {
  const biDoc = (mut: (b: Record<string, unknown>) => void) =>
    bad((d) => {
      const b: Record<string, unknown> = {
        data: 'data:image/png;base64,0123456789abcdef',
        w: 64,
        h: 64,
        mPerPx: 0.01,
        ox: 0,
        oy: 0,
      };
      mut(b);
      (d as unknown as Record<string, unknown>).baseImage = b;
    });

  it('合法的一组必须过', () => {
    expect(paths(biDoc(() => {}))).toEqual([]);
  });

  it('每个字段都有下界：太小 / 非数 / 非法旋转一律拒', () => {
    expect(paths(biDoc((b) => (b.data = 'too short')))).toContain('baseImage.data');
    expect(paths(biDoc((b) => (b.w = 4)))).toContain('baseImage.w');
    expect(paths(biDoc((b) => (b.h = 0)))).toContain('baseImage.h');
    expect(paths(biDoc((b) => (b.mPerPx = 0)))).toContain('baseImage.mPerPx');
    expect(paths(biDoc((b) => (b.ox = '左下' as never)))).toContain('baseImage.ox');
    expect(paths(biDoc((b) => (b.rot = 45)))).toContain('baseImage.rot');
    expect(paths(biDoc((b) => (b.rot = 90)))).toEqual([]);
    expect(paths(bad((d) => ((d as unknown as Record<string, unknown>).baseImage = '不是对象' as never)))).toContain(
      'baseImage'
    );
  });
});

describe('validate —— 户型专属快照（plan.*，S11b）', () => {
  const planDoc = (mut: (p: Record<string, unknown>) => void) =>
    bad((d) => {
      const p: Record<string, unknown> = {};
      mut(p);
      (d as unknown as Record<string, unknown>).plan = p;
    });

  it('windowBand / calib / refPhoto / islLabel', () => {
    expect(paths(planDoc((p) => (p.windowBand = [[1, 2], [3]])))).toContain('plan.windowBand[1]');
    expect(paths(planDoc((p) => (p.calib = '不是对象' as never)))).toContain('plan.calib');
    expect(paths(planDoc((p) => (p.calib = { img: 'x', w: 0, h: 10 })))).toEqual(['plan.calib.w']);
    expect(paths(planDoc((p) => (p.calib = { img: 7 as never, w: 591, h: 480 })))).toContain('plan.calib.img');
    expect(paths(planDoc((p) => (p.refPhoto = 123 as never)))).toContain('plan.refPhoto');
    expect(paths(planDoc((p) => (p.islLabel = '标签' as never)))).toContain('plan.islLabel');
    expect(paths(planDoc((p) => (p.islLabel = { p: [1], w: 1, d: 1, calib: 'x' })))).toContain('plan.islLabel.p');
  });

  it('isl / fx / inner 的每一条拒绝路径', () => {
    expect(
      paths(planDoc((p) => (p.isl = { a: [1], b: [2, 3], e: [4, 5], cp2: [6, 7], d: [8, 9] } as never)))
    ).toContain('plan.isl.a');
    // PlanExtras 里没有 fx：洁具走 DOC.fixtures（S1 迁移），不在户型快照里 —— 别以为这里该校验它
    expect(paths(planDoc((p) => (p.fx = '不是数组' as never)))).toEqual([]);
    expect(paths(planDoc((p) => (p.inner = '不是数组' as never)))).toContain('plan.inner');
    expect(paths(planDoc((p) => (p.inner = ['不是对象'])))).toContain('plan.inner[0]');
    expect(paths(planDoc((p) => (p.inner = [{ x1: 0, y1: 0, x2: 'x', y2: 1 }])))).toContain('plan.inner[0].x2');
    expect(paths(planDoc((p) => (p.inner = [{ x1: 0, y1: 0, x2: 1, y2: 1, wd: '厚' as never }])))).toContain(
      'plan.inner[0].wd'
    );
    expect(paths(planDoc((p) => (p.kitchen = '不是数组' as never)))).toContain('plan.kitchen');
    expect(paths(planDoc((p) => (p.kitchen = ['不是对象'])))).toContain('plan.kitchen[0]');
  });

  it('厨房构件：材质档 / box / cyl / seg / p 逐条验', () => {
    const k = (mut: (e: Record<string, unknown>) => void) =>
      planDoc((p) => {
        const e: Record<string, unknown> = { m: 'cab', p: [1, 2, 3], box: [1, 1, 1] };
        mut(e);
        p.kitchen = [e];
      });
    expect(paths(k(() => {}))).toEqual([]);
    expect(paths(k((e) => (e.m = '塑料')))).toContain('plan.kitchen[0].m');
    expect(
      paths(
        k((e) => {
          delete e.box;
        })
      )
    ).toContain('plan.kitchen[0]');
    expect(paths(k((e) => (e.box = [1, 1])))).toContain('plan.kitchen[0].box');
    expect(
      paths(
        k((e) => {
          e.box = undefined;
          e.cyl = [0.2, '长'];
        })
      )
    ).toContain('plan.kitchen[0].cyl');
    expect(paths(k((e) => (e.seg = 2)))).toContain('plan.kitchen[0].seg');
    expect(paths(k((e) => (e.p = [1, 2])))).toContain('plan.kitchen[0].p');
    expect(
      paths(
        k((e) => {
          e.cyl = [0.2, 1.4];
          delete e.box;
        })
      )
    ).toEqual([]);
  });
});

describe('checkGeoms —— 几何形状（validate 只看 geom 是不是对象）', () => {
  it('合法文档必须过（先确认基线）', () => {
    const d = blankDoc();
    d.walls.push({ id: 'w01', kind: 'wall', geom: { t: 'seg', x1: 0, y1: 0, x2: 3, y2: 0 } });
    expect(checkGeoms(d)).toEqual([]);
  });

  it('patio.geom 坏 → 拒（阳台会渲成隐形构件）', () => {
    const d = blankDoc();
    (d as unknown as Record<string, unknown>).patio = {
      geom: {
        t: 'poly',
        pts: [
          [0, 0],
          [1, NaN],
        ],
      },
    };
    expect(checkGeoms(d).map((e) => e.path)).toContain('patio.geom.pts[1]');
  });

  it('poly 点数 < 2 / 点不是数字对 → 拒', () => {
    const d = blankDoc();
    d.solids.push({ id: 's01', geom: { t: 'poly', pts: [[0, 0]] }, fill: '#8a919c' });
    expect(checkGeoms(d).map((e) => e.path)).toContain('solids[0].geom.pts');
    const d2 = blankDoc();
    d2.solids.push({
      id: 's01',
      geom: {
        t: 'poly',
        pts: [
          [0, 0],
          ['x', 1],
          [2, 2],
        ],
      } as never,
      fill: '#8a919c',
    });
    expect(checkGeoms(d2).map((e) => e.path)).toContain('solids[0].geom.pts[1]');
  });

  it('arc：坐标/角度必须是有限数、半径 > 0、dir 只能是 ±1', () => {
    const mk = (over: Record<string, unknown>) => {
      const d = blankDoc();
      d.solids.push({
        id: 's01',
        geom: { t: 'arc', cx: 0, cy: 0, r: 1, a0: 0, a1: Math.PI, dir: 1, ...over } as never,
        fill: '#8a919c',
      });
      return checkGeoms(d).map((e) => e.path);
    };
    expect(mk({ dir: 0 })).toContain('solids[0].geom.dir');
    expect(mk({ r: -1 })).toContain('solids[0].geom.r');
    expect(mk({ a0: NaN })).toContain('solids[0].geom.a0');
    expect(mk({ cx: '中' })).toContain('solids[0].geom.cx');
  });

  it('seg 少一个 x2 / 坐标 NaN → 拒（expand 出 NaN，整根墙消失）', () => {
    const mk = (over: Record<string, unknown>) => {
      const d = blankDoc();
      d.walls.push({ id: 'w01', kind: 'wall', geom: { t: 'seg', x1: 0, y1: 0, x2: 1, y2: 0, ...over } });
      return checkGeoms(d).map((e) => e.path);
    };
    expect(mk({ x2: undefined })).toContain('walls[0].geom.x2');
    expect(mk({ y2: NaN })).toContain('walls[0].geom.y2');
  });

  it('geom.t 不是 seg|arc|poly → 拒（expand 返回空数组，实体凭空消失）', () => {
    const d = blankDoc();
    d.walls.push({ id: 'w01', kind: 'wall', geom: { t: 'circle' } as never });
    expect(checkGeoms(d).map((e) => e.path)).toContain('walls[0].geom.t');
  });

  it('geom 必填', () => {
    const d = blankDoc();
    d.windows.push({ id: 'w01', kind: 'window', geom: undefined } as never);
    expect(checkGeoms(d).map((e) => e.path)).toContain('windows[0].geom');
  });
});
