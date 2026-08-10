#!/usr/bin/env node
/**
 * Build catalog.json from what each connector says about itself.
 *
 * The catalog is the only thing the app has before a connector is installed, so
 * it has to carry enough to decide with: what it fires on, what a workflow can
 * ask it to do, what it will want configured. All of that already exists in the
 * connector's own manifest, and a hand-maintained copy of it drifts — a trigger
 * gets renamed and the list keeps advertising the old one.
 *
 * So the manifest is the source, and the parts of a listing a manifest has no
 * opinion about — where it belongs in a list, what to find it by, how it signs
 * in — live in that package's own package.json under "vorn". Nothing about a
 * connector is described anywhere but its own directory.
 *
 * Run with --check to verify the committed file matches, which is what CI does.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { connectorManifest } from '@vornrun/connector-sdk'

const CATALOG_VERSION = 1

/** Trim an action's inputs down to what someone deciding would want to see. */
function summarize(entries) {
  return entries.map((entry) => ({
    type: entry.type,
    label: entry.label,
    ...(entry.description && { description: entry.description })
  }))
}

/**
 * The environment variables a connection will ask for.
 *
 * Taken from the triggers' setup rather than declared again, and de-duplicated
 * because every trigger of a connector reads the same connector-level config.
 */
function requiredEnv(manifest) {
  const seen = new Map()
  for (const trigger of manifest.triggers) {
    for (const variable of trigger.setup?.env ?? []) {
      if (!seen.has(variable.name)) seen.set(variable.name, variable)
    }
  }
  return [...seen.values()].map((variable) => ({
    name: variable.name,
    required: variable.required,
    ...(variable.description && { description: variable.description })
  }))
}

async function entryFor(dir) {
  const pkg = JSON.parse(readFileSync(`packages/${dir}/package.json`, 'utf8'))
  const built = resolve(`packages/${dir}/dist/index.js`)
  if (!existsSync(built)) {
    throw new Error(`packages/${dir} is not built — run \`yarn build\` first`)
  }

  const module = await import(pathToFileURL(built).href)
  const connector = Object.values(module).find(
    (value) => value && typeof value === 'object' && 'id' in value && 'triggers' in value
  )
  if (!connector) throw new Error(`packages/${dir} exports no connector`)

  const manifest = connectorManifest(connector)
  const listing = pkg.vorn ?? {}
  const capabilities = []
  if (manifest.triggers.length > 0) capabilities.push('triggers')
  if (manifest.actions.length > 0) capabilities.push('actions')

  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description ?? '',
    packageName: pkg.name,
    version: pkg.version,
    capabilities,
    ...(listing.category && { category: listing.category }),
    ...(listing.keywords && { keywords: listing.keywords }),
    ...(listing.auth && { auth: listing.auth }),
    ...(manifest.icon && { icon: manifest.icon }),
    triggers: summarize(manifest.triggers),
    actions: summarize(manifest.actions),
    env: requiredEnv(manifest)
  }
}

const dirs = readdirSync('packages', { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const connectors = []
for (const dir of dirs) connectors.push(await entryFor(dir))

const catalog = JSON.stringify({ version: CATALOG_VERSION, connectors }, null, 2) + '\n'

if (process.argv.includes('--check')) {
  const current = existsSync('catalog.json') ? readFileSync('catalog.json', 'utf8') : ''
  if (current !== catalog) {
    console.error('catalog.json is stale — run `node scripts/build-catalog.mjs` and commit it.')
    process.exit(1)
  }
  console.log(`catalog ok — ${connectors.length} connector(s), matching their manifests`)
} else {
  writeFileSync('catalog.json', catalog)
  console.log(`catalog written — ${connectors.length} connector(s)`)
}
