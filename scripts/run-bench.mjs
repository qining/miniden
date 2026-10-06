#!/usr/bin/env node
/* E5: headless 测试台运行器（CI + 本地通用）
 *
 *   node scripts/run-bench.mjs                 # 跑 work/ 里存在的全部 bench
 *   node scripts/run-bench.mjs t_3d.html ...   # 只跑指定 bench
 *
 * 环境：
 *   CHROME=/path/to/chrome   默认：macOS Google Chrome，CI（env CI=true）用 google-chrome
 *   每个 bench 的窗口 / virtual-time-budget / <pre id> 与 AGENTS §3 的 run() 完全一致。
 * 退出码：任一 bench 出现 FAIL / EXC / NO TEST OUTPUT → 1。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.CHROME
  || (process.env.CI === 'true' ? 'google-chrome'
      : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const CI_FLAGS = process.env.CI === 'true' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];

// 与 AGENTS §3 的表格一致（dist 的 t_walledit budget 120000）
const SPEC = {
  't_walledit.html':      { pre: 'wetest', budget: 100000, win: '1700,1100' },
  't_walledit_dist.html': { pre: 'wetest', budget: 120000, win: '1700,1100' },
  't_3d.html':            { pre: 't3d',    budget: 170000, win: '1400,950'  },
  't_3d_dist.html':       { pre: 't3d',    budget: 170000, win: '1400,950'  },
  't_3d_app.html':        { pre: 't3d',    budget: 170000, win: '1400,950'  },
  't_pt.html':            { pre: 'tpt',    budget: 600000, win: '1200,850'  },
  't_pt_dist.html':       { pre: 'tpt',    budget: 600000, win: '1200,850'  },
  't_pt_app.html':        { pre: 'tpt',    budget: 600000, win: '1200,850'  },
};

const wanted = process.argv.slice(2);
const list = wanted.length ? wanted : Object.keys(SPEC).filter(f => existsSync(join(root, 'work', f)));
if (!list.length) { console.error('work/ 里没有 bench（先 npm run build）'); process.exit(2); }

let fail = 0;
function attempt(f, spec) {
  const page = join(root, 'work', f);
  if (!existsSync(page)) return { ok: false, head: `FAIL ${f} | 页面不存在（先 npm run build）`, bad: [] };
  const [w, h] = spec.win.split(',');
  let dom = '';
  try {
    dom = execFileSync(CHROME, [
      '--headless', '--use-angle=swiftshader', '--allow-file-access-from-files',
      ...CI_FLAGS,
      '--dump-dom', `--virtual-time-budget=${spec.budget}`, `--window-size=${w},${h}`,
      `file://${page}`,
    ], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', timeout: 15 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { ok: false, head: `FAIL ${f} | chrome 失败: ${String(e.message).slice(0, 200)}`, bad: [] };
  }
  const m = dom.match(new RegExp(`<pre id="${spec.pre}">([\\s\\S]*?)</pre>`));
  if (!m) return { ok: false, head: `FAIL ${f} | NO TEST OUTPUT`, bad: [] };
  const raw = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  const lines = raw.split('\n');
  const tests = lines.filter(l => l.startsWith('PASS') || l.startsWith('FAIL')).length;
  const bad = lines.filter(l => l.startsWith('FAIL') || l.startsWith('EXC'));
  return { ok: !bad.length, head: `${bad.length ? 'FAIL' : 'PASS'} ${f} | tests ${tests} · fails ${bad.length}`, bad };
}

for (const f of list) {
  const spec = SPEC[f];
  if (!spec) { console.error(`未知 bench: ${f}`); fail++; continue; }
  let r = attempt(f, spec);
  if (!r.ok) {
    // AGENTS §3：headless 瞬态（如 t_pt kallax 全黑）→ 原样重跑一次再下结论
    console.log(`${r.head} → 重跑一次（已知 headless 瞬态）`);
    for (const b of r.bad.slice(0, 12)) console.log('   ', b.slice(0, 220));
    const r2 = attempt(f, spec);
    if (r2.ok) { console.log(`PASS ${f} | tests 重跑通过（首次为瞬态：${r.bad.map(b => b.split('|')[0]).join('; ').slice(0, 200)}）`); continue; }
    r = r2;
  }
  console.log(r.head);
  for (const b of r.bad.slice(0, 12)) console.log('   ', b.slice(0, 220));
  if (!r.ok) fail++;
}
process.exit(fail ? 1 : 0);
