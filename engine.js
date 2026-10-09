import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const studioBase = (process.env.COMOASI_STUDIO_BASE || '').replace(/\/$/, '');
// ENGINE_MODE=local runs the editorial engine in-process with open-source AI (local/engine-local.js)
// and stores assets on disk instead of calling the AppDeploy Studio.
const localMode = process.env.ENGINE_MODE === 'local';
const assetRoot = path.resolve(process.env.LOCAL_ASSET_DIR || 'data/assets');
let localEngine;

function localAssetFile(assetPath) {
  const resolved = path.resolve(assetRoot, String(assetPath || ''));
  if (!resolved.startsWith(`${assetRoot}${path.sep}`)) throw new Error('invalid_asset_path');
  return resolved;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function studioCall(route, body, options = {}) {
  if (localMode) {
    if (!route.startsWith('/api/engine/')) throw new Error(`studio_route_unavailable_in_local_mode:${route}`);
    localEngine ||= await import('./local/engine-local.js');
    return localEngine.engineCall(route, body || {});
  }
  if (!studioBase) throw new Error('COMOASI_STUDIO_BASE is not configured');
  const configuredAttempts = Number(options.attempts || 5);
  const attempts = route === '/api/metricool/oauth/schedule'
    ? 1
    : configuredAttempts;
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
        console.error(`[como-asi] studio call failed ${route} HTTP ${response.status}: ${text.slice(0, 4000)}`);
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
  if (localMode) {
    const target = localAssetFile(assetPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (path.resolve(filePath) !== target) await fs.copyFile(filePath, target);
    return { path: assetPath, contentType };
  }
  const stat = await fs.stat(filePath);
  const directLimitBytes = 2400000;
  console.info(`[como-asi] asset upload started: ${assetPath} (${stat.size} bytes raw)`);

  if (stat.size <= directLimitBytes) {
    const content = await fs.readFile(filePath, { encoding: 'base64' });
    const result = await studioCall('/api/assets/write', { path: assetPath, content, contentType }, { timeoutMs: 180000, attempts: 4 });
    console.info(`[como-asi] asset upload completed: ${assetPath}`);
    return result;
  }

  const bytes = await fs.readFile(filePath);
  const maxChunkCount = 480;
  const minimumChunkSize = 1500000;
  const chunkSize = Math.max(minimumChunkSize, Math.ceil(bytes.length / maxChunkCount));
  const chunkCount = Math.ceil(bytes.length / chunkSize);
  const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  console.info(`[como-asi] chunked asset upload: ${chunkCount} chunks of up to ${chunkSize} bytes`);
  for (let index = 0; index < chunkCount; index += 1) {
    const content = bytes.subarray(index * chunkSize, Math.min(bytes.length, (index + 1) * chunkSize)).toString('base64');
    await studioCall('/api/assets/chunk', { uploadId, index, content }, { timeoutMs: 180000, attempts: 5 });
  }
  const result = await studioCall('/api/assets/commit', { uploadId, chunkCount, path: assetPath, contentType }, { timeoutMs: 300000, attempts: 3 });
  console.info(`[como-asi] chunked asset upload completed: ${assetPath}`);
  return result;
}

export async function getAssetUrl(assetPath) {
  if (localMode) {
    const publicBase = (process.env.PUBLIC_ASSET_BASE || '').replace(/\/$/, '');
    if (publicBase) return `${publicBase}/${String(assetPath).split('/').map(encodeURIComponent).join('/')}`;
    return pathToFileURL(localAssetFile(assetPath)).href;
  }
  const result = await studioCall('/api/assets/url', { path: assetPath }, { timeoutMs: 60000, attempts: 3 });
  return result.url;
}
