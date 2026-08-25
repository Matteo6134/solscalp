import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    // Safety code must never be "mostly" right. Coverage is reported per-layer
    // so a thinly-tested safety layer is visible rather than hidden in an average.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      exclude: ['src/config.js'],
      thresholds: { lines: 80, functions: 80, branches: 75 },
    },
  },
})
