// E1-1: 构建管线（E17 起：一个事实来源，两个入口）
//
// 事实来源（唯一，入库）：app.html —— 内嵌 generic 通用户型，也是公开/用户入口的源文件。
// 构建产物（全部 gitignore）：
//   dist/app.html      公开入口单文件（generic 户型，绝不含 private/ 引用）
//   dist/planner.html  个人入口单文件（注入 private/plans/mine.json = 西雅图公寓；ui-gate/黄金基线用它）
//   planner.html       个人入口「源形式」（app.html + mine 替换，lib/ 外链保持）——**入库**
//                      → 改完 app.html 直接刷新就能看到，不用先 build；你日常打开的那个文件
//                      → 因此它含真实户型坐标，与历史里已有的同一份数据同级（AGENTS §1.4）
// 两个入口共用同一份代码 → 新工具/新功能/新家具只写一次，两边同时生效。
// 同步由测试台强制：同一套 plan-independent bench 跑 source(mine) / dist(mine) / dist(generic) 三份。
//
// 原则：「move, not rewrite」——不改变任何逻辑，只做：
//   1. 从 app.html 抽出内联 <script>（唯一事实来源）
//   2. 加两行 ESM 前言（import 本地 lib/ 的 three + OrbitControls，接上裸 THREE 引用）
//   3. esbuild bundle 成 IIFE（three/OrbitControls 内联 → 真正单文件）
//   4. 拼回 HTML（去掉两个 lib <script src> 标签，内联 bundle）
//
// 等价性验收（每次构建后跑）：
//   - #calib 截图 md5 == 1ac26921871db50ef1c055674c10e6e7（mine plan；generic 无基线）
//   - work/t_3d*.html / t_pt*.html（构建生成，plan-independent 脚本）全绿
//   - S10：plan 注入（mine 存在时）+ private/ 路径修复
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { bundleSchema } from './scripts/build-schema.mjs';
import { bundleGeo } from './scripts/build-geo.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const TMP = join(root, 'build', 'tmp');
const DIST = join(root, 'dist');

const html = readFileSync(join(root, 'app.html'), 'utf8'); // 唯一事实来源（入库版内嵌 generic）

// --- S1 Phase 2a：校验嵌入的 schema 块 == src/schema/ 最新编译（单一事实来源）---
const freshSchema = await bundleSchema();
const SCHEMA_START = '<script id="miniden-schema">\n';
const SCHEMA_END = '\n</script><!-- /miniden-schema -->';
const sa = html.indexOf(SCHEMA_START);
if (sa < 0) throw new Error('app.html 缺 <script id="miniden-schema">（跑 npm run schema:build）');
const sb = html.indexOf(SCHEMA_END, sa);
const embedded = html.slice(sa + SCHEMA_START.length, sb);
if (embedded !== freshSchema) {
  console.error('✗ 嵌入的 schema 块与 src/schema/ 最新编译不一致。跑 `npm run schema:build` 后重试。');
  process.exit(1);
}
console.log('  schema: 嵌入块与 src/schema/ 最新编译一致');

// --- S5：校验嵌入的 geo 块 == src/geo/ 最新编译 ---
const freshGeo = await bundleGeo();
const GEO_START = '<script id="miniden-geo">\n';
const GEO_END = '\n</script><!-- /miniden-geo -->';
const ga = html.indexOf(GEO_START);
if (ga < 0) throw new Error('app.html 缺 <script id="miniden-geo">（跑 npm run geo:build）');
const gb = html.indexOf(GEO_END, ga);
const geoEmbedded = html.slice(ga + GEO_START.length, gb);
if (geoEmbedded !== freshGeo) {
  console.error('✗ 嵌入的 geo 块与 src/geo/ 最新编译不一致。跑 `npm run geo:build` 后重试。');
  process.exit(1);
}
console.log('  geo: 嵌入块与 src/geo/ 最新编译一致');

// --- S10：校验嵌入的 #miniden-plan 块 == data/plans/generic.json（入库版唯一事实来源）---
// 两者静默分叉的话，CI 跑的户型和 data/ 里的不是同一个，查起来很贵。
{
  const PSTART = '<script type="application/json" id="miniden-plan">\n';
  const PEND = '\n</script>';
  const pa = html.indexOf(PSTART);
  if (pa < 0) throw new Error('app.html 缺 <script type="application/json" id="miniden-plan">');
  const pb = html.indexOf(PEND, pa);
  const embPlan = JSON.parse(html.slice(pa + PSTART.length, pb));
  const genPlan = JSON.parse(readFileSync(join(root, 'data/plans/generic.json'), 'utf8'));
  if (JSON.stringify(embPlan) !== JSON.stringify(genPlan)) {
    console.error('✗ app.html 的 #miniden-plan 块与 data/plans/generic.json 不一致（入库版必须是 generic）。');
    process.exit(1);
  }
  console.log('  plan: app.html 嵌入块与 data/plans/generic.json 一致（公开入口的户型）');
}

// --- 抽取内联脚本（唯一的裸 <script> 标签）---
const START = '<script>\n';
const i = html.indexOf(START);
const j = html.lastIndexOf('</script>');
if (i < 0 || j < 0 || j < i) throw new Error('找不到内联脚本边界');
const body = html.slice(i + START.length, j);
const tail = html.slice(j + '</script>'.length);

// --- head：去掉 lib 外链标签；dxf-parser 内联进 dist（单文件）---
const dxfLib = readFileSync(join(root, 'lib', 'dxf-parser.iife.js'), 'utf8');
const head = html
  .slice(0, i)
  .replace('<script src="lib/three.min.js"></script>\n', '')
  .replace('<script src="lib/OrbitControls.js"></script>\n', '')
  .replace(
    '<script src="lib/dxf-parser.iife.js"></script>\n',
    '<script>\n' + dxfLib.replace(/\$/g, '$$$$') + '\n</script>\n<!-- dxf-parser 内联（S5：单文件产物） -->'
  );
if (
  head.includes('lib/three.min.js') ||
  head.includes('lib/OrbitControls.js') ||
  head.includes('lib/dxf-parser.iife.js')
)
  throw new Error('lib 标签处理失败（head 里还有残留）');

// --- S6：pdf.js 双库内联进 dist head（懒执行）---
// 源码版靠 <script src> 懒加载（点按钮才注入）；dist 是单文件，没有 lib/ 可指 →
// 把两个 IIFE 以 JSON 字符串块内联，UI 层 loadPdfLibs() 检测到 #pdfJsInline 时用
// new Function 执行（worker 侧效挂 globalThis.pdfjsWorker → getDocument 主线程 fake worker）。
// 页面无 PDF 导入需求时零解析成本（JSON 文本块，不参与 JS 解析）。
const pdfWSrc = readFileSync(join(root, 'lib', 'pdf.worker.min.js'), 'utf8');
const pdfMSrc = readFileSync(join(root, 'lib', 'pdf.min.js'), 'utf8');
// 替换串里的 $ 必须转义（AGENTS §5.1）：pdf.js 压缩代码含模板串 `$`` →
// String.replace 会把它展开成「</head> 匹配点之前的整个文档」，把 planner 源码
// 灌进 JSON 块（220 个裸换行 → JSON.parse 炸）。
const head2 = head.replace(
  '</head>',
  '<script type="application/json" id="pdfJsInline">' +
    JSON.stringify([pdfWSrc, pdfMSrc]).replace(/\$/g, '$$$$') +
    '</script>\n</head>'
);
if (!head2.includes('id="pdfJsInline"')) throw new Error('pdfJsInline 注入失败');

// --- 生成 ESM 入口（临时文件，不入库）---
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

// OrbitControls（examples/js 风格：裸 THREE 引用）→ 用模块作用域 const 接上
// three.min.js 是 UMD：esbuild 按 CJS 解析（package.json 无 "type"）→
// import 的 default = module.exports = 完整 THREE 对象（可变，可挂 OrbitControls）
// 注意：脚本体自己有一个顶层 `let three`（3D 状态）→ 导入名必须避开
writeFileSync(
  join(TMP, 'oc.mjs'),
  `import threeLib from '../../lib/three.min.js';\nconst THREE = threeLib;\n` +
    readFileSync(join(root, 'lib', 'OrbitControls.js'), 'utf8')
);

// classic script → ESM：顶层函数重复声明在 classic 里合法（后声明者胜出、
// 前者是死代码），在 ESM 里是 SyntaxError → 忠实复刻语义：只保留最后一个。
// 结束行判定用代码风格规则（已验证：全部 207 个顶层函数都以 col-0 的 `}` 行
// 结束）——不用花括号扫描器（正则字面量/字符串会让它失同步）。
function dedupeToplevelFunctions(src) {
  const lines = src.split('\n');
  const decls = new Map();
  lines.forEach((l, idx) => {
    const m = l.match(/^function\s+([A-Za-z_$][\w$]*)/);
    if (m) {
      const a = decls.get(m[1]) || [];
      a.push(idx);
      decls.set(m[1], a);
    }
  });
  const firsts = [];
  for (const [name, idxs] of decls) if (idxs.length > 1) idxs.slice(0, -1).forEach((x) => firsts.push([name, x]));
  if (!firsts.length) return src;
  const endOf = (start) => {
    for (let m = start + 1; m < lines.length; m++) if (lines[m] === '}') return m;
    throw new Error(`重复函数在 ${start + 1} 行：找不到 col-0 结束行（代码风格破坏？人工处理）`);
  };
  const drop = new Set();
  for (const [name, start] of firsts) {
    const end = endOf(start);
    // 安全断：删除区间不得吞掉下一个同名声明
    if (firsts.some(([n2, s2]) => n2 === name && s2 > start && s2 <= end))
      throw new Error(`重复函数 ${name} 区间异常，人工处理`);
    for (let x = start; x <= end; x++) drop.add(x);
  }
  console.log(`  dedupe: 移除重复顶层函数声明 ${firsts.map(([n]) => n).join(', ')}（保留最后定义，classic 语义）`);
  return lines.filter((_, idx) => !drop.has(idx)).join('\n');
}

const bodyEsm = dedupeToplevelFunctions(body);

// 全局契约：原 classic script 的顶层声明有两层暴露——
//   ① var/function → window 属性；② let/const → 全局词法环境（跨 script 共享但不在 window）
// ESM 模块把两层都变成私有；外部注入脚本（测试台）靠裸名查找 → 只能靠 globalThis 属性
// 补回来。所以镜像 = **全部**顶层声明（var/let/const/function）。
// 对真实用户无副作用（没有外部脚本时这层镜像无人引用）。
// 两个防护：
//  (a) 扫描前先剥掉块注释（注释里的 C 风格代码如 `const float PI` 会被误当声明——幻影名）
//  (b) 用 getter 而不是赋值：很多名字是**会被重新绑定的 let**（最典型的是 `three`：
//      模块求值末它是 null，3D 场景异步建好后才重新赋值；`saveGeo`/`drawFurniture` 同理）。
//      一次性赋值快照会永远停在旧值；getter 让外部每次访问都读到当前绑定。
//      幻影名用 typeof 先筛掉（typeof 对未声明名安全，不会抛）。
const noComments = bodyEsm.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const names = [];
const kind = {};
/* 多声明器顶层行（`const A = x, B = y;`）必须把每个名字都抽出来。
   旧正则只抽第一个名字（它只认 `const a, b, c` 这种无初始化的列表），
   于是 `const ITEMS_KEY = …, ITEMS_KEY_OLD = …` 里的第二个名字在 dist 里没有镜像
   → 注入脚本（测试台）裸用就 ReferenceError（source 页是 classic，反而正常）。
   这里按 depth-0 逗号切段，每段取开头标识符；字符串/正则里的括号可能让 depth 失同步，
   但只会多产生幻影名，而幻影名被下面的 typeof 守护接住（typeof 对未声明名安全）。 */
function declNames(line) {
  const m = line.match(/^(var|let|const)\s+/);
  if (!m) return null;
  const kw = m[1];
  const rest = line.slice(m[0].length);
  const out = [];
  const flush = (seg) => {
    const nm = seg.match(/^\s*([A-Za-z_$][\w$]*)/);
    if (nm) out.push(nm[1]);
  };
  let depth = 0,
    segStart = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === '(' || c === '[' || c === '{' || c === '`') depth++;
    else if (c === ')' || c === ']' || c === '}' || c === '`') depth--;
    else if (c === ',' && depth === 0) {
      flush(rest.slice(segStart, i));
      segStart = i + 1;
    }
  }
  flush(rest.slice(segStart));
  return { kw, out };
}
for (const l of noComments.split('\n')) {
  let m = l.match(/^function\s+([A-Za-z_$][\w$]*)/);
  if (m) {
    names.push(m[1]);
    kind[m[1]] = 'fn';
    continue;
  }
  const d = declNames(l);
  if (d)
    for (const n of d.out) {
      names.push(n);
      if (!kind[n] || (kind[n] === 'const' && d.kw !== 'const')) kind[n] = d.kw;
    }
}
const uniq = [...new Set(names)].filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
// 可重绑定名（var/let/function）必须带 setter：外部脚本（测试台）会写它们
//（典型：`uidSeq++`——sloppy classic script 对 getter-only 属性赋值会静默失败 →
// 两个家具拿到同一个 uid → furnMap 互相覆盖 → 拾取/拖动全挂）。
// const 保持 getter-only（原 classic 里给 const 赋值本来就会 TypeError）。
const mirror = uniq
  .map((n) => {
    const def =
      kind[n] === 'const'
        ? `{ get: () => ${n}, configurable: true }`
        : `{ get: () => ${n}, set: v => { ${n} = v }, configurable: true }`;
    return `if (typeof ${n} !== "undefined") Object.defineProperty(globalThis, ${JSON.stringify(n)}, ${def});`;
  })
  .join('\n');

writeFileSync(
  join(TMP, 'entry.mjs'),
  `import threeLib from '../../lib/three.min.js';\nimport './oc.mjs';\nconst THREE = threeLib;\n` +
    `globalThis.THREE = threeLib;  // 原页面 window.THREE 由 three.min.js UMD 建立；注入脚本（测试台）裸用\n` +
    bodyEsm +
    `\n// 全局契约镜像（构建生成）：原 classic script 顶层 var/function → window\n` +
    mirror +
    '\n'
);
console.log(`  global mirror: ${uniq.length} names`);

// --- bundle ---
const { errors, outputFiles } = await esbuild.build({
  entryPoints: [join(TMP, 'entry.mjs')],
  bundle: true,
  format: 'iife',
  minify: false,
  write: false,
  target: 'chrome110',
});
if (errors.length) {
  console.error(outputFiles?.[0]?.text || errors);
  process.exit(1);
}
const bundle = outputFiles[0].text;

// --- 组装单文件 HTML ---
mkdirSync(DIST, { recursive: true });
let out = head2 + '<script>\n' + bundle + '\n</script>' + tail;

// --- E17：户型注入助手（同一份 bundle，只换 #miniden-plan 块）---
const PSTART = '<script type="application/json" id="miniden-plan">\n';
const PEND = '\n</script>';
function withPlan(pageHtml, planJson, where) {
  const pa = pageHtml.indexOf(PSTART);
  if (pa < 0) throw new Error(`${where} 缺 #miniden-plan 块`);
  const pb = pageHtml.indexOf(PEND, pa);
  return pageHtml.slice(0, pa + PSTART.length) + JSON.stringify(planJson, null, 1) + pageHtml.slice(pb);
}
const planName = (pageHtml) => {
  const pa = pageHtml.indexOf(PSTART);
  return JSON.parse(pageHtml.slice(pa + PSTART.length, pageHtml.indexOf(PEND, pa))).name;
};
const planOfPage = (pageHtml) => {
  const pa = pageHtml.indexOf(PSTART);
  return JSON.parse(pageHtml.slice(pa + PSTART.length, pageHtml.indexOf(PEND, pa)));
};
// S13：测试台不得带个人布局 —— bench 要确定性、且 plan-independent（同一套脚本跑两个户型）。
// 布局播种逻辑本身在 private/bench/t_walledit.js 里用合成 PLAN.layout 测（不靠个人数据）。
function stripPlanLayout(pageHtml) {
  const pa = pageHtml.indexOf(PSTART);
  if (pa < 0) return pageHtml;
  const pb = pageHtml.indexOf(PEND, pa);
  const p = JSON.parse(pageHtml.slice(pa + PSTART.length, pb));
  p.layout = null;
  return pageHtml.slice(0, pa + PSTART.length) + JSON.stringify(p, null, 1) + pageHtml.slice(pb);
}
// dist/ 与 work/ 在 root 下一层：相对资源引用加 ../（dev 资源；缺失时优雅降级）
const upDist = (h) =>
  h
    .replace(/['"]work\//g, (m) => m[0] + '../' + m.slice(1))
    .replace(/['"]private\//g, (m) => m[0] + '../' + m.slice(1));

// --- 公开入口 dist/app.html：generic，隐私硬断言（§1.4）---
// 只查「真正的资源引用」（引号后紧跟 private/ 或 ../private/）；HTML 注释里提到
// private/plans/mine.json 是说明文字，不是引用。
const outApp = out.replace(/['"]work\//g, (m) => m[0] + '../' + m.slice(1));
if (/['"](\.\.\/)?private\//.test(outApp))
  throw new Error('✗ dist/app.html 含 private/ 资源引用 —— 公开入口不得带个人数据（§1.4）');
if (planName(outApp) !== 'generic-2br')
  throw new Error('✗ dist/app.html 的户型不是 generic-2br —— 公开入口必须用通用户型');
// S13 隐私硬断言：公开入口不得带内置布局（那是个人数据，只属于个人入口）
{
  const n = ((planOfPage(outApp).layout || {}).items || []).length;
  if (n) throw new Error(`✗ dist/app.html 的内置布局有 ${n} 件 —— 公开入口必须 layout:null`);
}
writeFileSync(join(DIST, 'app.html'), outApp);
console.log('  入口: dist/app.html（公开/用户入口 · generic · 无 private/ 引用）');

// --- 个人入口：dist/planner.html（单文件，黄金基线用）+ 根目录 planner.html（源形式，改动即时可见）---
// 本地开发机有 private/plans/mine.json → 注入真实户型；CI/公开环境没有 → 退回 generic。
const minePath = join(root, 'private/plans/mine.json');
const hasMine = existsSync(minePath);
// out = dist 个人入口内容（下面按 hasMine 决定注入 mine 还是保持 generic）
if (hasMine) {
  const mine = JSON.parse(readFileSync(minePath, 'utf8'));
  out = upDist(withPlan(out, mine, 'dist'));
  writeFileSync(join(DIST, 'planner.html'), out);
  writeFileSync(join(root, 'planner.html'), withPlan(html, mine, 'app.html')); // 源形式：lib/ 外链不动
  const ln = ((mine.layout || {}).items || []).length;
  console.log(
    '  入口: dist/planner.html + planner.html（个人入口 · mine 西雅图公寓 · planner.html 入库）' +
      (ln ? ` · 内置布局 ${ln} 件（S13：localStorage 没存档时用它播种）` : '')
  );
} else {
  writeFileSync(join(DIST, 'planner.html'), out); // CI：与 dist/app.html 同内容，保持既有路径
  console.log(
    '  入口: dist/planner.html（无 private/plans/mine.json → generic；根 planner.html 保持已入库的那份不动）'
  );
}

// --- 测试台（S10：脚本与 plan 解耦，全部构建生成、不入库）---
// bench/t_3d.js、bench/t_pt.js = plan-independent（随库提交；坐标运行时从
//   floorPts() 派生 → generic/mine 两个户型同一套脚本）
// private/bench/t_walledit.js = plan 特定（含真实户型几何断言；仅本地）
// 生成矩阵：
//   work/t_3d.html / t_pt.html      ← source 页（本地 = mine plan 注入；CI = generic）
//   work/t_3d_dist.html / t_pt_dist.html ← dist 页
//   work/t_walledit.html / t_walledit_dist.html ← 仅本地（mine plan）
function makeBench(pageHtml, scriptPath, outPath) {
  pageHtml = stripPlanLayout(pageHtml); // S13：测试台不带个人布局
  const script = readFileSync(join(root, scriptPath), 'utf8');
  // $ 转义（AGENTS §5.1）：String.replace 替换串会解释 $'/$`/$$/$n。
  // 转义只有一层：$ → $$（'$$$$' 被替换引擎解释为字面 $$），外层 replace 再把 $$ 解回 $。
  // 写 6 个 $ 会把 $ 变成 $$$，外层解出 $ 后原字符重新暴露（$' 再展开）——真踩过。
  writeFileSync(
    join(root, outPath),
    pageHtml.replace('</body>', '\n<script>\n' + script.replace(/\$/g, '$$$$') + '\n</script>\n</body>', 1)
  );
  console.log(`  testbed: ${outPath} ← ${scriptPath}`);
}
// source 页（本地把 mine plan 注入进 #miniden-plan 块）
let srcForBench = html;
if (hasMine) srcForBench = withPlan(srcForBench, JSON.parse(readFileSync(minePath, 'utf8')), 'app.html');
// bench 在 work/ 下：lib/ 与 private/ 相对路径加 ../
srcForBench = srcForBench
  .replace(/['"]lib\//g, (m) => m[0] + '../' + m.slice(1))
  .replace(/['"]private\//g, (m) => m[0] + '../' + m.slice(1));
for (const [script, outp] of [
  ['bench/t_3d.js', 'work/t_3d.html'],
  ['bench/t_pt.js', 'work/t_pt.html'],
])
  makeBench(srcForBench, script, outp);
makeBench(out, 'bench/t_3d.js', 'work/t_3d_dist.html');
makeBench(out, 'bench/t_pt.js', 'work/t_pt_dist.html');
// E17 同步门禁：同一套 plan-independent bench 也跑公开入口 dist/app.html（generic 户型）。
// 新工具/新家具若在 generic 上炸，这里就红 —— 「两边同步」由构建保证，不靠人记。
makeBench(outApp, 'bench/t_3d.js', 'work/t_3d_app.html');
makeBench(outApp, 'bench/t_pt.js', 'work/t_pt_app.html');
if (existsSync(join(root, 'private/bench/t_walledit.js'))) {
  makeBench(srcForBench, 'private/bench/t_walledit.js', 'work/t_walledit.html');
  makeBench(out, 'private/bench/t_walledit.js', 'work/t_walledit_dist.html');
} else {
  console.log('  testbed: t_walledit 跳过（private/bench/t_walledit.js 不存在 = CI/公开环境）');
}

const kb = (n) => (n / 1024).toFixed(0);
console.log(
  `build OK: dist/app.html ${kb(Buffer.byteLength(outApp))}KB（公开） · ` +
    `dist/planner.html ${kb(Buffer.byteLength(out))}KB（个人${hasMine ? ' · mine' : ''}）` +
    ` (src app.html ${kb(Buffer.byteLength(html))}KB + three ${kb(readFileSync(join(root, 'lib', 'three.min.js')).length)}KB 内联)`
);
