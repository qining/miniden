# R2. 图片描摹 / ML 识别

日期：2026-09（研究，未实施）· 对应 roadmap S7/S8 · 关联 ADR-0003

## 1. P2：图片底图 + 磁吸描摹（浏览器内，OpenCV.js）

- **OpenCV.js 5.0**（Apache-2.0）：预构建从
  `https://docs.opencv.org/5.0/opencv.js` 直接拿；也可 `build_js.py` 白名单构建
- **体积**（issue #21431 + 构建文档实测）：
  - 默认单文件（wasm base64 内嵌）~**10-15MB**
  - 白名单（core+imgproc，只留 Canny/HoughLinesP/HoughCircles/morphology）~**1.6-2MB**
  - `--disable_single_file` 把 wasm 拆独立 .wasm（利于缓存，但破坏单文件——
    MiniDen 取舍：**懒加载**：用户上传底图时才 fetch（jsDelivr 托管或自托管），
    不进首包 796KB）
- **管线**（全部经典 CV，无 ML）：
  ```
  上传图片 → 灰度 → Canny（双阈值自适应）
  → HoughLinesP（minLineLength=墙长下限）→ 线段
  → HoughCircles（圆窗/圆柱候选）
  → 平行线对聚类 → 墙带（同 R1 的 DXF 算法，复用同一几何库）
  → 渲染成「特征层」叠加在底图上（暗带高亮）
  描摹时：笔尖/墙端点**磁吸**到特征线（现有吸附机制换数据源，AGENTS §3 的
  屏幕像素吸附半径逻辑直接复用）
  ```
- **定位**：行业兜底通道（量大质参差）——输出是「辅助线」，
  用户描摹确认，不做全自动

## 2. P3：ML 识别

### 2.1 学术 SOTA（2024-2026 抓取）

| 工作 | 方法 | 指标 | 状态 |
|---|---|---|---|
| **2408.01526**（2024，多户型） | 自训 CNN 7 类语义分割（墙/玻璃墙/栏杆/门/推拉门/窗/楼梯）→ 后处理+矢量化 → Blender 3D | **CubiCasa5k：平均 F1 0.86 / IoU 0.76**（墙 0.90/0.83，门 0.82/0.70，窗 0.90/0.82，栏杆 0.77/0.63）；跨 CubiCasa/R3D/CVC-FP/MLStruct-FP 数据集一致 | 研究代码（论文配套） |
| **Raster-to-Vector**（ICCV 系） | junction 检测 + 整数规划聚合 | 自称 **90% 精度/召回**（「进入生产区间」） | github.com/art-programmer/FloorplanTransformation |
| **Raster-to-Graph**（EG 2024） | 自回归图预测（attention transformer）→ 结构+语义图 | —（论文 PDF 二进制无法抽取细节） | 研究代码 |
| **FloorplanVLM**（2026） | VLM 直接输出结构化 JSON 拓扑 | — | 研究代码 |
| **neural_floorplan** | SegFormer 7 类掩码 → 墙图 | — | 研究代码 |

**公共数据集**：CubiCasa5k（5k 公寓）、R3D、R2V、CVC-FP、MLStruct-FP、KOVI。

### 2.2 产品级现状：Vloor（Floorplanner 的第三方服务）

**API 实测**（Floorplanner 官方文档 `floorplanner.readme.io`，2026-09 抓取，
文档提供 llms.txt + .md 版本）：

```
POST /api/v2/services/vloor/orders/create.json   (Basic AUTH)
{ project_id: int,              # Floorplanner 项目 id
  image: "https://.../image.jpg",  # ⚠ 必须是远端 URL（不能传字节）
  image_type: "sketch"|"handsketch"|"pointcloud" (默认 sketch),
  width: int32,                 # 图像宽度，关联户型比例
  name: str }
→ 200 {service_order_id} | 402 {error:"insufficient credits", payment_id} | 422
GET  /api/v2/services/vloor/orders/{id}/result.json → Floorplanner 项目
```

**对 MiniDen 的含义**：
1. Vloor 是 **Floorplanner 专属集成**：绑定对方项目 id、对方 credits、
   输出是 **Floorplanner 项目格式**（不是开放 JSON）——接入 = 用户要有
   Floorplanner 账号 + 我们做「Floorplanner 项目 → MiniDen Project 文档」转换
2. `image` 必须是**远端 URL** → 用户底图要先传到某处（隐私顾虑，住宅户型图）
3. Vloor GmbH 自己的产品是 `app.vloor.com/ai`（德语市场，「Automatisch
   Grundrisse digitalisieren mit Vloor AI」）——无公开自助 API

### 2.3 P3 路线判断

| 选项 | 评估 |
|---|---|
| 接 Vloor（via Floorplanner） | 用户门槛（账号+credits）、隐私（图传远端）、输出格式转换、第三方定价不可控——**不推荐** |
| 自训模型 + 自家云 endpoint | 数据：CubiCasa5k 等公开集可训 SegFormer（GPU 数天）；输出直接映射 Project 文档（原语，ADR-0002）；隐私可控（可 E2E 加密可选）；成本：推理用云 GPU（按需，~几美分/张）——**推荐方向** |
| onnxruntime-web 本地跑 | 模型几十 MB 与单文件灵魂（ADR-0004）冲突——排除（除非用户主动下载模型文件） |

**结论**：P3 = 「自家云函数 + SegFormer 类分割 + 矢量化后处理」，
输出 Project 文档 → 进编辑器人工修。学术指标（墙 F1 ~0.90）支撑
「初稿可用、人工修齐」的行业共识定位（ADR-0003）。
**排序最后**：P0-P2 先覆盖绝大多数场景（有 CAD/DXF 走 P1，有清晰图走 P2 磁吸）。

## 来源

- docs.opencv.org 5.0（js_intro/js_usage/js_setup）；opencv issue #21431
- floorplanner.readme.io：llms.txt / create-order / order-result / vloor / help 文章
- vloor.com（Vloor GmbH 产品页）
- arXiv 2408.01526v1（HTML 全文）；wutomwu.github.io Raster2Graph；
  github art-programmer/FloorplanTransformation；IJDAR 2025 / Automation in Construction 2025 综述（标题+摘要）
