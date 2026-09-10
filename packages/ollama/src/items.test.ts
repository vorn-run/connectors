import { describe, expect, it } from 'vitest'
import {
  SAMPLE_MODEL,
  SAMPLE_RUNNING_MODEL,
  flag,
  formatArg,
  gigabytes,
  isoOf,
  jsonObject,
  keepAliveArg,
  libraryUrl,
  messagesArg,
  modelToItem,
  runningToItem,
  text,
  textOrJsonArray
} from './items'

describe('argument readers', () => {
  it('reads text, flags and json objects', () => {
    expect(text('  a ')).toBe('a')
    expect(text('')).toBeUndefined()
    expect(text(undefined)).toBeUndefined()
    expect(flag('true')).toBe(true)
    expect(flag(true)).toBe(true)
    expect(flag('no')).toBe(false)
    expect(jsonObject(undefined, 'options')).toBeUndefined()
    expect(jsonObject('', 'options')).toBeUndefined()
    expect(jsonObject({ temperature: 0.2 }, 'options')).toEqual({ temperature: 0.2 })
    expect(() => jsonObject([1], 'options')).toThrow('options must be a JSON object')
  })

  it('sends text as text and a JSON array as the array', () => {
    expect(textOrJsonArray('hello')).toBe('hello')
    expect(textOrJsonArray('["a","b"]')).toEqual(['a', 'b'])
    expect(textOrJsonArray(['a'])).toEqual(['a'])
    expect(textOrJsonArray('[not json')).toBe('[not json')
    expect(textOrJsonArray('{"a":1}')).toBe('{"a":1}')
    expect(textOrJsonArray(undefined)).toBe('')
  })

  it('turns a user text into one turn and prepends a system turn once', () => {
    expect(messagesArg('hi')).toEqual([{ role: 'user', content: 'hi' }])
    expect(messagesArg('hi', 'be brief')).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' }
    ])
    expect(messagesArg('[{"role":"system","content":"s"},{"role":"user","content":"u"}]', 'ignored')).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' }
    ])
    expect(messagesArg('[{"role":"user","content":"u"}, 3, null]')).toEqual([{ role: 'user', content: 'u' }])
  })

  it('reads format as the word json, a schema object, or text', () => {
    expect(formatArg(undefined)).toBeUndefined()
    expect(formatArg('json')).toBe('json')
    expect(formatArg('{"type":"object"}')).toEqual({ type: 'object' })
    expect(formatArg({ type: 'object' })).toEqual({ type: 'object' })
    expect(formatArg('{broken')).toBe('{broken')
    expect(formatArg('check')).toBe('check')
  })

  it('reads keep-alive as a duration string or a number of seconds', () => {
    expect(keepAliveArg(undefined)).toBeUndefined()
    expect(keepAliveArg('5m')).toBe('5m')
    expect(keepAliveArg('0')).toBe(0)
    expect(keepAliveArg('-1')).toBe(-1)
  })
})

describe('items', () => {
  it('builds the sample model item the spec shows', () => {
    expect(modelToItem(SAMPLE_MODEL)).toEqual({
      externalId: 'qwen2.5-coder:7b@dae161e27b0e90dd1856c8bb3209201fd6736d8eb66298e75ed87571486f4364',
      title: 'qwen2.5-coder:7b (qwen2, 7.6B)',
      url: 'https://ollama.com/library/qwen2.5-coder',
      updatedAt: '2026-08-02T22:07:41.209Z',
      data: {
        name: 'qwen2.5-coder:7b',
        digest: 'dae161e27b0e90dd1856c8bb3209201fd6736d8eb66298e75ed87571486f4364',
        size: 4683087561,
        modified_at: '2026-08-02T16:07:41.209152383-06:00',
        family: 'qwen2',
        parameter_size: '7.6B',
        details: SAMPLE_MODEL.details
      }
    })
  })

  it('leaves out the url for a namespaced or remote model and copes with a bare entry', () => {
    expect(libraryUrl({ name: 'user/model:latest' })).toBeUndefined()
    expect(libraryUrl({ name: 'gemma3', remote_host: 'https://ollama.com' })).toBeUndefined()
    expect(libraryUrl({})).toBeUndefined()
    expect(modelToItem({ model: 'bare' })).toEqual({
      externalId: 'bare@',
      title: 'bare',
      url: 'https://ollama.com/library/bare',
      data: { name: 'bare', digest: '', size: 0, modified_at: null, family: null, parameter_size: null, details: {} }
    })
  })

  it('builds the sample running item the spec shows', () => {
    expect(runningToItem(SAMPLE_RUNNING_MODEL)).toEqual({
      externalId: 'qwen2.5-coder:7b@2026-09-10T07:31:16.885215-06:00',
      title: 'qwen2.5-coder:7b loaded (4.7 GB in VRAM, context 4096)',
      updatedAt: '2026-09-10T13:31:16.885Z',
      data: {
        name: 'qwen2.5-coder:7b',
        digest: 'dae161e27b0e90dd1856c8bb3209201fd6736d8eb66298e75ed87571486f4364',
        size: 4740716952,
        size_vram: 4740716952,
        expires_at: '2026-09-10T07:31:16.885215-06:00',
        context_length: 4096,
        details: SAMPLE_MODEL.details
      }
    })
    expect(runningToItem({ model: 'bare', size: 1_000_000_000 })).toMatchObject({
      externalId: 'bare@',
      title: 'bare loaded (1.0 GB in VRAM, context 0)',
      data: { expires_at: null, size_vram: 0 }
    })
    expect(gigabytes(undefined)).toBe('0.0 GB')
    expect(isoOf('not a time')).toBeUndefined()
    expect(runningToItem({ name: 'x', expires_at: 'soon' }).updatedAt).toBeUndefined()
  })
})
