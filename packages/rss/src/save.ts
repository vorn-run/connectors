import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ActionArgumentError } from '@vornrun/connector-sdk'

/** Where a file goes: absolute, or starting `~/`; a connector runs from its pack's folder, so a relative path would land there. */
export function filePath(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (raw === '') throw new ActionArgumentError('path', 'path is required')
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2))
  if (raw.startsWith('~') || !path.isAbsolute(raw)) {
    throw new ActionArgumentError('path', 'path must be an absolute path or start with ~/')
  }
  return path.resolve(raw)
}

/** Writes `value` as JSON beside `target` and renames it into place, so a reader never sees half a file. */
export async function writeJsonAtomically(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}
