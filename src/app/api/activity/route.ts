import { NextResponse, NextRequest } from 'next/server';
import { list, clear } from '@/lib/activity';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * Live activity feed backing the /status page.
 *
 *   GET    /api/activity?limit=100   -> newest-first events
 *   DELETE /api/activity             -> clear the log
 */
export async function GET(req: NextRequest) {
  const limitRaw = new URL(req.url).searchParams.get('limit');
  const limit = Math.min(Math.max(Number(limitRaw ?? 100) || 100, 1), 300);
  const events = list(limit);
  return json({
    now: Date.now(),
    count: events.length,
    // A single number the page can headline: is anything actually in flight?
    inFlight: events.filter((e) => e.status === 'pending').length,
    events
  });
}

export async function DELETE() {
  clear();
  return json({ cleared: true });
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}

function json(payload: unknown) {
  return new NextResponse(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders
    }
  });
}
