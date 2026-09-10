import { describe, expect, it } from 'vitest'
import { makeNonce, parameterString, percentEncode, sign, signatureBaseString } from './oauth'

// The signing guide's worked request with stand-ins of the same shape for its four credentials.
const CREDENTIALS = {
  consumerKey: 'consumer-key',
  consumerSecret: 'consumer-secret',
  token: '123-token',
  tokenSecret: 'token-secret'
}
const NONCE = 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg'
const TIMESTAMP = 1318622958
const EXAMPLE = {
  method: 'POST',
  url: 'https://api.x.com/1.1/statuses/update.json?include_entities=true',
  bodyParams: { status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
  nonce: NONCE,
  timestamp: TIMESTAMP
}
const EXPECTED_BASE =
  'POST&https%3A%2F%2Fapi.x.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dconsumer-key%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D123-token%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521'

describe('percentEncode', () => {
  it('matches the four examples of the percent-encoding guide', () => {
    expect(percentEncode('Ladies + Gentlemen')).toBe('Ladies%20%2B%20Gentlemen')
    expect(percentEncode('An encoded string!')).toBe('An%20encoded%20string%21')
    expect(percentEncode('Dogs, Cats & Mice')).toBe('Dogs%2C%20Cats%20%26%20Mice')
    expect(percentEncode('☃')).toBe('%E2%98%83')
  })

  it('leaves the unreserved characters alone and encodes the rest that encodeURIComponent keeps', () => {
    expect(percentEncode('AZaz09-._~')).toBe('AZaz09-._~')
    expect(percentEncode("!'()*")).toBe('%21%27%28%29%2A')
  })
})

describe('sign', () => {
  it('reproduces the worked example with the stand-in credentials', () => {
    const signed = sign(CREDENTIALS, EXAMPLE)
    expect(signed.baseString).toBe(EXPECTED_BASE)
    expect(signed.signature).toBe('ZaqfaIjE/MHLy6NXQlBB5Kk/bD8=')
    expect(signed.header).toContain('oauth_signature="ZaqfaIjE%2FMHLy6NXQlBB5Kk%2FbD8%3D"')
  })

  it('lays the header out as the authorizing guide shows', () => {
    const { header } = sign(CREDENTIALS, EXAMPLE)
    expect(header.startsWith('OAuth oauth_consumer_key="consumer-key", oauth_nonce=')).toBe(true)
    const keys = header
      .slice('OAuth '.length)
      .split(', ')
      .map((pair) => pair.split('=')[0])
    expect(keys).toEqual([
      'oauth_consumer_key',
      'oauth_nonce',
      'oauth_signature',
      'oauth_signature_method',
      'oauth_timestamp',
      'oauth_token',
      'oauth_version'
    ])
  })

  it('signs the query of a GET and none of a JSON body', () => {
    const get = sign(CREDENTIALS, {
      method: 'GET',
      url: 'https://api.x.com/2/tweets/20?tweet.fields=created_at,author_id',
      nonce: NONCE,
      timestamp: TIMESTAMP
    })
    expect(get.baseString.startsWith('GET&https%3A%2F%2Fapi.x.com%2F2%2Ftweets%2F20&')).toBe(true)
    expect(get.baseString).toContain('tweet.fields%3Dcreated_at%252Cauthor_id')

    const post = sign(CREDENTIALS, {
      method: 'POST',
      url: 'https://api.x.com/2/tweets',
      nonce: NONCE,
      timestamp: TIMESTAMP
    })
    expect(post.baseString).toBe(
      'POST&https%3A%2F%2Fapi.x.com%2F2%2Ftweets&' +
        percentEncode(
          `oauth_consumer_key=consumer-key&oauth_nonce=${NONCE}&oauth_signature_method=HMAC-SHA1&oauth_timestamp=${TIMESTAMP}&oauth_token=123-token&oauth_version=1.0`
        )
    )
  })

  it('mints a nonce and a timestamp when none are given', () => {
    const before = Math.floor(Date.now() / 1000)
    const { header } = sign(CREDENTIALS, { method: 'GET', url: 'https://api.x.com/2/users/me' })
    const nonce = /oauth_nonce="([^"]+)"/.exec(header)?.[1] ?? ''
    const timestamp = Number(/oauth_timestamp="(\d+)"/.exec(header)?.[1])
    expect(nonce).toMatch(/^\w{20,}$/)
    expect(timestamp).toBeGreaterThanOrEqual(before)
  })
})

describe('the building blocks', () => {
  it('sorts the parameter string by encoded key', () => {
    expect(parameterString([['b', '2'], ['a', '1'], ['a b', 'x&y']])).toBe('a=1&a%20b=x%26y&b=2')
  })

  it('drops the query from the base URL', () => {
    const base = signatureBaseString('get', new URL('https://api.x.com/2/users/me?x=1'), [['x', '1']])
    expect(base).toBe('GET&https%3A%2F%2Fapi.x.com%2F2%2Fusers%2Fme&x%3D1')
  })

  it('strips non-word characters from the nonce', () => {
    expect(makeNonce(() => Buffer.from([251, 255, 62, 63, 0]))).toMatch(/^\w+$/)
  })
})
