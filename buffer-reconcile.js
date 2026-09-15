import { query } from './db.js';
import { studioCall } from './engine.js';

const settingKey = 'metricool_automation_v1';
const defaultTimezone = 'America/Argentina/Buenos_Aires';
const defaultNetworks = ['instagram', 'tiktok', 'youtube'];

const clean = value => String(value || '').trim();
const asObject = value => value && typeof value === 'object' ? value : {};

function parseSetting(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch { return {}; }
}

async function reconcile() {
  const settings = await query('select value from comoasi.app_settings where key=$1', [settingKey]);
  const config = parseSetting(settings.rows[0]?.value);
  const timezone = clean(config.timezone) || defaultTimezone;
  const networks = Array.isArray(config.networks) && config.networks.length ? config.networks : defaultNetworks;

  const { rows } = await query(
    `select plan_date, slots
       from comoasi.daily_plans
      where plan_date=(now() at time zone $1)::date
      limit 1`,
    [timezone]
  );
  const plan = rows[0];
  if (!plan || !Array.isArray(plan.slots)) {
    console.log('[como-asi] Buffer reconcile: no current plan');
    return;
  }

  let changed = false;
  const slots = [];
  for (const original of plan.slots) {
    const slot = { ...original };
    const existingResults = Array.isArray(slot.buffer?.results) ? slot.buffer.results : [];
    const scheduledAt = clean(slot.scheduledAt);
    const reelId = clean(slot.reelId);
    const shouldReconcile = slot.status === 'scheduled'
      && slot.provider === 'buffer'
      && reelId
      && scheduledAt
      && existingResults.length === 0;

    if (!shouldReconcile) {
      slots.push(slot);
      continue;
    }

    const when = new Date(scheduledAt);
    if (!Number.isFinite(when.getTime()) || when.getTime() < Date.now() + 60000) {
      console.log('[como-asi] Buffer reconcile skipped expired slot', slot.key, scheduledAt);
      slots.push(slot);
      continue;
    }

    const response = asObject(await studioCall('/api/buffer/schedule', {
      reelId,
      scheduledAt: when.toISOString(),
      timezone,
      networks,
    }, { timeoutMs: 120000, attempts: 3 }));

    const results = Array.isArray(response.results) ? response.results : [];
    slot.buffer = {
      results,
      reconciledAt: new Date().toISOString(),
      duplicatePrevented: results.length > 0 && results.every(item => Boolean(item?.duplicatePrevented)),
    };
    changed = true;
    console.log('[como-asi] Buffer reconcile result', JSON.stringify({
      slot: slot.key,
      reelId,
      scheduledAt,
      results: results.map(item => ({
        network: item?.network,
        channelId: item?.channelId,
        postId: item?.postId,
        duplicatePrevented: Boolean(item?.duplicatePrevented),
      })),
    }));
    slots.push(slot);
  }

  if (changed) {
    await query(
      'update comoasi.daily_plans set slots=$2::jsonb where plan_date=$1',
      [plan.plan_date, JSON.stringify(slots)]
    );
  }
  console.log('[como-asi] Buffer reconcile complete', changed ? 'updated' : 'clean');
}

reconcile()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('[como-asi] Buffer reconcile failed', error?.message || error);
    process.exit(1);
  });
