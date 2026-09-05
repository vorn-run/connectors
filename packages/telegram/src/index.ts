import { createTelegramConnector } from './connector'
import { serveIfEntryPoint } from './entry'
import pkg from '../package.json'

export { createTelegramConnector } from './connector'
export type { TelegramConnectorOptions } from './connector'

const { version } = pkg

export const telegramConnector = createTelegramConnector({ version })

// The names the SDK's own tooling loads a connector by.
export { telegramConnector as connector }
export default telegramConnector

serveIfEntryPoint(telegramConnector, import.meta.url)
