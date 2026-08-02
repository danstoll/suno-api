import { NextResponse, NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { sunoApi } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type AllowedMethod = (typeof ALLOWED_METHODS)[number];

/**
 * Authenticated passthrough to any Suno API path.
 *
 *   GET  /api/raw?path=/api/project/default
 *   POST /api/raw   { "path": "/api/...", "method": "POST", "body": { ... } }
 *
 * Exists because Suno ships features faster than this wrapper gains typed
 * routes for them (Studio, the v3 editor, covers, hooks). Use it to probe and
 * to call unwrapped endpoints; promote anything that proves stable into a
 * proper route.
 *
 * Writes are opt-in: a non-GET method must be requested explicitly via POST
 * with a `method` field, so a stray GET can never mutate anything.
 */
export async function GET(req: NextRequest) {
  try {
    const path = new URL(req.url).searchParams.get('path');
    if (!path) {
      return json({ error: "Query param 'path' is required, e.g. ?path=/api/project/default" }, 400);
    }

    const api = await sunoApi((await cookies()).toString());
    const { status, data } = await api.raw(path, 'GET');

    // Surface Suno's status in the body — a 404 here means "that endpoint does
    // not exist", which is a useful probe result, not a failure of this route.
    return json({ suno_status: status, path, data }, 200);
  } catch (error: any) {
    console.error('raw GET error:', error);
    return json({ error: 'Internal server error. ' + (error?.message ?? error) }, 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();
    const { path, method = 'POST', body } = payload ?? {};

    if (!path) {
      return json({ error: "Field 'path' is required." }, 400);
    }
    const upper = String(method).toUpperCase() as AllowedMethod;
    if (!ALLOWED_METHODS.includes(upper)) {
      return json({ error: `Unsupported method '${method}'. Allowed: ${ALLOWED_METHODS.join(', ')}` }, 400);
    }

    const api = await sunoApi((await cookies()).toString());
    const { status, data } = await api.raw(path, upper, body);

    return json({ suno_status: status, path, method: upper, data }, 200);
  } catch (error: any) {
    console.error('raw POST error:', error);
    return json({ error: 'Internal server error. ' + (error?.message ?? error) }, 500);
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}

function json(payload: unknown, status: number) {
  return new NextResponse(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}
