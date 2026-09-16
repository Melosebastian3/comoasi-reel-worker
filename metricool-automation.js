import crypto from 'node:crypto';
import { pool, query } from './db.js';
import { studioCall } from './engine.js';
import { createJob } from './pipeline.js';
import { scheduleBufferIdempotent } from './buffer-idempotency.js';
import { scheduleUploadPostFallback, uploadPostFallbackReady } from './upload-post-fallback.js';

const settingKey = 'metricool_automation_v1';
const refreshLockKey = 'comoasi_metricool_oauth_refresh';
const defaultTimezone = 'America/Argentina/Buenos_Aires';
const defaultNetworks = ['instagram', 'tiktok', 'youtube'];
const defaultSlots = [
  { key: 'manana', time: '08:00' },
  { key: 'mediodia', time: '13:00' },
  { key: 'noche', time: '20:30' },
];
const categoryRotations = [
  ['chisme_polemica', 'famosos'],
  ['bizarro_wtf', 'chisme_polemica'],
  ['famosos', 'cultura_pop_actualidad'],
];
const metricoolLeaseMs = 30 * 60 * 1000;
const refreshWindowMs = 30 * 60 * 1000;

const clean = value => String(value || '').trim();
const asObject = value => value && typeof value === 'object' ? value : {};
const authNeedsReconnect = value => /metricool_reconnect_required|metricool_token_refresh_failed:400:invalid_grant/i.test(clean(value));
const uncertainMetricoolError = value => /metricool_schedule_uncertain|AbortError|timeout|fetch failed|metricool_mcp_(?:429|5\d\d)/i.test(clean(value));

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

const parseSetting = value => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch { return {}; }
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

export async function saveMetricoolConnection(input = {}) {
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
    networks: current.networks || defaultNetworks,
    timezone: current.timezone || defaultTimezone,
    slots: current.slots || defaultSlots,
    enabled: current.enabled !== false,
    connectedAt: current.connectedAt || new Date().toISOString(),
    lastError: null,
    tokenHealthLastError: null,
  });
  return automationStatus();
}

export async function saveMetricoolBrand(input = {}) {
  const brandId = clean(input.brandId);
  if (!brandId) throw new Error('metricool_brand_required');
  const current = await loadConfig();
  if (!current?.accessTokenEnc) throw new Error('metricool_connection_required');
  const networks = [...new Set((Array.isArray(input.networks) ? input.networks : defaultNetworks)
    .map(value => clean(value).toLowerCase())
    .filter(value => defaultNetworks.includes(value)))];
  await saveConfig({
    ...current,
    provider: 'metricool',
    providerOrder: ['metricool', 'buffer', 'upload-post'],
    brandId,
    brandLabel: clean(input.brandLabel) || brandId,
    timezone: clean(input.timezone) || current.timezone || defaultTimezone,
    networks: networks.length ? networks : defaultNetworks,
    slots: current.slots || defaultSlots,
    enabled: true,
    activatedAt: new Date().toISOString(),
    lastError: null,
  });
  void automationTick();
  return automationStatus();
}

export async function setAutomationEnabled(enabled) {
  const current = await loadConfig();
  if (!current) throw new Error('metricool_connection_required');
  await saveConfig({ ...current, enabled: Boolean(enabled), lastError: enabled ? current.lastError || null : null });
  if (enabled) void automationTick();
  return automationStatus();
}

function localDateKey(timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export async function automationStatus() {
  const value = await loadConfig();
  const timezone = value?.timezone || defaultTimezone;
  const dateKey = localDateKey(timezone);
  const { rows } = await query(
    'select plan_date, timezone, slots, strategy, status from comoasi.daily_plans where plan_date=$1 limit 1',
    [dateKey]
  );
  const todayPlan = rows[0] ? {
    planDate: rows[0].plan_date,
    timezone: rows[0].timezone,
    slots: Array.isArray(rows[0].slots) ? rows[0].slots : [],
    strategy: rows[0].strategy || {},
    status: rows[0].status,
  } : null;
  if (!value) {
    return {
      enabled: false,
      connected: false,
      renewable: false,
      ready: false,
      needsReconnect: false,
      provider: 'metricool',
      providerOrder: ['metricool', 'buffer', 'upload-post'],
      timezone,
      slots: defaultSlots,
      networks: defaultNetworks,
      todayPlan,
    };
  }
  const needsReconnect = authNeedsReconnect(value.lastError);
  return {
    enabled: value.enabled !== false,
    connected: Boolean(value.accessTokenEnc),
    renewable: Boolean(value.refreshTokenEnc) && !needsReconnect,
    ready: Boolean(value.accessTokenEnc && value.brandId && !needsReconnect),
    needsReconnect,
    provider: 'metricool',
    providerOrder: ['metricool', 'buffer', 'upload-post'],
    brandId: value.brandId || null,
    brandLabel: value.brandLabel || null,
    timezone,
    networks: value.networks || defaultNetworks,
    slots: value.slots || defaultSlots,
    expiresAt: value.expiresAt || null,
    lastRunAt: value.lastRunAt || null,
    lastSuccessAt: value.lastSuccessAt || null,
    lastError: value.lastError || null,
    tokenHealthLastError: value.tokenHealthLastError || null,
    todayPlan,
  };
}

async function requestRefreshToken(refreshToken) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch('https://app.metricool.com/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: 'client_1b74aa2c07594a30bbf20f5d1a1efb1a',
          refresh_token: refreshToken,
          resource: 'https://ai.metricool.com/mcp',
        }),
        signal: AbortSignal.timeout(20000),
      });
      const responseText = await response.text();
      let data = {};
      try { data = responseText ? JSON.parse(responseText) : {}; } catch { data = {}; }
      if (response.ok && clean(data.access_token)) return data;

      const safeError = clean(data.error) || `HTTP_${response.status}`;
      const safeDescription = clean(data.error_description || data.message || data.detail).slice(0, 220);
      const message = `metricool_token_refresh_failed:${response.status}:${safeError}${safeDescription ? `:${safeDescription}` : ''}`;
      if (response.status === 400 || response.status === 401 || response.status === 403) throw new Error(message);
      lastError = new Error(message);
    } catch (error) {
      lastError = error;
      if (authNeedsReconnect(error?.message || error)) throw error;
    }
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1200 * attempt));
  }
  throw lastError || new Error('metricool_token_refresh_failed');
}

async function refreshedAccessToken(config, windowMs = refreshWindowMs) {
  const initialAccessToken = open(config.accessTokenEnc);
  const initialExpiresAt = config.expiresAt ? new Date(config.expiresAt).getTime() : 0;
  if (initialAccessToken && initialExpiresAt > Date.now() + windowMs) return initialAccessToken;

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
    if (accessToken && expiresAt > Date.now() + windowMs) {
      await client.query('commit');
      transactionOpen = false;
      return accessToken;
    }

    const refreshToken = open(latest.refreshTokenEnc);
    if (!refreshToken) throw new Error('metricool_reconnect_required');
    const data = await requestRefreshToken(refreshToken);
    const next = {
      ...latest,
      accessTokenEnc: seal(data.access_token),
      refreshTokenEnc: clean(data.refresh_token) ? seal(data.refresh_token) : latest.refreshTokenEnc,
      expiresAt: new Date(Date.now() + Number(data.expires_in || 3600) * 1000).toISOString(),
      lastError: null,
      tokenHealthLastError: null,
      tokenRefreshedAt: new Date().toISOString(),
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

async function activeNetworks(reelId, networks) {
  const { rows } = await query(
    `select distinct platform
       from comoasi.publishing_queue
      where reel_id=$1
        and platform = any($2::text[])
        and (status in ('scheduled','publishing','published') or published_at is not null)`,
    [reelId, networks]
  );
  return new Set(rows.map(row => clean(row.platform).toLowerCase()));
}

async function reserveMetricoolNetworks({ reelId, networks, scheduledAt }) {
  const alreadyActive = await activeNetworks(reelId, networks);
  const candidates = networks.filter(network => !alreadyActive.has(network));
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + metricoolLeaseMs).toISOString();
  const acquired = [];
  const failedBefore = [];

  for (const network of candidates) {
    const payload = {
      provider: 'metricool',
      priority: 1,
      leaseToken,
      leaseExpiresAt,
      reservationKey: `metricool:${reelId}:${network}`,
      reservedAt: new Date().toISOString(),
    };
    const inserted = await query(
      `insert into comoasi.publishing_queue
        (reel_id, platform, account_key, scheduled_at, status, publish_payload, error)
       values($1,$2,'metricool',$3,'publishing',$4::jsonb,null)
       on conflict (reel_id, platform, account_key, scheduled_at) where account_key='metricool'
       do nothing
       returning *`,
      [reelId, network, scheduledAt, JSON.stringify(payload)]
    );
    if (inserted.rows[0]) {
      acquired.push(network);
      continue;
    }

    const existing = await query(
      `select * from comoasi.publishing_queue
        where reel_id=$1 and platform=$2 and account_key='metricool' and scheduled_at=$3
        order by updated_at desc limit 1`,
      [reelId, network, scheduledAt]
    );
    const row = existing.rows[0];
    if (row && !['scheduled', 'publishing', 'published'].includes(clean(row.status))) failedBefore.push(network);
    else if (row) alreadyActive.add(network);
  }

  return { leaseToken, acquired, alreadyActive, failedBefore };
}

async function completeMetricoolReservation({ reelId, networks, scheduledAt, leaseToken, result }) {
  const plannerUrl = clean(result?.plannerUrl) || null;
  await query(
    `update comoasi.publishing_queue
        set status='scheduled',
            publish_payload=(coalesce(publish_payload,'{}'::jsonb) - 'leaseToken' - 'leaseExpiresAt') || $5::jsonb,
            error=null,
            updated_at=now()
      where reel_id=$1
        and platform = any($2::text[])
        and account_key='metricool'
        and scheduled_at=$3
        and publish_payload->>'leaseToken'=$4`,
    [reelId, networks, scheduledAt, leaseToken, JSON.stringify({
      provider: 'metricool',
      priority: 1,
      plannerUrl,
      duplicatePrevented: Boolean(result?.duplicatePrevented),
      confirmedAt: new Date().toISOString(),
    })]
  );
}

async function failMetricoolReservation({ reelId, networks, scheduledAt, leaseToken, error, uncertain = false }) {
  const message = clean(error?.message || error).slice(0, 500) || 'metricool_schedule_failed';
  await query(
    `update comoasi.publishing_queue
        set status=$5,
            publish_payload=(coalesce(publish_payload,'{}'::jsonb) - 'leaseToken' - 'leaseExpiresAt') || $6::jsonb,
            error=$7,
            updated_at=now()
      where reel_id=$1
        and platform = any($2::text[])
        and account_key='metricool'
        and scheduled_at=$3
        and publish_payload->>'leaseToken'=$4`,
    [
      reelId,
      networks,
      scheduledAt,
      leaseToken,
      uncertain ? 'publishing' : 'failed',
      JSON.stringify({ provider: 'metricool', priority: 1, uncertain, failedAt: new Date().toISOString() }),
      message,
    ]
  );
}

async function scheduleMetricoolPrimary({ reelId, scheduledAt, timezone, networks }) {
  const config = await loadConfig();
  if (!config?.accessTokenEnc || !config?.brandId || authNeedsReconnect(config.lastError)) {
    return { ok: false, fallbackNetworks: networks, error: 'metricool_reconnect_required' };
  }

  let accessToken;
  try {
    accessToken = await refreshedAccessToken(config);
  } catch (error) {
    const message = clean(error?.message || error);
    const latest = await loadConfig() || config;
    await saveConfig({
      ...latest,
      lastError: authNeedsReconnect(message) ? message : latest.lastError || null,
      tokenHealthLastError: message,
    });
    return { ok: false, fallbackNetworks: networks, error: message };
  }

  const reservation = await reserveMetricoolNetworks({ reelId, networks, scheduledAt });
  const fallbackNetworks = [...reservation.failedBefore];
  if (!reservation.acquired.length) {
    return {
      ok: true,
      provider: 'metricool',
      duplicatePrevented: true,
      coveredNetworks: [...reservation.alreadyActive],
      fallbackNetworks,
      scheduledAt,
    };
  }

  try {
    const result = asObject(await studioCall('/api/metricool/oauth/schedule', {
      accessToken,
      brandId: config.brandId,
      reelId,
      scheduledAt,
      timezone,
      networks: reservation.acquired,
    }, { timeoutMs: 90000, attempts: 1 }));
    await completeMetricoolReservation({
      reelId,
      networks: reservation.acquired,
      scheduledAt,
      leaseToken: reservation.leaseToken,
      result,
    });
    console.info('[como-asi] Metricool primary scheduled', reelId, reservation.acquired.join(','), scheduledAt);
    return {
      ok: true,
      provider: 'metricool',
      duplicatePrevented: Boolean(result.duplicatePrevented),
      coveredNetworks: [...reservation.alreadyActive, ...reservation.acquired],
      fallbackNetworks,
      scheduledAt,
      result,
    };
  } catch (error) {
    const message = clean(error?.message || error);
    const uncertain = uncertainMetricoolError(message);
    await failMetricoolReservation({
      reelId,
      networks: reservation.acquired,
      scheduledAt,
      leaseToken: reservation.leaseToken,
      error,
      uncertain,
    });
    if (uncertain) {
      console.warn('[como-asi] Metricool outcome uncertain; fail-closed to prevent duplicates', reelId, reservation.acquired.join(','));
      return {
        ok: true,
        provider: 'metricool',
        uncertain: true,
        coveredNetworks: [...reservation.alreadyActive, ...reservation.acquired],
        fallbackNetworks,
        scheduledAt,
        error: message,
      };
    }
    console.warn('[como-asi] Metricool primary unavailable; falling back to Buffer', reelId, reservation.acquired.join(','), message);
    return {
      ok: false,
      provider: 'metricool',
      coveredNetworks: [...reservation.alreadyActive],
      fallbackNetworks: [...new Set([...fallbackNetworks, ...reservation.acquired])],
      scheduledAt,
      error: message,
    };
  }
}

async function scheduleWithPriority({ reelId, scheduledAt, timezone, networks }) {
  const requested = [...new Set(networks.map(item => clean(item).toLowerCase()).filter(item => defaultNetworks.includes(item)))];
  const results = [];
  const metricool = await scheduleMetricoolPrimary({ reelId, scheduledAt, timezone, networks: requested });
  results.push({ provider: 'metricool', ...metricool });

  let pending = Array.isArray(metricool.fallbackNetworks) ? metricool.fallbackNetworks : [];
  if (pending.length) {
    try {
      const buffer = asObject(await scheduleBufferIdempotent({ reelId, scheduledAt, timezone, networks: pending }));
      results.push({ provider: 'buffer', ...buffer });
      pending = [];
    } catch (error) {
      const active = await activeNetworks(reelId, pending);
      const stillPending = pending.filter(network => !active.has(network));
      results.push({ provider: 'buffer', ok: false, error: clean(error?.message || error), coveredNetworks: [...active] });
      pending = stillPending;
    }
  }

  if (pending.length && uploadPostFallbackReady()) {
    try {
      const uploadPost = asObject(await scheduleUploadPostFallback({
        reelId,
        scheduledAt,
        networks: pending,
        allowFailedBufferTakeover: true,
      }));
      results.push({ provider: 'upload-post', ...uploadPost });
      pending = [];
    } catch (error) {
      results.push({ provider: 'upload-post', ok: false, error: clean(error?.message || error) });
    }
  }

  const active = await activeNetworks(reelId, requested);
  const unresolved = requested.filter(network => !active.has(network));
  const uncertain = Boolean(metricool.uncertain) || results.some(item => item.provider === 'buffer' && item.ok === false && Array.isArray(item.coveredNetworks) && item.coveredNetworks.length);
  if (unresolved.length) {
    const detail = results.map(item => `${item.provider}:${item.ok === false ? item.error || 'failed' : 'ok'}`).join(';');
    const error = new Error(`publisher_chain_exhausted:${unresolved.join(',')}:${detail}`);
    error.unresolved = unresolved;
    throw error;
  }

  const providers = requested.map(network => {
    const provider = ['metricool', 'buffer', 'upload-post'].find(name => results.some(item => {
      if (item.provider !== name) return false;
      const covered = new Set([...(item.coveredNetworks || []), ...(item.networks || []), ...((item.scheduled || []).map(row => clean(row.network)))]);
      return covered.has(network) || (name === 'buffer' && item.ok !== false && pending.length === 0);
    })) || 'existing';
    return { network, provider };
  });

  const distinctProviders = [...new Set(providers.map(item => item.provider))];
  return {
    ok: true,
    provider: distinctProviders.length === 1 ? distinctProviders[0] : 'hybrid',
    providerOrder: ['metricool', 'buffer', 'upload-post'],
    scheduledAt,
    networks: requested,
    providers,
    uncertain,
    results,
  };
}

export async function scheduleSavedMetricool(input = {}) {
  const config = await loadConfig() || {};
  const requestedNetworks = [...new Set((Array.isArray(input.networks) ? input.networks : config.networks || defaultNetworks)
    .map(value => clean(value).toLowerCase())
    .filter(value => defaultNetworks.includes(value)))];
  const reelId = clean(input.reelId);
  const when = new Date(clean(input.scheduledAt));
  if (!reelId || !Number.isFinite(when.getTime()) || !requestedNetworks.length) {
    throw new Error('publisher_schedule_parameters_required');
  }
  return scheduleWithPriority({
    reelId,
    scheduledAt: when.toISOString(),
    timezone: clean(input.timezone) || config.timezone || defaultTimezone,
    networks: requestedNetworks,
  });
}

function zonedTime(dateKey, time, timezone) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(guess));
    const value = type => Number(parts.find(part => part.type === type)?.value || 0);
    const represented = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'));
    guess += target - represented;
  }
  return new Date(guess);
}

function buildDailySlots(dateKey, timezone, configuredSlots) {
  const dayIndex = Math.floor(Date.parse(dateKey + 'T00:00:00Z') / 86400000);
  const rotation = categoryRotations[Math.abs(dayIndex) % categoryRotations.length];
  const source = Array.isArray(configuredSlots) && configuredSlots.length ? configuredSlots : defaultSlots;
  return source.slice(0, 3).map((slot, index) => {
    const fallback = defaultSlots[index] || defaultSlots[defaultSlots.length - 1];
    const time = clean(slot.time) || fallback.time;
    const publishAt = zonedTime(dateKey, time, timezone);
    return {
      key: clean(slot.key) || fallback.key,
      time,
      category: rotation[index % rotation.length],
      generateAt: new Date(publishAt.getTime() - 6 * 60 * 60 * 1000).toISOString(),
      publishAt: publishAt.toISOString(),
      status: 'planned',
      jobId: null,
      reelId: null,
      retryCount: 0,
    };
  });
}

async function loadOrCreatePlan(dateKey, config) {
  const timezone = config.timezone || defaultTimezone;
  const desired = buildDailySlots(dateKey, timezone, config.slots);
  const { rows } = await query('select * from comoasi.daily_plans where plan_date=$1 limit 1', [dateKey]);
  if (rows[0]) {
    const current = Array.isArray(rows[0].slots) ? rows[0].slots : [];
    const now = Date.now();
    const merged = desired.map(slot => {
      const saved = current.find(candidate => clean(candidate?.key) === slot.key || clean(candidate?.time) === slot.time);
      if (saved) {
        return {
          ...slot,
          ...saved,
          key: slot.key,
          time: slot.time,
          category: clean(saved.category) || slot.category,
          generateAt: slot.generateAt,
          publishAt: slot.publishAt,
        };
      }
      return new Date(slot.publishAt).getTime() <= now ? { ...slot, status: 'missed' } : slot;
    });
    if (JSON.stringify(current) !== JSON.stringify(merged) || rows[0].timezone !== timezone) {
      await query(
        'update comoasi.daily_plans set timezone=$2, slots=$3::jsonb, strategy=$4::jsonb where plan_date=$1',
        [dateKey, timezone, JSON.stringify(merged), JSON.stringify({ mode: 'autonomous', provider: 'metricool', providerOrder: ['metricool', 'buffer', 'upload-post'], version: 'v3', approvalsRequired: false })]
      );
    }
    return { ...rows[0], timezone, slots: merged };
  }
  const inserted = await query(
    `insert into comoasi.daily_plans(plan_date, timezone, slots, strategy, status)
     values($1,$2,$3::jsonb,$4::jsonb,'planned')
     on conflict(plan_date) do update set timezone=excluded.timezone
     returning *`,
    [dateKey, timezone, JSON.stringify(desired), JSON.stringify({ mode: 'autonomous', provider: 'metricool', providerOrder: ['metricool', 'buffer', 'upload-post'], version: 'v3', approvalsRequired: false })]
  );
  return { ...inserted.rows[0], slots: desired };
}

async function savePlan(plan, slots) {
  await query(
    'update comoasi.daily_plans set slots=$2::jsonb, status=$3, strategy=$4::jsonb where plan_date=$1',
    [
      plan.plan_date,
      JSON.stringify(slots),
      slots.every(slot => slot.status === 'scheduled' || slot.status === 'missed') ? 'scheduled' : 'planned',
      JSON.stringify({ mode: 'autonomous', provider: 'metricool', providerOrder: ['metricool', 'buffer', 'upload-post'], version: 'v3', approvalsRequired: false }),
    ]
  );
}

async function processSlot(slot, config, now) {
  const next = { ...slot };
  if (next.status === 'scheduled' || next.status === 'missed') return next;
  const publishMs = new Date(next.publishAt).getTime();
  const generateMs = new Date(next.generateAt).getTime();

  if (!next.jobId && now >= publishMs) {
    next.status = 'missed';
    next.error = null;
    return next;
  }

  if (!next.jobId && now >= generateMs) {
    const job = await createJob({
      payload: {
        category: next.category,
        autonomous: true,
        provider: 'metricool',
        slotKey: next.key,
        plannedPublishAt: next.publishAt,
      },
    });
    next.jobId = job.id;
    next.status = 'generating';
    next.error = null;
    return next;
  }

  if (!next.jobId) return next;
  const { rows } = await query(
    `select j.status, j.error, j.reel_id, r.status as reel_status, r.video_object_key
       from comoasi.reel_jobs j
       left join comoasi.reels r on r.id=j.reel_id
      where j.id=$1`,
    [next.jobId]
  );
  const job = rows[0];
  if (!job) {
    next.jobId = null;
    next.reelId = null;
    next.status = 'planned';
    next.error = null;
    return next;
  }

  if (job.status === 'failed') {
    if (Number(next.retryCount || 0) < 2) {
      await query(
        `update comoasi.reel_jobs
            set status='queued', stage='queued', progress=0, error=null, completed_at=null, updated_at=now()
          where id=$1 and status='failed'`,
        [next.jobId]
      );
      next.retryCount = Number(next.retryCount || 0) + 1;
      next.status = 'retrying';
      next.error = clean(job.error).slice(0, 300) || null;
      return next;
    }
    next.status = 'failed';
    next.error = clean(job.error).slice(0, 300) || 'generation_failed';
    return next;
  }

  if (job.status !== 'completed' || job.reel_status !== 'ready' || !job.reel_id || !job.video_object_key) {
    next.status = 'generating';
    next.error = null;
    return next;
  }

  next.reelId = job.reel_id;
  const stableScheduledAt = clean(next.scheduledAt) || new Date(Math.max(publishMs, now + 15 * 60 * 1000)).toISOString();
  next.scheduledAt = stableScheduledAt;
  try {
    const scheduled = asObject(await scheduleWithPriority({
      reelId: job.reel_id,
      scheduledAt: stableScheduledAt,
      timezone: config.timezone || defaultTimezone,
      networks: config.networks || defaultNetworks,
    }));
    next.status = scheduled.uncertain ? 'publishing' : 'scheduled';
    next.provider = clean(scheduled.provider) || 'metricool';
    next.providerOrder = ['metricool', 'buffer', 'upload-post'];
    next.publisher = scheduled;
    next.error = null;
    return next;
  } catch (error) {
    next.status = 'retrying';
    next.error = clean(error?.message || error).slice(0, 500) || 'publisher_chain_failed';
    return next;
  }
}

let running = false;

export async function automationTick() {
  if (running) return automationStatus();
  running = true;
  try {
    let config = await loadConfig();
    if (!config?.enabled) return automationStatus();
    const dateKey = localDateKey(config.timezone || defaultTimezone);
    const plan = await loadOrCreatePlan(dateKey, config);
    const slots = [];
    for (const slot of plan.slots) {
      try {
        config = await loadConfig() || config;
        slots.push(await processSlot(slot, config, Date.now()));
      } catch (error) {
        const message = clean(error?.message || error).slice(0, 500) || 'automation_slot_failed';
        slots.push({ ...slot, error: message });
        console.error('[como-asi] publisher autopilot slot failed', slot?.key, message);
      }
    }

    await savePlan(plan, slots);
    const latest = await loadConfig() || config || {};
    const firstError = slots.find(slot => slot.error)?.error || null;
    const nowIso = new Date().toISOString();
    await saveConfig({
      ...latest,
      provider: 'metricool',
      providerOrder: ['metricool', 'buffer', 'upload-post'],
      lastRunAt: nowIso,
      lastSuccessAt: firstError ? latest.lastSuccessAt || null : nowIso,
      lastError: authNeedsReconnect(firstError) ? firstError : latest.lastError && authNeedsReconnect(latest.lastError) ? latest.lastError : null,
      lastPublisherError: firstError,
    });
    console.info(`[como-asi] plan ${dateKey}: ${slots.map(slot => `${slot.key}=${slot.status}:${slot.provider || 'pending'}`).join(', ')}`);
    return automationStatus();
  } finally {
    running = false;
  }
}

export async function keepMetricoolSessionAlive() {
  const config = await loadConfig();
  if (!config?.accessTokenEnc || !config?.refreshTokenEnc) return automationStatus();
  try {
    await refreshedAccessToken(config, refreshWindowMs);
  } catch (error) {
    const message = clean(error?.message || error).slice(0, 500);
    const latest = await loadConfig() || config;
    await saveConfig({
      ...latest,
      lastError: authNeedsReconnect(message) ? message : latest.lastError || null,
      tokenHealthLastError: message,
      tokenHealthCheckedAt: new Date().toISOString(),
    });
    console.warn('[como-asi] Metricool session keeper warning', message);
  }
  return automationStatus();
}

export function startAutomationDispatcher(intervalMs = 60000) {
  void keepMetricoolSessionAlive().catch(error => console.error('[como-asi] Metricool session keeper startup failed', clean(error?.message || error)));
  const keeper = setInterval(() => {
    void keepMetricoolSessionAlive().catch(error => console.error('[como-asi] Metricool session keeper failed', clean(error?.message || error)));
  }, 10 * 60 * 1000);
  keeper.unref?.();

  void automationTick().catch(error => console.error('[como-asi] automation startup failed', error));
  const timer = setInterval(() => {
    void automationTick().catch(error => console.error('[como-asi] automation tick failed', error));
  }, intervalMs);
  timer.unref?.();
  console.log(`[como-asi] Metricool-first planner active every ${intervalMs}ms; token keeper every 600000ms`);
  return timer;
}
