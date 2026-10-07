/**
 * 真实 PDF 集成测试（对应 import-dxf 的 integration-real-dxf）。
 *
 * fixture（tests/fixtures/integration/，只增不删）：
 *   - apartment-vector.pdf   —— 1:200 矢量户型（45° 折线外框 + 2 内墙 +
 *                               1 红色 700mm 门（弧+带间隙两直线）+
 *                               1 蓝色 900mm 窗（沿墙双平行线）+ 3 字形 + 1 小图）
 *   - scanned-floorplan.pdf  —— 扫描件（一张图片 + 一条直线）→ 只给警告
 *
 * pdf.js 4.10（ESM-only）在 node 端走 fake-worker 单线程路径：
 *   globalThis.pdfjsWorker = require('lib/pdf.worker.min.js')
 *   const { getDocument } = require('lib/pdf.min.js')
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { importPdf } from '../../src/geo/import-pdf';
import type { PdfOpList, OpsTable } from '../../src/geo/import-pdf';

const here = path.dirname(fileURLToPath(import.meta.url)); // <root>/tests/geo
const ROOT = path.resolve(here, '../..');
const req = createRequire(import.meta.url);
const { getDocument } = req(path.join(ROOT, 'lib/pdf.min.js'));
// fake worker（4.10 单线程）：worker bundle 是 IIFE，require 的副作用即把
// { WorkerMessageHandler } 挂到（运行它的上下文的）globalThis.pdfjsWorker ——
// 注意：不要再用 req 的返回值（{}）去覆盖 globalThis.pdfjsWorker，
// 那会把尾注设好的值冲掉，逼 pdf.js 走动态 import（file:// 必挂）。
req(path.join(ROOT, 'lib/pdf.worker.min.js'));

const FIX = path.join(ROOT, 'tests/fixtures/integration');

/** 真实 pdf.js 4.10 op 表（探针实测） */
const PDF_OPS: OpsTable = {
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
  fill: 22,
  setStrokeRGBColor: 58,
  setFillRGBColor: 59,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
};

async function pdfOps(file: string): Promise<PdfOpList> {
  const data = new Uint8Array(fs.readFileSync(path.join(FIX, file)));
  const pdf = await getDocument({ data, isEvalSupported: false } as any).promise;
  const page = await pdf.getPage(1);
  const list = await page.getOperatorList();
  return { fnArray: list.fnArray as number[], argsArray: list.argsArray as unknown[][] };
}

/* ------------------------------------------------------------ 矢量户型 */
describe('真实 PDF 集成（1:200 户型）', () => {
  it('推断 1:200（门弧 r→0.7m + 整图 4.6m 量级）', async () => {
    const r = importPdf(await pdfOps('apartment-vector.pdf'), { w: 612, h: 792 }, PDF_OPS, {
      name: 'apartment-vector.pdf',
    });
    expect(r.info.scale).toBe(200);
    expect(r.info.scaleMethod).toBe('heuristic');
  });

  it('量级与计数（外框 4 + 内墙 2 + 窗两侧 = 7 段；1 门 0.7m；1 窗 0.9m）', async () => {
    const r = importPdf(await pdfOps('apartment-vector.pdf'), { w: 612, h: 792 }, PDF_OPS, {
      name: 'apartment-vector.pdf',
    });
    expect(r.info.scanned).toBeFalsy(); // 非扫描分支不设该字段
    expect(r.doc.walls.length).toBeGreaterThanOrEqual(5);
    expect(r.info.counts.walls).toBeGreaterThanOrEqual(5);
    expect(r.doc.doors).toHaveLength(1);
    const d = r.doc.doors[0]!;
    expect(d.width).toBeCloseTo(0.7 / 0.3048, 1); // 0.7m ≈ 2.30ft
    expect(d.pos).toBeGreaterThanOrEqual(0);
    expect(d.pos).toBeLessThanOrEqual(1);
    expect(d.wallId).toBeTruthy();
    expect(r.doc.windows).toHaveLength(1);
    const w = r.doc.windows[0]!;
    expect(w.width).toBeCloseTo(0.9 / 0.3048, 1); // 0.9m ≈ 2.95ft
    expect(w.wallId).toBeTruthy();
    expect(w.pos).toBeGreaterThanOrEqual(0);
    expect(w.pos).toBeLessThanOrEqual(1);
  });

  it('量级换算正确（45° 旋转的 56.7pt 外框 → 4.57m；1:200）', async () => {
    const r = importPdf(await pdfOps('apartment-vector.pdf'), { w: 612, h: 792 }, PDF_OPS, {
      name: 'apartment-vector.pdf',
    });
    expect(r.info.extent.w).toBeCloseTo(4.57, 1);
    expect(r.info.extent.h).toBeCloseTo(3.35, 1);
  });

  it('确定性：同文件两次导入 JSON 完全一致', async () => {
    const ops = await pdfOps('apartment-vector.pdf');
    const r1 = importPdf(ops, { w: 612, h: 792 }, PDF_OPS, { name: 'apartment-vector.pdf' });
    const r2 = importPdf(ops, { w: 612, h: 792 }, PDF_OPS, { name: 'apartment-vector.pdf' });
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('手动比例覆盖（1:50 → 量级 ×5、method=fixed）', async () => {
    const r = importPdf(await pdfOps('apartment-vector.pdf'), { w: 612, h: 792 }, PDF_OPS, {
      name: 'apartment-vector.pdf',
      scale: 50,
    });
    expect(r.info.scale).toBe(50);
    expect(r.info.scaleMethod).toBe('fixed');
    expect(r.info.extent.w).toBeCloseTo(1.14, 2);
  });
});

/* ------------------------------------------------------------ 扫描件 */
describe('真实 PDF 集成（扫描件）', () => {
  it('图片主导 → scanned=true，几何为空（走 S7 矢量化）', async () => {
    const r = importPdf(await pdfOps('scanned-floorplan.pdf'), { w: 595, h: 842 }, PDF_OPS, {
      name: 'scanned-floorplan.pdf',
    });
    expect(r.info.scanned).toBe(true);
    expect(r.doc.walls).toHaveLength(0);
    expect(r.doc.doors).toHaveLength(0);
    expect(r.doc.windows).toHaveLength(0);
    // 扫描件仍按 pt 建空文档（坐标系已就位，S7 矢量化结果可直接灌入）
    expect(r.doc.units).toBe('cm');
  });
});
