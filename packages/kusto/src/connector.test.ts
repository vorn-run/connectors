import { describe, expect, it, vi } from 'vitest'
import { createConnectorHarness, connectionSetup } from '@vornrun/connector-sdk'
import {
  createKustoConnector,
  parseLookback,
  toIsoTimestamp,
  withParameters,
  SINCE_PARAM,
  LIMIT_PARAM
} from './connector'
import {
  connect,
  defaultCredential,
  kustoErrorMessage,
  normalizeClusterUrl,
  rowToRecord,
  runKustoQuery,
  tableToRecords,
  toRequestProperties,
  type KustoClientLike
} from './client'

const NOW = '2026-08-05T12:00:00.000Z'

const CONFIG = {
  cluster: 'help',
  database: 'Samples',
  query: 'Alerts | where FiredAt >= vorn_since | take vorn_limit'
}

const credential = {
  getToken: async () => ({ token: 't', expiresOnTimestamp: Date.now() + 3_600_000 })
}

interface Call {
  database: string
  query: string
  parameters: Record<string, unknown> | undefined
}

/**
 * A stand-in for the SDK's client, returning one primary result table.
 *
 * The tests inject this rather than mocking HTTP, so what is asserted is the
 * arguments this connector hands Microsoft's client — the part we own — rather
 * than a reimplementation of how that client serializes them.
 */
function respondWith(columns: string[], rows: unknown[][]) {
  const calls: Call[] = []
  const client: KustoClientLike = {
    executeQuery: vi.fn(async (database: string, query: string, properties?: unknown) => {
      calls.push({
        database,
        query,
        parameters: properties
          ? (JSON.parse(String(properties)) as { Parameters: Record<string, unknown> }).Parameters
          : undefined
      })
      return {
        primaryResults: [
          {
            columns: columns.map((name) => ({ name })),
            *rows() {
              for (const row of rows) {
                yield { getValueAt: (index: number) => row[index] }
              }
            }
          }
        ]
      }
    })
  }
  return { client, calls }
}

/** A client whose query fails the way the SDK reports a failure: an axios error. */
function failWith(data: unknown): KustoClientLike {
  return {
    executeQuery: async () => {
      throw Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data }
      })
    }
  }
}

function harness(client: KustoClientLike, config: Record<string, string | undefined> = CONFIG) {
  const connector = createKustoConnector({ connectImpl: async () => client })
  return createConnectorHarness(connector, { config, now: () => NOW })
}

describe('kusto connector', () => {
  describe('cluster url', () => {
    it('completes a bare cluster name to the public endpoint', () => {
      expect(normalizeClusterUrl('help')).toBe('https://help.kusto.windows.net')
    })

    it('leaves a fully qualified host or url alone', () => {
      expect(normalizeClusterUrl('help.kusto.windows.net')).toBe('https://help.kusto.windows.net')
      expect(normalizeClusterUrl('https://help.kusto.windows.net/')).toBe(
        'https://help.kusto.windows.net'
      )
    })

    it('rejects an empty cluster', () => {
      expect(() => normalizeClusterUrl('  ')).toThrow(/empty/)
    })

    it('refuses plaintext http, which would put an Entra token on the wire', () => {
      expect(() => normalizeClusterUrl('http://help.kusto.windows.net')).toThrow(/must use https/)
    })

    it('refuses a scheme that is not http(s) rather than treating it as a name', () => {
      expect(() => normalizeClusterUrl('ftp://help')).toThrow(/cluster name or an https URL/)
    })
  })

  describe('query parameters', () => {
    it('declares the poll window ahead of the author query', () => {
      expect(withParameters('Alerts | take 1')).toBe(
        `declare query_parameters(${SINCE_PARAM}:datetime, ${LIMIT_PARAM}:long);\nAlerts | take 1`
      )
    })

    it('refuses a query that is only whitespace', () => {
      expect(() => withParameters('   \n  ')).toThrow(/KUSTO_QUERY is empty/)
    })

    it('refuses a query that declares its own parameters', () => {
      expect(() => withParameters('declare query_parameters(x:string);\nAlerts')).toThrow(
        /must not declare its own query parameters/
      )
    })

    it('sees a declaration hidden behind leading comments and blank lines', () => {
      // Otherwise the connector prepends a second declaration and Kusto
      // answers with a syntax error that points nowhere useful.
      expect(() =>
        withParameters('// alerts query\n\n  declare query_parameters(x:string);\nAlerts')
      ).toThrow(/must not declare its own query parameters/)
    })

    it('leaves a query alone when declare only appears inside its text', () => {
      // Scanning the whole query would reject legitimate text like this.
      const query = 'Alerts | where Message has "declare query_parameters"'
      expect(withParameters(query)).toContain(query)
    })

    it('keeps leading comments in the query it sends', () => {
      expect(withParameters('// why this query exists\nAlerts')).toContain(
        '// why this query exists'
      )
    })

    it('binds the window as parameters rather than interpolating it', async () => {
      const { client, calls } = respondWith(['Id', 'Timestamp'], [])
      await harness(client).poll('queryResult', { since: '2026-08-05T11:00:00.000Z' })

      expect(calls[0].database).toBe('Samples')
      expect(calls[0].parameters).toEqual({
        [SINCE_PARAM]: '2026-08-05T11:00:00.000Z',
        // A long, not a string: `take` would reject the quoted form.
        [LIMIT_PARAM]: 100
      })
      // The user's text must survive untouched apart from the declaration.
      expect(calls[0].query).toContain(CONFIG.query)
    })

    it('bounds the first poll by the lookback instead of replaying everything', async () => {
      const { client, calls } = respondWith(['Id', 'Timestamp'], [])
      await harness(client, { ...CONFIG, lookback: '2h' }).poll('queryResult')

      expect(calls[0].parameters?.[SINCE_PARAM]).toBe('2026-08-05T10:00:00.000Z')
    })

    it('defaults the lookback to an hour and rejects a malformed one', () => {
      expect(parseLookback(undefined)).toBe(3_600_000)
      expect(parseLookback('7d')).toBe(604_800_000)
      expect(() => parseLookback('soon')).toThrow(/use a value like/)
    })

    it('sends nothing at all when there are no parameters to bind', async () => {
      // An ad-hoc action query has no window to reference, and an empty
      // Parameters object is not the same thing as no properties.
      expect(await toRequestProperties(undefined)).toBeUndefined()
      expect(await toRequestProperties({})).toBeUndefined()
    })
  })

  describe('row mapping', () => {
    it('maps columns onto items and exposes every projected field', async () => {
      const { client } = respondWith(
        ['Id', 'Timestamp', 'Title', 'Severity'],
        [['a1', new Date('2026-08-05T11:30:00Z'), 'Disk full', 3]]
      )
      const page = await harness(client).poll('queryResult')

      expect(page.items).toHaveLength(1)
      expect(page.items[0]).toMatchObject({
        externalId: 'a1',
        title: 'Disk full',
        updatedAt: '2026-08-05T11:30:00.000Z'
      })
      // `data` is flattened onto the item, so a workflow templates it as
      // {{trigger.item.Severity}}.
      expect(page.items[0].Severity).toBe(3)
    })

    it('normalizes a zone-less Kusto datetime to a lexically sortable ISO string', () => {
      // The SDK parses datetime columns into Dates, but a query can project a
      // string that only looks like one, so both paths still have to work.
      expect(toIsoTimestamp('2026-08-05 11:30:00.0000000')).toBe('2026-08-05T11:30:00.000Z')
      expect(toIsoTimestamp('2026-08-05T11:30:00Z')).toBe('2026-08-05T11:30:00.000Z')
      expect(toIsoTimestamp(new Date(NOW))).toBe(NOW)
      expect(toIsoTimestamp(null)).toBeUndefined()
      expect(toIsoTimestamp('')).toBeUndefined()
      expect(toIsoTimestamp('not a date')).toBeUndefined()
      // `new Date('nope')` is a Date, so instanceof is not enough on its own.
      expect(toIsoTimestamp(new Date('nope'))).toBeUndefined()
    })

    it('falls back to the id when the title column is absent', async () => {
      const { client } = respondWith(['Id', 'Timestamp'], [['a1', NOW]])
      const page = await harness(client).poll('queryResult')
      expect(page.items[0].title).toBe('a1')
    })

    it('falls back to the id when the title column is empty rather than blank', async () => {
      const { client } = respondWith(['Id', 'Timestamp', 'Title'], [['a1', NOW, '']])
      const page = await harness(client).poll('queryResult')
      expect(page.items[0].title).toBe('a1')
    })

    it('keeps the url key present but empty when the column is null', async () => {
      const { client } = respondWith(['Id', 'Timestamp', 'Link'], [['a1', NOW, null]])
      const page = await harness(client, { ...CONFIG, urlColumn: 'Link' }).poll('queryResult')
      expect(page.items[0].url).toBe('')
    })

    it('says so when the query projected no columns at all', async () => {
      // `[].join()` is the empty string, which would read as a missing name.
      const { client } = respondWith([], [])
      await expect(harness(client).poll('queryResult')).rejects.toThrow(/got: no columns/)
    })

    it('names a column the result left unnamed', async () => {
      const table = {
        columns: [{ name: null }],
        *rows() {
          yield { getValueAt: () => 'x' }
        }
      }
      expect(tableToRecords(table).columns).toEqual(['Column0'])
    })

    it('names the missing column when the query does not project an id', async () => {
      const { client } = respondWith(['Name', 'Timestamp'], [['x', NOW]])
      await expect(harness(client).poll('queryResult')).rejects.toThrow(
        /no "Id" column \(got: Name, Timestamp\)/
      )
    })

    it('names the missing column when the query does not project a timestamp', async () => {
      // Dedupe is by timestamp: without it the cursor never advances and
      // every poll re-delivers the same rows.
      const { client } = respondWith(['Id', 'Name'], [['a1', 'x']])
      await expect(harness(client).poll('queryResult')).rejects.toThrow(
        /no "Timestamp" column \(got: Id, Name\)/
      )
    })

    it('refuses a row whose timestamp is null rather than replaying it forever', async () => {
      const { client } = respondWith(['Id', 'Timestamp'], [['a1', null]])
      await expect(harness(client).poll('queryResult')).rejects.toThrow(/unusable "Timestamp"/)
    })

    it('refuses a row whose timestamp is not a datetime', async () => {
      const { client } = respondWith(['Id', 'Timestamp'], [['a1', 'whenever']])
      await expect(harness(client).poll('queryResult')).rejects.toThrow(/unusable "Timestamp"/)
    })

    it('refuses a row whose id is null rather than dedupe them together', async () => {
      const { client } = respondWith(['Id', 'Timestamp'], [[null, NOW]])
      await expect(harness(client).poll('queryResult')).rejects.toThrow(/needs a stable id/)
    })

    it('honours custom column names', async () => {
      const { client } = respondWith(
        ['AlertId', 'FiredAt', 'Summary', 'Link'],
        [['z9', NOW, 'Boom', 'https://example.com/z9']]
      )
      const page = await harness(client, {
        ...CONFIG,
        idColumn: 'AlertId',
        timestampColumn: 'FiredAt',
        titleColumn: 'Summary',
        urlColumn: 'Link'
      }).poll('queryResult')

      expect(page.items[0]).toMatchObject({
        externalId: 'z9',
        title: 'Boom',
        url: 'https://example.com/z9'
      })
    })
  })

  describe('dedupe', () => {
    it('does not redeliver rows Vorn has already seen', async () => {
      const { client } = respondWith(
        ['Id', 'Timestamp'],
        [
          ['a', '2026-08-05T11:00:00Z'],
          ['b', '2026-08-05T11:30:00Z']
        ]
      )
      // The query is deliberately ignoring `vorn_since` here, which is the
      // common authoring mistake; the SDK cursor must still absorb it.
      const redelivered = await harness(client).pollTwice('queryResult')
      expect(redelivered).toEqual([])
    })
  })

  describe('missing configuration', () => {
    it('names the environment variable that is missing', async () => {
      const { client } = respondWith(['Id'], [])
      await expect(
        harness(client, { database: 'Samples', query: 'Alerts' }).poll('queryResult')
      ).rejects.toThrow('KUSTO_CLUSTER is required')
      await expect(
        harness(client, { cluster: 'help', query: 'Alerts' }).poll('queryResult')
      ).rejects.toThrow('KUSTO_DATABASE is required')
    })
  })

  describe('errors', () => {
    it('surfaces the innermost Kusto error message', async () => {
      // Without this the failure reads "Request failed with status code 400",
      // which says nothing about the query that caused it.
      const client = failWith({
        error: {
          message: 'Request is invalid',
          innererror: { message: "Failed to resolve entity 'Alertz'" }
        }
      })
      await expect(harness(client).poll('queryResult')).rejects.toThrow(
        /Kusto query failed: Failed to resolve entity 'Alertz'/
      )
    })

    it('reads an error body the transport left as text', async () => {
      const client = failWith(JSON.stringify({ error: { '@message': 'Semantic error' } }))
      await expect(harness(client).poll('queryResult')).rejects.toThrow(/Semantic error/)
    })

    it('keeps an error it cannot dig into rather than inventing one', async () => {
      const client: KustoClientLike = {
        executeQuery: async () => {
          throw new Error('socket hang up')
        }
      }
      await expect(harness(client).poll('queryResult')).rejects.toThrow(/socket hang up/)
      expect(kustoErrorMessage(new Error('socket hang up'))).toBeUndefined()
      expect(kustoErrorMessage({ response: { data: 'upstream down' } })).toBeUndefined()
    })

    it('explains how to sign in when the credential chain fails', async () => {
      const client: KustoClientLike = {
        executeQuery: async () => {
          const error = new Error('no accounts found in the cache')
          error.name = 'KustoAuthenticationError'
          throw error
        }
      }
      await expect(harness(client).poll('queryResult')).rejects.toThrow(
        /az login.*no accounts found/s
      )
    })

    it('surfaces the outer message when Kusto nested nothing under it', async () => {
      const client = failWith({ error: { message: 'Request is invalid' } })
      await expect(harness(client).poll('queryResult')).rejects.toThrow(/Request is invalid/)
    })

    it('survives something that was thrown but is not an Error', async () => {
      // A rejected promise can carry anything, and reading .message off a
      // string would turn the real failure into "undefined".
      const client: KustoClientLike = {
        executeQuery: async () => {
          throw 'plain string failure'
        }
      }
      await expect(harness(client).poll('queryResult')).rejects.toThrow(/plain string failure/)
    })

    it('rejects a response with no tables', async () => {
      const client: KustoClientLike = {
        executeQuery: async () => ({ primaryResults: [] })
      }
      await expect(runKustoQuery(client, { database: 'd', query: 'q' })).rejects.toThrow(
        /no tables/
      )
    })
  })

  describe('runQuery action', () => {
    it('returns rows keyed by column name', async () => {
      const { client, calls } = respondWith(['Name', 'Count'], [['a', 1]])
      const result = await harness(client).execute('runQuery', {
        query: 'Events | summarize Count=count() by Name'
      })

      expect(result).toMatchObject({ rowCount: 1, columns: ['Name', 'Count'] })
      expect(result.rows).toEqual([{ Name: 'a', Count: 1 }])
      // An ad-hoc query gets no injected parameters to reference.
      expect(calls[0].parameters).toBeUndefined()
    })

    it('overrides the database when the step supplies one', async () => {
      const { client, calls } = respondWith(['Name'], [])
      await harness(client).execute('runQuery', { query: 'Events', database: 'Other' })
      expect(calls[0].database).toBe('Other')
    })

    it('requires a query that is more than whitespace', async () => {
      const { client } = respondWith(['Name'], [])
      await expect(harness(client).execute('runQuery', { query: '   ' })).rejects.toThrow(
        /query is required/
      )
    })

    it('refuses a query that is not text at all', async () => {
      // The SDK rejects a missing required input on our behalf, but a number
      // reaches the action, and `String(123)` would be sent as KQL.
      const { client } = respondWith(['Name'], [])
      await expect(harness(client).execute('runQuery', { query: 123 })).rejects.toThrow(
        /query is required/
      )
    })
  })

  describe('connecting', () => {
    it('reuses one client per cluster instead of re-probing the credential', async () => {
      // The connector is a long-lived process polling on a timer; a client per
      // poll would walk the credential chain every time, which for the Azure
      // CLI means spawning a process.
      const { client } = respondWith(['Id', 'Timestamp'], [])
      const connectImpl = vi.fn(async () => client)
      const h = createConnectorHarness(createKustoConnector({ connectImpl }), {
        config: CONFIG,
        now: () => NOW
      })
      await h.poll('queryResult')
      await h.poll('queryResult')
      expect(connectImpl).toHaveBeenCalledTimes(1)
    })

    it('falls back to the ambient Azure credential', async () => {
      // Constructing it touches nothing; only getToken would reach the network.
      const credential = await defaultCredential()
      expect(typeof credential.getToken).toBe('function')
      expect(await defaultCredential()).toBe(credential)
    })

    it('builds a real client from a token credential, with no access token in sight', async () => {
      // Kusto has no personal-access-token equivalent and none is wanted: the
      // credential chain covers `az login` locally and managed identity in a
      // service, and the token it mints expires on its own.
      const client = await connect('https://help.kusto.windows.net', credential)
      expect(typeof client.executeQuery).toBe('function')
    })
  })

  describe('setup', () => {
    it('exposes the environment variables Vorn must prompt for', () => {
      const setup = connectionSetup(createKustoConnector(), 'queryResult')
      const names = setup.env.map((entry) => entry.name)
      expect(names).toContain('KUSTO_CLUSTER')
      expect(names).toContain('KUSTO_QUERY')
      expect(setup.filters.pollTool).toBe('poll_queryResult')
    })
  })

  describe('reading a real result table', () => {
    it('reads the SDK’s own table type, not just the shape we declared for it', async () => {
      // Every other test injects a fake client, so nothing would notice if the
      // SDK named these members differently. This builds a genuine
      // KustoResultTable from a raw response frame and reads it the same way
      // the connector does.
      const { KustoResultTable } = await import('azure-kusto-data')
      const table = new KustoResultTable({
        TableName: 'PrimaryResult',
        Columns: [
          { ColumnName: 'Id', ColumnType: 'string' },
          { ColumnName: 'Timestamp', ColumnType: 'datetime' },
          { ColumnName: 'Severity', ColumnType: 'int' }
        ],
        Rows: [['a1', '2026-08-05T11:30:00.0000000Z', 3]]
      })

      const { columns, records } = tableToRecords(table)
      expect(columns).toEqual(['Id', 'Timestamp', 'Severity'])
      expect(records[0].Id).toBe('a1')
      expect(records[0].Severity).toBe(3)
      // The SDK parses a datetime column into a Date, which is why the
      // connector no longer has to guess at Kusto's zone-less string format.
      expect(toIsoTimestamp(records[0].Timestamp)).toBe('2026-08-05T11:30:00.000Z')
    })
  })

  describe('rowToRecord', () => {
    it('pads a row that is shorter than the column list', () => {
      expect(rowToRecord(['a', 'b'], [1])).toEqual({ a: 1, b: undefined })
    })

    it('keeps a __proto__ column as data instead of mutating the record', () => {
      // The query author picks the column names. On a plain object this
      // assignment sets the prototype, so the value disappears from the item.
      const record = rowToRecord(['__proto__', 'Severity'], [{ polluted: true }, 'high'])

      expect(Object.hasOwn(record, '__proto__')).toBe(true)
      expect({ ...record }['__proto__']).toEqual({ polluted: true })
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    })
  })
})

describe('kusto connector icon', () => {
  it('ships a glyph so the connection is not just another MCP row', () => {
    const icon = createKustoConnector().icon
    expect(icon?.paths.length).toBeGreaterThan(0)
    expect(icon?.viewBox).toBe('0 0 24 24')
  })
})
