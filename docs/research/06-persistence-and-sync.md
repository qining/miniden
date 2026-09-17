# R6. 持久化与同步

日期：2026-07（研究）· 关联 roadmap E10

## 1. 现状与问题

| key | 内容 | 大小 |
|---|---|---|
| `planner_v1` | 家具布局（GEO_VERSION 闸门） | KB 级 |
| `planner_userGeo_v1` | 用户墙体/门编辑（**索引寻址**，ADR-0005 将废除） | KB 级 |
| `planner_panels_v1` | 面板宽度/折叠 | <1KB |

- localStorage：**5MB 同步 API**——文档本身没问题，但未来**底图图片**
  （用户户型图 jpg）会爆；同步写入在主线程（大 key 卡顿）
- **结论：换 IndexedDB（异步、几百 MB）**，前面加 `storage.js` 门面
  （接口不变），三个现有 key 一次性迁移（R6 与 E10 同一工作项）

## 2. 导入/导出（v1 必须有）

- **导出**：Project 文档 JSON（schema v1，人类可读，可 git 管）
  + 底图可选打包（ZIP：`doc.json` + `bg.jpg`）
- **导入**：JSON 走 `migrate(doc)` 迁移链（E3）；ZIP 解包
- 文件命名：`<项目名>-<日期>.miniden.json`

## 3. 云同步（v2+ 才考虑，记录选项即可）

| 方案 | 评估 |
|---|---|
| 简单 CRUD（自家云函数，doc 整体覆盖 + 时间戳） | 单用户产品够用最省；冲突 = last-write-wins（可接受） |
| CRDT（Yjs） | 多设备/多用户实时协作才需要；Yjs 可跑 IndexedDB/Webrtc/WebSocket——**留作未来选项**，v1 不引入 |
| 「分享链接」 | doc JSON → URL（短链/二维码）让朋友看 3D——**低成本高传播**，v2 可做（doc 小，base64 进 hash） |

## 4. 隐私底线

- 户型数据（含底图）默认**只在本机**；任何上传（Vloor 类、云同步）
  必须是显式动作 + 明确提示（R2 已发现 Vloor 强制远端 URL 的问题）
- 底图压缩后存（<200KB/张，IndexedDB blob），不进 JSON 导出默认内容

## 来源

- Web 存储现状（MDN：localStorage 5MB / IndexedDB quota）
- Yjs（yjs.dev）；R2 中 Vloor API 的隐私观察
