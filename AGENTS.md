# AGENTS.md — 公寓家具规划器开发指南

写给接手这个 repo 的 AI agent。这份文档记录**实测有效的流程、踩过的坑、以及验证方法论**。
读完再动手，能省掉大量返工。

---

## 0. 这是什么

单文件 Web 应用 `planner.html`（约 4800 行，284KB），给一套**西雅图市中心 33 层 2室2卫公寓**做家具规划：

- **2D SVG 平面编辑器**：拖放家具、编辑墙体/门/柱、标准建筑图例
- **3D 渲染**（Three.js r147，本地 `lib/`，离线可用）：娃娃屋视角 + 室内第一人称漫游
- **照片级渲染**：GPU 浮点渐进累积（软阴影/环境光/抗锯齿）
- **家具库**：126 个目录条目，其中 14 件按官网商品图**逐件建模**

依赖只有 `lib/three.min.js` 和 `lib/OrbitControls.js`（已本地化）。没有构建步骤，直接用浏览器打开。

### 0.1 仓库自带的 agent 资产（都随 git 走）

| 路径 | 是什么 |
|---|---|
| `.claude/skills/add-catalog-item/SKILL.md` | **加家具/灯具/地毯/游具入库的作业指导书**（唯一一份，下面两个 agent 都读它）。详细版是本文 §8.1，冲突以 §8.1 为准 |
| `.claude/skills/add-catalog-item/check-item.py` | 单件体检 + 全量回归：`python3 .claude/skills/add-catalog-item/check-item.py <条目id>` / `--regress` |
| `.agents/skills` → `../.claude/skills` | **给 pi coding agent 用的软链**（git 存 mode 120000）。pi 只扫 `.agents/skills`，不认 `.claude/`；Claude Code 反过来不认 `.agents/`。软链让两边共用同一份文件，改一处两边同时生效 |
| `.claude/settings.json` | 项目级设置。Claude Code 的 **subagent 并发上限锁成 1**（`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`） |
| `work/t_walledit.html` `work/t_3d.html` `work/t_pt.html` | 三个自动化测试台（§3） |
| `work/headful_test.py` | 真显卡光追验证（§5.5） |
| `work/layouts/*.json` | 4 套压力测试布局 |

**两个 agent 的差异**（实测自 pi 0.85.1 / Claude Code 2.1.233 的安装源码）：

| | Claude Code | pi |
|---|---|---|
| 读哪个指令文件 | `CLAUDE.md` | `AGENTS.md`（候选序 `AGENTS.override.md → AGENTS.md → AGENTS.MD → CLAUDE.md`，同目录只取**第一个**命中）|
| skill 目录 | `.claude/skills/` | `.agents/skills/`（从 cwd 逐级上溯**到 git root 为止**）或 `.pi/skills/`（只认 cwd 那一层）|
| 首次加载 | 直接可用 | **要先信任项目**：交互模式跑一次 `/trust` 然后重启；非交互（`-p` / `--mode json` / `--mode rpc`）不弹框，必须显式加 `--approve`，否则**静默不加载、不报错** |

所以给 pi 看的约束必须写进 `AGENTS.md`（本文），写进 `CLAUDE.md` 它看不到。

---

## 1. 铁律（违反会造成不可逆损失）

### 1.1 `#calib` 校准输出必须逐字节不变

户型几何经过 **30 轮独立 AI 审查迭代**才与官方图纸对齐（最终 PASS）。任何改动之后必须验证：

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless --disable-gpu --screenshot=/tmp/ck.png --window-size=2400,1500 \
  --virtual-time-budget=9000 "file:///Users/dako/planner/planner.html#calib" 2>/dev/null
sips -c 1360 1674 --cropOffset 72 369 /tmp/ck.png --out /tmp/ckc.png >/dev/null 2>&1
md5 -q /tmp/ckc.png
# 必须等于 1ac26921871db50ef1c055674c10e6e7（基线 r31）
```

**新增的视觉元素一律不能进 calib 视图**。做法：
- FIXED 条目加 `noCal:true`
- 或在绘制处判断 `if(!CALIB) ...`
- 或让 CALIB 分支沿用原来的颜色（例：中岛描边写成 `stroke:CALIB?'#4a5058':'#6b655d'`）

如果确实要改动户型几何（用户明确指出图纸有误时），必须：
1. 记录**意图坐标**（不是"以底图为准"，而是明确写出这段几何应该是什么）
2. 更新基线 md5 并在提交信息里说明
3. 已有先例：西北斜墙落地窗带按实拍照片覆盖官方图（豁免区 plan x<135, y150-290）

### 1.2 两个版本号不能混用

| 常量 | 作用 | 何时 bump |
|---|---|---|
| `GEO_VERSION`(=3) | 家具存档 `planner_v1` 的版本闸门 | 户型坐标系变动 |
| `USERGEO_VERSION`(=1) | 用户墙体编辑 `planner_userGeo_v1` | **内置 WALLS/FIXED 条目顺序或增删变动时** |

`USERGEO.hiddenW/ovW/hiddenP/ovP/hiddenD/ovD` 都是**按数组下标寻址**的。往 `WALLS` 中间插一段墙就会让用户的覆盖错位。当初这两个共用一个常量，bump 一次会连带清空用户手工录入的自定义家具（不可找回），已解耦。

### 1.3 用户明确说过的偏好

- **默认空白**：打开时不预置任何家具，参考方案只放在下拉里
- **永远给完整 URL**：`file:///Users/dako/planner/planner.html#3d`，不要写相对路径
- 实拍照片 `704.jpg`/`705.jpg` 是**实际单元**（深色地板）；`708.jpg` 是样板间（浅地板）——**以实拍为准**

---

## 2. 开发流程（每次改动都走一遍）

```bash
cd /Users/dako/planner

# 1) 改代码（见 §7 编辑技巧）

# 2) 语法检查——必做，比打开浏览器快得多
python3 -c "
import re
html = open('planner.html').read()
m = re.search(r'<script>\n(.*?)</script>', html, re.S)
open('/tmp/planner_check.js','w').write(m.group(1))
" && node --check /tmp/planner_check.js && echo "SYNTAX OK"

# 3) 交互测试台（46 条断言，见 §3）
# 4) 校准回归（§1.1）
# 5) 视觉验证（截图 + 放大目检，见 §4）
# 6) commit（用户没要求就不要 push；要 push 时先确认）
```

**绝不能**只做截图冒烟就认为交互功能可用。教训见 §5.1。

---

## 3. 自动化交互测试台（最重要的资产）

从 `planner.html` 生成的测试副本，注入一段测试脚本，用
**真实命中测试 + 合成 PointerEvent** 驱动 UI。**两个测试台，改完都要跑**：

| 文件 | 覆盖 | 断言 | 输出 `<pre id>` | 抽取锚点 | 窗口 / virtual-time |
|---|---|---|---|---|---|
| `work/t_walledit.html` | 2D：墙/柱/门编辑、门垛联动、拖动中删除、搜索折叠、双币种、三档视图/单位/量尺寸/面板、光追画质对话框 | 111 | `wetest` | `window.__ERRS` | 1700x1100 / 80000 |
| `work/t_3d.html` | 3D：射线拾取/拖动/旋转、开关灯、**全目录建模+贴图体检**、缩略图、镜子/新家具、双击进室内、座椅重做体检 | 41 | `t3d` | `window.__E3` | 1400x950 / 170000 |
| `work/t_pt.html` | 光追：BVH 校验、着色器、进度、降噪、萤火虫/NaN 判别、分块自适应、**白家具可辨识度**（跑在满家具客厅上） | 32 | `tpt` | `window.__EPT` | 1200x850 / 600000 |

`t_3d.html` 里那组 `catalog-*` 断言是**最省事的整体体检**：把 CATALOG 每一条都跑一遍
`furn3D()`，断言（a）不抛错（b）材质都有 `map`（c）都有 `normalMap`（d）三角形数不失控。
加家具、改材质之后先看这四条，比逐个截图快得多。

**两个测试台不能合并**：2D 全套跑完再构建 3D 场景会超出单次 `--virtual-time-budget`，
页面根本不输出结果（症状是 `NO TEST OUTPUT`，很容易误判成页面崩溃）。
每次跑之前先 `pkill -f headless`，否则上一轮的 swiftshader 僵尸进程抢 CPU 把本轮拖超时。

**`t_pt` 的 `pt-kallax-visible` 探针会偶发全黑**（均值 0 / 标准差 0，headless 瞬态）：
单跑一次 FAIL 时**原样重跑一次**再下结论，不要按它改代码。

### 重新生成（改了 planner.html 之后必做）

```bash
python3 - <<'PYEOF'
import re
s = open('planner.html').read()
for f, mark in [('work/t_walledit.html', r'window\.__ERRS'), ('work/t_3d.html', r'window\.__E3')]:
    m = re.search(r"(\n<script>\n" + mark + r".*?</script>\n</body>)", open(f).read(), re.S)  # 抽出测试脚本
    open(f, 'w').write(s.replace('</body>', m.group(1), 1)
      .replace("'work/clean_plan.jpg'", "'clean_plan.jpg'")   # 测试页在 work/ 下，改相对路径
      .replace("lib/three.min.js", "../lib/three.min.js")
      .replace("lib/OrbitControls.js", "../lib/OrbitControls.js"))
PYEOF
```

### 运行

```bash
"$CHROME" --headless --use-angle=swiftshader --allow-file-access-from-files \
  --dump-dom --virtual-time-budget=55000 --window-size=1700,1100 \
  "file:///Users/dako/planner/work/t_walledit.html" 2>/dev/null | python3 -c "
import sys,re,html
t=sys.stdin.read(); m=re.search(r'<pre id=\"wetest\">(.*?)</pre>', t, re.S)
r=html.unescape(m.group(1)) if m else 'NO TEST OUTPUT'
lines=r.split(chr(10)); fails=[l for l in lines if l.startswith(('FAIL','EXC'))]
print('tests:',len([l for l in lines if l.startswith(('PASS','FAIL'))]),'| fails:',len(fails))
for f in fails: print(f)
print(lines[-1])"
```

3D 测试台同理，换文件名、`<pre id=t3d>` 和窗口大小 `1400,950`、预算 `50000` 即可。

### 写测试的关键手法

```js
// 真实命中：用 elementFromPoint 找到实际接收事件的元素
const fire=(type,cx,cy,extra)=>{ const tgt=document.elementFromPoint(cx,cy)||svgEl;
  tgt.dispatchEvent(new PointerEvent(type, Object.assign({clientX:cx,clientY:cy,
    bubbles:true,cancelable:true,pointerId:1,isPrimary:true,button:0,buttons:1}, extra||{}))); };

// 图纸坐标 → 屏幕坐标
const SPT=(fx,fy)=>{ const ctm=svgEl.getScreenCTM();
  const p=new DOMPoint(fx*S, fy*S).matrixTransform(ctm); return [p.x,p.y]; };

// headless 里 setPointerCapture 会抛，先打补丁
const origCap=Element.prototype.setPointerCapture;
Element.prototype.setPointerCapture=function(id){ try{ origCap.call(this,id); }catch(e){} };
```

**断言里不要写死材质颜色常量**——改了材质就会假失败。已经因为这个踩过两次（门材质调色后测试红）。要么断言结构（mesh 数量、类型），要么改材质时同步更新测试常量。

---

## 4. 验证方法论（按可靠性排序）

### 4.1 像素探针（最可靠，用于几何校准）

写一个临时 HTML 用 canvas `getImageData` 扫描暗带边缘，Chrome headless `--dump-dom` 读结果：

```js
const files = ['ov_r30.png','img_plan.png'];       // 叠加图 vs 纯底图，同帧同坐标
const probes = [ ['row',Y,X0,X1], [X,Y0,Y1] ];     // 行扫 / 列扫
// lum<120 判为暗；输出每条扫描线上的暗带区间
```
`OVL` = 矢量+0.6透明底图的并集，`IMG` = 纯底图。比较边缘位置差即偏差。
底图抗锯齿有 1-2px 毛边，**用多条探针取中位**，不要单点定论。

### 4.2 坐标映射标定（不要反解，要正向标定）

千万别从墙特征反解图纸→像素的映射（多解且易错）。正确做法：在副本里于**已知图纸坐标**画 4 个绿色标记点，同管线截图后聚类定位，一次解出：

```
ov = plan × 2.8165 + (4.7, 7.9)      # 对应 2400×1500 截图裁 (369,72) 1674×1360 的标准管线
```

### 4.3 连通域 / Hough / 网格叠加

- **连通域**：找洁具、找孤立色块（注意洁具轮廓常与墙连通，会合并成大块）
- **Hough 变换**：用户在图上画的标注线 → 精确直线方程（做过：从用户手绘橙线解出门线斜率 0.450）
- **网格叠加**：把图纸坐标网格画在底图上直接读数（比目测强，但不如探针精确）

### 4.4 视觉目检（必要但不充分）

```bash
sips -c 高 宽 --cropOffset Y X 输入.png --out /tmp/x.png    # 注意参数顺序！offset 为 0 时要写 1
sips -z 高 宽 /tmp/x.png --out /tmp/x_big.png               # 放大
```
然后 `Read` 图片。**小裁剪会误判**——曾因裁得太小把连续的墙看成断开，扩大裁剪范围后发现是好的。

---

## 5. 踩过的坑（血泪清单）

### 5.1 流程类

| 坑 | 后果 | 正确做法 |
|---|---|---|
| 只做截图冒烟就交付交互功能 | 用户反馈"根本不工作" | 必须写自动化交互测试台 |
| macOS **没有 `timeout` 命令** | rc=127，命令根本没跑，`echo done` 掩盖了失败，看到的是旧文件 | 不要用 `timeout`；检查 rc |
| 测试页是改动前生成的副本 | 测出旧行为，浪费一轮调试 | 每次改完 planner.html 都重新生成测试页 |
| 批量 replace 时文本已漂移 | 静默 MISS | 每次 replace 都统计 miss 数并打印 |

### 5.2 浏览器/three.js 类

| 坑 | 症状 | 修法 |
|---|---|---|
| **CanvasTexture 没设 sRGB** | 贴图渲染发白、颜色不对 | `t.encoding=THREE.sRGBEncoding` |
| **ExtrudeGeometry 的 bevelSize 向外扩张** | 圆角体实际尺寸比请求大 2r | 基形先缩 2r（`rboxGeo` 已修） |
| **跨 WebGL 上下文共享纹理** | 渲染出全黑图 | 最终合成必须用同一个 renderer |
| **rAF 在无合成帧时被饿死** | 场景永不构建 / 动画卡住不动 | 关键路径改用 `setTimeout` 派发 |
| **OrbitControls 参与第一人称朝向** | 转头时相机升高、到边界后方向翻转 | FP 模式 `controls.enabled=false`，直接 `cam.lookAt` |
| `cross(fwd, up)` 就是"右" | WASD 左右相反 | 不要再 `.negate()` |
| ShapeGeometry 绕 X 转 +90° 后法线朝**下** | 天花板用 BackSide 会从上方可见、挡住俯视 | 用 FrontSide |
| 材质 `envMapIntensity` 太高 | 白墙"发光"、像自发光 | 墙面用 MeshPhysical + `specularIntensity:.05`, `envMapIntensity:.10`, `roughness:1.0` |
| 光源用 SpotLight 窄角 | 像舞台射灯，不像家里 | 家用灯具主体用 PointLight（全向）；筒灯叠 75° 宽角 + `penumbra:0.92` |
| `physicallyCorrectLights` 下强度是坎德拉 | 灯几乎不亮 | 点光 `I=lm/(4π)`；聚光 `I=lm/(2π(1-cosθ))` |
| 工具条高度变化（控件出现/文字换行） | 画布跳动、缓存的屏幕坐标失效 | 编辑类工具条固定单行高度（`nowrap`+`ellipsis`+定高），控件用 `visibility` 占位切换 |
| 工具模式的早退分支 | "加门模式下拖端点"完全失效 | 手柄/拖拽检测必须在工具分支**之前**；move 的早退要加 `&& !drag` |
| **Raycaster 不刷新 `matrixWorld`（r147）** | 刚移动完家具再点，射线打空或打到旧位置；按需渲染下尤其明显 | 射线前显式 `group.updateMatrixWorld(true)`（相机也要），不能指望 `renderer.render()` 已经跑过 |
| 俯视时吸顶灯永远挡在射线最前 | 娃娃屋视角点不中灯下方的沙发 | `pickFurniture` 命中链里优先取非灯具，全是灯才回退取灯 |
| **本机 3D 截图** | 黑屏 | 用 `--use-angle=swiftshader`（不带 `-webgl` 后缀），`--virtual-time-budget` 20000-30000；大 budget 会留下 400% CPU 僵尸进程，必要时 `pkill -f headless` |

### 5.3 几何/建模类

- **`sips` 的 `--cropOffset 0 0` 会被当成未设置** → 变成居中裁剪。用 1 代替 0。
- **`grep -o` 统计中文分类会误报**（多字节+空格），用 python `re.findall` 统计。
- **SVG `stroke-linecap` 必须是 `butt`**，`square` 会让每段墙端头外伸半个描边宽，系统性吃掉门洞。
- **墙体要画成实心多边形而不是描边线**：line+butt 在 T 型口/转角必留豁缝、厚度突变必出台阶。`wallPolys()` 做端头咬合。
- **T 型口延长量**：延长到对方远侧面时，斜交情况下端头矩形的横向半宽会斜着冒出对面，要扣除投影 `(o.half - w.half*sqrt(1-den²))/|den|`。
- **只有共线墙垛才跟随门移动**：垂直墙被绝对赋值会被拉斜；改成记录初始偏移、按增量平移。
- **夹取区间必须包含 0**：`range()` 返回反向区间时会把门推向相反方向。
- **条形/定向部件容易整轴写反 90°**（T 脚、板条、边带、臂、杆）：
  正面 3/4 视角下两个方向长得几乎一样，只有侧视图能露馅（且侧视图透视也
  容易看错，曾把居中的底架看成偏前）。建模前必须在 brief 里写死
  「沿哪个世界轴、平行长边还是短边」，建模后用**侧视角渲染图**核对，
  拿不准就逐 child 打 bbox 验证（`?nomerge`）。
- **可伸展/带达臂的件，占地必须含最大伸展**（臂灯、伸缩桌、可旋转件）：
  spec `w/d` 取官方 Length/reach，不是机身尺寸。RANARP 落地灯曾只录机身
  28×28，实际臂长 76cm——这类 spec 要**改目录条目本身**（note 里注明口径），
  不能在模型里把臂缩小去迁就错误的 spec。

---

## 5.4 材质与贴图（2026-09 补齐）

`planner.html` 里所有贴图都是**程序化生成的 CanvasTexture**（离线可用、可确定性复现）：

| 函数 | 用途 | 备注 |
|---|---|---|
| `woodTexture()` | 地板：深冷灰褐宽板 | 对照 704/705 实拍 |
| `woodSpecies(name)` | 家具木纹：pine/beech/birch/oak/walnut | 按 `spec.wood` 选 |
| `grayOakTexture()` / `quartzTexture()` | 橱柜灰褐木纹 / 白石英台面 | |
| `fabricTexture()` | 织物 | 沙发/椅/灯罩 |
| `laminateTexture()` | 三聚氰胺/烤漆板 | 白色柜体的默认贴图 |
| `carpetTexture()` | 地毯绒面 | 法线强度要大（1.6）才有毛绒感 |
| `powderCoatTexture()` | 金属烤漆细橘皮 | 铁床架/推车 |
| `plasticTexture()` | 注塑件橘皮 | QUADRO 管件等 |
| `leatherTexture()` | 素皮/皮革毛孔 | 爬行垫的硅胶涂层面 |
| `brushedSteelTexture()` | 拉丝不锈钢 | 冰箱/五金 |
| `cityPanorama(night)` | 窗外全景 | 同时当光追的环境光 |

三条铁律：

1. **CanvasTexture 必须设 `t.encoding = THREE.sRGBEncoding`**，否则在 `outputEncoding=sRGB`
   下被当线性图，渲染发白。
2. **纯色材质一律不合格**。近景和光追里一眼假。曾经泛型建模的 25 个 kind 全是无贴图纯色板，
   现在有三道保障：
   - `furnMats(spec, col)`：泛型建模按 kind 统一发材质（贴图/粗糙度/金属度/envI）
   - `C.M(color, opts)`：专属模型的材质工厂，没显式指定贴图时按金属度自动兜底
   - `ensureTextured(root)`：建完模再扫一遍，补掉分支里就地 `new` 出来的漏网材质
   要显式退出，给材质挂 `userData.noTex` / `noNrm`。
3. **`envMapIntensity` 默认是 1，对彩色材质是灾难**。clearcoat + 高 env 会给彩色塑料罩一层白，
   饱和的红黄蓝绿直接变粉彩色（QUADRO 就栽过）。塑料 0.22-0.35、木头 0.6、金属 0.8-0.95。

贴图密度要随家具尺寸变，否则 40cm 床头柜和 200cm 沙发纹理一样大。用 `texScaled(base, ft, per)`：
把缩放吸附到固定几档再缓存——**每 clone 一次纹理都会多一次 GPU 上传，绝对不能按件克隆**。

## 5.4.1 价格与币种

目录条目的价格字段：

| 字段 | 含义 |
|---|---|
| `price` | 美国实际标价（USD） |
| `priceCA` | 加拿大实际标价（CAD） |
| `caVar` | 有加拿大价，但那是同型号的**另一个面料/配置**（界面上给提示） |
| `caNA` | 加拿大不售（加元视图显示「加拿大无售」，不做折算） |

**两地差价远不止一个汇率**，这是实测数据：目录里 102 件同时有两地实际标价，
`CAD/USD` 比值**从 0.59 一直到 1.64，中位数正好 1.00**，而同期汇率约 1.38。
按汇率折算几乎每件都是错的（BILLY：美国 $79，折算应是 CA$109，实际 CA$90）。
所以规则是：**哪个币种有当地实际标价就直接用，只有缺的那一边才折算，且必须标 `≈`**。

抓 IKEA 加拿大价的办法（`curl` 会被反爬掐掉价格字段，必须用 Chrome 渲染）：

```bash
"$CHROME" --headless --disable-gpu --virtual-time-budget=16000 --dump-dom \
  "https://www.ikea.com/ca/en/p/<slug>/" | grep -o '"product_prices":\["[0-9.]*"\]'
```

美国 slug 在加拿大常常不存在（不同货号），这时走站内搜索 API：

```bash
curl -sL "https://sik.search.blue.cdtapps.com/ca/en/search-result-page?q=<关键词>&size=12"
```

**抓完必须做异常值体检**：拿 `CA/US` 比值排序，落在 0.55~2.2 之外的多半是抓到了
系列落地页而不是商品页（MALM King 抓出 CA$25 就是这么来的）。

## 5.4.2 固定灯具不计价

筒灯 / 吸顶灯 / 镜前灯 / 吊灯是**公寓自带的**，跟购物无关。
`isBuiltIn(spec)` 就是 `isLight(spec)`（正好是那四个 kind，落地灯 `lamp` 不在内）：

- 目录里这些条目**没有 price / priceCA 字段**，价格列显示「公寓自带」
- 不进采购清单计数、不计入合计（合计尾部注明「N 件固定灯具不计价」）
- 但仍单列一节可点选/删除，仍可调色温亮度——只是跟钱无关

## 5.4.3 视图与单位（v3.3 重构）

**视图只有三档**：`state.view` = `'2d'` | `'doll'`(3D 俯瞰) | `'fp'`(室内)。
后两档共用同一个 WebGL 画布，只是相机模式不同，所以代码里问的是 `is3D()` 而不是
`state.view==='3d'`。`setView('3d')` 保留了兼容映射（→ `'doll'`），旧测试台不用改。

历史包袱：原来是「2D / 3D」两档 + 3D 之下再套「娃娃屋 / 室内视角」，白多一层。
`setCamMode()` 现在会同步回写 `state.view`——相机档位就是视图档位。

**光追只在室内视角出现**。俯瞰是掀了天花板的剖切图，路径追踪出来的光照根本不成立
（天光从掀掉的屋顶直接灌进来），所以 `#btnPT` / `#ptSeg` / `#ptDnSeg` 只在 `fp` 下显示。

**长度单位统一走 `fmtLen(ft, {precise})`**：
- `'cm'` → 公制厘米
- `'ft'` → 英尺+英寸，美国房产写法（`13' 2"`、`6"`、精确模式到 1/4 英寸 `1' 1/4"`）

内部一律用英尺存储，只在显示时换算。**房间尺寸标注不能写死字符串**——
`LABELS` 里存 `wd`/`dp` 英尺数值，画的时候才格式化，否则切单位数字不变
（这正是 v3.2 之前的 bug）。切单位要 `build2D()` 重画整张平面图，只重画家具不够。

## 5.4.4 2D 量尺寸

`meas` 状态机 + `#meas` 图层。点一下定起点、移动实时预览、再点落定，可连续量多条；
按住 Shift 锁定水平/垂直；Esc 或再点按钮退出；「清除」删除全部。
标注长度走 `fmtLen(..., {precise:true})`，跟着单位切换走。
标注的线宽/字号都要除以 `svg.getScreenCTM().a`，否则缩放后大小会跟着变。

## 5.4.5 侧栏

左右面板都能收起（收起后留一条竖 tab 点回来）和拖宽，宽度与折叠状态存在
`localStorage('planner_panels_v1')`。

**目录是卡片网格不是列表**。挑家具是个费眼的活，靠的是看图：
`.catGrid` 用 `repeat(auto-fill, minmax(150px,1fr))`，所以面板越宽每行卡片越多。
缩略图渲染分辨率 320×240（4:3），卡片按 `background-size:contain` 显示。

## 5.4.6 `#calib` 与 UI 布局的耦合（重要）

校准截图是**按固定像素偏移裁剪**的（2400×1500 窗口裁 `(72,369)` 的 1674×1360），
所以**任何改变画布宽度的 UI 改动都会让整张图位移**，md5 直接变——
v3.3 把目录面板从 270px 加宽到 400px，32.5% 的像素就对不上了。

解法不是更新基线，而是**让 `#calib` 锁死旧版布局**：`body.calib` 那几条 `!important`
把 `#catalog` 固定回 270px、`#props` 回 250px、隐藏分隔条/折叠条/面板头，
`applyPanels()` 在 CALIB 下直接 return。这样校准回归从此只验几何，不受 UI 影响。

同理，**房间尺寸标注在 CALIB 下必须用原始写死字符串**（`LABELS[].d`），
不能跟着单位切换变——`fmtLen` 格式化出来的 `13' 2"` 和原来的 `13'2"` 差一个空格，
足以让 md5 变掉。

排查位移类差异的办法：把 HEAD 版本也渲一张，两图逐像素 diff。
差异像素占比 30%+ 且包围盒覆盖全图 = 位移，不是局部改动。

## 5.4.7 家具建模的两条硬约束

**一、占地尺寸必须诚实**。`spec.w/d/h` 是 2D 图例、碰撞检测和采购清单共用的口径，
建模不能超出它，也不能虚报（声明一个大盒子让断言轻松通过）。
`t_3d.html` 的 `lunix-fits-footprint` / `lunix-footprint-not-inflated` 就是守这个的：
填充率必须落在 92%~102%。

如果一件家具**本来就带散件**（Lunix 那 14 块海绵，摆成沙发只用掉 8 块），
正确做法是**把散件也建出来、散放在旁边，然后把它们算进占地**，而不是不建。

两个配套要求：
- 散件位置**不能从 `spec.w/d` 反推**——改了 spec 又会改变包围盒，来回收敛不了。
  用相对主体的固定偏移摆，最后统一把整组水平重心归零。
- 模型末尾要做一次重心归零：`Box3.setFromObject(C.g)` 求中心，再把所有 children
  的 `position.x/z` 减掉。2D 图例和碰撞都假定家具原点 = 占地中心。

**二、所有部件必须贴地，不能沉到地板以下**。
`t_3d.html` 的 `lunix-on-floor` 断言 `bbox.min.y > -0.02`。

最容易翻车的是**复合欧拉角**：给一个 mesh 同时设 `rotation.x` 和 `rotation.y`，
three 按 XYZ 序复合（`R = Rx·Ry·Rz`），块会被转翻。两个实测案例：
- 三棱柱同时设 `rotation.x=-90°, rotation.z=0.55` → 沉到地下 17cm
- 半圆柱用 `CylinderGeometry(..., 0, PI)` + `rotation.set(-90°,0,-90°)` → 圆面朝下，
  整块沉一个半径（17.5cm）

正确姿势：
- **旋转和落地分开**：mesh 只负责"形状 + 抬到地面"，外面套一个 `Group` 只负责绕竖轴转向
- **能用形状表达就别用旋转**：半圆柱直接拿半圆 `Shape` 挤出（直边在 y=0），
  比拿圆柱转两下可靠得多
- `C.ext(..., 'xz')` 的挤出方向是 **-y**，要把 `position.y` 抬一个厚度

排查手法：逐 child 打 `Box3` 的 y 范围并按 max 排序，一眼能看出是谁

## 5.4.8 subagent 重做建模（v3.6 实践）

> **现在 subagent 并发上限是 1（硬约束，两个 agent 都适用）。**
> 下面记的是当时 3 个并行跑出来的经验，结论依旧成立，只是现在会串行执行：
> 派活时**一次派一个**，别一口气开三个。
> 串行之后 worktree 隔离不再是防并发覆盖的刚需，但仍然建议保留：
> 隔离出来的分支便于单件回滚，也保证主线随时可跑回归。
>
> | agent | 闸门在哪 | 跟随 git？ |
> |---|---|---|
> | Claude Code | `.claude/settings.json` → `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=1`。超限是**直接拒绝**，不是排队 | ✅ 在仓库里 |
> | pi-subagents | `~/.pi/agent/extensions/subagent/config.json` → `globalConcurrencyLimit: 1` + `maxActiveAsyncRunsPerSession: 1`（默认 20）。改完**要重启 pi**，扩展激活时只 `loadConfig()` 一次 | ❌ **在用户 home，不在仓库内**，clone 到新机器要手工建 |
>
> pi 这边**没有**项目级并发配置：`getConfigPath()`（`pi-subagents/src/extension/config.ts:186`）
> 只拼 `~/.pi/agent/extensions/subagent/config.json`，无 projectRoot 分支、无合并、无回退；
> `.pi/settings.json` 的 `subagents.*` 白名单里一个并发键都没有；也没有对应环境变量。
> 文档里的 `parallel.{maxTasks,concurrency}` 在 0.67.0 是**死配置**（类型还在，无读取点），别用。
>
> 仓库内能做的第二道防线（跟随 git，但属"劝导"不是闸门）：
> 用 pi 的 workflowScript 时在**顶层**显式传 `globalConcurrencyLimit: 1`
> （只允许出现在顶层调用，且不会转发给子调用）。

9 件座椅（4 餐椅 / 3 吧凳 / 2 办公椅）原来全在吃 `kind` 通用回退——实测只有
**120 面 / 2 个网格**，就是两个盒子摞起来。用 3 个 subagent 各带一个 git worktree
并行重做，每个都跑 `add-catalog-item` skill。经验：

- **一定要让 agent 自己去核实商品页**。我在任务里给的 12 个链接**有 5 个是死链**，
  而且我对 SKOGSTA（写成方料腿，实为温莎式）、TEODORES（写成镂空椅背，实为实心板）、
  ODGER（写成三条腿，实为四条）、FLINTAN（写成软包背，实为网布背）四处描述都是错的。
  三个 agent 都是按实拍图建的，没跟着错误描述走——这就是「不看图不建模」那条铁律的价值。
- **worktree 隔离是必须的**。9 件同时改一个 `planner.html` 必然互相覆盖。
- **合并不要用 `git apply`**。三个 patch 都往同一个锚点插 MODELS，第二个就冲突。
  改成按内容提取（目录行按 id、模型按 `MODELS['key']` 块、函数按名字连注释一起抓）
  再定点插入，完全确定性。
- **必须查种子冲突**。两个 agent 都给新贴图挑了 `srand(1016)`——撞了的话两张贴图
  会一模一样。合并脚本里自动改号，测试台加了
  `speckleTexture() !== meshWeaveTexture()` 守着。
- **合并后要在主线重跑一遍单件体检**。worktree 是老基线，主线可能已经改过共享代码
  （这次主线正好修了 `C.caster`）。

## 5.5 GPU 路径追踪（`ptRender`）

浏览器里**拿不到显卡的 RT core**：WebGPU 至今没有 ray query / ray tracing pipeline，
WebGL2 更没有。所以这是「用 GPU 的通用计算单元跑软件光追」——
自建 BVH → 打包进 RGBA32F 纹理 → 片元着色器栈式遍历 → 逐帧累积。

管线：`ptCollect()` 收集全场景三角形 → `ptBuildBVH()` 分箱 SAH → `ptBuild()` 打包纹理
→ G-buffer 两趟（albedo / 法线+深度）→ 分块累积 → À-Trous 降噪 → ACES + sRGB。

踩过的坑：

- **每帧 `renderer.setSize()` 会重建默认帧缓冲**，进度看起来完全不动。只在开头设一次。
- **`visibility()` 用「找最近交点」循环等于跑好几遍完整遍历**。阴影光线要写成 any-hit：
  撞到不透明面立刻返回，遇玻璃衰减后继续。
- **GPU 是异步的**，CPU 光按 `performance.now()` 判断会把命令队列排爆、界面失去响应。
  每帧的分块数要有硬上限。
- **进度卡住然后突然结束 = GPU 看门狗把上下文重置了**，不是噪声问题。
  用户看到的现象：进度停在某个百分比很久，然后一下子跑完，出图像只跑了一半、
  满屏点点。机理是单个分块的 draw 太长触发驱动重置，累积缓冲被清空，
  但采样计数还在涨，最后除以完整 spp 就得到一张欠曝多噪的图。三件事一起做：
  （a）分块细到 8×8，单个 draw 短到踩不到看门狗；
  （b）监听 `webglcontextlost`，丢了就停下来如实告诉用户完成了多少采样，
       而不是假装跑完；
  （c）用 `gl.fenceSync` 让 CPU 等 GPU 真画完再排下一批——
       `renderer.render()` 只是排队就返回，不等的话队列越堆越深，
       最后卡在某次提交上不动，进度条也跟着假死。
- **分块数不能拍脑袋定死**。同样 8×8，强显卡上一块 3ms、弱显卡上可能 300ms。
  实测决策表（`ptPickGrid` 的输出，标准档 900k 像素）：

  | 每像素耗时 | 选中格子 | 单块耗时 |
  |---|---|---|
  | 0.05–1 µs（强显卡）| 4×4 | 3–56ms |
  | 2 µs | 8×8 | 28ms |
  | 5–10 µs（弱显卡）| 16×16 | 18–35ms |
  | 20–50 µs（极弱）| 32×32 | 18–44ms |

  所以 **8×8 只在 2µs/像素附近是对的**，两头都不合适。做法是把决策抽成纯函数
  `ptPickGrid(perPx, px, minTX, maxTX, tileMax)` / `ptAdjustGrid(...)`：
  开跑前先画 1/64 画面标定一次选初始格子，之后每个**采样边界**（`tile===0`，
  保证每像素每轮恰好采一次）再按实测单块耗时校正。
  切到 32×32 仍超标就在进度条上提示用户降档。
  纯函数化不只是为了整洁——**真实 GPU 计时在 headless 下测不到**
  （虚拟时间冻结 `performance.now()`），只有把决策抽出来才测得了。
- **光追测试必须跑在有家具的场景上**。空屋只有 2.7 万三角形、2 盏灯，
  BVH 深度和光源采样的开销都不真实。`t_pt.html` 现在铺了一整套客厅（约 10 万三角形、
  22 件家具含 8 盏筒灯），另有 `work/pt_stress.py` 的 4 套布局（20/34/21/52 件，
  6 万~24.6 万三角形）做端到端压力测试，布局同时导出在 `work/layouts/*.json`，
  可以直接用界面的「导入布局」载进去手动看。
- **孤立亮点要区分萤火虫和 NaN**。判据是提高采样数后亮点是否衰减：
  实测 8spp 0.41% → 32spp 0.16%，说明是未收敛的高方差样本；NaN 被加法混合永久累进，
  完全不会衰减。所以亮点阈值要随 spp 收紧（`0.02/√spp`），不能定死。
- **满家具场景里「降噪降了多少」要换个读法**。拉普拉斯量的是高频能量，
  而边缘和贴图本身就贡献大量高频、降噪器又是保边的——空屋能降 63%，
  满屋 15~30% 就是正常的，不是降噪失效。
- **渲染这块必须用 headful 真机验证**（`work/headful_test.py`）。
  headless + swiftshader 测不到真东西：`fenceSync` 不 signal、虚拟时间冻结
  `performance.now()`、也没有真正的 GPU 看门狗。做法是起个本地 HTTP 服务器
  （headful 拿不到 `--dump-dom`），页面跑完把结果和出图 POST 回来。
  Apple M2 实测（D 布局 246,333 三角形 / 31 盏灯 / 52 件家具）：

  | 档位 | 采样 | 用时 | 分块 | 单块耗时 | 上下文 |
  |---|---|---|---|---|---|
  | 草稿 | 120/120 | 60s | 标定 16×16 → 运行中降到 8×8 | 6ms | 未丢失 |
  | 精细 | 900/900 | 398s | 4×4 | 29ms（峰值 62ms）| 未丢失 |

  单块 29ms 对 2s 的看门狗阈值有近 70 倍余量；栅栏节流在精细档生效了 12289 次。
- **两个只有真机才暴露的画质 bug**（headless 的小图看不出来）：
  1. **降噪的颜色相似度 σ 不能用绝对值**。室内日光场景的辐照度量级是 1~3，
     而原来的绝对 σ 只有 0.03 量级，于是每个邻居都被判成「边缘」拒绝，
     整个 À-Trous 形同虚设。要改成相对局部亮度：
     `exp(-dot(dc,dc) / (uSigC * (dot(c0,c0) + 0.05)))`。
  2. **深度权重要沿局部深度梯度比，不能直接比深度差**。天花板、地板这类掠射面上
     相邻像素深度本来就变化快，直接比会把邻居全拒掉——滤波恰好在最需要它的
     大片间接光区域失效。用中心差分估 `gz`，按 `z0 + dot(gz, off)` 外推后再比残差。
- **不要把光栅的假环境光原样叠到路径追踪上**。光栅视图靠 `amb + hemi` 假装全局光照，
  而光追是**真的**在算 GI——两者相加等于把房间塞进一个发光白球里：
  对比度整体被抹平、窗外城市糊成一片灰、**白色家具（KALLAX 这种白格架）
  直接和白墙融在一起看不见**（用户报的「KALLAX 快隐身」就是这个）。
  做法是只保留很小一份当天光残留（`AMB_FILL = 0.32`），
  同时把环境贴图权重给足（`uEnvInt` 0.42 → 1.0），让日光真的从窗户进来。
  `t_pt.html` 的 `pt-kallax-visible` 用「格架区域亮度标准差 > 18」守着这条——
  标准差小 = 糊成一片。
- **排查「光追里某个东西不见了」的顺序**：先查材质是不是被当成玻璃
  （`transparent && opacity<0.75` 会被赋 `trans=0.93`），
  再用 CPU 射线打一条过去看命中链，最后直接取环境贴图在该方向的像素值对照。
  这次查下来光追其实是对的——窗外偏暗是因为全景图在那个方向本来就是
  rgb(72,85,117) 的深蓝，问题在别处（环境光填充）。
- **萤火虫要在降噪之前压掉**。À-Trous 的颜色权重会把孤立超亮样本当成边缘保留，
  越滤越突出。在解调 pass 里做一道 3×3 抑制：超过「八邻域最大值」和「均值×3」
  中较宽松者就压回去（邻域也亮的地方不动，真实高光不受影响）。
  实测孤立亮点 0.078% → 0.006%。
- **fence 必须能退化**。swiftshader 下 `clientWaitSync` 根本不 signal，
  死等会比不节流还慢（每步白等上百次轮询）。连续几次等不到就把 `useFence`
  关掉、退回按帧排一整轮。兜底判据要用**轮询次数**不能用时间——
  `--virtual-time-budget` 会冻结 `performance.now()`，基于时间的超时永远不触发。
- **NaN 必须在写出前挡掉**。加法混合会把 NaN 永久累进累积缓冲，那个像素从此
  是个洗不掉的亮点。`min`/`clamp` 碰到 NaN 行为未定义，挡不住，要显式
  `L = mix(vec3(0.0), L, vec3(equal(L, L)));`
- **降噪是画质的分水岭**。室内场景天光只能从窗户进来，弹射一次就逃出去的概率很低，
  低采样必然噪。À-Trous 按法线/深度/颜色差加权，**输入必须先除掉 albedo、滤完再乘回**，
  否则贴图细节被一起抹平。实测同样 8 spp 下噪点降 63%。
- **`--virtual-time-budget` 下 0ms 定时器链会饿死长间隔定时器**，`setInterval` 测不到进度。
  测 UI 文案变化要用 `MutationObserver`。

## 5.6 目录缩略图

侧边栏每件家具是用**独立的小 WebGLRenderer** 渲的 3/4 视角图（`furnThumb`），
不是色块。按需渲染（`IntersectionObserver` 滚到可视区才画）+ `_thumbCache` 缓存，
所以开局不卡、搜索重建列表时直接命中缓存。灯具单独处理成**仰视**——
吸顶灯俯视只能看到一个盘子。

取景分两遍：先按包围盒八角投影迭代贴合，再**渲一遍读 alpha 通道按真实剪影收紧并居中**。
只按包围盒取景会白留三四成画面——开放式框架（爬爬架）和平面旋转过的矩形（爬行垫）
的包围盒角全是空气。扁平件（`size.y < 0.22*max(x,z)`）要换成俯视，25° 仰角看地毯就是一条线。

**`physicallyCorrectLights = false` 时 three 会把光照乘 π 作补偿**，按物理直觉给的强度
会高出三倍多，浅色件直接推成纯白——沙色和石灰色两个配色的缩略图看起来一模一样。
缩略图渲染器这组光照值（amb .22 / hemi .28 / key .55 / fill .18）是实测调出来的，
`t_3d.html` 里有条 `thumb-color-variants-differ` 断言专门守着这个回归。

判断缩略图是否有内容要**解码后数不透明像素**，不能看 PNG 字节数：简单形状压得极小，
1.9KB 也可能是张正常的图。

## 6. LLM Agent 审查与验证方法论

这个项目大量使用 subagent/workflow，以下是**实测有效**的模式。

### 6.1 对抗验证是刚需

流程：**多路并行找问题 → 每条发现交独立"怀疑论者"复测 → 只留确认项**。

实测数据：三轮下来 62 + 38 + 35 条候选，对抗验证后只剩 **52 条真问题**，其余全是量测伪影。
**没有对抗验证就会过度修复**——曾经按未验证的报告改动，反而把已经对齐的几何改坏（r26 的三处回退）。

怀疑论者的提示词要点：
- 明确要求 **REFUTE**（驳倒），而不是"检查"
- "只有实测 ≥N px 或明确豁口才 confirmed=true；测不出、属豁免清单、底图本来如此 → false"
- **结论必须带数字证据**

（当时的）外部强模型做验证的质量很高：会自建合成模型（`ovl = 0.6*img + c`）分离矢量层、用 50% 边缘做亚像素、拿控制行自校准方法偏差。本地模型做同口径验证时，把合成模型/探针脚本**写死在代码里**（而不是让它自由发挥），质量才稳定。

### 6.2 双审查体系互补，冲突要自己裁决

外部审查员（差分/三版对比）和内部怀疑论者（亚像素探针）**各有盲区**。
遇到过同一区域一方读出"白楔口"、另一方读出"斜墙带"——真相是**两个元素并存**（底图上细线+垛+白口挤在一起）。

裁决办法：
1. 自己下 `lum<130` 中阈值探针看**全部墨层**
2. 用"底图实黑但 4px 内无矢量黑"的像素计数作为客观优化目标
3. 修复时**保留双方各自验证过的部分**，不要拿一方结论整体推翻另一方

### 6.3 审查员的口径盲区

外部审查员用 **≥5px 逐点中线偏差**口径，对**"角度/走向"类偏差是盲区**——门垛被画成近乎水平（斜率 0.012 vs 底图 0.292）而 27 轮都没报出来，是用户拿直尺看出来的。

**长直线特征要按斜率拟合验证**，不能只测端点偏差。

### 6.4 Workflow 编排模式（本地模型口径，2026-09 起）

**本项目用本地模型（`llamacpp-lan/qwen38-27b`）跑 subagent，不要假设 opus/claude/openai 可用。**
并发锁 1（§5.4.8），**一件任务一个 run、fresh 上下文、给足超时**（单件建模 1-2h）。

本地模型的上下文/输出上限比外部强模型小得多，实测三次失败后沉淀的守则：

1. **不 fork 继承大上下文**。父会话上下文 + 几张 PNG 就能把窗口撑爆（`stopReason "length"`，死在写代码前）。
2. **fresh 上下文 + 有界读取**：planner.html 284KB 绝不全读，先 `grep -n` 定位再 `sed` 取区块；参考图每款最多 2-3 张（正脸 + 尺寸图），且**文件名可能标错**，读到的内容不符就换一张，别纠结。
3. **死在哪切到哪**：采集/看图阶段能跑完但写代码前死掉 → 切成两个 run：分析 run 把尺寸/部件/材质写成 `work/briefs/<key>.md`，建模 run 只读 brief 不碰图。
4. **代码分小块写**：底座→坐垫→扶手→细节，每块一次 `edit`，中途 `node --check`；不要一次生成 200 行代码块。
5. **验收看 `git diff --stat`**：本地模型可能 exit 0 却没写任何文件，输出报告前先确认仓库确实变了。

```js
// 串行模式：一件一个 run，fresh 上下文
for (const t of TASKS) {
  const r = await agent(prompt(t), { schema: OUT })   // model 缺省 = 继承本地模型
  results.push(r)
  log(`已完成 ${results.length}/${TASKS.length}`)
}
```

实测有效的三类 workflow：
1. **数据采集**：15 个商品页并行抓尺寸/价格/全部配色（返回 schema 化结果）
2. **代码审查**：按维度切分（交互状态机 / 数据一致性 / 材质渲染），每条发现再对抗验证
3. **逐件建模**：每件家具一个 agent，打开商品页看图后写建模代码

**结果回收**：workflow 的 `.output` 文件可能被截断，**去 journal 里取完整数据**：
```bash
J=~/.claude/projects/.../subagents/workflows/wf_XXXX/journal.jsonl
python3 -c "
import json
for line in open('$J'):
    d=json.loads(line)
    if d.get('type')=='result': print(json.dumps(d['result'], ensure_ascii=False)[:500])
"
```
注意字段是 `d['result']`（不是 `d['value']`），且 `started`/`result` 两种行都有。

### 6.5 给建模 agent 的提示词要点

- 给**完整的 API 文档**（每个基元的签名、y 是底面还是中心、坐标系约定）
- 硬性要求写清楚：必须用 `C.col`/`C.col2` 表达配色、外轮廓不能超官方尺寸、mesh 数上限
- 要求先 WebFetch 商品页**看图**，与已采集的文字描述互相印证
- 要求返回 `notes` 说明抓住了哪些形态特征——能据此判断它是真看了图还是在编

实测 agent 能做到：像素反解投影矩阵求腿平面朝向、发现文字描述与图片矛盾并以图为准、
主动报告 API 缺陷（`rb` 尺寸 bug 就是建模 agent 发现的）。

---

## 7. 代码结构地图

| 行号附近 | 区块 |
|---|---|
| 264 | 户型几何（坐标系：英尺，Y 向下，主卧左上角为原点；`SC=11.2` 图纸px/ft） |
| 693 | 状态、持久化、`effWalls/effFixed/effDoors`（**唯一几何出口**） |
| 785 | 2D SVG 渲染（`wallPolys` / `build2D` / `furnShape` / `drawFurniture`） |
| 1499 | 墙体编辑器（`wallEditDown/Move/Up`、`doorLinkage`、吸附） |
| 1978 | 3D 渲染（贴图生成、`buildStatic3D`、门窗、洁具、厨房） |
| 2824 | 照片级渲染（GPU 浮点累积） |
| 2990 | 逐商品建模注册表 `MODELS` + `modelCtx` 建模 API |
| 4358 | UI（目录、检视面板、视角、日夜、加载提示） |

**几何数据流**：`WALLS/FIXED/DOORS`（内置）+ `USERGEO`（用户编辑）→ `effWalls()/effFixed()/effDoors()` → 2D 和 3D **共用同一份**。
新增任何消费几何的代码，一律走 `eff*()`，不要直接读 `WALLS`（`#dump` 和 CALIB 分支是故意的例外）。

关键常量：`SC=11.2`（图纸px/ft）、`CEIL_H=8.8`（层高ft）、`EYE_H=5.35`（人眼高）、
`DOOR_MIN=0.5`、`STUB_MIN=0.18`、`LINK_TOL=0.5`。

---

## 8. 如何扩展

### 8.1 加家具（完整流程 —— 照着做，别跳步）

> **先看有没有现成的 skill**：`.claude/skills/add-catalog-item/`（随 repo 版本控制）。
> Claude Code 里打 `/add-catalog-item`、或者说「加个 XX 进去」会自动加载；
> 别的 agent 把 `SKILL.md` 当作业指导书读就行。
> 那是精简可执行版，**本节是详细版，两边冲突以本节为准**。

这一节是被返工逼出来的。**每一步都有一道验收关，过不去就别往下走**；
最后那份「常见翻车清单」里每一条都真的发生过。

---

#### 第 0 步：先把实物看清楚

**绝对不要凭印象建模。** 拿到商品链接后第一件事是把官方图抓下来**用眼睛看**
（Read 工具能直接渲染图片，看就是了）。

```bash
mkdir -p work/ref
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
curl -sL -A "$UA" --max-time 40 "<图片URL>?width=1200" -o /tmp/x.webp
sips -s format png /tmp/x.webp --out work/ref/<名字>.png >/dev/null
```

商品页多是 JS 渲染的，`curl` 抓不到图片 URL，用 Chrome 渲染后再抓：

```bash
"$CHROME" --headless --disable-gpu --virtual-time-budget=20000 --dump-dom "<商品页>" > /tmp/pg.html
grep -o '"hiRes":"https://[^"]*"' /tmp/pg.html | head          # Amazon
grep -oE 'cdn\.shopify\.com/s/files/[^"]+\.(jpg|png|webp)' /tmp/pg.html | head   # Shopify
```

**要看的不只是主图**：找那张「零件分解图 / 尺寸标注图」，它会告诉你
一共几块、每块什么形状、关键尺寸标在哪。Lunix 沙发的 14 块海绵、
Avenlur 爬爬架的 8 个功能件，都是从这类图里读出来的。

参考图存进 `work/ref/`（已入库），后面复核和以后改模型都要拿它对照。

> 验收关：你能用一句话说清「这东西由哪几个部件组成、各自什么形状」。说不清就再找图。

---

#### 第 1 步：抓真实数据（尺寸 / 价格 / 全部配色）

**不要凭印象编尺寸。** 各站点的实测手法：

| 站点 | 手法 |
|---|---|
| IKEA 美/加 | Chrome 渲染后从埋点里取：`grep -o '"product_prices":\["[0-9.]*"\]'`。**`curl` 会被反爬把价格字段掐掉**，标题却是对的，很容易误判 |
| IKEA 加拿大 slug 不存在 | 走站内搜索 API：`https://sik.search.blue.cdtapps.com/ca/en/search-result-page?q=<词>&size=12`（返回 JSON，含 `salesPrice.numeral` 和 `pipUrl`） |
| Amazon | `id="productTitle"`、`"priceAmount":`、`"public_title"`（配色/规格变体）、`prodDetails` 表里的 `Item Dimensions D x W x H` |
| Shopify 独立站 | `"public_title"` 取变体，`dimensionValuesDisplayData` 取配色全集 |
| 页面根本不写尺寸 | 用 WebSearch 查零售商列表页（Best Buy / Amazon 常有），**查到什么写什么，查不到就说查不到，不要编** |

尺寸一律记 **cm**（`w`/`d`/`h`），坐具另记 `seatH`（座高）。

> 验收关：宽/深/高、价格、**全部配色**三样齐了。缺哪样就明确写在交付说明里。

---

#### 第 2 步：写目录条目

```js
{id:'xxx-0', cat:'沙发 / 单椅', name:'名称 · 配色', w:139.7, d:69.9, h:53.8,
 price:275.57, priceCA:274.97, color:'#主色', color2:'#辅色', seatH:23.9,
 model:'xxx', kind:'playCouch', wood:'pine', url:'...', note:'...'}
```

| 字段 | 说明 |
|---|---|
| `w/d/h` | cm。**必须是「整件东西的实际占地」**，包括散在旁边的配件（见第 3 步） |
| `price` / `priceCA` | 美国 / 加拿大**当地实际标价**，不是汇率折算（见 §5.4.1） |
| `caVar` | 有加元价，但那是同型号的另一个面料/配置，界面上会提示 |
| `caNA` | 加拿大不售，加元视图显示「加拿大无售」 |
| `color` / `color2` | 主色 / 辅色，模型里用 `C.col` / `C.col2` |
| `model` | 指向 `MODELS[...]`。**同款不同色共用一个 `model`**，靠 `color` 区分 |
| `kind` | 决定 2D 图例、通用建模回退、材质选择、碰撞高度区间 |
| `wood` | `pine`/`beech`/`birch`/`oak`/`walnut`，选木纹贴图 |
| `seatH` | 坐具座高（cm） |
| `dimmable` | 可调光的落地灯：**要花钱买**但需要色温/亮度控件（见 §5.4.2） |
| `note` | 材质、功能、特殊说明。尺寸口径特殊时**一定要在这里写清楚** |

**同款不同色 = 每个配色一个独立条目**（用户明确要求要能挑选）。

现有分类（截至 v3.4）：沙发 / 单椅、餐桌椅 / 吧凳、床 / 床头柜、收纳 / 电视柜、
书桌 / 办公椅、灯具 / 照明、地毯 / 爬行垫、茶几 / 边几、儿童 / 爬爬架。
**不要把性质不同的东西合并成一类**（用户为此提过意见：地毯和茶几和灯具本来就不是一类）。

现有 `kind`：`armchair bed bedMetal bookcase cart ceilingLight chair climber coffeeTable
crib desk deskSitStand downlight dresser lamp nightstand officeChair pendant playCouch
playMat rug shelf shoeCab sideTable sofa sofaL stool swivelChair tableDrawer tableFold
tableRect tableRound tvBench vanityLight`。加新 `kind` 要同时管三处：
`furnMats()` 的材质分类、`furnShape()` 的 2D 图例、`vSpan()` 的高度区间。

**商品名照写原文拼写**（POÄNG / RÅSKOG / SÖDERHAMN / IDÅSEN），不要为了好搜写成 ASCII。
搜索层用 `foldText()` 把查询词和商品名两边都折成 ASCII 再比对，
`poang` / `POÄNG` / `poäng` 都能搜到。出现新语种字母就往 `FOLD_EXTRA` 里补一行。

---

#### 第 3 步：建模

`MODELS['xxx'] = (C) => {...}`。没注册的会回退到 `kind` 的通用造型（能用，但细节差一档）。

`C` 提供的工具（`modelCtx`）：

| 方法 | 用途 |
|---|---|
| `C.w/d/h` | 已换算成**英尺**的尺寸（`C.cm(x)` 把 cm 转英尺） |
| `C.col` / `C.col2` / `C.seatH` | 配色与座高 |
| `C.it` / `C.cct` / `C.lum` | 当前实例（灯具模型读色温/亮度用） |
| `C.M(color, opts)` | 材质工厂，见第 4 步 |
| `C.box/rb/cyl/tube/sph/torus` | 方盒 / 圆角盒 / 圆柱 / 胶囊管 / 球 / 环 |
| `C.ext(pts, depth, mat, x,y,z, plane, bevel)` | 任意多边形挤出，`plane` 取 `'xy'`(默认,沿+z) / `'xz'`(平放,**沿 -y**) / `'zy'` |
| `C.lathe` / `C.cushion` / `C.legT` / `C.bar` / `C.knob` / `C.caster` | 旋转体 / 软包坐垫 / 锥形腿 / 长条拉手 / 球形拉手 / 脚轮 |
| `C.rep(n, fn)` | 阵列 |
| `C.m.{wood,fab,chrome,steel,black,white,plastic,leather,glass}` | 常用材质库 |

细节要求：**「几个方块拼一下」不算建模**。用户明确要求过「每个家具都需要单独建模，
从商品图片对着建」。参考量级：一件家具 2000–15000 三角形，
桌椅这类简单件也该有倒角、腿部收分、把手、缝线一类的细节。

**两条硬约束（详见 §5.4.7，这里只列结论）**：

1. **占地必须诚实**：包围盒对 `spec.w/d/h` 的填充率要落在 **92%~102%**。
   既不能超出（2D 图例和碰撞会错），也不能虚报（声明个大盒子糊弄断言）。
   本来就带散件的（Lunix 14 块海绵摆成沙发只用 8 块）——
   **把散件也建出来散放在旁边，然后把它们算进占地**，不是不建。
2. **所有部件贴地**：`bbox.min.y > -0.02`。

配套两条：
- 散件位置**不能从 `spec.w/d` 反推**（改 spec 又会改包围盒，来回收敛不了），
  用相对主体的固定偏移摆
- 模型末尾做一次水平重心归零：

```js
C.g.updateMatrixWorld(true);
const bb = new C.THREE.Box3().setFromObject(C.g);
const off = new C.THREE.Vector3(); bb.getCenter(off);
for(const ch of C.g.children){ ch.position.x -= off.x; ch.position.z -= off.z; }
```

**最容易翻车的是复合欧拉角**：给一个 mesh 同时设 `rotation.x` 和 `rotation.y/z`，
three 按 XYZ 序复合（`R = Rx·Ry·Rz`），块会被转翻、沉到地板以下。正确姿势：
- **旋转和落地分开**：mesh 只负责「形状 + 抬到地面」，外面套一个 `Group` 只负责绕竖轴转向
- **能用形状表达就别用旋转**：半圆柱直接拿半圆 `Shape` 挤出（直边落在 y=0），
  比拿 `CylinderGeometry` 转两下可靠得多

---

#### 第 4 步：材质与贴图（**不能跳过**）

有三道保障，但**别指望兜底**——兜底只保证「不是纯色平板」，好看要自己给：

1. `furnMats(spec, col)`：通用建模按 `kind` 统一发材质
2. `C.M(color, opts)`：没显式指定贴图时按金属度自动兜底
3. `ensureTextured(root)`：建完模再扫一遍，补掉分支里就地 `new` 的漏网材质

`C.M(color, opts)` 的 `opts`：

| opt | 效果 |
|---|---|
| `wood:'pine'` | 木纹贴图 + 法线 + 清漆 |
| `fabric:true` | 织物贴图 |
| `leather:true` | 素皮/皮革毛孔 |
| `plastic:true` | 注塑件橘皮 |
| `rough` / `metal` | 粗糙度 / 金属度 |
| `clear` / `clearRough` | 清漆层 |
| `sheen` / `sheenColor` | 丝绒/绒面高光 |
| `envI` | **环境反射强度** |
| `flat:true` | 显式退出贴图兜底 |

现成贴图：`woodSpecies(name)`（pine/beech/birch/oak/walnut）、`fabricTexture`、
`laminateTexture`（三聚氰胺板）、`carpetTexture`（地毯绒面）、`powderCoatTexture`（金属烤漆）、
`plasticTexture`、`leatherTexture`、`brushedSteelTexture`、`grayOakTexture`、`quartzTexture`、
`woodTexture`（地板）。

**该加新贴图就加，不要凑合。** 现有的凑不出实物质感（藤编、大理石、亚麻粗织、
磨砂玻璃、拉丝黄铜……）就新写一个：

```js
let _xxxTex = null;
function xxxTexture(){
  if(_xxxTex) return _xxxTex;
  srand(1016);                          // 固定种子！否则渲染不确定，回归测试失效（见 §11）
                                        // 已占用 1001~1015、2000+；挑个没用过的
  const N = 512, c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d');
  g.fillStyle = '#fdfcfa'; g.fillRect(0, 0, N, N);   // 基调接近白：靠 material.color 上色
  /* …用 rnd01() 画纹理… */
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 2);
  t.encoding = THREE.sRGBEncoding;       // 必须！否则被当线性图，渲染发白
  t.anisotropy = 8;
  _xxxTex = t; return t;
}
```

四条铁律：
1. **必须 `srand(种子)` 起头**，用 `rnd01()` 而不是 `Math.random()`——渲染确定性是回归测试的前提
2. **必须设 `t.encoding = THREE.sRGBEncoding`**，否则在 `outputEncoding=sRGB` 下渲染发白
3. **基调接近白**，颜色靠 `material.color` 相乘上色，这样一张贴图能服务所有配色
4. 法线贴图用 `normalFromTexture(tex, strength)`（有缓存，直接调）

**`envMapIntensity` 默认是 1，对彩色材质是灾难**。clearcoat + 高 env 会给彩色塑料罩一层白，
饱和的红黄蓝绿直接变粉彩色（QUADRO 就栽过）。参考值：塑料 0.22–0.35、织物 0.12–0.20、
木头 0.6、金属 0.8–0.95。

**贴图密度要随家具尺寸变**（40cm 床头柜和 200cm 沙发纹理不能一样大），
用 `texScaled(base, ftSize, per)`——它把缩放吸附到固定几档再缓存，
**绝对不能按件 clone 纹理**，每 clone 一次就多一次 GPU 上传。

同理，`sheen` 给大了整块会被冲成白的（Lunix 第一版 `.55` 就白了，`.22` 才对）。

---

#### 第 5 步：2D 图例

在 `furnShape()` 里给新 `kind` 加俯视符号。没加会落到通用圆角矩形——能用但读不出是什么。
参考 `climber` 那条：外框 + 横档示意 + 对角线。

---

#### 第 6 步：验证（四道关，全过才算完）

**关 1 —— 语法 + 全目录体检**（最省事，先跑这个）

```bash
python3 -c "
import re
h=open('planner.html').read(); m=re.search(r'<script>\n(.*?)</script>', h, re.S)
open('/tmp/p.js','w').write(m.group(1))" && node --check /tmp/p.js
```

然后跑 `work/t_3d.html`，看这几条：

| 断言 | 守的是什么 |
|---|---|
| `catalog-all-build` | 每个目录条目都能建出模型，不抛错 |
| `catalog-all-textured` | 每件家具的材质都有 `map` |
| `catalog-all-normalmapped` | 都有 `normalMap` |
| `catalog-tri-avg` / `catalog-tri-max` | 三角形数没失控 |
| `thumb-renders` | 缩略图渲得出来、取景贴合 |

**关 2 —— 包围盒 / 填充率**（新家具一定要单独量）

```js
const g = furn3D({uid:-1, ref:sp.id, x:0, y:0, rot:0}, sp);
g.updateMatrixWorld(true);
const b = new THREE.Box3().setFromObject(g);
const sz = new THREE.Vector3(), ct = new THREE.Vector3();
b.getSize(sz); b.getCenter(ct);
// 填充率 sz.x/cm2ft(sp.w) 等三项要在 0.92~1.02
// 重心 ct.x, ct.z 要 ≈ 0；b.min.y 要 > -0.02
```

出问题时**逐 child 打 y 范围并按 max 排序**，一眼能看出是哪块沉下去了。

**关 3 —— 隔离渲染目检**（这一关最容易被跳过，但最有用）

```js
three.staticGroup.visible = false;                       // 别被墙挡住
three.scene.background = new THREE.Color(0x1b1f26); three.scene.fog = null;
const g0 = three.furnMap.values().next().value.g; g0.updateMatrixWorld(true);
const bb = new THREE.Box3().setFromObject(g0), sz = new THREE.Vector3(), ct = new THREE.Vector3();
bb.getSize(sz); bb.getCenter(ct);
const dir = new THREE.Vector3(0.5, 0.42, 1).normalize();
let dist = sz.length() * 0.5 / Math.tan(34 * Math.PI / 360) * 1.05;
const cs = []; for(let i = 0; i < 8; i++) cs.push(new THREE.Vector3(
  (i&1)?bb.max.x:bb.min.x, (i&2)?bb.max.y:bb.min.y, (i&4)?bb.max.z:bb.min.z));
three.cam.fov = 34;
for(let k = 0; k < 4; k++){                              // 按包围盒八角迭代贴合
  three.cam.position.copy(ct).addScaledVector(dir, dist); three.cam.lookAt(ct);
  three.cam.updateMatrixWorld(true);
  three.cam.matrixWorldInverse.copy(three.cam.matrixWorld).invert();
  three.cam.updateProjectionMatrix();
  let mx = 0; for(const c of cs){ const q = c.clone().project(three.cam);
    mx = Math.max(mx, Math.abs(q.x), Math.abs(q.y)); }
  dist *= mx / 0.86;
}
three.cam.position.copy(ct).addScaledVector(dir, dist); three.cam.lookAt(ct);
three.controls.target.copy(ct); three.controls.enabled = true; three.controls.update();
requestRender();
```

**两个必踩的坑**：
- 手摆完相机**必须同步 `controls.target` 再 `controls.update()`**。
  `OrbitControls.update()` 每帧会按它自己的内部状态把相机拉回去，画布会是空的
  （`controls.enabled=false` 也拦不住）
- 测试里给场景加光要克制：`physicallyCorrectLights=false` 时 three 会把光照乘 π 补偿，
  按物理直觉给的强度会高出三倍多，浅色件直接推成纯白，配色全看不出差别

**关 4 —— 和实拍图逐项比对（至少两个角度，硬条件）**（对着 `work/ref/` 里的图看）

`check-item.py <条目id>` 出两张图：主 3/4 前视角（`check_<id>.png`）和侧视角
（`check_<id>_side.png`）。**两张都要看、都要对照过**：主视角对正面实拍，侧视角对侧面/3-4 实拍。
侧面轮廓（腿距、悬挑、背部结构、深度比例）只有侧视角才露馅，单角度最容易在这栽。
参考图凑不齐两个角度时，先补抓一张侧面/剖切实拍再对照。

- [ ] 部件数量对不对？（14 块就得是 14 块）
- [ ] 各部件的**形状**对不对？（方 / 圆 / 楔形 / 带孔）
- [ ] 各部件的**相对位置和朝向**对不对？
- [ ] 比例对不对？（拿图上标注的尺寸比一比，别只看整体高度）
- [ ] 颜色对不对？（渲染出来发白就是 sheen / envMapIntensity 给大了）
- [ ] 材质像不像？（木纹 / 织物 / 塑料 / 金属，纹理密度合不合理）
- [ ] 特征细节在不在？（把手、缝线、螺丝、logo、脚垫）

**最后照 §2 走完整回归**：重新生成三个测试台 → 全跑 → `#calib` md5 核对 → 目检 → 提交。

---

#### 常见翻车清单（每条都真的发生过）

| 症状 | 原因 |
|---|---|
| 家具在 2D 图上比 3D 里小一圈 | 建模超出了 `spec.w/d`，或者散件没算进占地 |
| 家具半截埋进地板 | 复合欧拉角把块转翻了；`C.ext(...,'xz')` 忘了抬一个厚度（挤出方向是 -y） |
| 成品比 spec 大一圈 | `C.ext(..., bevel)` 的 `bevelSize` **向外扩**，轮廓要先减掉倒角量（深度它补偿了，截面没有） |
| 折线管件像一串香肠 | `C.tube` 的胶囊端帽正好收在端点上，首尾相接会在每个折点掐出一道腰 → 每段用 `C.tube(L + 2r, ...)` 搭接 |
| 家具偏在格子一角 | 模型末尾没做水平重心归零 |
| 近看像塑料板 / 一眼假 | 材质没贴图。跑 `catalog-all-textured` 一查便知 |
| 彩色件全变粉彩色 | `envMapIntensity` 默认 1 + clearcoat，白光罩糊了颜色 |
| 贴图发白 | `CanvasTexture` 忘了 `encoding = sRGBEncoding` |
| 两个配色的缩略图长一样 | 光照过曝（`physicallyCorrectLights=false` 下 three 会乘 π） |
| 改了尺寸后包围盒也跟着变，怎么调都对不上 | 散件位置从 `spec.w/d` 反推了，形成循环 |
| 缩略图只看得见一个角 | 取景第二遍缩得过头；`furnThumb` 有剪影贴合保护，别绕过它 |
| 抓到的价格离谱（King 床架 $25） | 命中了系列落地页不是商品页。抓完做 CA/US 比值异常值体检 |
| 渲染两次结果不一致 | 新贴图用了 `Math.random()`，没走 `srand()` + `rnd01()` |
| T 脚/条形部件方向错 90° | 只看正面 3/4 图建模，两方向长得一样 | 建模前 brief 写死轴向（沿 x 还是 z），建模后**侧视角渲染图**核对 |
| 占地缺了伸展部分（臂灯只占机身） | 采集时只录机身 w/d，没录官方 Length/reach | 采集时对伸展件核对 reach；spec 错了就改目录条目，不缩模型迁就 |
| 多件套装「嵌套」和「总宽」矛盾 | 例：60+30=90 恰等于 spec 宽时，嵌套必然总宽不足 | 建模前先算整组 bbox span，选偏移落在 92~102% 填充窗内（VITTSJÖ 套几解法：span 85=94%） |
| 填充率超窗但不知哪个部件超了 | 灯环/绕线带/拉手这类细件外缘超出 spec | 别盲调参数：`?nomerge` 逐 child 打 bbox，找出最宽部件（VIDJA 铬环 R 13.1→12.5） |

### 8.2 加可编辑性

已有：画墙/画柱异形/改内置墙、门的位置与宽度（带墙垛联动）、灯的色温与亮度、家具旋转 0.1° 精度。

加新编辑能力时注意：
- 手柄要**恒定屏幕尺寸**（`k = svg.getScreenCTM().a`，所有尺寸除以 k），否则放大后手柄糊住底图
- 吸附半径要**随缩放收缩**（按屏幕像素算），否则放大了也无法精确定位
- 点击 vs 拖动的阈值用**屏幕像素**（≥5px），不要用世界坐标——1px 手抖会静默改坏几何
- 拖拽目标要在 pointerdown 时**快照**，move 里不要重新解引用（Esc/Delete 会让 sel 变 null）
- 纯选中**不要写 override**（延迟到首次真正移动才 materialize），否则点一下就把内置几何冻结

### 8.3 提高渲染效果

现有管线：ACES 色调映射 + PMREM 环境贴图 + 程序化贴图（木纹按树种/织物/石英/拉丝钢/城市全景）+ 法线贴图（Sobel 从颜色图算）+ 照片级渐进累积。

继续提升的方向：
- **材质**：`MeshPhysicalMaterial` 的 `clearcoat`（清漆）、`sheen`（丝绒）、`specularIntensity`（哑光漆）
- **贴图**：`woodSpecies(name)` 已支持 pine/beech/birch/oak/walnut，加新树种照着写
- **光照**：娃娃屋=均匀泛光（看清造型），室内=真实灯光（`applyLightMode()` 分流）
- **照片级渲染**：`photoRender(samples)`，采样数越高越干净；日光锥抖动出半影、半球天光采样近似 AO

调材质时**一定要对照实拍照片采样**（写个 canvas 取色脚本），不要凭感觉。
注意照片有曝光偏差，要找光照正常的区域采样，或用已知白色物体做归一化参考。

---

## 9. 便捷命令速查

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# 2D 截图
"$CHROME" --headless --disable-gpu --screenshot=/tmp/a.png --window-size=1700,1100 \
  --virtual-time-budget=12000 "file:///Users/dako/planner/planner.html" 2>/dev/null

# 3D 截图（必须 swiftshader）
"$CHROME" --headless --use-angle=swiftshader --screenshot=/tmp/b.png --window-size=1900,1200 \
  --virtual-time-budget=16000 "file:///Users/dako/planner/planner.html#3d" 2>/dev/null

# 读取页面内计算结果（配合注入脚本输出到 <pre id="r">）
"$CHROME" --headless --use-angle=swiftshader --allow-file-access-from-files --dump-dom \
  --virtual-time-budget=30000 "file:///path/test.html" 2>/dev/null | python3 -c "
import sys,re,html
t=sys.stdin.read(); m=re.search(r'<pre id=\"r\">(.*?)</pre>', t, re.S)
print(html.unescape(m.group(1)) if m else 'NO RESULT')"

# 导出几何做程序化分析
"$CHROME" --headless --disable-gpu --allow-file-access-from-files --dump-dom \
  --virtual-time-budget=5000 "file:///Users/dako/planner/planner.html#dump" 2>/dev/null
# → <pre id="dump">{W:墙段, F:地板点, S:结构块}</pre>，坐标是图纸px
```

**hash 模式**：`#calib` 校准叠加 / `#calibimg` 只显底图 / `#dump` 导出几何 / `#3d` 直接进 3D / `#a` `#b` 载入参考方案。

**参考资料**：`work/furniture_specs.json`（采集的商品数据）、`work/furniture_models.json`（agent 生成的建模代码）、
`704.jpg`/`705.jpg`（实拍）、`708.jpg`（样板间效果图）、`work/clean_plan.jpg`（官方图纸，校准基准）。

---

## 10. 交付习惯

- 回复用中文，先给结论再给细节
- 提到文件/页面**一定给完整 `file://` URL**
- 报告改动时说清楚"根因是什么"，不要只说"修好了"
- 测试数字要具体（"转头位移 0.0000ft、眼高恒定"比"修好了"有说服力）
- 用户圈图指出问题时，**先放大裁剪确认自己看到的和用户看到的是同一处**，再动手

---

## 11. 性能优化（2026-09 实测）

### 已做的优化与实测收益

| 优化 | 手法 | 实测 |
|---|---|---|
| **按材质合并几何** | `mergeByMaterial()`：把每件家具/静态场景的 mesh 按 (材质, 投影标志) 分桶，烘焙各自变换后拼成一个 BufferGeometry | draw call **724 → 66**，三角形数完全不变 |
| **增量家具同步** | `sync3D()` 维护 uid→group 映射 + 签名；签名没变只更新变换矩阵 | 拖动一次 **~300ms → 4.2ms（70×）** |
| **按需渲染** | `three.needsRender` 脏标记；只有相机/场景变化才画帧 | 静止时 GPU 占用归零（原先无条件 60fps） |
| **阴影按需更新** | `shadowMap.autoUpdate=false` + `requestShadowUpdate()` | 相机移动不再重算阴影贴图 |
| **交互期自适应分辨率** | 拖动/滚轮时 pixelRatio 降到 1.0，静止 220ms 后恢复满分辨率重绘 | 交互期像素量减少约 4×，静态画质不变 |
| **法线贴图上 GPU** | 一次 shader pass 出图，失败回退 CPU Sobel | 免去 512² × 8 邻域的 JS 循环 |
| **全量重建** | 上述叠加 | buildStatic3D+sync3Dfull **460ms → 144ms** |

### 关键约束：合并不能改变画面

- **透明材质不合并**：多层透明面依赖逐网格由远及近排序，合并会改变混合结果
- **单成员分组不重建**：只有一个 mesh 的桶保持原样，避免顶点浮点漂移导致贴图采样偏移（曾让地板木纹缝线整体位移 1px）
- 分桶键必须含 `castShadow`/`receiveShadow`/`renderOrder`
- 合并出来的几何打 `userData.mergedOwned=true`；`disposeOwned()` **只释放自有几何，绝不释放共享材质与贴图**
  （原代码每次 `sync3D` 都 `m.map.dispose()`，把缓存的木纹/织物贴图释放掉，导致反复重传 GPU）

### 性能测量在本环境的陷阱（很重要）

- **`--virtual-time-budget` 会冻结 `performance.now()`**，页面内同步计时全是 `0.0ms`，完全不可用
- **`--screenshot` 在 load 事件时就截图**，赶在 `load` 监听器之前，页面内基准跑不完
- **可行办法**：用**进程墙钟**（`time.time()` 包住整个 Chrome 进程）+ 页面写一个完成标记 `<pre id="done">`；
  **必须校验标记存在**，否则数字是"进程被提前结束"的假读数
- **SwiftShader 是软件光栅化器**，填充率瓶颈、不体现 draw call 的驱动开销 →
  合并的收益在这里测不出来，但在真实 GPU 上是实打实的 CPU 驱动开销下降

### 渲染确定性（新增，且是回归测试的前提）

所有程序化贴图原本用 `Math.random()`，导致**每次刷新木纹/天际线都不一样**——
既是 UX 问题，也让像素级回归比对失效（同代码跑两次就有 4.8% 显著差异，噪声淹没真实回归）。

现在用固定种子的 xorshift32（`srand()/rnd01()`），各贴图函数入口播种。
**验证方法**：同一页面渲染两次，md5 必须完全相同。有了它才能证明"优化前后逐字节一致"
（本轮合并优化就是这样验证的：`?nomerge` 与默认渲染的 md5 完全相同）。

`photoRender` 的采样抖动仍用 `Math.random()`——那里需要真随机。

### 调试开关

- `?nomerge` — 关闭几何合并，用于 A/B 对照
- 页面内可直接调 `sync3Dfull()` 强制全量重建家具

### 下一步可做的优化（尚未做）

- **InstancedMesh**：KALLAX 隔板、婴儿床栏杆、窗棂等重复构件可用实例化，进一步降低顶点量
- **材质全局去重**：目前 79 个材质实例，很多参数完全相同；注意有模型会在创建后改材质（如吊灯罩改 `side`），共享前必须审计
- **静态场景 LOD / 视锥剔除**：合并后剔除粒度变粗，场景更大时可按房间分组合并
- **Worker 预生成贴图**：目前贴图生成很快（实测接近免费），暂无必要
