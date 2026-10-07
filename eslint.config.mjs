// E6: ESLint 扁平配置。
// 覆盖范围 = JS/MJS 工具面（scripts/、bench/、build.mjs、vitest.config.mjs）。
// src/ 与 tests/ 的 .ts 暂不进 ESLint：typescript-eslint 目前 peer 只支持 TS <6.1，
// 本仓库用 TypeScript 7（原生移植，无 JS 编译器 API），等上游支持后再接入。
// TS 侧的质量线 = tsc --noEmit strict + vitest + Prettier。
// app.html / planner.html 是单文件应用本体（字节敏感），不 lint 不格式化；
// 语法门禁走 AGENTS §2 的 node --check 提取法 + bench 全量断言。
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'dist/**',
      'build/tmp/**',
      'work/**',
      'private/**',
      'lib/**',
      'node_modules/**',
      'src/geo/dist-geo.js',
      'src/schema/dist-schema.js',
      'tests/fixtures/**',
    ],
  },

  js.configs.recommended,

  {
    // Node 工具面：构建脚本、CI 脚本、门禁脚本
    files: ['scripts/**/*.mjs', 'build.mjs', 'vitest.config.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },

  {
    // bench 测试台脚本：注入页面 <script> 的经典脚本片段。
    // 它们运行在 app 的运行时里，引用大量 app 全局（state/FX/LABELS/furn3D/THREE…），
    // 这些名字在仓库里不存在声明，no-undef 只能关掉；语法与危险模式照常检查。
    files: ['bench/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser, THREE: 'readonly' },
    },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
];
