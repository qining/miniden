/* =====================================================================
   src/geo/entry.ts — 浏览器端入口（S5/S6：DXF + PDF 导入，IIFE bundle 唯一入口）

   编译（scripts/build-geo.mjs）：esbuild → IIFE → 注入 planner.html 的
   `<script id="miniden-geo">` 块，挂到 globalThis.MINIDEN_GEO：

       window.MINIDEN_GEO = { importDxf, detectUnits, classifyLayer, ... }

   纯度：同 schema——禁 import three / document（R7）。dxf-parser 由
   独立的 `<script src="lib/dxf-parser.iife.js">` 提供（globalThis.DxfParser），
   本模块只消费它的输出结构（结构化类型，零运行时依赖）。
   ===================================================================== */

import * as Dxf from './import-dxf';
import * as Pdf from './import-pdf';
import * as Trace from './image-trace';

(globalThis as { MINIDEN_GEO?: unknown }).MINIDEN_GEO = {
  importDxf: Dxf.importDxf,
  detectUnits: Dxf.detectUnits,
  classifyLayer: Dxf.classifyLayer,
  extractRaw: Dxf.extractRaw,
  UNIT_TO_M: Dxf.UNIT_TO_M,
  UNIT_NOMINAL: Dxf.UNIT_NOMINAL,
  // S6：PDF 导入（pdf.js 由 UI 层提供；OPS 表运行时传入）
  importPdf: Pdf.importPdf,
  extractRawPdf: Pdf.extractRawPdf,
  classifyPdfColor: Pdf.classifyPdfColor,
  inferPdfScale: Pdf.inferPdfScale,
  // S7：图片底图特征提取（纯 JS Canny+Hough）与放置变换
  traceLines: Trace.traceLines,
  imgTransform: Trace.imgTransform,
};
