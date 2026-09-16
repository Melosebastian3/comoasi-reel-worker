import crypto from 'node:crypto';
import { query } from './db.js';
import { studioCall } from './engine.js';
import { keepMetricoolSessionAlive } from './metricool-automation.js';
import { scheduleBufferIdempotent } from './buffer-idempotency.js';

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
        and (
          status in ('scheduled','publishing')
          or (
            status='published'
            and coalesce(publish_payload->>'publishedAtExact','false')='false'
          )
        )
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
  const exactPublishedAt = scheduledIso(result.publishedAt);
  const publishedAtExact = Boolean(exactPublishedAt) && result.publishedAtExact !== false;
  const externalId = clean(result.externalId);
  const externalUrl = clean(result.externalUrl);
  if (!reelId || !network || !scheduledAt) return false;
  const payload = {
    provider: 'metricool',
    priority: 1,
    deliveryStatus: 'published',
    externalLink: externalUrl || null,
    reconciliationState: 'published',
    reconciliationSource: clean(result.source) || 'metricool-planner-provider-status',
    reconciliationCheckedAt: new Date().toISOString(),
    publicationConfirmedAt: clean(result.confirmedAt) || new Date().toISOString(),
    publishedAtExact,
    publishedAtSource: publishedAtExact ? 'metricool-analytics' : 'awaiting-metricool-analytics',
    publishedAtLocal: clean(result.publishedAtLocal) || null,
    fallbackBlockedUntilConfirmed: false,
  };
  const updated = await query(
    `update comoasi.publishing_queue
        set status='published',
            published_at=case when $7::boolean then $4::timestamptz else published_at end,
            external_post_id=coalesce(nullif($5,''), external_post_id),
            publish_payload=coalesce(publish_payload,'{}'::jsonb) || $6::jsonb,
            error=null,
            updated_at=now()
      where reel_id=$1
        and platform=$2
        and account_key='metricool'
        and scheduled_at=$3
        and (
          status in ('scheduled','publishing')
          or (status='published' and coalesce(publish_payload->>'publishedAtExact','false')='false')
        )
      returning id`,
    [reelId, network, scheduledAt, exactPublishedAt || null, externalId, JSON.stringify(payload), publishedAtExact]
  );
  return Boolean(updated.rows[0]);
}

function confirmedProviderFailure(result) {
  const diagnostic = asObject(result.diagnostic);
  const remoteSummary = asObject(diagnostic.remoteSummary);
  const providers = Array.isArray(remoteSummary.providers) ? remoteSummary.providers.map(asObject) : [];
  const network = clean(result.network).toLowerCase();
  const provider = providers.find(item => clean(item.network).toLowerCase() === network);
  if (!provider) return null;
  const status = clean(provider.status).toUpperCase();
  if (!['FAILED', 'ERROR', 'FAILURE', 'REJECTED'].includes(status)) return null;
  return {
    status,
    error: clean(provider.error || provider.detailedStatus || status).slice(0, 500),
  };
}

async function setMetricoolFallbackPayload(reelId, network, patch, status = null, error = null) {
  const params = [reelId, network, JSON.stringify(patch), status, error];
  await query(
    `update comoasi.publishing_queue
        set publish_payload=coalesce(publish_payload,'{}'::jsonb) || $3::jsonb,
            status=coalesce($4,status),
            error=$5,
            updated_at=now()
      where reel_id=$1 and platform=$2 and account_key='metricool'`,
    params
  );
}

function ambiguousBufferError(value) {
  return /AbortError|timeout|timed out|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i.test(clean(value));
}

async function handleConfirmedMetricoolFailure(result, context, failure) {
  const reelId = clean(result.reelId);
  const network = clean(result.network).toLowerCase();
  const detectedAt = new Date().toISOString();
  await setMetricoolFallbackPayload(reelId, network, {
    reconciliationState: 'failed',
    reconciliationSource: 'metricool-planner-provider-status',
    reconciliationCheckedAt: detectedAt,
    metricoolFailureStatus: failure.status,
    metricoolFailureError: failure.error,
    fallbackBlockedUntilConfirmed: false,
    fallbackState: 'buffer-scheduling',
    fallbackTriggeredAt: detectedAt,
  }, 'failed', failure.error || `metricool_${failure.status.toLowerCase()}`);

  const fallbackScheduledAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  try {
    const buffer = await scheduleBufferIdempotent({
      reelId,
      scheduledAt: fallbackScheduledAt,
      timezone: context.timezone,
      networks: [network],
    });
    await setMetricoolFallbackPayload(reelId, network, {
      fallbackState: 'buffer-scheduled',
      fallbackProvider: 'buffer',
      fallbackScheduledAt,
      fallbackConfirmedAt: new Date().toISOString(),
      fallbackDuplicatePrevented: Boolean(buffer?.duplicatePrevented),
    }, 'failed', failure.error || null);
    console.warn('[como-asi] Metricool confirmed failure handed to Buffer', reelId, network, failure.status);
    return { ok: true, provider: 'buffer', scheduledAt: fallbackScheduledAt };
  } catch (error) {
    const message = clean(error?.message || error).slice(0, 500) || 'buffer_fallback_failed';
    if (ambiguousBufferError(message)) {
      await setMetricoolFallbackPayload(reelId, network, {
        fallbackState: 'buffer-uncertain',
        fallbackProvider: 'buffer',
        fallbackLastError: message,
        fallbackBlockedUntilConfirmed: true,
        fallbackCheckedAt: new Date().toISOString(),
      }, 'failed', failure.error || null);
      console.error('[como-asi] Buffer fallback outcome uncertain; fail-closed', reelId, network, message);
      return { ok: false, uncertain: true, error: message };
    }

    await query(
      `update comoasi.publishing_queue
          set status='failed',
              error=$3,
              publish_payload=coalesce(publish_payload,'{}'::jsonb) || $4::jsonb,
              updated_at=now()
        where reel_id=$1
          and platform=$2
          and account_key='buffer'
          and external_post_id is null
          and status='publishing'`,
      [reelId, network, message, JSON.stringify({
        failedAfterMetricoolTakeover: true,
        failureConfirmedAt: new Date().toISOString(),
      })]
    );
    await setMetricoolFallbackPayload(reelId, network, {
      fallbackState: 'buffer-failed-contingency',
      fallbackProvider: 'buffer',
      fallbackLastError: message,
      fallbackBlockedUntilConfirmed: false,
      fallbackCheckedAt: new Date().toISOString(),
    }, 'failed', failure.error || null);
    console.warn('[como-asi] Buffer fallback failed definitively; contingency will try Upload-Post', reelId, network, message);
    return { ok: false, provider: 'buffer', error: message };
  }
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
    if (!items.length) return { ok: true, checked: 0, published: 0, pending: 0, failed: 0 };

    const response = asObject(await studioCall('/api/metricool/oauth/reconcile', {
      accessToken: context.accessToken,
      brandId: context.brandId,
      timezone: context.timezone,
      items,
    }, { timeoutMs: 120000, attempts: 1 }));
    const results = Array.isArray(response.results) ? response.results.map(asObject) : [];
    let published = 0;
    let pending = 0;
    let failed = 0;
    for (const result of results) {
      if (clean(result.state) === 'published') {
        if (await markPublished(result)) published += 1;
        continue;
      }
      const failure = confirmedProviderFailure(result);
      if (failure) {
        await handleConfirmedMetricoolFailure(result, context, failure);
        failed += 1;
        continue;
      }
      if (await markPending(result)) pending += 1;
    }
    console.info('[como-asi] Metricool reconciliation complete', JSON.stringify({ checked: items.length, published, pending, failed }));
    return { ok: true, checked: items.length, published, pending, failed, results };
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
