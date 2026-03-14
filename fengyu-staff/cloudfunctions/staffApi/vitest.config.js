import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['__tests__/setup.js'],
    include: ['__tests__/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['routes/**/*.js', 'middleware/**/*.js', 'index.js'],
      thresholds: {
        branches: 35,
        functions: 40,
        lines: 48,
      },
    },
  },
})
