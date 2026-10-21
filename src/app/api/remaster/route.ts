import { NextResponse, NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { sunoApi } from '@/lib/SunoApi';
import { corsHeaders, errorResponse } from '@/lib/utils';
import { parseRemasterBody } from '@/lib/remaster.mjs';

export const dynamic = 'force-dynamic';

/**
 * Remaster an existing clip (Suno task `upsample`).
 *
 *   POST /api/remaster { "clip_id": "<uuid>", "model": "chirp-fenix" }
 *
 * `model` is optional and defaults to the fork's default model.
 */
export async function POST(req: NextRequest) {
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Request body must be valid JSON.' }, 400);
    }
    const parsed = parseRemasterBody(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);

    const api = await sunoApi((await cookies()).toString());
    const clips = await api.remaster(parsed.clipId, parsed.model);
    return json(clips, 200);
  } catch (error: any) {
    return errorResponse(error, 'remaster');
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
