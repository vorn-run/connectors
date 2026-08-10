#!/usr/bin/env node
/**
 * Every connector package must be wired into the same gate.
 *
 * `yarn test` runs whatever each workspace calls `test`, so a package with no
 * such script is not failing — it is silently absent, and its coverage never
 * appears anywhere. That is a plausible thing for an agent opening a connector
 * PR to produce, and it looks exactly like success. This checks the wiring
 * itself rather than the result.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'

const REQUIRED_SCRIPTS = ['build', 'test', 'typecheck']
const problems = []

const packages = readdirSync('packages', { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)

if (packages.length === 0) problems.push('no packages found')

for (const name of packages) {
  const dir = `packages/${name}`
  const manifestPath = `${dir}/package.json`
  if (!existsSync(manifestPath)) {
    problems.push(`${name}: no package.json`)
    continue
  }

  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const script of REQUIRED_SCRIPTS) {
    if (!pkg.scripts?.[script]) problems.push(`${name}: no "${script}" script`)
  }

  // Without this the package runs vitest with its own defaults, which means no
  // coverage thresholds — the gate silently does not apply to it.
  const configPath = `${dir}/vitest.config.ts`
  if (!existsSync(configPath)) {
    problems.push(`${name}: no vitest.config.ts, so the coverage gate does not apply`)
  } else if (!readFileSync(configPath, 'utf8').includes('vitest.shared')) {
    problems.push(`${name}: vitest.config.ts does not extend the shared config`)
  }

  const tests = readdirSync(`${dir}/src`).filter((file) => file.endsWith('.test.ts'))
  if (tests.length === 0) problems.push(`${name}: no tests under src/`)
}

if (problems.length > 0) {
  console.error('packages are not wired into the gate:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`packages ok — ${packages.length} wired into build, test and typecheck`)
