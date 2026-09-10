# AGENTS.md — 公寓家具规划器开发指南

写给接手这个 repo 的 AI agent。这份文档记录**实测有效的流程、踩过的坑、以及验证方法论**。
读完再动手，能省掉大量返工。

---

## 0. 这是什么

单文件 Web 应用 `planner.html`（约 4800 行，284KB），给一套**高层 2室2卫公寓**做家具规划：

- **2D SVG 平面编辑器**：拖放家具、编辑墙体/门/柱、标准建筑图例
- **3D 渲染**（Three.js r147，本地 `lib/`，离线可用）：娃娃屋视角 + 室内第一人称漫游
- **照片级渲染**：GPU 浮点渐进累积（软阴影/环境光/抗锯齿）
- **家具库**：126 个目录条目，其中 14 件按官网商品图**逐件建模**

依赖只有 `lib/three.min.js` 和 `lib/OrbitControls.js`（已本地化）。没有构建步骤，直接用浏览器打开。

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
| `work/t_walledit.html` | 2D：墙/柱/门编辑、门垛联动、拖动中删除、搜索折叠、双币种、三档视图/单位/量尺寸/面板 | 102 | `wetest` | `window.__ERRS` | 1700x1100 / 80000 |
| `work/t_3d.html` | 3D：射线拾取/拖动/旋转、开关灯、**全目录建模+贴图体检**、缩略图、镜子/新家具、双击进室内 | 38 | `t3d` | `window.__E3` | 1400x950 / 170000 |
| `work/t_pt.html` | 光追：BVH 的 CPU 独立校验、着色器编译、进度、降噪效果 | 20 | `tpt` | `window.__EPT` | 1200x850 / 300000 |

`t_3d.html` 里那组 `catalog-*` 断言是**最省事的整体体检**：把 CATALOG 每一条都跑一遍
`furn3D()`，断言（a）不抛错（b）材质都有 `map`（c）都有 `normalMap`（d）三角形数不失控。
加家具、改材质之后先看这四条，比逐个截图快得多。

**两个测试台不能合并**：2D 全套跑完再构建 3D 场景会超出单次 `--virtual-time-budget`，
页面根本不输出结果（症状是 `NO TEST OUTPUT`，很容易误判成页面崩溃）。
每次跑之前先 `pkill -f headless`，否则上一轮的 swiftshader 僵尸进程抢 CPU 把本轮拖超时。

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

opus 做验证的质量很高：会自建合成模型（`ovl = 0.6*img + c`）分离矢量层、用 50% 边缘做亚像素、拿控制行自校准方法偏差。

### 6.2 双审查体系互补，冲突要自己裁决

外部审查员（差分/三版对比）和内部 opus 怀疑论者（亚像素探针）**各有盲区**。
遇到过同一区域一方读出"白楔口"、另一方读出"斜墙带"——真相是**两个元素并存**（底图上细线+垛+白口挤在一起）。

裁决办法：
1. 自己下 `lum<130` 中阈值探针看**全部墨层**
2. 用"底图实黑但 4px 内无矢量黑"的像素计数作为客观优化目标
3. 修复时**保留双方各自验证过的部分**，不要拿一方结论整体推翻另一方

### 6.3 审查员的口径盲区

外部审查员用 **≥5px 逐点中线偏差**口径，对**"角度/走向"类偏差是盲区**——门垛被画成近乎水平（斜率 0.012 vs 底图 0.292）而 27 轮都没报出来，是用户拿直尺看出来的。

**长直线特征要按斜率拟合验证**，不能只测端点偏差。

### 6.4 Workflow 编排模式

用户明确要求：**subagent 尽量用 opus，并发控制在 2**（可以很多，但要排队）。

```js
// 排队模式：每批 2 个，串行推进
for (let i = 0; i < TASKS.length; i += 2) {
  const rs = await parallel(TASKS.slice(i, i+2).map(t => () =>
    agent(prompt(t), { schema: OUT, model: 'opus' })))
  results.push(...rs.filter(Boolean))
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

### 8.1 加家具

1. **采集真实数据**（不要凭印象编尺寸）：开 workflow 抓官网商品页，拿宽/深/高、价格、**全部配色**
2. **写目录条目**：同款不同色 → **每个配色一个独立条目**（用户明确要求要能挑选），共用一个 `model` 键
   ```js
   {id:'xxx-0', cat:'沙发 / 单椅', name:'名称 · 配色', w:,d:,h:, price:,
    color:'#主色', color2:'#辅色', model:'xxx', kind:'sofa', wood:'pine', url:'...', note:'...'}
   ```
3. **逐件建模**：`MODELS['xxx'] = (C) => {...}`，见 §6.5。未注册的会回退到通用 `kind` 造型
4. **2D 图例**：在 `furnShape` 里加对应 `kind` 的俯视符号
5. **验证**：包围盒与官方尺寸对比（`work/t_models.html` 那套），再隔离渲染目检

分类目前有：沙发/单椅、餐桌椅/吧凳、床/床头柜、收纳/电视柜、书桌/办公椅、
灯具/照明、地毯/爬行垫、茶几/边几。**不要把性质不同的东西合并成一类**（用户为此提过意见）。

**商品名照写瑞典语原拼写**（POÄNG / RÅSKOG / SÖDERHAMN），不要为了好搜就写成 ASCII。
`buildCatalog()` 用 `foldText()` 把查询词和商品名两边都折成 ASCII 再比对，所以
`poang` / `POÄNG` / `poäng` 都能搜到，而列表显示的是正确拼写。折叠规则：
`normalize('NFD')` 去变音符（管 å ä ö é ü），加一张 `FOLD_EXTRA` 表处理不可分解的
`ø æ ß œ đ ł ð þ`（目录里 `Ø` 其实是直径符号，顺带也能用 `o70` 搜到 `Ø70`）。
新增别的语种商品时若出现新字母，往 `FOLD_EXTRA` 里补即可。

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
