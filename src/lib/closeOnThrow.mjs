/**
 * Run an async setup step; if it throws, call close() first, then rethrow.
 * Used so a browser that was launched is never left running when the code
 * after the launch fails. A close() that throws or rejects never hides the
 * original error. Pure: no I/O of its own.
 */
export async function closeOnThrow(close, setup) {
  try {
    return await setup();
  } catch (e) {
    try { await close(); } catch { /* already gone */ }
    throw e;
  }
}
