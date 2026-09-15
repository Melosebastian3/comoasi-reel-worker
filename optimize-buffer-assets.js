import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { query } from './db.js';
import { getAssetUrl, uploadAsset } from './engine.js';

const maxBytes = 80 * 1024 * 1024;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr.slice(-3000)}`)));
  });
}

async function contentLength(url) {
  const response = await fetch(url, { method: 'HEAD' });
  if (!response.ok) throw new Error(`asset_head_failed:${response.status}`);
  const value = Number(response.headers.get('content-length') || 0);
  return Number.isFinite(value) ? value : 0;
}

async function download(url, filePath) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`asset_download_failed:${response.status}`);
  const handle = await fs.open(filePath, 'w');
  try {
    await pipeline(Readable.fromWeb(response.body), handle.createWriteStream());
  } finally {
    await handle.close().catch(() => {});
  }
}

async function optimizeOne(reel) {
  const signedUrl = await getAssetUrl(reel.video_object_key);
  const before = await contentLength(signedUrl);
  if (before > 0 && before <= maxBytes) {
    console.info(`[como-asi] Buffer asset already optimized ${reel.id}: ${before} bytes`);
    return { reelId: reel.id, skipped: true, before, after: before };
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'comoasi-optimize-'));
  const input = path.join(dir, 'input.mp4');
  const output = path.join(dir, 'output.mp4');
  try {
    console.info(`[como-asi] optimizing Buffer asset ${reel.id}: ${before || 'unknown'} bytes`);
    await download(signedUrl, input);
    await run('ffmpeg', [
      '-y', '-i', input,
      '-map', '0:v:0', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-maxrate', '5M', '-bufsize', '10M', '-pix_fmt', 'yuv420p',
      '-r', '30', '-g', '60', '-keyint_min', '30',
      '-threads', '2',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart',
      output,
    ]);
    const stat = await fs.stat(output);
    if (stat.size <= 0 || stat.size >= before && before > 0) throw new Error(`asset_optimization_not_effective:${stat.size}`);
    await uploadAsset(reel.video_object_key, output, 'video/mp4');
    const verifyUrl = await getAssetUrl(reel.video_object_key);
    const after = await contentLength(verifyUrl);
    console.info(`[como-asi] Buffer asset optimized ${reel.id}: ${before} -> ${after || stat.size} bytes`);
    return { reelId: reel.id, skipped: false, before, after: after || stat.size };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function optimizeScheduledBufferAssets() {
  const { rows } = await query(`
    select distinct r.id, r.video_object_key
      from comoasi.publishing_queue q
      join comoasi.reels r on r.id=q.reel_id
     where q.account_key='buffer'
       and q.scheduled_at >= now() - interval '12 hours'
       and q.scheduled_at <= now() + interval '24 hours'
       and r.status='ready'
       and r.video_object_key is not null
     order by r.id
  `);
  const results = [];
  for (const reel of rows) {
    try {
      results.push(await optimizeOne(reel));
    } catch (error) {
      console.error('[como-asi] Buffer asset optimization failed', reel.id, error?.message || error);
      results.push({ reelId: reel.id, error: error?.message || String(error) });
    }
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  optimizeScheduledBufferAssets()
    .then(results => console.info('[como-asi] Buffer asset optimization pass complete', JSON.stringify(results)))
    .catch(error => console.error('[como-asi] Buffer asset optimization pass failed', error?.message || error));
}
