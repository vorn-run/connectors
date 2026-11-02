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
 * The extensions written in Rust are listed from what `tools/pack` wrote for
 * them in dist/ (their manifest's name, icon and version, and the checksum of
 * the pack a release of that version carries), so run
 * `cargo run --release -p vorn-pack` first. A component's Wasm differs by
 * build host, and releases build on Linux, so take dist/ from CI's
 * `rust-extensions` artifact when packing elsewhere.
 *
 * Run with --check to verify the committed file matches, which is what CI does.
 */
import { extensionDirs, rustExtensionDirs } from './extensions.mjs'
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { connectorManifest } from '@vornrun/connector-sdk'
import { catalogEntry, readTemplateFiles } from './templates.mjs'

const CATALOG_VERSION = 1
/** Written by `yarn conformance`, committed, and quoted here as the verified badge. */
const RECEIPT_FILE = 'verified.json'
/** The repository Vorn installs a connector from, and the folder `build-extensions.mjs` writes it to. */
const GIT_URL = 'https://github.com/vorn-run/extensions.git'
const FOLDER = (id) => id
/**
 * Where a release carries the 0.8 pack of a version, under the tag that
 * published it. Kept while Vorn releases that install from packUrl are still
 * in use; a Vorn that installs from git reads git and path instead.
 */
const PACK_URL = (dir, id, version) =>
  `https://github.com/vorn-run/extensions/releases/download/${dir}-v${version}/${id}-${version}.vorn.tgz`

/**
 * The release tag of a Rust extension's folder: `adapters/claude` at 1.0.0 is
 * `adapters-claude-v1.0.0`, which `tools/pack --tag` reads back.
 */
const RUST_TAG = (dir, version) => `${dir.replace('/', '-')}-v${version}`

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

/** A connector's conformance receipt, if it has been run and committed. */
function receiptFor(dir) {
  const path = `${dir}/${RECEIPT_FILE}`
  if (!existsSync(path)) return undefined
  const receipt = JSON.parse(readFileSync(path, 'utf8'))
  return {
    schema: receipt.schema,
    version: receipt.version,
    checkedAt: receipt.checkedAt,
    checks: receipt.checks
  }
}

async function entryFor(dir) {
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'))
  const built = resolve(`${dir}/dist/index.js`)
  if (!existsSync(built)) {
    throw new Error(`${dir} is not built — run \`yarn build\` first`)
  }

  const module = await import(pathToFileURL(built).href)
  const connector = Object.values(module).find(
    (value) => value && typeof value === 'object' && 'id' in value && 'triggers' in value
  )
  if (!connector) throw new Error(`${dir} exports no connector`)

  const manifest = connectorManifest(connector)
  const listing = pkg.vorn ?? {}
  const capabilities = []
  if (manifest.triggers.length > 0) capabilities.push('triggers')
  if (manifest.actions.length > 0) capabilities.push('actions')

  const receipt = receiptFor(dir)

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
    // The rung the connector itself declares; the line above is the prose for it.
    ...(manifest.auth?.rung && { authRung: manifest.auth.rung }),
    ...(receipt && { verified: receipt }),
    // Only where the folder is committed: advertising one that is not there
    // would turn an install into a clone that finds nothing.
    ...(existsSync(`${FOLDER(manifest.id)}/vorn-extension.toml`) && {
      git: GIT_URL,
      path: FOLDER(manifest.id)
    }),
    packUrl: PACK_URL(dir, manifest.id, pkg.version),
    ...(manifest.icon && { icon: manifest.icon }),
    triggers: summarize(manifest.triggers),
    actions: summarize(manifest.actions),
    env: requiredEnv(manifest),
    // What it reaches, so the catalog can say so before anything is installed.
    ...(listing.hosts && { hosts: listing.hosts }),
    ...(listing.hostsFrom && { hostsFrom: listing.hostsFrom })
  }
}

/**
 * A Rust extension's entry: what installs it is its release's pack, which Vorn
 * fetches and admits only when the bytes match `sha256`.
 */
function rustEntryFor(dir) {
  const toml = readFileSync(`${dir}/vorn-extension.toml`, 'utf8')
  const field = (name) => toml.match(new RegExp(`^${name} = "([^"]*)"`, 'm'))?.[1]
  const id = field('id')
  const version = field('version')
  const listed = `dist/${id}-${version}.vorn.json`
  if (!existsSync(listed)) {
    throw new Error(`${dir} is not packed — run \`cargo run --release -p vorn-pack\` first`)
  }
  const pack = JSON.parse(readFileSync(listed, 'utf8'))
  return {
    id: pack.id,
    name: pack.name,
    description: pack.description,
    kind: 'extension',
    version: pack.version,
    capabilities: [],
    git: GIT_URL,
    path: dir,
    packUrl: `https://github.com/vorn-run/extensions/releases/download/${RUST_TAG(dir, version)}/${id}-${version}.vorn.tgz`,
    sha256: pack.sha256,
    ...(pack.icon && { icon: pack.icon }),
    // A kit's window, so the catalog can draw it before it is installed.
    ...(pack.tags && { tags: pack.tags }),
    ...(pack.layout && { layout: pack.layout })
  }
}

const dirs = extensionDirs()

const connectors = []
for (const dir of dirs) connectors.push(await entryFor(dir))
for (const dir of rustExtensionDirs()) connectors.push(rustEntryFor(dir))

// Templates ride the same document because the app fetches one file: a second
// URL would be a second thing to be stale, offline, or half-published.
const templates = readTemplateFiles().map((file) => catalogEntry(file.document))

const catalog = JSON.stringify({ version: CATALOG_VERSION, connectors, templates }, null, 2) + '\n'
const summary = `${dirs.length} connector(s), ${connectors.length - dirs.length} Rust extension(s), ${templates.length} template(s)`

if (process.argv.includes('--check')) {
  const current = existsSync('catalog.json') ? readFileSync('catalog.json', 'utf8') : ''
  if (current !== catalog) {
    console.error('catalog.json is stale — run `node scripts/build-catalog.mjs` and commit it.')
    process.exit(1)
  }
  console.log(`catalog ok — ${summary}, matching their manifests`)
} else {
  writeFileSync('catalog.json', catalog)
  console.log(`catalog written — ${summary}`)
}
