import { NextResponse, NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { sunoApi } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * Replace Section (infill) — regenerate a time window inside an existing song
 * while leaving the rest of it alone.
 *
 *   POST /api/replace_section
 *   {
 *     "clip_id": "<uuid>",
 *     "infill_start_s": 64,
 *     "infill_end_s": 88,
 *     "lyrics": "new words for that window",   // optional
 *     "context_start_s": 40,                   // optional, defaults to start-15
 *     "context_end_s": 110,                    // optional, defaults to end+15
 *     "include_history_s": 2,                  // optional
 *     "include_future_s": 2,                   // optional
 *     "task": "infill",                        // see note
 *     "tags": "...", "title": "...", "model": "chirp-fenix"
 *   }
 *
 * Use this rather than /api/extend_audio when you want to CHANGE something in
 * place. Extend regenerates everything after its cut point and cannot preserve
 * the tail; infill replaces a bounded window and keeps both sides.
 *
 * Note on `task`: the field names here were read off a real Suno clip, but that
 * capture was a per-stem infill (`stem_condition_infill`). Plain Replace
 * Section is `infill`, per the model capability list — exposed as a parameter
 * so it can be corrected without a code change if Suno disagrees.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      // `clip_id`/`audio_id` accepted as aliases for the field Suno actually
      // calls `continue_clip_id`, to match this API's other routes.
      continue_clip_id,
      clip_id,
      audio_id,
      ...rest
    } = body ?? {};

    const id = continue_clip_id ?? clip_id ?? audio_id;
    if (!id) {
      return json({ error: "'continue_clip_id' (aliases: clip_id, audio_id) is required." }, 400);
    }
    if (typeof rest.infill_start_s !== 'number' || typeof rest.infill_end_s !== 'number') {
      return json({ error: "'infill_start_s' and 'infill_end_s' are required numbers (seconds)." }, 400);
    }

    const api = await sunoApi((await cookies()).toString());
    const audios = await api.generateInfill({ continue_clip_id: id, ...rest });

    return json(audios, 200);
  } catch (error: any) {
    console.error('replace_section error:', error);
    const detail = error?.response?.data ?? error?.message ?? String(error);
    // Surface Suno's own validation message — while the payload shape is still
    // being pinned down, that message is the most useful thing we can return.
    return json({ error: 'Replace section failed.', detail }, 500);
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
