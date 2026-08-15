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

  // The release workflow reads its notes from this file, between the heading
  // for the version being tagged and the next heading. A missing section fails
  // the release *after* the tag exists and, worse, after npm has the publish —
  // which cannot be taken back. Checking it here means the pull request fails
  // instead, while the version number is still a line in a diff.
  if (!existsSync(`${dir}/README.md`)) problems.push(`${name}: no README.md`)

  const changelogPath = `${dir}/CHANGELOG.md`
  if (!existsSync(changelogPath)) {
    problems.push(`${name}: no CHANGELOG.md, so a release of it would have no notes`)
  } else {
    const heading = `## ${pkg.version}`
    const lines = readFileSync(changelogPath, 'utf8').split('\n')
    const start = lines.findIndex((line) => line.trim() === heading)
    if (start === -1) {
      problems.push(`${name}: CHANGELOG.md has no "${heading}" section for the version in package.json`)
    } else {
      const rest = lines.slice(start + 1)
      const end = rest.findIndex((line) => line.startsWith('## '))
      const section = (end === -1 ? rest : rest.slice(0, end)).join('').trim()
      if (section === '') problems.push(`${name}: CHANGELOG.md "${heading}" section is empty`)
    }
  }

  // npm never includes CHANGELOG.md on its own, and `files` is what decides.
  // A changelog that exists in the repo but not in the tarball is not much use
  // to someone reading the package on npm.
  const files = pkg.files ?? []
  for (const required of ['README.md', 'CHANGELOG.md']) {
    if (!files.includes(required)) problems.push(`${name}: "${required}" is not in package.json "files"`)
  }
}

if (problems.length > 0) {
  console.error('packages are not wired into the gate:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`packages ok — ${packages.length} wired into build, test and typecheck`)
