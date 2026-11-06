import { describe, expect, it } from 'vitest'
import { sanitizeNotificationUrl } from './sw-url-utils'

const ORIGIN = 'http://localhost:3000'
const HTTPS_ORIGIN = 'https://myserver.example.com'

describe('sanitizeNotificationUrl', () => {
  it('returns same-origin relative path unchanged', () => {
    expect(sanitizeNotificationUrl('/sessions/abc', ORIGIN)).toBe('/sessions/abc')
  })

  it('returns root path for root URL', () => {
    expect(sanitizeNotificationUrl('/', ORIGIN)).toBe('/')
  })

  it('returns path with query and hash', () => {
    expect(sanitizeNotificationUrl('/settings?tab=notifications#push', ORIGIN)).toBe(
      '/settings?tab=notifications#push',
    )
  })

  it('returns same-origin absolute URL as relative path', () => {
    expect(sanitizeNotificationUrl(`${ORIGIN}/sessions/abc`, ORIGIN)).toBe('/sessions/abc')
  })

  it('rejects cross-origin URL', () => {
    expect(sanitizeNotificationUrl('https://evil.example.com/steal', ORIGIN)).toBe('/')
  })

  it('rejects javascript: scheme', () => {
    expect(sanitizeNotificationUrl('javascript:alert(1)', ORIGIN)).toBe('/')
  })

  it('rejects file: scheme', () => {
    expect(sanitizeNotificationUrl('file:///etc/passwd', ORIGIN)).toBe('/')
  })

  it('rejects data: scheme', () => {
    expect(sanitizeNotificationUrl('data:text/html,<script>alert(1)</script>', ORIGIN)).toBe('/')
  })

  it('rejects intent: scheme (Android)', () => {
    expect(sanitizeNotificationUrl('intent://example.com#Intent;scheme=https;end', ORIGIN)).toBe('/')
  })

  it('rejects protocol-relative URL (// prefix)', () => {
    expect(sanitizeNotificationUrl('//evil.example.com/path', ORIGIN)).toBe('/')
  })

  it('returns / for non-string input', () => {
    expect(sanitizeNotificationUrl(42, ORIGIN)).toBe('/')
    expect(sanitizeNotificationUrl(null, ORIGIN)).toBe('/')
    expect(sanitizeNotificationUrl(undefined, ORIGIN)).toBe('/')
    expect(sanitizeNotificationUrl({}, ORIGIN)).toBe('/')
  })

  it('returns / for empty string', () => {
    expect(sanitizeNotificationUrl('', ORIGIN)).toBe('/')
  })

  it('returns / for unparseable URL', () => {
    expect(sanitizeNotificationUrl('http://[invalid', ORIGIN)).toBe('/')
  })

  it('handles HTTPS origin', () => {
    expect(sanitizeNotificationUrl('/sessions/xyz', HTTPS_ORIGIN)).toBe('/sessions/xyz')
    expect(
      sanitizeNotificationUrl('https://myserver.example.com/sessions/xyz', HTTPS_ORIGIN),
    ).toBe('/sessions/xyz')
    expect(sanitizeNotificationUrl('https://other.com/path', HTTPS_ORIGIN)).toBe('/')
  })
})
