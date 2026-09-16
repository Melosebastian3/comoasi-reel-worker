import crypto from 'node:crypto';
import { pool, query } from './db.js';
import { studioCall } from './engine.js';

const settingKey = 'metricool_contingency_v1';
const refreshLockKey = 'comoasi_metricool_contingency_refresh';
const metricoolClientId = 'client_1b74aa2c07594a30bbf20f5d1a1efb1a';
const metricoolResource = 'https://ai.metricool.com/mcp';
const defaultTimezone = 'America/Argentina/Buenos_Aires';
const allowedNetworks = new Set(['instagram', 'tiktok', 'youtube']);

const clean = value => String(value || '').trim();
const parseSetting = value => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch { return {}; }
};
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

async function loadConfig() {
  const { rows } = await query('select value, updated_at from comoasi.app_settings where key=$1', [settingKey]);
  if (!rows[0]) return null;
  return { ...parseSetting(rows[0].value), updatedAt: rows[0].updated_at };
}

async function saveConfig(value) {
  const next = { ...value };
  delete next.updatedAt;
  await query(
    `insert into comoasi.app_settings(key, value) values($1,$2::jsonb)
     on conflict(key) do update set value=excluded.value, updated_at=now()`,
    [settingKey, JSON.stringify(next)]
  );
  return next;
}

export async function saveMetricoolContingencyConnection(input = {}) {
  const accessToken = clean(input.accessToken);
  if (!accessToken) throw new Error('metricool_access_required');
  const current = await loadConfig() || {};
  const expiresIn = Math.max(60, Number(input.expiresIn || 3600));
  const refreshToken = clean(input.refreshToken);
  await saveConfig({
    ...current,
    accessTokenEnc: seal(accessToken),
    refreshTokenEnc: refreshToken ? seal(refreshToken) : current.refreshTokenEnc || null,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    connectedAt: current.connectedAt || new Date().toISOString(),
    lastError: null,
  });
  return metricoolContingencyStatus();
}

export async function saveMetricoolContingencyBrand(input = {}) {
  const brandId = clean(input.brandId);
  if (!brandId) throw new Error('metricool_brand_required');
  const current = await loadConfig();
  if (!current?.accessTokenEnc) throw new Error('metricool_connection_required');
  const networks = [...new Set((Array.isArray(input.networks) ? input.networks : [...allowedNetworks])
    .map(item => clean(item).toLowerCase())
    .filter(item => allowedNetworks.has(item)))];
  await saveConfig({
    ...current,
    brandId,
    brandLabel: clean(input.brandLabel) || brandId,
    timezone: clean(input.timezone) || current.timezone || defaultTimezone,
    networks: networks.length ? networks : [...allowedNetworks],
    configuredAt: new Date().toISOString(),
    lastError: null,
  });
  return metricoolContingencyStatus();
}

export async function metricoolContingencyStatus() {
  const value = await loadConfig();
  if (!value) {
    return {
      connected: false,
      renewable: false,
      ready: false,
      brandId: null,
      brandLabel: null,
      timezone: defaultTimezone,
      networks: [...allowedNetworks],
      expiresAt: null,
      lastError: null,
    };
  }
  return {
    connected: Boolean(value.accessTokenEnc),
    renewable: Boolean(value.refreshTokenEnc),
    ready: Boolean(value.accessTokenEnc && value.brandId),
    brandId: value.brandId || null,
    brandLabel: value.brandLabel || null,
    timezone: value.timezone || defaultTimezone,
    networks: Array.isArray(value.networks) && value.networks.length ? value.networks : [...allowedNetworks],
    expiresAt: value.expiresAt || null,
    lastError: value.lastError || null,
  };
}

export async function metricoolContingencyReady() {
  const status = await metricoolContingencyStatus();
  return status.ready;
}

async function refreshedAccessToken(config) {
  const initialToken = open(config.accessTokenEnc);
  const initialExpiry = config.expiresAt ? new Date(config.expiresAt).getTime() : 0;
  if (initialToken && initialExpiry > Date.now() + 180000) return initialToken;

  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('begin');
    transactionOpen = true;
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [refreshLockKey]);
    const locked = await client.query('select value, updated_at from comoasi.app_settings where key=$1', [settingKey]);
    const latest = locked.rows[0]
      ? { ...parseSetting(locked.rows[0].value), updatedAt: locked.rows[0].updated_at }
      : config;
    const accessToken = open(latest.accessTokenEnc);
    const expiresAt = latest.expiresAt ? new Date(latest.expiresAt).getTime() : 0;
    if (accessToken && expiresAt > Date.now() + 180000) {
      await client.query('commit');
      transactionOpen = false;
      return accessToken;
    }

    const refreshToken = open(latest.refreshTokenEnc);
    if (!refreshToken) throw new Error('metricool_reconnect_required');
    const response = await fetch('https://app.metricool.com/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: metricoolClientId,
        refresh_token: refreshToken,
        resource: metricoolResource,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const responseText = await response.text();
    let data = {};
    try { data = responseText ? JSON.parse(responseText) : {}; } catch { data = {}; }
    if (!response.ok || !clean(data.access_token)) {
      const safeError = clean(data.error) || `HTTP_${response.status}`;
      const safeDescription = clean(data.error_description || data.message || data.detail).slice(0, 220);
      const message = `metricool_token_refresh_failed:${response.status}:${safeError}${safeDescription ? `:${safeDescription}` : ''}`;
      await client.query(
        `update comoasi.app_settings
            set value=coalesce(value,'{}'::jsonb) || $2::jsonb, updated_at=now()
          where key=$1`,
        [settingKey, JSON.stringify({ lastError: message })]
      );
      throw new Error(message);
    }

    const next = {
      ...latest,
      accessTokenEnc: seal(data.access_token),
      refreshTokenEnc: clean(data.refresh_token) ? seal(data.refresh_token) : latest.refreshTokenEnc,
      expiresAt: new Date(Date.now() + Number(data.expires_in || 3600) * 1000).toISOString(),
      lastError: null,
    };
    delete next.updatedAt;
    await client.query(
      `insert into comoasi.app_settings(key, value) values($1,$2::jsonb)
       on conflict(key) do update set value=excluded.value, updated_at=now()`,
      [settingKey, JSON.stringify(next)]
    );
    await client.query('commit');
    transactionOpen = false;
    return clean(data.access_token);
  } catch (error) {
    if (transactionOpen) await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function scheduleMetricoolContingency(input = {}) {
  const config = await loadConfig();
  if (!config?.accessTokenEnc || !config?.brandId) throw new Error('metricool_contingency_not_configured');
  const reelId = clean(input.reelId);
  const scheduledAt = clean(input.scheduledAt);
  const requested = [...new Set((Array.isArray(input.networks) ? input.networks : config.networks || [...allowedNetworks])
    .map(item => clean(item).toLowerCase())
    .filter(item => allowedNetworks.has(item)))];
  if (!reelId || !scheduledAt || !requested.length) throw new Error('metricool_schedule_parameters_required');

  const existing = await query(
    `select platform
       from comoasi.publishing_queue
      where reel_id=$1
        and account_key='metricool'
        and platform = any($2::text[])
        and status in ('scheduled','publishing','published')`,
    [reelId, requested]
  );
  const covered = new Set(existing.rows.map(row => clean(row.platform).toLowerCase()));
  const pending = requested.filter(network => !covered.has(network));
  if (!pending.length) {
    return { ok: true, provider: 'metricool', duplicatePrevented: true, networks: requested, scheduledAt };
  }

  const accessToken = await refreshedAccessToken(config);
  const result = await studioCall('/api/metricool/oauth/schedule', {
    accessToken,
    brandId: config.brandId,
    reelId,
    scheduledAt,
    timezone: clean(input.timezone) || config.timezone || defaultTimezone,
    networks: pending,
  }, { timeoutMs: 90000, attempts: 1 });

  await query(
    `update comoasi.publishing_queue
        set status='cancelled',
            publish_payload=coalesce(publish_payload,'{}'::jsonb) || $3::jsonb,
            updated_at=now()
      where reel_id=$1
        and account_key='buffer'
        and platform = any($2::text[])
        and published_at is null`,
    [reelId, pending, JSON.stringify({
      supersededBy: 'metricool',
      supersededAt: new Date().toISOString(),
    })]
  );

  console.info('[como-asi] Metricool contingency scheduled', reelId, pending.join(','), scheduledAt);
  return { ok: true, provider: 'metricool', duplicatePrevented: Boolean(result?.duplicatePrevented), networks: pending, scheduledAt, result };
}
