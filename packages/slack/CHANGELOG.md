# Changelog

All notable changes to `@vornrun/connector-slack`.

## 0.1.0

First release.

Trigger a workflow from Slack, and let a workflow step write back.

- **Triggers:** `messageInChannel`, `replyInThread`, `memberJoinedChannel`.
- **Actions:** `postMessage`, `replyInThread`, `addReaction`, `listChannels`,
  `getChannel`, `findUserByEmail`, `getUser`.
- **Signing in:** a bot token from a Slack app installed to the workspace,
  created at api.slack.com/apps under OAuth & Permissions.

The message triggers use Slack's own `ts` as the cursor, passed back as
`oldest`, so a message is delivered once. Bot and system messages are skipped
by default; `includeBots` turns them on.

Every action reads Slack's `ok` envelope and fails with the `error` code when
it is `false`, because Slack answers HTTP 200 either way.
