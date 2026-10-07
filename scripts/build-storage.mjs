// E10: 把 src/storage/（TypeScript）编译成 IIFE 并注入 app.html
//
// 单一事实来源 = src/storage/（单测 tests/storage/store.test.ts + tsc strict 门禁）。
// app.html 里的 `<script id="miniden-storage">` 块是 vendored 副本：
//   - 本脚本重新生成它（npm run storage:build）
//   - build.mjs 每次构建校验它 == 最新编译输出（不一致即失败）
//
// 产物同时落一份 src/storage/dist-storage.js（便于 diff / 单文件分发包引用）。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

export async function bundleStorage() {
  const r = await esbuild.build({
    entryPoints: [join(root, 'src/storage/entry.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    minify: true,
    sourcemap: false,
    write: false,
  });
  const code = r.outputFiles[0].text;
  const banner =
    '/* VENDORED —— 由 scripts/build-storage.mjs 从 src/storage/ 编译生成，勿手改。\n' +
    '   src/ 是唯一事实来源（单测 + tsc strict）；改 src/storage/ 后跑 `npm run storage:build`。\n' +
    '   build.mjs 校验本块与最新编译输出逐字节一致。 */\n';
  return banner + code;
}

export function injectStorage(html, code) {
  const START = '<script id="miniden-storage">\n';
  const END = '\n</script><!-- /miniden-storage -->';
  const a = html.indexOf(START);
  if (a >= 0) {
    const b = html.indexOf(END, a);
    if (b < 0) throw new Error('app.html 的 miniden-storage 块缺结束标记');
    return html.slice(0, a) + START + code + html.slice(b);
  }
  // 首次注入：放在 miniden-schema 之前（主脚本之前即可，storage 不依赖 schema）
  const anchor = html.indexOf('<script id="miniden-schema">');
  if (anchor < 0) throw new Error('app.html 里找不到注入锚点（miniden-schema）');
  return html.slice(0, anchor) + START + code + END + '\n' + html.slice(anchor);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const code = await bundleStorage();
  writeFileSync(join(root, 'src', 'storage', 'dist-storage.js'), code);
  const html = readFileSync(join(root, 'app.html'), 'utf8');
  writeFileSync(join(root, 'app.html'), injectStorage(html, code));
  console.log(`storage bundle ${code.length}B → app.html <script id="miniden-storage">`);
}
