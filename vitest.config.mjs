import { defineConfig } from 'vitest/config';

// MiniDen 纯逻辑层单测（schema / geo / import / storage）。
// 只跑纯函数——DOM/WebGL 相关的行为回归在 work/t_*.html 测试台（AGENTS §3），
// 真实 IndexedDB 落盘在 scripts/storage-probe.mjs（真实时间，不用虚拟时间）。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // 只统计纯逻辑层：src/**/entry.ts 是浏览器接线（被 build 内联进 app.html），
      // 它们的行为由 bench（t_walledit / t_3d / t_pt）与 storage 探针覆盖，不在 vitest 里充数。
      include: ['src/**/*.ts'],
      exclude: ['src/**/entry.ts'],
      reporter: ['text'],
      // 棘轮：只许涨不许跌。跌了就是「改了代码没补测试」，CI 直接红。
      thresholds: { lines: 95, functions: 96, statements: 92, branches: 85 },
    },
  },
});
