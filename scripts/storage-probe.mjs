#!/usr/bin/env node
/* =====================================================================
   scripts/storage-probe.mjs — E10 存储门面的「真实浏览器」门禁（真实时间，不用虚拟时间）

   为什么单独一个脚本：IndexedDB 落盘是真实 I/O，而 bench 跑在 --virtual-time-budget 下 ——
   虚拟时间靠定时器推进、真实回调靠真实事件循环，两者错相，bench 里断言它必然随机红
   （实测：budget 100000/200000 无输出、140000 全绿；轮询窗口 40 → 120 仍偶发）。
   这里改成 slo.mjs 同一套路：本地 HTTP 服务 + headless Chrome（不给虚拟时间）+ 页面 POST 回来，
   真实时间等真实 I/O。

   验什么（每条都是「门面说了不算，直接读主存」）：
     1) 主存真的是 IndexedDB
     2) 一次 set() 真的落进主存（键名逐字节对）
     3) localStorage 镜像同时在（旧代码路径 / IDB 被屏蔽时仍读得到当前值）
     4) 旧单桶键 planner_doc_v1 / planner_v1 / planner_userGeo_v1 **没被搬进主存**
     5) 而且它们在 LS 里**还在**（迁移只复制，删了就是毁用户数据）
     6) 没有写失败、没有降级标记

   用法：node scripts/storage-probe.mjs [--mine]   （默认公开入口 dist/app.html，CI 用这个）
   ===================================================================== */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const CHROME =
  process.env.CHROME ||
  (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome');
const SWIFTSHADER_FLAG = '--enable-unsafe-swiftshader';
const PROFILE_DIR = join(root, 'work', 'storage-profile');
const PROBE_PAGE = join(root, 'work', 'storage_probe.html');
const PROBE_KEY = 'miniden_probe_doc';
const LEGACY_KEYS = ['planner_doc_v1', 'planner_v1', 'planner_userGeo_v1'];
const WAIT_MS = Number(process.env.STORAGE_PROBE_WAIT_MS || 45000);

const useMine = process.argv.includes('--mine');
const srcDist = useMine ? join(root, 'dist', 'planner.html') : join(root, 'dist', 'app.html');
if (!existsSync(srcDist)) {
  console.error(`找不到 ${srcDist} —— 先跑 node build.mjs`);
  process.exit(2);
}

/* ------------------------------------------------------------ 造探针页 */

const seedLegacy = `<script>
/* 探针：在门面 warm 之前先把旧单桶键塞进 localStorage —— 之后验「它们没被搬进主存、也没被删」 */
try{ for(const k of ${JSON.stringify(LEGACY_KEYS)}) localStorage.setItem(k, '{"probe":"legacy"}'); }catch(e){}
</script>
`;

const probeScript = `<script>
(async function(){
  const out = { ok:false, err:null };
  try{
    const S = window.MINIDEN_STORE;
    if(!S) throw new Error('window.MINIDEN_STORE 不存在（存储块没进来？）');
    S.set(${JSON.stringify(PROBE_KEY)}, JSON.stringify({ probe:1 }));
    await S.flush();
    const keys = await new Promise((ok)=>{
      const q = indexedDB.open('miniden-planner', 1);
      q.onupgradeneeded = ()=>{ try{ q.result.createObjectStore('miniden_kv'); }catch(e){} };
      q.onsuccess = ()=>{ const db=q.result;
        try{
          const t = db.transaction('miniden_kv','readonly');
          const rq = t.objectStore('miniden_kv').getAllKeys();
          rq.onsuccess = ()=>{ ok(Array.from(rq.result||[])); if(db.close) db.close(); };
          rq.onerror = ()=>ok([]);
        }catch(e){ ok([]); }
      };
      q.onerror = ()=>ok([]);
    });
    out.backend = S.backend();
    out.stats = S.stats();
    out.degraded = S.degraded();
    out.idbKeys = keys;
    out.lsProbe = localStorage.getItem(${JSON.stringify(PROBE_KEY)});
    out.lsLegacy = {};
    for(const k of ${JSON.stringify(LEGACY_KEYS)}) out.lsLegacy[k] = localStorage.getItem(k);
    out.ok = true;
  }catch(e){ out.err = String((e && e.message) || e); }
  try{ await fetch('/report', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(out) }); }catch(e){}
})();
</script>
`;

let html = readFileSync(srcDist, 'utf8');
const anchor = '<script id="miniden-storage">';
if (html.indexOf(anchor) < 0) {
  console.error('探针页里没有 <script id="miniden-storage"> —— 存储块缺失');
  process.exit(2);
}
html = html.replace(anchor, seedLegacy + anchor);
const bodyEnd = html.lastIndexOf('</body>');
if (bodyEnd < 0) {
  console.error('探针页没有 </body>');
  process.exit(2);
}
html = html.slice(0, bodyEnd) + probeScript + html.slice(bodyEnd);
writeFileSync(PROBE_PAGE, html);

/* --------------------------------------------------------------- HTTP 服务 */

let report = null;
let reportAt = 0;
const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/report') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        report = JSON.parse(body);
        reportAt = Date.now();
      } catch (e) {
        report = { ok: false, err: 'POST 不是合法 JSON: ' + String(e) };
        reportAt = Date.now();
      }
      res.writeHead(204).end();
    });
    return;
  }
  if (req.method === 'GET') {
    const p = req.url === '/' ? '/work/storage_probe.html' : req.url.split('?')[0];
    const file = join(root, p);
    if (existsSync(file)) {
      const isHtml = file.endsWith('.html');
      res.writeHead(200, { 'content-type': isHtml ? 'text/html; charset=utf-8' : 'application/octet-stream' });
      res.end(readFileSync(file));
      return;
    }
  }
  res.writeHead(404).end();
});

function listen() {
  return new Promise((ok, bad) => {
    server.listen(0, '127.0.0.1', () => ok(server.address().port));
    server.once('error', bad);
  });
}

const port = await listen();
try {
  rmSync(PROFILE_DIR, { recursive: true, force: true });
} catch (_e) {
  /* 删不掉就用它 */
}

const chromeArgs = [
  '--headless',
  `--user-data-dir=${PROFILE_DIR}`,
  '--use-angle=swiftshader',
  SWIFTSHADER_FLAG,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--disable-features=SigninPromo,DesktopFirstRun',
  '--window-size=1200,850',
  `http://127.0.0.1:${port}/`,
];

const t0 = Date.now();
const child = spawn(CHROME, chromeArgs, { stdio: ['ignore', 'ignore', 'ignore'] });

async function waitReport() {
  const deadline = t0 + WAIT_MS;
  while (Date.now() < deadline) {
    if (report) return true;
    if (child.exitCode !== null) {
      // 进程提前退出：再给一点时间，POST 可能刚好在路上
      for (let i = 0; i < 20 && !report; i++) await new Promise((r) => setTimeout(r, 100));
      return report !== null;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return report !== null;
}

const got = await waitReport();
try {
  child.kill('SIGTERM');
} catch (_e) {
  /* 已经退了 */
}
server.close();
try {
  rmSync(PROFILE_DIR, { recursive: true, force: true });
} catch (_e) {
  /* 临时 profile 清理失败不影响结果 */
}

if (!got) {
  console.error(`FAIL 没收到页面 POST（${((Date.now() - t0) / 1000).toFixed(1)}s）—— 页面可能崩了或存储块没跑`);
  process.exit(1);
}

/* ---------------------------------------------------------------- 判定 */

const r = report;
const checks = [];
const C = (name, ok, extra) => checks.push({ name, ok, extra });

C('页面跑完并回报', !!r.ok, r.ok ? `用时 ${((reportAt - t0) / 1000).toFixed(2)}s` : `err=${r.err}`);
C('主存是 IndexedDB', r.backend === 'indexedDB', `backend=${r.backend}`);
const probeInIdb = Array.isArray(r.idbKeys) && r.idbKeys.indexOf(PROBE_KEY) >= 0;
C('一次 set() 真的落进主存', probeInIdb, `idbKeys=${JSON.stringify(r.idbKeys)}`);
let lsOk;
try {
  lsOk = typeof r.lsProbe === 'string' && JSON.parse(r.lsProbe).probe === 1;
} catch (_e) {
  lsOk = false;
}
C('localStorage 镜像同时在', lsOk, `lsProbe=${String(r.lsProbe).slice(0, 40)}`);
const legacyInIdb = LEGACY_KEYS.filter((k) => Array.isArray(r.idbKeys) && r.idbKeys.indexOf(k) >= 0);
C(
  '旧单桶键没被搬进主存',
  legacyInIdb.length === 0,
  legacyInIdb.length ? `主存里出现了 ${legacyInIdb.join(', ')}` : '主存里没有旧键'
);
const legacyStillInLs = LEGACY_KEYS.every(
  (k) => r.lsLegacy && typeof r.lsLegacy[k] === 'string' && r.lsLegacy[k].length > 0
);
C('旧单桶键在 LS 里还在（迁移只复制）', legacyStillInLs, JSON.stringify(r.lsLegacy));
C(
  '没有 IDB 写失败',
  !r.stats || r.stats.idbFails === 0,
  r.stats ? `idbFails=${r.stats.idbFails} idbWrites=${r.stats.idbWrites}` : 'stats 缺失'
);
C('没有降级标记', r.degraded === false, `degraded=${r.degraded}`);

console.log(
  `E10 存储探针 · ${useMine ? 'dist/planner.html（个人入口）' : 'dist/app.html（公开入口）'} · 真实时间（无虚拟时间）`
);
let fail = 0;
for (const c of checks) {
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.name.padEnd(34)} ${c.extra ?? ''}`);
  if (!c.ok) fail++;
}
if (r.stats) console.log(`  stats: ${JSON.stringify(r.stats)}`);
console.log(fail ? `E10 存储探针：${fail} 项失败` : 'E10 存储探针：全绿');
process.exit(fail ? 1 : 0);
