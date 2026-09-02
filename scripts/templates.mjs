/**
 * The workflow templates a new workflow can start from.
 *
 * A template is a workflow someone built in Vorn and exported — the file the
 * app writes, unchanged, with a `meta` block naming it for the list. Keeping
 * the exported shape means the export feature is the authoring tool: nothing
 * has to be transcribed by hand into a second format that could disagree with
 * the one the app reads back.
 *
 * The catalog entry is assembled here rather than stored, so a template file
 * carries no copy of anything the workflow already says.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'

export const TEMPLATES_DIR = 'templates'
export const TEMPLATE_SUFFIX = '.vorn-workflow.json'
/** The one format the app reads; a file claiming another is refused, not repaired. */
export const PORTABLE_FORMAT_VERSION = 1

/** Every template file, parsed, in a stable order. */
export function readTemplateFiles() {
  if (!existsSync(TEMPLATES_DIR)) return []
  return readdirSync(TEMPLATES_DIR)
    .filter((name) => name.endsWith(TEMPLATE_SUFFIX))
    .sort()
    .map((name) => {
      const path = `${TEMPLATES_DIR}/${name}`
      try {
        return { name, path, document: JSON.parse(readFileSync(path, 'utf8')) }
      } catch (error) {
        return { name, path, error: error.message }
      }
    })
}

/** A template file as the catalog lists it: the meta block, and the workflow under it. */
export function catalogEntry(document) {
  const { meta, ...portable } = document
  return {
    id: meta.id,
    name: meta.name,
    description: meta.description ?? '',
    steps: meta.steps ?? [],
    ...(meta.category && { category: meta.category }),
    portable
  }
}
