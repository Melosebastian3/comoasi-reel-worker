import fs from 'node:fs/promises';

const automationPath = new URL('./metricool-automation.js', import.meta.url);
let automationSource = await fs.readFile(automationPath, 'utf8');
const invalidPlanStatus = "slots.every(slot => slot.status === 'scheduled' || slot.status === 'missed') ? 'scheduled' : 'planned'";
const validPlanStatus = "slots.every(slot => slot.status === 'scheduled' || slot.status === 'missed') ? 'completed' : 'planned'";
if (automationSource.includes(invalidPlanStatus)) {
  automationSource = automationSource.replace(invalidPlanStatus, validPlanStatus);
}
await fs.writeFile(automationPath, automationSource, 'utf8');

const serverPath = new URL('./server.js', import.meta.url);
let serverSource = await fs.readFile(serverPath, 'utf8');
const bufferImport = "import { automationStatus, automationTick, saveMetricoolBrand, saveMetricoolConnection, scheduleSavedMetricool, setAutomationEnabled, startAutomationDispatcher } from './buffer-automation.js';";
const metricoolImport = "import { automationStatus, automationTick, saveMetricoolBrand, saveMetricoolConnection, scheduleSavedMetricool, setAutomationEnabled, startAutomationDispatcher } from './metricool-automation.js';";
if (serverSource.includes(bufferImport)) {
  serverSource = serverSource.replace(bufferImport, metricoolImport);
} else if (!serverSource.includes(metricoolImport)) {
  throw new Error('metricool_primary_server_import_anchor_not_found');
}

const automationStatusAnchor = `app.get('/api/automation/status', async (_req, res) => {`;
const compatibilityRoute = `app.get('/api/metricool/contingency/status', async (_req, res) => {\n  try {\n    res.json(await automationStatus());\n  } catch (error) {\n    res.status(500).json({ error: error?.message || 'metricool_status_failed' });\n  }\n});\n\n`;
if (!serverSource.includes("app.get('/api/metricool/contingency/status'")) {
  if (!serverSource.includes(automationStatusAnchor)) throw new Error('metricool_primary_status_anchor_not_found');
  serverSource = serverSource.replace(automationStatusAnchor, `${compatibilityRoute}${automationStatusAnchor}`);
}
await fs.writeFile(serverPath, serverSource, 'utf8');

const contingencyPath = new URL('./contingency-engine.js', import.meta.url);
let contingencySource = await fs.readFile(contingencyPath, 'utf8');
const uploadPostExclusion = `       and not exists (\n         select 1\n           from comoasi.publishing_queue u\n          where u.reel_id=b.reel_id\n            and u.platform=b.platform\n            and u.account_key='upload-post'\n            and u.external_post_id is not null\n       )`;
const guardedExclusion = `${uploadPostExclusion}\n       and not exists (\n         select 1\n           from comoasi.publishing_queue m\n          where m.reel_id=b.reel_id\n            and m.platform=b.platform\n            and m.account_key='metricool'\n            and (m.status in ('scheduled','publishing','published') or m.published_at is not null)\n       )`;
if (!contingencySource.includes("m.account_key='metricool'")) {
  if (!contingencySource.includes(uploadPostExclusion)) throw new Error('metricool_cross_provider_guard_anchor_not_found');
  contingencySource = contingencySource.replace(uploadPostExclusion, guardedExclusion);
}
await fs.writeFile(contingencyPath, contingencySource, 'utf8');

console.log('[como-asi] Metricool primary hardening applied (Metricool -> Buffer -> Upload-Post; duplicate guards active)');
