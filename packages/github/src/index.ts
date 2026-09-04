import { createGitHubConnector } from "./connector";
import { serveIfEntryPoint } from "./entry";

export { createGitHubConnector, issueToItem, issueNumber } from "./connector";
export type { GitHubConnectorOptions } from "./connector";
export {
  createGitHubClient,
  createTokenSource,
  githubPreflight,
  ghInstallHint,
  runGh,
  GhNotFoundError,
  GhSignedOutError,
} from "./client";
import pkg from "../package.json";
export type {
  GitHubApi,
  GitHubClient,
  PreflightResult,
  RunGh,
  TokenSource,
} from "./client";

const { version } = pkg;

export const githubConnector = createGitHubConnector({ version });

// The names the SDK's own tooling loads a connector by.
export { githubConnector as connector };
export default githubConnector;

serveIfEntryPoint(githubConnector, import.meta.url);
