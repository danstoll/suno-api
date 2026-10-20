/**
 * Map a thrown error to an HTTP status and JSON body. Pure, so it can be
 * tested without Next.js. Suno's own status is kept when it sent one.
 * @param {any} error
 * @returns {{ status: number, body: { error: string } }}
 */
export function mapError(error) {
  if (error?.response) {
    const { status, data, statusText } = error.response;
    if (status === 402) {
      return { status: 402, body: { error: data?.detail || 'Payment required' } };
    }
    return {
      status: status || 500,
      body: { error: 'API Error: ' + (data?.detail || statusText || 'Unknown error') }
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
