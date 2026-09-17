import crypto from 'node:crypto';
import { query } from './db.js';
import { studioCall } from './engine.js';

const settingKey = 'metricool_automation_v1';
const defaultTimezone = 'America/Argentina/Buenos_Aires';
const clean = value => String(value ?? '').trim();
const asObject = value => value && typeof value === 'object' ? value : {};
const numeric = value => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};
const bounded = (value, min = 0, max = 100) => Math.max(min, Math.min(max, numeric(value)));

function parseSetting(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch { return {}; }
}

function encryptionKey() {
  const secret = clean(process.env.SOCIAL_TOKEN_ENCRYPTION_KEY);
  if (!secret) throw new Error('SOCIAL_TOKEN_ENCRYPTION_KEY_missing');
  return crypto.createHash('sha256').update(secret).digest();
}

function open(value) {
  if (!value) return '';
  const [iv, tag, encrypted] = String(value).split('.').map(part => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

async function loadMetricoolConfig() {
  const { rows } = await query('select value from comoasi.app_settings where key=$1 limit 1', [settingKey]);
  return rows[0] ? parseSetting(rows[0].value) : null;
}

async function patchMetricoolConfig(patch) {
  await query(
    `update comoasi.app_settings
        set value=coalesce(value,'{}'::jsonb) || $2::jsonb,
            updated_at=now()
      where key=$1`,
    [settingKey, JSON.stringify(patch)]
  );
}

export async function validateMetricoolBrandAccess() {
  const config = await loadMetricoolConfig();
  const brandId = clean(config?.brandId);
  const accessToken = open(config?.accessTokenEnc);
  if (!brandId || !accessToken) {
    const result = { accessible: false, reason: 'metricool_connection_incomplete' };
    await patchMetricoolConfig({ brandAccessOk: false, brandAccessCheckedAt: new Date().toISOString(), brandAccessError: result.reason });
    return result;
  }

  try {
    const response = asObject(await studioCall('/api/metricool/oauth/brand-health', {
      accessToken,
      brandId,
      timezone: clean(config?.timezone) || defaultTimezone,
    }, { timeoutMs: 60000, attempts: 1 }));
    const accessible = response.accessible === true;
    const reason = accessible ? null : clean(response.reason) || 'metricool_brand_access_denied';
    await patchMetricoolConfig({
      brandAccessOk: accessible,
      brandAccessCheckedAt: new Date().toISOString(),
      brandAccessError: reason,
    });
    return { accessible, reason, brandId, availableBrands: response.availableBrands || null };
  } catch (error) {
    const reason = clean(error?.message || error).slice(0, 500) || 'metricool_brand_health_failed';
    await patchMetricoolConfig({ brandAccessOk: false, brandAccessCheckedAt: new Date().toISOString(), brandAccessError: reason });
    return { accessible: false, reason, brandId };
  }
}

function publicUrl(payload) {
  const body = asObject(payload);
  return clean(body.externalLink || body.externalUrl || body.publicUrl || body.plannerUrl) || null;
}

export async function syncPublishedLedger() {
  const { rows } = await query(`
    select reel_id, platform, external_post_id, published_at, publish_payload
      from comoasi.publishing_queue
     where status='published'
       and external_post_id is not null
       and published_at is not null
       and published_at >= now() - interval '30 days'
       and platform in ('instagram','tiktok','youtube')
     order by published_at desc
  `);

  let upserted = 0;
  for (const row of rows) {
    await query(
      `insert into comoasi.platform_posts
        (reel_id, platform, external_post_id, url, published_at, metrics, last_synced_at)
       values($1,$2,$3,$4,$5,'{}'::jsonb,null)
       on conflict(platform, external_post_id) do update set
         reel_id=coalesce(excluded.reel_id, comoasi.platform_posts.reel_id),
         url=coalesce(excluded.url, comoasi.platform_posts.url),
         published_at=coalesce(excluded.published_at, comoasi.platform_posts.published_at),
         updated_at=now()`,
      [row.reel_id, row.platform, clean(row.external_post_id), publicUrl(row.publish_payload), row.published_at]
    );
    upserted += 1;
  }
  return { scanned: rows.length, upserted };
}

function videoIdFromUrl(platform, url) {
  const value = clean(url);
  if (!value) return '';
  if (platform === 'tiktok') return value.match(/\/video\/(\d+)/i)?.[1] || '';
  if (platform === 'youtube') return value.match(/[?&]v=([^&]+)/i)?.[1] || value.match(/\/shorts\/([^/?]+)/i)?.[1] || '';
  if (platform === 'instagram') return value.match(/\/(?:reel|p)\/([^/?]+)/i)?.[1] || '';
  return '';
}

function analyticsIdentity(network, row) {
  if (network === 'instagram') return { id: clean(row.IGRE04), url: clean(row.IGRE06) };
  if (network === 'tiktok') return { id: videoIdFromUrl('tiktok', row.TKPO03), url: clean(row.TKPO03) };
  if (network === 'youtube') return { id: clean(row.YTVP04), url: clean(row.YTVP05) };
  return { id: '', url: '' };
}

function normalizePerformance(network, row) {
  if (network === 'instagram') {
    return {
      source: 'metricool', socialExternalId: clean(row.IGRE04), views: numeric(row.IGRE23), reach: numeric(row.IGRE11), likes: numeric(row.IGRE10), comments: numeric(row.IGRE07), shares: numeric(row.IGRE21), saves: numeric(row.IGRE12), reposts: numeric(row.IGRE29), interactions: numeric(row.IGRE09), engagement: numeric(row.IGRE08), averageWatchTime: numeric(row.IGRE24), totalWatchTime: numeric(row.IGRE25), retention: numeric(row.IGRE27), viewRate: numeric(row.IGRE28), raw: row,
    };
  }
  if (network === 'tiktok') {
    return {
      source: 'metricool', socialExternalId: videoIdFromUrl('tiktok', row.TKPO03), views: numeric(row.TKPO07), reach: numeric(row.TKPO11), likes: numeric(row.TKPO08), comments: numeric(row.TKPO09), shares: numeric(row.TKPO10), interactions: numeric(row.TKPO08) + numeric(row.TKPO09) + numeric(row.TKPO10), engagement: numeric(row.TKPO9999), fullVideoWatchedRate: numeric(row.TKPO13), totalWatchTime: numeric(row.TKPO14), averageWatchTime: numeric(row.TKPO15), duration: numeric(row.TKPO06), raw: row,
    };
  }
  return {
    source: 'metricool', socialExternalId: clean(row.YTVP04), views: numeric(row.YTVP06), likes: numeric(row.YTVP09), comments: numeric(row.YTVP11), shares: numeric(row.YTVP12), interactions: numeric(row.YTVP09) + numeric(row.YTVP11) + numeric(row.YTVP12), watchMinutes: numeric(row.YTVP07), averageViewDuration: numeric(row.YTVP08), raw: row,
  };
}

function urlsEquivalent(left, right) {
  const a = clean(left).replace(/\/$/, '');
  const b = clean(right).replace(/\/$/, '');
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

export async function syncMetricoolPerformance() {
  const config = await loadMetricoolConfig();
  if (!config?.brandAccessOk) return { skipped: true, reason: 'metricool_brand_not_accessible' };
  const accessToken = open(config.accessTokenEnc);
  const brandId = clean(config.brandId);
  if (!accessToken || !brandId) return { skipped: true, reason: 'metricool_connection_incomplete' };

  const to = new Date();
  const from = new Date(to.getTime() - 30 * 86400000);
  const response = asObject(await studioCall('/api/metricool/oauth/performance', {
    accessToken,
    brandId,
    from: from.toISOString(),
    to: to.toISOString(),
  }, { timeoutMs: 120000, attempts: 1 }));
  const networks = asObject(response.networks);
  const { rows: posts } = await query(`
    select id, platform, external_post_id, url
      from comoasi.platform_posts
     where published_at >= now() - interval '30 days'
       and platform in ('instagram','tiktok','youtube')
  `);

  let matched = 0;
  for (const network of ['instagram', 'tiktok', 'youtube']) {
    const analyticsRows = Array.isArray(networks[network]) ? networks[network] : [];
    const candidates = posts.filter(post => post.platform === network);
    for (const row of analyticsRows) {
      const identity = analyticsIdentity(network, asObject(row));
      const post = candidates.find(item => {
        const platformId = videoIdFromUrl(network, item.url);
        return (identity.id && (identity.id === clean(item.external_post_id) || identity.id === platformId)) || urlsEquivalent(identity.url, item.url);
      });
      if (!post) continue;
      const metrics = normalizePerformance(network, asObject(row));
      await query(
        `update comoasi.platform_posts
            set metrics=coalesce(metrics,'{}'::jsonb) || $2::jsonb,
                url=coalesce(nullif($3,''),url),
                last_synced_at=now(),
                updated_at=now()
          where id=$1`,
        [post.id, JSON.stringify(metrics), identity.url]
      );
      matched += 1;
    }
  }
  return { matched, errors: response.errors || {} };
}

function interactionCount(metrics) {
  const explicit = numeric(metrics.interactions);
  if (explicit > 0) return explicit;
  return numeric(metrics.likes) + numeric(metrics.comments) + numeric(metrics.shares) + numeric(metrics.saves);
}

function retentionPercent(platform, metrics, durationSeconds) {
  if (platform === 'instagram') return bounded(metrics.retention);
  if (platform === 'tiktok') return bounded(metrics.fullVideoWatchedRate);
  if (platform === 'youtube' && numeric(metrics.averageViewDuration) > 0 && durationSeconds > 0) {
    return bounded((numeric(metrics.averageViewDuration) / durationSeconds) * 100);
  }
  return 0;
}

export async function rebuildViralLearning() {
  const { rows } = await query(`
    select p.platform, p.metrics, p.reel_id, r.category, r.topic, r.title, r.duration_seconds,
           coalesce((select em.protagonist from comoasi.editorial_memory em where em.topic=r.topic order by em.created_at desc limit 1),'') as protagonist
      from comoasi.platform_posts p
      join comoasi.reels r on r.id=p.reel_id
     where p.published_at >= now() - interval '30 days'
       and p.last_synced_at is not null
  `);

  const byReel = new Map();
  for (const row of rows) {
    const metrics = asObject(row.metrics);
    const views = numeric(metrics.views);
    if (views <= 0) continue;
    const key = clean(row.reel_id);
    const item = byReel.get(key) || {
      reelId: key, category: clean(row.category), topic: clean(row.topic), title: clean(row.title), protagonist: clean(row.protagonist), views: 0, interactions: 0, retentions: [], networks: new Set(),
    };
    item.views += views;
    item.interactions += interactionCount(metrics);
    const retention = retentionPercent(row.platform, metrics, numeric(row.duration_seconds) || 60);
    if (retention > 0) item.retentions.push(retention);
    item.networks.add(row.platform);
    byReel.set(key, item);
  }

  const reels = [...byReel.values()].map(item => ({
    ...item,
    networkCount: item.networks.size,
    engagementRate: item.views > 0 ? item.interactions / item.views : 0,
    retention: item.retentions.length ? item.retentions.reduce((a, b) => a + b, 0) / item.retentions.length : 0,
  }));
  if (!reels.length) return { learned: 0, reason: 'no_real_metric_samples' };

  const maxViews = Math.max(...reels.map(item => item.views), 1);
  const maxEngagement = Math.max(...reels.map(item => item.engagementRate), 0.000001);
  const maxRetention = Math.max(...reels.map(item => item.retention), 1);
  for (const item of reels) {
    const viewComponent = Math.log1p(item.views) / Math.log1p(maxViews);
    const engagementComponent = Math.min(1, item.engagementRate / maxEngagement);
    const retentionComponent = item.retention > 0 ? Math.min(1, item.retention / maxRetention) : 0;
    item.score = Math.round((0.60 * viewComponent + 0.25 * engagementComponent + 0.15 * retentionComponent) * 10000) / 100;
  }

  const groups = new Map();
  const addGroup = (category, patternType, patternKey, item) => {
    if (!patternKey) return;
    const key = `${category}|${patternType}|${patternKey}`;
    const group = groups.get(key) || { category, patternType, patternKey, samples: [] };
    group.samples.push(item);
    groups.set(key, group);
  };
  for (const item of reels) {
    addGroup(item.category, 'category', item.category, item);
    addGroup(item.category, 'protagonist', item.protagonist, item);
  }

  for (const group of groups.values()) {
    const score = group.samples.reduce((sum, item) => sum + item.score, 0) / group.samples.length;
    const metrics = {
      views: group.samples.reduce((sum, item) => sum + item.views, 0),
      interactions: group.samples.reduce((sum, item) => sum + item.interactions, 0),
      averageEngagementRate: group.samples.reduce((sum, item) => sum + item.engagementRate, 0) / group.samples.length,
      averageRetention: group.samples.reduce((sum, item) => sum + item.retention, 0) / group.samples.length,
      reelIds: group.samples.map(item => item.reelId),
    };
    await query(
      `insert into comoasi.viral_learning(category, pattern_type, pattern_key, score, sample_size, metrics, notes, last_seen_at)
       values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,now())
       on conflict(category, pattern_type, pattern_key) do update set
         score=excluded.score,
         sample_size=excluded.sample_size,
         metrics=excluded.metrics,
         notes=excluded.notes,
         last_seen_at=excluded.last_seen_at,
         updated_at=now()`,
      [group.category, group.patternType, group.patternKey, score, group.samples.length, JSON.stringify(metrics), JSON.stringify({ source: 'metricool-real-performance-v1', windowDays: 30 })]
    );
  }

  const categoryScores = {};
  for (const group of groups.values()) {
    if (group.patternType !== 'category') continue;
    categoryScores[group.category] = Math.round((group.samples.reduce((sum, item) => sum + item.score, 0) / group.samples.length) * 100) / 100;
  }
  const topPosts = [...reels].sort((a, b) => b.score - a.score).slice(0, 10).map(item => ({ reelId: item.reelId, title: item.title, category: item.category, protagonist: item.protagonist, score: item.score, views: item.views, interactions: item.interactions, retention: item.retention, networkCount: item.networkCount }));
  await query(
    `insert into comoasi.metric_snapshots(snapshot_date, source, strategy, category_scores, signals, top_posts, raw_data)
     values((now() at time zone 'America/Argentina/Buenos_Aires')::date,'metricool-performance',$1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb)
     on conflict(snapshot_date,source) do update set
       strategy=excluded.strategy,
       category_scores=excluded.category_scores,
       signals=excluded.signals,
       top_posts=excluded.top_posts,
       raw_data=excluded.raw_data,
       updated_at=now()`,
    [JSON.stringify({ model: 'real-performance-v1', weights: { views: 0.60, engagement: 0.25, retention: 0.15 }, windowDays: 30 }), JSON.stringify(categoryScores), JSON.stringify({ realMetricSamples: reels.length, generatedAt: new Date().toISOString() }), JSON.stringify(topPosts), JSON.stringify({ reels: topPosts })]
  );
  return { learned: groups.size, reels: reels.length, topPosts: topPosts.length };
}

let cycleRunning = false;
export async function runPerformanceLearningCycle() {
  if (cycleRunning) return { ok: true, skipped: true, reason: 'already_running' };
  cycleRunning = true;
  try {
    const ledger = await syncPublishedLedger();
    const health = await validateMetricoolBrandAccess();
    let performance = { skipped: true, reason: 'metricool_brand_not_accessible' };
    if (health.accessible) performance = await syncMetricoolPerformance();
    const learning = await rebuildViralLearning();
    const result = { ok: true, ledger, health, performance, learning };
    console.info('[como-asi] performance learning cycle complete', JSON.stringify(result));
    return result;
  } catch (error) {
    const message = clean(error?.message || error).slice(0, 500);
    console.warn('[como-asi] performance learning cycle warning', message);
    return { ok: false, error: message };
  } finally {
    cycleRunning = false;
  }
}

export function startPerformanceLearningDispatcher(intervalMs = 30 * 60 * 1000) {
  const initial = setTimeout(() => { void runPerformanceLearningCycle(); }, 20000);
  initial.unref?.();
  const timer = setInterval(() => { void runPerformanceLearningCycle(); }, Math.max(10 * 60 * 1000, intervalMs));
  timer.unref?.();
  const healthTimer = setInterval(() => {
    void validateMetricoolBrandAccess().then(result => console.info('[como-asi] Metricool brand health', JSON.stringify(result))).catch(error => console.warn('[como-asi] Metricool brand health warning', clean(error?.message || error)));
  }, 10 * 60 * 1000);
  healthTimer.unref?.();
  console.info(`[como-asi] real performance learning active every ${Math.max(10 * 60 * 1000, intervalMs)}ms; brand health every 600000ms`);
  return { timer, healthTimer };
}
