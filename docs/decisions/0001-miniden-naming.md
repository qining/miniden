# 0001. 项目命名：planner → MiniDen

- 日期：2026-07-17
- 状态：已接受（用户拍板）

## 背景

项目原名 `planner`（repo：`qining/planner`），过于泛化，不足以承载产品身份。
产品本质（用户原话）：**不是特别精确，主要是看东西放不放得下**——
自家房子的一个迷你模型，往里摆家具、看布局、出购物清单。
标志性画面是**娃娃屋视角**（掀掉屋顶往里看的 3D 剖切视图）。

## 决策

项目定名 **MiniDen**（中文：迷你窝）。
`den` = 舒适私人小天地（a cozy nook），与「窝」的语义对应；
娃娃屋视角成为「MiniDen 视角」。

候选排除（均实测同名撞车/域名，详见 `design/floorplan-input-and-eng-audit.md` §0.1）：
Rumplan（俄罗斯同品类服务）、Homeline / Floorform / Dwello（活跃产品）、
Planform / Trueplan / Roomline / Bostad（.com 1999–2005 已注册）、
**miniwo**（用户原案「迷你窝」pinyin——含义采纳，拼写被活跃的儿童英语 App 占用，
`.com`/`.ai` 于 2026 年接连被注册）。

## 后果

- **正面**：名字自解释（迷你 + 私人空间）；`miniden.ai` 未注册可拿，
  `miniden.com` 停放待售可收购；中文「迷你窝」顺口
- **执行**：GitHub `qining/planner` → `qining/miniden`（旧 URL 自动重定向）；
  本地目录名与 `planner.html` 文件名**暂不改**（`file://` 路径散布在
  AGENTS.md / 三个测试台 / check 脚本，全改成本不划算，等 P0-1 esbuild
  架构落地时一并定产物名）
- **风险**：无活跃同名产品（已查），但「den」是常见英语词，
  对外发布前需再做一轮商标检索（tmsearch.uspto.gov）
