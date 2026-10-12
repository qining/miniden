// S10: 把 src/catalog/（TypeScript）编译成 IIFE 并注入 app.html
//
// 单一事实来源 = src/catalog/（单测 tests/catalog/packs.test.ts + tsc strict 门禁）。
// app.html 里的 `<script id="miniden-catalog">` 块是 vendored 副本：
//   - 本脚本重新生成它（npm run catalog:build）
//   - build.mjs 每次构建校验它 == 最新编译输出（不一致即失败）
//
// 产物同时落一份 src/catalog/dist-catalog.js（便于 diff / 单文件分发包引用）。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

export async function bundleCatalog() {
  const r = await esbuild.build({
    entryPoints: [join(root, 'src/catalog/entry.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    minify: true,
    sourcemap: false,
    write: false,
  });
  const code = r.outputFiles[0].text;
  const banner =
    '/* VENDORED —— 由 scripts/build-catalog.mjs 从 src/catalog/ 编译生成，勿手改。\n' +
    '   src/ 是唯一事实来源（单测 + tsc strict）；改 src/catalog/ 后跑 `npm run catalog:build`。\n' +
    '   build.mjs 校验本块与最新编译输出逐字节一致。 */\n';
  return banner + code;
}

export function injectCatalog(html, code) {
  const START = '<script id="miniden-catalog">\n';
  const END = '\n</script><!-- /miniden-catalog -->';
  const a = html.indexOf(START);
  if (a >= 0) {
    const b = html.indexOf(END, a);
    if (b < 0) throw new Error('app.html 的 miniden-catalog 块缺结束标记');
    return html.slice(0, a) + START + code + html.slice(b);
  }
  // 首次注入：放在 miniden-storage 之前（主脚本之前即可，catalog 不依赖存储）
  const anchor = html.indexOf('<script id="miniden-storage">');
  if (anchor < 0) throw new Error('app.html 里找不到注入锚点（miniden-storage）');
  return html.slice(0, anchor) + START + code + END + '\n' + html.slice(anchor);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const code = await bundleCatalog();
  writeFileSync(join(root, 'src', 'catalog', 'dist-catalog.js'), code);
  const html = readFileSync(join(root, 'app.html'), 'utf8');
  writeFileSync(join(root, 'app.html'), injectCatalog(html, code));
  console.log(`catalog bundle ${code.length}B → app.html <script id="miniden-catalog">`);
}
