import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  dts: true,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  // Installed alongside the connector rather than inlined: the SDK and MCP
  // runtime would otherwise be duplicated in every connector package. There is
  // no vendor client here to keep external — see the header of src/client.ts.
  external: ['@modelcontextprotocol/sdk', '@vornrun/connector-sdk', 'zod']
})
