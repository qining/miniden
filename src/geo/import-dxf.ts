/* =====================================================================
   src/geo/import-dxf.ts — DXF 解析对象 → ProjectDoc（S5，R1 设计）

   结构（S6 重构后）：
     - 本文件 = DXF 专有：实体结构类型 + extractRaw（实体→Raw）+
       detectUnits（$INSUNITS 优先，否则委托 common 启发式）+ importDxf 薄封装。
     - Raw → ProjectDoc 的共享管线（变换/墙带/门/窗/柱/房间）在
       import-common.ts（PDF 导入 import-pdf 复用同一管线）。
     - 共享符号从 common re-export（保持既有 import 路径不破）。

   纯函数：禁 import three / document / localStorage（R7 模块图）。
   坐标系：DXF 图纸 y 向上 → 文档 y 向下；单位：源单位 → m → ft（文档 ft 原生）。
   确定性：无随机（回归可比对）。
   ===================================================================== */
import { buildDocFromRaw, detectUnitsFromSamples, wallThicknessSamples, classifyLayer } from './import-common';
import type { Unit, UnitMethod, ImportResult, Raw } from './import-common';

/* 共享符号 re-export（既有测试/入口的 import 路径不变） */
export {
  classifyLayer,
  UNIT_TO_M,
  UNIT_NOMINAL,
  M_TO_FT,
  detectBands,
  transform,
  segOnBand,
  isParallel,
  signedDist,
  overlapFrac,
} from './import-common';
export type {
  Unit,
  UnitMethod,
  LayerClass,
  ImportInfo,
  ImportResult,
  Raw,
  RawSeg,
  RawArc,
  RawCircle,
  RawClosed,
  V2,
  Band,
  BuildDocOptions,
} from './import-common';

/* ---------------------------------------------------------------- 类型 */

export interface DxfPt {
  x: number;
  y: number;
  z?: number;
  bulge?: number;
}
export interface DxfEntity {
  type: string;
  layer?: string;
  vertices?: DxfPt[];
  center?: DxfPt;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  angleLength?: number;
  closed?: boolean;
  shape?: boolean;
  fitPoints?: DxfPt[];
  controlPoints?: DxfPt[];
  text?: string;
  position?: DxfPt;
  name?: string;
}
export interface DxfDoc {
  header: Record<string, unknown>;
  tables?: { layer?: { layers?: Record<string, { name: string; frozen?: boolean; colorIndex?: number }> } };
  entities?: DxfEntity[];
}

export type DxfUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft' | 'yd' | 'mi';

export interface UnitDetect {
  unit: Unit;
  method: UnitMethod;
}

/* ---------------------------------------------------------------- 常量 */

/* DXF 规范码表（Autodesk DXF Reference / ezdxf）：1=Inches 2=Feet 3=Miles 4=Millimeters
   5=Centimeters 6=Meters 7=Kilometers … 19=Yards。
   AutoCAD / Fusion 导出的 mm 图纸写的是 4 —— 以前这张表错位（1 当 mm、4 当 in），
   真实 mm 图纸会被读成英寸（25.4× 尺度错 → 240mm 墙厚变 6.1m → 整个户型读不出墙）。 */
const INSUNITS: Record<number, DxfUnit> = { 1: 'in', 2: 'ft', 3: 'mi', 4: 'mm', 5: 'cm', 6: 'm', 19: 'yd' };

/* ---------------------------------------------------------------- 单位 */

/**
 * $INSUNITS 有效 → 直接用（CAD 声明）；
 * 否则墙厚样本对量级表（common 启发式）；都不行 → 回退 mm（UI 让用户确认）。
 */
export function detectUnits(d: DxfDoc, wallThickSamplesSrc: number[]): UnitDetect {
  const raw = d.header ? (d.header['$INSUNITS'] as unknown) : undefined;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  if (Number.isFinite(n) && INSUNITS[n]) return { unit: INSUNITS[n], method: 'insunits' };
  return detectUnitsFromSamples(wallThickSamplesSrc);
}

/* ------------------------------------------------------------ 几何提取 */

interface V2 {
  x: number;
  y: number;
}
const v = (x: number, y: number): V2 => ({ x, y });
const sub = (a: V2, b: V2): V2 => v(a.x - b.x, a.y - b.y);
const len = (a: V2) => Math.hypot(a.x, a.y);

/** DXF 实体 → 原语集合（源单位、y-up、未平移）。 */
export function extractRaw(d: DxfDoc): Raw {
  const raw: Raw = {
    segs: [],
    arcs: [],
    circles: [],
    closed: [],
    skipped: { ellipses: 0, inserts: 0, texts: 0, other: 0 },
  };
  for (const ent of d.entities ?? []) {
    const cls = classifyLayer(ent.layer);
    switch (ent.type) {
      case 'LINE': {
        const vv = ent.vertices;
        if (!vv || vv.length < 2) break;
        const a = v(vv[0].x, vv[0].y),
          b = v(vv[1].x, vv[1].y);
        if (len(sub(b, a)) > 1e-6) raw.segs.push({ a, b, cls });
        break;
      }
      case 'LWPOLYLINE':
      case 'POLYLINE': {
        const pts = (ent.vertices ?? [])
          .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
          .map((p) => v(p.x, p.y));
        if (pts.length < 2) break;
        if (ent.shape && pts.length >= 3) {
          if (cls === 'wall' || cls === 'door' || cls === 'window') {
            // 墙/门/窗层的闭合折线 = 墙面/门扇/窗框轮廓（真实 CAD 常用面表达墙）
            // → 逐边（含闭合边）入候选：相邻两边互相配对出真实墙厚；
            // 若只当多边形（closed）就永远进不了墙带配对（hack_canada 集成用例暴露）
            const nPts = pts.length;
            for (let i = 0; i < nPts; i++) {
              const p = pts[i],
                q = pts[(i + 1) % nPts];
              const bulge = (ent.vertices?.[i] as DxfPt | undefined)?.bulge ?? 0;
              if (Math.abs(bulge) > 1e-6) {
                const arc = bulgeToArc(p, q, bulge);
                if (arc) raw.arcs.push({ ...arc, cls });
              } else if (len(sub(q, p)) > 1e-6) raw.segs.push({ a: p, b: q, cls });
            }
          } else {
            raw.closed.push({ pts, cls });
          }
          break;
        }
        for (let i = 0; i < pts.length - 1; i++) {
          const p = pts[i],
            q = pts[i + 1];
          const bulge = (ent.vertices?.[i] as DxfPt | undefined)?.bulge ?? 0;
          if (Math.abs(bulge) > 1e-6) {
            const arc = bulgeToArc(p, q, bulge);
            if (arc) raw.arcs.push({ ...arc, cls });
          } else if (len(sub(q, p)) > 1e-6) raw.segs.push({ a: p, b: q, cls });
        }
        break;
      }
      case 'ARC': {
        if (!ent.center || !(ent.radius && ent.radius > 0)) break;
        const s = ent.startAngle ?? 0;
        let e = ent.endAngle ?? 0;
        let sweep = e - s;
        if (sweep <= 1e-9) sweep += 2 * Math.PI;
        const full = sweep >= 2 * Math.PI - 1e-6;
        raw.arcs.push({ c: v(ent.center.x, ent.center.y), r: ent.radius, s, e: full ? s + 2 * Math.PI : e, cls, full });
        break;
      }
      case 'CIRCLE': {
        if (!ent.center || !(ent.radius && ent.radius > 0)) break;
        raw.circles.push({ c: v(ent.center.x, ent.center.y), r: ent.radius, cls });
        break;
      }
      case 'SPLINE': {
        const src = ent.fitPoints && ent.fitPoints.length >= 2 ? ent.fitPoints : (ent.controlPoints ?? []);
        const pts = src.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)).map((p) => v(p.x, p.y));
        if (pts.length < 2) break;
        if (ent.closed && pts.length >= 3) {
          raw.closed.push({ pts, cls });
          break;
        }
        for (let i = 0; i < pts.length - 1; i++)
          if (len(sub(pts[i + 1], pts[i])) > 1e-6) raw.segs.push({ a: pts[i], b: pts[i + 1], cls });
        break;
      }
      case 'ELLIPSE':
        raw.skipped.ellipses++;
        break;
      case 'INSERT':
        raw.skipped.inserts++;
        break;
      case 'TEXT':
      case 'MTEXT':
        raw.skipped.texts++;
        break;
      default:
        raw.skipped.other++;
        break;
    }
  }
  return raw;
}

/** bulge 边 → 圆弧（y-up；sweep = 4·atan(b) 带符号）。 */
function bulgeToArc(p: V2, q: V2, b: number): { c: V2; r: number; s: number; e: number; full: boolean } | null {
  const L = len(sub(q, p));
  if (L < 1e-9) return null;
  const th = 4 * Math.atan(b);
  const r = L / 2 / Math.sin(Math.abs(th) / 2);
  if (!Number.isFinite(r) || r <= 0) return null;
  const mx = (p.x + q.x) / 2,
    my = (p.y + q.y) / 2;
  const ux = (q.x - p.x) / L,
    uy = (q.y - p.y) / L;
  const sgn = b > 0 ? 1 : -1;
  const distMid = r * Math.cos(Math.abs(th) / 2);
  const c = v(mx - sgn * distMid * uy, my + sgn * distMid * ux);
  const s = Math.atan2(p.y - c.y, p.x - c.x);
  return { c, r, s, e: s + th, full: false };
}

/* ------------------------------------------------------------ 主入口 */

export interface ImportOptions {
  name?: string;
  /** 强制单位（用户确认框改选时传入）；缺省 = 自动检测。 */
  unit?: DxfUnit;
}

export function importDxf(d: DxfDoc, opts: ImportOptions = {}): ImportResult {
  const warnings: string[] = [];
  const raw = extractRaw(d);

  const detect = detectUnits(d, wallThicknessSamples(raw));
  const unit: Unit = opts.unit ?? detect.unit;
  const method = opts.unit ? 'user' : detect.method;
  if (opts.unit && opts.unit !== detect.unit) warnings.push(`单位按指定值 ${opts.unit}（自动检测为 ${detect.unit}）`);
  if (detect.method === 'fallback' && !opts.unit) warnings.push('无法自动判断单位（按 mm 处理）——请在左侧确认');

  return buildDocFromRaw(raw, { name: opts.name, unit, method, warnings });
}
