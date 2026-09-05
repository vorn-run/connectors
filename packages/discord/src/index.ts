import { createDiscordConnector } from './connector'
import { serveIfEntryPoint } from './entry'
import pkg from '../package.json'

export { createDiscordConnector } from './connector'
export type { DiscordConnectorOptions, Settings } from './connector'
export {
  API_ROOT,
  DiscordApiError,
  compareSnowflakes,
  createDiscordClient,
  normalizeToken,
  snowflakeFrom,
  snowflakeTime
} from './client'
export type { DiscordClient, DiscordClientOptions } from './client'

const { version } = pkg

export const discordConnector = createDiscordConnector({ version })

// The names the SDK's own tooling loads a connector by.
export { discordConnector as connector }
export default discordConnector

serveIfEntryPoint(discordConnector, import.meta.url)
