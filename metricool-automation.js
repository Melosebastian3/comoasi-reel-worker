import crypto from 'node:crypto';
import { query } from './db.js';
import { studioCall } from './engine.js';
import { createJob } from './pipeline.js';

const settingKey = 'metricool_automation_v1';
const defaultTimezone = 'America/Argentina/Buenos_Aires';
const defaultNetworks = ['instagram', 'tiktok', 'youtube'];
const defaultSlots = [
  { key: 'mediodia', time: '13:00' },
  { key: 'noche', time: '20:30' },
];
const categoryRotations = [
  ['chisme_polemica', 'famosos'],
  ['bizarro_wtf', 'chisme_polemica'],
  ['famosos', 'cultura_pop_actualidad'],
];

const clean = value => String(value || '').trim();
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
  await query(
    `insert into comoasi.app_settings(key, value) values($1,$2::jsonb)
     on conflict(key) do update set value=excluded.value, updated_at=now()`,
    [settingKey, JSON.stringify(value)]
  );
  return value;
}

export async function saveMetricoolConnection(input) {
  const accessToken = clean(input?.accessToken);
  if (!accessToken) throw new Error('metricool_access_required');
  const current = await loadConfig() || {};
  const expiresIn = Math.max(60, Number(input?.expiresIn || 3600));
  const value = {
    ...current,
    accessTokenEnc: seal(accessToken),
    refreshTokenEnc: clean(input?.refreshToken) ? seal(input.refreshToken) : current.refreshTokenEnc || null,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    networks: current.networks || defaultNetworks,
    timezone: current.timezone || defaultTimezone,
    slots: current.slots || defaultSlots,
    enabled: current.enabled !== false,
    connectedAt: current.connectedAt || new Date().toISOString(),
    lastError: null,
  };
  delete value.updatedAt;
  await saveConfig(value);
  return automationStatus();
}

export async function saveMetricoolBrand(input) {
  const brandId = clean(input?.brandId);
  if (!brandId) throw new Error('metricool_brand_required');
  const current = await loadConfig();
  if (!current?.accessTokenEnc) throw new Error('metricool_connection_required');
  const networks = [...new Set((Array.isArray(input?.networks) ? input.networks : defaultNetworks)
    .map(value => clean(value).toLowerCase())
    .filter(value => defaultNetworks.includes(value)))];
  const value = {
    ...current,
    brandId,
    brandLabel: clean(input?.brandLabel) || brandId,
    timezone: clean(input?.timezone) || current.timezone || defaultTimezone,
    networks: networks.length ? networks : defaultNetworks,
    slots: current.slots || defaultSlots,
    enabled: true,
    activatedAt: new Date().toISOString(),
    lastError: null,
  };
  delete value.updatedAt;
  await saveConfig(value);
  void automationTick();
  return automationStatus();
}

export async function setAutomationEnabled(enabled) {
  const current = await loadConfig();
  if (!current) throw new Error('metricool_connection_required');
  const value = { ...current, enabled: Boolean(enabled), lastError: null };
  delete value.updatedAt;
  await saveConfig(value);
  if (value.enabled) void automationTick();
  return automationStatus();
}

export async function automationStatus() {
  const value = await loadConfig();
  const timezone = value?.timezone || defaultTimezone;
  const dateKey = localDateKey(timezone);
  const { rows } = await query('select plan_date, timezone, slots, strategy, status from comoasi.daily_plans where plan_date=$1 limit 1', [dateKey]);
  const todayPlan = rows[0] ? {
    planDate: rows[0].plan_date,
    timezone: rows[0].timezone,
    slots: Array.isArray(rows[0].slots) ? rows[0].slots : [],
    strategy: rows[0].strategy || {},
    status: rows[0].status,
  } : null;
  if (!value) return { enabled: false, connected: false, ready: false, timezone, slots: defaultSlots, networks: defaultNetworks, todayPlan };
  return {
    enabled: value.enabled !== false,
    connected: Boolean(value.accessTokenEnc),
    renewable: Boolean(value.refreshTokenEnc),
    ready: Boolean(value.accessTokenEnc && value.brandId),
    brandId: value.brandId || null,
    brandLabel: value.brandLabel || null,
    timezone,
    networks: value.networks || defaultNetworks,
    slots: value.slots || defaultSlots,
    expiresAt: value.expiresAt || null,
    lastRunAt: value.lastRunAt || null,
    lastSuccessAt: value.lastSuccessAt || null,
    lastError: value.lastError || null,
    todayPlan,
  };
}

async function refreshedAccessToken(config) {
  const accessToken = open(config.accessTokenEnc);
  const expiresAt = config.expiresAt ? new Date(config.expiresAt).getTime() : 0;
  if (accessToken && expiresAt > Date.now() + 180000) return accessToken;
  const refreshToken = open(config.refreshTokenEnc);
  if (!refreshToken) throw new Error('metricool_reconnect_required');
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
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !clean(data.access_token)) throw new Error('metricool_token_refresh_failed');
  const next = {
    ...config,
    accessTokenEnc: seal(data.access_token),
    refreshTokenEnc: clean(data.refresh_token) ? seal(data.refresh_token) : config.refreshTokenEnc,
    expiresAt: new Date(Date.now() + Number(data.expires_in || 3600) * 1000).toISOString(),
    lastError: null,
  };
  delete next.updatedAt;
  await saveConfig(next);
  return clean(data.access_token);
}

export async function scheduleSavedMetricool(input) {
  const config = await loadConfig();
  if (!config?.accessTokenEnc || !config?.brandId) throw new Error('metricool_reconnect_required');
  const accessToken = await refreshedAccessToken(config);
  const allowed = new Set(defaultNetworks);
  const requestedNetworks = [...new Set((Array.isArray(input?.networks) ? input.networks : config.networks || defaultNetworks)
    .map(value => clean(value).toLowerCase())
    .filter(value => allowed.has(value)))];
  if (!clean(input?.reelId) || !clean(input?.scheduledAt) || !requestedNetworks.length) {
    throw new Error('metricool_schedule_parameters_required');
  }
  return studioCall('/api/metricool/oauth/schedule', {
    accessToken,
    brandId: config.brandId,
    reelId: clean(input.reelId),
    scheduledAt: clean(input.scheduledAt),
    timezone: clean(input?.timezone) || config.timezone || defaultTimezone,
    networks: requestedNetworks,
  }, { timeoutMs: 90000, attempts: 1 });
}

function localDateKey(timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
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
  return source.slice(0, 2).map((slot, index) => {
    const publishAt = zonedTime(dateKey, clean(slot.time) || defaultSlots[index].time, timezone);
    return {
      key: clean(slot.key) || defaultSlots[index].key,
      time: clean(slot.time) || defaultSlots[index].time,
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
  const { rows } = await query('select * from comoasi.daily_plans where plan_date=$1 limit 1', [dateKey]);
  if (rows[0]) return { ...rows[0], slots: Array.isArray(rows[0].slots) ? rows[0].slots : [] };
  const slots = buildDailySlots(dateKey, config.timezone || defaultTimezone, config.slots);
  const inserted = await query(
    `insert into comoasi.daily_plans(plan_date, timezone, slots, strategy, status)
     values($1,$2,$3::jsonb,$4::jsonb,'planned')
     on conflict(plan_date) do update set timezone=excluded.timezone
     returning *`,
    [dateKey, config.timezone || defaultTimezone, JSON.stringify(slots), JSON.stringify({ mode: 'autonomous', version: 'v1', approvalsRequired: false })]
  );
  return { ...inserted.rows[0], slots };
}

async function savePlan(plan, slots) {
  await query('update comoasi.daily_plans set slots=$2::jsonb, status=$3 where plan_date=$1', [
    plan.plan_date,
    JSON.stringify(slots),
    slots.every(slot => slot.status === 'scheduled') ? 'scheduled' : 'planned',
  ]);
}

async function processSlot(slot, config, now) {
  const next = { ...slot };
  if (!next.jobId && now >= new Date(next.generateAt).getTime()) {
    const job = await createJob({ payload: { category: next.category, autonomous: true, slotKey: next.key, plannedPublishAt: next.publishAt } });
    next.jobId = job.id;
    next.status = 'generating';
    return next;
  }
  if (!next.jobId || next.status === 'scheduled') return next;

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
    next.status = 'planned';
    return next;
  }
  if (job.status === 'failed') {
    if (Number(next.retryCount || 0) < 2) {
      await query(`update comoasi.reel_jobs set status='queued', stage='queued', progress=0, error=null, completed_at=null, updated_at=now() where id=$1`, [next.jobId]);
      next.retryCount = Number(next.retryCount || 0) + 1;
      next.status = 'retrying';
    } else {
      next.status = 'failed';
      next.error = clean(job.error).slice(0, 300);
    }
    return next;
  }
  if (job.status !== 'completed' || job.reel_status !== 'ready' || !job.reel_id || !job.video_object_key) {
    next.status = 'generating';
    return next;
  }

  const accessToken = await refreshedAccessToken(config);
  const requested = new Date(next.publishAt).getTime();
  const scheduledAt = new Date(Math.max(requested, now + 15 * 60 * 1000)).toISOString();
  await studioCall('/api/metricool/oauth/schedule', {
    accessToken,
    brandId: config.brandId,
    reelId: job.reel_id,
    scheduledAt,
    timezone: config.timezone || defaultTimezone,
    networks: config.networks || defaultNetworks,
  }, { timeoutMs: 90000, attempts: 1 });
  next.reelId = job.reel_id;
  next.scheduledAt = scheduledAt;
  next.status = 'scheduled';
  next.error = null;
  return next;
}

let running = false;
export async function automationTick() {
  if (running) return automationStatus();
  running = true;
  try {
    let config = await loadConfig();
    if (!config?.enabled || !config?.accessTokenEnc || !config?.brandId) return automationStatus();
    const dateKey = localDateKey(config.timezone || defaultTimezone);
    const plan = await loadOrCreatePlan(dateKey, config);
    const slots = [];
    for (const slot of plan.slots) {
      try {
        config = await loadConfig() || config;
        slots.push(await processSlot(slot, config, Date.now()));
      } catch (error) {
        const message = clean(error?.message || error).slice(0, 300);
        slots.push({ ...slot, error: message });
        const failedConfig = { ...config, lastError: message, lastRunAt: new Date().toISOString() };
        delete failedConfig.updatedAt;
        await saveConfig(failedConfig);
      }
    }
    await savePlan(plan, slots);
    const latest = await loadConfig() || config;
    const firstError = slots.find(slot => slot.error)?.error || null;
    const nowIso = new Date().toISOString();
    const saved = { ...latest, lastRunAt: nowIso, lastSuccessAt: firstError ? latest.lastSuccessAt || null : nowIso, lastError: firstError };
    delete saved.updatedAt;
    await saveConfig(saved);
    console.info(`[como-asi] plan ${dateKey}: ${slots.map(slot => `${slot.key}=${slot.status}`).join(', ')}`);
    return automationStatus();
  } finally {
    running = false;
  }
}

export function startAutomationDispatcher(intervalMs = 60000) {
  void automationTick().catch(error => console.error('[como-asi] automation startup failed', error));
  const timer = setInterval(() => {
    void automationTick().catch(error => console.error('[como-asi] automation tick failed', error));
  }, intervalMs);
  timer.unref?.();
  console.log(`[como-asi] autonomous planner active every ${intervalMs}ms`);
}
