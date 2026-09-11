import fs from 'node:fs/promises';
import path from 'node:path';

const studioBase = (process.env.COMOASI_STUDIO_BASE || '').replace(/\/$/, '');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function studioCall(route, body, options = {}) {
  if (!studioBase) throw new Error('COMOASI_STUDIO_BASE is not configured');
  const attempts = Number(options.attempts || 5);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${studioBase}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-como-asi-project': 'como-asi' },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(Number(options.timeoutMs || 180000)),
      });
      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      if (!response.ok) {
        const requestError = new Error(`${route} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
        requestError.status = response.status;
        throw requestError;
      }
      return data;
    } catch (requestError) {
      lastError = requestError;
      const status = Number(requestError?.status || 0);
      const retryable = !status || status === 429 || status >= 500;
      if (!retryable || attempt === attempts) break;
      await sleep(Math.min(15000, 1200 * (2 ** (attempt - 1))));
    }
  }
  throw lastError || new Error(`${route} failed`);
}

export async function writeBase64File(filePath, base64) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.from(base64, 'base64'));
  return filePath;
}

export async function uploadAsset(assetPath, filePath, contentType) {
  const content = await fs.readFile(filePath, { encoding: 'base64' });
  return studioCall('/api/assets/write', { path: assetPath, content, contentType }, { timeoutMs: 180000, attempts: 4 });
}

export async function getAssetUrl(assetPath) {
  const result = await studioCall('/api/assets/url', { path: assetPath }, { timeoutMs: 60000, attempts: 3 });
  return result.url;
}
