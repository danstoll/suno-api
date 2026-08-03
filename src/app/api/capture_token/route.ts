import { NextResponse, NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { sunoApi } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';

/**
 * Capture Suno's verification token on its own, away from any render.
 *
 * Suno moved verification into a `browser-token` header, and the only way to
 * obtain one is to intercept a real generate request from a signed-in browser.
 * That capture used to happen inside a render, which meant a browser window
 * appeared partway through and a human had to notice it right then. Miss the
 * moment and the render sat until the client gave up — three runs died exactly
 * that way, each burning 25 minutes and reporting nothing more useful than a
 * curl timeout.
 *
 * Called here, the browser opens with no render waiting on it. Do the
 * generation whenever, and the token is held on the cached SunoApi instance so
 * every later call is unattended.
 *
 *   GET  → is a token currently held?
 *   POST → open a browser and wait for one
 *
 * The token never travels through the response body; it stays server-side.
 */
/**
 * This route waits on a person, so it must not carry the usual short cap.
 * 60s was copied in from the other routes and would have killed the capture a
 * minute in — dev mode ignores it, which is exactly how a bug like that
 * survives to bite somewhere else.
 */
export const maxDuration = 3600;
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const api = await sunoApi((await cookies()).toString());
    return json({ held: api.hasBrowserToken() });
  } catch (error: any) {
    return json({ error: error?.message ?? String(error) }, 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const api = await sunoApi((await cookies()).toString());
    if (api.hasBrowserToken()) return json({ held: true, captured: true, note: 'already held' });
    const result = await api.captureBrowserToken();
    return json({ held: result.captured, ...result });
  } catch (error: any) {
    return json({ error: error?.message ?? String(error) }, 500);
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}

function json(body: unknown, status = 200) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}
