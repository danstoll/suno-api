/**
 * Remaster (Suno task "upsample"). Pure, so it can be tested without Suno.
 * The field names were read off existing remastered clips, not captured from
 * the web client — if Suno rejects the call, capture one and adjust here.
 */

/**
 * @param {any} body parsed request body
 * @returns {{ ok: true, clipId: string, model?: string } | { ok: false, error: string }}
 */
export function parseRemasterBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }
  const clipId = body.clip_id ?? body.audio_id;
  if (typeof clipId !== 'string' || !clipId.trim()) {
    return { ok: false, error: "'clip_id' (alias: audio_id) is required." };
  }
  if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim())) {
    return { ok: false, error: "'model' must be a non-empty string." };
  }
  return { ok: true, clipId: clipId.trim(), model: body.model?.trim() };
}

/**
 * @param {{ clipId: string, model: string, token: string | null, tokenProvider: string | null, uuid: string }} o
 */
export function buildRemasterPayload({ clipId, model, token, tokenProvider, uuid }) {
  return {
    project_id: null,
    token,
    task: 'upsample',
    generation_type: 'TEXT',
    mv: model,
    prompt: '',
    title: '',
    tags: '',
    negative_tags: '',
    metadata: {},
    override_fields: [],
    upsample_clip_id: clipId,
    transaction_uuid: uuid,
    token_provider: tokenProvider
  };
}
