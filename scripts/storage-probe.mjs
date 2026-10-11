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
  const readIdb = (key) => new Promise((ok)=>{
    const q = indexedDB.open('miniden-planner', 1);
    q.onupgradeneeded = ()=>{ try{ q.result.createObjectStore('miniden_kv'); }catch(e){} };
    q.onsuccess = ()=>{ const db=q.result;
      try{
        const t = db.transaction('miniden_kv','readonly');
        const rq = t.objectStore('miniden_kv').get(key);
        rq.onsuccess = ()=>{ ok(typeof rq.result==='string' ? rq.result : null); if(db.close) db.close(); };
        rq.onerror = ()=>ok(null);
      }catch(e){ ok(null); }
    };
    q.onerror = ()=>ok(null);
  });
  const listIdb = () => new Promise((ok)=>{
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
  const phase2 = location.search.indexOf('p2') >= 0;
  try{
    const S = window.MINIDEN_STORE;
    if(!S) throw new Error('window.MINIDEN_STORE 不存在（存储块没进来？）');
    S.set(${JSON.stringify(PROBE_KEY)}, JSON.stringify({ probe:1 }));
    await S.flush();
    out.backend = S.backend();
    out.stats = S.stats();
    out.degraded = S.degraded();
    out.idbKeys = await listIdb();
    out.lsProbe = localStorage.getItem(${JSON.stringify(PROBE_KEY)});
    out.lsLegacy = {};
    for(const k of ${JSON.stringify(LEGACY_KEYS)}) out.lsLegacy[k] = localStorage.getItem(k);
    if(!phase2) out.phase = 1;
    if(!phase2){
      /* ---------- 阶段 1：造两份「存档只存在主存」的户型 ----------
         为什么能造出来：localStorage 镜像有上限（mirrorLimit），超过就只进主存；
         再把 LS 里那份小的镜像删掉 → 这份户型的存档同步读就是「没有」。 */
      createBlankPlan(); const idB = PLAN_ID; const nameB = DOC.name;
      createBlankPlan(); const idC = PLAN_ID; const nameC = DOC.name;
      const bigDoc = (name, tag) => {
        const d = JSON.parse(JSON.stringify(DOC));
        d.name = name; d.imported = true; d.dataV = DOC_DATA_VERSION; d.plan = {}; d.runs = [];
        d.walls = [
          { id:'w'+tag+'a', kind:'w', src:'user', geom:{ t:'seg', x1:0, y1:0, x2:12, y2:0 }, thick:0.5, wdPx:11 },
          { id:'w'+tag+'b', kind:'w', src:'user', geom:{ t:'seg', x1:12, y1:0, x2:12, y2:9 }, thick:0.5, wdPx:11 },
        ];
        d.floorOutline = [];
        // 每次推 1000 个点再量长度（逐点 stringify 在 1.7M 字符上是 O(n²)，会跑几分钟）
        for(let guard = 0; guard < 400 && JSON.stringify(d).length < 1700000; guard++)
          for(let i = 0; i < 1000; i++) d.floorOutline.push([tag, d.floorOutline.length]);
        return d;
      };
      const kB = PLANS.docKeyFor(idB), kC = PLANS.docKeyFor(idC);
      const dB = bigDoc(nameB, 1), dC = bigDoc(nameC, 2);
      S.set(kB, JSON.stringify(dB)); S.lsRemove(kB);   // 主存为准，LS 镜像删掉
      S.set(kC, JSON.stringify(dC)); S.lsRemove(kC);
      PLAN_REG = PLANS.setActive(PLAN_REG, idB); saveRegistry();   // 刷新后从 B 这份开始
      await S.flush();
      out.regAfter = localStorage.getItem('planner_plans_v1');
      out.planIdAfter = PLAN_ID; out.regActive = PLAN_REG && PLAN_REG.active;
      out.phase = 1;
      out.plans = { idB, idC, nameB, nameC, kB, kC };
      out.idbB = await readIdb(kB);
      out.idbC = await readIdb(kC);
      out.lsB = localStorage.getItem(kB);
      out.lsC = localStorage.getItem(kC);
      localStorage.setItem('miniden_probe_plans', JSON.stringify(out.plans)); // 交给阶段 2
    } else {
      /* ---------- 阶段 2：刷新后切到「存档只存在主存」的另一份户型 ----------
         怀疑（bug 猎 #28）：switchPlan 里 STORE.warm() 不 await，紧接着 loadDoc() 同步读
         读到「没有」→ 回退成空白文档 → 同一函数末尾的 saveGeo() 把空白文档写回主存
         → 那份户型的存档被盖掉。 */
      const wait = async (fn, ms) => { const t0 = Date.now(); while(Date.now() - t0 < ms){ if(fn()) return true; await new Promise((r)=>setTimeout(r, 60)); } return fn(); };
      const p = out.plans = JSON.parse(localStorage.getItem('miniden_probe_plans') || '{}');
      out.startPlan = PLAN_ID; out.startName = DOC.name; out.startWalls = (DOC.walls||[]).length;
      out.regAtStart = localStorage.getItem('planner_plans_v1');
      out.startHydrated = await wait(()=>DOC.name === p.nameB && (DOC.walls||[]).length === 2, 8000);
      out.idbCBefore = await readIdb(p.kC);
      switchPlan(p.idC, true);
      out.afterSwitchName = DOC.name;
      out.afterSwitchWalls = (DOC.walls||[]).length;
      out.hydrated = await wait(()=>DOC.name === p.nameC && (DOC.walls||[]).length === 2, 8000);
      out.afterHydrateName = DOC.name; out.afterHydrateWalls = (DOC.walls||[]).length;
      out.idbCAfter = await readIdb(p.kC);
      out.lsCAfter = localStorage.getItem(p.kC);
      out.diag = {
        hydrated: S.stats().hydrated,
        warmingC: S.warming ? S.warming([p.kC]) : '门面没有 warming()（修复前的版本）',
        cacheC: (S.get(p.kC) || '').length,
        imported: DOC.imported,
        planId: PLAN_ID,
      };
      out.warmRace = await Promise.race([
        S.warm([p.kC]).then(() => 'warm-resolved'),
        new Promise((r) => setTimeout(() => r('warm-timeout-4s'), 4000)),
      ]);
      out.warmingAfterWarm = S.warming ? S.warming([p.kC]) : 'no-api';
      out.cacheAfterWarm = (S.get(p.kC) || '').length;
      // 第二次切：这份户型的键此刻已经 warm 过，同步读就该读到真存档
      switchPlan(p.idB, true); switchPlan(p.idC, true);
      out.secondSwitchWalls = (DOC.walls||[]).length;
      out.secondSwitchName = DOC.name;
      out.phase = 2;
    }
    out.ok = true;
  }catch(e){ out.err = String((e && e.message) || e); }
  try{ await fetch(phase2 ? '/report2' : '/report', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(out) }); }catch(e){}
  if(!phase2 && out.ok){ location.href = '/?p2=' + Date.now(); }
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
let report2 = null;
let report2At = 0;
const server = createServer((req, res) => {
  if (req.method === 'POST' && (req.url === '/report' || req.url === '/report2')) {
    const second = req.url === '/report2';
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        parsed = { ok: false, err: 'POST 不是合法 JSON: ' + String(e) };
      }
      if (second) {
        report2 = parsed;
        report2At = Date.now();
      } else {
        report = parsed;
        reportAt = Date.now();
      }
      res.writeHead(204).end();
    });
    return;
  }
  if (req.method === 'GET') {
    const pathOnly = req.url.split('?')[0]; // 阶段 2 的 URL 带 ?p2=…，别把它当成仓库根目录
    const p = pathOnly === '/' ? '/work/storage_probe.html' : pathOnly;
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
    // 阶段 2 要等页面自己刷新一次（location.href）——两份报告都到才算跑完
    if (report && report2) return true;
    if (child.exitCode !== null) {
      // 进程提前退出：再给一点时间，POST 可能刚好在路上
      for (let i = 0; i < 20 && !(report && report2); i++) await new Promise((r) => setTimeout(r, 100));
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

/* ---------------- 阶段 2：切到「存档只存在主存」的户型（E10 × E26 交叉，bug 猎 #28）
   真实刷新 + 真实 IndexedDB + 真实 switchPlan。这里不信门面说了什么，直接读主存里的字节。 */
if (report2) {
  const q = report2;
  const p = q.plans || {};
  const bigEnough = (s) => typeof s === 'string' && s.length > 1500000;
  C('阶段2 页面跑完并回报', !!q.ok, q.ok ? `用时 ${((report2At - reportAt) / 1000).toFixed(2)}s` : `err=${q.err}`);
  C(
    '造出两份只存主存的户型',
    bigEnough(r.idbB) && bigEnough(r.idbC) && !r.lsB && !r.lsC,
    `idbB=${String(r.idbB).length}B idbC=${String(r.idbC).length}B lsB=${String(r.lsB).length}B lsC=${String(r.lsC).length}B`
  );
  C(
    '刷新后当前户型的存档从主存里恢复',
    q.startHydrated === true,
    `name=${JSON.stringify(q.startName)} walls=${q.startWalls}（期望 ${JSON.stringify(p.nameB)} / 2） reg=${String(q.regAtStart).slice(0, 120)}`
  );
  C(
    '切过去后这份户型的几何真的是它自己的',
    q.afterHydrateWalls === 2 && q.afterHydrateName === p.nameC,
    `name=${JSON.stringify(q.afterHydrateName)} walls=${q.afterHydrateWalls}（期望 ${JSON.stringify(p.nameC)} / 2）diag=${JSON.stringify(q.diag)} warm=${q.warmRace} warmingAfter=${q.warmingAfterWarm} cache=${q.cacheAfterWarm} 第二次切 walls=${q.secondSwitchWalls}`
  );
  C(
    '主存里那份存档没被空白文档盖掉',
    bigEnough(q.idbCAfter) && q.idbCAfter === q.idbCBefore,
    `切之前 ${String(q.idbCBefore).length}B → 切之后 ${String(q.idbCAfter).length}B`
  );
} else {
  C('阶段2 报告', false, '页面没回报第二阶段（刷新后那一次）——多户型切换场景没跑到');
}

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
