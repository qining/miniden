/* =====================================================================
   migrate —— 合成 legacy 存档的迁移（不依赖 private/fixtures，因此 CI 也跑）

   为什么单独一个文件：migrate.test.ts 的无损对照要用真实 eff* 输出
   （private/fixtures/legacy-geo.json，含真实户型坐标）→ CI 里没有 →
   migrate.ts 在 CI 的覆盖率只有 77%，而它恰恰是「用户存档会不会丢」的那条路。
   这里用一份**通用形状**的合成存档把分支跑全：窗/开口/通道/用户新增/覆盖/隐藏/
   洁具/阳台/房间，CI 与本地同口径。
   ===================================================================== */
import { describe, it, expect } from 'vitest';
import {
  migrateLegacyToV1,
  docToLegacy,
  EMPTY_USERGEO,
  type LegacyGeo,
  type LegacyUserGeo,
} from '../../src/schema/migrate';
import { validate, checkGeoms } from '../../src/schema/project';
import type { Geom } from '../../src/schema/primitives';

/** 投影/迁移出来的 seg 几何（Geom 是联合类型，取坐标要显式收窄） */
const segOf = (g: Geom) => g as { t: 'seg'; x1: number; y1: number; x2: number; y2: number };

const SC = 11.2;

/** 通用形状的合成 legacy（无个人数据）：4 根墙 + 1 窗 + 1 门洞 + 1 通道 + 1 柱 + 1 阳台 + 2 洁具 */
function legacyGeo(): LegacyGeo {
  return {
    sc: SC,
    walls: [
      { x1: 0, y1: 0, x2: 12, y2: 0, t: 'w', wd: 6.5 }, // 普通墙（带图纸 px 厚度）
      { x1: 12, y1: 0, x2: 12, y2: 9, t: 'w' }, // 缺省厚度
      { x1: 0, y1: 0, x2: 0, y2: 9, t: 'g', wd: 3.5, slider: true, fc: true }, // 落地推拉窗
      { x1: 5, y1: 9, x2: 7, y2: 9, t: 'd', wd: 4.0 }, // 门洞（'d'）
      { x1: 0, y1: 9, x2: 0, y2: 4, t: 'o' }, // 用户手绘开口（'o' = 通道，3D 无过梁）
    ],
    inner: [{ x1: 6, y1: 0, x2: 6, y2: 3, t: 'i', wd: 2.0 }],
    doors: [
      { x1: 5, y1: 9, x2: 7, y2: 9, kind: 'swing', hinge: 0, side: 1, wood: true }, // 落在 'd' 缺口上
      { x1: 9, y1: 0, x2: 10.5, y2: 0, kind: 'double', hinge: 1, side: 0, wood: false }, // 落在普通墙上
    ],
    fixed: [
      {
        name: '柱',
        poly: [
          [3, 3],
          [4, 3],
          [4, 4],
          [3, 4],
        ],
        fill: '#0c0d0f',
      },
      {
        name: '不画进校准的块',
        poly: [
          [8, 5],
          [9, 5],
          [9, 6],
        ],
        fill: '#15171a',
        noCal: true,
      },
    ],
    labels: [
      { p: [4, 4], t: '客厅', wd: 8, dp: 6, d: '8\'6"' },
      { p: [10, 7], t: '卧室', small: true, rot: 90 },
    ],
    fx: [
      { t: 'toilet', x1: 12 * SC, y1: 1 * SC, x2: 13 * SC, y2: 2 * SC, dir: 'W', fa: 'E' },
      { t: 'counter', x1: 1 * SC, y1: 8 * SC, x2: 4 * SC, y2: 9 * SC },
    ],
    patio: [
      [12, 9],
      [15, 9],
      [15, 12],
    ],
    isl: null,
  };
}

/** 合成 USERGEO：覆盖/隐藏/新增三类都来一份（下标越界另有专门用例） */
function userGeo(): LegacyUserGeo {
  return {
    walls: [
      { x1: 2, y1: 2, x2: 5, y2: 2, t: 'w' }, // 用户新墙
      { x1: 5, y1: 2, x2: 7, y2: 2, t: 'g', fc: true }, // 用户新窗
      { x1: 8, y1: 2, x2: 8, y2: 5, t: 'i' }, // 用户新细线
      { x1: 9, y1: 5, x2: 11, y2: 5, t: 'o' }, // 用户新通道
    ],
    polys: [
      {
        name: '用户柱',
        pts: [
          [6, 6],
          [7, 6],
          [7, 7],
        ],
      },
    ],
    doors: [{ x1: 2, y1: 0, x2: 3.5, y2: 0, kind: 'bifold', hinge: 0, side: 0, wood: false }],
    hiddenW: [1], // 隐藏内置墙 #1
    hiddenP: [1], // 隐藏内置块 #1（noCal 那个）
    hiddenD: [],
    ovW: { 0: { x2: 11, y2: 1 } }, // 改内置墙 #0 的端点
    ovP: {
      0: {
        poly: [
          [3, 3],
          [4.5, 3],
          [4.5, 4.5],
          [3, 4.5],
        ],
      },
    }, // 改内置柱
    ovD: { 0: { x1: 5.2 } }, // 改门位置
  };
}

describe('migrate —— 合成存档（CI 也跑：迁移分支不能只在本地被测）', () => {
  it('空 USERGEO：类别齐全、validate / checkGeoms 都过', () => {
    const doc = migrateLegacyToV1(legacyGeo(), EMPTY_USERGEO);
    expect(validate(doc)).toEqual([]);
    expect(checkGeoms(doc)).toEqual([]);
    expect(doc.walls.length).toBeGreaterThan(0);
    expect(doc.windows.length).toBe(1);
    expect(doc.solids.length).toBe(2);
    expect(doc.rooms.length).toBe(2);
    expect(doc.fixtures.length).toBe(2);
    expect(doc.patio?.geom.t).toBe('poly');
  });

  it('墙的类型：w=wall / d=opening / o=passage / g=窗（不是墙）', () => {
    const doc = migrateLegacyToV1(legacyGeo(), EMPTY_USERGEO);
    const kinds = doc.walls.map((w) => w.kind);
    expect(kinds).toContain('wall');
    expect(kinds).toContain('opening'); // 'd'
    expect(kinds).toContain('passage'); // 'o'
    // 'g' 段（原下标 2）不能出现在墙链里 —— 它在 windows 里
    expect(doc.walls.some((w) => w.chainIndex === 2)).toBe(false);
    const win = doc.windows[0];
    expect(win.style).toBe('slide'); // slider → slide
    expect(win.sill).toBe(0); // fc（落地）→ 窗台 0
  });

  it('图纸 px 厚度 → ft（thick = wd / sc），并保留 wdPx', () => {
    const doc = migrateLegacyToV1(legacyGeo(), EMPTY_USERGEO);
    const w0 = doc.walls.find((w) => w.chainIndex === 0)!;
    expect(w0.thick).toBeCloseTo(6.5 / SC, 6);
    expect(w0.wdPx).toBe(6.5);
  });

  it('门洞上的门：gapGeom 与原缺口配对（门垛联动靠它）', () => {
    const doc = migrateLegacyToV1(legacyGeo(), EMPTY_USERGEO);
    const onGap = doc.doors.find((d) => d.gapGeom);
    expect(onGap).toBeTruthy();
    expect(segOf(onGap!.geom).x1).toBeCloseTo(5, 6);
    // 落在普通墙上的门没有 gapGeom
    expect(doc.doors.filter((d) => !d.gapGeom).length).toBe(1);
  });

  it('洁具从图纸 px 换算成 ft（fx 是 legacy 里唯一非 ft 的字段）', () => {
    const doc = migrateLegacyToV1(legacyGeo(), EMPTY_USERGEO);
    const toilet = doc.fixtures.find((f) => f.t === 'toilet')!;
    // Fixture 存 ft 平铺字段（不是 geom）：fx 是 legacy 里唯一按图纸 px 存的字段
    expect(toilet.x1).toBeCloseTo(12, 6);
    expect(toilet.y2).toBeCloseTo(2, 6);
    expect(toilet.dir).toBe('W');
    expect(toilet.fa).toBe('E');
  });

  it('USERGEO：新增墙/窗/细线/通道/柱/门都进文档，且 src=user', () => {
    const doc = migrateLegacyToV1(legacyGeo(), userGeo());
    expect(validate(doc)).toEqual([]);
    expect(checkGeoms(doc)).toEqual([]);
    const userWalls = doc.walls.filter((w) => w.src === 'user');
    expect(userWalls.map((w) => w.kind)).toEqual(expect.arrayContaining(['wall', 'thin', 'passage']));
    expect(doc.windows.filter((w) => w.src === 'user').length).toBe(1);
    expect(doc.solids.filter((s) => s.src === 'user').length).toBe(1);
    expect(doc.doors.filter((d) => d.src === 'user').length).toBe(1);
  });

  it('hidden*：同一份 USERGEO，隐藏开/关时投影数量差 = 被隐藏的件数', () => {
    // 不能拿「带新增的存档」和「空存档」比——新增本身就会让数量变大，那样断言什么都不证明
    const hide = userGeo();
    const show = userGeo();
    show.hiddenW = [];
    show.hiddenP = [];
    const a = docToLegacy(migrateLegacyToV1(legacyGeo(), hide));
    const b = docToLegacy(migrateLegacyToV1(legacyGeo(), show));
    expect(b.walls.length - a.walls.length).toBe(1); // hiddenW: 内置墙 #1
    expect(b.fixed.length - a.fixed.length).toBe(1); // hiddenP: 内置块 #1
  });

  it('ov*：覆盖写进实体本身（不再是下标覆盖层）', () => {
    const doc = migrateLegacyToV1(legacyGeo(), userGeo());
    const w0 = doc.walls.find((w) => w.src === 'builtin' && w.chainIndex === 0)!;
    expect(segOf(w0.geom).x2).toBeCloseTo(11, 6); // ovW[0].x2
    expect(segOf(w0.geom).y2).toBeCloseTo(1, 6);
    const p0 = doc.solids.find((s) => s.src === 'builtin' && s.chainIndex === 0)!;
    expect(p0.geom.t).toBe('poly');
    expect((p0.geom as { pts: number[][] }).pts[1][0]).toBeCloseTo(4.5, 6); // ovP[0]
    const d0 = doc.doors.find((d) => d.src === 'builtin' && d.chainIndex === 0)!;
    expect(segOf(d0.geom).x1).toBeCloseTo(5.2, 6); // ovD[0]
  });

  it('往返：docToLegacy(migrate(legacy)) 的 W/F/D 数量与 legacy 一致（空 USERGEO 时）', () => {
    const legacy = legacyGeo();
    const out = docToLegacy(migrateLegacyToV1(legacy, EMPTY_USERGEO));
    // 墙链 = w + d + o（窗不在墙里）
    // 投影里窗与墙在同一索引空间交错（legacy effWalls 把窗 inline 在原位）→ 墙链 = 非窗段 + 窗
    expect(out.walls.length).toBe(legacy.walls.length);
    expect(out.fixed.length).toBe(legacy.fixed.length);
    expect(out.doors.length).toBe(legacy.doors.length);
    // 投影键集合是冻结的（S1 字节等价红线）：只有这三键
    expect(Object.keys(out).sort()).toEqual(['doors', 'fixed', 'walls']);
  });

  it('损坏存档（hidden 下标越界）不能把载入弄挂', () => {
    const broken = userGeo();
    broken.hiddenW = [999];
    broken.hiddenP = [999];
    broken.hiddenD = [999];
    const doc = migrateLegacyToV1(legacyGeo(), broken);
    expect(validate(doc)).toEqual([]);
    expect(doc.walls.length).toBeGreaterThan(0);
  });

  it('patio 少于 3 点 → 不建阳台（不产出退化多边形）', () => {
    const legacy = legacyGeo();
    legacy.patio = [
      [1, 1],
      [2, 2],
    ] as unknown as typeof legacy.patio;
    const doc = migrateLegacyToV1(legacy, EMPTY_USERGEO);
    expect(doc.patio).toBeFalsy();
  });

  it('patio 为 null / 缺失（通用户型与导入户型常见）不能把迁移弄挂', () => {
    // 原先 geo.patio.length 直接解引用 → TypeError → 整个载入挂掉；
    // app.html 侧一直靠 buildRawGeo 传 `patio: PATIO || []` 绕开，守卫应该在迁移里
    const a = legacyGeo();
    a.patio = null as unknown as typeof a.patio;
    expect(() => migrateLegacyToV1(a, EMPTY_USERGEO)).not.toThrow();
    const b = legacyGeo();
    delete (b as { patio?: unknown }).patio;
    expect(() => migrateLegacyToV1(b as unknown as LegacyGeo, EMPTY_USERGEO)).not.toThrow();
  });
});
