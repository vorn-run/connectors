import { describe, expect, it } from 'vitest'
import {
  MODELS_DOC_URL,
  SAMPLE_BATCH,
  SAMPLE_MODEL,
  batchOutput,
  batchToItem,
  firstText,
  listArg,
  messageOutput,
  messagesArg,
  modelToItem,
  numberArg,
  parsed,
  stopSequencesArg
} from './items'

describe('argument helpers', () => {
  it('parses text as JSON and passes parsed values through', () => {
    expect(parsed('{"a":1}', 'x')).toEqual({ a: 1 })
    expect(parsed({ a: 1 }, 'x')).toEqual({ a: 1 })
    expect(() => parsed('{nope', 'x')).toThrow('x must be JSON')
  })

  it('turns prompt text into one user turn and passes a turns array through', () => {
    expect(messagesArg('hello')).toEqual([{ role: 'user', content: 'hello' }])
    expect(messagesArg(' [{"role":"user","content":"hi"}]')).toEqual([{ role: 'user', content: 'hi' }])
    expect(messagesArg([{ role: 'assistant', content: 'yo' }])).toEqual([{ role: 'assistant', content: 'yo' }])
    expect(messagesArg({ role: 'user', content: 'one' })).toEqual([{ role: 'user', content: 'one' }])
    expect(() => messagesArg('')).toThrow('messages is required')
    expect(() => messagesArg(undefined)).toThrow('messages is required')
    expect(() => messagesArg('[1]')).toThrow('messages must be prompt text or a JSON array')
    expect(() => messagesArg('[nope')).toThrow('messages must be JSON')
  })

  it('reads a list from an array or a single object, and nothing from nothing', () => {
    expect(listArg(undefined, 'tools')).toBeUndefined()
    expect(listArg('', 'tools')).toBeUndefined()
    expect(listArg([{ name: 'a' }], 'tools')).toEqual([{ name: 'a' }])
    expect(listArg({ name: 'a' }, 'tools')).toEqual([{ name: 'a' }])
    expect(listArg('[{"name":"a"}]', 'tools')).toEqual([{ name: 'a' }])
    expect(() => listArg('{', 'tools')).toThrow('tools must be JSON')
  })

  it('reads stop sequences from a line or a JSON array', () => {
    expect(stopSequencesArg(undefined)).toBeUndefined()
    expect(stopSequencesArg('END, STOP ,')).toEqual(['END', 'STOP'])
    expect(stopSequencesArg('["END","STOP"]')).toEqual(['END', 'STOP'])
    expect(stopSequencesArg(['a, b'])).toEqual(['a, b'])
    expect(stopSequencesArg(' , ')).toBeUndefined()
    expect(() => stopSequencesArg('[1]')).toThrow('stopSequences must be strings')
  })

  it('reads numbers and leaves unset alone', () => {
    expect(numberArg(undefined, 'maxTokens')).toBeUndefined()
    expect(numberArg('', 'maxTokens')).toBeUndefined()
    expect(numberArg('0.5', 'temperature')).toBe(0.5)
    expect(numberArg(7, 'maxTokens')).toBe(7)
    expect(() => numberArg('many', 'maxTokens')).toThrow('maxTokens must be a number, got "many"')
  })
})

describe('outputs', () => {
  it('takes the first text block and leaves text empty for a tool call alone', () => {
    expect(firstText([{ type: 'tool_use', id: 't' }, { type: 'text', text: 'hi' }, { type: 'text', text: 'later' }])).toBe('hi')
    expect(firstText([{ type: 'tool_use', id: 't' }])).toBe('')
    expect(firstText(undefined)).toBe('')
    expect(firstText([{ type: 'text' }])).toBe('')
  })

  it('shapes a message, reading missing fields as empty', () => {
    const message = {
      id: 'msg_1',
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: 'Hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 2, output_tokens: 3 }
    }
    expect(messageOutput(message)).toEqual({
      id: 'msg_1',
      model: 'claude-sonnet-5',
      text: 'Hello',
      stopReason: 'end_turn',
      usage: { input_tokens: 2, output_tokens: 3 },
      raw: message
    })
    expect(messageOutput({})).toEqual({ id: '', model: '', text: '', stopReason: '', usage: {}, raw: {} })
  })

  it('shapes a batch, reading missing fields as empty', () => {
    expect(batchOutput(SAMPLE_BATCH)).toEqual({
      id: SAMPLE_BATCH.id,
      processingStatus: 'ended',
      requestCounts: SAMPLE_BATCH.request_counts,
      createdAt: SAMPLE_BATCH.created_at,
      endedAt: SAMPLE_BATCH.ended_at,
      expiresAt: SAMPLE_BATCH.expires_at,
      cancelInitiatedAt: null,
      resultsUrl: SAMPLE_BATCH.results_url,
      raw: SAMPLE_BATCH
    })
    expect(batchOutput({} as never)).toMatchObject({ id: '', processingStatus: '', requestCounts: {}, endedAt: null, resultsUrl: null })
  })
})

describe('items', () => {
  it('describes an ended batch by its counts, stamped with its end time', () => {
    expect(batchToItem(SAMPLE_BATCH)).toEqual({
      externalId: SAMPLE_BATCH.id,
      title: `Batch ${SAMPLE_BATCH.id} ended: 50 succeeded, 30 errored, 10 canceled, 10 expired`,
      status: 'ended',
      updatedAt: SAMPLE_BATCH.ended_at,
      data: SAMPLE_BATCH
    })
    expect(batchToItem({ id: 'msgbatch_x' })).toEqual({
      externalId: 'msgbatch_x',
      title: 'Batch msgbatch_x ended: no requests',
      status: '',
      data: { id: 'msgbatch_x' }
    })
  })

  it('names a model by its display name and points at the models page', () => {
    expect(modelToItem(SAMPLE_MODEL)).toEqual({
      externalId: 'claude-opus-5',
      title: 'Claude Opus 5',
      url: MODELS_DOC_URL,
      updatedAt: SAMPLE_MODEL.created_at,
      data: SAMPLE_MODEL
    })
    expect(modelToItem({ id: 'claude-x' })).toEqual({ externalId: 'claude-x', title: 'claude-x', url: MODELS_DOC_URL, data: { id: 'claude-x' } })
  })
})
