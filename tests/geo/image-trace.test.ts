import { describe, it, expect } from 'vitest';
import { traceLines, imgTransform, type TraceSeg } from '../../src/geo/image-trace';

/* 合成一张 200×160 的「户型图」：白底黑线
   - 水平墙带：y=50 与 y=58 两条双线，x 20..180
   - 竖直墙带：x=100 与 x=108，y 20..140
   - 45° 斜线：(20,120) → (70,70) */
function makePlan(w = 200, h = 160): Uint8Array {
  const g = new Uint8Array(w * h).fill(255);
  const hline = (y: number, x0: number, x1: number) => {
    for (let x = x0; x <= x1; x++) g[y * w + x] = 0;
  };
  const vline = (x: number, y0: number, y1: number) => {
    for (let y = y0; y <= y1; y++) g[y * w + x] = 0;
  };
  hline(50, 20, 180);
  hline(58, 20, 180);
  vline(100, 20, 140);
  vline(108, 20, 140);
  for (let i = 0; i <= 50; i++) {
    const x = 20 + i,
      y = 120 - i;
    g[y * w + x] = 0;
  }
  return g;
}

function nearSegs(segs: TraceSeg[], x: number, y: number, tol: number): TraceSeg[] {
  return segs.filter(
    (s) =>
      (Math.abs(s.a.x - x) < tol && Math.abs(s.a.y - y) < tol) ||
      (Math.abs(s.b.x - x) < tol && Math.abs(s.b.y - y) < tol)
  );
}

describe('S7 traceLines（纯 JS Canny+Hough）', () => {
  it('检出水平墙带双线', () => {
    const r = traceLines(makePlan(), 200, 160);
    const h50 = nearSegs(r.segs, 20, 50, 4).concat(nearSegs(r.segs, 180, 50, 4));
    expect(h50.length).toBeGreaterThan(0);
    const span = Math.max(...h50.map((s) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y)));
    expect(span).toBeGreaterThan(100);
  });

  it('检出竖直墙带双线', () => {
    const r = traceLines(makePlan(), 200, 160);
    const v100 = nearSegs(r.segs, 100, 20, 4).concat(nearSegs(r.segs, 100, 140, 4));
    expect(v100.length).toBeGreaterThan(0);
  });

  it('检出 45° 斜墙', () => {
    const r = traceLines(makePlan(), 200, 160);
    const diag = r.segs.filter((s) => {
      const t = (s.b.x - s.a.x) / (Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) || 1);
      return Math.abs(t + 1) < 0.3 && s.weight >= 20; // 左下→右上（x+ y−）
    });
    expect(diag.length).toBeGreaterThan(0);
  });

  it('空图 → 无线段、无边像素', () => {
    const r = traceLines(new Uint8Array(100 * 80).fill(255), 100, 80);
    expect(r.segs.length).toBe(0);
  });

  it('反相（深底浅字）自动翻转', () => {
    const g = makePlan();
    for (let i = 0; i < g.length; i++) g[i] = 255 - g[i];
    const r = traceLines(g, 200, 160);
    expect(r.inverted).toBe(true);
    expect(r.segs.length).toBeGreaterThan(0);
  });

  it('确定性：两次调用逐字段相同', () => {
    const a = traceLines(makePlan(), 200, 160);
    const b = traceLines(makePlan(), 200, 160);
    expect(JSON.stringify(a.segs)).toBe(JSON.stringify(b.segs));
    expect(a.edgeCount).toBe(b.edgeCount);
  });
});

describe('S7 imgTransform（像素 ↔ 文档 ft，y 均向下）', () => {
  const bi = { w: 100, h: 60, mPerPx: 0.01, ox: 1, oy: 2, rot: 0 as const };
  const ft = 0.01 / 0.3048;

  it('rot=0：四角映射', () => {
    const t = imgTransform(bi);
    expect(t.toDoc(0, 0)[0]).toBeCloseTo(1, 9);
    expect(t.toDoc(0, 0)[1]).toBeCloseTo(2, 9);
    expect(t.toDoc(100, 60)[0]).toBeCloseTo(1 + 100 * ft, 9);
    expect(t.toDoc(100, 60)[1]).toBeCloseTo(2 + 60 * ft, 9);
    // 往返
    const [x, y] = t.toDoc(37, 44);
    const [px, py] = t.toImg(x, y);
    expect(px).toBeCloseTo(37, 6);
    expect(py).toBeCloseTo(44, 6);
  });

  it('rot=90（顺时针）：原图左上 → 旋转包围盒右上', () => {
    const t = imgTransform({ w: 100, h: 60, mPerPx: 0.01, ox: 1, oy: 2, rot: 90 as const });
    expect(t.bw).toBe(60); // 宽高交换
    expect(t.bh).toBe(100);
    // 像素 (0,0)（原图左上）→ 旋转后右上角 (ox + bw·ft, oy)
    expect(t.toDoc(0, 0)[0]).toBeCloseTo(1 + 60 * ft, 9);
    expect(t.toDoc(0, 0)[1]).toBeCloseTo(2, 9);
    // 像素 (w,0)（原图右上）→ 右下角
    expect(t.toDoc(100, 0)[0]).toBeCloseTo(1 + 60 * ft, 9);
    expect(t.toDoc(100, 0)[1]).toBeCloseTo(2 + 100 * ft, 9);
    // 往返
    const [x, y] = t.toDoc(50, 30);
    const [px, py] = t.toImg(x, y);
    expect(px).toBeCloseTo(50, 6);
    expect(py).toBeCloseTo(30, 6);
  });
});
