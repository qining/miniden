#!/usr/bin/env node
/* S10（R8-5K-5）：目录体检 CLI —— 验证管线分层里的「全量 schema 层」
 *
 * 为什么要有这一层：bench 的「全目录建模体检」是**渲染层**的（每件建一遍模、数三角形），
 * 275 件要跑几十秒，5,000 件就是几十分钟，不可能每轮回归都跑全。
 * 而「条目字段合不合契约、id 撞不撞、model 有没有对应建模、价格字段有没有写反」
 * 这些是纯数据判据，全量跑一遍只要几十毫秒 —— 这一层就该全量、就该进 CI。
 *
 * 用法：
 *   node scripts/catalog-check.mjs                 # 内置目录全量体检
 *   node scripts/catalog-check.mjs a.json b.json   # 再加外部目录包
 *   node scripts/catalog-check.mjs --json          # 机器可读输出
 * 退出码：0 = 干净；1 = 有 error（内置目录必须 0 error）；2 = 用法/读取错误。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/* 目录契约层从 src/catalog/ 现编现用（不依赖已生成的 dist-catalog.js，也不会读到旧副本）。
   为什么不用 `import '../src/catalog/schema.ts'`：packs.ts 里的 `from './schema'` 没有后缀，
   Node 的 ESM 解析器要求写全文件名（tsconfig 的 moduleResolution:bundler 只管 tsc/esbuild）。 */
const bundled = await esbuild.build({
  entryPoints: [join(root, 'src/catalog/entry.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  write: false,
});
new Function(bundled.outputFiles[0].text)();
const CAT = globalThis.MINIDEN_CATALOG;
const { KNOWN_KINDS, validateEntry, validatePack, duplicateIds, mergeCatalog, compileModel } = CAT;

const html = readFileSync(join(root, 'app.html'), 'utf8');

/** 从 app.html 里取出内置 CATALOG 数组与已注册的模型名集合（不执行 app 代码） */
function readBuiltins(src) {
  const a = src.indexOf('const CATALOG = [');
  if (a < 0) throw new Error('app.html 里找不到 const CATALOG = [');
  const b = src.indexOf('\n];', a);
  if (b < 0) throw new Error('CATALOG 数组找不到结束标记');
  const literal = src.slice(a + 'const CATALOG = '.length, b + 2);
  const entries = new Function('"use strict";return (' + literal + ');')();
  if (!Array.isArray(entries)) throw new Error('CATALOG 不是数组');
  const models = new Set();
  const re = /^MODELS\[('([^']+)')\]\s*=/gm;
  let m;
  while ((m = re.exec(src))) models.add(m[2]);
  return { entries, models };
}

const asJson = process.argv.includes('--json');
const packFiles = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const { entries: builtin, models: builtinModels } = readBuiltins(html);

const issues = [];
const clean = [];
for (const e of builtin) {
  const r = validateEntry(e);
  if (!r.ok) issues.push(...r.issues);
  else if (r.issues.length) issues.push(...r.issues);
  if (r.ok) clean.push(r.entry);
}
for (const id of duplicateIds(builtin))
  issues.push({ level: 'error', where: id, field: 'id', message: '内置目录 id 重复' });

/* model 字段有没有对应的建模（内置或包）——没有就会静默退回通用造型（§8.1 的「通用回退」坑） */
const packParsed = [];
for (const f of packFiles) {
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(f, 'utf8'));
  } catch (err) {
    console.error(`✗ 读不到目录包 ${f}: ${err.message}`);
    process.exit(2);
  }
  const r = validatePack(raw);
  /* CLI 口径与界面不同（这是刻意的）：界面是「包层坏 → 整包不加载，条目层坏 → 逐条拒收」，
     而「体检这个包」意味着把每一条毛病都告诉你 —— 条目层 error 也算 error。 */
  issues.push(...r.issues, ...r.entryIssues);
  if (!r.pack) continue;
  packParsed.push(r.pack);
  for (const [key, src] of Object.entries(r.pack.models)) {
    const c = compileModel(src);
    if (c.error)
      issues.push({ level: 'error', where: r.pack.pack, field: `models.${key}`, message: `模型编译失败：${c.error}` });
  }
}
const packModelKeys = new Set(packParsed.flatMap((p) => Object.keys(p.models)));
for (const e of clean) {
  const key = e.model || e.id;
  if (e.model && !builtinModels.has(key) && !packModelKeys.has(key))
    issues.push({
      level: 'error',
      where: e.id,
      field: 'model',
      message: `model '${key}' 没有对应的建模（会静默退回通用造型）`,
    });
}
const merged = mergeCatalog(builtin, packParsed);
const unknownKinds = new Set(clean.filter((e) => !KNOWN_KINDS.includes(e.kind)).map((e) => e.kind));

const errors = issues.filter((i) => i.level === 'error');
const warnings = issues.filter((i) => i.level === 'warning');

if (asJson) {
  console.log(
    JSON.stringify(
      {
        builtin: builtin.length,
        packs: packParsed.map((p) => ({
          pack: p.pack,
          entries: p.entries.length,
          models: Object.keys(p.models).length,
        })),
        merged: merged.entries.length,
        skippedConflicts: merged.conflicts.length,
        errors,
        warnings,
        unknownKinds: [...unknownKinds],
      },
      null,
      1
    )
  );
  process.exit(errors.length ? 1 : 0);
}

console.log(`内置目录：${builtin.length} 条 · 已注册模型：${builtinModels.size} 个`);
if (packParsed.length)
  console.log(
    `外部包：${packParsed
      .map((p) => `${p.pack}(${p.entries.length} 条 / ${Object.keys(p.models).length} 模型)`)
      .join(', ')}`
  );
console.log(`合并后目录：${merged.entries.length} 条（跳过同 id ${merged.conflicts.length} 条）`);
if (unknownKinds.size) console.log(`陌生 kind：${[...unknownKinds].join(', ')}`);
if (warnings.length) {
  console.log(`\n提醒 ${warnings.length} 条：`);
  for (const w of warnings.slice(0, 40)) console.log(`  ! ${w.where} [${w.field}] ${w.message}`);
  if (warnings.length > 40) console.log(`  … 其余 ${warnings.length - 40} 条`);
}
if (errors.length) {
  console.log(`\n✗ 错误 ${errors.length} 条：`);
  for (const e of errors.slice(0, 40)) console.log(`  ✗ ${e.where} [${e.field}] ${e.message}`);
  if (errors.length > 40) console.log(`  … 其余 ${errors.length - 40} 条`);
  process.exit(1);
}
console.log('\n✓ 目录体检通过（0 错误）');
