import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  dts: true,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  // Installed alongside the connector rather than inlined, so the SDK is not duplicated in every package.
  external: ['@modelcontextprotocol/sdk', '@vornrun/connector-sdk', 'zod']
})
