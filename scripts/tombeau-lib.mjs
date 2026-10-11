// Shared helpers for the Tombeau cover-art run.
// All Suno traffic goes through the local fork's authenticated passthrough
// (/api/raw), so no cookie or bearer is ever handled here directly.
const BASE = process.env.SUNO_LOCAL || 'http://localhost:3060';

export async function rawGet(path) {
  const r = await fetch(`${BASE}/api/raw?path=${encodeURIComponent(path)}`);
  const j = await r.json();
  return j;
}

export async function rawCall(path, method, body) {
  const r = await fetch(`${BASE}/api/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, method, body })
  });
  return await r.json();
}

export { BASE };
