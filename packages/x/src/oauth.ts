import { createHmac, randomBytes } from 'node:crypto'

/** RFC 3986 percent-encoding as the signing guide requires: only unreserved bytes stay bare, `%XX` is uppercase. */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

export interface OAuthCredentials {
  consumerKey: string
  consumerSecret: string
  token: string
  tokenSecret: string
}

export interface SignedRequestInput {
  method: string
  /** The full URL; its query string is signed and then left in place. */
  url: string
  /** Body parameters, only for an `application/x-www-form-urlencoded` body; a JSON body is never signed. */
  bodyParams?: Record<string, string>
  nonce?: string
  /** Unix seconds. */
  timestamp?: number
}

export interface SignedRequest {
  /** The `Authorization` header value. */
  header: string
  baseString: string
  signature: string
}

function oauthParams(credentials: OAuthCredentials, nonce: string, timestamp: number): Record<string, string> {
  return {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp),
    oauth_token: credentials.token,
    oauth_version: '1.0'
  }
}

/** 32 random bytes as base64 with the non-word characters stripped, as the guide describes. */
export function makeNonce(random: (size: number) => Buffer = randomBytes): string {
  return random(32).toString('base64').replace(/\W/g, '')
}

/** The parameter string: every key and value encoded, sorted by encoded key, joined as `k=v` with `&`. */
export function parameterString(params: Array<[string, string]>): string {
  return params
    .map(([key, value]) => [percentEncode(key), percentEncode(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
}

/** `METHOD&encode(base URL)&encode(parameter string)`: the string the HMAC covers. */
export function signatureBaseString(method: string, url: URL, params: Array<[string, string]>): string {
  const baseUrl = `${url.origin}${url.pathname}`
  return `${method.toUpperCase()}&${percentEncode(baseUrl)}&${percentEncode(parameterString(params))}`
}

export function sign(credentials: OAuthCredentials, input: SignedRequestInput): SignedRequest {
  const url = new URL(input.url)
  const nonce = input.nonce ?? makeNonce()
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000)
  const oauth = oauthParams(credentials, nonce, timestamp)
  const params: Array<[string, string]> = [
    ...Array.from(url.searchParams.entries()),
    ...Object.entries(input.bodyParams ?? {}),
    ...Object.entries(oauth)
  ]
  const baseString = signatureBaseString(input.method, url, params)
  const signingKey = `${percentEncode(credentials.consumerSecret)}&${percentEncode(credentials.tokenSecret)}`
  const signature = createHmac('sha1', signingKey).update(baseString).digest('base64')
  const header =
    'OAuth ' +
    Object.entries({ ...oauth, oauth_signature: signature })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`)
      .join(', ')
  return { header, baseString, signature }
}
