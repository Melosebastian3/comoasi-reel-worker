import { query } from './db.js';

const clean = value => String(value || '').trim();

function mappedStatus(topLevelStatus, result) {
  const platformStatus = clean(result?.status).toLowerCase();
  if (result?.success === true || platformStatus === 'completed') return 'published';
  if (result?.success === false || ['failed', 'skipped'].includes(platformStatus) || topLevelStatus === 'failed') return 'failed';
  if (['queued', 'processing', 'in_progress'].includes(topLevelStatus) || ['queued', 'processing', 'retryable'].includes(platformStatus)) return 'publishing';
  return 'scheduled';
}

export async function reconcileUploadPostJob(jobId) {
  const id = clean(jobId);
  if (!id) throw new Error('upload_post_job_id_required');
  const apiKey = clean(process.env.UPLOAD_POST_API_KEY);
  if (!apiKey) throw new Error('upload_post_not_configured');

  const response = await fetch(`https://api.upload-post.com/api/uploadposts/status?job_id=${encodeURIComponent(id)}`, {
    headers: { Authorization: `Apikey ${apiKey}` },
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`upload_post_status_failed:${response.status}:${clean(data?.message || text).slice(0, 300)}`);

  const topLevelStatus = clean(data?.status).toLowerCase();
  const results = Array.isArray(data?.results) ? data.results : [];
  const { rows } = await query(
    `select * from comoasi.publishing_queue
      where account_key='upload-post' and external_post_id=$1
      order by platform`,
    [id]
  );

  const updates = [];
  for (const row of rows) {
    const result = results.find(item => clean(item?.platform).toLowerCase() === clean(row.platform).toLowerCase()) || null;
    const status = mappedStatus(topLevelStatus, result);
    const externalLink = clean(result?.url || result?.post_url) || null;
    const errorMessage = status === 'failed'
      ? clean(result?.error || result?.message || data?.message || 'upload_post_failed').slice(0, 500)
      : null;
    await query(
      `update comoasi.publishing_queue
          set status=$3,
              published_at=case when $3='published' then coalesce(published_at, now()) else published_at end,
              error=$4,
              publish_payload=coalesce(publish_payload,'{}'::jsonb) || $5::jsonb,
              updated_at=now()
        where id=$1 and external_post_id=$2`,
      [
        row.id,
        id,
        status,
        errorMessage,
        JSON.stringify({
          deliveryStatus: topLevelStatus || status,
          deliveryCheckedAt: new Date().toISOString(),
          externalLink,
          deliveryResult: result || {},
        }),
      ]
    );
    updates.push({ platform: row.platform, status, externalLink, error: errorMessage });
  }

  const final = updates.length > 0 && updates.every(item => ['published', 'failed'].includes(item.status));
  console.info('[como-asi] Upload-Post delivery status', id, topLevelStatus || 'unknown', updates.map(item => `${item.platform}:${item.status}`).join(','));
  return { ok: true, jobId: id, status: topLevelStatus, updates, final };
}
