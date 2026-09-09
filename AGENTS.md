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

`work/t_walledit.html` 是从 `planner.html` 生成的测试副本，注入了一段测试脚本，用
**真实命中测试 + 合成 PointerEvent** 驱动 UI，目前 **46 条断言**。

### 重新生成（改了 planner.html 之后必做）

```bash
python3 - <<'PYEOF'
import re
s = open('planner.html').read()
old = open('work/t_walledit.html').read()
m = re.search(r"(\n<script>\nwindow\.__ERRS.*?</script>\n</body>)", old, re.S)   # 抽出测试脚本
out = s.replace('</body>', m.group(1), 1)
open('work/t_walledit.html','w').write(out
  .replace("'work/clean_plan.jpg'","'clean_plan.jpg'")     # 测试页在 work/ 下，改相对路径
  .replace("lib/three.min.js","../lib/three.min.js")
  .replace("lib/OrbitControls.js","../lib/OrbitControls.js"))
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
