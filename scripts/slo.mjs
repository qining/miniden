#!/usr/bin/env node
/* E14：快捷 SLO 套件（ADR-0006 —— 顶层指标 = 用户时间，不是原始性能）
 *
 * 计时方法（AGENTS §11）：`--virtual-time-budget` 会虚拟化 performance.now()/Date.now()，
 * 页面内计时不可信。本套件不用 virtual time：起一个本地 HTTP 服务，页面每完成一个阶段就
 * POST 回来，**权威计时 = 服务端收到 POST 的墙钟 − Chrome 启动墙钟**；
 * 页面内的 performance.now() 只作为 CPU-bound 阶段的细粒度对照（没有 virtual time 时它是真的）。
 *
 * 用法：
 *   node scripts/slo.mjs              # 本地：个人入口 dist/planner.html（真实户型 + 内置布局）
 *   node scripts/slo.mjs --public     # 公开入口 dist/app.html（generic 户型；CI 用这个）
 *   node scripts/slo.mjs --ci         # CI 口径：软件 GL 的帧率/内存只作参考，不做门禁
 *   node scripts/slo.mjs --headful    # 真显卡（本地，会弹 Chrome 窗口）—— 用户侧真实数字
 *
 * 退出码：任一门禁项超阈值 → 1。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const CI = flag('--ci') || process.env.CI === 'true';
const HEADFUL = flag('--headful');
const usePublic = flag('--public');
const CHROME =
  process.env.CHROME ||
  (process.env.CI === 'true' ? 'google-chrome' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const CI_FLAGS = process.env.CI === 'true' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
const SWIFTSHADER_FLAG = '--enable-unsafe-swiftshader';

const SRC = join(root, usePublic ? 'dist' : 'dist', usePublic ? 'app.html' : 'planner.html');
if (!existsSync(SRC)) {
  console.error('dist/ 里没有入口页（先 npm run build）');
  process.exit(2);
}

/* ---------- SLO fixture：~10MB DXF（不入库，现生成） ---------- */
const BIG = join(root, 'work', 'big10mb.dxf');
if (!existsSync(BIG)) {
  const r = spawnSync('node', [join(root, 'scripts', 'make-big-dxf.mjs'), '--out', BIG], { encoding: 'utf8' });
  console.log((r.stdout || r.stderr || '').trim());
}

/* ---------- 阈值（ADR-0006 / roadmap E14） ---------- */
const LIMIT = {
  startup: 1500, // ms：进程启动 → 界面可交互
  firstTask: 180000, // ms：打开 → 放 3 件家具 → 看到 3D
  importTask: 180000, // ms：导入 → 可用初稿
  viewSwitch: 300, // ms：2D → 3D 首帧
  dragFps: 55, // 帧/秒（≈18ms/帧；60 是理想值，留一点余量）
  heap50: 1.5 * 1024 * 1024 * 1024, // 50 件场景 JS 堆
  bigDxf: 3000, // ms：10MB DXF 解析 + 映射
  catalog1000: 1000, // ms：1000 条目目录列表重建
};
/* CI 跑的是软件 GL（swiftshader）：启动/3D 构建/帧率都被软件光栅化放大 5~8 倍，
   用它卡「用户侧绝对值」会永远红。所以 CI 口径 = **回归门禁**（抓 5× 级别的劣化），
   用户侧绝对值（ADR-0006 的 1.5s / 16ms）由本地 `node scripts/slo.mjs --headful` 验。 */
if (CI && !HEADFUL) {
  LIMIT.startup = 25000;
  LIMIT.firstTask = 150000;
  LIMIT.viewSwitch = 3000;
  LIMIT.bigDxf = 8000;
  LIMIT.catalog1000 = 4000;
}
// 软件 GL 的帧率与堆不代表用户显卡：只报告、不门禁
const informational = CI && !HEADFUL ? new Set(['dragFps', 'heap50']) : new Set();

/* ---------- HTTP 服务（同源，页面才能 fetch 回传） ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.dxf': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
};
const stages = [];
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/slo') {
    stages.push({
      name: u.searchParams.get('name') || '?',
      wall: Date.now() - t0,
      page: +u.searchParams.get('ms') || 0,
      info: u.searchParams.get('info') || '',
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }
  const p = normalize(join(root, u.pathname));
  if (!p.startsWith(root) || !existsSync(p) || !req.url) {
    res.writeHead(404);
    res.end('nope');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
  res.end(readFileSync(p));
});
let t0 = Date.now();
let port = 0;
function listen() {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
}

/* ---------- SLO 驱动脚本（注入到入口页；classic script，靠 build.mjs 的 globalThis 镜像取应用符号） ---------- */
const DRIVER = `
<script>
/* E14 SLO 驱动 */
(function(){
  const T0 = performance.now();
  const sleep = ms => new Promise(r=>setTimeout(r, ms));
  const post = (name, info) => fetch('/slo?name='+encodeURIComponent(name)+
      '&ms='+Math.round(performance.now()-T0)+'&info='+encodeURIComponent(info||'')).catch(()=>{});
  const ms = () => performance.now();
  const svgEl = () => document.querySelector('#svg2d');
  const SPT = (fx,fy) => { const ctm = svgEl().getScreenCTM(); if(!ctm) return [10,10];
    const p = new DOMPoint(fx*S, fy*S).matrixTransform(ctm); return [p.x, p.y]; };
  const fire = (type, cx, cy, extra) => { const tgt = document.elementFromPoint(cx,cy) || svgEl();
    tgt.dispatchEvent(new PointerEvent(type, Object.assign({clientX:cx, clientY:cy, bubbles:true,
      cancelable:true, pointerId:1, isPrimary:true, button:0, buttons:1}, extra||{}))); };
  const origCap = Element.prototype.setPointerCapture;
  Element.prototype.setPointerCapture = function(id){ try{ origCap.call(this,id); }catch(e){} };
  const rendered = () => !!(window.three && three.renderer && three.renderer.info.render.calls > 0);
  async function waitRender(limit){ for(let i=0;i<limit;i++){ if(rendered()) return true; await sleep(16); } return false; }
  async function waitReady(limit){ for(let i=0;i<limit;i++){
      if(document.querySelectorAll('.catGrid .catCard').length > 20 && svgEl().querySelector('path')) return true;
      await sleep(25); } return false; }

  window.addEventListener('load', async () => {
    try {
      const origCap2 = null; void origCap2;
      /* 1) 启动：界面可交互（目录卡片已建、2D 已画） */
      const ok = await waitReady(400);
      await post('ready', ok ? 'cards='+document.querySelectorAll('.catGrid .catCard').length : 'NOT READY');

      /* 2) 首次任务：搜目录 → 点卡片放 3 件 → 进 3D 看到首帧 */
      const tTask = ms();
      let tAdd = 0, t3d = 0;
      const search = document.querySelector('#catSearch');
      const picks = ['沙发','地毯','落地灯'];
      let placed = 0;
      for (const q of picks) {
        search.value = q; search.dispatchEvent(new Event('input', {bubbles:true}));
        const card = document.querySelector('.catGrid .catCard');
        if (card) { card.click(); placed++; }
      }
      search.value=''; search.dispatchEvent(new Event('input', {bubbles:true}));
      tAdd = ms() - tTask;
      const tV = ms();
      setView('doll');
      const got3d = await waitRender(900);
      t3d = ms() - tV;
      await post('first-task', 'placed='+placed+' 3D首帧='+got3d+' 放件='+Math.round(tAdd)+'ms'+
        ' 进3D='+Math.round(t3d)+'ms 合计='+Math.round(ms()-tTask)+'ms');

      /* 3) 切视图：2D → 3D 首帧 */
      setView('2d'); await sleep(120);
      if (window.three) { three.renderer.info.render.calls = 0; }
      const tSw = ms();
      setView('doll');
      const swOk = await waitRender(400);
      await post('view-switch', (swOk?'':'超时 ')+'用时='+Math.round(ms()-tSw)+'ms');

      /* 4) 拖拽帧率：2D 拖动一件家具，逐 rAF 派发 move，数动画帧 */
      const it = state.items[state.items.length-1];
      let fps = 0, frames = 0;
      if (it) {
        const [cx, cy] = SPT(it.x, it.y);
        fire('pointerdown', cx, cy);
        const tDrag = ms();
        await new Promise((res) => {
          let i = 0;
          const step = () => {
            frames++;
            if (i++ >= 90) { fire('pointerup', cx + i*2, cy + i); return res(); }
            fire('pointermove', cx + i*2, cy + i*1.2);
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
        const dt = ms() - tDrag;
        fps = frames / (dt / 1000);
        await post('drag', frames+' 帧 / '+Math.round(dt)+'ms = '+fps.toFixed(1)+' fps');
      } else await post('drag', '没有可拖的家具');

      /* 5) 50 件场景：JS 堆 + 三角形 */
      const tFifty = ms();
      const base = CATALOG.filter(s => !isBuiltIn(s)).slice(0, 12);
      for (let i = 0; i < 50; i++) addItem(base[i % base.length].id);
      setView('doll'); await waitRender(600); await sleep(400);
      const mem = performance.memory ? performance.memory.usedJSHeapSize : 0;
      let tri = 0; if (window.three) three.scene.traverse(o => { if (o.isMesh && o.geometry && o.geometry.index) tri += o.geometry.index.count/3; });
      await post('fifty', '50 件 · jsHeap='+(mem/1048576).toFixed(0)+'MB · 三角≈'+Math.round(tri)+
        ' · 建+渲用时='+Math.round(ms()-tFifty)+'ms');

      /* 6) 10MB DXF 导入（解析 + 映射 + 落地 2D） */
      const tImp = ms();
      let impInfo = '失败';
      try {
        const txt = await fetch('/work/big10mb.dxf').then(r=>r.text());
        const d = new window.DxfParser().parse(txt);
        const res = window.MINIDEN_GEO.importDxf(d, {name:'big10mb'});
        const tMap = ms();
        applyImportedDoc(res.doc, res.info);
        build2D();
        const c = res.info.counts;
        impInfo = txt.length+'B · 解析+映射 '+(tMap-tImp).toFixed(0)+'ms · 落地 '+Math.round(ms()-tMap)+'ms'+
          ' · 墙'+c.walls+' 窗'+c.windows+' 门'+c.doors+' 柱'+c.solids;
      } catch (e) { impInfo = 'EXC ' + e.message; }
      await post('import', impInfo+' · 合计 '+Math.round(ms()-tImp)+'ms');

      /* 7) 目录 1000 条：列表重建耗时 */
      const tCat = ms();
      const keep = CATALOG.slice(0);
      while (CATALOG.length < 1000) {
        const s = keep[CATALOG.length % keep.length];
        CATALOG.push(Object.assign({}, s, { id:'slo-'+CATALOG.length, name:s.name+' · SLO'+CATALOG.length }));
      }
      buildCatalog('');
      const cards = document.querySelectorAll('.catGrid .catCard').length;
      const dtCat = ms() - tCat;
      CATALOG.length = keep.length; buildCatalog('');
      await post('catalog1000', cards+' 卡片 · '+Math.round(dtCat)+'ms');

      await post('done', '');
    } catch (e) { await post('fatal', e.message); }
  });
})();
</script>
`;

/* ---------- 生成页面 → 跑 Chrome → 收阶段 ---------- */
const html = readFileSync(SRC, 'utf8');
const at = html.lastIndexOf('</body>');
if (at < 0) {
  console.error('入口页没有 </body>');
  process.exit(2);
}
mkdirSync(join(root, 'work'), { recursive: true });
const page = join(root, 'work', 't_slo.html');
writeFileSync(page, html.slice(0, at) + DRIVER + html.slice(at));

await listen();
const url = `http://127.0.0.1:${port}/work/t_slo.html`;
const chromeArgs = [
  HEADFUL ? '' : '--headless',
  // 独立 profile：否则 headful 会把 URL 交给已在运行的 Chrome 实例、自己立刻退出（收不到任何 POST）。
  // 新 profile 必须压掉首启流程，否则 Chrome 弹「登录 Chrome」对话框卡住、页面根本不加载（实测踩过）。
  ...(HEADFUL
    ? [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--disable-features=SigninPromo,DesktopFirstRun',
        '--user-data-dir=' + join(root, 'work', 'slo-profile'),
      ]
    : []),
  // headless 用软件 GL（CI 可跑、可复现）；headful 用真显卡 —— 那才是用户侧的帧率/启动数字
  ...(HEADFUL ? [] : ['--use-angle=swiftshader', SWIFTSHADER_FLAG]),
  ...CI_FLAGS,
  '--window-size=1700,1100',
  '--remote-allow-origins=*',
  url,
].filter(Boolean);

t0 = Date.now();
const child = spawn(CHROME, chromeArgs, { stdio: ['ignore', 'ignore', 'ignore'] });
let finished = false;
const deadline = Date.now() + 420000;

await new Promise((resolve) => {
  const iv = setInterval(() => {
    if (stages.some((s) => s.name === 'done' || s.name === 'fatal') || Date.now() > deadline) {
      clearInterval(iv);
      finished = !stages.some((s) => s.name === 'fatal');
      resolve();
    }
  }, 100);
  child.on('exit', () => {
    clearInterval(iv);
    resolve();
  });
});
try {
  child.kill('SIGKILL');
} catch (_) {
  /* 已退出 */
}
server.close();

/* ---------- 报告 ---------- */
const get = (n) => stages.find((s) => s.name === n);
const rows = [
  ['启动（进程→界面可交互）', get('ready'), LIMIT.startup, 'wall', 'startup'],
  ['首次任务（放 3 件 → 3D 首帧）', get('first-task'), LIMIT.firstTask, 'wall', 'firstTask'],
  ['切视图 2D→3D 首帧', get('view-switch'), LIMIT.viewSwitch, 'page', 'viewSwitch'],
  ['拖拽帧率', get('drag'), LIMIT.dragFps, 'fps', 'dragFps'],
  ['50 件场景 JS 堆', get('fifty'), LIMIT.heap50, 'heap', 'heap50'],
  ['10MB DXF 导入', get('import'), LIMIT.bigDxf, 'page', 'bigDxf'],
  ['目录 1000 条重建', get('catalog1000'), LIMIT.catalog1000, 'page', 'catalog1000'],
];
console.log('');
console.log(
  'E14 快捷 SLO · ' +
    (usePublic ? 'dist/app.html（generic）' : 'dist/planner.html（mine）') +
    (HEADFUL ? ' · headful 真显卡' : ' · headless swiftshader')
);
console.log('入口: ' + SRC.replace(root + '/', ''));
console.log('');
let fail = 0;
for (const [label, st, lim, kind, key] of rows) {
  if (!st) {
    console.log(`  ✗ ${label.padEnd(34)} 没有测到（页面没跑到这一阶段）`);
    if (!informational.has(key)) fail++;
    continue;
  }
  let value, ok, shown;
  if (kind === 'wall') {
    value = st.wall;
    ok = value <= lim;
    shown = `${(value / 1000).toFixed(2)}s / ${(lim / 1000).toFixed(0)}s`;
  } else if (kind === 'page') {
    const m = /(\d+)\s*ms\s*$/.exec(st.info.trim());
    value = m ? +m[1] : st.page;
    ok = value <= lim;
    shown = `${value}ms / ${lim}ms`;
  } else if (kind === 'fps') {
    const m = /([\d.]+)\s*fps/.exec(st.info);
    value = m ? +m[1] : 0;
    ok = value >= lim;
    shown = `${value.toFixed(1)} fps / ≥${lim}`;
  } else {
    const m = /jsHeap=(\d+)MB/.exec(st.info);
    value = m ? +m[1] * 1048576 : 0;
    ok = value <= lim;
    shown = `${(value / 1048576).toFixed(0)}MB / ${(lim / 1048576).toFixed(0)}MB`;
  }
  const soft = informational.has(key);
  if (!ok && !soft) fail++;
  console.log(
    `  ${ok ? '✓' : soft ? '·' : '✗'} ${label.padEnd(34)} ${shown.padEnd(22)} ${st.info.slice(0, 96)}${soft ? '  [软件 GL 参考值]' : ''}`
  );
}
console.log('');
console.log('阶段墙钟（服务端收到 POST 的时刻 − Chrome 启动时刻）：');
for (const s of stages) console.log(`  ${String(s.wall).padStart(7)}ms  ${s.name.padEnd(12)} ${s.info.slice(0, 90)}`);
console.log('');
if (!finished) console.log('页面没跑完（超时或异常）');
process.exit(fail || !finished ? 1 : 0);
