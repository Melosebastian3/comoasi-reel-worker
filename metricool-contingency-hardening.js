import fs from 'node:fs/promises';

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
console.log('[como-asi] Metricool primary hardening applied (Metricool -> Buffer -> Upload-Post)');
