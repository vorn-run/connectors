import { createGitLabConnector } from "./connector";
import { serveIfEntryPoint } from "./entry";

export { createGitLabConnector } from "./connector";
export type { GitLabConnectorOptions } from "./connector";
export {
  apiUrl,
  createGitLabClient,
  createTokenSource,
  gitlabPreflight,
  glabInstallHint,
  hostOf,
  normalizeBaseUrl,
  projectSegment,
  runGlab,
  GlabNotFoundError,
  GlabSignedOutError,
} from "./client";
export type {
  GitLabClient,
  PreflightResult,
  RunGlab,
  TokenSource,
} from "./client";
export {
  issueToItem,
  mergeRequestToItem,
  pipelineToItem,
  isFinishedPipeline,
  TERMINAL_PIPELINE_STATUSES,
} from "./items";
import pkg from "../package.json";
export type { GitLabIssue, GitLabMergeRequest, GitLabPipeline } from "./items";

const { version } = pkg;

export const gitlabConnector = createGitLabConnector({ version });

// The names the SDK's own tooling loads a connector by.
export { gitlabConnector as connector };
export default gitlabConnector;

serveIfEntryPoint(gitlabConnector, import.meta.url);
