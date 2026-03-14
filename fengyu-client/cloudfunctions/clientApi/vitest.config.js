import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    testMatch: ['**/__tests__/**/*.test.js'],
    setupFiles: ['./__tests__/setup.js'],
    coverage: {
      include: ['routes/**/*.js', 'middleware/**/*.js', 'index.js'],
      thresholds: {
        branches: 60,
        functions: 70,
        lines: 70,
      },
    },
  },
})
