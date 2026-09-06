import { createMysqlConnector } from './connector'
import { serveIfEntryPoint } from './entry'
import pkg from '../package.json'

export { createMysqlConnector } from './connector'
export type { MysqlConnectorOptions } from './connector'

const { version } = pkg

export const mysqlConnector = createMysqlConnector({ version })

// The names the SDK's own tooling loads a connector by.
export { mysqlConnector as connector }
export default mysqlConnector

serveIfEntryPoint(mysqlConnector, import.meta.url)
