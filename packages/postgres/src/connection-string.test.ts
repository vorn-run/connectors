import { describe, expect, it } from 'vitest'
import { DEFAULT_APPLICATION_NAME, parseConnectionString } from './connection-string'

describe('parseConnectionString', () => {
  it('reads every part of a full URI', () => {
    expect(
      parseConnectionString(
        'postgres://alice:s3cret@db.example.com:6543/app?sslmode=verify-full&sslrootcert=/etc/ca.pem&connect_timeout=3&application_name=my-app'
      )
    ).toEqual({
      user: 'alice',
      password: 's3cret',
      host: 'db.example.com',
      port: 6543,
      database: 'app',
      sslMode: 'verify-full',
      sslRootCert: '/etc/ca.pem',
      connectTimeoutS: 3,
      applicationName: 'my-app'
    })
  })

  it('applies the defaults the manual gives', () => {
    expect(parseConnectionString('postgresql://bob@localhost')).toEqual({
      user: 'bob',
      host: 'localhost',
      port: 5432,
      database: 'bob',
      sslMode: 'prefer',
      connectTimeoutS: 10,
      applicationName: DEFAULT_APPLICATION_NAME
    })
  })

  it('treats an empty port, an empty path and empty parameters as absent', () => {
    const parsed = parseConnectionString(' postgres://bob@host:/?&connect_timeout=&application_name= ')
    expect(parsed.port).toBe(5432)
    expect(parsed.database).toBe('bob')
    expect(parsed.connectTimeoutS).toBe(10)
    expect(parsed.applicationName).toBe(DEFAULT_APPLICATION_NAME)
  })

  it('percent-decodes the user, password, database and parameters', () => {
    const parsed = parseConnectionString('postgres://a%40b:p%40ss%2Fword@host/my%20db?application_name=a%26b&flag')
    expect(parsed.user).toBe('a@b')
    expect(parsed.password).toBe('p@ss/word')
    expect(parsed.database).toBe('my db')
    expect(parsed.applicationName).toBe('a&b')
  })

  it('reads a bracketed IPv6 host', () => {
    const parsed = parseConnectionString('postgres://u@[2001:db8::1]:5433/db')
    expect(parsed.host).toBe('2001:db8::1')
    expect(parsed.port).toBe(5433)
    const bare = parseConnectionString('postgres://u@[::1]/db')
    expect(bare.host).toBe('::1')
    expect(bare.port).toBe(5432)
  })

  it('refuses anything that is not a libpq URI', () => {
    expect(() => parseConnectionString('mysql://u@h/db')).toThrow(/postgres:\/\/ or postgresql:\/\//)
    expect(() => parseConnectionString('mock-connectionString')).toThrow(/libpq URI/)
  })

  it('requires a user and a host', () => {
    expect(() => parseConnectionString('postgres://host/db')).toThrow(/user name is required/)
    expect(() => parseConnectionString('postgres://u:p@/db')).toThrow(/host is required/)
  })

  it('rejects several hosts rather than half-supporting them', () => {
    expect(() => parseConnectionString('postgres://u@h1:5432,h2:5433/db')).toThrow(/several hosts/)
  })

  it('names a bad port, a bad bracket, or junk after the host', () => {
    expect(() => parseConnectionString('postgres://u@h:abc/db')).toThrow(/port "abc"/)
    expect(() => parseConnectionString('postgres://u@[::1/db')).toThrow(/closing bracket/)
    expect(() => parseConnectionString('postgres://u@[::1]x/db')).toThrow(/unexpected "x"/)
  })

  it('names a bad sslmode or connect_timeout', () => {
    expect(() => parseConnectionString('postgres://u@h/db?sslmode=maybe')).toThrow(/sslmode "maybe"/)
    expect(() => parseConnectionString('postgres://u@h/db?connect_timeout=soon')).toThrow(/connect_timeout "soon"/)
  })

  it('names a malformed percent-encoding', () => {
    expect(() => parseConnectionString('postgres://u:%zz@h/db')).toThrow(/password has a malformed/)
    expect(() => parseConnectionString('postgres://u@h/db?x=%zz')).toThrow(/parameter list/)
  })

  it('allows connect_timeout=0, which means no timeout', () => {
    expect(parseConnectionString('postgres://u@h/db?connect_timeout=0').connectTimeoutS).toBe(0)
  })
})
