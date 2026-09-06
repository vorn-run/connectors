# Trello

Trello connector for Vorn

## Build and check

```sh
yarn install
yarn build
yarn check      # verifies the connector against Vorn's contract
yarn test
yarn pack       # writes trello-0.1.0.vorn.tgz, installable in Vorn
```

## Settings

| Setting | Environment | Required |
| --- | --- | --- |
| API token | `API_TOKEN` | yes |
| Base URL | `BASE_URL` | no |

## What it offers

- **Item created** — polls for items created since the last run.
- **Create item** — creates one item and returns its id.

Rename the trigger, the action and the settings to whatever this connector
really talks to; the shapes here are a starting point, not a rule.
