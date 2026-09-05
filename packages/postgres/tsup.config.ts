import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  dts: true,
  // The driver travels inside the bundle, so the packed connector carries no runtime dependency.
  noExternal: ['postgres'],
  // Vorn spawns the built file directly.
  banner: { js: '#!/usr/bin/env node' }
})
