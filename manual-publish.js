import { query } from './db.js';
import { scheduleSavedMetricool } from './metricool-automation.js';

const supportedNetworks = ['instagram', 'tiktok', 'youtube'];
const clean = value => String(value || '').trim();

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

  const scheduledAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  const result = await scheduleSavedMetricool({
    reelId: id,
    scheduledAt,
    timezone: 'America/Argentina/Buenos_Aires',
    networks: pending,
  });
  const after = await queueRows(id);
  return {
    ok: true,
    provider: result.provider || 'metricool',
    providerOrder: ['metricool', 'buffer', 'upload-post'],
    alreadyPublished: false,
    result,
    publication: publicationSnapshot(after),
  };
}
