#!/usr/bin/env node
/* E21 可见 E2E：headful Chrome + CDP 真实输入（trusted pointer / 真实键盘 / 真实刷新）
 *
 * 与 bench 的分工（AGENTS §3）：
 *   bench  = 断言密度（headless、合成 PointerEvent、虚拟时间、可 CI 跑 700+ 条）
 *   e2e    = 真实用户路径（headful、真实鼠标键盘、真实时间、真实刷新、人可看着）
 * 为什么需要它：bench 的 dispatchEvent 是 untrusted 事件、不经过浏览器输入管线，
 * 也不会触发 pointer capture / hover / focus / 真实 dblclick / 真实文件选择 / 页面刷新。
 *
 * 用法：
 *   node scripts/e2e.mjs                    headful（人可看着），默认两个入口：dist/planner + dist/app
 *   node scripts/e2e.mjs --flow=units       只跑一条
 *   node scripts/e2e.mjs --fast             不减速（CI / 快速回归）
 *   node scripts/e2e.mjs --public           只跑公开入口 dist/app.html（generic 户型）
 *   node scripts/e2e.mjs --entry=all        四个入口全跑：dist/planner · dist/app · planner.html · app.html
 *   node scripts/e2e.mjs --entry=src-app    只跑入库的源文件 app.html（外链 lib/，generic 户型）
 *   node scripts/e2e.mjs --ci               headless=new + swiftshader + fast + 入口 dist/app.html + app.html
 * 产物（全部 gitignore）：work/e2e/report.html（逐步截图 + 断言，人可审）、log.json、shots/
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '../..');
const argv = process.argv.slice(2);
const has = (k) => argv.some((a) => a === k || a.startsWith(k + '='));
const val = (k, d) => {
  const a = argv.find((x) => x.startsWith(k + '='));
  return a ? a.slice(k.length + 1) : d;
};
const CI = has('--ci');
const FAST = CI || has('--fast');
const PUBLIC = CI || has('--public');
const KEEP_STATE = has('--keep-state'); // 调试用：保留上一个 flow 的状态
const ONLY = val('--flow', null);
const SPEED = Number(val('--speed', FAST ? 0 : 620)); // 每步之间给人眼留出时间
const PORT = Number(val('--port', 9411));
const PROFILE = join(root, 'work', 'e2e-profile');
const OUT = join(root, 'work', 'e2e');
const SHOTS = join(OUT, 'shots');
const CHROME_MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_CI = process.env.CHROME || process.env.CHROME_BIN || '/usr/bin/chromium-browser';

/* 入口口径（E18：一个事实来源 app.html → 两个入口）。
   默认跑「两个入口都跑」——同一套流程在个人入口与公开入口上各跑一遍，
   换户型就坏的断言当场暴露（bench 的 source/dist/dist-generic 三份同理）。
   --entry= 可指定：planner | app | src-planner | src-app | both | all（逗号可组合） */
const ENTRY_ALIAS = {
  planner: ['dist/planner.html'],
  app: ['dist/app.html'],
  'src-planner': ['planner.html'],
  'src-app': ['app.html'],
  both: ['dist/planner.html', 'dist/app.html'],
  all: ['dist/planner.html', 'dist/app.html', 'planner.html', 'app.html'],
};
function resolveEntries() {
  const raw = val('--entry', null) || (CI ? 'app,src-app' : PUBLIC ? 'app' : 'both');
  const out = [];
  for (const part of String(raw).split(',')) {
    const k = part.trim();
    if (!k) continue;
    const list = ENTRY_ALIAS[k];
    if (!list) {
      console.error('--entry 不认识：' + k + '（可选 ' + Object.keys(ENTRY_ALIAS).join(' | ') + '）');
      process.exit(2);
    }
    for (const e of list) if (!out.includes(e)) out.push(e);
  }
  return out;
}
const ENTRIES = resolveEntries();

function chromeArgs(entryPath) {
  const a = [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-features=SigninPromo,DesktopFirstRun',
    '--allow-file-access-from-files',
    '--window-size=1500,1000',
    '--window-position=60,60',
  ];
  if (CI) a.push('--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu');
  a.push('file://' + entryPath);
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runEntry(entry) {
  const entryPath = join(root, entry);
  const slug = entry.replace(/[^A-Za-z0-9._-]/g, '_');
  rmSync(PROFILE, { recursive: true, force: true }); // 每个入口一个干净 profile
  mkdirSync(SHOTS, { recursive: true });

  const bin = process.env.CHROME_BIN || (CI ? CHROME_CI : CHROME_MAC);
  const proc = spawn(bin, chromeArgs(entryPath), { stdio: ['ignore', 'pipe', 'pipe'] });
  const chromeLog = [];
  proc.stdout.on('data', (d) => chromeLog.push(String(d)));
  proc.stderr.on('data', (d) => chromeLog.push(String(d)));
  let exited = null;
  proc.on('exit', (code, sig) => {
    exited = { code, sig };
  });

  // 等 DevTools 端点（并确认它就是我们刚启动的那个页面）
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(250);
    if (exited) break;
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const j = await r.json();
      const p = j.find((t) => t.type === 'page' && t.url.includes('/work/e2e') === false && t.url.endsWith(entry));
      if (p) target = p;
    } catch {
      /* 还没起来 */
    }
  }
  if (!target) {
    console.error('无法连上 DevTools（Chrome 没起来或端口被占）');
    console.error(chromeLog.join('').slice(-1200));
    proc.kill('SIGKILL');
    process.exit(2);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'));
  });
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(m.method + ': ' + m.error.message));
      else res(m.result);
    } else if (m.method) {
      events.push(m);
      if (m.method === 'Page.javascriptDialogOpening') handleDialog(m.params);
    }
  };

  /* 真实 confirm()/alert()：headless bench 里这类弹窗会把页面永久卡死（AGENTS §5.1），
     真实浏览器里它是一次**用户确认**。E2E 记录它出现过（这是 UX 断言），再代为应答。 */
  let dialogMode = 'accept';
  const dialogLog = [];
  const handleDialog = (p) => {
    dialogLog.push({ type: p.type, message: p.message });
    console.log(`  DIALOG ${p.type}: ${String(p.message).slice(0, 90)}`);
    const accept = dialogMode === 'accept';
    dialogMode = 'accept';
    cdp('Page.handleJavaScriptDialog', { accept, promptText: accept ? p.defaultPrompt || '' : undefined }).catch(
      () => {}
    );
  };
  const cdp = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('DOM.enable');
  const DL = join(OUT, 'downloads');
  mkdirSync(DL, { recursive: true });
  await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });

  /* ---------- 测试 API ---------- */
  const results = [];
  let shotNo = 0;
  let currentFlow = null;
  let currentStep; // 每个 flow 开头重置；catch 里读它定位「停在哪一步」
  let failures = 0;

  const ev = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception
        ? r.exceptionDetails.exception.description || r.exceptionDetails.exception.value
        : r.exceptionDetails.text;
      throw new Error('页面内表达式异常: ' + String(d).slice(0, 300));
    }
    return r.result ? r.result.value : undefined;
  };

  const banner = async (text) => {
    await ev(
      `(()=>{let d=document.getElementById('__e2e');
        if(!d){d=document.createElement('div');d.id='__e2e';
          d.style.cssText='position:fixed;left:50%;top:6px;transform:translateX(-50%);z-index:2147483647;\\
            pointer-events:none;background:#ffd45e;color:#111;font:600 15px/1.35 system-ui;padding:7px 14px;\\
            border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,.5);max-width:70vw';
          document.body.appendChild(d);}
        d.textContent=${JSON.stringify(text)};return true})()`
    );
  };

  const shot = async (label) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    const name = String(++shotNo).padStart(3, '0') + '-' + slug + '-' + label.replace(/[^A-Za-z0-9._-]/g, '_') + '.png';
    writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'));
    return name;
  };

  const t = {
    get flow() {
      return currentFlow;
    },
    async step(label, note) {
      currentStep = label;
      await banner(`${currentFlow} · ${label}${note ? ' — ' + note : ''}`);
      if (SPEED) await sleep(SPEED);
      return label;
    },
    async done(label, note) {
      currentStep = label;
      await banner(`${currentFlow} · ${label}${note ? ' — ' + note : ''}`);
      if (SPEED) await sleep(SPEED);
    },
    assert(name, cond, detail) {
      const ok = !!cond;
      if (!ok) failures++;
      results.push({ flow: currentFlow, kind: 'assert', name, ok, detail: detail == null ? '' : String(detail) });
      console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail != null ? ' | ' + detail : ''}`);
      return ok;
    },
    info(name, detail) {
      results.push({ flow: currentFlow, kind: 'info', name, ok: true, detail: String(detail) });
      console.log(`  INFO ${name} | ${detail}`);
    },
    eval: ev,
    /** 3D 场景会异步重建（three 会短暂为 null）：读它要带重试 */
    async evalRetry(expr, ms = 15000, why = 'evalRetry') {
      const t0 = Date.now();
      for (;;) {
        try {
          const v = await ev(expr);
          if (v !== undefined && v !== null) return v;
        } catch {
          /* 场景正在重建 */
        }
        if (Date.now() - t0 > ms) throw new Error(why + '：读取失败（' + ms + 'ms）');
        await sleep(300);
      }
    },
    async waitFor(expr, ms = 8000, why = expr) {
      const t0 = Date.now();
      for (;;) {
        let v;
        try {
          // Boolean() 包一层：表达式返回对象（如 THREE.Scene）时 returnByValue 序列化不了，
          // 直接取会拿到 undefined → 明明成立却永远等不到
          v = await ev(`(()=>{try{return Boolean(${expr})}catch(e){return false}})()`);
        } catch {
          v = false;
        }
        if (v) return true;
        if (Date.now() - t0 > ms) throw new Error('等待超时（' + ms + 'ms）：' + why);
        await sleep(120);
      }
    },
    async reload() {
      await cdp('Page.reload', { ignoreCache: true });
      await t.waitForReady();
    },
    /** 干净存档起步：清 localStorage + IndexedDB 再重载（流程之间 / 运行之间都确定） */
    async freshState() {
      await cdp('Runtime.evaluate', {
        expression: `(()=>{try{localStorage.clear()}catch(e){}try{indexedDB.deleteDatabase('miniden-planner')}catch(e){}})()`,
        awaitPromise: true,
      });
      await cdp('Page.reload', { ignoreCache: true });
      await t.waitForReady();
    },
    async waitForReady() {
      await t.waitFor(
        `(()=>{try{return !!(window.MINIDEN_STORE && typeof state!=='undefined' && document.querySelector('#svg2d')
          && document.querySelectorAll('.catCard').length>0 && document.querySelector('#totals'));}catch(e){return false}})()`,
        20000,
        '页面就绪'
      );
      // 目录缩略图同步渲完（#ui 态之外靠 IO，这里等它渲出若干张再往下走）
      await t
        .waitFor(`document.querySelectorAll('.catCard .ph.has').length>=1`, 12000, '目录缩略图首张渲出')
        .catch(() => {});
    },
    async rectOf(sel) {
      const r = await ev(
        `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;
          const b=e.getBoundingClientRect();
          if(b.width<1||b.height<1)return null;
          return {x:b.x+b.width/2,y:b.y+b.height/2,w:b.width,h:b.height,text:(e.textContent||'').trim().slice(0,60)};})()`
      );
      if (!r) throw new Error('元素不可见或不存在: ' + sel);
      return r;
    },
    /** 户型坐标（ft）→ 屏幕坐标：与 bench 的 SPT 同一套映射，但走真实 CTM */
    async planPoint(fx, fy) {
      const p = await ev(
        `(()=>{const s=document.querySelector('#svg2d');const ctm=s.getScreenCTM();if(!ctm)return null;
          const q=new DOMPoint(${fx}*S, ${fy}*S).matrixTransform(ctm);return {x:q.x,y:q.y};})()`
      );
      if (!p) throw new Error('svg2d 屏幕 CTM 取不到');
      return p;
    },
    async mouse(type, x, y, extra) {
      await cdp('Input.dispatchMouseEvent', Object.assign({ type, x: Math.round(x), y: Math.round(y) }, extra || {}));
    },
    async click(target, opt = {}) {
      const p = typeof target === 'string' ? await t.rectOf(target) : target;
      if (typeof target === 'string') {
        // 遮挡检查（AGENTS §8.4 三层探针的几何 + 遮挡两层）：
        // 目标中点上最上层的必须是它自己（或它的祖先/后代），否则先滚进视野再试一次。
        const probe = () =>
          t.eval(
            `(()=>{const e=document.elementFromPoint(${p.x},${p.y});const w=document.querySelector(${JSON.stringify(target)});
              if(!e||!w)return 'missing';
              // 只接受「这个点真的打在目标本身或它的子孙上」；
              // 返回祖先容器 = 目标被裁剪/滚出可视区了（rect 还在但看不见）
              if(e===w||w.contains(e))return 'ok';
              return '被盖：最上层=' + (e.id || e.className || e.tagName) + ' 目标=' + (w.id || w.className);})()`
          );
        let st = await probe();
        if (st !== 'ok') {
          await t.eval(
            `document.querySelector(${JSON.stringify(target)}).scrollIntoView({block:'center',inline:'nearest'})`
          );
          await sleep(150);
          const p2 = await t.rectOf(target);
          p.x = p2.x;
          p.y = p2.y;
          st = await probe();
          if (st !== 'ok') throw new Error('点击目标不可达：' + target + ' → ' + st);
        }
      }
      await t.mouse('mouseMoved', p.x, p.y);
      const cc = opt.double ? 2 : 1;
      await t.mouse('mousePressed', p.x, p.y, { button: 'left', buttons: 1, clickCount: cc });
      await t.mouse('mouseReleased', p.x, p.y, { button: 'left', buttons: 0, clickCount: cc });
      if (SPEED) await sleep(Math.min(SPEED, 260));
      return p;
    },
    async drag(from, to, opt = {}) {
      const a = typeof from === 'string' ? await t.rectOf(from) : from;
      const b = typeof to === 'string' ? await t.rectOf(to) : to;
      await t.mouse('mouseMoved', a.x, a.y);
      await t.mouse('mousePressed', a.x, a.y, { button: 'left', buttons: 1, clickCount: 1 });
      const steps = opt.steps || 12;
      for (let i = 1; i <= steps; i++) {
        const k = i / steps;
        await t.mouse('mouseMoved', a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, { button: 'left', buttons: 1 });
        if (SPEED) await sleep(24);
      }
      await t.mouse('mouseReleased', b.x, b.y, { button: 'left', buttons: 0, clickCount: 1 });
      if (SPEED) await sleep(Math.min(SPEED, 300));
    },
    async key(key, code, vk) {
      const base = { key, code: code || key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      if (SPEED) await sleep(120);
    },
    async type(sel, text) {
      const r = await t.rectOf(sel);
      await t.click({ x: r.x, y: r.y });
      // 先清空：Input.insertText 是在光标处**插入**，不清空就会接在旧值后面
      await ev(
        `(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.value='';e.dispatchEvent(new Event('input',{bubbles:true}));})()`
      );
      await ev(`document.querySelector(${JSON.stringify(sel)}).focus()`);
      await cdp('Input.insertText', { text });
      await ev(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new Event('input',{bubbles:true}))`);
      if (SPEED) await sleep(Math.min(SPEED, 300));
    },
    /** 真实文件选择：把文件塞进 <input type=file>（走站点自己的 change 处理） */
    async setFiles(sel, paths) {
      const doc = await cdp('DOM.getDocument', { depth: -1 });
      const q = await cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel });
      if (!q.nodeId) throw new Error('找不到 file input: ' + sel);
      await cdp('DOM.setFileInputFiles', { files: paths, nodeId: q.nodeId });
      if (SPEED) await sleep(Math.min(SPEED, 400));
    },
    async shot(label) {
      return await shot(label);
    },
    get speed() {
      return SPEED;
    },
    /** 下一次 confirm() 选「取消」（默认「确定」） */
    dialog(mode) {
      dialogMode = mode;
    },
    get dialogs() {
      return dialogLog.slice();
    },
    downloads: DL,
    /** 真实导入用的 DXF（仓库自带 fixture，无个人数据） */
    fixtureDxf: [join(root, 'tests', 'fixtures', 'apartment-mm.dxf')],
  };

  /* ---------- 跑流程 ---------- */
  const { FLOWS } = await import('./e2e-flows.mjs');
  const flows = ONLY ? FLOWS.filter((f) => f.name === ONLY) : FLOWS;
  if (!flows.length) {
    console.error('没有匹配的 flow（可选：' + FLOWS.map((f) => f.name).join(', ') + '）');
    ws.close();
    proc.kill('SIGKILL');
    process.exit(2);
  }

  console.log(
    'E21 E2E · ' + (CI ? 'headless(CI)' : 'headful（可看着）') + ' · 入口 ' + entry + ' · 每步 ' + SPEED + 'ms'
  );
  await t.waitForReady();

  for (const f of flows) {
    currentFlow = f.name;
    currentStep = null;
    console.log('\n— ' + f.name + (f.title ? ' · ' + f.title : ''));
    try {
      if (!KEEP_STATE) await t.freshState();
      await f.run(t);
      await shot(f.name + '_end');
    } catch (e) {
      failures++;
      results.push({
        flow: f.name,
        kind: 'error',
        name: 'flow 异常（停在步骤：' + (currentStep || '未开始') + '）',
        ok: false,
        detail: e.message,
      });
      console.log('  FAIL flow ' + f.name + ' 异常: ' + e.message);
      try {
        await shot(f.name + '_ERROR');
      } catch {
        /* 页面可能已经不可用 */
      }
    }
    // 每条流程结束后真实刷新：既复位状态，也顺带验持久化路径
    if (!f.noReload) {
      try {
        await t.reload();
      } catch (e) {
        failures++;
        console.log('  FAIL 刷新复位失败: ' + e.message);
      }
    }
  }

  ws.close();
  proc.kill('SIGKILL');
  await sleep(400);
  rmSync(PROFILE, { recursive: true, force: true });

  const passed = results.filter((r) => r.kind === 'assert' && r.ok).length;
  const total = results.filter((r) => r.kind === 'assert').length;
  console.log('\n[' + entry + '] ' + passed + '/' + total + ' 断言通过 · 失败 ' + failures);
  return { entry, slug, results, passed, total, failures, shotNo };
}

/* ---------- 多入口：同一套流程逐个入口各跑一遍，合并成一份报告（E18 口径） ---------- */
async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });

  const have = ENTRIES.filter((e) => existsSync(join(root, e)));
  for (const m of ENTRIES) if (!have.includes(m)) console.log('跳过入口（文件不存在，先 npm run build）：' + m);
  if (!have.length) {
    console.error('没有可跑的入口（先 npm run build）');
    process.exit(2);
  }

  const runs = [];
  for (const e of have) runs.push(await runEntry(e));

  const results = runs.flatMap((r) => r.results.map((x) => ({ ...x, entry: r.entry })));
  const passed = runs.reduce((a, r) => a + r.passed, 0);
  const total = runs.reduce((a, r) => a + r.total, 0);
  const failures = runs.reduce((a, r) => a + r.failures, 0);
  writeFileSync(join(OUT, 'log.json'), JSON.stringify({ entries: have, ci: CI, speed: SPEED, results }, null, 1));

  const byFlow = new Map();
  for (const r of results) {
    const k = r.entry + ' · ' + r.flow;
    if (!byFlow.has(k)) byFlow.set(k, []);
    byFlow.get(k).push(r);
  }
  const allShots = existsSync(SHOTS) ? (await import('node:fs')).readdirSync(SHOTS) : [];
  let html =
    `<!doctype html><meta charset="utf-8"><title>MiniDen E2E 报告</title>` +
    `<style>body{background:#12151a;color:#e8e6e1;font:14px/1.5 system-ui;margin:24px}` +
    `h1{font-size:20px} h2{margin:26px 0 8px;font-size:15px;color:#9fb3c8}` +
    `.a{padding:6px 10px;border-left:4px solid #26e0a8;margin:4px 0;background:#181c22}` +
    `.a.f{border-color:#e05656;background:#241a1c} .i{border-color:#7fb8ff;opacity:.85}` +
    `img{max-width:520px;border:1px solid #2a2f36;margin:6px 8px 6px 0;vertical-align:top}` +
    `pre{white-space:pre-wrap;margin:0;font:12px/1.4 ui-monospace}</style>` +
    `<h1>E2E 报告 · 入口 ${have.join(' + ')} · ${CI ? 'CI(headless)' : 'headful'}</h1>` +
    `<p>断言 ${passed}/${total} 通过 · 失败 ${failures} · 截图 ${runs.reduce((a, r) => a + r.shotNo, 0)} 张 · 每步 ${SPEED}ms</p>`;
  for (const r of runs) {
    html += `<p><b>${r.entry}</b>：${r.passed}/${r.total} 通过 · 失败 ${r.failures}</p>`;
  }
  for (const [flow, rows] of byFlow) {
    html += `<h2>${flow}</h2>`;
    for (const r of rows) {
      const cls = r.kind === 'info' ? 'i' : r.ok ? 'a' : 'a f';
      html += `<div class="${cls}">${r.ok ? 'PASS' : r.kind === 'info' ? 'INFO' : 'FAIL'} ${r.name}<pre>${(r.detail || '').replace(/</g, '&lt;')}</pre></div>`;
    }
    const run = runs.find((x) => x.entry === rows[0].entry);
    const key = run.slug + '-' + rows[0].flow.replace(/[^A-Za-z0-9._-]/g, '_');
    for (const n of allShots.filter((n) => n.includes(key))) html += `<img src="shots/${n}" alt="${n}">`;
  }
  writeFileSync(join(OUT, 'report.html'), html);

  console.log('\nE2E 合计: ' + passed + '/' + total + ' 断言通过 · 失败 ' + failures + ' · 入口 ' + have.join(' + '));
  console.log('报告：file://' + join(OUT, 'report.html'));
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E 驱动失败: ' + e.message);
  process.exit(2);
});
