import { NextResponse, NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { sunoApi } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * Read a Suno Studio project.
 *
 *   GET /api/studio_project?id=<studio_project_id>            -> summary
 *   GET /api/studio_project?id=<id>&full=true                 -> whole state document
 *
 * Studio is a DIFFERENT API surface from the clip endpoints. Clips are
 * generated and immutable; Studio projects are a versioned, DAW-style document
 * (tracks -> clips + take lanes, timing in beats, warp markers, per-track EQ).
 *
 * Find a project id on any clip whose `metadata.type` is `studio_export` or
 * `edit_v3_export` — it is exposed as `metadata.studio_project_id`.
 *
 * READ-ONLY on purpose. Writing a project version means replacing a document
 * that represents real creative work; it is not something to do against a
 * guessed schema. Use /api/raw explicitly once the write shape is confirmed.
 */
export async function GET(req: NextRequest) {
  try {
    const params = new URL(req.url).searchParams;
    const id = params.get('id');
    const full = params.get('full') === 'true';

    if (!id) {
      return json({ error: "Query param 'id' (studio_project_id) is required." }, 400);
    }

    const api = await sunoApi((await cookies()).toString());
    const { status, data } = await api.raw(`/api/studio/project/${id}`, 'GET');

    if (status !== 200) {
      return json({ error: `Suno returned ${status} for project ${id}`, data }, status);
    }
    if (full) return json(data, 200);

    const state = data.state ?? {};
    return json(
      {
        id: data.id,
        title: data.title,
        latest_version_id: data.latest_version_id,
        created_at: data.created_at,
        updated_at: data.updated_at,
        archived: data.archived,
        edit_clip_id: state.editClipId,
        style_summary: state.styleSummary,
        used_replace_section: state.metadata?.usedReplaceSection ?? false,
        // Studio measures everything in beats, not seconds. bps is the
        // conversion factor: seconds = beats / bps.
        timing: state.timing
          ? { type: state.timing.type, bps: state.timing.bps, lock_bps: state.timing.lockBPS }
          : undefined,
        tracks: (state.tracks ?? []).map((t: any) => ({
          id: t.id,
          name: t.name,
          type: t.type,
          instrument: t.instrument?.type,
          muted: t.mute,
          solo: t.solo,
          clip_count: Array.isArray(t.clips) ? t.clips.length : 0,
          take_lane_count: Array.isArray(t.takeLanes) ? t.takeLanes.length : 0
        }))
      },
      200
    );
  } catch (error: any) {
    console.error('studio_project error:', error);
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
