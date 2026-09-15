import { query } from './db.js';
import { createJob } from './pipeline.js';
import { scheduleBufferIdempotent } from './buffer-idempotency.js';

const settingKey = 'metricool_automation_v1';
const defaultTimezone = 'America/Argentina/Buenos_Aires';
const defaultNetworks = ['instagram', 'tiktok', 'youtube'];
const defaultSlots = [
  { key: 'manana', time: '08:00', market: 'argentina' },
  { key: 'mediodia', time: '13:00', market: 'random' },
  { key: 'noche', time: '20:30', market: 'argentina' },
];
const categoryRotations = [
  ['chisme_polemica', 'famosos'],
  ['bizarro_wtf', 'chisme_polemica'],
  ['famosos', 'cultura_pop_actualidad'],
];

const clean = value => String(value || '').trim();
const asObject = value => value && typeof value === 'object' ? value : {};

function parseSetting(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch { return {}; }
}

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

function normalizedConfig(value = {}) {
  const networks = [...new Set((Array.isArray(value.networks) ? value.networks : defaultNetworks)
    .map(item => clean(item).toLowerCase())
    .filter(item => defaultNetworks.includes(item)))];
  return {
    ...value,
    provider: 'buffer',
    enabled: value.enabled !== false,
    timezone: clean(value.timezone) || defaultTimezone,
    networks: networks.length ? networks : defaultNetworks,
    slots: Array.isArray(value.slots) && value.slots.length ? value.slots.slice(0, 3) : defaultSlots,
    brandLabel: clean(value.brandLabel) || 'comoasi.media',
    lastError: null,
  };
}

async function ensureConfig() {
  const current = await loadConfig();
  if (current) return normalizedConfig(current);
  return saveConfig(normalizedConfig({ enabled: true }));
}

export async function saveMetricoolConnection() {
  const value = normalizedConfig(await ensureConfig());
  value.migratedAt = value.migratedAt || new Date().toISOString();
  await saveConfig(value);
  return automationStatus();
}

export async function saveMetricoolBrand(input = {}) {
  const current = normalizedConfig(await ensureConfig());
  const networks = [...new Set((Array.isArray(input.networks) ? input.networks : current.networks)
    .map(item => clean(item).toLowerCase())
    .filter(item => defaultNetworks.includes(item)))];
  const value = {
    ...current,
    provider: 'buffer',
    brandId: clean(input.brandId) || current.brandId || 'buffer',
    brandLabel: clean(input.brandLabel) || current.brandLabel || 'comoasi.media',
    timezone: clean(input.timezone) || current.timezone || defaultTimezone,
    networks: networks.length ? networks : defaultNetworks,
    enabled: true,
    lastError: null,
    migratedAt: current.migratedAt || new Date().toISOString(),
  };
  await saveConfig(value);
  void automationTick();
  return automationStatus();
}

export async function setAutomationEnabled(enabled) {
  const current = normalizedConfig(await ensureConfig());
  const value = {
    ...current,
    enabled: Boolean(enabled),
    lastError: null,
  };
  await saveConfig(value);
  if (value.enabled) void automationTick();
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
    const represented = Date.UTC(
      value('year'),
      value('month') - 1,
      value('day'),
      value('hour'),
      value('minute'),
      value('second')
    );
    guess += target - represented;
  }
  return new Date(guess);
}

function buildDailySlots(dateKey, timezone, configuredSlots) {
  const dayIndex = Math.floor(Date.parse(`${dateKey}T00:00:00Z`) / 86400000);
  const rotation = categoryRotations[Math.abs(dayIndex) % categoryRotations.length];
  const source = Array.isArray(configuredSlots) && configuredSlots.length ? configuredSlots : defaultSlots;
  return source.slice(0, 3).map((slot, index) => {
    const fallback = defaultSlots[index] || defaultSlots[defaultSlots.length - 1];
    const time = clean(slot?.time) || fallback.time;
    const publishAt = zonedTime(dateKey, time, timezone);
    return {
      key: clean(slot?.key) || fallback.key,
      time,
      market: fallback.market,
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
          market: slot.market,
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
        [dateKey, timezone, JSON.stringify(merged), JSON.stringify({ mode: 'autonomous', provider: 'buffer', version: 'v2', approvalsRequired: false })]
      );
    }
    return { ...rows[0], timezone, slots: merged };
  }
  const inserted = await query(
    `insert into comoasi.daily_plans(plan_date, timezone, slots, strategy, status)
     values($1,$2,$3::jsonb,$4::jsonb,'planned')
     on conflict(plan_date) do update set timezone=excluded.timezone
     returning *`,
    [dateKey, timezone, JSON.stringify(desired), JSON.stringify({ mode: 'autonomous', provider: 'buffer', version: 'v2', approvalsRequired: false })]
  );
  return { ...inserted.rows[0], slots: desired };
}

async function savePlan(plan, slots) {
  const complete = slots.every(slot => slot.status === 'scheduled' || slot.status === 'missed');
  await query(
    'update comoasi.daily_plans set slots=$2::jsonb, status=$3, strategy=$4::jsonb where plan_date=$1',
    [
      plan.plan_date,
      JSON.stringify(slots),
      complete ? 'completed' : 'planned',
      JSON.stringify({ mode: 'autonomous', provider: 'buffer', version: 'v2', approvalsRequired: false }),
    ]
  );
}

async function scheduleBuffer({ reelId, scheduledAt, timezone, networks }) {
  return scheduleBufferIdempotent({ reelId, scheduledAt, timezone, networks });
}

export async function scheduleSavedMetricool(input = {}) {
  const config = normalizedConfig(await ensureConfig());
  const allowed = new Set(defaultNetworks);
  const requestedNetworks = [...new Set((Array.isArray(input.networks) ? input.networks : config.networks)
    .map(item => clean(item).toLowerCase())
    .filter(item => allowed.has(item)))];
  const reelId = clean(input.reelId);
  const when = new Date(clean(input.scheduledAt));
  if (!reelId || !Number.isFinite(when.getTime()) || !requestedNetworks.length) {
    throw new Error('buffer_schedule_parameters_required');
  }
  return scheduleBuffer({
    reelId,
    scheduledAt: when.toISOString(),
    timezone: clean(input.timezone) || config.timezone,
    networks: requestedNetworks,
  });
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
    const market = next.market === 'argentina' ? 'argentina' : 'random';
    const job = await createJob({
      payload: {
        category: `${market}:${next.category}`,
        market,
        autonomous: true,
        provider: 'buffer',
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

  if (job.status !== 'completed' || job.reel_status !== 'ready' || !job.video_object_key || !job.reel_id) {
    next.status = 'generating';
    next.error = null;
    return next;
  }

  next.reelId = job.reel_id;
  const scheduledAt = new Date(Math.max(publishMs, now + 15 * 60 * 1000)).toISOString();
  const scheduled = asObject(await scheduleBuffer({
    reelId: job.reel_id,
    scheduledAt,
    timezone: config.timezone,
    networks: config.networks,
  }));

  next.status = 'scheduled';
  next.scheduledAt = scheduledAt;
  next.error = null;
  next.provider = 'buffer';
  next.buffer = {
    duplicatePrevented: Boolean(scheduled.duplicatePrevented),
    scheduled: Array.isArray(scheduled.scheduled) ? scheduled.scheduled : [],
    idempotency: clean(scheduled.idempotency) || null,
  };
  return next;
}

let running = false;

export async function automationTick() {
  if (running) return automationStatus();
  running = true;
  try {
    let config = normalizedConfig(await ensureConfig());
    if (!config.enabled) return automationStatus();

    const dateKey = localDateKey(config.timezone);
    const plan = await loadOrCreatePlan(dateKey, config);
    const slots = [];

    for (const slot of plan.slots) {
      try {
        config = normalizedConfig(await ensureConfig());
        slots.push(await processSlot(slot, config, Date.now()));
      } catch (error) {
        const message = clean(error?.message || error).slice(0, 500) || 'automation_slot_failed';
        slots.push({ ...slot, error: message });
        console.error('[como-asi] Buffer autopilot slot failed', slot?.key, message);
      }
    }

    await savePlan(plan, slots);
    const failed = slots.find(slot => slot.error);
    await saveConfig({
      ...config,
      provider: 'buffer',
      lastRunAt: new Date().toISOString(),
      lastSuccessAt: failed ? config.lastSuccessAt || null : new Date().toISOString(),
      lastError: failed ? failed.error : null,
    });
    return automationStatus();
  } finally {
    running = false;
  }
}

export async function automationStatus() {
  const value = normalizedConfig(await ensureConfig());
  const timezone = value.timezone;
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

  return {
    enabled: value.enabled !== false,
    connected: true,
    renewable: true,
    ready: value.enabled !== false,
    needsReconnect: false,
    provider: 'buffer',
    brandId: value.brandId || 'buffer',
    brandLabel: value.brandLabel || 'comoasi.media',
    timezone,
    networks: value.networks,
    slots: value.slots,
    expiresAt: null,
    lastRunAt: value.lastRunAt || null,
    lastSuccessAt: value.lastSuccessAt || null,
    lastError: value.lastError || null,
    todayPlan,
  };
}

export function startAutomationDispatcher(intervalMs = 60000) {
  void automationTick().catch(error => console.error('[como-asi] Buffer autopilot initial tick failed', error?.message || error));
  const timer = setInterval(() => {
    void automationTick().catch(error => console.error('[como-asi] Buffer autopilot tick failed', error?.message || error));
  }, intervalMs);
  timer.unref?.();
  console.log(`[como-asi] Buffer autopilot dispatcher active every ${intervalMs}ms`);
  return timer;
}
