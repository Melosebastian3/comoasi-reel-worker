import { query } from './db.js';
import { scheduleUploadPostFallback, uploadPostFallbackReady } from './upload-post-fallback.js';
import { reconcileUploadPostJob } from './upload-post-status.js';
import { queuePublishAll, socialStatus } from './social-publisher.js';

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

async function nativeReadyNetworks(requested) {
  try {
    const statuses = await socialStatus();
    return requested.filter(network => {
      const item = statuses.find(status => status.network === network);
      return Boolean(item?.configured && item?.connected && !item?.review);
    });
  } catch (error) {
    console.error('[como-asi] native contingency status failed', clean(error?.message || error));
    return [];
  }
}

async function nativeTakeover({ reelId, networks, scheduledAt }) {
  const ready = await nativeReadyNetworks(networks);
  if (!ready.length) return { ok: false, networks: [], reason: 'native_social_not_configured' };

  const { rows } = await query(
    `select platform
       from comoasi.publishing_queue
      where reel_id=$1
        and platform = any($2::text[])
        and account_key=platform
        and status in ('queued','publishing','published')`,
    [reelId, ready]
  );
  const existing = new Set(rows.map(row => clean(row.platform)));
  const pending = ready.filter(network => !existing.has(network));
  if (!pending.length) return { ok: true, networks: ready, duplicatePrevented: true };

  const jobs = await queuePublishAll({ reelId, selectedNetworks: pending, scheduledAt });
  console.info('[como-asi] native contingency scheduled', reelId, pending.join(','), scheduledAt);
  return { ok: true, networks: pending, jobs };
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
       and not exists (
         select 1
           from comoasi.publishing_queue n
          where n.reel_id=b.reel_id
            and n.platform=b.platform
            and n.account_key=b.platform
            and n.status in ('queued','publishing','published')
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
    const scheduledAt = waitUntil(group.scheduledAt);
    let uploadPostError = null;

    if (uploadPostFallbackReady()) {
      try {
        const result = await scheduleUploadPostFallback({
          reelId,
          scheduledAt,
          networks: group.networks,
          allowFailedBufferTakeover: true,
        });
        results.push({ ok: true, provider: 'upload-post', reelId, networks: group.networks, scheduledAt, result });
        console.info('[como-asi] contingency takeover scheduled', reelId, group.networks.join(','), scheduledAt);
        continue;
      } catch (error) {
        uploadPostError = error;
        console.warn('[como-asi] Upload-Post contingency unavailable', reelId, group.networks.join(','), clean(error?.message || error));
      }
    } else {
      uploadPostError = new Error('upload_post_not_configured');
    }

    try {
      const native = await nativeTakeover({ reelId, networks: group.networks, scheduledAt });
      const covered = new Set(native.networks || []);
      const remaining = group.networks.filter(network => !covered.has(network));
      if (native.ok && covered.size) {
        results.push({ ok: true, provider: 'native', reelId, networks: [...covered], scheduledAt, result: native });
        if (!remaining.length) continue;
      }
      const finalError = new Error(`${clean(uploadPostError?.message || uploadPostError)};native_unavailable:${remaining.join(',') || group.networks.join(',')}`);
      await markContingencyBackoff(reelId, remaining.length ? remaining : group.networks, finalError);
      console.error('[como-asi] contingency exhausted', reelId, (remaining.length ? remaining : group.networks).join(','), finalError.message);
      results.push({ ok: false, reelId, networks: remaining.length ? remaining : group.networks, error: finalError.message });
    } catch (nativeError) {
      const finalError = new Error(`${clean(uploadPostError?.message || uploadPostError)};native_failed:${clean(nativeError?.message || nativeError)}`);
      await markContingencyBackoff(reelId, group.networks, finalError);
      console.error('[como-asi] contingency takeover failed', reelId, group.networks.join(','), finalError.message);
      results.push({ ok: false, reelId, networks: group.networks, error: finalError.message });
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
