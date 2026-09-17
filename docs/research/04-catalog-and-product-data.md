# R4. 家具目录与商品数据

日期：2026-07（研究）· 关联：catalog/ 模块、275 条目现状

## 1. 商品数据来源（以 IKEA 为主目录）

- **IKEA 没有官方公开开发者 API**（2026-07 多源确认：api-evangelist/ikea
  「IKEA does not publish an official public developer API」；内部 Knowledge
  Hub `knowledge.ikea.net` 不对公众开放）
- **社区逆向 OpenAPI**（`idelsink/ikea-openapi`，MIT）：
  Search / Product Catalog / **Sales Item（实时库存/价格）** / After-Purchase
  Ordering，均针对 `www.ikea.com/{country}/{lang}` storefront 接口
- **MiniDen 现状做法**（保持）：Chrome 渲染抓埋点（`product_prices`）+
  cdtapps 站内搜索 API（AGENTS §5.4.1）——**不走逆向 API**：
  逆向接口无 SLA、有 ToS 风险，且我们只需低频补价（目录数据入库时抓一次，
  不是运行时依赖）
- 非 IKEA 商品（Amazon/Shopify 独立站）：现有抓法照旧
  （`public_title`/`priceAmount`/`dimensionValuesDisplayData`，AGENTS §8.1）

## 2. 竞品目录形态（定性）

| 产品 | 目录特点 | 护城河 |
|---|---|---|
| Planner 5D | 大而全的通用库（品牌+通用件混合），拖放 | 数量 + 云同步 |
| HomeByMe | 品牌合作目录（真实 SKU、真实价） | 品牌合作网络 |
| 酷家乐 | 商家生态（商家自传模型+商品链接，导购闭环） | 国内商家生态 + 施工图 |
| **MiniDen（我们）** | **逐件手工建模**（商品图对照，2000-15000 三角/件）+ **真实双币价格** + 采购清单 | **单件保真度 + 采购闭环**（不是「有模型」，是「这件就是这个样、这个价」） |

## 3. GLTF vs 程序化建模（单文件约束下的算术）

- 单件 GLTF（带贴图）合理体积 **100KB–2MB**；275 件全量 ≈ **30–50MB**
  → 内联进单文件 = 不可行（现状整个产物 796KB）
- 运行时 fetch GLB = 破坏「双击即开、离线」（ADR-0004）
- **程序化**（现状：`MODELS` 注册表 + `modelCtx` API + 程序化 CanvasTexture，
  固定种子可回归）= 796KB 承载 275 件 + 照片级渲染——**保持，这是差异化**
- 体积预算：新增 10 环境预设 HDRI 可选加载（~3MB 懒加载）；
  目录缩略图按需渲染 + 缓存（现状 `furnThumb`，不变）

## 结论

目录体系**不换方向**：程序化建模 + 人工采集价格。
工程上：`catalog/` + `models/` 独立模块（E1 迁移时先拆，纯数据+函数，
最容易搬）；`furniture_specs.json`（采集数据）继续做模型重建的数据源。

## 来源

- apis.io / api-evangelist/ikea / idelsink/ikea-openapi（2026-07 抓取）
- 竞品：AGENTS.md §2 与 research doc §2（前次调研）；酷家乐帮助中心
