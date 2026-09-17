import fs from 'node:fs/promises';

const automationPath = new URL('./metricool-automation.js', import.meta.url);
let automationSource = await fs.readFile(automationPath, 'utf8');

if (!automationSource.includes('metricoolBrandId: reservationBrandId || null')) {
  const functionAnchor = `async function reserveMetricoolNetworks({ reelId, networks, scheduledAt }) {\n  const alreadyActive = await activeNetworks(reelId, networks);`;
  const functionReplacement = `async function reserveMetricoolNetworks({ reelId, networks, scheduledAt }) {\n  const reservationConfig = await loadConfig();\n  const reservationBrandId = clean(reservationConfig?.brandId);\n  const alreadyActive = await activeNetworks(reelId, networks);`;
  if (!automationSource.includes(functionAnchor)) throw new Error('final_freeze_metricool_reservation_anchor_not_found');
  automationSource = automationSource.replace(functionAnchor, functionReplacement);

  const payloadAnchor = `      provider: 'metricool',\n      priority: 1,\n      leaseToken,`;
  const payloadReplacement = `      provider: 'metricool',\n      priority: 1,\n      metricoolBrandId: reservationBrandId || null,\n      leaseToken,`;
  if (!automationSource.includes(payloadAnchor)) throw new Error('final_freeze_metricool_payload_anchor_not_found');
  automationSource = automationSource.replace(payloadAnchor, payloadReplacement);
}
await fs.writeFile(automationPath, automationSource, 'utf8');

const serverPath = new URL('./server.js', import.meta.url);
let serverSource = await fs.readFile(serverPath, 'utf8');
const simpleCompatibilityRoute = `app.get('/api/metricool/contingency/status', async (_req, res) => {\n  try {\n    res.json(await automationStatus());\n  } catch (error) {\n    res.status(500).json({ error: error?.message || 'metricool_status_failed' });\n  }\n});`;
const hardenedCompatibilityRoute = `app.get('/api/metricool/contingency/status', async (_req, res) => {\n  try {\n    const status = await automationStatus();\n    const { rows } = await query(\"select value from comoasi.app_settings where key='metricool_automation_v1' limit 1\");\n    const config = rows[0]?.value && typeof rows[0].value === 'object' ? rows[0].value : {};\n    const brandAccessOk = config.brandAccessOk === true;\n    res.json({\n      ...status,\n      ready: Boolean(status.ready && brandAccessOk),\n      brandAccessOk: config.brandAccessOk ?? null,\n      brandAccessCheckedAt: config.brandAccessCheckedAt || null,\n      brandAccessError: config.brandAccessError || null,\n    });\n  } catch (error) {\n    res.status(500).json({ error: error?.message || 'metricool_status_failed' });\n  }\n});`;
if (!serverSource.includes('brandAccessCheckedAt: config.brandAccessCheckedAt')) {
  if (!serverSource.includes(simpleCompatibilityRoute)) throw new Error('final_freeze_metricool_status_anchor_not_found');
  serverSource = serverSource.replace(simpleCompatibilityRoute, hardenedCompatibilityRoute);
}
await fs.writeFile(serverPath, serverSource, 'utf8');

console.log('[como-asi] final freeze hardening applied (real Metricool brand health + per-publication brand trace)');
