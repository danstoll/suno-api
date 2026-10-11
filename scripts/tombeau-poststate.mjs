// READ-ONLY. After the rejected upload: what, if anything, was left behind?
//  - track 1's live cover, against the backup
//  - whether the orphaned upload id appears anywhere (cover-art library)
//  - whether the upload record itself is readable
import { readFileSync } from 'node:fs';
import { rawGet, rawCall } from './tombeau-lib.mjs';

const CLIP = '49b5a27d-e95f-4fed-a23f-ca8e15d68619';
const UPLOAD_ID = '842b2b70-c65e-47f0-906a-f6ed4981a459';

const backup = JSON.parse(readFileSync('F:\\Projects\\DaddyWombat\\suno-api\\backups\\tombeau-clips-2026-09-19.json', 'utf8'));
const before = backup.clips.find(c => c.id === CLIP);

const r = await rawGet(`/api/clip/${CLIP}`);
const c = r.data;
console.log('=== track 1 live state');
console.log('image_url      :', c.image_url);
console.log('  matches backup:', c.image_url === before.image_url);
console.log('image_large_url:', c.image_large_url);
console.log('  matches backup:', c.image_large_url === before.image_large_url);
console.log('title unchanged:', c.title === before.title);
console.log('lyrics unchanged:', (c.metadata?.prompt || '') === (before.metadata?.prompt || ''));
console.log('style unchanged :', (c.metadata?.tags || '') === (before.metadata?.tags || ''));
console.log('is_public       :', c.is_public, '(backup:', before.is_public, ')');
console.log('video_is_stale  :', c.video_is_stale, '(backup:', before.video_is_stale, ')');
for (const k of ['image_s3_id', 'is_liked', 'is_trashed', 'status']) {
  console.log(`${k}: ${JSON.stringify(c[k])} (backup: ${JSON.stringify(before[k])})`);
}

// Does the rejected upload show up in the cover-art library? (POST, but a listing.)
console.log('\n=== cover-art library, most recent batches');
const hist = await rawCall('/api/video_gen/history', 'POST', { limit: 8, media_type: 'image', favorites_only: false });
console.log('suno_status:', hist.suno_status);
for (const b of (hist.data?.history || [])) {
  const ids = (b.items || []).map(i => i.id).join(', ');
  console.log(` batch ${b.batch_id}  origin=${b.origin} cat=${b.gen_category} status=${b.status}`);
  console.log(`   items: ${ids}`);
  for (const i of (b.items || [])) console.log(`     url: ${i.url}`);
}
const flat = JSON.stringify(hist.data || {});
console.log(`\nupload id ${UPLOAD_ID} present in library listing:`, flat.includes(UPLOAD_ID));
