import { connector } from './connector'
import { serveIfEntryPoint } from './entry'

export { connector }
export default connector

await serveIfEntryPoint(import.meta.url)
