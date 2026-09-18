/**
 * S5 集成测试：真实 DXF 文件（来源见 tests/fixtures/integration/README.md）。
 *
 * 与单测 fixture（自造 apartment-mm/cm.dxf）的区别：这些是别人用 ezdxf / QCAD /
 * LibreDWG 产出的真实数据——闭合墙面轮廓（不是平行双 LINE）、AC1024~AC1032
 * 各种版本、INSUNITS=6/4/0 各种取值、块引用、3DFACE/DIMENSION/椭圆。
 *
 * 断言分两层：
 *   1. 通用不变量（所有文件）：不抛错、schema validate 通过、确定性、量级有限、
 *      性能可接受；
 *   2. 每文件行为：单位检测结果、墙厚配对、房间/柱识别、已知局限的警告。
 *
 * 这些断言锚定了「真实数据暴露的缺陷的修复」：
 *   - hack_canada（INSUNITS=6=yd）曾漏映射 → 落到 mm fallback → 量级错 + 0 墙；
 *   - 闭合 LWPOLYLINE 墙面曾整块进 `closed` 不做边对边配对 → 0 墙；
 *   - 'colors' 层曾误判为柱层（QCAD 色样层）。
 * 回归任何一条都说明真实数据路径坏了。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import DxfParser from 'dxf-parser';
import { importDxf, classifyLayer, type DxfDoc } from '../../src/geo/import-dxf';
import { validate } from '../../src/schema/project';

const here = dirname(fileURLToPath(import.meta.url));
const INT = join(here, '..', 'fixtures', 'integration');

function load(name: string): DxfDoc {
  return new DxfParser().parseSync(readFileSync(join(INT, name), 'utf8')) as unknown as DxfDoc;
}

const ALL = [
  'hack_canada_building.dxf',
  'libredwg_example_2018.dxf',
  'qcad_entities.dxf',
  'qcad_example00.dxf',
];

describe('integration: 通用不变量（全部真实文件）', () => {
  for (const f of ALL) {
    describe(f, () => {
      const r1 = importDxf(load(f), { name: f });
      const r2 = importDxf(load(f), { name: f });
      it('dxf-parser 解析出实体', () => {
        expect(load(f).entities?.length ?? 0).toBeGreaterThan(0);
      });
      it('importDxf 不抛错', () => {
        expect(r1.doc).toBeTruthy();
        expect(r1.info.unit).toBeTruthy();
      });
      it('产出文档通过 schema validate', () => {
        expect(validate(r1.doc)).toEqual([]);
      });
      it('量级有限且为正', () => {
        expect(Number.isFinite(r1.info.extent.w)).toBe(true);
        expect(Number.isFinite(r1.info.extent.h)).toBe(true);
        expect(r1.info.extent.w).toBeGreaterThan(0);
        expect(r1.info.extent.h).toBeGreaterThan(0);
      });
      it('确定性：两次独立导入产出逐字节相同的 doc JSON', () => {
        expect(JSON.stringify(r1.doc)).toBe(JSON.stringify(r2.doc));
        expect(JSON.stringify(r1.info)).toBe(JSON.stringify(r2.info));
      });
      it('性能：单文件导入 < 2s', () => {
        const t0 = Date.now();
        importDxf(load(f), { name: f });
        expect(Date.now() - t0).toBeLessThan(2000);
      });
    });
  }
});

describe('integration: 每文件行为', () => {
  describe('hack_canada_building（ezdxf 建筑图：6 层、闭合墙面轮廓、150 个块引用）', () => {
    const r = importDxf(load('hack_canada_building.dxf'));
    it('$INSUNITS=6 → yd（此前映射缺失 → mm fallback → 量级错 1000× + 0 墙）', () => {
      expect(r.info.unit).toBe('yd');
      expect(r.info.unitMethod).toBe('insunits');
    });
    it('闭合 LWPOLYLINE 墙面经边对边配对得到真实墙厚（0.15/0.2yd = 0.45/0.6ft），无默认厚', () => {
      const th = r.doc.walls.map(w => w.thick ?? 0).sort((a, b) => a - b);
      expect(th.length).toBeGreaterThanOrEqual(100);
      // 两种真实厚度都要出现；默认厚 0.1m=0.3281ft 不应出现
      expect(th.some(t => Math.abs(t - 0.45) < 0.01)).toBe(true);
      expect(th.some(t => Math.abs(t - 0.6) < 0.01)).toBe(true);
      expect(th.every(t => t > 0.4)).toBe(true);
    });
    it('房间（131 个闭合矩形）与柱（48 个 S-COLS 闭合方）识别', () => {
      expect(r.info.counts.rooms).toBe(131);
      expect(r.doc.solids.filter(s => s.column).length).toBe(48);
    });
    it('量级合理：22m × 125m（6 层堆叠的单层平面 + 场地）', () => {
      expect(r.info.extent.w).toBeGreaterThan(20);
      expect(r.info.extent.w).toBeLessThan(30);
      expect(r.info.extent.h).toBeGreaterThan(100);
    });
    it('块引用跳过被如实报告（门/窗符号在块里——文档化局限）', () => {
      expect(r.info.counts.doors).toBe(0);
      expect(r.info.counts.windows).toBe(0);
      expect(r.info.warnings.some(w => w.includes('块引用') && w.includes('150'))).toBe(true);
    });
  });

  describe('libredwg_example_2018（AC1032 / R2018 / $INSUNITS=4 英寸 / 826KB）', () => {
    const r = importDxf(load('libredwg_example_2018.dxf'));
    it('$INSUNITS=4 → in，insunits 方法', () => {
      expect(r.info.unit).toBe('in');
      expect(r.info.unitMethod).toBe('insunits');
    });
    it('大尺度图（363×216m）触发「量级偏大」警告', () => {
      expect(r.info.warnings.some(w => w.includes('量级偏大'))).toBe(true);
    });
    it('3DFACE / DIMENSION / 椭圆等实体存在也不崩；房间闭合环仍识别', () => {
      expect(r.info.counts.rooms).toBe(11);
      expect(r.info.warnings.some(w => w.includes('椭圆'))).toBe(true);
    });
  });

  describe('qcad_example00（QCAD 样例 / AC1024 / $INSUNITS=4）', () => {
    const r = importDxf(load('qcad_example00.dxf'));
    it('insunits → in，量级正常 → 无警告', () => {
      expect(r.info.unit).toBe('in');
      expect(r.info.warnings).toEqual([]);
    });
  });

  describe('qcad_entities（QCAD 实体样例 / $INSUNITS=0 → 启发式）', () => {
    const r = importDxf(load('qcad_entities.dxf'));
    it('INSUNITS=0 无信息 → 墙厚启发式判 mm', () => {
      expect(r.info.unitMethod).toBe('heuristic');
      expect(r.info.unit).toBe('mm');
    });
    it('色样「colors」层不再误判为柱层（此前 S-COLS/彩色层误报）', () => {
      // 该文件的实体层无柱；若 'colors' 误判 col，会多出一批柱
      expect(r.doc.solids.filter(s => s.column && s.name === '柱').length).toBe(0);
    });
  });
});

describe('integration: 层名分类精度（真实数据里的误判案例）', () => {
  it('QCAD 色样层 colors 不是柱层', () => {
    expect(classifyLayer('colors')).toBe('other');
    expect(classifyLayer('COLORS')).toBe('other');
  });
  it('柱层写法仍命中（含带前缀/连字符）', () => {
    expect(classifyLayer('COL')).toBe('col');
    expect(classifyLayer('COLS')).toBe('col');
    expect(classifyLayer('COLUMN')).toBe('col');
    expect(classifyLayer('COLUMNS')).toBe('col');
    expect(classifyLayer('S-COLS')).toBe('col');
    expect(classifyLayer('柱')).toBe('col');
  });
  it('墙优先于柱：WALL-COLS 仍是墙', () => {
    expect(classifyLayer('WALL-COLS')).toBe('wall');
  });
});
