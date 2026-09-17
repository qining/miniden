import { describe, it, expect } from 'vitest';
import { validate, blankDoc, nextId, projectSchema, type ProjectDoc } from '../../src/schema/project';
import type { Seg } from '../../src/schema/primitives';
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
