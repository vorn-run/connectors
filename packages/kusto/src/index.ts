import { createKustoConnector } from "./connector";
import { serveIfEntryPoint } from "./entry";
import pkg from "../package.json";

export { createKustoConnector } from "./connector";
export type { KustoConnectorOptions } from "./connector";

const { version } = pkg;

export const kustoConnector = createKustoConnector({ version });

// The names the SDK's own tooling loads a connector by.
export { kustoConnector as connector };
export default kustoConnector;

serveIfEntryPoint(kustoConnector, import.meta.url);
