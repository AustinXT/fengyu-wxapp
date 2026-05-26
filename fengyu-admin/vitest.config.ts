import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  resolve: {
    alias: {
      // `server-only` 在非 RSC 环境（vitest）导入即抛错。生产 RSC 下正常守护，
      // 测试里用空模块替身，让 import server-only 的模块（lib/password-transit）可被单测。
      'server-only': new URL('./tests/stubs/server-only.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/lib/**/*.{ts,tsx}', 'src/actions/**/*.ts', 'src/cron/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/types.ts',
        'src/lib/mock-data.ts',
        'src/cron/index.ts', // node-cron 调度入口，仅一行 cron.schedule 调用，不便单测
      ],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
  },
})
