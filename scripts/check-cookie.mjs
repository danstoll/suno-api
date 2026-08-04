/**
 * Validate a SUNO_COOKIE end to end, without ever printing it.
 *
 *   node scripts/check-cookie.mjs              # check the one in .env
 *   node scripts/check-cookie.mjs path/to/file # check a candidate first
 *
 * Reproduces exactly what SunoApi does on boot — getAuthToken, then keepAlive,
 * then a real billing call — so a GOOD verdict means the app will start, not
 * merely that the string looks cookie-shaped. Exists because two rounds of a
 * real rotation were lost to guessing which entries mattered: the answer is
 * `__client` and nothing else, and this proves it in about a second.
 *
 * Exit 0 = usable, exit 1 = would fail at startup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import * as cookie from 'cookie';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = process.argv[2];

let raw;
if (arg) {
  raw = fs.readFileSync(arg, 'utf8');
} else {
  const envPath = path.join(here, '..', '.env');
  const line = fs.readFileSync(envPath, 'utf8')
    .split(/\r?\n/).find((l) => /^\s*SUNO_COOKIE\s*=/.test(l));
  if (!line) { console.error('No SUNO_COOKIE line in .env'); process.exit(1); }
  raw = line.replace(/^\s*SUNO_COOKIE\s*=\s*/, '').replace(/^['"]|['"]$/g, '');
}
raw = raw.trim().replace(/\r?\n/g, '');

const cookies = cookie.parse(raw);
const CLERK = 'https://auth.suno.com';
const VERSION = '5.117.0';

console.log(`source            : ${arg ?? '.env'}`);
console.log(`cookie length     : ${raw.length}`);
console.log(`entries           : ${Object.keys(cookies).length}`);
console.log(`__client          : ${cookies.__client ? 'present' : 'ABSENT — cannot authenticate'}`);
console.log(`ajs_anonymous_id  : ${cookies.ajs_anonymous_id ? 'present (stable deviceId)' : 'absent (random deviceId each boot)'}`);

if (!cookies.__client) process.exit(1);

try {
  // `exp` is public JWT metadata, not a secret.
  const p = JSON.parse(Buffer.from(cookies.__client.split('.')[1], 'base64url').toString());
  console.log(`__client expires  : ${new Date(p.exp * 1000).toISOString()}`);
} catch { /* not fatal — the live check below is what counts */ }

const client = axios.create({
  withCredentials: true,
  headers: {
    'Affiliate-Id': 'undefined',
    'Device-Id': `"${cookies.ajs_anonymous_id ?? 'unknown'}"`,
    'x-suno-client': 'Android prerelease-4nt180t 1.0.42',
    'X-Requested-With': 'com.suno.android',
    'sec-ch-ua': '"Chromium";v="130", "Android WebView";v="130", "Not?A_Brand";v="99"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  }
});
// SunoApi rebuilds the whole jar into a Cookie header on every request; a bare
// Authorization header is NOT enough and gives a false negative.
client.interceptors.request.use((c) => {
  c.headers.Cookie = Object.entries(cookies).map(([k, v]) => cookie.serialize(k, v)).join('; ');
  return c;
});

try {
  const res = await client.get(
    `${CLERK}/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=${VERSION}`,
    { headers: { Authorization: cookies.__client } });
  const sid = res.data?.response?.last_active_session_id;
  console.log(`sessions          : ${(res.data?.response?.sessions ?? []).length}`);
  if (!sid) {
    console.log('VERDICT           : REJECTED — signed-out client, getAuthToken would throw');
    process.exit(1);
  }
  const renew = await client.post(
    `${CLERK}/v1/client/sessions/${sid}/tokens?__clerk_api_version=2025-11-10&_clerk_js_version=${VERSION}`,
    {}, { headers: { Authorization: cookies.__client } });
  if (!renew.data?.jwt) {
    console.log('VERDICT           : REJECTED — keepAlive could not mint a token');
    process.exit(1);
  }
  const billing = await client.get('https://studio-api.prod.suno.com/api/billing/info/', {
    headers: { Authorization: `Bearer ${renew.data.jwt}` } });
  console.log(`credits_left      : ${billing.data?.total_credits_left}`);
  console.log('VERDICT           : GOOD — authenticates end to end');
} catch (e) {
  console.log(`VERDICT           : REJECTED — ${e?.response?.status ?? ''} ${e?.message}`);
  process.exit(1);
}
