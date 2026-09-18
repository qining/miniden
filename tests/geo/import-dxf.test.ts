// S5 测试：DXF → ProjectDoc 映射（fixture 驱动，R1 场景）
// fixture：scripts/make-dxf-fixtures.mjs（node scripts/make-dxf-fixtures.mjs 重新生成）
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import DxfParser from 'dxf-parser';
import { importDxf, classifyLayer, type DxfDoc } from '../../src/geo/import-dxf';
import { validate } from '../../src/schema/project';
import { expand, type Seg, type Geom } from '../../src/schema/primitives';
import { docToLegacy } from '../../src/schema/migrate';


const here = dirname(fileURLToPath(import.meta.url));
const M_TO_FT = 1 / 0.3048;
const f2 = (x: number) => Math.round(x * 10000) / 10000;
const near = (a: number, b: number, eps = 0.005) => expect(Math.abs(a - b)).toBeLessThan(eps);
// v1 里墙/门/窗的 geom 恒为 seg（ADR-0002：弧墙是将来）
const seg = (g: Geom): Seg => g as Seg;

function parseFixture(name: string): DxfDoc {
  const txt = readFileSync(join(here, '..', 'fixtures', name), 'utf8');
  return new DxfParser().parseSync(txt) as unknown as DxfDoc;
}
function run(name: string) {
  return importDxf(parseFixture(name));
}

describe('classifyLayer', () => {
  it('中文 + 英文 + 0/undefined', () => {
    expect(classifyLayer('WALL')).toBe('wall');
    expect(classifyLayer('墙体')).toBe('wall');
    expect(classifyLayer('DOOR_FRAME')).toBe('door');
    expect(classifyLayer('WINDOW')).toBe('window');
    expect(classifyLayer('COLUMN')).toBe('col');
    expect(classifyLayer('FURNITURE')).toBe('furn');
    expect(classifyLayer('0')).toBe('other');
    expect(classifyLayer(undefined)).toBe('other');
    expect(classifyLayer('DIM')).toBe('axis');
  });
});

describe('units: $INSUNITS 路径', () => {
  const { info } = run('apartment-mm.dxf');
  it('mm fixture 检出 mm（insunits）', () => {
    expect(info.unit).toBe('mm');
    expect(info.unitMethod).toBe('insunits');
  });
  it('量级正确（10.24×8.24m）', () => {
    near(info.extent.w, 10.24);
    near(info.extent.h, 8.24);
  });
});

describe('units: 启发式路径（$INSUNITS=0）', () => {
  const { info } = run('apartment-cm.dxf');
  it('cm fixture 用墙厚中位数检出 cm', () => {
    expect(info.unit).toBe('cm');
    expect(info.unitMethod).toBe('heuristic');
  });
});

describe('墙带配对', () => {
  const { doc } = run('apartment-mm.dxf');
  it('6 条墙：4 外 + 内墙被门洞切成 2 段', () => {
    expect(doc.walls).toHaveLength(6);
  });
  it('外墙厚 0.24m → 0.7874ft；内墙 0.12m → 0.3937ft', () => {
    const thick = doc.walls.map(w => f2(w.thick ?? 0)).sort((a, b) => a - b);
    expect(thick.filter(t => t > 0.7)).toHaveLength(4);
    expect(thick.filter(t => t < 0.7)).toHaveLength(2);
    near(thick[0]!, 0.12 * M_TO_FT);
    near(thick[3]!, 0.24 * M_TO_FT);
  });
  it('y 翻转 + 平移：所有几何 ≥ 0（原 y=-0.12m 的外南墙贴 0）', () => {
    for (const w of doc.walls) {
      const g = seg(w.geom);
      expect(Math.min(g.x1, g.x2, g.y1, g.y2)).toBeGreaterThanOrEqual(-0.01);
    }
  });
});

describe('门', () => {
  const { doc } = run('apartment-mm.dxf');
  it('1 个门，缺口 1.2m → 3.937ft（竖直缺口）', () => {
    expect(doc.doors).toHaveLength(1);
    const d = doc.doors[0];
    const gap = seg(d.gapGeom!);
    near(Math.abs(gap.x2 - gap.x1), 0, 0.001);
    near(Math.abs(gap.y2 - gap.y1), 1.2 * M_TO_FT, 0.02);
  });
  it('门扇 = 图纸 DOOR 层段（0.9m，水平）', () => {
    const d = doc.doors[0];
    const leaf = seg(d.geom);
    near(Math.abs(leaf.x2 - leaf.x1), 0.9 * M_TO_FT, 0.02);
    near(Math.abs(leaf.y2 - leaf.y1), 0, 0.001);
    expect(d.kind).toBe('swing');
    expect([0, 1]).toContain(d.hinge);
    expect([1, -1]).toContain(d.side);
  });
  it('pos 是缺口在整墙上的比例（0..1）', () => {
    expect(doc.doors[0].pos).toBeGreaterThanOrEqual(0);
    expect(doc.doors[0].pos).toBeLessThanOrEqual(1);
  });
});

describe('窗', () => {
  const { doc } = run('apartment-mm.dxf');
  it('1 个窗，1.8m → 5.906ft，默认 fixed/窗台 0.9m/顶 2.4m', () => {
    expect(doc.windows).toHaveLength(1);
    const w = doc.windows[0];
    near(w.width, 1.8 * M_TO_FT, 0.02);
    near(w.sill, 0.9 * M_TO_FT, 0.005);
    near(w.head, 2.4 * M_TO_FT, 0.005);
    expect(w.style).toBe('fixed');
  });
});

describe('柱 / 房间', () => {
  const { doc } = run('apartment-mm.dxf');
  it('圆柱 r=0.25m → fullCircle 实体', () => {
    expect(doc.solids).toHaveLength(1);
    const s = doc.solids[0];
    expect(s.geom.t).toBe('arc');
    if (s.geom.t === 'arc') near(s.geom.r, 0.25 * M_TO_FT, 0.005);
    expect(s.column).toBe(true);
  });
  it('48m² 闭合环 → 房间（不是实体）', () => {
    expect(doc.rooms).toHaveLength(1);
    const r = doc.rooms[0];
    near(r.wd!, 6 * M_TO_FT, 0.02);
    near(r.dp!, 8 * M_TO_FT, 0.02);
  });
});

describe('文档质量', () => {
  const { doc, info } = run('apartment-mm.dxf');
  it('通过 schema validate（含 id 唯一性）', () => {
    expect(validate(doc)).toEqual([]);
  });
  it('所有墙/门/窗的 expand() 能展开（消费端契约，ADR-0002）', () => {
    for (const w of doc.walls) expect(expand(w.geom).length).toBeGreaterThan(0);
    for (const d of doc.doors) expect(expand(d.geom).length).toBeGreaterThan(0);
    for (const w of doc.windows) expect(expand(w.geom).length).toBeGreaterThan(0);
  });
  it('确定性：两次导入 JSON 完全相同', () => {
    expect(JSON.stringify(run('apartment-mm.dxf').doc)).toBe(JSON.stringify(doc));
  });
  it('docToLegacy 投影不抛（新文档也能走旧渲染路径）', () => {
    expect(() => docToLegacy(doc)).not.toThrow();
  });
  it('warnings 不报量级异常', () => {
    expect(info.warnings.some(w => w.includes('量级'))).toBe(false);
  });
});

describe('边界', () => {
  it('空文档：不崩，0 墙 + 警告', () => {
    const r = importDxf({ header: { '$INSUNITS': 1 }, entities: [] });
    expect(r.info.counts.walls).toBe(0);
    expect(r.info.warnings.some(w => w.includes('未检出墙体'))).toBe(true);
  });
  it('单线墙：默认厚 0.1m，仍成墙', () => {
    const d = {
      header: { '$INSUNITS': 1 },
      entities: [
        { type: 'LINE', layer: '0', vertices: [{ x: 0, y: 0 }, { x: 3000, y: 0 }] },
        { type: 'LINE', layer: '0', vertices: [{ x: 0, y: 0 }, { x: 0, y: 3000 }] },
      ],
    };
    const r = importDxf(d as unknown as DxfDoc);
    expect(r.info.counts.walls).toBe(2);
    near(r.doc.walls[0]!.thick ?? 0, 0.1 * M_TO_FT, 0.005);
  });
  it('用户强制单位覆盖自动检测', () => {
    const d = {
      header: { '$INSUNITS': 3 }, // m
      entities: [{ type: 'LINE', layer: '0', vertices: [{ x: 0, y: 0 }, { x: 3, y: 0 }] }],
    };
    const r = importDxf(d as unknown as DxfDoc, { unit: 'cm' });
    expect(r.info.unit).toBe('cm');
    expect(r.info.unitMethod).toBe('user');
  });
});
