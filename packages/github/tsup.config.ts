import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  dts: true,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  // Installed alongside the connector rather than inlined: `@azure/identity` must stay one instance, and the SDK is not duplicated in every package.
  external: ['@azure/identity', '@vornrun/connector-sdk']
})
