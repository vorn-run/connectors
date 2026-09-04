import { createAdoConnector } from "./connector";
import { serveIfEntryPoint } from "./entry";
import pkg from "../package.json";

export { createAdoConnector } from "./connector";
export type { AdoConnectorOptions } from "./connector";

const { version } = pkg;

export const adoConnector = createAdoConnector({ version });

// The names the SDK's own tooling loads a connector by.
export { adoConnector as connector };
export default adoConnector;

serveIfEntryPoint(adoConnector, import.meta.url);
