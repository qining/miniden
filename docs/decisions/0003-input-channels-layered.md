# 0003. 户型输入通道四层递进

- 日期：2026-07-17
- 状态：已接受

## 背景

竞品调研（Planner 5D / Floorplanner+Vloor / 酷家乐 / RoomSketcher）
的一致模式：**机器出初稿、人工在编辑器里修**，没有一家宣称一键完美；
CAD 向量输入质量最高且各家都优先推荐；图片识别量最大但质量参差。
行业没有产品把「完美识别」做成卖点——人工修正是标配环节，
而我们的墙/柱/门编辑器（111 断言保护）正是这一环的最强实现。

## 决策

输入通道按质量/成本分四层，全部产出**同一份 Project 文档**
（ADR-0005），编辑器是唯一消费者：

| 层 | 输入 | 实现 | 优先级 |
|---|---|---|---|
| P0 手动绘制 | 手绘（可垫底图） | 已有 | 立即 |
| P1 DXF 导入 | .dxf | `dxf-parser`（MIT，LINE/LWPOLYLINE/ARC/CIRCLE/图层/块） | 高 |
| P1 PDF 导入 | 矢量 .pdf | `pdf.js` `getOperatorList()` → 线段聚类；扫描件检测后降级 P2 | 高 |
| P2 图片底图+磁吸 | jpg/png 户型图 | `OpenCV.js`（WASM）Canny/Hough 找墙带，描摹笔尖吸附 | 中 |
| P3 ML 识别 | jpg/png | 云端 API（自训或接 Vloor 类 SaaS）；**不进单文件** | 低（最后） |

P3 走云端的理由：onnxruntime-web 能跑 junction 检测 CNN，但模型几十 MB，
与「单文件离线」产品灵魂（ADR-0004）冲突。

## 后果

- 各通道是独立可交付的增量（roadmap R 系列 + S5/S6/S7/S8）
- 编辑器与生产者解耦：任何新通道只写「→ Project 文档」的转换器
