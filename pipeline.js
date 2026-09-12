import { query } from './db.js';

const STAGES = [
  ['queued', 0],
  ['topic', 8],
  ['research', 18],
  ['narration', 32],
  ['storyboard', 45],
  ['scenes', 48],
  ['voice', 80],
  ['cover', 87],
  ['render', 94],
  ['publishing-kit', 98],
  ['completed', 100],
];

export async function createJob({ reelId = null, payload = {} }) {
  const result = await query(
    `insert into comoasi.reel_jobs (reel_id, status, stage, progress, payload)
     values ($1, 'queued', 'queued', 0, $2::jsonb)
     returning *`,
    [reelId, JSON.stringify(payload)]
  );
  return result.rows[0];
}

export async function setJobStage(id, stage, extra = {}) {
  const pair = STAGES.find(([name]) => name === stage);
  const progress = pair ? pair[1] : 0;
  const status = stage === 'completed' ? 'completed' : stage === 'failed' ? 'failed' : 'running';
  const result = await query(
    `update comoasi.reel_jobs
        set status=$2, stage=$3, progress=$4,
            started_at=coalesce(started_at, now()),
            completed_at=case when $2 in ('completed','failed') then now() else completed_at end,
            result=result || $5::jsonb,
            updated_at=now()
      where id=$1
      returning *`,
    [id, status, stage, progress, JSON.stringify(extra)]
  );
  console.log(`[como-asi] job ${id} -> ${stage} (${progress}%)`);
  return result.rows[0];
}

export async function setJobProgress(id, stage, progress, extra = {}) {
  const safeProgress = Math.max(0, Math.min(100, Math.round(Number(progress) || 0)));
  const result = await query(
    `update comoasi.reel_jobs
        set status='running', stage=$2, progress=$3,
            started_at=coalesce(started_at, now()),
            result=result || $4::jsonb,
            updated_at=now()
      where id=$1
      returning *`,
    [id, stage, safeProgress, JSON.stringify(extra)]
  );
  console.log(`[como-asi] job ${id} -> ${stage} (${safeProgress}%)`);
  return result.rows[0];
}

export async function failJob(id, errorMessage) {
  const result = await query(
    `update comoasi.reel_jobs
        set status='failed', stage='failed', error=$2, completed_at=now(), updated_at=now()
      where id=$1 returning *`,
    [id, String(errorMessage || 'Unknown error')]
  );
  return result.rows[0];
}
