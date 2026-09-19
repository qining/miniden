/**
 * S6 集成 fixture 生成器（node scripts/make-pdf-fixtures.mjs）
 *
 * 手写最小 PDF（不走 PDFKit——保持 repo 零新增依赖）：
 *   tests/fixtures/integration/apartment-vector.pdf
 *     A4 landscape（842×595pt），中间一张**内部一致的 1:200** 户型图
 *     （4000×3000mm 套型 → 纸面 20×15mm = 56.7×42.5pt，几何与标注同比例）：
 *     - 黑色：外墙两圈同心矩形（间距 2.835pt = 200mm @1:200），左墙留出
 *       700mm（9.92pt）门洞缺口（内外两圈同缺口）→ 墙带 + 门洞
 *     - 黑色：两道内墙（80mm @1:200 = 1.134pt 双线带）
 *     - 红色：90° 门弧（2 段 45° cubic Bézier 近似，r = 9.92pt = 700mm）
 *     - 蓝色：窗（两道平行短线跨外墙，间距 12.735pt = 900mm @1:200）
 *     - 3 个「文字字形」式微小闭合路径（bbox ~10pt、6 点）→ 应被字形过滤器丢弃
 *     - 一条真 Tj 文字（op 列表里是文本 op，不是路径）→ 应被完全忽略
 *     - 全部内容包在 `q 1 0 0 1 392.7 276.3 cm ... Q`（CTM 平移，页心）→ 测 CTM 栈
 *     - 页面小图（FlateDecode RGB 8×8）→ imageOps=1，但矢量足够多 → 非扫描件
 *   tests/fixtures/integration/scanned-floorplan.pdf
 *     只有一张整页位图（8×8 缩放铺满）、零矢量 → 触发扫描件降级
 *
 * 两个文件都**只含 ASCII 内容流 + 最小对象结构**，无字体嵌入、无压缩内容流
 * （内容流不压缩，方便人眼核对）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.resolve(import.meta.dirname, '../tests/fixtures/integration');
fs.mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------ PDF 装配 */

function buildPdf(objects) {
  // objects: [{body, binary?: Buffer}]，编号从 1 开始
  const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [0];
  let size = parts[0].length;
  objects.forEach((o, i) => {
    offsets.push(size);
    const head = Buffer.from(`${i + 1} 0 obj\n${o.body}\n`, 'latin1');
    if (o.binary) {
      const chunk = Buffer.concat([head, Buffer.from('stream\n', 'latin1'), o.binary, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
      parts.push(chunk);
      size += chunk.length;
    } else {
      const chunk = Buffer.concat([head, Buffer.from('endobj\n', 'latin1')]);
      parts.push(chunk);
      size += chunk.length;
    }
  });
  const out = Buffer.concat(parts);
  const xrefStart = out.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++)
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  const trailer = `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.concat([out, Buffer.from(xref + trailer, 'latin1')]);
}

/* ------------------------------------------------ 矢量户型内容流（1:200） */

// 1:200：1mm 纸面 = 200mm 实际 → 1mm = 2.835pt
const mm = (v) => v / 0.3528;   // mm(纸面) → pt
// 户型 4000×3000mm @1:200 = 20×15mm 纸面
const W = mm(20), H = mm(15);             // 56.691 × 42.517 pt
const WALL = mm(200 / 200 * 1);           // 200mm 外墙 → 1mm = 2.835pt
const INWALL = mm(80 / 200 * 1);          //  80mm 内墙 → 0.4mm = 1.134pt
const DOOR = mm(700 / 200 * 1);           // 700mm 门洞/门扇 → 3.5mm = 9.92pt
const WIN = mm(900 / 200 * 1);            // 900mm 窗 → 4.5mm = 12.73pt

function arcQuarter(cx, cy, r, a0deg, a1deg) {
  // 角度递增（y-up 逆时针）的 90° 弧分 2 段 45° cubic。
  // 控制点距离 = (4/3)·tan(step/4)·r（标准 kappa），切线 = (−sinθ, +cosθ)。
  const segs = [];
  const a0 = a0deg * Math.PI / 180, a1 = a1deg * Math.PI / 180;
  const n = 2, step = (a1 - a0) / n;
  for (let i = 0; i < n; i++) {
    const b0 = a0 + i * step, b1 = b0 + step;
    const k = (4 / 3) * Math.tan(step / 4);
    const p0 = [cx + r * Math.cos(b0), cy + r * Math.sin(b0)];
    const p3 = [cx + r * Math.cos(b1), cy + r * Math.sin(b1)];
    const c1 = [p0[0] - k * r * Math.sin(b0), p0[1] + k * r * Math.cos(b0)];
    const c2 = [p3[0] + k * r * Math.sin(b1), p3[1] - k * r * Math.cos(b1)];
    segs.push([p0, c1, c2, p3]);
  }
  return segs;
}

const f = (x) => (Math.round(x * 1000) / 1000);
const ln = (x1, y1, x2, y2) => `${f(x1)} ${f(y1)} m ${f(x2)} ${f(y2)} l S`;

function vecContent() {
  const L = [];
  const cx = f((842 - W) / 2), cy = f((595 - H) / 2);   // 页心
  L.push('q');
  L.push(`1 0 0 1 ${cx} ${cy} cm`);                    // CTM：图纸放页心
  L.push('0.7 w');
  L.push('0 0 0 RG');
  // —— 外墙：外圈（y 从 0），左墙留门洞（y H/2..H/2+DOOR）——
  L.push(ln(0, 0, W, 0));                    // 下
  L.push(ln(W, 0, W, H));                    // 右
  L.push(ln(W, H, 0, H));                    // 上
  L.push(ln(0, 0, 0, H / 2));                // 左下
  L.push(ln(0, H / 2 + DOOR, 0, H));         // 左上
  // —— 外墙内圈（缩进 WALL），左墙同门洞 ——
  const o = WALL;
  L.push(ln(o, o, W - o, o));
  L.push(ln(W - o, o, W - o, H - o));
  L.push(ln(W - o, H - o, o, H - o));
  L.push(ln(o, o, o, H / 2));
  L.push(ln(o, H / 2 + DOOR, o, H - o));
  // —— 内墙：中横墙 + 中竖墙（80mm 双线带，间距 INWALL）——
  const h = H / 2, i2 = INWALL / 2;
  L.push(ln(o, h - i2, W - o, h - i2));
  L.push(ln(o, h + i2, W - o, h + i2));
  L.push(ln(W / 2 - i2, o, W / 2 - i2, h));
  L.push(ln(W / 2 + i2, o, W / 2 + i2, h));
  // —— 红色门弧：90°，r = 门扇长（700mm），铰链在门洞上端，朝内开 ——
  L.push('0.5 w');
  L.push('0.86 0 0 RG');
  const dc = o / 2;   // 左墙中线 x
  for (const [p0, c1, c2, p3] of arcQuarter(dc, H / 2 + DOOR, DOOR, 90, 180))
    L.push(`${f(p0[0])} ${f(p0[1])} m ${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p3[0])} ${f(p3[1])} c`);
  L.push('S');
  // —— 蓝色窗：两道平行短线与墙平行、跨上墙中线（间距 WIN = 900mm）——
  L.push('0.4 w');
  L.push('0 0 0.85 RG');
  const wx = W - 30, wy = H - WALL / 2;
  L.push(ln(wx, wy - WIN / 2, wx + WIN, wy - WIN / 2));
  L.push(ln(wx, wy + WIN / 2, wx + WIN, wy + WIN / 2));
  // —— 3 个「文字字形」微小闭合路径（bbox ~10pt、6 点）→ 应被过滤 ——
  L.push('0.5 w');
  L.push('0 0 0 RG');
  for (const gx of [10, 26, 42]) {
    const x = gx, y = -30;
    L.push(`${f(x)} ${f(y)} m ${f(x + 3)} ${f(y)} l ${f(x + 5)} ${f(y + 2)} l ${f(x + 8)} ${f(y + 3)} l ${f(x + 9)} ${f(y + 8)} l ${f(x + 2)} ${f(y + 10)} l h S`);
  }
  // —— 真文字（Tj：op 列表里是文本 op，不是路径 → 必须被忽略）——
  L.push('BT /F1 8 Tf 10 -44 Td (Level 1) Tj ET');
  L.push('Q');
  // —— 小图（图纸右上方 20×20pt）→ imageOps=1，但矢量足够多 → 非扫描件 ——
  L.push('q 20 0 0 20 ' + f(W + 15) + ' ' + f(H + 15) + ' cm /Im1 Do Q');
  return L.join('\n');
}

/* ------------------------------------------------ 8×8 红色位图 */

function redImage8() {
  const raw = Buffer.alloc(8 * 8 * 3);
  raw.fill(0xff);   // 全红 RGB
  return zlib.deflateSync(raw);
}

/* ------------------------------------------------ 两个文件 */

function vectorPdf() {
  const img = redImage8();
  const content = vecContent();
  const objects = [
    { body: '<</Type /Catalog /Pages 2 0 R>>' },
    { body: '<</Type /Pages /Kids [3 0 R] /Count 1>>' },
    {
      body: `<</Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources <</Font <</F1 6 0 R>> /XObject <</Im1 5 0 R>>>> /Contents 4 0 R>>`,
    },
    { body: `<</Length ${content.length}>>`, binary: Buffer.from(content, 'latin1') },
    {
      body: '<</Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ' + img.length + '>>',
      binary: img,
    },
    { body: '<</Type /Font /Subtype /Type1 /BaseFont /Courier>>' },
  ];
  return buildPdf(objects);
}

function scannedPdf() {
  // 整页位图：8×8 放大到 842×595（内容流只有 cm + Do）
  const img = redImage8();
  const content = 'q 842 0 0 595 0 0 cm /Im1 Do Q';
  const objects = [
    { body: '<</Type /Catalog /Pages 2 0 R>>' },
    { body: '<</Type /Pages /Kids [3 0 R] /Count 1>>' },
    {
      body: '<</Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources <</XObject <</Im1 5 0 R>>>> /Contents 4 0 R>>',
    },
    { body: `<</Length ${content.length}>>`, binary: Buffer.from(content, 'latin1') },
    {
      body: '<</Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ' + img.length + '>>',
      binary: img,
    },
  ];
  return buildPdf(objects);
}

fs.writeFileSync(path.join(OUT, 'apartment-vector.pdf'), vectorPdf());
fs.writeFileSync(path.join(OUT, 'scanned-floorplan.pdf'), scannedPdf());
console.log('written:');
for (const n of ['apartment-vector.pdf', 'scanned-floorplan.pdf'])
  console.log(' ', path.join(OUT, n), fs.statSync(path.join(OUT, n)).size, 'bytes');
