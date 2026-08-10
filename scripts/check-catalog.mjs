#!/usr/bin/env node
/**
 * The catalog is a pointer list the app reads to offer connectors. Every entry
 * must name a package that exists here, or the app offers an Add button for
 * something nobody can install — a failure that only shows up in the UI.
 */
import { readFileSync, existsSync } from 'node:fs'

const catalog = JSON.parse(readFileSync('catalog.json', 'utf8'))
const problems = []

if (catalog.version !== 1) problems.push(`unsupported catalog version ${catalog.version}`)

const seen = new Set()
for (const entry of catalog.connectors ?? []) {
  for (const field of ['id', 'name', 'description', 'packageName']) {
    if (!entry[field]) problems.push(`${entry.id ?? '(no id)'}: missing ${field}`)
  }
  if (seen.has(entry.id)) problems.push(`duplicate id "${entry.id}"`)
  seen.add(entry.id)

  const dir = `packages/${entry.id}`
  if (!existsSync(`${dir}/package.json`)) {
    problems.push(`${entry.id}: no package at ${dir}`)
    continue
  }
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'))
  if (pkg.name !== entry.packageName) {
    problems.push(`${entry.id}: catalog says ${entry.packageName}, package is ${pkg.name}`)
  }
}

if (problems.length > 0) {
  console.error('catalog.json is not valid:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(`catalog ok — ${(catalog.connectors ?? []).length} connector(s)`)
