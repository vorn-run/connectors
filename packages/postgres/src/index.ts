import { createPostgresConnector } from "./connector";
import { serveIfEntryPoint } from "./entry";
import pkg from "../package.json";

export { createPostgresConnector } from "./connector";
export type { PostgresConnectorOptions } from "./connector";

const { version } = pkg;

export const postgresConnector = createPostgresConnector({ version });

// The names the SDK's own tooling loads a connector by.
export { postgresConnector as connector };
export default postgresConnector;

serveIfEntryPoint(postgresConnector, import.meta.url);
