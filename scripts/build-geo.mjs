// S5: 把 src/geo/（TypeScript）编译成 IIFE 并注入 planner.html
//
// 单一事实来源 = src/geo/（有单测 + tsc strict 门禁）。
// planner.html 里的 `<script id="miniden-geo">` 块是 vendored 副本：
//   - 本脚本重新生成它（npm run geo:build）
//   - build.mjs 每次构建校验它 == 最新编译输出（不一致即失败）
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

export async function bundleGeo() {
  const r = await esbuild.build({
    entryPoints: [join(root, 'src/geo/entry.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    minify: true,
    sourcemap: false,
    write: false,
  });
  const code = r.outputFiles[0].text;
  const banner =
    '/* VENDORED —— 由 scripts/build-geo.mjs 从 src/geo/ 编译生成，勿手改。\n' +
    '   src/ 是唯一事实来源（单测 + tsc strict）；改 src/geo/ 后跑 `npm run geo:build`。\n' +
    '   build.mjs 校验本块与最新编译输出逐字节一致。 */\n';
  return banner + code;
}

export function injectGeo(html, code) {
  const START = '<script id="miniden-geo">\n';
  const END = '\n</script><!-- /miniden-geo -->';
  const a = html.indexOf(START);
  if (a >= 0) {
    const b = html.indexOf(END, a);
    if (b < 0) throw new Error('miniden-geo 块结束标记丢失');
    return html.slice(0, a) + START + code + END + html.slice(b + END.length);
  }
  // 首次注入：紧跟 schema 块之后（保证 MINIDEN 先就位）
  const after = html.indexOf('<!-- /miniden-schema -->');
  if (after < 0) throw new Error('找不到 miniden-schema 块（先跑 npm run schema:build）');
  const pos = after + '<!-- /miniden-schema -->'.length;
  return html.slice(0, pos) + '\n' + START + code + END + html.slice(pos);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const code = await bundleGeo();
  writeFileSync(join(root, 'src/geo/dist-geo.js'), code);
  const htmlPath = join(root, 'planner.html');
  const html = readFileSync(htmlPath, 'utf8');
  writeFileSync(htmlPath, injectGeo(html, code));
  console.log(`geo bundle ${code.length}B → planner.html <script id="miniden-geo">`);
}
