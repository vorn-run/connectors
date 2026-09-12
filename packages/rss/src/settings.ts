import type { ConnectorConfig } from '@vornrun/connector-sdk'
// Bundled at build time: a pack is one file, so a version read from disk is not there to read.
import pkg from '../package.json'

export const DEFAULT_USER_AGENT = `vorn-connector-rss/${pkg.version} (+https://vorn.run)`
export const DEFAULT_LOOKBACK_HOURS = 24
export const MAX_LOOKBACK_HOURS = 8760

function blank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === ''
}

/** A whole number in range, the fallback when empty, else an error naming the field. */
export function wholeNumber(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (blank(value)) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a whole number from ${min}${max === Infinity ? ' up' : ` to ${max}`}`)
  }
  return parsed
}

/** Hours above zero, or undefined when empty. */
export function optionalHours(value: unknown, name: string): number | undefined {
  if (blank(value)) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a number of hours above 0`)
  return parsed
}

export function lookbackHours(config: ConnectorConfig): number {
  return wholeNumber(config.lookbackHours, 'lookbackHours', 1, MAX_LOOKBACK_HOURS, DEFAULT_LOOKBACK_HOURS)
}

export function userAgentOf(config: ConnectorConfig): string {
  return config.userAgent?.trim() || DEFAULT_USER_AGENT
}
