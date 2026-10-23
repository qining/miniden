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
import * as Points from './points';
import * as Regions from './regions';
import * as Stairs from './stairs';
import * as Placement from './placement';

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
  // S15：点位被家具挡住的判据（单位 ft）
  pointBlockers: Points.pointBlockers,
  obbCorners: Points.obbCorners,
  pointInPoly: Points.pointInPoly,
  // S16：点一下房间 → 轮廓 / 面积 / 标注点；房屋外轮廓
  buildGrid: Regions.buildGrid,
  regionAt: Regions.regionAt,
  footprint: Regions.footprint,
  polyArea: Regions.polyArea,
  simplifyClosed: Regions.simplifyClosed,
  // S17：楼梯几何（直跑 / L / U / 双跑 → 踏步 / 平台 / 外轮廓 / 箭头）；家具压在楼梯 / 楼梯口上的面积
  stairLayout: Stairs.stairLayout,
  stepCount: Stairs.stepCount,
  fitStairPath: Stairs.fitStairPath,
  isDogLeg: Stairs.isDogLeg,
  // S18：摆家具的几何判据（墙皮 / 贴墙吸附 / 离墙距离 / 门扇扫过的扇形）
  wallFaces: Placement.wallFaces,
  snapBox: Placement.snapBox,
  clearances: Placement.clearances,
  doorSweep: Placement.doorSweep,
  convexClipArea: Points.convexClipArea,
};
