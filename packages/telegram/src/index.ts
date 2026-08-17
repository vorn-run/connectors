import { createRequire } from 'node:module'
import { createTelegramConnector } from './connector'
import { serveIfEntryPoint } from './entry'

export { createTelegramConnector } from './connector'
export type { TelegramConnectorOptions } from './connector'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export const telegramConnector = createTelegramConnector({ version })

serveIfEntryPoint(telegramConnector, import.meta.url)
