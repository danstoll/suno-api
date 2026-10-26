'use client';

import { useEffect, useState } from 'react';

/**
 * Live status page for the local API.
 *
 * Generations take minutes and a captcha can silently block the lot, so
 * "is it stuck or just slow?" is the question that comes up constantly.
 * This answers it without tailing server logs.
 */

interface ActivityEvent {
  id: number;
  at: number;
  kind: string;
  label: string;
  status: 'pending' | 'ok' | 'error' | 'info';
  ms?: number;
  detail?: string;
}

// Full class names, so Tailwind can see them. Colours come from the
// --color-status-* tokens in globals.css.
const STATUS_TEXT: Record<ActivityEvent['status'], string> = {
  pending: 'text-status-pending',
  ok: 'text-status-ok',
  error: 'text-status-error',
  info: 'text-status-info'
};

export default function StatusPage() {
  const [now, setNow] = useState(0);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [inFlight, setInFlight] = useState(0);
  const [credits, setCredits] = useState<string>('…');
  const [captcha, setCaptcha] = useState<string>('…');
  const [cookieExp, setCookieExp] = useState<{ text: string; level: 'ok' | 'warn' | 'error' }>({ text: '…', level: 'ok' });
  const [err, setErr] = useState<string>('');
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    let alive = true;

    const tick = async () => {
      try {
        const r = await fetch('/api/activity?limit=120', { cache: 'no-store' });
        const j = await r.json();
        if (!alive) return;
        setEvents(j.events ?? []);
        setNow(Date.now());
        setInFlight(j.inFlight ?? 0);
        setErr('');
      } catch (e: any) {
        if (alive) setErr(e?.message ?? 'activity feed unreachable');
      }
    };

    // Credits and captcha state are slower-moving; poll them less often so a
    // status page never becomes the thing that trips the rate limit.
    const slowTick = async () => {
      try {
        const r = await fetch('/api/cookie_status', { cache: 'no-store' });
        const j = await r.json();
        if (alive) setCookieExp(describeExpiry(j?.expires_at, Date.now()));
      } catch { /* leave previous value */ }
      try {
        const r = await fetch('/api/get_limit', { cache: 'no-store' });
        const j = await r.json();
        if (alive && j?.credits_left !== undefined) {
          setCredits(`${j.credits_left} / ${j.monthly_limit}`);
        }
      } catch { /* leave previous value */ }
      try {
        const r = await fetch('/api/raw', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: '/api/c/check', method: 'POST', body: { ctype: 'generation' } })
        });
        const j = await r.json();
        if (alive) setCaptcha(j?.data?.required ? 'CHALLENGING' : 'clear');
      } catch { /* leave previous value */ }
    };

    // Poll only while the tab is visible. A hidden tab makes no requests;
    // becoming visible again polls once straight away, then resumes the timers.
    let fast: ReturnType<typeof setInterval> | undefined;
    let slow: ReturnType<typeof setInterval> | undefined;
    const stop = () => { clearInterval(fast); clearInterval(slow); fast = slow = undefined; };
    const start = () => {
      if (fast !== undefined) return;
      tick();
      slowTick();
      fast = setInterval(tick, 2000);
      slow = setInterval(slowTick, 30000);
    };
    const onVisibility = () => (document.hidden ? stop() : start());

    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden) start();
    return () => {
      alive = false;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [paused]);

  const ago = (t: number) => {
    const s = Math.round((now - t) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
    return `${Math.floor(s / 3600)}h ago`;
  };

  return (
    <main className="font-[ui-monospace,SFMono-Regular,Menlo,monospace] p-6 max-w-[1100px] mx-auto">
      <h1 className="text-xl mb-3">suno-api · status</h1>

      <div className="flex gap-6 flex-wrap px-4 py-3 border border-foreground/25 rounded-lg mb-4">
        <Stat label="in flight" value={String(inFlight)} highlight={inFlight > 0} />
        <Stat label="captcha" value={captcha} highlight={captcha === 'CHALLENGING'} />
        <Stat label="credits" value={credits} />
        <Stat label="cookie expires" value={cookieExp.text} colour={cookieExp.level === 'ok' ? undefined : STATUS_TEXT[cookieExp.level === 'warn' ? 'pending' : 'error']} />
        <button type="button" onClick={() => setPaused((p) => !p)} aria-label={paused ? 'Resume live updates' : 'Pause live updates'} className="ml-auto cursor-pointer">
          {paused ? 'resume' : 'pause'}
        </button>
        <button
          type="button"
          aria-label="Clear activity log"
          onClick={async () => {
            if (!window.confirm('Clear the whole activity log? This cannot be undone.')) return;
            try {
              const r = await fetch('/api/activity', { method: 'DELETE' });
              if (!r.ok) throw new Error(`clear failed (${r.status})`);
              setEvents([]);
            } catch (e: any) {
              setErr(e?.message ?? 'clear failed');
            }
          }}
          className="cursor-pointer"
        >clear</button>
      </div>

      {err && <p className={STATUS_TEXT.error}>⚠ {err} — is the dev server running?</p>}

      <table className="w-full border-collapse text-[0.82rem]">
        <caption className="sr-only">
          Recent API activity, newest first
        </caption>
        <thead>
          <tr className="text-left border-b border-foreground/40">
            <th scope="col" className="px-2 py-[0.35rem] w-[90px]">when</th>
            <th scope="col" className="px-2 py-[0.35rem] w-20">kind</th>
            <th scope="col" className="px-2 py-[0.35rem]">what</th>
            <th scope="col" className="px-2 py-[0.35rem] w-20">status</th>
            <th scope="col" className="px-2 py-[0.35rem] w-[70px]">took</th>
          </tr>
        </thead>
        <tbody>
          {events.length === 0 && (
            <tr><td colSpan={5} className="px-2 py-4 opacity-60">
              No activity yet. Start a generation and it will appear here.
            </td></tr>
          )}
          {events.map((e) => (
            <tr key={e.id} className="border-b border-foreground/20">
              <td className="px-2 py-[0.3rem] opacity-70">{ago(e.at)}</td>
              <td className="px-2 py-[0.3rem] opacity-80">{e.kind}</td>
              <td className="px-2 py-[0.3rem]">
                {e.label}
                {e.detail && <div className="opacity-60 text-xs">{e.detail}</div>}
              </td>
              <td className={`px-2 py-[0.3rem] font-semibold ${STATUS_TEXT[e.status]}`}>
                {e.status === 'pending' ? '● running' : e.status}
              </td>
              <td className="px-2 py-[0.3rem] opacity-70">
                {e.ms !== undefined ? `${(e.ms / 1000).toFixed(1)}s` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

/** Expiry text and severity: warn at 7 days or less, error when expired or unknown. */
function describeExpiry(iso: unknown, nowMs: number): { text: string; level: 'ok' | 'warn' | 'error' } {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return { text: 'unknown', level: 'error' };
  const date = new Date(t).toISOString().slice(0, 10);
  const days = Math.floor((t - nowMs) / 86400000);
  if (t <= nowMs) return { text: `${date} · expired`, level: 'error' };
  return { text: `${date} · ${days}d left`, level: days <= 7 ? 'warn' : 'ok' };
}

function Stat({ label, value, highlight, colour }: { label: string; value: string; highlight?: boolean; colour?: string }) {
  return (
    <div>
      <div className="text-[0.7rem] opacity-60 uppercase">{label}</div>
      <div className={`text-[1.1rem] font-semibold ${colour ?? (highlight ? STATUS_TEXT.pending : '')}`}>{value}</div>
    </div>
  );
}
