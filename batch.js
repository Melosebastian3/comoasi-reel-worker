// Daily batch for GitHub Actions: produce the day's ¿Cómo Así? reels and exit.
// Publishing is NOT done here; it stays behind PUBLISH_MODE (default dry-run) in a later step.
//
//   ENGINE_MODE=local DATABASE_URL=... node batch.js [--date 2026-10-09] [--count 3] [--slots manana,noche]
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool, query } from './db.js';
import { createJob } from './pipeline.js';
import { runJobNow } from './job-runner.js';

const SLOTS = [
  { key: 'manana', time: '08:00' },
  { key: 'mediodia', time: '13:00' },
  { key: 'noche', time: '20:30' },
];
// Same daily rotation as metricool-automation.js.
const CATEGORY_ROTATIONS = [
  ['chisme_polemica', 'famosos'],
  ['bizarro_wtf', 'chisme_polemica'],
  ['famosos', 'cultura_pop_actualidad'],
];

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
}

function tomorrowInBuenosAires() {
  const now = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(now);
}

async function main() {
  const dateKey = arg('date', tomorrowInBuenosAires());
  const wanted = String(arg('slots', '')).split(',').filter(Boolean);
  const count = Number(arg('count', 3));
  const dayIndex = Math.floor(Date.parse(`${dateKey}T00:00:00Z`) / 86400000);
  const rotation = CATEGORY_ROTATIONS[Math.abs(dayIndex) % CATEGORY_ROTATIONS.length];
  const slots = SLOTS.map((slot, index) => ({ ...slot, category: rotation[index % rotation.length] }))
    .filter(slot => !wanted.length || wanted.includes(slot.key))
    .slice(0, count);

  const manifest = { date: dateKey, engineMode: process.env.ENGINE_MODE || 'studio', reels: [] };
  for (const slot of slots) {
    const runKey = `batch:${dateKey}:${slot.key}`;
    // Idempotent per date+slot: a re-run continues the same job instead of making a second video.
    const existing = await query(
      `select * from comoasi.reel_jobs where payload->>'runKey'=$1 order by created_at desc limit 1`,
      [runKey]
    );
    let job = existing.rows[0];
    // A failed or cancelled attempt starts over with a fresh topic instead of reusing its results.
    if (['failed', 'cancelled'].includes(job?.status)) job = null;
    if (job?.status === 'completed') {
      console.log(`[batch] ${runKey} already completed, skipping`);
    } else {
      if (!job) job = await createJob({ payload: { runKey, category: slot.category, slot: slot.key, date: dateKey } });
      else await query(`update comoasi.reel_jobs set status='queued', stage='queued', error=null, updated_at=now() where id=$1`, [job.id]);
      console.log(`[batch] ${runKey} -> job ${job.id} (${slot.category})`);
      await runJobNow(job.id);
    }
    const { rows } = await query('select id, status, stage, error, result, reel_id from comoasi.reel_jobs where id=$1', [job.id]);
    const done = rows[0];
    manifest.reels.push({
      slot: slot.key,
      time: slot.time,
      category: slot.category,
      jobId: done.id,
      reelId: done.reel_id,
      status: done.status,
      error: done.error,
      videoAssetPath: done.result?.videoAssetPath || null,
      coverAssetPath: done.result?.coverAssetPath || null,
      title: done.result?.story?.title || done.result?.topicData?.title || null,
      publishingKit: done.result?.publishingKit || null,
    });
  }

  const outDir = path.resolve(process.env.LOCAL_ASSET_DIR || 'data/assets');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, `manifest-${dateKey}.json`), JSON.stringify(manifest, null, 2));
  const failed = manifest.reels.filter(reel => reel.status !== 'completed');
  console.log(`[batch] ${manifest.reels.length - failed.length}/${manifest.reels.length} reels completed for ${dateKey}`);
  return failed.length ? 1 : 0;
}

main()
  .then(code => pool.end().then(() => process.exit(code)))
  .catch(async batchError => {
    console.error('[batch] fatal', batchError);
    await pool.end().catch(() => {});
    process.exit(1);
  });
