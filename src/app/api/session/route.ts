import { NextResponse, NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { sunoApi } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * Account capability discovery.
 *
 *   GET /api/session            -> models, feature flags, roles
 *   GET /api/session?raw=true   -> the untouched Suno payload
 *
 * This is the authoritative source for which models and features the account
 * can actually use — far better than tracking Suno's changelog by hand. The
 * model list here is what `SUNO_MODEL` should be set from.
 */
export async function GET(req: NextRequest) {
  try {
    const raw = new URL(req.url).searchParams.get('raw') === 'true';
    const api = await sunoApi((await cookies()).toString());
    const { status, data } = await api.raw('/api/session/', 'GET');

    if (status !== 200) {
      return json({ error: `Suno returned ${status}`, data }, status);
    }
    if (raw) return json(data, 200);

    return json(
      {
        models: (data.models ?? []).map((m: any) => ({
          external_key: m.external_key, // <- the `mv` / SUNO_MODEL value
          name: m.name,
          major_version: m.major_version,
          description: m.description,
          capabilities: m.capabilities,
          features: m.features,
          allowed_condition_combinations: m.allowed_condition_combinations,
          max_lengths: m.max_lengths
        })),
        roles: data.roles,
        // Flags gate features like edit-mode-infill, crop-remove and
        // song-duration-control. Presence here is how you tell whether an
        // unwrapped feature is even worth implementing for this account.
        flags: data.flags ? Object.keys(data.flags) : []
      },
      200
    );
  } catch (error: any) {
    console.error('session error:', error);
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
