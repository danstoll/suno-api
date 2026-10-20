/**
 * Map a thrown error to an HTTP status and JSON body. Pure, so it can be
 * tested without Next.js. Suno's own status is kept when it sent one.
 * @param {any} error
 * @returns {{ status: number, body: { error: string } }}
 */
const asText = (v) => (typeof v === 'string' ? v : v == null ? undefined : JSON.stringify(v));

export function mapError(error) {
  if (error?.response) {
    const { status: raw, data, statusText } = error.response;
    const detail = asText(data?.detail);
    const status = raw >= 400 && raw <= 599 ? raw : 500;
    if (raw === 402) {
      return { status: 402, body: { error: detail || 'Payment required' } };
    }
    return {
      status,
      body: { error: 'API Error: ' + (detail || statusText || 'Unknown error') }
    };
  }
  if (error?.request) {
    return {
      status: 503,
      body: { error: 'Network error: Unable to connect to Suno API. Please check your internet connection and try again.' }
    };
  }
  return {
    status: 500,
    body: { error: 'Internal error: ' + (error?.message || 'Unknown error occurred') }
  };
}
