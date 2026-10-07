#!/usr/bin/env node
// 重建 vendored lib/dxf-parser.iife.js（dxf-parser@1.1.2）。
//
// 用官方 UMD 构建（node_modules/dxf-parser/dist/dxf-parser.js）：
//   - 浏览器分支 self.DxfParser = class（页面 <script src> / dist 内联两种方式都成立）
//   - 不用 ESM dist（dist/index.js）：esbuild IIFE 会把它捆成命名空间对象
//     `var DxfParser = (()=>{...})()`（值是 {DxfParser: class}，不是构造器——
//     `new window.DxfParser()` 直接 "not a constructor"）
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const umd = readFileSync(join(root, '..', 'node_modules', 'dxf-parser', 'dist', 'dxf-parser.js'), 'utf8');
if (!/^!function\(e,a\)\{/.test(umd.trimStart()) || !umd.includes('DxfParser=a()'))
  throw new Error('node_modules/dxf-parser/dist/dxf-parser.js 不像 UMD（版本变了？人工检查）');
const header =
  '/* VENDORED dxf-parser@1.1.2 UMD (MIT, (c) 2015 mdgserver) —— 署名见 THIRD-PARTY.md；\n' +
  '   node scripts/build-dxf-lib.mjs 从 node_modules 重新生成，勿手改。 */\n';
writeFileSync(join(root, '..', 'lib', 'dxf-parser.iife.js'), header + umd + '\n');
console.log(`lib/dxf-parser.iife.js = dxf-parser@1.1.2 UMD（${(umd.length / 1024).toFixed(1)}KB）`);
