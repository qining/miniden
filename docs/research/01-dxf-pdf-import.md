# R1. DXF / PDF 向量导入深潜

日期：2026-07（研究，未实施）· 对应 roadmap S5/S6 · 关联 ADR-0003

## 1. DXF 解析：dxf-parser 1.1.2

- **包**：`dxf-parser`（npm，**MIT**，~40KB；repo 现挂在 `gdsestimating/dxf-parser`）
- **浏览器可用**：纯 JS 解析器，读 .dxf 文本 → 一个大 JS 对象
- **支持范围**（README "What's Supported"）：
  - `header`（含 `$INSUNITS`、`$INSBASE`、`$EXTMIN/$EXTMAX` 等）
  - **大多数 2D 实体**（LINE / LWPOLYLINE / ARC / CIRCLE / SPLINE / TEXT / 部分 MTEXT / 3DSolids / 各种 Leader / 其他少见对象）
  - **layers**（name/visible/color）、LType 表、**块表 + insert**（含插入点/比例/旋转）、VPort 表、部分 XData
- **输出结构**（wiki Example-Output 实测）：

```js
{
  header: { "$ACADVER":"AC1027", "$INSBASE":{x,y,z}, "$EXTMIN":{x,y}, "$EXTMAX":{x,y}, ... },
  layers: { "0": {name, visible, color}, "WALLS": {...}, ... },
  ltypes: { ... pattern ... },
  blocks: { "*U34": { position:{x,y,z}, entities:[ {type:"LINE", vertices:[{x,y,z},{x,y,z}], layer}, ... ] } },
  entities: [ { type:"LINE", layer, vertices:[{x,y},{x,y}] },
              { type:"LWPOLYLINE", layer, vertices:[{x,y}...], closed?, bulge? },
              { type:"ARC", layer, center:{x,y}, radius, startAngle, endAngle }, ... ]
}
```

- **$INSUNITS 标准值**（AutoCAD 规范）：`0=未指定, 1=mm, 2=cm, 3=m, 4=英寸, 5=英尺, 6=英里`
- **不支持 DWG**（二进制格式，浏览器内无可靠解析器）——酷家乐的 DWG 支持是服务端转 DXF/T3 后做的。我们：**只收 DXF，DWG 提示用户另存为 DXF**

### 单位自动检测（照抄酷家乐 + 加固）

酷家乐帮助中心（2026-07 抓取）的实际规则：
1. 支持 mm / m / 英尺 / 英寸 绘制的图纸，**导入时自动检测 CAD 单位**，导入弹窗二次确认
2. 经验判据：**测墙厚 ≈240 → mm；≈24 → cm**（240mm 标准砖墙）；不是支持单位就用 SC 命令缩放
3. 文件限制：免费档 **DWG ≤5MB / DXF ≤10MB**，付费档 30MB；多户型文件弹选择框；
   清理建议：删立面图/轴网/尺寸标注、XREF 要先绑定、模型空间冻结的图元要解冻
4. 其「模袋云」识别服务只收 mm

**MiniDen 的检测算法**（浏览器内，零服务依赖）：
```
1) 读 $INSUNITS ≠ 0 → 直接用（标注来源=CAD 声明）
2) 否则取最长墙段簇的间距/墙带宽度，匹配 {240, 24, 2.4, 0.24, 9.4, 0.94 ...} 量级表
   （240=mm, 24=cm, 2.4=m, 9.4=inch, 0.94≈ft, 2400=cm 画成 mm 值 ...）
3) 与 $EXTMAX 量级交叉验证（公寓户型通常 < 30m）
4) 弹窗给用户确认「检测为毫米，整图 12.4m×8.2m ✓/✗」——最终拍板权在用户（行业通行做法）
```

### DXF → Project 文档（ADR-0002 原语直通）

| DXF 源 | 映射 |
|---|---|
| 平行线对（同图层、共线、偏移 t） | `wall` 厚 t（墙带中线 + thick） |
| 单线（墙中心线惯例） | `wall` 厚 = 默认值（属性面板可调） |
| `LWPOLYLINE` 闭合多段线 | `polygon`（柱/异形）或房间轮廓 |
| `ARC` | `arc` 原语（弧墙 / 门摆幅） |
| `CIRCLE` | `arc(360°)`（圆柱 / 圆窗） |
| 块插入（图层名含 DOOR/门） | `door`（符号宽 → width，摆幅弧 → side/hinge） |
| 图层名 | 语义提示：WALL/墙 / DOOR/门 / WINDOW/窗 / COL/柱 / FURN/家具（仅提示，用户可改） |

**已知难点**：天正导出的 DXF 图层名混乱（用图层颜色兜底分类）；
墙带「中线 vs 边线」两种画法（检测：线段成对平行且间距恒定 → 边线对，取中线）。

## 2. PDF 向量导入：pdf.js `getOperatorList()`

- **包**：`pdf.js`（**Apache-2.0**，Mozilla；npm `pdfjs-dist`，浏览器 build ~350KB+worker）
- **关键 API**（源码 `src/display/api.js` 实测）：
  `page.getOperatorList({intent:'display'|'print'|'any', annotationMode})`
  → `Promise<PDFOperatorList>`：`{fnArray:[op,...], argsArray:[[...],...]}`
- **OPS 常量**（`src/shared/util.js`，实测值）：
  `save=10, restore=11, transform=12, moveTo=13, lineTo=14, curveTo=15, curveTo2=16, curveTo3=17, closePath=18, rectangle=19, stroke=20, fill=22`
- **提取管线**：
  ```
  遍历 ops：维护 CTM 栈（save/restore/transform）
  moveTo/lineTo → 线段（乘当前 CTM）
  curveTo/curveTo2/curveTo3 → 采样成线段链（弦高阈值，ADR-0002：展开只在消费端，
     但 PDF 贝塞尔是「输入」，入库前需拟合——见下）
  rectangle → 4 线段
  过滤：丢弃 <2% 页面最短边的线段（噪点）、丢弃纯文字路径（bbox 密度启发式）
  聚类：平行线对 → 墙带（同 DXF 算法）；端点聚类 → junction
  ```
- **坐标注意**：PDF 原点左下、y 向上 → 导入时翻 y（我们图纸 y 向下）
- **扫描件检测**：`page.getOperatorList()` 里若几乎只有 `paintImage`（大图）、
  没有 moveTo/lineTo → 判定扫描件 → 弹提示「这是扫描图，转走图片描摹通道（P2）」
- **贝塞尔→原语**（保持 ADR-0002 无损）：入库前做**弧拟合**
  （3 点/最小二乘圆拟合：残差 < 弦高 20% → `arc` 原语，否则折线——
  折线只在「本来就不是弧」时入库，属于内容属性而非近似损失）

## 3. 结论与风险

| 项 | 判断 |
|---|---|
| dxf-parser 满足 S5 | ✅ 实体/图层/块/头变量全有；~40KB 进 bundle 无压力 |
| pdf.js 满足 S6 | ✅ operatorList 是官方 API；worker 需内联（单文件约束，esbuild worker 内联或 Blob URL） |
| 单位检测 | 酷家乐启发式（墙厚 240/24）+ $INSUNITS + 用户确认弹窗 = 三保险，与行业做法一致 |
| DWG | ❌ 不做（浏览器内无解）；提示另存 DXF |
| 天正/T3 | ❌ 不做（私有格式）；提示转 DXF |
| 风险 | 真实户型 DXF 质量参差（图层乱、线碎、符号非标准）→ **导入后一律进编辑器人工修**（ADR-0003 的机器出初稿定位），不做「自动完美」 |

## 来源

- dxf-parser README / wiki Example-Output（cdn.jsdelivr.net/npm/dxf-parser@1.1.2）
- pdf.js 源码 `src/display/api.js`、`src/shared/util.js`（github master，2026-07 抓取）
- 酷家乐帮助中心：上传户型 CAD 要求 / 如何提高图纸识别效率 / 如何导入 CAD / 如何清理 CAD 图纸（kujiale.com/hc，2026-07 抓取）
