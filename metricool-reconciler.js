import crypto from 'node:crypto';
import { query } from './db.js';
import { studioCall } from './engine.js';
import { keepMetricoolSessionAlive } from './metricool-automation.js';

const settingKey = 'metricool_automation_v1';
const defaultTimezone = 'America/Argentina/Buenos_Aires';
const clean = value => String(value || '').trim();
const asObject = value => value && typeof value === 'object' ? value : {};

const encryptionKey = () => {
  const secret = clean(process.env.SOCIAL_TOKEN_ENCRYPTION_KEY);
  if (!secret) throw new Error('SOCIAL_TOKEN_ENCRYPTION_KEY_missing');
  return crypto.createHash('sha256').update(secret).digest();
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

async function connectionContext() {
  await keepMetricoolSessionAlive();
  const { rows } = await query('select value from comoasi.app_settings where key=$1 limit 1', [settingKey]);
  const config = parseSetting(rows[0]?.value);
  const accessToken = open(config.accessTokenEnc);
  const brandId = clean(config.brandId);
  if (!accessToken || !brandId) return null;
  return {
    accessToken,
    brandId,
    timezone: clean(config.timezone) || defaultTimezone,
  };
}

function scheduledIso(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

async function candidates() {
  const { rows } = await query(
    `select reel_id, platform, scheduled_at, status, publish_payload
       from comoasi.publishing_queue
      where account_key='metricool'
        and status in ('scheduled','publishing')
        and scheduled_at <= now() - interval '30 seconds'
        and scheduled_at >= now() - interval '72 hours'
      order by scheduled_at asc
      limit 60`
  );
  const groups = new Map();
  for (const row of rows) {
    const scheduledAt = scheduledIso(row.scheduled_at);
    if (!scheduledAt) continue;
    const key = `${row.reel_id}|${scheduledAt}`;
    const list = groups.get(key) || [];
    const network = clean(row.platform).toLowerCase();
    if (network && !list.includes(network)) list.push(network);
    groups.set(key, list);
  }
  return rows.flatMap(row => {
    const scheduledAt = scheduledIso(row.scheduled_at);
    const network = clean(row.platform).toLowerCase();
    if (!scheduledAt || !network) return [];
    return [{
      reelId: clean(row.reel_id),
      network,
      scheduledAt,
      groupNetworks: groups.get(`${row.reel_id}|${scheduledAt}`) || [network],
    }];
  });
}

async function markPublished(result) {
  const reelId = clean(result.reelId);
  const network = clean(result.network).toLowerCase();
  const scheduledAt = scheduledIso(result.scheduledAt);
  const publishedAt = scheduledIso(result.publishedAt) || scheduledAt;
  const externalId = clean(result.externalId);
  const externalUrl = clean(result.externalUrl);
  if (!reelId || !network || !scheduledAt || !publishedAt) return false;
  const payload = {
    provider: 'metricool',
    priority: 1,
    deliveryStatus: 'sent',
    externalLink: externalUrl || null,
    reconciliationState: 'published',
    reconciliationSource: clean(result.source) || 'metricool-analytics',
    reconciliationCheckedAt: new Date().toISOString(),
    publishedAtLocal: clean(result.publishedAtLocal) || null,
  };
  const updated = await query(
    `update comoasi.publishing_queue
        set status='published',
            published_at=$4,
            external_post_id=coalesce(nullif($5,''), external_post_id),
            publish_payload=coalesce(publish_payload,'{}'::jsonb) || $6::jsonb,
            error=null,
            updated_at=now()
      where reel_id=$1
        and platform=$2
        and account_key='metricool'
        and scheduled_at=$3
        and status in ('scheduled','publishing')
      returning id`,
    [reelId, network, scheduledAt, publishedAt, externalId, JSON.stringify(payload)]
  );
  return Boolean(updated.rows[0]);
}

async function markPending(result) {
  const reelId = clean(result.reelId);
  const network = clean(result.network).toLowerCase();
  const scheduledAt = scheduledIso(result.scheduledAt);
  if (!reelId || !network || !scheduledAt) return false;
  const payload = {
    provider: 'metricool',
    priority: 1,
    reconciliationState: clean(result.state) || 'pending',
    reconciliationSource: clean(result.source) || 'metricool-analytics-pending',
    reconciliationCheckedAt: new Date().toISOString(),
    reconciliationLastError: clean(result.error).slice(0, 300) || null,
    reconciliationDiagnostic: result.diagnostic && typeof result.diagnostic === 'object' ? result.diagnostic : null,
    plannerUrl: clean(result.plannerUrl) || null,
    fallbackBlockedUntilConfirmed: true,
  };
  const updated = await query(
    `update comoasi.publishing_queue
        set status=case when scheduled_at <= now() - interval '2 minutes' then 'publishing' else status end,
            publish_payload=coalesce(publish_payload,'{}'::jsonb) || $4::jsonb,
            updated_at=now()
      where reel_id=$1
        and platform=$2
        and account_key='metricool'
        and scheduled_at=$3
        and status in ('scheduled','publishing')
      returning id`,
    [reelId, network, scheduledAt, JSON.stringify(payload)]
  );
  return Boolean(updated.rows[0]);
}

let running = false;

export async function reconcileMetricoolPublications() {
  if (running) return { ok: true, skipped: true, reason: 'already_running' };
  running = true;
  try {
    const context = await connectionContext();
    if (!context) return { ok: true, skipped: true, reason: 'metricool_not_connected' };
    const items = await candidates();
    if (!items.length) return { ok: true, checked: 0, published: 0, pending: 0 };

    const response = asObject(await studioCall('/api/metricool/oauth/reconcile', {
      accessToken: context.accessToken,
      brandId: context.brandId,
      timezone: context.timezone,
      items,
    }, { timeoutMs: 120000, attempts: 1 }));
    const results = Array.isArray(response.results) ? response.results.map(asObject) : [];
    let published = 0;
    let pending = 0;
    for (const result of results) {
      if (clean(result.state) === 'published') {
        if (await markPublished(result)) published += 1;
      } else if (await markPending(result)) {
        pending += 1;
      }
    }
    console.info('[como-asi] Metricool reconciliation complete', JSON.stringify({ checked: items.length, published, pending }));
    return { ok: true, checked: items.length, published, pending, results };
  } catch (error) {
    const message = clean(error?.message || error).slice(0, 500) || 'metricool_reconciliation_failed';
    console.warn('[como-asi] Metricool reconciliation warning', message);
    return { ok: false, error: message };
  } finally {
    running = false;
  }
}

export function startMetricoolReconciliationDispatcher(intervalMs = 60000) {
  const first = setTimeout(() => {
    void reconcileMetricoolPublications();
  }, 10000);
  first.unref?.();
  const timer = setInterval(() => {
    void reconcileMetricoolPublications();
  }, intervalMs);
  timer.unref?.();
  console.info(`[como-asi] Metricool post-publication reconciliation active every ${intervalMs}ms`);
  return timer;
}
