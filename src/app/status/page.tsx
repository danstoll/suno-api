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

const COLOURS: Record<string, string> = {
  pending: '#d98d0b',
  ok: '#1a9e4b',
  error: '#d02f2f',
  info: '#5b6472'
};

export default function StatusPage() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [inFlight, setInFlight] = useState(0);
  const [credits, setCredits] = useState<string>('…');
  const [captcha, setCaptcha] = useState<string>('…');
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

    tick();
    slowTick();
    const fast = setInterval(tick, 2000);
    const slow = setInterval(slowTick, 30000);
    return () => { alive = false; clearInterval(fast); clearInterval(slow); };
  }, [paused]);

  const ago = (t: number) => {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
    return `${Math.floor(s / 3600)}h ago`;
  };

  return (
    <main style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', padding: '1.5rem', maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>suno-api · status</h1>

      <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', padding: '0.75rem 1rem', border: '1px solid #8884', borderRadius: 8, marginBottom: '1rem' }}>
        <Stat label="in flight" value={String(inFlight)} highlight={inFlight > 0} />
        <Stat label="captcha" value={captcha} highlight={captcha === 'CHALLENGING'} />
        <Stat label="credits" value={credits} />
        <button onClick={() => setPaused((p) => !p)} style={{ marginLeft: 'auto', cursor: 'pointer' }}>
          {paused ? 'resume' : 'pause'}
        </button>
        <button
          onClick={async () => { await fetch('/api/activity', { method: 'DELETE' }); setEvents([]); }}
          style={{ cursor: 'pointer' }}
        >clear</button>
      </div>

      {err && <p style={{ color: COLOURS.error }}>⚠ {err} — is the dev server running?</p>}

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid #8886' }}>
            <th style={{ padding: '0.35rem 0.5rem', width: 90 }}>when</th>
            <th style={{ padding: '0.35rem 0.5rem', width: 80 }}>kind</th>
            <th style={{ padding: '0.35rem 0.5rem' }}>what</th>
            <th style={{ padding: '0.35rem 0.5rem', width: 80 }}>status</th>
            <th style={{ padding: '0.35rem 0.5rem', width: 70 }}>took</th>
          </tr>
        </thead>
        <tbody>
          {events.length === 0 && (
            <tr><td colSpan={5} style={{ padding: '1rem 0.5rem', opacity: 0.6 }}>
              No activity yet. Start a generation and it will appear here.
            </td></tr>
          )}
          {events.map((e) => (
            <tr key={e.id} style={{ borderBottom: '1px solid #8883' }}>
              <td style={{ padding: '0.3rem 0.5rem', opacity: 0.7 }}>{ago(e.at)}</td>
              <td style={{ padding: '0.3rem 0.5rem', opacity: 0.8 }}>{e.kind}</td>
              <td style={{ padding: '0.3rem 0.5rem' }}>
                {e.label}
                {e.detail && <div style={{ opacity: 0.6, fontSize: '0.75rem' }}>{e.detail}</div>}
              </td>
              <td style={{ padding: '0.3rem 0.5rem', color: COLOURS[e.status], fontWeight: 600 }}>
                {e.status === 'pending' ? '● running' : e.status}
              </td>
              <td style={{ padding: '0.3rem 0.5rem', opacity: 0.7 }}>
                {e.ms !== undefined ? `${(e.ms / 1000).toFixed(1)}s` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: '0.7rem', opacity: 0.6, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: '1.1rem', fontWeight: 600, color: highlight ? COLOURS.pending : undefined }}>{value}</div>
    </div>
  );
}
