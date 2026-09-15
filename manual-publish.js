import { query } from './db.js';
import { studioCall } from './engine.js';
import { scheduleUploadPostFallback } from './upload-post-fallback.js';

const supportedNetworks = ['instagram', 'tiktok', 'youtube'];
const fallbackNetworks = new Set(supportedNetworks);
const clean = value => String(value || '').trim();
const asObject = value => value && typeof value === 'object' ? value : {};

function normalizeNetworks(value) {
  const source = Array.isArray(value) && value.length ? value : supportedNetworks;
  return [...new Set(source.map(item => clean(item).toLowerCase()).filter(item => supportedNetworks.includes(item)))];
}

async function queueRows(reelId) {
  const { rows } = await query(
    `select * from comoasi.publishing_queue
      where reel_id=$1
        and platform = any($2::text[])
      order by updated_at desc`,
    [reelId, supportedNetworks]
  );
  return rows;
}

function isPublished(row) {
  return clean(row?.status) === 'published' || Boolean(row?.published_at);
}

function publicationSnapshot(rows) {
  const networks = supportedNetworks.map(network => {
    const candidates = rows.filter(row => clean(row.platform) === network);
    const selected = candidates.find(isPublished)
      || candidates.find(row => clean(row.status) === 'publishing')
      || candidates.find(row => clean(row.status) === 'scheduled')
      || candidates.find(row => clean(row.status) === 'failed')
      || candidates[0]
      || null;
    const status = !selected
      ? 'missing'
      : isPublished(selected)
        ? 'published'
        : clean(selected.status) || 'scheduled';
    return {
      network,
      status,
      provider: clean(selected?.account_key) || null,
      scheduledAt: selected?.scheduled_at || null,
      publishedAt: selected?.published_at || null,
      error: clean(selected?.error) || null,
    };
  });

  const statuses = networks.map(item => item.status);
  let status = 'generated';
  if (statuses.every(item => item === 'published')) status = 'published';
  else if (statuses.some(item => item === 'published')) status = 'partial';
  else if (statuses.some(item => item === 'publishing')) status = 'publishing';
  else if (statuses.some(item => item === 'scheduled')) status = 'scheduled';
  else if (statuses.some(item => item === 'failed')) status = 'failed';

  const scheduled = networks.map(item => item.scheduledAt).filter(Boolean).map(value => new Date(value).getTime()).filter(Number.isFinite);
  const published = networks.map(item => item.publishedAt).filter(Boolean).map(value => new Date(value).getTime()).filter(Number.isFinite);
  const scheduledAt = scheduled.length ? new Date(Math.min(...scheduled)).toISOString() : null;
  const publishedAt = published.length ? new Date(Math.max(...published)).toISOString() : null;
  const overdue = status === 'scheduled' && scheduledAt && Date.now() - new Date(scheduledAt).getTime() > 10 * 60 * 1000;
  return { status: overdue ? 'overdue' : status, scheduledAt, publishedAt, networks };
}

async function syncBufferResult(reelId, item, triggeredAt) {
  const network = clean(item.network).toLowerCase();
  const postId = clean(item.postId);
  if (!supportedNetworks.includes(network) || !postId) return;
  const remoteStatus = clean(item.status).toLowerCase();
  const status = remoteStatus === 'sent' || remoteStatus === 'published'
    ? 'published'
    : remoteStatus === 'sending' || remoteStatus === 'publishing'
      ? 'publishing'
      : 'scheduled';
  const scheduledAt = clean(item.dueAt) || new Date(Date.now() + 2 * 60 * 1000).toISOString();
  const publishedAt = status === 'published' ? clean(item.sentAt) || new Date().toISOString() : null;
  const payload = {
    provider: 'buffer',
    postId,
    manualTriggerAt: triggeredAt,
    deliveryStatus: remoteStatus || status,
    deliveryCheckedAt: new Date().toISOString(),
    externalLink: clean(item.externalLink) || null,
  };

  await query(
    `insert into comoasi.publishing_queue as q
      (reel_id, platform, account_key, scheduled_at, status, publish_payload, external_post_id, published_at, error)
     values($1,$2,'buffer',$3,$4,$5::jsonb,$6,$7,null)
     on conflict (reel_id, platform, account_key) where account_key='buffer'
     do update set
       scheduled_at=excluded.scheduled_at,
       status=excluded.status,
       publish_payload=(q.publish_payload - 'leaseToken' - 'leaseExpiresAt') || excluded.publish_payload,
       external_post_id=excluded.external_post_id,
       published_at=coalesce(excluded.published_at, q.published_at),
       error=null,
       updated_at=now()`,
    [reelId, network, scheduledAt, status, JSON.stringify(payload), postId, publishedAt]
  );
}

function safeFallbackForNetwork(rows, network) {
  if (!fallbackNetworks.has(network)) return false;
  const bufferRows = rows.filter(row => clean(row.account_key) === 'buffer' && clean(row.platform) === network);
  return !bufferRows.some(row => clean(row.external_post_id) && ['scheduled', 'publishing', 'published'].includes(clean(row.status)));
}

export async function publishNow({ reelId, networks }) {
  const id = clean(reelId);
  if (!id) throw new Error('reel_id_required');
  const selectedNetworks = normalizeNetworks(networks);
  if (!selectedNetworks.length) throw new Error('publish_networks_required');

  const reelResult = await query('select id, status, video_object_key from comoasi.reels where id=$1 limit 1', [id]);
  const reel = reelResult.rows[0];
  if (!reel) throw new Error('reel_not_found');
  if (clean(reel.status) !== 'ready' || !clean(reel.video_object_key)) throw new Error('reel_not_ready');

  const before = await queueRows(id);
  const alreadyPublished = new Set(before.filter(isPublished).map(row => clean(row.platform)));
  const pending = selectedNetworks.filter(network => !alreadyPublished.has(network));
  if (!pending.length) {
    return { ok: true, alreadyPublished: true, publication: publicationSnapshot(before), results: [] };
  }

  const triggeredAt = new Date().toISOString();
  try {
    const response = asObject(await studioCall('/api/buffer/publish-now', {
      reelId: id,
      networks: pending,
    }, { timeoutMs: 120000, attempts: 1 }));
    const results = Array.isArray(response.results) ? response.results.map(asObject) : [];
    for (const item of results) await syncBufferResult(id, item, triggeredAt);
    const after = await queueRows(id);
    return {
      ok: true,
      provider: 'buffer',
      alreadyPublished: false,
      results,
      publication: publicationSnapshot(after),
    };
  } catch (error) {
    const message = clean(error?.message || error);
    const rateLimited = message.includes('429') || message.includes('Too many requests') || message.includes('window=24h');
    if (!rateLimited) throw error;

    const safeFallback = pending.filter(network => safeFallbackForNetwork(before, network));
    if (safeFallback.length) {
      const fallback = await scheduleUploadPostFallback({
        reelId: id,
        scheduledAt: new Date(Date.now() + 90 * 1000).toISOString(),
        networks: safeFallback,
        allowFailedBufferTakeover: true,
      });
      const remaining = pending.filter(network => !safeFallback.includes(network));
      const after = await queueRows(id);
      return {
        ok: true,
        provider: remaining.length ? 'hybrid' : 'upload-post',
        partial: remaining.length > 0,
        alreadyPublished: false,
        fallback,
        blockedNetworks: remaining,
        message: remaining.length
          ? `Buffer está limitado; se activó la contingencia para ${safeFallback.join(', ')}. Quedan pendientes: ${remaining.join(', ')}.`
          : 'Buffer está limitado; la publicación se derivó automáticamente al proveedor de contingencia.',
        publication: publicationSnapshot(after),
      };
    }

    const blocked = new Error('buffer_rate_limited_manual_publish_blocked');
    blocked.detail = 'Buffer está limitando consultas y hay publicaciones existentes cuyo estado no se puede confirmar. No se forzó un segundo envío para evitar duplicados.';
    throw blocked;
  }
}
