/**
 * In-memory activity log so a human can watch what this API is doing.
 *
 * Everything interesting here happens over minutes — a generation is submitted,
 * polled, extended, concatenated, and a captcha may block the lot. Without a
 * view of that you are reduced to tailing server logs to answer "is it stuck?",
 * which is exactly the question that keeps coming up.
 *
 * Deliberately in-memory and bounded: this is a live view, not an audit trail,
 * and it must never grow without limit in a long-running dev server.
 */

export type ActivityStatus = 'pending' | 'ok' | 'error' | 'info';

export interface ActivityEvent {
  id: number;
  at: number;
  /** Grouping label, e.g. 'api', 'captcha', 'suno'. */
  kind: string;
  /** What happened, e.g. 'POST /api/custom_generate'. */
  label: string;
  status: ActivityStatus;
  /** Milliseconds, once known. */
  ms?: number;
  /** Short human detail — never a credential, never a full lyric sheet. */
  detail?: string;
}

const MAX_EVENTS = 300;

// Survives Next.js hot reloads, which otherwise reset module state on every
// edit and would blank the view mid-run.
const globalForActivity = global as unknown as {
  __sunoActivity?: { events: ActivityEvent[]; seq: number };
};
const store = globalForActivity.__sunoActivity ?? { events: [], seq: 0 };
globalForActivity.__sunoActivity = store;

/** Record an event. Returns its id so it can be settled later. */
export function record(
  kind: string,
  label: string,
  status: ActivityStatus = 'info',
  detail?: string
): number {
  const id = ++store.seq;
  store.events.push({ id, at: Date.now(), kind, label, status, detail: trim(detail) });
  if (store.events.length > MAX_EVENTS) store.events.splice(0, store.events.length - MAX_EVENTS);
  return id;
}

/** Update an event started earlier — typically pending -> ok/error. */
export function settle(id: number, status: ActivityStatus, detail?: string): void {
  const ev = store.events.find((e) => e.id === id);
  if (!ev) return;
  ev.status = status;
  ev.ms = Date.now() - ev.at;
  if (detail !== undefined) ev.detail = trim(detail);
}

/** Newest first, optionally limited. */
export function list(limit = MAX_EVENTS): ActivityEvent[] {
  return store.events.slice(-limit).reverse();
}

export function clear(): void {
  store.events.length = 0;
}

/**
 * Keep details short and free of secrets. Bodies here can contain a whole lyric
 * sheet or a bearer token, neither of which belongs on a status page.
 */
function trim(s?: string): string | undefined {
  if (s === undefined || s === null) return undefined;
  let out = String(s);
  out = out.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<jwt>');
  out = out.replace(/[A-Za-z0-9]{32,}/g, (m) => `<${m.length}-char token>`);
  return out.length > 160 ? out.slice(0, 160) + '…' : out;
}
