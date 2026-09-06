import { describe, expect, it } from 'vitest'
import { parseConnectionString, parseSslMode } from './connection-string'

const BASE = 'mysql://alice:pencil@db.example.com:3307/app'

describe('parseConnectionString', () => {
  it('reads every part the manual names, defaulting the port and TLS', () => {
    expect(parseConnectionString(BASE)).toEqual({
      user: 'alice',
      password: 'pencil',
      host: 'db.example.com',
      port: 3307,
      database: 'app',
      sslMode: 'disabled'
    })
    expect(parseConnectionString(' mysql://bob@localhost ')).toEqual({ user: 'bob', host: 'localhost', port: 3306, sslMode: 'disabled' })
  })

  it('percent-decodes the user, password and database, and unwraps an IPv6 host', () => {
    expect(parseConnectionString('mysql://al%40ice:p%2Fss%3Aw%40rd@[2001:db8::1]/my%20db')).toMatchObject({
      user: 'al@ice',
      password: 'p/ss:w@rd',
      host: '2001:db8::1',
      database: 'my db'
    })
    expect(() => parseConnectionString('mysql://alice:%E0%A4%A@h/db')).toThrow(/password has a malformed percent-encoding/)
  })

  it('refuses the X Protocol scheme, other schemes, a missing user and a missing host', () => {
    expect(() => parseConnectionString('mysqlx://alice@host/db')).toThrow(/X Protocol/)
    expect(() => parseConnectionString('postgres://alice@host/db')).toThrow(/starting with mysql:\/\//)
    expect(() => parseConnectionString('mock-connectionString')).toThrow(/starting with mysql:\/\//)
    expect(() => parseConnectionString('mysql://host/db')).toThrow(/user name is required/)
    expect(() => parseConnectionString('mysql://alice@/db')).toThrow(/host is required|not a valid URL/)
    expect(() => parseConnectionString('mysql://alice@(/tmp/mysql.sock)/db')).toThrow(/socket path/)
  })

  it('maps ssl-mode from the URL onto the three settings, and reads ssl-ca', () => {
    expect(parseConnectionString(`${BASE}?ssl-mode=DISABLED`).sslMode).toBe('disabled')
    expect(parseConnectionString(`${BASE}?ssl-mode=preferred`).sslMode).toBe('required')
    expect(parseConnectionString(`${BASE}?ssl-mode=REQUIRED`).sslMode).toBe('required')
    expect(parseConnectionString(`${BASE}?ssl-mode=VERIFY_CA`).sslMode).toBe('verify-full')
    expect(parseConnectionString(`${BASE}?ssl-mode=VERIFY_IDENTITY&ssl-ca=(/etc/ca.pem)`)).toMatchObject({
      sslMode: 'verify-full',
      sslCa: '/etc/ca.pem'
    })
    expect(parseConnectionString(`${BASE}?ssl-ca=/etc/ca.pem&other=1`).sslCa).toBe('/etc/ca.pem')
    expect(() => parseConnectionString(`${BASE}?ssl-mode=maybe`)).toThrow(/ssl-mode "maybe" is not one of/)
  })

  it('lets the ssl and sslCa settings win over the URL', () => {
    expect(parseConnectionString(`${BASE}?ssl-mode=REQUIRED&ssl-ca=/url.pem`, { ssl: 'verify-full', sslCa: '/set.pem' })).toMatchObject({
      sslMode: 'verify-full',
      sslCa: '/set.pem'
    })
    expect(parseConnectionString(BASE, { ssl: ' ', sslCa: '' }).sslMode).toBe('disabled')
    expect(() => parseConnectionString(BASE, { ssl: 'prefer' })).toThrow(/ssl must be one of disabled, required, verify-full, not "prefer"/)
  })
})

describe('parseSslMode', () => {
  it('treats blank as unset and passes a known value through', () => {
    expect(parseSslMode(undefined)).toBeUndefined()
    expect(parseSslMode('required')).toBe('required')
  })
})
