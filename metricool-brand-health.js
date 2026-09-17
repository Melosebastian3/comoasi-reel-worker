import crypto from 'node:crypto';
import { query } from './db.js';
import { studioCall } from './engine.js';

const settingKey = 'metricool_automation_v1';
const clean = value => String(value ?? '').trim();
const parseSetting = value => value && typeof value === 'object' ? value : (() => { try { return JSON.parse(String(value || '{}')); } catch { return {}; } })();
let inventoryLogged = false;

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

async function config() {
  const { rows } = await query('select value from comoasi.app_settings where key=$1 limit 1', [settingKey]);
  return rows[0] ? parseSetting(rows[0].value) : null;
}

async function patch(value) {
  await query(`update comoasi.app_settings set value=coalesce(value,'{}'::jsonb) || $2::jsonb, updated_at=now() where key=$1`, [settingKey, JSON.stringify(value)]);
}

async function logBrandInventory(accessToken) {
  if (inventoryLogged) return null;
  try {
    const result = await studioCall('/api/metricool/oauth/brands', { accessToken }, { timeoutMs: 60000, attempts: 3 });
    const brands = Array.isArray(result?.brands) ? result.brands : [];
    console.info('[como-asi] Metricool OAuth brand inventory', JSON.stringify(brands.map(item => ({ id: clean(item?.id), label: clean(item?.label), networks: Array.isArray(item?.networks) ? item.networks : [] }))));
    inventoryLogged = true;
    return brands;
  } catch (error) {
    console.warn('[como-asi] Metricool brand inventory warning', clean(error?.message || error));
    return null;
  }
}

export async function checkMetricoolBrandAccess() {
  const current = await config();
  const brandId = clean(current?.brandId);
  const accessToken = open(current?.accessTokenEnc);
  const checkedAt = new Date().toISOString();
  if (!brandId || !accessToken) {
    await patch({ brandAccessOk: false, brandAccessCheckedAt: checkedAt, brandAccessError: 'metricool_connection_incomplete' });
    return { accessible: false, reason: 'metricool_connection_incomplete' };
  }
  await logBrandInventory(accessToken);
  try {
    const result = await studioCall('/api/metricool/oauth/brand-health', {
      accessToken,
      brandId,
      timezone: clean(current?.timezone) || 'America/Argentina/Buenos_Aires',
    }, { timeoutMs: 60000, attempts: 3 });
    const accessible = result?.accessible === true;
    const reason = accessible ? null : clean(result?.reason) || 'metricool_brand_access_denied';
    await patch({ brandAccessOk: accessible, brandAccessCheckedAt: checkedAt, brandAccessError: reason });
    console.info('[como-asi] authoritative Metricool brand health', JSON.stringify({ accessible, brandId, reason }));
    return { accessible, brandId, reason, availableBrands: result?.availableBrands || null };
  } catch (error) {
    const reason = clean(error?.message || error).slice(0, 500) || 'metricool_brand_health_transport_failed';
    await patch({ brandAccessCheckedAt: checkedAt, brandAccessError: reason });
    console.warn('[como-asi] Metricool brand health transport warning; preserving prior access state', reason);
    return { accessible: current?.brandAccessOk === true, unknown: true, brandId, reason };
  }
}

export function startMetricoolBrandHealthDispatcher(intervalMs = 5 * 60 * 1000) {
  const first = setTimeout(() => { void checkMetricoolBrandAccess(); }, 5000);
  first.unref?.();
  const timer = setInterval(() => { void checkMetricoolBrandAccess(); }, Math.max(60000, intervalMs));
  timer.unref?.();
  console.info(`[como-asi] authoritative Metricool brand health active every ${Math.max(60000, intervalMs)}ms`);
  return timer;
}
