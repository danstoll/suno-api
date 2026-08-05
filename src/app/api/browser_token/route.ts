import { NextResponse, NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { sunoApi } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';

/**
 * Receive a verification token captured from the user's own browser.
 *
 * Suno's verification moved into a `browser-token` header. It can only be
 * lifted from a real generate request, and the automation's browser is the
 * wrong place to get one: that session is challenged harder, a real hCaptcha
 * appears, solving it does not land a token, and it reappears. The user's
 * normal signed-in tab meanwhile generates without being challenged at all.
 *
 * So `scripts/capture-browser-token.js` runs in that tab, lifts the header off
 * a generation the user makes anyway, and posts it here. The credential travels
 * browser -> localhost and never through a chat transcript.
 *
 *   GET  → is a token held?
 *   POST → { token, provider? }
 *
 * The token is never echoed back; the response reports only its length.
 */
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
    const body = await req.json().catch(() => ({}));
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!token) return json({ error: 'Need { token }.' }, 400);
    // A real one is a long opaque string. A short value means the snippet
    // grabbed the wrong header, and storing it would fail confusingly later.
    if (token.length < 40) return json({ error: `Token looks too short (${token.length} chars).` }, 400);

    const api = await sunoApi((await cookies()).toString());
    api.setBrowserToken(token, typeof body?.provider === 'string' ? body.provider : undefined);
    return json({ held: true, length: token.length, provider: body?.provider ?? null });
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
