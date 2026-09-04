import { createLinearConnector } from "./connector";
import { serveIfEntryPoint } from "./entry";
import pkg from "../package.json";

export { createLinearConnector } from "./connector";
export type { LinearConnectorOptions } from "./connector";

const { version } = pkg;

export const linearConnector = createLinearConnector({ version });

// The names the SDK's own tooling loads a connector by.
export { linearConnector as connector };
export default linearConnector;

serveIfEntryPoint(linearConnector, import.meta.url);
