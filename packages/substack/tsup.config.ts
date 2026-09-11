import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  dts: true,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  // The markdown parser travels inside the bundle, so the packed connector carries no runtime dependency.
  noExternal: ['marked'],
  external: ['@modelcontextprotocol/sdk', '@vornrun/connector-sdk', 'zod']
})
