/* S17（ADR-0007）：楼层 = 一份户型文档里的若干楼层；当前层的内容换进文档顶层。
   这里钉住纯函数层：启用 / 切层（往返逐字节）/ 加层（上 / 下、复制外墙）/ 删层 / 标高重排 / 逐层遍历 / 校验。 */
import { describe, it, expect } from 'vitest';
import { blankDoc, validate, type ProjectDoc } from '../../src/schema/project';
import {
  LEVEL_KEYS,
  SLAB_DEFAULT,
  enableLevels,
  hasLevels,
  activateLevel,
  addLevel,
  removeLevel,
  setLevelCeiling,
  sortedLevels,
  forEachLevel,
  levelContentOf,
  activeLevel,
  levelCeil,
  translateLevelContent,
  levelBBox,
  addLevelFromDoc,
} from '../../src/schema/levels';

const seg = (x1: number, y1: number, x2: number, y2: number) => ({ t: 'seg' as const, x1, y1, x2, y2 });
const house = () => {
  const d = blankDoc('两层的房子');
  d.walls = [
    { id: 'w01', kind: 'wall', geom: seg(0, 0, 20, 0) },
    { id: 'w02', kind: 'wall', geom: seg(20, 0, 20, 14) },
    { id: 'w03', kind: 'wall', geom: seg(20, 14, 0, 14) },
    { id: 'w04', kind: 'wall', geom: seg(0, 14, 0, 0) },
    { id: 'w05', kind: 'wall', geom: seg(10, 0, 10, 14) },
  ] as never;
  d.outlets = [
    { id: 'ol01', x: 1, y: 1, rot: 0, h: 1, kind: 'std', host: 'wall', hostId: 'w01', at: 1, side: 1 },
  ] as never;
  d.floorMat = 'oakNatural';
  return d;
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('启用楼层', () => {
  it('没有 levels 的文档 = 单层；启用后原内容就是 lv1（标高 0），顶层内容一个字节不动', () => {
    const d = house();
    expect(hasLevels(d)).toBe(false);
    const before = JSON.stringify({ walls: d.walls, outlets: d.outlets, floorMat: d.floorMat });
    enableLevels(d, '一层');
    expect(hasLevels(d)).toBe(true);
    expect(d.level).toBe('lv1');
    expect(d.levels).toEqual([{ id: 'lv1', name: '一层', elev: 0 }]);
    expect(JSON.stringify({ walls: d.walls, outlets: d.outlets, floorMat: d.floorMat })).toBe(before);
    expect(validate(d)).toEqual([]);
  });

  it('重复启用是空操作', () => {
    const d = enableLevels(house());
    const s = JSON.stringify(d);
    enableLevels(d);
    expect(JSON.stringify(d)).toBe(s);
  });
});

describe('加层 / 切层', () => {
  it('往上加一层：标高 = 下层标高 + 下层层高 + 楼板厚；新层是空的（不带下层的点位 / 房间）', () => {
    const d = house();
    d.ceilingH = 9;
    const up = addLevel(d, { where: 'above', name: '二层' });
    expect(up.elev).toBeCloseTo(9 + SLAB_DEFAULT, 9);
    expect(sortedLevels(d).map((l) => l.id)).toEqual(['lv1', up.id]);
    const c = levelContentOf(d, up.id)!;
    expect(c.walls).toEqual([]);
    expect(c.outlets).toEqual([]);
    expect(c.ceilingH).toBe(9);
    expect(d.level).toBe('lv1'); // 加层不切层
  });

  it('往上加一层可以带上窗（复制件）：楼上楼下常是同一列窗', () => {
    const d = house();
    const win = {
      id: 'g01',
      geom: seg(4, 0, 8, 0),
      wallId: 'w01',
      pos: 0.3,
      width: 4,
      sill: 2.2,
      head: 7.4,
      style: 'slide',
      frame: '#1b1d20',
      glass: 0.18,
      src: 'user',
    } as never;
    const up = addLevel(d, { where: 'above', walls: d.walls.slice(0, 4), windows: [win] });
    expect(up.windows!.length).toBe(1);
    expect(up.windows![0]).not.toBe(win);
    activateLevel(d, up.id);
    expect(d.windows.length).toBe(1);
    expect(validate(d)).toEqual([]);
  });

  it('往下加（地下室）：标高为负；可以带上外墙（复制件，改动不回到原层）', () => {
    const d = house();
    const shell = d.walls.slice(0, 4);
    const b = addLevel(d, { where: 'below', name: '地下室', ceilingH: 7.5, walls: shell });
    expect(b.elev).toBeCloseTo(-(7.5 + SLAB_DEFAULT), 9);
    const c = levelContentOf(d, b.id)!;
    expect(c.walls!.length).toBe(4);
    (c.walls![0].geom as { x1: number }).x1 = 99;
    expect((d.walls[0].geom as { x1: number }).x1).toBe(0);
  });

  it('切层往返：切到二层再切回来，一层的内容逐字节不变；二层画的墙留在二层', () => {
    const d = house();
    const lv1 = clone(Object.fromEntries(LEVEL_KEYS.filter((k) => k in d).map((k) => [k, (d as never)[k]])));
    const up = addLevel(d, { where: 'above' });
    expect(activateLevel(d, up.id)).toBe(true);
    expect(d.level).toBe(up.id);
    expect(d.walls).toEqual([]);
    expect(d.floorMat).toBeUndefined();
    d.walls.push({ id: 'w01', kind: 'wall', geom: seg(2, 2, 8, 2) } as never);
    expect(activateLevel(d, 'lv1')).toBe(true);
    const back = Object.fromEntries(LEVEL_KEYS.filter((k) => k in d).map((k) => [k, (d as never)[k]]));
    expect(JSON.stringify(back)).toBe(JSON.stringify(lv1));
    expect(levelContentOf(d, up.id)!.walls!.length).toBe(1);
    expect(validate(d)).toEqual([]);
  });

  it('切到不存在的层 / 当前层 → false，文档不动', () => {
    const d = house();
    addLevel(d, { where: 'above' });
    const s = JSON.stringify(d);
    expect(activateLevel(d, 'nope')).toBe(false);
    expect(activateLevel(d, 'lv1')).toBe(false);
    expect(JSON.stringify(d)).toBe(s);
  });

  it('JSON 往返后照样能切层（存档 / 导出就是这个形态）', () => {
    const d = house();
    const up = addLevel(d, { where: 'above' });
    activateLevel(d, up.id);
    const r = clone(d);
    expect(validate(r)).toEqual([]);
    expect(activateLevel(r, 'lv1')).toBe(true);
    expect(r.walls.length).toBe(5);
  });
});

describe('删层 / 层高 / 遍历', () => {
  it('只剩一层时不能删；删当前层先切到相邻层；删完重排标高（上面的层落下来）', () => {
    const d = house();
    d.ceilingH = 9;
    expect(removeLevel(d, 'lv1').ok).toBe(false);
    const l2 = addLevel(d, { where: 'above', name: '二层' });
    const l3 = addLevel(d, { where: 'above', name: '三层' });
    expect(l3.elev).toBeCloseTo(2 * (9 + SLAB_DEFAULT), 9);
    activateLevel(d, l2.id);
    const r = removeLevel(d, l2.id);
    expect(r.ok).toBe(true);
    expect(d.levels!.some((l) => l.id === l2.id)).toBe(false);
    expect(d.level === 'lv1' || d.level === l3.id).toBe(true);
    expect(sortedLevels(d).find((l) => l.id === l3.id)!.elev).toBeCloseTo(9 + SLAB_DEFAULT, 9);
    expect(validate(d)).toEqual([]);
  });

  it('改一层的层高：它上面的层整体抬高同样的量；地面层标高仍是 0', () => {
    const d = house();
    d.ceilingH = 9;
    const l2 = addLevel(d, { where: 'above' });
    const l3 = addLevel(d, { where: 'above' });
    setLevelCeiling(d, 'lv1', 10);
    expect(d.ceilingH).toBe(10);
    const lv = sortedLevels(d);
    expect(lv[0].elev).toBe(0);
    expect(lv.find((l) => l.id === l2.id)!.elev).toBeCloseTo(10 + SLAB_DEFAULT, 9);
    expect(lv.find((l) => l.id === l3.id)!.elev).toBeCloseTo(10 + SLAB_DEFAULT + 9 + SLAB_DEFAULT, 9);
  });

  it('forEachLevel：每一层都走到，当前层拿到的是文档顶层', () => {
    const d = house();
    const up = addLevel(d, { where: 'above' });
    const seen: string[] = [];
    forEachLevel(d, (view, lv, active) => {
      seen.push(lv.id + ':' + (view.walls || []).length + ':' + active);
      if (active) expect(view).toBe(d);
    });
    expect(seen.sort()).toEqual(['lv1:5:true', up.id + ':0:false'].sort());
  });

  it('地下室改层高：地面层仍是 0，地下室往下让（标高 = −(它的层高 + 一层楼板厚)）；不当前的层改的是它自己的外壳', () => {
    const d = house();
    d.ceilingH = 9;
    const b = addLevel(d, { where: 'below' });
    expect(b.elev).toBeCloseTo(-(9 + SLAB_DEFAULT), 9);
    expect(setLevelCeiling(d, b.id, 7.5)).toBe(true);
    expect(d.ceilingH).toBe(9); // 当前层（一层）的层高不动
    expect(
      levelCeil(
        d,
        d.levels!.find((l) => l.id === b.id)!
      )
    ).toBe(7.5);
    const lv = sortedLevels(d);
    expect(lv.find((l) => l.id === 'lv1')!.elev).toBe(0);
    expect(lv.find((l) => l.id === b.id)!.elev).toBeCloseTo(-(7.5 + SLAB_DEFAULT), 9);
    expect(setLevelCeiling(d, 'lv404', 8)).toBe(false);
    expect(removeLevel(d, 'lv404')).toEqual({ ok: false, reason: '没有这一层' });
  });

  it('单层文档：setLevelCeiling 只认 lv1；activeLevel = null；levelContentOf 只认 lv1', () => {
    const d = house();
    expect(setLevelCeiling(d, 'lv1', 9.5)).toBe(true);
    expect(d.ceilingH).toBe(9.5);
    expect(setLevelCeiling(d, 'lv2', 9)).toBe(false);
    expect(activeLevel(d)).toBeNull();
    expect(levelContentOf(d, 'lv1')).toBe(d);
    expect(levelContentOf(d, 'lv2')).toBeNull();
    const up = addLevel(d, { where: 'above' });
    expect(activeLevel(d)!.id).toBe('lv1');
    expect(levelContentOf(d, 'nope')).toBeNull();
    expect(levelContentOf(d, up.id)).toBe(d.levels!.find((l) => l.id === up.id));
  });

  it('切到一层「只有外壳」的楼层（手写 / 旧导出里缺内容键）：顶层补上必填的空值，校验照样过', () => {
    const d = house();
    enableLevels(d);
    d.levels!.push({ id: 'lv2', name: '阁楼', elev: 9.8 } as never);
    expect(activateLevel(d, 'lv2')).toBe(true);
    expect(d.walls).toEqual([]);
    expect(d.windows).toEqual([]);
    expect(d.doors).toEqual([]);
    expect(d.solids).toEqual([]);
    expect(d.rooms).toEqual([]);
    expect(d.fixtures).toEqual([]);
    expect(d.patio).toBeNull();
    expect(d.hidden).toEqual({ walls: [], windows: [], doors: [], solids: [] });
    expect(d.ceilingH).toBe(8.8); // 缺层高 → 沿用刚离开那一层的
    expect(d.outlets).toBeUndefined(); // 非必填的键不凭空造出来
    expect(validate(d)).toEqual([]);
    // 切回来：一层的内容原样回到顶层
    expect(activateLevel(d, 'lv1')).toBe(true);
    expect(d.walls.length).toBe(5);
  });

  it('单层文档也能遍历（一次，当前层 = 文档本身）', () => {
    const d = house();
    let n = 0;
    forEachLevel(d, (view, lv, active) => {
      n++;
      expect(view).toBe(d);
      expect(active).toBe(true);
      expect(lv.id).toBe('lv1');
    });
    expect(n).toBe(1);
  });
});

describe('校验：楼层与楼梯', () => {
  it('不当前的楼层里的非法实体照样被拒（路径带楼层下标）', () => {
    const d = house();
    const up = addLevel(d, { where: 'above' });
    const c = levelContentOf(d, up.id)!;
    c.outlets = [{ id: 'ol01', x: 1, y: 1, rot: 0, h: 1, kind: 'tesla', host: 'wall' }] as never;
    const errs = validate(d);
    expect(errs.some((e) => e.path === 'levels[1].outlets[0].kind')).toBe(true);
  });

  it('当前层 id 必须存在；楼层 id 不能重复；当前层的外壳里不许再放内容', () => {
    const d = house();
    const up = addLevel(d, { where: 'above' });
    const a = clone(d) as ProjectDoc;
    a.level = 'ghost';
    expect(validate(a).some((e) => e.path === 'level')).toBe(true);
    const b = clone(d) as ProjectDoc;
    b.levels![1].id = 'lv1';
    expect(validate(b).some((e) => e.path === 'levels[1].id')).toBe(true);
    const c = clone(d) as ProjectDoc;
    (c.levels![0] as never as { walls: unknown[] }).walls = [];
    expect(validate(c).some((e) => e.path === 'levels[0]')).toBe(true);
    expect(up.id).not.toBe('lv1');
  });

  it('楼梯：中心线 2–4 个点、宽 1–10ft、踏步数 2–40 的整数', () => {
    const d = house();
    d.stairs = [
      {
        id: 'st01',
        path: [
          [2, 2],
          [2, 12],
        ],
        w: 3,
        steps: 16,
        src: 'user',
      },
      { id: 'st02', path: [[5, 2]], w: 3 },
      {
        id: 'st03',
        path: [
          [6, 2],
          [6, 8],
          [9, 8],
        ],
        w: 0.5,
      },
      {
        id: 'st04',
        path: [
          [7, 2],
          [7, 8],
        ],
        w: 3,
        steps: 1.5,
      },
    ] as never;
    const errs = validate(d);
    expect(errs.some((e) => e.path.startsWith('stairs[0]'))).toBe(false);
    expect(errs.some((e) => e.path === 'stairs[1].path')).toBe(true);
    expect(errs.some((e) => e.path === 'stairs[2].w')).toBe(true);
    expect(errs.some((e) => e.path === 'stairs[3].steps')).toBe(true);
  });
});

/* =====================================================================
   S17b：矢量图纸导入为一层 + 整层平移
   ===================================================================== */
describe('整层平移 / 导入为一层（S17b）', () => {
  const full = () => {
    const d = house();
    d.windows = [
      {
        id: 'n01',
        geom: seg(4, 0, 8, 0),
        wallId: null,
        pos: 0.5,
        width: 4,
        sill: 2,
        head: 7,
        style: 'fixed',
        frame: '#111',
        glass: 0.2,
      },
    ] as never;
    d.doors = [
      {
        id: 'd01',
        geom: seg(20, 4, 20, 7),
        gapGeom: seg(20, 4, 20, 7),
        wallId: null,
        pos: 0.5,
        width: 3,
        kind: 'swing',
      },
    ] as never;
    d.solids = [
      {
        id: 's01',
        geom: {
          t: 'poly',
          pts: [
            [2, 2],
            [3, 2],
            [3, 3],
            [2, 3],
          ],
        },
        fill: '#0c0d0f',
      },
      { id: 's02', geom: { t: 'arc', cx: 15, cy: 10, r: 0.5, a0: 0, a1: 360, dir: 1 }, fill: '#0c0d0f' },
    ] as never;
    d.rooms = [
      {
        id: 'r01',
        label: '客厅',
        pos: [5, 7],
        poly: [
          [0.2, 0.2],
          [9.8, 0.2],
          [9.8, 13.8],
          [0.2, 13.8],
        ],
      },
    ] as never;
    d.fixtures = [{ id: 'f01', t: 'toilet', x1: 11, y1: 1, x2: 13, y2: 3 }] as never;
    d.runs = [
      {
        id: 'k01',
        path: [
          [11, 13],
          [19, 13],
        ],
        depth: 2,
        topH: 3,
      },
    ] as never;
    d.outlets = [{ id: 'ol02', x: 5, y: 7, rot: 0, h: 0, kind: 'floorDrain', host: 'floor' }] as never;
    d.stairs = [
      {
        id: 'st01',
        path: [
          [16, 2],
          [16, 10],
        ],
        w: 3,
      },
    ] as never;
    d.floorOutline = [
      [0, 0],
      [20, 0],
      [20, 14],
      [0, 14],
    ] as never;
    d.baseImage = { data: 'data:image/png;base64,AAAA', w: 10, h: 10, mPerPx: 0.1, ox: 1, oy: 2 } as never;
    return d;
  };

  it('平移：墙 / 窗 / 门与门洞缺口 / 多边形柱 / 圆柱 / 房间标签与轮廓 / 洁具 / 台面 / 点位 / 楼梯 / 地板轮廓 / 底图 —— 全部同一个位移', () => {
    const d = full();
    translateLevelContent(d, 2.5, -1);
    expect((d.walls[0].geom as any).x1).toBe(2.5);
    expect((d.walls[0].geom as any).y1).toBe(-1);
    expect((d.windows[0].geom as any).x2).toBe(10.5);
    expect((d.doors[0] as any).gapGeom.y2).toBe(6);
    expect((d.solids[0].geom as any).pts[0]).toEqual([4.5, 1]);
    expect((d.solids[1].geom as any).cx).toBe(17.5);
    expect(d.rooms[0].pos).toEqual([7.5, 6]);
    expect((d.rooms[0] as any).poly[2]).toEqual([12.3, 12.8]);
    expect([d.fixtures[0].x1, d.fixtures[0].y2]).toEqual([13.5, 2]);
    expect((d.runs as any)[0].path[1]).toEqual([21.5, 12]);
    expect([(d.outlets as any)[0].x, (d.outlets as any)[0].y]).toEqual([7.5, 6]);
    expect((d.stairs as any)[0].path[0]).toEqual([18.5, 1]);
    expect((d.floorOutline as any)[2]).toEqual([22.5, 13]);
    expect([(d.baseImage as any).ox, (d.baseImage as any).oy]).toEqual([3.5, 1]);
    expect(validate(d)).toEqual([]);
  });

  it('S26b：房间的单面墙覆盖（按墙线两端点存）跟着一起平移；其余装修字段原样', () => {
    const d = full();
    (d.rooms[0] as any).faces = [{ a: [0, 0], b: [10, 0], wall: { color: '#4f604f' } }];
    (d.rooms[0] as any).tile = { mat: 'subwayWhite', h: 'shower' };
    translateLevelContent(d, 2.5, -1);
    expect((d.rooms[0] as any).faces[0].a).toEqual([2.5, -1]);
    expect((d.rooms[0] as any).faces[0].b).toEqual([12.5, -1]);
    expect((d.rooms[0] as any).faces[0].wall).toEqual({ color: '#4f604f' });
    expect((d.rooms[0] as any).tile).toEqual({ mat: 'subwayWhite', h: 'shower' });
    expect(validate(d)).toEqual([]);
  });

  it('平移不攒浮点尾巴（坐标取到 1e-4ft）；位移为 0 什么都不动', () => {
    const d = full();
    const before = JSON.stringify(d);
    translateLevelContent(d, 0, 0);
    expect(JSON.stringify(d)).toBe(before);
    for (let i = 0; i < 10; i++) translateLevelContent(d, 0.1, 0);
    expect((d.walls[0].geom as any).x1).toBe(1);
  });

  it('包围盒：墙 / 窗 / 门 / 柱（圆柱按外接方）/ 地板轮廓；空的层 = null', () => {
    expect(levelBBox(full())).toEqual({ x0: 0, y0: 0, x1: 20, y1: 14 });
    const d = blankDoc('空');
    expect(levelBBox(d)).toBeNull();
    d.solids = [{ id: 's1', geom: { t: 'arc', cx: 3, cy: 4, r: 1, a0: 0, a1: 360, dir: 1 }, fill: '#000' }] as never;
    expect(levelBBox(d)).toEqual({ x0: 2, y0: 3, x1: 4, y1: 5 });
  });

  it('导入为一层（往上）：新层在最上面、内容是导入那份的深拷贝并平移过、层高取导入那份的、原文档那一层不动；整份文档过校验', () => {
    const d = house();
    const top0 = JSON.stringify({ walls: d.walls, outlets: d.outlets });
    const src = full();
    src.ceilingH = 9.5;
    const lv = addLevelFromDoc(d, src, { where: 'above', dx: 1, dy: 1 })!;
    expect(lv).toBeTruthy();
    expect(sortedLevels(d).map((l) => l.id)).toEqual(['lv1', lv.id]);
    expect(lv.elev).toBe(0 + d.ceilingH + SLAB_DEFAULT);
    expect((lv as any).walls).toHaveLength(5);
    expect((lv as any).walls[0].geom.x1).toBe(1);
    expect((lv as any).ceilingH).toBe(9.5);
    expect((lv as any).baseImage.ox).toBe(2);
    (src.walls[0].geom as any).x1 = 99; // 深拷贝：改导入那份不影响新层
    expect((lv as any).walls[0].geom.x1).toBe(1);
    expect(JSON.stringify({ walls: d.walls, outlets: d.outlets })).toBe(top0);
    expect(d.level).toBe('lv1'); // 不切过去
    expect(validate(d)).toEqual([]);
    expect(activateLevel(d, lv.id)).toBe(true);
    expect((d.walls[0].geom as any).x1).toBe(1);
    expect(validate(d)).toEqual([]);
  });

  it('平移的边界：只有部分键的内容、门没有门洞缺口、房间没有轮廓、阳台跟着走、认不出的几何不动', () => {
    const v: any = {
      walls: [{ id: 'w1', kind: 'wall', geom: seg(0, 0, 1, 0) }],
      doors: [{ id: 'd1', geom: seg(0, 0, 1, 0) }],
      rooms: [{ id: 'r1', label: '', pos: [1, 1] }],
      solids: [
        { id: 's1', geom: { t: 'weird', x: 1 } },
        { id: 's2', geom: { t: 'poly' } },
      ],
      patio: { geom: seg(5, 5, 6, 5) },
    };
    translateLevelContent(v, 1, 2);
    expect(v.walls[0].geom.x1).toBe(1);
    expect(v.doors[0].geom.y2).toBe(2);
    expect(v.rooms[0].pos).toEqual([2, 3]);
    expect(v.rooms[0].poly).toBeUndefined();
    expect(v.solids[0].geom).toEqual({ t: 'weird', x: 1 });
    expect(v.solids[1].geom).toEqual({ t: 'poly' });
    expect(v.patio.geom.x1).toBe(6);
    const empty: any = {};
    translateLevelContent(empty, 3, 3); // 什么键都没有也不炸
    expect(empty).toEqual({});
  });

  it('包围盒的边界：非有限坐标不算、多边形没有点、只有地板轮廓', () => {
    const v: any = {
      walls: [{ id: 'w1', geom: { t: 'seg', x1: Number.NaN, y1: 0, x2: 2, y2: 3 } }],
      solids: [{ id: 's1', geom: { t: 'poly' } }, { id: 's2' }],
    };
    expect(levelBBox(v)).toEqual({ x0: 2, y0: 3, x1: 2, y1: 3 });
    expect(
      levelBBox({
        floorOutline: [
          [1, 1],
          [4, 5],
        ],
      } as any)
    ).toEqual({ x0: 1, y0: 1, x1: 4, y1: 5 });
  });

  it('导入那份没给层高（或给了 0）就用当前户型的层高；没有 hidden / patio 时补上合法空值', () => {
    const d = house();
    const src: any = { walls: [{ id: 'w1', kind: 'wall', geom: seg(0, 0, 3, 0) }], ceilingH: 0 };
    const lv: any = addLevelFromDoc(d, src as ProjectDoc, { where: 'above' })!;
    expect(lv.ceilingH).toBe(d.ceilingH);
    expect(lv.hidden).toEqual({ walls: [], windows: [], doors: [], solids: [] });
    expect(lv.patio).toBeNull();
    expect(lv.walls[0].geom.x2).toBe(3);
  });

  it('导入为地下室（往下）：标高在最下一层下面；导入的是多层文档 = 不收（null，文档不动）', () => {
    const d = house();
    const lv = addLevelFromDoc(d, full(), { where: 'below', name: '地下室' })!;
    expect(lv.name).toBe('地下室');
    expect(lv.elev).toBeLessThan(0);
    const multi = house();
    enableLevels(multi);
    addLevel(multi, { where: 'above' });
    const n = d.levels!.length;
    expect(addLevelFromDoc(d, multi, { where: 'above' })).toBeNull();
    expect(d.levels!.length).toBe(n);
  });
});
