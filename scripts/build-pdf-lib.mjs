// S6: 把 pdfjs-dist（4.10.38 legacy build，ESM-only）包成经典脚本，
// 供 app.html 的「单文件/file://」约束使用（与 dxf-parser 同策略）：
//
//   lib/pdf.min.js       —— IIFE + top-level var pdfjsLib（classic 脚本 var 挂 window）
//   lib/pdf.worker.min.js—— IIFE + 显式 globalThis.pdfjsWorker = { WorkerMessageHandler }
//
// 4.x 砍掉了 UMD .js（只剩 .mjs），且 worker 模块只 export、不自挂全局；
// pdf.js 主库的 fake-worker 加载器优先查 `globalThis.pdfjsWorker.WorkerMessageHandler`，
// 所以 worker bundle 在**主线程**跑完（classic script）即可让 getDocument() 走
// fake worker（主线程解析）——file:// 下 Worker 构造被 CORS 拦，这条是唯一可行路径。
// 代价：解析在 UI 线程（一次性导入操作，秒级，可接受）。
//
// 单一事实来源 = node_modules/pdfjs-dist（devDep 锁 4.10.38）：
//   - 本脚本重新生成两个 lib/ 文件（npm run pdf:build）
//   - build.mjs 每次构建校验 lib/ 与最新编译输出逐字节一致（不一致即失败）
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PKG = join(root, 'node_modules', 'pdfjs-dist', 'legacy', 'build');

export async function buildPdfLibs() {
  const out = {};

  // 主库：IIFE，globalName 生成顶层 var（classic 脚本下 = window.pdfjsLib）
  {
    const r = await esbuild.build({
      entryPoints: [join(PKG, 'pdf.mjs')],
      bundle: true,
      format: 'iife',
      globalName: 'pdfjsLib',
      target: 'es2020',
      minify: true,
      sourcemap: false,
      write: false,
    });
    out['lib/pdf.min.js'] =
      '/* VENDORED —— 由 scripts/build-pdf-lib.mjs 从 pdfjs-dist@4.10.38 (legacy) 编译生成，勿手改。\n' +
      '   npm run pdf:build 重新生成；build.mjs 校验逐字节一致。Apache-2.0 (Mozilla)。 */\n' +
      r.outputFiles[0].text +
      '\n/* CJS 尾注（node require 用；浏览器无 module 不受影响）：*/\n' +
      'if (typeof module !== "undefined" && module.exports) module.exports = pdfjsLib;';
  }

  // worker：IIFE（私有命名空间）+ 尾注显式挂 globalThis.pdfjsWorker（fake-worker 入口）
  {
    const r = await esbuild.build({
      entryPoints: [join(PKG, 'pdf.worker.mjs')],
      bundle: true,
      format: 'iife',
      globalName: 'PDFJS_WORKER_BUNDLE',
      target: 'es2020',
      minify: true,
      sourcemap: false,
      write: false,
      footer: {
        js:
          'if (typeof globalThis !== "undefined") {\n' +
          '  globalThis.pdfjsWorker = { WorkerMessageHandler: PDFJS_WORKER_BUNDLE.WorkerMessageHandler };\n' +
          '}',
      },
    });
    out['lib/pdf.worker.min.js'] =
      '/* VENDORED —— 由 scripts/build-pdf-lib.mjs 从 pdfjs-dist@4.10.38 (legacy) 编译生成，勿手改。\n' +
      '   主线程 classic script：设 globalThis.pdfjsWorker → pdf.js 走 fake worker（file:// 安全）。\n' +
      '   npm run pdf:build 重新生成；build.mjs 校验逐字节一致。Apache-2.0 (Mozilla)。 */\n' +
      r.outputFiles[0].text;
  }

  return out;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const out = await buildPdfLibs();
  for (const [rel, code] of Object.entries(out)) {
    writeFileSync(join(root, rel), code);
    console.log(`${rel} ${code.length}B`);
  }
}
