// 用法：node work/ux/shot.mjs <url> <宽> <高> <输出.png> [页面里执行的 JS（可 async，返回值打印出来）] [截图前再等 ms]
// 例：node work/ux/shot.mjs "file://$PWD/dist/app.html" 1440 900 work/ux/shots/a.png "setView('doll')" 2500
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
const CH = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , url, w, h, out, js, waitMs] = process.argv;
const port = 9400 + Math.floor(Math.random() * 400);
const ud = '/tmp/uxshot_' + port + '_' + Date.now();
const p = spawn(CH, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + ud, '--window-size=' + w + ',' + h,
  '--allow-file-access-from-files', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
let tabs = null;
for (let k = 0; k < 60 && !tabs; k++) { await new Promise((r) => setTimeout(r, 500)); try { tabs = await (await fetch('http://127.0.0.1:' + port + '/json')).json(); } catch (e) {} }
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d.result); pend.delete(d.id); } };
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await cdp('Page.navigate', { url }); await new Promise((r) => setTimeout(r, 3500));
if (js) { const r = await cdp('Runtime.evaluate', { expression: '(async()=>{' + (/\breturn\b/.test(js) ? js : 'return (' + js + ')') + '})()', returnByValue: true, awaitPromise: true });
  console.log(JSON.stringify(r.result && r.result.value !== undefined ? r.result.value : r)); }
await new Promise((r) => setTimeout(r, +(waitMs || 800)));
const s = await cdp('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(s.data, 'base64'));
try { await cdp('Browser.close'); } catch (e) {}
p.kill(); setTimeout(() => { try { rmSync(ud, { recursive: true, force: true }); } catch (e) {} process.exit(0); }, 600);
