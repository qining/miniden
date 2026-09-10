---
name: add-catalog-item
description: 往 planner.html 的家具目录里加家具、灯具、地毯、儿童游具等任何家装用品时使用。覆盖数据采集、几何与建模、材质贴图、以及必须跑完的验证关卡。用户给了商品链接或图片、说"加个XX进去"、"目录里再加"时就用这个。
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

### 2. 目录条目

```js
{id:'xxx-0', cat:'沙发 / 单椅', name:'名称 · 配色', w:139.7, d:69.9, h:53.8,
 price:275.57, priceCA:274.97, color:'#主色', color2:'#辅色', seatH:23.9,
 model:'xxx', kind:'playCouch', wood:'pine', url:'...', note:'...'}
```

- **同款不同色 = 每个配色一个独立条目**，共用同一个 `model`
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

散件位置**不能从 `spec.w/d` 反推**（改 spec 又改包围盒，收敛不了）→ 用相对主体的固定偏移。
模型末尾做水平重心归零：

```js
C.g.updateMatrixWorld(true);
const bb = new C.THREE.Box3().setFromObject(C.g);
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

## 验证（四关全过才算完）

```bash
# 关 1：语法
python3 -c "
import re
h=open('planner.html').read(); m=re.search(r'<script>\n(.*?)</script>', h, re.S)
open('/tmp/p.js','w').write(m.group(1))" && node --check /tmp/p.js

# 关 2+3：单件体检（包围盒/填充率/重心/贴地/材质/缩略图）+ 隔离渲染出图
python3 .claude/skills/add-catalog-item/check-item.py <条目id>
# → 看它输出的 PNG，对照 work/ref/ 里的实拍图

# 关 4：全量回归
python3 .claude/skills/add-catalog-item/check-item.py --regress
```

**关 4 之外还要看这几条断言**（`work/t_3d.html`）：
`catalog-all-build` / `catalog-all-textured` / `catalog-all-normalmapped` /
`catalog-tri-avg` / `catalog-tri-max` / `thumb-renders`。

**对着实拍图逐项比**：部件数量 → 形状 → 相对位置朝向 → 比例 → 颜色 → 材质 → 特征细节
（把手/缝线/螺丝/logo/脚垫）。

给新家具补一条常驻断言进 `work/t_3d.html`（参考现有的 `lunix-*` 那组），
然后按 `AGENTS.md` §3 重新生成三个测试台。

## 症状 → 原因

| 症状 | 原因 |
|---|---|
| 2D 图上比 3D 里小一圈 | 建模超出 `spec.w/d`，或散件没算进占地 |
| 半截埋进地板 | 复合欧拉角转翻了；或 `C.ext(...,'xz')` 忘了抬一个厚度 |
| 偏在格子一角 | 没做水平重心归零 |
| 近看像塑料板 | 材质没贴图 → 跑 `catalog-all-textured` |
| 彩色件变粉彩色 | `envMapIntensity` 默认 1 + clearcoat |
| 贴图发白 | `CanvasTexture` 漏了 `encoding=sRGBEncoding` |
| 两个配色缩略图长一样 | 光照过曝（`physicallyCorrectLights=false` 时 three 会乘 π） |
| 改尺寸后包围盒跟着变，调不拢 | 散件位置从 `spec.w/d` 反推了 |
| 抓到的价格离谱 | 命中系列落地页而非商品页 |
| 两次渲染结果不一致 | 新贴图用了 `Math.random()` |
| 手摆相机后画布是空的 | `OrbitControls.update()` 把相机拉回去了 → 先同步 `controls.target` 再 `update()` |
| 成品比 spec 大一圈 | `C.ext(..., bevel)` 的 `bevelSize` 是**向外扩**的：轮廓要先减掉倒角量。深度它已经补偿了，截面没有 |
| 折线管件像一串香肠 | `C.tube` 的胶囊端帽收在端点上，首尾相接会在每个折点掐出腰 → 每段 `C.tube(L + 2r, ...)` 让相邻段搭接 |
