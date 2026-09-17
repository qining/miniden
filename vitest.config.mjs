import { defineConfig } from 'vitest/config';

// MiniDen 纯逻辑层单测（schema / geo / import…）。
// 只跑纯函数——DOM/WebGL 相关的行为回归在 work/t_*.html 测试台（AGENTS §3）。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
