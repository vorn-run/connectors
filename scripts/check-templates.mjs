#!/usr/bin/env node
/**
 * Every workflow template must be one the app can actually open.
 *
 * A template is published to every install at once, and it arrives as data the
 * editor walks rather than code anyone runs — so a file that names a step type
 * this build has never heard of, or an edge pointing at a step it does not
 * carry, is a broken canvas on someone else's machine. The app repairs what it
 * can on the way in and drops the rest silently; that is the right behaviour
 * for a document off the network, and the wrong place to find out.
 *
 * The two checks worth more than the shape ones: a machine path is somebody's
 * home directory published to strangers, and a webhook token is a secret that
 * would be the same on every machine that ever used the template.
 */
import {
  catalogEntry,
  readTemplateFiles,
  PORTABLE_FORMAT_VERSION,
  TEMPLATE_SUFFIX
} from './templates.mjs'

/** The step types this build knows, mirrored from the app's WorkflowNodeType. */
const NODE_TYPES = new Set([
  'trigger',
  'launchAgent',
  'script',
  'condition',
  'approval',
  'createTaskFromItem',
  'callConnectorAction',
  'httpRequest',
  'loop'
])

/** A path that only exists on the machine the template was built on. */
const MACHINE_PATH = /(?:^|[\s"'([:=])(?:\/Users\/|\/home\/|[A-Za-z]:\\|\\\\[A-Za-z0-9._-]+\\)/

/** Config keys that would carry a secret, which a published file must not. */
const SECRET_KEYS = new Set(['token', 'secret', 'password', 'apiKey', 'accessToken', 'privateKey'])

const problems = []

/** Walk every string a template carries, so a check applies wherever it hides. */
function walkStrings(value, visit, path = '') {
  if (typeof value === 'string') return visit(value, path)
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkStrings(entry, visit, `${path}[${index}]`))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      walkStrings(entry, visit, path ? `${path}.${key}` : key)
    }
  }
}

function checkMeta(file, meta) {
  const say = (message) => problems.push(`${file.name}: ${message}`)
  if (!meta || typeof meta !== 'object') return say('no meta block — add {id, name, description, steps}')

  const expectedId = file.name.slice(0, -TEMPLATE_SUFFIX.length)
  if (typeof meta.id !== 'string' || meta.id.length === 0) say('meta.id must be a string')
  else if (meta.id !== expectedId) say(`meta.id "${meta.id}" does not match the filename`)
  if (typeof meta.name !== 'string' || meta.name.length === 0) say('meta.name must be a string')
  if (typeof meta.description !== 'string' || meta.description.length === 0) {
    say('meta.description must say what the template does')
  }
  if (!Array.isArray(meta.steps) || meta.steps.some((step) => typeof step !== 'string')) {
    say('meta.steps must be a list of step names')
  }
  if (meta.category !== undefined && typeof meta.category !== 'string') {
    say('meta.category must be a string when set')
  }
}

function checkGraph(file, portable) {
  const say = (message) => problems.push(`${file.name}: ${message}`)

  if (portable.version !== PORTABLE_FORMAT_VERSION) {
    say(`version must be ${PORTABLE_FORMAT_VERSION}, not ${JSON.stringify(portable.version)}`)
    return
  }
  if (typeof portable.name !== 'string' || portable.name.length === 0) say('the workflow needs a name')
  if (!Array.isArray(portable.nodes) || portable.nodes.length === 0) {
    say('the workflow carries no steps')
    return
  }
  if (!Array.isArray(portable.edges)) {
    say('the workflow carries no edges list')
    return
  }

  const ids = new Set()
  for (const node of portable.nodes) {
    if (!node || typeof node.id !== 'string' || typeof node.type !== 'string') {
      say('a step is missing its id or type')
      continue
    }
    if (ids.has(node.id)) say(`two steps share the id "${node.id}"`)
    ids.add(node.id)
    if (!NODE_TYPES.has(node.type)) say(`step "${node.id}" is a "${node.type}", which this build cannot draw`)
  }

  for (const edge of portable.edges) {
    if (!edge || typeof edge.source !== 'string' || typeof edge.target !== 'string') {
      say('a connection is missing its source or target')
      continue
    }
    if (!ids.has(edge.source)) say(`a connection starts at "${edge.source}", a step the file does not carry`)
    if (!ids.has(edge.target)) say(`a connection ends at "${edge.target}", a step the file does not carry`)
  }

  checkRequires(file, portable, ids)
}

function checkRequires(file, portable, ids) {
  const say = (message) => problems.push(`${file.name}: ${message}`)
  if (portable.requires === undefined) return
  if (!Array.isArray(portable.requires)) return say('requires must be a list when set')

  for (const requirement of portable.requires) {
    if (!requirement || typeof requirement.nodeId !== 'string') {
      say('a requirement names no step')
      continue
    }
    if (!ids.has(requirement.nodeId)) {
      say(`a requirement speaks for "${requirement.nodeId}", a step the file does not carry`)
    }
    if (requirement.kind === 'httpProfile') {
      if (typeof requirement.name !== 'string') say('an HTTP profile requirement needs a name')
      continue
    }
    if (requirement.kind !== 'connection') {
      say(`a requirement is a "${requirement.kind}", which the app cannot answer`)
      continue
    }
    if (typeof requirement.connectorId !== 'string' || typeof requirement.name !== 'string') {
      say('a connection requirement needs a connectorId and a name')
    }
    if (requirement.event !== undefined && typeof requirement.event !== 'string') {
      say('a connection requirement event must be a string when set')
    }
  }
}

function checkNothingPrivate(file, portable) {
  const say = (message) => problems.push(`${file.name}: ${message}`)

  walkStrings(portable, (text, path) => {
    if (MACHINE_PATH.test(text)) {
      say(`${path} carries a path from the machine it was built on — use {{project.path}}`)
    }
  })

  for (const node of Array.isArray(portable.nodes) ? portable.nodes : []) {
    const config = node?.config
    if (!config || typeof config !== 'object') continue
    for (const [key, value] of Object.entries(config)) {
      if (!SECRET_KEYS.has(key)) continue
      if (typeof value === 'string' && value.length > 0) {
        say(`step "${node.id}" publishes a ${key} — leave it empty and let each install make its own`)
      }
    }
  }
}

const files = readTemplateFiles()
const ids = new Map()

for (const file of files) {
  if (file.error) {
    problems.push(`${file.name}: not valid JSON — ${file.error}`)
    continue
  }
  // Valid JSON is not yet a document: a file holding `null` or a list would
  // destructure into nonsense, or throw, before any check ran.
  if (!file.document || typeof file.document !== 'object' || Array.isArray(file.document)) {
    problems.push(`${file.name}: is not a workflow — expected an exported workflow object`)
    continue
  }
  const { meta, ...portable } = file.document
  checkMeta(file, meta)
  checkGraph(file, portable)
  checkNothingPrivate(file, portable)

  if (meta?.id) {
    if (ids.has(meta.id)) problems.push(`${file.name}: shares its id with ${ids.get(meta.id)}`)
    else ids.set(meta.id, file.name)
  }
}

if (problems.length > 0) {
  console.error('Templates that would not open:\n')
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

console.log(`templates ok — ${files.length} template(s), every step and connection accounted for`)
for (const file of files) console.log(`  ${catalogEntry(file.document).id}`)
