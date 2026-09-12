import crypto from 'node:crypto';
import { query } from './db.js';
import { studioCall } from './engine.js';

const networks = ['instagram', 'tiktok', 'youtube'];
const requiredEnv = {
  instagram: ['META_APP_ID', 'META_APP_SECRET'],
  tiktok: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'],
  youtube: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
};

const clean = value => String(value || '').trim();
const jsonBody = async response => {
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
};
const configured = network => requiredEnv[network].every(name => clean(process.env[name]));
const encryptionKey = () => {
  const secret = clean(process.env.SOCIAL_TOKEN_ENCRYPTION_KEY);
  if (!secret) throw new Error('SOCIAL_TOKEN_ENCRYPTION_KEY_missing');
  return crypto.createHash('sha256').update(secret).digest();
};
const seal = value => {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
};
const open = value => {
  if (!value) return '';
  const [iv, tag, encrypted] = String(value).split('.').map(part => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
};

export async function ensurePublisherSchema() {
  await query(`create table if not exists comoasi.social_connections(
    network text primary key,
    account_id text,
    account_label text,
    access_token_enc text not null,
    refresh_token_enc text,
    expires_at timestamptz,
    metadata jsonb not null default '{}'::jsonb,
    connected_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`);
  await query("alter table comoasi.publishing_queue add column if not exists status text not null default 'queued'");
  await query('alter table comoasi.publishing_queue add column if not exists started_at timestamptz');
  await query('alter table comoasi.publishing_queue add column if not exists completed_at timestamptz');
  await query('alter table comoasi.publishing_queue add column if not exists external_id text');
  await query('alter table comoasi.publishing_queue add column if not exists error text');
  await query('alter table comoasi.publishing_queue add column if not exists updated_at timestamptz not null default now()');
}

async function connection(network) {
  const { rows } = await query('select * from comoasi.social_connections where network=$1', [network]);
  if (!rows[0]) return null;
  return { ...rows[0], accessToken: open(rows[0].access_token_enc), refreshToken: open(rows[0].refresh_token_enc) };
}

export async function socialStatus() {
  await ensurePublisherSchema();
  const { rows } = await query('select network, account_id, account_label, expires_at, connected_at, metadata from comoasi.social_connections');
  const byNetwork = new Map(rows.map(row => [row.network, row]));
  return networks.map(network => {
    const row = byNetwork.get(network);
    return {
      network,
      configured: configured(network),
      connected: Boolean(row),
      accountId: row?.account_id || null,
      accountLabel: row?.account_label || null,
      connectedAt: row?.connected_at || null,
      review: network === 'tiktok' && process.env.TIKTOK_AUDITED !== 'true' ? 'audit_required_for_public_posts' : network === 'youtube' && process.env.YOUTUBE_API_AUDITED !== 'true' ? 'audit_required_for_public_posts' : null,
      missing: configured(network) ? [] : requiredEnv[network].filter(name => !clean(process.env[name])),
    };
  });
}

export function authorizationUrl({ network, redirectUri, state, codeChallenge }) {
  if (!networks.includes(network)) throw new Error('unsupported_network');
  if (!configured(network)) {
    const error = new Error('developer_credentials_required');
    error.missing = requiredEnv[network].filter(name => !clean(process.env[name]));
    throw error;
  }
  if (!redirectUri || !state) throw new Error('redirect_uri_and_state_required');
  if (network === 'instagram') {
    const params = new URLSearchParams({
      client_id: process.env.META_APP_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'instagram_business_basic,instagram_business_content_publish',
      state,
    });
    return `https://www.instagram.com/oauth/authorize?${params}`;
  }
  if (network === 'tiktok') {
    const params = new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'user.info.basic,video.publish',
      state,
      code_challenge: codeChallenge || '',
      code_challenge_method: 'S256',
    });
    return `https://www.tiktok.com/v2/auth/authorize/?${params}`;
  }
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: codeChallenge || '',
    code_challenge_method: 'S256',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeCode({ network, code, redirectUri, codeVerifier }) {
  if (network === 'instagram') {
    const response = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      body: new URLSearchParams({ client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, grant_type: 'authorization_code', redirect_uri: redirectUri, code }),
      signal: AbortSignal.timeout(20000),
    });
    const token = await jsonBody(response);
    if (!response.ok || !token.access_token) throw new Error('instagram_oauth_failed');
    const longResponse = await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(process.env.META_APP_SECRET)}&access_token=${encodeURIComponent(token.access_token)}`, { signal: AbortSignal.timeout(20000) });
    const longToken = await jsonBody(longResponse);
    return {
      accessToken: longResponse.ok && longToken.access_token ? longToken.access_token : token.access_token,
      refreshToken: '',
      expiresIn: Number(longToken.expires_in || token.expires_in || 5184000),
      accountId: clean(token.user_id),
    };
  }
  if (network === 'tiktok') {
    const response = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY, client_secret: process.env.TIKTOK_CLIENT_SECRET, code, grant_type: 'authorization_code', redirect_uri: redirectUri, code_verifier: codeVerifier || '' }),
      signal: AbortSignal.timeout(20000),
    });
    const token = await jsonBody(response);
    if (!response.ok || !token.access_token) throw new Error('tiktok_oauth_failed');
    return { accessToken: token.access_token, refreshToken: token.refresh_token || '', expiresIn: Number(token.expires_in || 86400), accountId: clean(token.open_id) };
  }
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, code, grant_type: 'authorization_code', redirect_uri: redirectUri, code_verifier: codeVerifier || '' }),
    signal: AbortSignal.timeout(20000),
  });
  const token = await jsonBody(response);
  if (!response.ok || !token.access_token) throw new Error('youtube_oauth_failed');
  return { accessToken: token.access_token, refreshToken: token.refresh_token || '', expiresIn: Number(token.expires_in || 3600), accountId: '' };
}

async function accountProfile(network, token) {
  if (network === 'instagram') {
    const response = await fetch(`https://graph.instagram.com/v23.0/me?fields=user_id,username&access_token=${encodeURIComponent(token.accessToken)}`, { signal: AbortSignal.timeout(15000) });
    const data = await jsonBody(response);
    if (!response.ok) throw new Error('instagram_profile_failed');
    return { id: clean(data.user_id || data.id || token.accountId), label: clean(data.username || 'Instagram') };
  }
  if (network === 'tiktok') {
    const response = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,username', { headers: { Authorization: `Bearer ${token.accessToken}` }, signal: AbortSignal.timeout(15000) });
    const data = await jsonBody(response);
    const user = data?.data?.user || {};
    return { id: clean(user.open_id || token.accountId), label: clean(user.display_name || user.username || 'TikTok') };
  }
  const response = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${token.accessToken}` }, signal: AbortSignal.timeout(15000) });
  const data = await jsonBody(response);
  if (!response.ok || !data.items?.[0]) throw new Error('youtube_channel_required');
  return { id: clean(data.items[0].id), label: clean(data.items[0].snippet?.title || 'YouTube') };
}

export async function finishConnection(input) {
  const { network, code, redirectUri, codeVerifier } = input;
  if (!networks.includes(network) || !code || !redirectUri) throw new Error('oauth_parameters_required');
  const token = await exchangeCode({ network, code, redirectUri, codeVerifier });
  const profile = await accountProfile(network, token);
  const expiresAt = new Date(Date.now() + Math.max(60, token.expiresIn || 3600) * 1000).toISOString();
  await ensurePublisherSchema();
  await query(`insert into comoasi.social_connections(network, account_id, account_label, access_token_enc, refresh_token_enc, expires_at, metadata)
    values($1,$2,$3,$4,$5,$6,$7::jsonb)
    on conflict(network) do update set account_id=excluded.account_id, account_label=excluded.account_label, access_token_enc=excluded.access_token_enc,
      refresh_token_enc=case when excluded.refresh_token_enc is null then comoasi.social_connections.refresh_token_enc else excluded.refresh_token_enc end,
      expires_at=excluded.expires_at, metadata=excluded.metadata, connected_at=now(), updated_at=now()`,
    [network, profile.id, profile.label, seal(token.accessToken), seal(token.refreshToken) || null, expiresAt, JSON.stringify({ provider: network })]);
  return { network, connected: true, accountId: profile.id, accountLabel: profile.label };
}

export async function disconnectSocial(network) {
  if (!networks.includes(network)) throw new Error('unsupported_network');
  await ensurePublisherSchema();
  await query('delete from comoasi.social_connections where network=$1', [network]);
  return { network, connected: false };
}

const joinTags = value => Array.isArray(value) ? value.map(tag => String(tag).startsWith('#') ? String(tag) : `#${tag}`).join(' ') : '';
const publishingCopy = (kit, network, fallbackTitle) => {
  const row = kit?.[network] || {};
  if (network === 'youtube') return { title: clean(row.title || fallbackTitle).slice(0, 100), text: [row.description, joinTags(row.hashtags)].filter(Boolean).join('\n\n').slice(0, 5000) };
  return { title: fallbackTitle, text: [row.caption, joinTags(row.hashtags)].filter(Boolean).join('\n\n') };
};

async function refreshedConnection(network) {
  const row = await connection(network);
  if (!row) throw new Error(`${network}_not_connected`);
  if (!row.expires_at || new Date(row.expires_at).getTime() > Date.now() + 120000 || !row.refreshToken) return row;
  let token;
  if (network === 'tiktok') {
    const response = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY, client_secret: process.env.TIKTOK_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: row.refreshToken }),
      signal: AbortSignal.timeout(20000),
    });
    token = await jsonBody(response);
    if (!response.ok || !token.access_token) throw new Error('tiktok_token_refresh_failed');
  } else if (network === 'youtube') {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: row.refreshToken }),
      signal: AbortSignal.timeout(20000),
    });
    token = await jsonBody(response);
    if (!response.ok || !token.access_token) throw new Error('youtube_token_refresh_failed');
  } else return row;
  const accessToken = token.access_token;
  const refreshToken = token.refresh_token || row.refreshToken;
  const expiresAt = new Date(Date.now() + Number(token.expires_in || 3600) * 1000).toISOString();
  await query('update comoasi.social_connections set access_token_enc=$2, refresh_token_enc=$3, expires_at=$4, updated_at=now() where network=$1', [network, seal(accessToken), seal(refreshToken), expiresAt]);
  return { ...row, accessToken, refreshToken, expires_at: expiresAt };
}

async function publishInstagram(reel, videoUrl) {
  const account = await refreshedConnection('instagram');
  const copy = publishingCopy(reel.publishing_kit, 'instagram', reel.title || reel.topic);
  const params = new URLSearchParams({ media_type: 'REELS', video_url: videoUrl, caption: copy.text, share_to_feed: 'true', access_token: account.accessToken });
  const create = await fetch(`https://graph.instagram.com/v23.0/${encodeURIComponent(account.account_id)}/media`, { method: 'POST', body: params, signal: AbortSignal.timeout(30000) });
  const container = await jsonBody(create);
  if (!create.ok || !container.id) throw new Error('instagram_container_failed');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const status = await fetch(`https://graph.instagram.com/v23.0/${container.id}?fields=status_code,status&access_token=${encodeURIComponent(account.accessToken)}`, { signal: AbortSignal.timeout(15000) });
    const info = await jsonBody(status);
    if (info.status_code === 'FINISHED') break;
    if (info.status_code === 'ERROR' || attempt === 19) throw new Error(`instagram_processing_failed:${clean(info.status || info.status_code)}`);
  }
  const publish = await fetch(`https://graph.instagram.com/v23.0/${encodeURIComponent(account.account_id)}/media_publish`, {
    method: 'POST', body: new URLSearchParams({ creation_id: container.id, access_token: account.accessToken }), signal: AbortSignal.timeout(30000),
  });
  const data = await jsonBody(publish);
  if (!publish.ok || !data.id) throw new Error('instagram_publish_failed');
  return clean(data.id);
}

async function publishTikTok(reel, videoUrl) {
  const account = await refreshedConnection('tiktok');
  const copy = publishingCopy(reel.publishing_kit, 'tiktok', reel.title || reel.topic);
  const response = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
    method: 'POST',
    headers: { Authorization: `Bearer ${account.accessToken}`, 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      post_info: { title: copy.text.slice(0, 2200), privacy_level: 'PUBLIC_TO_EVERYONE', disable_duet: false, disable_comment: false, disable_stitch: false, video_cover_timestamp_ms: 1000, is_aigc: true },
      source_info: { source: 'PULL_FROM_URL', video_url: videoUrl },
    }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await jsonBody(response);
  if (!response.ok || data.error?.code || !data.data?.publish_id) throw new Error(`tiktok_publish_failed:${clean(data.error?.message || data.error?.code)}`);
  return clean(data.data.publish_id);
}

async function publishYoutube(reel, videoUrl) {
  const account = await refreshedConnection('youtube');
  const copy = publishingCopy(reel.publishing_kit, 'youtube', reel.title || reel.topic);
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { Authorization: `Bearer ${account.accessToken}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'video/mp4' },
    body: JSON.stringify({ snippet: { title: copy.title, description: copy.text, categoryId: '24' }, status: { privacyStatus: 'public', selfDeclaredMadeForKids: false, containsSyntheticMedia: true } }),
    signal: AbortSignal.timeout(30000),
  });
  if (!init.ok || !init.headers.get('location')) throw new Error('youtube_upload_session_failed');
  const media = await fetch(videoUrl, { signal: AbortSignal.timeout(60000) });
  if (!media.ok) throw new Error('video_download_failed');
  const bytes = await media.arrayBuffer();
  const upload = await fetch(init.headers.get('location'), { method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.byteLength) }, body: bytes, signal: AbortSignal.timeout(120000) });
  const data = await jsonBody(upload);
  if (!upload.ok || !data.id) throw new Error('youtube_publish_failed');
  return clean(data.id);
}

async function executeQueueRow(row) {
  const { rows } = await query('select * from comoasi.reels where id=$1', [row.reel_id]);
  const reel = rows[0];
  if (!reel || reel.status !== 'ready' || !reel.video_object_key) throw new Error('reel_not_ready');
  const signed = await studioCall('/api/assets/url', { path: reel.video_object_key }, { timeoutMs: 30000, attempts: 2 });
  const videoUrl = clean(signed?.url);
  if (!videoUrl) throw new Error('video_url_unavailable');
  if (row.platform === 'instagram') return publishInstagram(reel, videoUrl);
  if (row.platform === 'tiktok') return publishTikTok(reel, videoUrl);
  if (row.platform === 'youtube') return publishYoutube(reel, videoUrl);
  throw new Error('unsupported_network');
}

let dispatching = false;
async function dispatchPublisherQueue() {
  if (dispatching) return;
  dispatching = true;
  try {
    const { rows } = await query(`select * from comoasi.publishing_queue where status='queued' and scheduled_at<=now() order by scheduled_at asc limit 3`);
    for (const row of rows) {
      const claimed = await query(`update comoasi.publishing_queue set status='publishing', started_at=now(), updated_at=now(), error=null where id=$1 and status='queued' returning *`, [row.id]);
      if (!claimed.rows[0]) continue;
      try {
        const externalId = await executeQueueRow(claimed.rows[0]);
        await query(`update comoasi.publishing_queue set status='published', external_id=$2, completed_at=now(), updated_at=now() where id=$1`, [row.id, externalId]);
      } catch (error) {
        const message = String(error?.message || error).slice(0, 500);
        await query(`update comoasi.publishing_queue set status='failed', error=$2, completed_at=now(), updated_at=now() where id=$1`, [row.id, message]);
        console.error('[como-asi] social publish failed', row.platform, row.id, message);
      }
    }
  } finally { dispatching = false; }
}

export async function queuePublishAll({ reelId, selectedNetworks, scheduledAt }) {
  await ensurePublisherSchema();
  const requested = [...new Set((selectedNetworks || networks).map(clean).filter(network => networks.includes(network)))];
  if (!reelId || !requested.length) throw new Error('reel_and_networks_required');
  const status = await socialStatus();
  const blocked = status.filter(item => requested.includes(item.network) && (!item.configured || !item.connected));
  if (blocked.length) {
    const error = new Error('social_accounts_not_ready');
    error.blocked = blocked;
    throw error;
  }
  const when = scheduledAt && Number.isFinite(new Date(scheduledAt).getTime()) ? new Date(scheduledAt).toISOString() : new Date().toISOString();
  const jobs = [];
  for (const network of requested) {
    const { rows } = await query(`insert into comoasi.publishing_queue(reel_id, platform, account_key, scheduled_at, publish_payload, status)
      values($1,$2,$3,$4,$5::jsonb,'queued') returning *`, [reelId, network, network, when, JSON.stringify({ provider: 'comoasi-native', autoPublish: true })]);
    jobs.push(rows[0]);
  }
  dispatchPublisherQueue().catch(error => console.error('[como-asi] publisher dispatch failed', error));
  return jobs;
}

export function startPublisherDispatcher(intervalMs = 10000) {
  ensurePublisherSchema()
    .then(() => dispatchPublisherQueue())
    .catch(error => console.error('[como-asi] publisher schema failed', error));
  const timer = setInterval(() => dispatchPublisherQueue().catch(error => console.error('[como-asi] publisher scan failed', error)), intervalMs);
  timer.unref();
}
