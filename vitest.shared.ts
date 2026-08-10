import { defineConfig } from 'vitest/config'

/**
 * The test gate every connector package shares.
 *
 * Connectors here are increasingly written by agents rather than by hand, and
 * an agent will happily open a PR whose tests exercise the one function it
 * found easiest to reach. Coverage is the cheapest automatic answer to that, so
 * the threshold is set high and applied per file: a well-tested client module
 * must not carry an untested connector module to a passing average.
 *
 * 90% is a floor, not a target, and it does not mean the tests are good — a
 * test can execute a line and assert nothing. Reviewers still have to read them.
 */
export const COVERAGE_THRESHOLD = 90

export default defineConfig({
  test: {
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['src/**'],
      // A test file covering itself proves nothing.
      exclude: ['src/**/*.test.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: {
        perFile: true,
        statements: COVERAGE_THRESHOLD,
        branches: COVERAGE_THRESHOLD,
        functions: COVERAGE_THRESHOLD,
        lines: COVERAGE_THRESHOLD
      }
    }
  }
})
