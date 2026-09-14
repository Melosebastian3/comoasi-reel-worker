import crypto from 'node:crypto';
import { query } from './db.js';
import { studioCall } from './engine.js';
import { automationStatus, saveMetricoolBrand } from './metricool-automation.js';

const settingKey = 'metricool_automation_v1';
const defaultTimezone = 'America/Argentina/Buenos_Aires';
const defaultNetworks = ['instagram', 'tiktok', 'youtube'];
const clean = value => String(value || '').trim();

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

async function loadConfig() {
  const { rows } = await query('select value from comoasi.app_settings where key=$1', [settingKey]);
  return rows[0] ? parseSetting(rows[0].value) : null;
}

export async function recoverMetricoolAutomation() {
  const config = await loadConfig();
  if (!config?.accessTokenEnc || !config?.brandId) {
    return { ok: false, skipped: true, reason: 'metricool_not_connected', status: await automationStatus() };
  }
  if (config.enabled !== false) {
    return { ok: true, skipped: true, reason: 'metricool_already_enabled', status: await automationStatus() };
  }

  const accessToken = open(config.accessTokenEnc);
  if (!accessToken) throw new Error('metricool_repair_access_missing');
  const expiresAt = config.expiresAt ? new Date(config.expiresAt).getTime() : 0;
  if (expiresAt && expiresAt <= Date.now() + 60000) throw new Error('metricool_repair_access_expired');

  const networks = Array.isArray(config.networks) && config.networks.length ? config.networks : defaultNetworks;
  const timezone = clean(config.timezone) || defaultTimezone;
  const cleanup = await studioCall('/api/metricool/oauth/cleanup', {
    accessToken,
    brandId: clean(config.brandId),
    timezone,
    networks,
  }, { timeoutMs: 180000, attempts: 1 });

  if (!cleanup?.ok) throw new Error(cleanup?.error || 'metricool_repair_cleanup_failed');

  const status = await saveMetricoolBrand({
    brandId: clean(config.brandId),
    brandLabel: clean(config.brandLabel) || clean(config.brandId),
    timezone,
    networks,
  });

  return { ok: true, skipped: false, cleanup: cleanup.cleanup || cleanup, status };
}

let repairRunning = false;
export function startMetricoolRepairDispatcher(intervalMs = 120000) {
  const run = async () => {
    if (repairRunning) return;
    repairRunning = true;
    try {
      const result = await recoverMetricoolAutomation();
      if (result?.ok && !result?.skipped) {
        console.log('[como-asi] Metricool repair completed', JSON.stringify(result.cleanup || {}));
      }
    } catch (error) {
      console.error('[como-asi] Metricool repair attempt failed', error?.message || error);
    } finally {
      repairRunning = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref?.();
  console.log(`[como-asi] Metricool repair dispatcher active every ${intervalMs}ms while needed`);
}
