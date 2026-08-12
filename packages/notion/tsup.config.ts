import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  dts: true,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  // Installed alongside the connector rather than inlined: the SDK and MCP
  // runtime would otherwise be duplicated in every connector package, and
  // `@notionhq/client` is a maintained vendor client we want npm to resolve
  // and update rather than a copy frozen into this bundle.
  external: ['@notionhq/client', '@modelcontextprotocol/sdk', '@vornrun/connector-sdk', 'zod']
})
