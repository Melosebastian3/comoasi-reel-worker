import { query } from './db.js';

const clean = value => String(value || '').trim();
const allowedNetworks = new Set(['instagram', 'youtube']);

function joinTags(value) {
  return Array.isArray(value)
    ? value.map(tag => String(tag).startsWith('#') ? String(tag) : `#${tag}`).join(' ')
    : '';
}

function copyFor(reel, network) {
  const kit = reel?.publishing_kit && typeof reel.publishing_kit === 'object' ? reel.publishing_kit : {};
  const row = kit?.[network] && typeof kit[network] === 'object' ? kit[network] : {};
  if (network === 'youtube') {
    return {
      title: clean(row.title || reel.title || '¿Cómo Así?').slice(0, 100),
      text: [row.description, joinTags(row.hashtags)].filter(Boolean).join('\n\n').slice(0, 5000),
    };
  }
  return {
    title: clean(reel.title || '¿Cómo Así?').slice(0, 120),
    text: [row.caption, joinTags(row.hashtags)].filter(Boolean).join('\n\n').slice(0, 2200),
  };
}

export function uploadPostFallbackReady() {
  return process.env.UPLOAD_POST_ENABLED === 'true'
    && Boolean(clean(process.env.UPLOAD_POST_API_KEY))
    && Boolean(clean(process.env.UPLOAD_POST_USER || 'default'));
}

export function isBufferRateLimitError(error) {
  const message = clean(error?.message || error);
  return message.includes('429') || message.includes('Too many requests') || message.includes('window=24h');
}

export function bufferRetryAtFromError(error, nowMs = Date.now()) {
  const message = clean(error?.message || error);
  const match = message.match(/retryAfter=(\d+)/i);
  const seconds = match ? Number(match[1]) : 30 * 60;
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 30 * 60;
  return new Date(nowMs + safeSeconds * 1000 + 60 * 1000).toISOString();
}

async function existingUploadPostRows(reelId, networks) {
  const { rows } = await query(
    `select * from comoasi.publishing_queue
      where reel_id=$1 and account_key='upload-post' and platform = any($2::text[])
      order by updated_at desc`,
    [reelId, networks]
  );
  const byNetwork = new Map();
  for (const row of rows) {
    if (!byNetwork.has(row.platform)) byNetwork.set(row.platform, row);
  }
  return byNetwork;
}

async function saveRows({ reelId, networks, scheduledAt, jobId, idempotencyKey, response }) {
  const saved = [];
  for (const network of networks) {
    const { rows } = await query(
      `select * from comoasi.publishing_queue
        where reel_id=$1 and platform=$2 and account_key='upload-post'
        order by updated_at desc limit 1`,
      [reelId, network]
    );
    const payload = {
      provider: 'upload-post',
      idempotencyKey,
      jobId,
      user: clean(process.env.UPLOAD_POST_USER || 'default'),
      scheduledAt,
      response: response && typeof response === 'object' ? response : {},
      confirmedAt: new Date().toISOString(),
    };
    let row;
    if (rows[0]) {
      const updated = await query(
        `update comoasi.publishing_queue
            set scheduled_at=$4,
                status='scheduled',
                external_post_id=$5,
                publish_payload=$6::jsonb,
                error=null,
                updated_at=now()
          where id=$1 and reel_id=$2 and platform=$3
          returning *`,
        [rows[0].id, reelId, network, scheduledAt, jobId, JSON.stringify(payload)]
      );
      row = updated.rows[0];
    } else {
      const inserted = await query(
        `insert into comoasi.publishing_queue
          (reel_id, platform, account_key, scheduled_at, status, external_post_id, publish_payload, error)
         values($1,$2,'upload-post',$3,'scheduled',$4,$5::jsonb,null)
         returning *`,
        [reelId, network, scheduledAt, jobId, JSON.stringify(payload)]
      );
      row = inserted.rows[0];
    }
    saved.push(row);
  }
  return saved;
}

export async function scheduleUploadPostFallback({ reelId, scheduledAt, networks }) {
  if (!uploadPostFallbackReady()) throw new Error('upload_post_not_configured');
  const selected = [...new Set((Array.isArray(networks) ? networks : [])
    .map(item => clean(item).toLowerCase())
    .filter(item => allowedNetworks.has(item)))];
  if (!reelId || !selected.length) throw new Error('upload_post_networks_required');

  const bufferRows = await query(
    `select platform, external_post_id, status from comoasi.publishing_queue
      where reel_id=$1 and account_key='buffer' and platform = any($2::text[])`,
    [reelId, selected]
  );
  const unsafe = bufferRows.rows.filter(row => clean(row.external_post_id) && ['scheduled', 'published', 'publishing'].includes(clean(row.status)));
  if (unsafe.length) {
    throw new Error(`upload_post_fallback_blocked_buffer_post_exists:${unsafe.map(row => row.platform).join(',')}`);
  }

  const existing = await existingUploadPostRows(reelId, selected);
  const already = selected.filter(network => clean(existing.get(network)?.external_post_id));
  if (already.length === selected.length) {
    return {
      ok: true,
      provider: 'upload-post',
      duplicatePrevented: true,
      scheduledAt,
      networks: selected,
      scheduled: selected.map(network => ({
        network,
        postId: clean(existing.get(network)?.external_post_id),
        duplicatePrevented: true,
      })),
    };
  }

  const { rows } = await query(
    `select id, title, publishing_kit, video_object_key, status
       from comoasi.reels where id=$1 limit 1`,
    [reelId]
  );
  const reel = rows[0];
  if (!reel || reel.status !== 'ready' || !reel.video_object_key) throw new Error('upload_post_reel_not_ready');

  const base = clean(process.env.COMOASI_PUBLIC_BASE || 'https://comoasi-reel-worker-production-4de5.up.railway.app').replace(/\/$/, '');
  const videoUrl = `${base}/media/${encodeURIComponent(reelId)}.mp4`;
  const user = clean(process.env.UPLOAD_POST_USER || 'default');
  const idempotencyKey = `comoasi:${reelId}:${selected.slice().sort().join('+')}`;
  const form = new FormData();
  form.append('user', user);
  form.append('video', videoUrl);
  form.append('scheduled_date', scheduledAt);
  for (const network of selected) form.append('platform[]', network);

  const youtube = copyFor(reel, 'youtube');
  const instagram = copyFor(reel, 'instagram');
  form.append('title', selected.includes('youtube') ? youtube.title : instagram.text || instagram.title);
  if (selected.includes('youtube')) {
    form.append('youtube_title', youtube.title);
    form.append('youtube_description', youtube.text);
    form.append('privacyStatus', 'public');
    form.append('defaultLanguage', 'es');
    form.append('defaultAudioLanguage', 'es');
  }
  if (selected.includes('instagram')) {
    form.append('instagram_title', instagram.text || instagram.title);
    form.append('media_type', 'REELS');
    form.append('share_to_feed', 'true');
  }

  const response = await fetch('https://api.upload-post.com/api/upload', {
    method: 'POST',
    headers: {
      Authorization: `Apikey ${clean(process.env.UPLOAD_POST_API_KEY)}`,
      'Idempotency-Key': idempotencyKey,
    },
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok || data?.success === false) {
    throw new Error(`upload_post_failed:${response.status}:${clean(data?.message || data?.error || text).slice(0, 500)}`);
  }
  const jobId = clean(data?.job_id || data?.request_id);
  if (!jobId) throw new Error('upload_post_job_id_missing');

  await saveRows({ reelId, networks: selected, scheduledAt, jobId, idempotencyKey, response: data });
  console.info('[como-asi] Upload-Post fallback scheduled', reelId, selected.join(','), jobId);
  return {
    ok: true,
    provider: 'upload-post',
    duplicatePrevented: false,
    scheduledAt,
    networks: selected,
    jobId,
    idempotencyKey,
    scheduled: selected.map(network => ({ network, postId: jobId, duplicatePrevented: false })),
  };
}
