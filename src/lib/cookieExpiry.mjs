/**
 * Read the expiry of the `__client` JWT from a Cookie header string.
 * Returns an ISO date string, or null. Never returns any part of the cookie.
 */
export function cookieExpiry(cookieHeader) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;
  const pair = cookieHeader
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith('__client='));
  if (!pair) return null;
  const jwt = pair.slice('__client='.length);
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
    const d = new Date(payload.exp * 1000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}
