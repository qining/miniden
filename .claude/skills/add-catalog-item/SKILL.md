---
name: add-catalog-item
description: 往 planner.html 的家具目录里添加新条目（家具/灯具/地毯/儿童用品）：数据采集 → 目录条目 → 3D 建模 → 材质贴图 → 2D 图例 → 验证关卡 → 入库。
---

# 加家具入库

深度说明见 `AGENTS.md` §8.1（本 skill 是它的可执行版本）。此处只放必须遵守的部分。

## 铁律（违反 = 返工）

1. **不看图不建模。** 先抓官方图并**真的用 Read 看**，尤其是零件分解图/尺寸标注图。
2. **不编尺寸。** 页面查不到就用 WebSearch；再查不到就明说查不到，不要填一个"合理值"。
3. **占地必须诚实。** 包围盒对 `spec.w/d/h` 的填充率落在 **92%~102%**。既不能越界，也不能虚报。
   本来就带散件的（如模块沙发的额外积木块）→ **把散件建出来散放旁边并算进占地**，不是不建。
4. **所有部件贴地**：`bbox.min.y > -0.02`。
5. **不许出现无贴图的纯色材质。** 新材质该加就加新贴图。
6. **`#calib` 输出必须逐字节不变**（md5 `1ac26921871db50ef1c055674c10e6e7`）。
7. **全部在主会话里做，不委派 subagent。** 逐件按下面流程推进，每件跑完 check-item 再继续。

## 自我生长（把经验沉淀进本 skill）

这个 skill 要越用越强。**触发条件**：加家具时，用户指出了 agent 自己没发现的问题，
手工 steering 了至少一次才纠正过来——这类问题值得沉淀。
（agent 自己验证时抓出来并修好的，不算，不用沉淀。）

修正完成后走这四步：

1. **根因**：把「为什么一次没做对」归到三类之一：
   - 已有步骤但**口径不够**（例：只看了正面 3/4 图，没看侧面）
   - **步骤不存在**（这类部件/数据/场景压根没被要求核对）
   - 步骤存在且查了，但**判断错了**（透视错觉、小裁剪误判这类感知坑）
2. **泛化测试（硬门）**：要写进 skill 的东西必须能写成
   「**对 X 类部件 / Y 类数据 / Z 类场景，要 W**」，对未来加家具的至少某一类情况有用。
   绑死在某一件家具上的东西（商品名、具体尺寸、具体参数值）**不许进 skill**，
   归到那件的 brief（`work/briefs/`）里。
3. **落点：优先合并/修改，不是只追加**：
   - 与已有条目同根因 → **直接改原条目**（加强口径、扩大适用范围、重写措辞）
   - 新经验和某条已有经验是同一更高层规则的两个侧面 → **二次 generalize**，升成一条更通用的规则
   - 全新症状类 → 「症状 → 原因」加一行，并在对应流程步骤补一句
4. **一致与精简**：SKILL.md 与 AGENTS.md 详细版（§5.3 / §8.1 翻车清单 / 流程步骤）保持同步；
   一条规则一句话说完——若根因要三句话才说得清，先问「这是不是真通用」再写。

示例（形式参考）：用户指出 T 脚方向错 → 根因 = 只看正面 3/4 图、两个朝向长得几乎一样
→ 泛化 = 「条形/定向部件建模前 brief 写死轴向，建模后侧视角渲染图核对」→ 落点 = 建模步骤 + 症状表。

## 流程

### 1. 采集

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless --disable-gpu --virtual-time-budget=20000 --dump-dom "<商品页>" > /tmp/pg.html
```

商品页基本都是 JS 渲染的，**`curl` 抓不到，而且会被反爬把价格字段掐掉（标题却是对的，很容易误判成功）**。

| 站点 | 取法 |
|---|---|
| IKEA | `grep -o '"product_prices":\["[0-9.]*"\]' /tmp/pg.html` |
| IKEA 加拿大 slug 不存在 | `curl -sL "https://sik.search.blue.cdtapps.com/ca/en/search-result-page?q=<词>&size=12"` → JSON 里 `salesPrice.numeral` |
| Amazon | `id="productTitle"` / `"priceAmount":` / `"public_title"`（变体）/ `prodDetails` 表的 `Item Dimensions` |
| Shopify | `"public_title"` + `dimensionValuesDisplayData`（配色全集） |

图片下载后转 PNG 存 `work/ref/<名>.png`，**用 Read 工具看过再往下走**：

```bash
curl -sL -A "Mozilla/5.0" "<图URL>?width=1200" -o /tmp/x.webp
sips -s format png /tmp/x.webp --out work/ref/<名>.png >/dev/null
```

必须拿到：宽/深/高（cm）、价格、**全部配色**。抓完价格做异常值体检：
`CA/US` 比值落在 0.55~2.2 之外多半是命中了系列落地页而非商品页。

**可伸展/带达臂的件**（臂灯、伸缩桌、可旋转件）：`w/d` 必须取官方
Length/reach 对应的**最大占地**，不是机身尺寸。如果录好的 spec 比实际伸展小，
**改目录条目**（note 写清口径），不能在模型里把伸展部分缩小迁就。

### 2. 目录条目

```js
{id:'xxx-0', cat:'沙发 / 单椅', name:'名称 · 配色', w:139.7, d:69.9, h:53.8,
 price:275.57, priceCA:274.97, color:'#主色', color2:'#辅色', seatH:23.9,
 model:'xxx', kind:'playCouch', wood:'pine', url:'...', note:'...'}
```

- **同款不同色 = 每个配色一个独立条目**，共用同一个 `model`
- **写入前查 id / model 唯一性**（`grep "id:'xxx'" planner.html`）：同系列不同品类会撞（PS 2026 推车已有 `id:'ps2026-0'/model:'ps2026'`，落地灯必须改名如 `ps2026l`）
- `price`=美国实际标价、`priceCA`=加拿大实际标价（**不是汇率折算**）；
  `caVar`=同型号但面料/配置不同、`caNA`=加拿大不售
- 固定在墙/天花的灯（`downlight/ceilingLight/vanityLight/pendant`）**不写价格**，公寓自带；
  可调光落地灯要计价但加 `dimmable:true` 才有色温/亮度控件
- 商品名照写原文拼写（POÄNG / RÅSKOG），搜索层会自动折叠 ASCII
- 分类不要合并性质不同的东西；加新 `kind` 要同时管
  `furnMats()`（材质）、`furnShape()`（2D 图例）、`vSpan()`（高度区间）

### 3. 建模

`MODELS['xxx'] = (C) => {...}`，用 `C.box/rb/cyl/tube/sph/torus/ext/lathe/cushion/legT/rep`。
「几个方块拼一下」不算建模——参考量级 2000–15000 三角形，要有倒角、腿部收分、把手、缝线。

**复合欧拉角是头号杀手**：同一个 mesh 上叠 `rotation.x` + `rotation.y/z`，
three 按 XYZ 序复合会把块转翻、沉到地板下。正确姿势：

- 旋转和落地**分开**：mesh 只管「形状 + 抬到地面」，外面套一个 `Group` 只管绕竖轴转向
- 能用形状表达就别用旋转（半圆柱 → 半圆 `Shape` 挤出，直边天然落在 y=0）
- `C.ext(..., 'xz')` 的挤出方向是 **−y**，要把 `position.y` 抬一个厚度

**条形/定向部件先写死轴向**：T 脚、板条、边带、横臂、杆这类部件，建模前在
brief 里写清「沿 x 还是 z、平行长边还是短边」——正面 3/4 图下两个方向长得
几乎一样，只看正面图必错（BEKANT/TROTTEN 的 T 脚就整轴写反过 90°）。
建模后用**侧视角渲染图**核对，拿不准就 `?nomerge` 逐 child 打 bbox。

**多件套装先算整组 bbox span**：例：大 60 + 小 30 = 90 恰等于 spec 宽时，
「嵌套（重叠 > 0）」和「满 span」不可能同时成立。选一个偏移让整组 span
落在 92~102% 填充窗内即可（VITTSJÖ 套几：span 85 = 94%）。

散件位置**不能从 `spec.w/d` 反推**（改 spec 又改包围盒，收敛不了）→ 用相对主体的固定偏移。
模型末尾做水平重心归零。**含旋转件时必须按真实顶点求 bbox**：
`Box3.setFromObject` 对旋转 mesh 按局部包围盒 8 角点算（过度估计），
中心与合并后真实顶点 bbox 不一致，归零会偏 1cm 量级（lunix 实测偏 7.9cm）：

```js
C.g.updateMatrixWorld(true);
const bb = new C.THREE.Box3();
C.g.traverse(o=>{
  if(o.isMesh && o.geometry){
    const pos = o.geometry.attributes.position, v = new C.THREE.Vector3();
    for(let i=0; i<pos.count; i++){ v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); bb.expandByPoint(v); }
  }
});
const off = new C.THREE.Vector3(); bb.getCenter(off);
for(const ch of C.g.children){ ch.position.x -= off.x; ch.position.z -= off.z; }
```

### 4. 材质贴图

`C.M(color, {wood:'pine'|fabric|leather|plastic, rough, metal, clear, sheen, envI})`。
现成贴图：`woodSpecies` `fabricTexture` `laminateTexture` `carpetTexture`
`powderCoatTexture` `plasticTexture` `leatherTexture` `brushedSteelTexture`
`grayOakTexture` `quartzTexture`。

**凑不出实物质感就写新的**（藤编/大理石/亚麻/磨砂玻璃/拉丝黄铜…）：

```js
let _xxxTex = null;
function xxxTexture(){
  if(_xxxTex) return _xxxTex;
  srand(1016);                                  // 必须固定种子（1001~1015 已占用）
  const N=512, c=document.createElement('canvas'); c.width=c.height=N;
  const g=c.getContext('2d');
  g.fillStyle='#fdfcfa'; g.fillRect(0,0,N,N);   // 基调接近白，靠 material.color 上色
  /* …用 rnd01() 画… */
  const t=new THREE.CanvasTexture(c);
  t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(2,2);
  t.encoding=THREE.sRGBEncoding;                // 必须！否则渲染发白
  t.anisotropy=8; _xxxTex=t; return t;
}
```

- 必须 `srand()` + `rnd01()`，不能 `Math.random()`（渲染确定性是回归测试的前提）
- `envMapIntensity` 默认 1 对彩色材质是灾难（饱和色会被白光冲成粉彩）：
  塑料 0.22–0.35 / 织物 0.12–0.20 / 木头 0.6 / 金属 0.8–0.95
- `sheen` 给大了整块发白（0.2 上下即可）
- 贴图密度随尺寸变用 `texScaled()`，**不能按件 clone 纹理**

### 5. 2D 图例

新 `kind` 要在 `furnShape()` 里加俯视符号，否则只有一个通用圆角矩形。

**两种坐标别混**（Hape 木琴栽过：符号放大 S≈22 倍，变成巨无霸色块）：
- `R()` helper **内部会对参数乘 S**（吃**英尺**：`R(-wf/2,-df/2,wf,df,rxPx,...)`，`rx` 例外，直接 px）
- 裸 `el('circle'/'line'/'rect')` **直接吃像素**（英尺值要自己 `*S`）
- `wp=wf*S` / `dp=df*S` 已经是 px，**传给 `R()` 就会被二次放大 S²**
口径：一律先用 `wf`/`df`（英尺）算几何，传给裸 `el()` 时再乘 `S`；`R()` 只喂英尺。

## 验证（四关全过才算完）

以下命令**都从仓库根执行**。`check-item.py` 就在本 skill 目录里，
下面写的是仓库根视角的路径（pi 从 `.agents/skills/` 软链加载时指向同一个文件）。

```bash
# 关 1：语法
python3 -c "
import re
h=open('planner.html').read(); m=re.search(r'<script>\n(.*?)</script>', h, re.S)
open('/tmp/p.js','w').write(m.group(1))" && node --check /tmp/p.js

# 关 2+3：单件体检（包围盒/填充率/重心/贴地/材质/缩略图）+ 隔离渲染出图
python3 .claude/skills/add-catalog-item/check-item.py <条目id>
# → 输出两张 PNG：主 3/4 前视角 + 侧视角（work/ref/check_<id>.png / check_<id>_side.png）
#   出图后**立刻**走下面的「并排目检」，不要攒到最后一并看

# 关 4：全量回归
python3 .claude/skills/add-catalog-item/check-item.py --regress
```

**关 4 之外还要看这几条断言**（`work/t_3d.html`）：
`catalog-all-build` / `catalog-all-textured` / `catalog-all-normalmapped` /
`catalog-tri-avg` / `catalog-tri-max` / `thumb-renders`。

**并排目检（硬条件，不能跳过）**：体检出图后，在**同一会话里按顺序 Read**，让图直接列在终端里，人和 agent 看的是同一组帧：

0. **先走三视图**（用户 2026-09 要求）：从商品页 3/4 照片**反推前/侧/俯三个正交轮廓**
   （主轮廓、部件位置朝向、悬空/穿透），跑 `work/threeview_probe.html#threeview:<id>`
   把模型渲成同样三个 ortho 视角逐项比。轮廓错误（A/V 翻倒、部件悬空、嘴鼻朝向、
   前视图是梯形还是矩形）只有正交视图能抓。
0b. **结构组成必须在看参考图时就提取**（2026-09 木马/麋鹿返工教训）：每个部件是
   **一块板还是两块**（中央单板 vs 两侧各一）、板面**朝向哪个方向**（侧面可见还是正面可见）、
   **前视图轮廓**（梯形/A/V/矩形）。例：木马=两侧板只含身体（梯形外张，上窄下宽）+
   头颈中央单板；麋鹿=两侧板只含身体 + 头中央单板。只数「几个部件」不够，
   要数「每部件几块板、板朝哪」，否则前视图会露馅（两块平行板 vs 一块板）。
1. 再 Read 从商品页抓好的参考实拍（`work/ref/<名>/v*.jpg`）——建立正确印象。
   **视角以商品页实际存在的为准**（常见是 3/4 斜视角、细节特写），不要预设一定有正面/侧面
2. 再 Read 渲染图 `work/ref/check_<id>.png`（主 3/4 前视角）和 `check_<id>_side.png`（侧视角）
3. **每张渲染图挑参考图里视角最接近的那张**逐项比对，边看边说哪里对哪里不对，不要只说「看起来还行」

逐项比：部件数量 → 形状 → 相对位置朝向 → 比例 → 颜色 → 材质 → 特征细节（把手/缝线/螺丝/logo/脚垫）。
- 一张 3/4 实拍可以同时核对主视角和侧视角；参考图若是细节特写，用整体图核对比例、特写核对细节
- 侧面轮廓（腿距、悬挑、背部结构、深度比例）只有在能看到侧面的角度才露馅；完全没有侧面参考图时，补抓变体图再下结论
- **只比 3/4 斜视角会放过轮廓错误**：三视图（front/side/top ortho）是轮廓的仲裁者，每件必走
- 拿不准就 `sips -z` 放大裁剪重看（小裁剪会误判，扩大范围再看）
- **攒到最后一起看 = 放过比例错误**（T 脚 90° 就是只靠数字体检过、用户目检才抓到的）；每件出图后立刻并排看。

给新家具补一条常驻断言进 `work/t_3d.html`（参考现有的 `lunix-*` 那组），
然后按 `AGENTS.md` §3 重新生成三个测试台。

## 症状 → 原因

| 症状 | 原因 |
|---|---|
| 2D 图上比 3D 里小一圈 | 建模超出 `spec.w/d`，或散件没算进占地 |
| 半截埋进地板 | 复合欧拉角转翻了；或 `C.ext(...,'xz')` 忘了抬一个厚度 |
| 偏在格子一角 | 没做水平重心归零 |
| centered 断言偏 ~1cm（含旋转件） | `Box3.setFromObject` 对旋转 mesh 过度估计，中心 ≠ 真实顶点 bbox 中心 | 归零改按真实顶点求 bbox（traverse + `fromBufferAttribute` + `applyMatrix4`） |
| 近看像塑料板 | 材质没贴图 → 跑 `catalog-all-textured` |
| 彩色件变粉彩色 | `envMapIntensity` 默认 1 + clearcoat |
| 贴图发白 | `CanvasTexture` 漏了 `encoding=sRGBEncoding` |
| 两个配色缩略图长一样 | 光照过曝（`physicallyCorrectLights=false` 时 three 会乘 π） |
| 改尺寸后包围盒跟着变，调不拢 | 散件位置从 `spec.w/d` 反推了 |
| T 脚/条形部件方向错 90° | 只看正面 3/4 图建模 | brief 写死轴向，侧视角渲染图核对 |
| 占地缺了伸展部分（臂灯只占机身） | 采集只录了机身 w/d | 核对官方 Length/reach，spec 错了就改目录条目 |
| 斜网/斜面整体高出占地一截 | 单 mesh 同时设 rotation.x/y/z：Euler XYZ 序按 Rz→Ry→Rx 复合，宽边也被倾斜 | 复合姿态拆成父子：子 mesh 只做一个轴的旋转，父 Group 做另一个（ SPORTSLIG 斜网用 group 绕 x 倾 + 内部绕 y 转） |
| 杆/管被抬到离地一米多 | C.box/C.cyl/C.rb 的 y 是**底对齐**：横放圆柱底 = 中心高 − len/2（len 是杆长不是半径），曾把 88cm 横杆写到 y 89cm | 先算中心高再减半个杆长：`C.cyl(r,r,len,mat,x, cy-len/2, z)` 再 `rotation.x=π/2` |
| 占地多出 2~3cm 且找不到超界件 | 圆截面（胶囊端帽/圆管）比它贴的平面凸出半径 r | 探针打印各 mesh 的 max.z/max.x 找圆件；把它整体后移一个 r 使凸缘贴平（横杆布套 r 2.7 超前面 2.7cm） |
| A 型架建成 V 型（上下颠倒） | 摇摆架/攀爬架立柱是**向上**外张（下窄上宽），建成向下外张 | 前视图反推：宽端朝哪？A 型宽端朝上 | 
| 中央单板部件建成两块平行板（头/颈/靠背） | 参考图只数了部件数没数板数 | 看参考图数板：前视图里是一板还是两板（木马/麋鹿的头颈都是中央单板，侧板只含身体） |
| 前视图轮廓错（该梯形建成矩形） | 只从侧视图建模，没反推前视图 | 梯形/外张件：侧板绕 x 轴外张（`m.rotation.x=±θ`，绕地面 y=0 为轴→底部不动顶部内收） |
| 调过的 mesh 突然沉进地板/飞走 | helper（C.box 等）已设过 position，事后 `m.position.y=cm(x)` 是**替换**不是累加 | 要平移用 `+=`，或把完整值传给 helper |
| 脚本批量替换删掉一大段代码 | 无界 `find("return C.g;")`：目标块不含该串时命中**下一个**模型的 return | 块边界用有界搜索：两个相邻 `MODELS['…']` marker 之间 rfind |
| 多件套装嵌套与总宽矛盾 | 60+30=90 时嵌套必缩 span | 先算整组 bbox span，选偏移进 92~102% 窗 |
| 填充率超窗但不知哪个部件超了 | 灯环/绕线带/拉手外缘超 spec | `?nomerge` 逐 child 打 bbox 找最宽部件 |
| CatmullRom 曲线在长直线+短弧交界处过冲 | 长段只给两个端点，切线被大段拉偏（NIPÅSEN 侧框外溢 0.4cm） | 长直线段按 ~40cm 间隔加密中间点再建 CatmullRomCurve3 |
| 曲线点忘乘 `cm()`（cm 值被当英尺） | 钩子/管件突然放大 ~30 倍，bbox 爆到 200%+（NIPÅSEN 钩子 395cm） | 手建 Vector3 曲线点与 `C.box`/`C.cyl` 参数一样逐个 `cm()`；填充率体检能抓 |
| 已换算值再包一层 `cm()`（双重转换） | 部件缩小 30 倍几乎看不见（Lil' Kick 轮胎/轮毂/花瓣半径 0.1cm，轮子只剩一圈幽灵） | 参数已是英尺（如 `R=cm(7.5)`）就直接用 `R`、`0.43*R`，不要再套 `cm()`；渲染图里「该大的部件很小」先查这个 |
| Group/holder 里的 `C.rb`/`C.cushion` 子件被抬高半高 | 后仰垫/腰枕整体偏高一半厚度（8 件沙发全部 y 溢出 114~128%） | 子件局部几何是 **y 0..h 底对齐**（不是居中）；要绕中心旋转先 `child.position.y -= cm(h/2)` 再进 holder |
| `C.cyl` 只传 7 个参数（漏了 y） | seg 值落进 z 槽，腿/柱飞到 z=12ft（365cm），bbox z 爆 400%+ | 必须写全 8 个位置参数 `C.cyl(rTop,rBot,h,mat,x, 0, z, seg)`；bbox 探针的「某轴爆炸 + 单条窄板」就是它 |
| 居中件偏了「一个半径」 | `C.rb`/`C.box` 的 x/z 是**中心点**不是角点：想让 11cm 块居中却写 (-5.5, 0, -5.5)，整块偏 5.5cm，上面的部件悬空（DYVLINGE 底座块） | 居中写 (0,0,0)，偏移用 ±w/2；bbox 探针「对称件整体偏半宽」就是它 |
| 模型「不报错」但其实是通用回退造型 | `furn3D` 对注册模型的异常是 **try/catch 静默回退**（只 console.warn），mesh 是自定义+通用的混合体 | 验证探针要抓 console.warn，或数 mesh 数/三角形数对照预期；「没抛错」不是验收标准（`Object3D` 没有 `.translate()`，`mesh.translate()` 就属于这种炸法） |
| rboxGeo 薄板退化（r ≈ h/2） | 基形先缩 2r 后基形接近扁平，圆角形状病态，成品尺寸漂移（17cm 板渲出 20.5cm） | 厚度 < 2r+余量 时改用直角 `C.box`，或选 r < h/2 留足基形厚度 |
| C.box 的 x/z 也是中心点（同 C.rb） | 想让板从 0 延伸到 w 却把 ±w/2 写成 x → 整板偏半个板长，bbox 爆 1.46×（BARLAST 十字底座两板交叉处重叠出 48cm 宽） | 居中写 (0,0,0)；要偏置写 ±w/2 而不是 ±w |
| 旋转件的 bbox 比名义尺寸高 | `Box3.setFromObject` 按局部包围盒 8 角点算旋转体（过度估计）：60cm 板倾 3.4° 的 bbox 竖直方向多 3.6cm | 倾垫/倾斜面板的正常现象，别当成建模错误；填充率余量本就吸收它 |
| 抓到的价格离谱 | 命中系列落地页而非商品页 |
| 两次渲染结果不一致 | 新贴图用了 `Math.random()` |
| 手摆相机后画布是空的 | `OrbitControls.update()` 把相机拉回去了 → 先同步 `controls.target` 再 `update()` |
| 成品比 spec 大一圈 | `C.ext(..., bevel)` 的 `bevelSize` 是**向外扩**的：轮廓要先减掉倒角量。深度它已经补偿了，截面没有 |
| 折线管件像一串香肠 | `C.tube` 的胶囊端帽收在端点上，首尾相接会在每个折点掐出腰 → 每段 `C.tube(L + 2r, ...)` 让相邻段搭接 |
| C.cyl 想当「中心在某高度」的横杆/顶杆 | C.cyl 是**底对齐**（add 时 y+h/2）：把中心高直接传给 y，144cm 杆被抬到 132cm（bbox 爆 155%）| 调用后 `m.position.y=cm(中心高)` 再转，或传 `中心高−len/2` |
| work/ 里堆满一次性探针 HTML（用户要手动清理）| 每次调试都在 version 控制目录里新建探针页、用完不删；放 /tmp 又因相对 `lib/` 路径失效不可复用 | 复用**一个**探针模板：planner.html 副本放 work/ + lib 改 `../lib`，同一命令末尾立即 `rm`；探针无输出先查页面目录与 lib 相对路径是否匹配 |
