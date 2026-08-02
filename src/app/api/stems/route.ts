import { NextResponse, NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { sunoApi } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * List the separated stems of a clip.
 *
 *   GET /api/stems?id=<clip-id>            -> page 0
 *   GET /api/stems?id=<clip-id>&page=1     -> further pages
 *   GET /api/stems?id=<clip-id>&all=true   -> every page, flattened
 *
 * Distinct from /api/generate_stems, which *creates* a split. This reads an
 * existing one — the 12-way Auto Split (Vocals, Backing Vocals, Drums, Bass,
 * Guitar, Keyboard, Percussion, Strings, Synth, FX, Brass, Woodwinds).
 *
 * A clip with no split reports `pages: 0`, and Suno then answers `page=0` with
 * HTTP 400 "Invalid page number" — so the page count is checked first and an
 * empty list returned, rather than surfacing a confusing error.
 */
export async function GET(req: NextRequest) {
  try {
    const params = new URL(req.url).searchParams;
    const id = params.get('id');
    const all = params.get('all') === 'true';
    const page = Number(params.get('page') ?? 0);

    if (!id) return json({ error: "Query param 'id' (clip id) is required." }, 400);
    if (!Number.isInteger(page) || page < 0) {
      return json({ error: `'page' must be a non-negative integer, got '${params.get('page')}'` }, 400);
    }

    const api = await sunoApi((await cookies()).toString());

    const pagesRes = await api.raw(`/api/clip/${id}/stems/pages`, 'GET');
    if (pagesRes.status !== 200) {
      return json({ error: `Suno returned ${pagesRes.status}`, data: pagesRes.data }, pagesRes.status);
    }
    const pages: number = pagesRes.data?.pages ?? 0;
    if (pages === 0) {
      return json({ clip_id: id, pages: 0, stems: [], note: 'This clip has no stem split.' }, 200);
    }

    const wanted = all ? Array.from({ length: pages }, (_, i) => i) : [page];
    const stems: any[] = [];
    for (const p of wanted) {
      const res = await api.raw(`/api/clip/${id}/stems?page=${p}`, 'GET');
      if (res.status !== 200) {
        return json({ error: `Suno returned ${res.status} for page ${p}`, data: res.data }, res.status);
      }
      for (const s of res.data?.stems ?? []) {
        stems.push({
          id: s.id,
          // The useful label: metadata.stem_type_group_name is the instrument
          // ("Vocals", "Drums"), while title is a decorated "(Vocals)".
          stem: s.metadata?.stem_type_group_name ?? s.title,
          title: s.title,
          status: s.status,
          duration: s.metadata?.duration,
          audio_url: s.audio_url,
          image_url: s.image_url,
          model_name: s.model_name,
          stem_from_id: s.metadata?.stem_from_id,
          stem_task: s.metadata?.stem_task,
          quiet: s.metadata?.is_loudness_under_threshold ?? false
        });
      }
    }

    return json({ clip_id: id, pages, returned_pages: wanted, count: stems.length, stems }, 200);
  } catch (error: any) {
    console.error('stems error:', error);
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
