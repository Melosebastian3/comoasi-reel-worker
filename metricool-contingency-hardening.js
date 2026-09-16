import fs from 'node:fs/promises';

const serverPath = new URL('./server.js', import.meta.url);
let serverSource = await fs.readFile(serverPath, 'utf8');

const serverImportAnchor = "import { enforceReelRetention, retentionStatus, startRetentionDispatcher } from './retention.js';";
const serverImportLine = "import { metricoolContingencyStatus, saveMetricoolContingencyBrand, saveMetricoolContingencyConnection, scheduleMetricoolContingency } from './metricool-contingency.js';";
if (!serverSource.includes(serverImportLine)) {
  if (!serverSource.includes(serverImportAnchor)) throw new Error('metricool_contingency_server_import_anchor_not_found');
  serverSource = serverSource.replace(serverImportAnchor, `${serverImportAnchor}\n${serverImportLine}`);
}

const oldConnectRoute = `app.post('/api/metricool/connect', async (req, res) => {\n  try {\n    res.json(await saveMetricoolConnection(req.body || {}));\n  } catch (error) {\n    res.status(400).json({ error: error?.message || 'buffer_connection_compat_failed' });\n  }\n});`;
const newConnectRoute = `app.post('/api/metricool/connect', async (req, res) => {\n  try {\n    res.json(await saveMetricoolContingencyConnection(req.body || {}));\n  } catch (error) {\n    res.status(400).json({ error: error?.message || 'metricool_connection_failed' });\n  }\n});`;
if (serverSource.includes(oldConnectRoute)) serverSource = serverSource.replace(oldConnectRoute, newConnectRoute);

const oldBrandRoute = `app.post('/api/metricool/brand', async (req, res) => {\n  try {\n    res.json(await saveMetricoolBrand(req.body || {}));\n  } catch (error) {\n    res.status(400).json({ error: error?.message || 'buffer_brand_compat_failed' });\n  }\n});`;
const newBrandRoute = `app.post('/api/metricool/brand', async (req, res) => {\n  try {\n    res.json(await saveMetricoolContingencyBrand(req.body || {}));\n  } catch (error) {\n    res.status(400).json({ error: error?.message || 'metricool_brand_failed' });\n  }\n});`;
if (serverSource.includes(oldBrandRoute)) serverSource = serverSource.replace(oldBrandRoute, newBrandRoute);

const automationStatusAnchor = `app.get('/api/automation/status', async (_req, res) => {`;
const metricoolStatusRoute = `app.get('/api/metricool/contingency/status', async (_req, res) => {\n  try {\n    res.json(await metricoolContingencyStatus());\n  } catch (error) {\n    res.status(500).json({ error: error?.message || 'metricool_contingency_status_failed' });\n  }\n});\n\n`;
if (!serverSource.includes("app.get('/api/metricool/contingency/status'")) {
  if (!serverSource.includes(automationStatusAnchor)) throw new Error('metricool_contingency_status_anchor_not_found');
  serverSource = serverSource.replace(automationStatusAnchor, `${metricoolStatusRoute}${automationStatusAnchor}`);
}

const oldScheduleRoute = `app.post('/api/metricool/schedule-saved', async (req, res) => {\n  try {\n    res.json(await scheduleSavedMetricool(req.body || {}));\n  } catch (error) {\n    res.status(502).json({ error: error?.message || 'buffer_schedule_failed' });\n  }\n});`;
const newScheduleRoute = `app.post('/api/metricool/schedule-saved', async (req, res) => {\n  try {\n    res.json(await scheduleMetricoolContingency(req.body || {}));\n  } catch (error) {\n    res.status(502).json({ error: error?.message || 'metricool_schedule_failed' });\n  }\n});`;
if (serverSource.includes(oldScheduleRoute)) serverSource = serverSource.replace(oldScheduleRoute, newScheduleRoute);

await fs.writeFile(serverPath, serverSource, 'utf8');

const contingencyPath = new URL('./contingency-engine.js', import.meta.url);
let contingencySource = await fs.readFile(contingencyPath, 'utf8');

const contingencyImportAnchor = "import { queuePublishAll, socialStatus } from './social-publisher.js';";
const contingencyImportLine = "import { metricoolContingencyReady, scheduleMetricoolContingency } from './metricool-contingency.js';";
if (!contingencySource.includes(contingencyImportLine)) {
  if (!contingencySource.includes(contingencyImportAnchor)) throw new Error('metricool_contingency_engine_import_anchor_not_found');
  contingencySource = contingencySource.replace(contingencyImportAnchor, `${contingencyImportAnchor}\n${contingencyImportLine}`);
}

const uploadPostExclusionOld = `and not exists (\n         select 1\n           from comoasi.publishing_queue u\n          where u.reel_id=b.reel_id\n            and u.platform=b.platform\n            and u.account_key='upload-post'\n            and u.external_post_id is not null\n       )`;
const uploadPostExclusionNew = `and not exists (\n         select 1\n           from comoasi.publishing_queue u\n          where u.reel_id=b.reel_id\n            and u.platform=b.platform\n            and u.account_key='upload-post'\n            and u.external_post_id is not null\n            and u.status in ('scheduled','publishing','published')\n       )\n       and not exists (\n         select 1\n           from comoasi.publishing_queue m\n          where m.reel_id=b.reel_id\n            and m.platform=b.platform\n            and m.account_key='metricool'\n            and m.status in ('scheduled','publishing','published')\n       )`;
if (contingencySource.includes(uploadPostExclusionOld)) {
  contingencySource = contingencySource.replace(uploadPostExclusionOld, uploadPostExclusionNew);
}

const loopAnchor = `    const scheduledAt = waitUntil(group.scheduledAt);\n    let uploadPostError = null;\n\n    if (uploadPostFallbackReady()) {`;
const loopReplacement = `    const scheduledAt = waitUntil(group.scheduledAt);\n    let uploadPostError = null;\n    let uploadPostPreviouslyFailed = false;\n    try {\n      const failedUploadPost = await query(\n        \`select count(*)::int as count\n           from comoasi.publishing_queue\n          where reel_id=$1\n            and account_key='upload-post'\n            and platform = any($2::text[])\n            and status='failed'\`,\n        [reelId, group.networks]\n      );\n      uploadPostPreviouslyFailed = Number(failedUploadPost.rows[0]?.count || 0) > 0;\n    } catch (error) {\n      console.warn('[como-asi] failed Upload-Post history check', reelId, clean(error?.message || error));\n    }\n\n    if (uploadPostFallbackReady() && !uploadPostPreviouslyFailed) {`;
if (contingencySource.includes(loopAnchor)) contingencySource = contingencySource.replace(loopAnchor, loopReplacement);

const uploadPostElseAnchor = `    } else {\n      uploadPostError = new Error('upload_post_not_configured');\n    }\n\n    try {\n      const native = await nativeTakeover({ reelId, networks: group.networks, scheduledAt });`;
const metricoolBlock = `    } else if (uploadPostPreviouslyFailed) {\n      uploadPostError = new Error('upload_post_previous_delivery_failed');\n    } else {\n      uploadPostError = new Error('upload_post_not_configured');\n    }\n\n    let metricoolError = null;\n    try {\n      if (await metricoolContingencyReady()) {\n        const metricool = await scheduleMetricoolContingency({\n          reelId,\n          scheduledAt,\n          networks: group.networks,\n        });\n        results.push({ ok: true, provider: 'metricool', reelId, networks: metricool.networks || group.networks, scheduledAt, result: metricool });\n        console.info('[como-asi] Metricool contingency takeover scheduled', reelId, (metricool.networks || group.networks).join(','), scheduledAt);\n        continue;\n      }\n      metricoolError = new Error('metricool_contingency_not_configured');\n    } catch (error) {\n      metricoolError = error;\n      console.warn('[como-asi] Metricool contingency unavailable', reelId, group.networks.join(','), clean(error?.message || error));\n    }\n\n    try {\n      const native = await nativeTakeover({ reelId, networks: group.networks, scheduledAt });`;
if (contingencySource.includes(uploadPostElseAnchor)) contingencySource = contingencySource.replace(uploadPostElseAnchor, metricoolBlock);

const finalErrorOld = `      const finalError = new Error(\`${clean(uploadPostError?.message || uploadPostError)};native_unavailable:\${remaining.join(',') || group.networks.join(',')}\`);`;
const finalErrorNew = `      const finalError = new Error(\`${clean(uploadPostError?.message || uploadPostError)};${clean(metricoolError?.message || metricoolError)};native_unavailable:\${remaining.join(',') || group.networks.join(',')}\`);`;
if (contingencySource.includes(finalErrorOld)) contingencySource = contingencySource.replace(finalErrorOld, finalErrorNew);

const nativeCatchOld = `      const finalError = new Error(\`${clean(uploadPostError?.message || uploadPostError)};native_failed:\${clean(nativeError?.message || nativeError)}\`);`;
const nativeCatchNew = `      const finalError = new Error(\`${clean(uploadPostError?.message || uploadPostError)};${clean(metricoolError?.message || metricoolError)};native_failed:\${clean(nativeError?.message || nativeError)}\`);`;
if (contingencySource.includes(nativeCatchOld)) contingencySource = contingencySource.replace(nativeCatchOld, nativeCatchNew);

await fs.writeFile(contingencyPath, contingencySource, 'utf8');
console.log('[como-asi] Metricool contingency hardening applied');
