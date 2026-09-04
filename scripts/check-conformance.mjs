#!/usr/bin/env node
/**
 * Run every connector against the conformance harness and hold it to its receipt.
 *
 * `vorn-connector check --mock` exercises each declared trigger and action
 * against an in-process stub, and `--receipt` writes down what passed. The
 * receipt is committed, because the catalog quotes it: a badge that says
 * "verified" has to name checks someone can read, and a file regenerated on
 * every CI run would carry a fresh timestamp and make the catalog differ from
 * the one in the commit.
 *
 * So CI re-runs the checks and compares them with the committed receipt rather
 * than rewriting it. `--write` is the other half: what an author runs after
 * changing a connector, the way `build-catalog.mjs` is run without `--check`.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const RECEIPT_FILE = 'verified.json'

// Through realpath: the SDK may sit behind a link, and the CLI knows itself only by its real file.
const CLI = realpathSync(resolve('node_modules/@vornrun/connector-sdk/dist/cli.js'))
const write = process.argv.includes('--write')

/** What a receipt claims, with the time it was taken left out. */
function claim(receipt) {
  return JSON.stringify({
    schema: receipt.schema,
    version: receipt.version,
    checks: [...(receipt.checks ?? [])].sort()
  })
}

/** Run the harness against one connector, leaving its receipt at `into`. */
function runCheck(dir, into) {
  try {
    execFileSync('node', [CLI, 'check', './dist/index.js', '--mock', '--receipt', into], {
      cwd: `packages/${dir}`,
      stdio: 'inherit'
    })
    return true
  } catch {
    // The findings themselves are already on the console, inherited above.
    problems.push(`${dir}: failed its own checks`)
    return false
  }
}

const problems = []
const dirs = readdirSync('packages', { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

if (!existsSync(CLI)) {
  console.error(`the connector SDK is not installed — expected its CLI at ${CLI}`)
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'vorn-conformance-'))
try {
  for (const dir of dirs) {
    if (!existsSync(`packages/${dir}/dist/index.js`)) {
      problems.push(`${dir}: not built — run \`yarn build\` first`)
      continue
    }

    const committed = `packages/${dir}/${RECEIPT_FILE}`
    if (write) {
      if (runCheck(dir, RECEIPT_FILE)) console.log(`  ${dir}: receipt written`)
      continue
    }

    const fresh = join(scratch, `${dir}.json`)
    if (!runCheck(dir, fresh)) continue

    if (!existsSync(committed)) {
      problems.push(`${dir}: no ${RECEIPT_FILE} — run \`yarn conformance\` and commit it`)
      continue
    }

    const before = claim(JSON.parse(readFileSync(committed, 'utf8')))
    const after = claim(JSON.parse(readFileSync(fresh, 'utf8')))
    if (before !== after) {
      problems.push(`${dir}: ${RECEIPT_FILE} is stale — run \`yarn conformance\` and commit it`)
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (problems.length > 0) {
  console.error('connectors did not conform:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(
  write
    ? `conformance written — ${dirs.length} connector(s)`
    : `conformance ok — ${dirs.length} connector(s) match their receipts`
)
