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
const routeBlock = `app.post('/api/publisher/publish-now', (req, res) => {\n  const reelId = req.body?.reelId;\n  const networks = req.body?.networks;\n  if (!reelId) {\n    res.status(400).json({ error: 'reel_id_required', duplicateSafe: true });\n    return;\n  }\n\n  res.status(202).json({\n    ok: true,\n    accepted: true,\n    reelId,\n    networks: Array.isArray(networks) ? networks : ['instagram', 'tiktok', 'youtube'],\n    message: 'Contingencia iniciada. El sistema va a publicar solo las redes pendientes y actualizará el estado automáticamente.',\n    duplicateSafe: true,\n  });\n\n  setImmediate(() => {\n    void publishNow({ reelId, networks })\n      .then(result => console.info('[como-asi] manual contingency complete', reelId, JSON.stringify(result)))\n      .catch(error => console.error('[como-asi] manual contingency failed', reelId, error?.message || error));\n  });\n});\n\n${routeAnchor}`;
if (!source.includes("app.post('/api/publisher/publish-now'")) {
  if (!source.includes(routeAnchor)) throw new Error('manual_publish_route_anchor_not_found');
  source = source.replace(routeAnchor, routeBlock);
}

await fs.writeFile(path, source, 'utf8');
console.log('[como-asi] manual publish hardening applied');
