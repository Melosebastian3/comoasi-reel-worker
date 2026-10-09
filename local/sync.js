// Moves the editorial state between the real database (Neon) and the throwaway Postgres that
// runs next to the GPU on Kaggle, so the database password never leaves GitHub Actions.
//
//   node local/sync.js export-context <file> --date YYYY-MM-DD   (Actions, real DB)
//   node local/sync.js load-context <file>                      (Kaggle, local DB)
//   node local/sync.js export-results <file> --since ISO        (Kaggle, local DB)
//   node local/sync.js import-results <file>                    (Actions, real DB)
import fs from 'node:fs/promises';
import { pool, query } from '../db.js';

const [command, file] = process.argv.slice(2);
const option = name => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
};

const TABLES = {
  reels: ['id', 'category', 'topic', 'title', 'hook', 'status', 'duration_seconds', 'scene_count', 'viral_score', 'visual_score', 'research', 'narration', 'storyboard', 'cover', 'publishing_kit', 'worker_job_id', 'video_object_key', 'created_at', 'updated_at'],
  reel_jobs: ['id', 'external_job_id', 'reel_id', 'status', 'stage', 'progress', 'error', 'payload', 'result', 'created_at', 'started_at', 'completed_at', 'updated_at'],
  editorial_memory: ['id', 'topic', 'normalized_topic', 'category', 'protagonist', 'event_key', 'angle', 'subtopic', 'period_label', 'narrative_question', 'status', 'source', 'platforms', 'published_at', 'performance', 'created_at', 'updated_at'],
  viral_learning: ['id', 'category', 'pattern_type', 'pattern_key', 'score', 'sample_size', 'metrics', 'notes', 'last_seen_at', 'created_at', 'updated_at'],
};
const JSON_COLUMNS = new Set(['research', 'storyboard', 'cover', 'publishing_kit', 'payload', 'result', 'performance', 'metrics', 'notes']);

async function upsert(table, rows, { update }) {
  const columns = TABLES[table];
  for (const row of rows) {
    const values = columns.map(column => (JSON_COLUMNS.has(column) && row[column] != null ? JSON.stringify(row[column]) : row[column] ?? null));
    const placeholders = columns.map((column, index) => (JSON_COLUMNS.has(column) ? `$${index + 1}::jsonb` : `$${index + 1}`));
    const conflict = update
      ? `do update set ${columns.filter(column => column !== 'id').map(column => `${column}=excluded.${column}`).join(', ')}`
      : 'do nothing';
    await query(`insert into comoasi.${table} (${columns.join(', ')}) values (${placeholders.join(', ')}) on conflict (id) ${conflict}`, values);
  }
  return rows.length;
}

async function main() {
  if (!file) throw new Error('file_required');
  if (command === 'export-context') {
    const date = option('date');
    const memory = await query(`select * from comoasi.editorial_memory order by created_at desc limit 300`);
    const learning = await query(`select * from comoasi.viral_learning`);
    const jobs = date
      ? await query(`select * from comoasi.reel_jobs where payload->>'runKey' like $1`, [`batch:${date}:%`])
      : { rows: [] };
    const reelIds = jobs.rows.map(job => job.reel_id).filter(Boolean);
    const reels = reelIds.length ? await query(`select * from comoasi.reels where id = any($1::uuid[])`, [reelIds]) : { rows: [] };
    const context = { exportedAt: new Date().toISOString(), date, editorial_memory: memory.rows, viral_learning: learning.rows, reels: reels.rows, reel_jobs: jobs.rows };
    await fs.writeFile(file, JSON.stringify(context));
    console.log(`[sync] exported ${memory.rows.length} memory, ${learning.rows.length} learning, ${jobs.rows.length} jobs`);
  } else if (command === 'load-context') {
    const context = JSON.parse(await fs.readFile(file, 'utf8'));
    await upsert('editorial_memory', context.editorial_memory || [], { update: false });
    await upsert('viral_learning', context.viral_learning || [], { update: false });
    await upsert('reels', context.reels || [], { update: true });
    await upsert('reel_jobs', context.reel_jobs || [], { update: true });
    console.log('[sync] context loaded');
  } else if (command === 'export-results') {
    const since = option('since') || '1970-01-01';
    const out = {};
    for (const table of ['reels', 'reel_jobs', 'editorial_memory']) {
      out[table] = (await query(`select * from comoasi.${table} where updated_at >= $1`, [since])).rows;
    }
    await fs.writeFile(file, JSON.stringify(out));
    console.log(`[sync] exported ${out.reels.length} reels, ${out.reel_jobs.length} jobs, ${out.editorial_memory.length} memory rows`);
  } else if (command === 'import-results') {
    const results = JSON.parse(await fs.readFile(file, 'utf8'));
    const reels = await upsert('reels', results.reels || [], { update: true });
    const jobs = await upsert('reel_jobs', results.reel_jobs || [], { update: true });
    const memory = await upsert('editorial_memory', results.editorial_memory || [], { update: false });
    console.log(`[sync] imported ${reels} reels, ${jobs} jobs, ${memory} memory rows`);
  } else {
    throw new Error(`unknown_command:${command}`);
  }
}

main()
  .then(() => pool.end())
  .catch(async syncError => {
    console.error('[sync] failed', syncError);
    await pool.end().catch(() => {});
    process.exit(1);
  });
