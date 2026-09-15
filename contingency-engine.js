import { query } from './db.js';
import { scheduleUploadPostFallback, uploadPostFallbackReady } from './upload-post-fallback.js';
import { reconcileUploadPostJob } from './upload-post-status.js';

const supportedNetworks = ['instagram', 'tiktok', 'youtube'];
const clean = value => String(value || '').trim();
const waitUntil = (scheduledAt, nowMs = Date.now()) => {
  const targetMs = new Date(scheduledAt || 0).getTime();
  const safeMs = Number.isFinite(targetMs) ? Math.max(targetMs, nowMs + 90 * 1000) : nowMs + 90 * 1000;
  return new Date(safeMs).toISOString();
};

async function markContingencyBackoff(reelId, networks, error) {
  const retryAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  await query(
    `update comoasi.publishing_queue
        set publish_payload=coalesce(publish_payload,'{}'::jsonb) || $3::jsonb,
            updated_at=now()
      where reel_id=$1
        and account_key='buffer'
        and platform = any($2::text[])`,
    [reelId, networks, JSON.stringify({
      contingencyLastError: clean(error?.message || error).slice(0, 500),
      contingencyRetryAt: retryAt,
      contingencyCheckedAt: new Date().toISOString(),
    })]
  );
}

export async function reconcilePendingUploadPostJobs() {
  if (!uploadPostFallbackReady()) return [];
  const { rows } = await query(`
    select distinct external_post_id
      from comoasi.publishing_queue
     where account_key='upload-post'
       and external_post_id is not null
       and status in ('scheduled','publishing')
       and scheduled_at <= now() + interval '5 minutes'
       and updated_at >= now() - interval '12 hours'
     order by external_post_id
  `);

  const results = [];
  for (const row of rows) {
    const jobId = clean(row.external_post_id);
    if (!jobId) continue;
    try {
      results.push(await reconcileUploadPostJob(jobId));
    } catch (error) {
      console.error('[como-asi] contingency Upload-Post status failed', jobId, clean(error?.message || error));
      results.push({ ok: false, jobId, error: clean(error?.message || error) });
    }
  }
  return results;
}

export async function recoverProviderGaps() {
  if (!uploadPostFallbackReady()) return [];
  const { rows } = await query(`
    select b.reel_id, b.platform, b.scheduled_at
      from comoasi.publishing_queue b
     where b.account_key='buffer'
       and b.platform = any($1::text[])
       and b.status in ('failed','cancelled')
       and b.published_at is null
       and b.scheduled_at between now() - interval '6 hours' and now() + interval '24 hours'
       and (
         b.publish_payload->>'contingencyRetryAt' is null
         or (b.publish_payload->>'contingencyRetryAt')::timestamptz <= now()
       )
       and not exists (
         select 1
           from comoasi.publishing_queue u
          where u.reel_id=b.reel_id
            and u.platform=b.platform
            and u.account_key='upload-post'
            and u.external_post_id is not null
       )
     order by b.scheduled_at, b.reel_id, b.platform
  `, [supportedNetworks]);

  const grouped = new Map();
  for (const row of rows) {
    const reelId = clean(row.reel_id);
    const platform = clean(row.platform).toLowerCase();
    if (!reelId || !supportedNetworks.includes(platform)) continue;
    if (!grouped.has(reelId)) grouped.set(reelId, { networks: [], scheduledAt: row.scheduled_at });
    const group = grouped.get(reelId);
    if (!group.networks.includes(platform)) group.networks.push(platform);
    if (row.scheduled_at && (!group.scheduledAt || new Date(row.scheduled_at) > new Date(group.scheduledAt))) {
      group.scheduledAt = row.scheduled_at;
    }
  }

  const results = [];
  for (const [reelId, group] of grouped.entries()) {
    try {
      const scheduledAt = waitUntil(group.scheduledAt);
      const result = await scheduleUploadPostFallback({
        reelId,
        scheduledAt,
        networks: group.networks,
        allowFailedBufferTakeover: true,
      });
      results.push({ ok: true, reelId, networks: group.networks, scheduledAt, result });
      console.info('[como-asi] contingency takeover scheduled', reelId, group.networks.join(','), scheduledAt);
    } catch (error) {
      await markContingencyBackoff(reelId, group.networks, error);
      console.error('[como-asi] contingency takeover failed', reelId, group.networks.join(','), clean(error?.message || error));
      results.push({ ok: false, reelId, networks: group.networks, error: clean(error?.message || error) });
    }
  }
  return results;
}

export async function runContingencyCycle() {
  const delivery = await reconcilePendingUploadPostJobs();
  const failover = await recoverProviderGaps();
  return { delivery, failover };
}

export function startContingencyDispatcher(intervalMs = 30000) {
  const safeInterval = Math.max(15000, Number(intervalMs) || 30000);
  const timer = setInterval(() => {
    void runContingencyCycle().catch(error => console.error('[como-asi] contingency cycle failed', clean(error?.message || error)));
  }, safeInterval);
  timer.unref?.();
  console.info(`[como-asi] intelligent contingency active every ${safeInterval}ms`);
  return timer;
}
