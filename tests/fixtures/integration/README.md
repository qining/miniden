# 真实 DXF 集成测试夹具（S5）

**用途**：`tests/geo/integration-real-dxf.test.ts` 用这些「别人的」真实 DXF 文件
验证 importer 在真实数据上不崩、优雅降级、并锚定真实数据暴露的缺陷修复。
与 `../apartment-mm.dxf` / `apartment-cm.dxf`（本项目自造、尺寸已知的单测夹具）
互为补充：**单测锚行为，集成测锚鲁棒性**。

**维护约定**：只增不删；改 importer 后这些测试必须全绿。断言值变化时先判断
是 importer 回归还是夹具漂移，再决定改哪边。

## 来源与许可证

| 文件 | 体积 | 版本 | 内容 | 来源 | 许可证 |
|---|---|---|---|---|---|
| `hack_canada_building.dxf` | 220KB | AC1027 (R2013) | 6 层混合用途建筑（ezdxf 生成）：闭合 LWPOLYLINE 墙面轮廓（0.15/0.2yd 厚）、131 个房间边界、48 根柱、150 个门/窗块引用、`$INSUNITS=6`(yd) | GitHub 公开仓库样例（Hack Canada / ezdxf 示例工程） | 公开仓库样例，内部测试用途 |
| `libredwg_example_2018.dxf` | 826KB | AC1032 (R2018) | 意大利建筑图样（LibreDWG 示例）：363×216m 大尺度、`$INSUNITS=4`(in)、3DFACE/DIMENSION/椭圆、11 个房间闭合环 | LibreDWG 官方 example（github.com/LibreDWG/libredwg，`example/`） | LGPL-2.1+（LibreDWG 仓库） |
| `qcad_example00.dxf` | 155KB | AC1024 (R2010) | QCAD 官方示例 00（教学图）：`$INSUNITS=4`(in)、量级正常 | QCAD 官方 sample（github.com/QCAD/qcad，`samples/qcad-dxf`） | GPL-2（QCAD 仓库） |
| `qcad_entities.dxf` | 190KB | AC1024 (R2010) | QCAD 实体样例：`$INSUNITS=0`（无单位信息，走启发式）、色样 `colors` 层、29 个块引用 | 同上 | GPL-2（QCAD 仓库） |

均为公开仓库下载（2026-07 抓取）。如上游文件更新导致断言漂移，按上表重新
下载并核对断言（优先修 importer，其次更新断言并注明原因）。

## 这些文件为什么有价值

1. **闭合墙面轮廓**：hack_canada 的墙是 4 点闭合矩形（外墙面 0.2yd 厚、
   内隔墙 0.15yd 厚）而不是平行双 LINE。自造 fixture 只覆盖双 LINE，
   「轮廓边对边配对」这条路只有它覆盖。
2. **INSUNITS 覆盖**：6(yd)、4(in)、0(无) 三种此前未测的取值。
3. **版本跨度**：R2010 / R2013 / R2018 三个 AC 版本。
4. **脏数据**：3DFACE / DIMENSION / 椭圆 / 块引用 / 150+ 实体层——
   importer 必须跳过而不崩。
5. **误判层名**：QCAD `colors` 色样层 vs `S-COLS` 柱层的分类边界。

## 已知局限（这些文件暴露、尚未修，属文档化行为）

- **块引用（INSERT）不展开** → 门/窗符号在块里的图（hack_canada 全部 150 个
  门/窗块）得不到门窗；warning 如实报告数量。修复方向 = 展开块引用
  （dxf-parser 的 `blocks` 字段已有数据）。
- **大尺度图**（363m×216m）：导入「成功」但量级偏大警告——用户确认框会显示，
  用户可手动改单位。
- **椭圆的 `end` 角度缺失**：dxf-parser 对 ELLIPSE 只解析 `aend` 不解析
  `end`，按整椭圆跳过并计数警告。
