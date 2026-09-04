import { createNotionConnector } from "./connector";
import { serveIfEntryPoint } from "./entry";
import pkg from "../package.json";

export { createNotionConnector } from "./connector";
export type { NotionConnectorOptions, CreateApi } from "./connector";

const { version } = pkg;

export const notionConnector = createNotionConnector({ version });

// The names the SDK's own tooling loads a connector by.
export { notionConnector as connector };
export default notionConnector;

serveIfEntryPoint(notionConnector, import.meta.url);
