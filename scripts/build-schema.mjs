// S1 Phase 2a: 把 src/schema/（TypeScript）编译成 IIFE 并注入 planner.html
//
// 单一事实来源 = src/schema/（有 31 单测 + tsc strict 门禁）。
// planner.html 里的 `<script id="miniden-schema">` 块是 vendored 副本：
//   - 本脚本重新生成它（npm run schema:build）
//   - build.mjs 每次构建校验它 == 最新编译输出（不一致即失败）
//
// 产物同时落一份 src/schema/dist-schema.js（便于 diff / 单文件分发包引用）。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

export async function bundleSchema() {
  const r = await esbuild.build({
    entryPoints: [join(root, 'src/schema/entry.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    minify: true,
    sourcemap: false,
    write: false,
  });
  const code = r.outputFiles[0].text;
  const banner =
    '/* VENDORED —— 由 scripts/build-schema.mjs 从 src/schema/ 编译生成，勿手改。\n' +
    '   src/ 是唯一事实来源（31 单测 + tsc strict）；改 src/schema/ 后跑 `npm run schema:build`。\n' +
    '   build.mjs 校验本块与最新编译输出逐字节一致。 */\n';
  return banner + code;
}

export function injectSchema(html, code) {
  const START = '<script id="miniden-schema">\n';
  const END = '\n</script><!-- /miniden-schema -->';
  const a = html.indexOf(START);
  if (a >= 0) {
    const b = html.indexOf(END, a);
    if (b < 0) throw new Error('miniden-schema 块结束标记丢失');
    return html.slice(0, a) + START + code + END + html.slice(b + END.length);
  }
  // 首次注入：放在主 <script>（裸标签）之前
  const main = html.indexOf('<script>\n');
  if (main < 0) throw new Error('找不到主 <script> 标签');
  return html.slice(0, main) + START + code + END + '\n' + html.slice(main);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const code = await bundleSchema();
  writeFileSync(join(root, 'src/schema/dist-schema.js'), code);
  const htmlPath = join(root, 'planner.html');
  const html = readFileSync(htmlPath, 'utf8');
  writeFileSync(htmlPath, injectSchema(html, code));
  console.log(`schema bundle ${code.length}B → planner.html <script id="miniden-schema">`);
}
