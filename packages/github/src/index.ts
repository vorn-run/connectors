import { createRequire } from 'node:module'
import { createGitHubConnector } from './connector'
import { serveIfEntryPoint } from './entry'

export { createGitHubConnector, issueToItem, issueNumber } from './connector'
export type { GitHubConnectorOptions } from './connector'
export {
  createGitHubClient,
  createTokenSource,
  githubPreflight,
  ghInstallHint,
  runGh,
  GhNotFoundError,
  GhSignedOutError
} from './client'
export type { GitHubApi, GitHubClient, PreflightResult, RunGh, TokenSource } from './client'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export const githubConnector = createGitHubConnector({ version })

serveIfEntryPoint(githubConnector, import.meta.url)
