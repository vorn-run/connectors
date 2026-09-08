import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  dts: true,
  // The driver travels inside the bundle, so the packed connector carries no runtime dependency.
  noExternal: ['mysql2'],
  // Vorn spawns the built file directly; the driver is CommonJS and requires Node builtins, so it gets a require.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);"
  }
})
