import fs from 'node:fs/promises';

const path = new URL('./server.js', import.meta.url);
let source = await fs.readFile(path, 'utf8');

const importAnchor = "import { enforceReelRetention, retentionStatus, startRetentionDispatcher } from './retention.js';";
const importLine = "import { publishNow } from './manual-publish.js';";
if (!source.includes(importLine)) {
  if (!source.includes(importAnchor)) throw new Error('manual_publish_import_anchor_not_found');
  source = source.replace(importAnchor, `${importAnchor}\n${importLine}`);
}

const routeAnchor = `app.get('/api/social/status', async (_req, res) => {\n  res.json({ networks: await socialStatus() });\n});`;
const routeBlock = `app.post('/api/publisher/publish-now', async (req, res) => {\n  try {\n    const result = await publishNow({\n      reelId: req.body?.reelId,\n      networks: req.body?.networks,\n    });\n    res.json(result);\n  } catch (error) {\n    const message = error?.message || 'manual_publish_failed';\n    const status = message === 'reel_id_required' || message === 'publish_networks_required'\n      ? 400\n      : message === 'reel_not_found'\n        ? 404\n        : message === 'reel_not_ready'\n          ? 409\n          : message === 'buffer_rate_limited_manual_publish_blocked'\n            ? 429\n            : 502;\n    res.status(status).json({\n      error: message,\n      detail: error?.detail || null,\n      duplicateSafe: true,\n    });\n  }\n});\n\n${routeAnchor}`;
if (!source.includes("app.post('/api/publisher/publish-now'")) {
  if (!source.includes(routeAnchor)) throw new Error('manual_publish_route_anchor_not_found');
  source = source.replace(routeAnchor, routeBlock);
}

await fs.writeFile(path, source, 'utf8');
console.log('[como-asi] manual publish hardening applied');
