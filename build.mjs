// E1-1: 构建管线（源 = planner.html 内联脚本；产物 = dist/planner.html 单文件）
//
// 原则：「move, not rewrite」——不改变任何逻辑，只做：
//   1. 从 planner.html 抽出内联 <script>（唯一事实来源）
//   2. 加两行 ESM 前言（import 本地 lib/ 的 three + OrbitControls，接上裸 THREE 引用）
//   3. esbuild bundle 成 IIFE（three/OrbitControls 内联 → 真正单文件）
//   4. 拼回 HTML（去掉两个 lib <script src> 标签，内联 bundle）
//
// 等价性验收（每次构建后跑）：
//   - #calib 截图 md5 == 1ac26921871db50ef1c055674c10e6e7
//   - work/t_3d.html / t_walledit.html（从 dist 生成变体）全绿
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const TMP = join(root, 'build', 'tmp');
const DIST = join(root, 'dist');

const html = readFileSync(join(root, 'planner.html'), 'utf8');

// --- 抽取内联脚本（唯一的裸 <script> 标签）---
const START = '<script>\n';
const i = html.indexOf(START);
const j = html.lastIndexOf('</script>');
if (i < 0 || j < 0 || j < i) throw new Error('找不到内联脚本边界');
const body = html.slice(i + START.length, j);
const tail = html.slice(j + '</script>'.length);

// --- head：去掉两个 lib 外链标签 ---
const head = html.slice(0, i)
  .replace('<script src="lib/three.min.js"></script>\n', '')
  .replace('<script src="lib/OrbitControls.js"></script>\n', '');
if (head.includes('lib/three.min.js') || head.includes('lib/OrbitControls.js'))
  throw new Error('lib 标签去除失败（head 里还有残留）');

// --- 生成 ESM 入口（临时文件，不入库）---
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

// OrbitControls（examples/js 风格：裸 THREE 引用）→ 用模块作用域 const 接上
// three.min.js 是 UMD：esbuild 按 CJS 解析（package.json 无 "type"）→
// import 的 default = module.exports = 完整 THREE 对象（可变，可挂 OrbitControls）
// 注意：脚本体自己有一个顶层 `let three`（3D 状态）→ 导入名必须避开
writeFileSync(join(TMP, 'oc.mjs'),
  `import threeLib from '../../lib/three.min.js';\nconst THREE = threeLib;\n` +
  readFileSync(join(root, 'lib', 'OrbitControls.js'), 'utf8'));

// classic script → ESM：顶层函数重复声明在 classic 里合法（后声明者胜出、
// 前者是死代码），在 ESM 里是 SyntaxError → 忠实复刻语义：只保留最后一个。
// 结束行判定用代码风格规则（已验证：全部 207 个顶层函数都以 col-0 的 `}` 行
// 结束）——不用花括号扫描器（正则字面量/字符串会让它失同步）。
function dedupeToplevelFunctions(src) {
  const lines = src.split('\n');
  const decls = new Map();
  lines.forEach((l, idx) => {
    const m = l.match(/^function\s+([A-Za-z_$][\w$]*)/);
    if (m) { const a = decls.get(m[1]) || []; a.push(idx); decls.set(m[1], a); }
  });
  const firsts = [];
  for (const [name, idxs] of decls)
    if (idxs.length > 1) idxs.slice(0, -1).forEach(x => firsts.push([name, x]));
  if (!firsts.length) return src;
  const endOf = (start) => {
    for (let m = start + 1; m < lines.length; m++)
      if (lines[m] === '}') return m;
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
const noComments = bodyEsm.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
const names = [];
const kind = {};
for (const l of noComments.split('\n')) {
  let m = l.match(/^function\s+([A-Za-z_$][\w$]*)/);
  if (m) { names.push(m[1]); kind[m[1]] = 'fn'; continue; }
  m = l.match(/^(var|let|const)\s+([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)/);
  if (m) m[2].split(',').forEach(s => { const n = s.trim(); names.push(n); kind[n] = m[1]; });
}
const uniq = [...new Set(names)].filter(n => /^[A-Za-z_$][\w$]*$/.test(n));
// 可重绑定名（var/let/function）必须带 setter：外部脚本（测试台）会写它们
//（典型：`uidSeq++`——sloppy classic script 对 getter-only 属性赋值会静默失败 →
// 两个家具拿到同一个 uid → furnMap 互相覆盖 → 拾取/拖动全挂）。
// const 保持 getter-only（原 classic 里给 const 赋值本来就会 TypeError）。
const mirror = uniq.map(n => {
  const def = kind[n] === 'const'
    ? `{ get: () => ${n}, configurable: true }`
    : `{ get: () => ${n}, set: v => { ${n} = v }, configurable: true }`;
  return `if (typeof ${n} !== "undefined") Object.defineProperty(globalThis, ${JSON.stringify(n)}, ${def});`;
}).join('\n');

writeFileSync(join(TMP, 'entry.mjs'),
  `import threeLib from '../../lib/three.min.js';\nimport './oc.mjs';\nconst THREE = threeLib;\n` +
  `globalThis.THREE = threeLib;  // 原页面 window.THREE 由 three.min.js UMD 建立；注入脚本（测试台）裸用\n` +
  bodyEsm +
  `\n// 全局契约镜像（构建生成）：原 classic script 顶层 var/function → window\n` + mirror + '\n');
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
if (errors.length) { console.error(outputFiles?.[0]?.text || errors); process.exit(1); }
const bundle = outputFiles[0].text;

// --- 组装单文件 HTML ---
// dist/ 在 root 下一层：把相对资源引用 'work/...' 改为 '../work/...'（dev 资源：
// 底图/参考图；产品功能不依赖它们，缺失时优雅降级）
mkdirSync(DIST, { recursive: true });
let out = head + '<script>\n' + bundle + '\n</script>' + tail;
out = out.replace(/['"]work\//g, m => m[0] + '../' + m.slice(1));
writeFileSync(join(DIST, 'planner.html'), out);

// --- 生成 dist 变体的测试台（从 dist 生成，保证测试代码与产物同源、永不过期）---
for (const [src, dst, mark] of [['work/t_walledit.html', 'work/t_walledit_dist.html', 'window\\.__ERRS'],
                                ['work/t_3d.html', 'work/t_3d_dist.html', 'window\\.__E3'],
                                ['work/t_pt.html', 'work/t_pt_dist.html', 'window\\.__EPT']]) {
  const tf = readFileSync(join(root, src), 'utf8');
  const m = tf.match(new RegExp("(\\n<script>\\n" + mark + ".*?</script>\\n</body>)", 's'));
  if (!m) throw new Error(`测试台 ${src} 里找不到 ${mark} 标记`);
  writeFileSync(join(root, dst), out.replace('</body>', m[1], 1));
  console.log(`  testbed: ${dst}`);
}

const kb = (n) => (n / 1024).toFixed(0);
console.log(`build OK: dist/planner.html ${kb(Buffer.byteLength(out))}KB` +
  ` (src ${kb(Buffer.byteLength(html))}KB + three ${kb(readFileSync(join(root,'lib','three.min.js')).length)}KB 内联)`);
