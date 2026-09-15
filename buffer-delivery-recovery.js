import { query } from './db.js';
import { studioCall } from './engine.js';

const clean = value => String(value || '').trim();

function mappedStatus(status) {
  if (status === 'sent') return 'published';
  if (status === 'sending') return 'publishing';
  if (status === 'error') return 'failed';
  return 'scheduled';
}

export async function reconcileBufferDeliveries() {
  const { rows } = await query(`
    select distinct reel_id
      from comoasi.publishing_queue
     where account_key='buffer'
       and scheduled_at >= now() - interval '6 hours'
       and scheduled_at <= now() + interval '24 hours'
       and external_post_id is not null
  `);

  const allResults = [];
  for (const row of rows) {
    const reelId = clean(row.reel_id);
    if (!reelId) continue;
    try {
      const response = await studioCall('/api/buffer/recover', { reelId }, { timeoutMs: 120000, attempts: 3 });
      const results = Array.isArray(response?.results) ? response.results : [];
      for (const item of results) {
        const network = clean(item?.network).toLowerCase();
        const status = clean(item?.status).toLowerCase();
        const postId = clean(item?.postId);
        if (!network || !status || !postId) continue;
        const dueAt = clean(item?.dueAt) || null;
        const errorMessage = clean(item?.error?.message || item?.error?.rawError) || null;
        const dbStatus = mappedStatus(status);
        await query(
          `update comoasi.publishing_queue
              set status=$4,
                  scheduled_at=coalesce($5::timestamptz, scheduled_at),
                  external_post_id=$6,
                  published_at=case when $4='published' then coalesce(published_at, now()) else published_at end,
                  error=$7,
                  publish_payload=publish_payload || $8::jsonb,
                  updated_at=now()
            where reel_id=$1 and platform=$2 and account_key=$3`,
          [
            reelId,
            network,
            'buffer',
            dbStatus,
            dueAt,
            postId,
            errorMessage,
            JSON.stringify({
              deliveryStatus: status,
              deliveryCheckedAt: new Date().toISOString(),
              recovered: Boolean(item?.recovered),
              externalLink: clean(item?.externalLink) || null,
            }),
          ]
        );
        allResults.push({ reelId, network, status, dbStatus, postId, recovered: Boolean(item?.recovered), dueAt, error: errorMessage });
      }
    } catch (error) {
      console.error('[como-asi] Buffer delivery reconciliation failed', reelId, error?.message || error);
      allResults.push({ reelId, error: error?.message || String(error) });
    }
  }
  console.info('[como-asi] Buffer delivery reconciliation complete', JSON.stringify(allResults));
  return allResults;
}

export function startBufferDeliveryRecovery(intervalMs = 300000) {
  const timer = setInterval(() => {
    void reconcileBufferDeliveries().catch(error => console.error('[como-asi] Buffer delivery recovery tick failed', error?.message || error));
  }, intervalMs);
  timer.unref?.();
  console.info(`[como-asi] Buffer delivery recovery active every ${intervalMs}ms`);
  return timer;
}
