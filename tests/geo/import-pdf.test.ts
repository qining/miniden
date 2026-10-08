/* =====================================================================
   S6 单测：import-pdf（纯函数，不依赖 pdf.js——OPS 表以最小常量表传入）

   覆盖（R1 设计点）：
     - 颜色分类（classifyPdfColor）：黑/蓝/红/绿/黄/灰
     - CTM 栈：transform / save / restore
     - 弧拟合：90° 双 cubic 门弧 → arc（Kåsa，质心平移防病态）
     - 整圆：两段 180° 半圆 → circle（sweep ≥ 330°）
     - 文字字形过滤：闭合 + 小 bbox + 点密 → 丢弃；开放弧豁免
     - rectangle op：4 参数闭合子路径
     - 扫描件判据：有 paintImage 且矢量 < 8 → scanned
     - pt → m：72pt = 1in = 0.0254m（scale 1）
     - inferPdfScale：门弧 700mm@1:200 → 候选 1:200 胜出
     - 确定性：同输入两次 → JSON 完全一致
   ===================================================================== */
import { describe, it, expect } from 'vitest';
import { extractRawPdf, classifyPdfColor, inferPdfScale, importPdf } from '../../src/geo/import-pdf';
import type { PdfOpList, OpsTable } from '../../src/geo/import-pdf';

/* ---- 最小 OPS 表（pdf.js 4.10 数值；只含用到的） ---- */
const O: OpsTable = {
  save: 10,
  restore: 11,
  transform: 12,
  constructPath: 91,
  moveTo: 13,
  lineTo: 14,
  curveTo: 15,
  curveTo2: 16,
  curveTo3: 17,
  closePath: 18,
  rectangle: 19,
  stroke: 20,
  setStrokeRGBColor: 58,
  setFillRGBColor: 59,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
};

/* ---- 90° 弧的 cubic 近似（标准 kappa，与 fixture 生成器同式） ---- */
function arcCubics(cx: number, cy: number, r: number, a0: number, a1: number): [number, number][][] {
  const out: [number, number][][] = [];
  const n = 2,
    step = (a1 - a0) / n;
  for (let i = 0; i < n; i++) {
    const b0 = a0 + i * step,
      b1 = b0 + step;
    const k = (4 / 3) * Math.tan(step / 4);
    const p0: [number, number] = [cx + r * Math.cos(b0), cy + r * Math.sin(b0)];
    const p3: [number, number] = [cx + r * Math.cos(b1), cy + r * Math.sin(b1)];
    const c1: [number, number] = [p0[0] - k * r * Math.sin(b0), p0[1] + k * r * Math.cos(b0)];
    const c2: [number, number] = [p3[0] + k * r * Math.sin(b1), p3[1] - k * r * Math.cos(b1)];
    out.push([p0, c1, c2, p3]);
  }
  return out;
}
const rad = (d: number) => (d * Math.PI) / 180;

/** pdf.js 4.10 格式：所有路径 op 包在 constructPath 的 fns[] 里。 */
function pathOps(fns: number[], nums: number[]): PdfOpList['argsArray'][number] {
  return [fns, nums, null];
}

/** 红色 90° 门弧（双 45° cubic，中间隐式 moveTo 由 pdf.js 4.10 行为模拟）。 */
function doorArcOps(cx: number, cy: number, r: number): PdfOpList {
  const segs = arcCubics(cx, cy, r, rad(90), rad(180));
  const fns = [13, 15, 13, 15];
  const nums: number[] = [];
  segs.forEach((s) => {
    nums.push(s[0][0], s[0][1]);
    nums.push(s[1][0], s[1][1], s[2][0], s[2][1], s[3][0], s[3][1]);
  });
  return {
    fnArray: [O.setStrokeRGBColor, O.constructPath, O.stroke],
    argsArray: [{ 0: 219, 1: 0, 2: 0 } as unknown as unknown[], pathOps(fns, nums), null],
  };
}

describe('classifyPdfColor（描边色 → 语义类）', () => {
  it('近黑 = other（墙默认）', () => {
    expect(classifyPdfColor(0, 0, 0)).toBe('other');
    expect(classifyPdfColor(60, 60, 60)).toBe('other');
    expect(classifyPdfColor(80, 70, 60)).toBe('other');
  });
  it('蓝主导 = window', () => {
    expect(classifyPdfColor(0, 0, 255)).toBe('window');
    expect(classifyPdfColor(0, 0, 217)).toBe('window');
  });
  it('红主导 = door', () => {
    expect(classifyPdfColor(255, 0, 0)).toBe('door');
    expect(classifyPdfColor(219, 0, 0)).toBe('door');
  });
  it('绿主导 = furn', () => {
    expect(classifyPdfColor(0, 255, 0)).toBe('furn');
    expect(classifyPdfColor(100, 200, 100)).toBe('furn');
  });
  it('黄 / 品红 / 浅灰 = other（无主导色）', () => {
    expect(classifyPdfColor(255, 255, 0)).toBe('other');
    expect(classifyPdfColor(255, 0, 255)).toBe('other');
    expect(classifyPdfColor(100, 100, 110)).toBe('other');
  });
});

describe('CTM 栈', () => {
  it('transform 平移作用于后续路径', () => {
    const ops: PdfOpList = {
      fnArray: [O.transform, O.constructPath, O.stroke],
      argsArray: [[1, 0, 0, 1, 120, 85], pathOps([13, 14], [0, 0, 10, 0]), null],
    };
    const raw = extractRawPdf(ops, O);
    expect(raw.segs).toHaveLength(1);
    expect(raw.segs[0]!.a.x).toBeCloseTo(120, 3);
    expect(raw.segs[0]!.a.y).toBeCloseTo(85, 3);
    expect(raw.segs[0]!.b.x).toBeCloseTo(130, 3);
  });
  it('save / restore 隔离变换', () => {
    const ops: PdfOpList = {
      fnArray: [O.save, O.transform, O.constructPath, O.stroke, O.restore, O.constructPath, O.stroke],
      argsArray: [
        null,
        [1, 0, 0, 1, 100, 0],
        pathOps([13, 14], [0, 0, 10, 0]),
        null,
        null,
        pathOps([13, 14], [0, 0, 10, 0]),
        null,
      ],
    };
    const raw = extractRawPdf(ops, O);
    expect(raw.segs).toHaveLength(2);
    expect(raw.segs[0]!.a.x).toBeCloseTo(100, 3); // 有偏移
    expect(raw.segs[1]!.a.x).toBeCloseTo(0, 3); // restore 后回到原点
  });
});

describe('弧拟合', () => {
  it('90° 门弧（双 45° cubic + 隐式 moveTo）→ arc，cls=door，r/sweep 正确', () => {
    const raw = extractRawPdf(doorArcOps(120, 85, 11.34), O);
    expect(raw.arcs).toHaveLength(1);
    const a = raw.arcs[0]!;
    expect(a.r).toBeCloseTo(11.34, 1);
    expect(a.c.x).toBeCloseTo(120, 1);
    expect(a.c.y).toBeCloseTo(85, 1);
    expect(Math.abs(a.e - a.s)).toBeCloseTo(rad(90), 1);
    expect(a.cls).toBe('door');
    expect(raw.segs).toHaveLength(0);
  });
  it('整圆（8 段 cubic 一条子路径）→ circle', () => {
    const segs = [
      ...arcCubics(0, 0, 10, rad(0), rad(90)),
      ...arcCubics(0, 0, 10, rad(90), rad(180)),
      ...arcCubics(0, 0, 10, rad(180), rad(270)),
      ...arcCubics(0, 0, 10, rad(270), rad(360)),
    ];
    const fns = [13, 15, 13, 15, 13, 15, 13, 15, 13, 15, 13, 15, 13, 15, 13, 15]; // pdf.js 4.10：每段 cubic 前有（隐式）moveTo
    const nums: number[] = [];
    segs.forEach((s) => {
      nums.push(s[0][0], s[0][1]);
      nums.push(s[1][0], s[1][1], s[2][0], s[2][1], s[3][0], s[3][1]);
    });
    const ops: PdfOpList = {
      fnArray: [O.setStrokeRGBColor, O.constructPath, O.stroke],
      argsArray: [{ 0: 0, 1: 0, 2: 0 } as unknown as unknown[], pathOps(fns, nums), null],
    };
    const raw = extractRawPdf(ops, O);
    expect(raw.circles).toHaveLength(1);
    expect(raw.circles[0]!.r).toBeCloseTo(10, 1);
  });
});

describe('文字字形过滤', () => {
  it('闭合 + 小 bbox + 点密 → 丢弃（skipped.texts）', () => {
    const ops: PdfOpList = {
      fnArray: [O.setStrokeRGBColor, O.constructPath, O.stroke],
      argsArray: [
        { 0: 0, 1: 0, 2: 0 } as unknown as unknown[],
        [[13, 14, 14, 14, 14, 14, 18], [100, 440, 103, 440, 105, 442, 108, 443, 109, 448, 102, 450, null], null],
        null,
      ],
    };
    const raw = extractRawPdf(ops, O);
    expect(raw.skipped.texts).toBe(1);
    expect(raw.closed).toHaveLength(0);
    expect(raw.segs).toHaveLength(0);
  });
  it('开放路径（门弧型）不被字形过滤', () => {
    const raw = extractRawPdf(doorArcOps(0, 0, 9.92), O);
    expect(raw.skipped.texts).toBe(0);
    expect(raw.arcs).toHaveLength(1);
  });
});

describe('rectangle / 扫描件 / 单位', () => {
  it('rectangle op → 闭合环（4 角点）', () => {
    const ops: PdfOpList = {
      fnArray: [O.setStrokeRGBColor, O.constructPath, O.stroke],
      argsArray: [{ 0: 0, 1: 0, 2: 0 } as unknown as unknown[], pathOps([19], [0, 0, 20, 10]), null],
    };
    const raw = extractRawPdf(ops, O);
    expect(raw.closed).toHaveLength(1);
    expect(raw.closed[0]!.pts).toHaveLength(5); // 4 角 + 回首
  });
  it('有 paintImage 且矢量 < 8 → scanned', () => {
    const ops: PdfOpList = {
      fnArray: [O.paintImageXObject, O.constructPath, O.stroke],
      argsArray: [null, pathOps([13, 14], [0, 0, 10, 0]), null],
    };
    const raw = extractRawPdf(ops, O);
    expect(raw.scanned).toBe(true);
    expect(raw.imageOps).toBe(1);
  });
  it('有 paintImage 但矢量 ≥ 8 → 非扫描件', () => {
    const fnArray = [O.paintImageXObject];
    const argsArray: (unknown[] | null)[] = [null];
    for (let i = 0; i < 8; i++) {
      fnArray.push(O.constructPath, O.stroke);
      argsArray.push(pathOps([13, 14], [i * 10, 0, i * 10 + 5, 0]), null);
    }
    const raw = extractRawPdf({ fnArray, argsArray }, O);
    expect(raw.scanned).toBe(false);
    expect(raw.imageOps).toBe(1);
  });
  it('importPdf：72pt 线段 = 1in = 0.0254m（scale 1 手动）', () => {
    const ops: PdfOpList = {
      fnArray: [O.setStrokeRGBColor, O.constructPath, O.stroke],
      argsArray: [{ 0: 0, 1: 0, 2: 0 } as unknown as unknown[], pathOps([13, 14], [0, 0, 720, 0]), null],
    };
    const r = importPdf(ops, { w: 612, h: 792 }, O, { scale: 1 });
    expect(r.doc.walls).toHaveLength(1);
    const g = r.doc.walls[0]!.geom as { x1: number; y1: number; x2: number; y2: number };
    const lenM = Math.hypot(g.x2 - g.x1, g.y2 - g.y1) * 0.3048;
    expect(lenM).toBeCloseTo(0.254, 3);
    expect(r.info.unit).toBe('pt');
    expect(r.info.unitMethod).toBe('fixed');
    expect(r.info.scale).toBe(1);
    expect(r.info.scaleMethod).toBe('fixed');
  });
});

describe('inferPdfScale（比例尺推断）', () => {
  it('门弧 700mm@1:200 + 套型量级 → 1:200 胜出', () => {
    const raw = extractRawPdf(doorArcOps(0, 0, 9.92), O); // r=9.92pt
    expect(raw.arcs).toHaveLength(1); // 弧拟合成立是推断的前提
    // 造一个 4m×3m@1:200 = 56.7pt 的量级
    raw.segs.push({ a: { x: 0, y: 0 }, b: { x: 56.7, y: 0 }, cls: 'other' });
    const inf = inferPdfScale(raw);
    expect(inf.scale).toBe(200); // 门弧 r→0.70m 落入 [0.4,1.2]，量级 4.7m 也落入 → 1:200 得分 0
    expect(inf.method).toBe('heuristic');
  });
  it('没有门元素 → 靠整图量级，并给警告', () => {
    const raw = extractRawPdf(
      {
        fnArray: [O.setStrokeRGBColor, O.constructPath, O.stroke],
        argsArray: [{ 0: 0, 1: 0, 2: 0 } as unknown as unknown[], pathOps([13, 14], [0, 0, 56.7, 0]), null],
      },
      O
    );
    const inf = inferPdfScale(raw);
    expect(inf.scale).toBe(100); // 单线 56.7pt：1:100→2.0m 与 1:200→4.0m 都落入 [2,30] → 并列取小
    expect(inf.warnings.some((w) => w.includes('未检出门元素'))).toBe(true);
  });
});

describe('确定性', () => {
  it('同输入两次 importPdf → JSON 完全一致', () => {
    const ops = doorArcOps(120, 85, 11.34);
    const r1 = importPdf(ops, { w: 612, h: 792 }, O);
    const r2 = importPdf(ops, { w: 612, h: 792 }, O);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

/* ============ 覆盖补齐：rgbOf 三种形态 / 灰度描边 / curveTo2-3 / 退化矩形 / 比例打分 ============ */
describe('rgbOf：pdf.js 颜色参数的三种形态（曾踩坑：形态②查 .length 永远 undefined → 全变近黑）', () => {
  const colorOf = (arg: unknown[]): string => {
    const ops: PdfOpList = {
      fnArray: [O.setStrokeRGBColor, O.constructPath, O.stroke],
      argsArray: [arg, pathOps([13, 14], [0, 0, 30, 0]), null],
    };
    const raw = extractRawPdf(ops, O);
    return raw.segs[0] ? raw.segs[0].cls : 'no-seg';
  };
  it('形态①：三个裸数字', () => {
    expect(colorOf([219, 0, 0])).toBe('door'); // 红
    expect(colorOf([0, 0, 217])).toBe('window'); // 蓝
  });
  it('形态③：第一个参数是带 0/1/2 下标的对象或数组', () => {
    // 形态③ 的入口条件：参数长度 ≥3 且首参是对象/数组（pickObj 分支）
    expect(colorOf([[219, 0, 0], null, null])).toBe('door');
    expect(colorOf([{ 0: 0, 1: 0, 2: 217 }, null, null])).toBe('window');
  });
  it('形态②：不足三个参数但下标有值（pdf.js 3.x 老式）', () => {
    expect(colorOf({ 0: 219, 1: 0, 2: 0 } as unknown as unknown[])).toBe('door');
  });
  it('什么颜色都没给 → 近黑（other），不炸', () => {
    expect(colorOf([])).toBe('other');
  });
  it('灰度描边 setStrokeGray：0–1 值 ×255', () => {
    const ops: PdfOpList = {
      fnArray: [O.setStrokeGray, O.constructPath, O.stroke],
      argsArray: [[0.86], pathOps([13, 14], [0, 0, 30, 0]), null],
    };
    const raw = extractRawPdf(ops, O);
    expect(raw.segs[0]!.cls).toBe('other'); // 浅灰无主导色
  });
});

describe('路径 op 补齐：curveTo2 / curveTo3 / 退化矩形', () => {
  it('curveTo2（PDF 的 c：首控制点 = 当前点）也要被采样，不能整条路径丢掉', () => {
    // PDF curveTo2 只给第二个控制点；代码把它表成 c1 = 当前点的三次曲线（PDF 语义）。
    // 这种形状不是标准圆弧近似 → 走折线回退，但必须产出几何（曾经整段被吞就是 bug）。
    const cx = 120,
      cy = 85,
      r = 11.34;
    const fns = [13, 16, 16];
    const nums: number[] = [];
    let last: [number, number] = [cx + r, cy];
    nums.push(last[0], last[1]);
    for (const deg of [45, 90]) {
      const a = rad(deg);
      const p: [number, number] = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      const c: [number, number] = [cx + r * 1.2 * Math.cos(a - rad(22.5)), cy + r * 1.2 * Math.sin(a - rad(22.5))];
      nums.push(c[0], c[1], p[0], p[1]);
      last = p;
    }
    const ops: PdfOpList = {
      fnArray: [O.setStrokeRGBColor, O.constructPath, O.stroke],
      argsArray: [[0, 0, 0], pathOps(fns, nums), null],
    };
    const raw = extractRawPdf(ops, O);
    const total = raw.segs.length + raw.arcs.length;
    expect(total).toBeGreaterThan(0);
    // 起点必须落在给定的 moveTo 上（CTM 是单位阵）
    const first = raw.segs.length ? raw.segs[0]!.a : null;
    if (first) expect(first.x).toBeCloseTo(cx + r, 2);
  });
  it('curveTo3（首控制点重合）与 curveTo 产出同样的折线候选', () => {
    const ops: PdfOpList = {
      fnArray: [O.setStrokeRGBColor, O.constructPath, O.stroke],
      argsArray: [[0, 0, 0], pathOps([13, 17], [0, 0, 0, 0, 10, 10]), null],
    };
    const raw = extractRawPdf(ops, O);
    expect(raw.segs.length + raw.arcs.length).toBeGreaterThan(0);
  });
  it('rectangle 的 w 或 h 为 0 → 这条子路径丢掉（不产生假墙）', () => {
    const ops: PdfOpList = {
      fnArray: [O.setStrokeRGBColor, O.constructPath, O.stroke],
      argsArray: [[0, 0, 0], pathOps([19], [10, 10, 0, 20]), null],
    };
    const raw = extractRawPdf(ops, O);
    expect(raw.segs).toHaveLength(0);
    expect(raw.closed).toHaveLength(0);
  });
});

describe('inferPdfScale：门半径/门线打分（比例选错整套户型就错 10 倍）', () => {
  const scaleOf = (ops: PdfOpList) => inferPdfScale(extractRawPdf(ops, O));
  it('门弧半径落在 0.4–1.2m 的候选胜出（并列取较小候选）', () => {
    // r=8pt：1:200 → 0.56m ✓；1:100 → 0.28m ✗；1:400 → 1.13m ✓（并列时取较小）
    const inf = scaleOf(doorArcOps(120, 85, 8));
    expect(inf.scale).toBe(200);
    expect(inf.method).toBe('heuristic');
  });
  it('门弧半径离谱 → 打分惩罚，退回固定比例并警告', () => {
    const inf = scaleOf(doorArcOps(120, 85, 400)); // 400pt 的「门弧」不可能是门
    expect(inf.warnings.length).toBeGreaterThan(0);
  });
  it('只有门线（没有弧）也参与打分', () => {
    const ops: PdfOpList = {
      fnArray: [O.setStrokeRGBColor, O.constructPath, O.stroke],
      argsArray: [[219, 0, 0], pathOps([13, 14], [0, 0, 35.4, 0]), null], // 35.4pt = 1ft @1:100
    };
    const inf = scaleOf(ops);
    expect([100, 50, 20, 200]).toContain(inf.scale);
  });
});
