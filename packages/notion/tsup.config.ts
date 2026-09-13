import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  dts: true,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  // Installed alongside the connector rather than inlined: the SDK is not duplicated, and npm keeps `@notionhq/client` current.
  external: ['@notionhq/client', '@vornrun/connector-sdk']
})
