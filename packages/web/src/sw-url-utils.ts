/**
 * URL sanitization utilities for service worker navigation.
 *
 * Push notification data is untrusted input. Before navigating the client
 * (via NAVIGATE postMessage or openWindow), URLs must be validated to
 * prevent navigation injection attacks.
 *
 * These are pure functions with no service worker dependencies,
 * so they can be tested in Node without mocking SW globals.
 */

/**
 * Sanitize a URL from push notification data.
 *
 * Only same-origin relative paths are accepted. Absolute URLs must
 * match the provided origin. All other inputs fall back to `/`.
 *
 * @param raw - The raw URL from notification data (untrusted)
 * @param origin - The expected origin (e.g. 'https://myserver.example.com')
 * @returns A safe relative path (always starts with `/`)
 */
export function sanitizeNotificationUrl(raw: unknown, origin: string): string {
  // Reject non-string input immediately
  if (typeof raw !== 'string') return '/';

  const trimmed = raw.trim();

  // Reject empty strings
  if (trimmed === '') return '/';

  // Reject protocol-relative URLs (// prefix)
  if (trimmed.startsWith('//')) return '/';

  // Reject dangerous schemes
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('file:') ||
    lower.startsWith('data:') ||
    lower.startsWith('intent:') ||
    lower.startsWith('vbscript:')
  ) {
    return '/';
  }

  // Already a relative path starting with /
  if (trimmed.startsWith('/')) {
    // Validate it can be parsed as a URL relative to origin
    try {
      new URL(trimmed, origin);
      return trimmed;
    } catch {
      return '/';
    }
  }

  // Absolute URL — must be same-origin
  try {
    const parsed = new URL(trimmed);
    if (parsed.origin === origin) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
    // Cross-origin — reject
    return '/';
  } catch {
    // Unparseable — reject
    return '/';
  }
}
