import express from 'express';
import crypto from 'node:crypto';
import { healthcheckDb, query } from './db.js';
import { createJob, setJobStage } from './pipeline.js';
import { recoverJobs, startJob } from './job-runner.js';

const app = express();
const port = Number(process.env.PORT || 8080);
const projectKey = 'como-asi';

app.use(express.json({ limit: '8mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Como-Asi-Project', projectKey);
  next();
});

app.get('/health', async (_req, res) => {
  try {
    const db = await healthcheckDb();
    res.json({ ok: true, project: projectKey, isolated: true, database: db.database, role: db.role });
  } catch (error) {
    res.status(503).json({ ok: false, project: projectKey, isolated: true, error: String(error) });
  }
});

app.get('/isolation', (_req, res) => {
  res.json({
    project: projectKey,
    strictIsolation: true,
    forbiddenDependencies: ['HISTYRA', 'video-factory', 'music-reel-worker'],
    sharesHistyraDatabase: false,
    sharesHistyraWorker: false,
    sharesHistyraRepo: false,
    sharesHistyraStorage: false,
  });
});

app.get('/api/settings', async (_req, res) => {
  const { rows } = await query('select key, value, updated_at from comoasi.app_settings order by key');
  res.json(rows);
});

app.get('/api/reels', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 100);
  const { rows } = await query('select * from comoasi.reels order by created_at desc limit $1', [limit]);
  res.json(rows);
});

app.post('/api/reels', async (req, res) => {
  const { category, topic, title = null, hook = null } = req.body || {};
  if (!category || !topic) return res.status(400).json({ error: 'category_and_topic_required' });
  const { rows } = await query(
    `insert into comoasi.reels(category, topic, title, hook)
     values($1,$2,$3,$4) returning *`,
    [String(category), String(topic), title, hook]
  );
  res.status(201).json(rows[0]);
});

app.get('/api/reels/:id', async (req, res) => {
  const { rows } = await query('select * from comoasi.reels where id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});

app.get('/api/memory', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 250);
  const { rows } = await query('select * from comoasi.editorial_memory order by created_at desc limit $1', [limit]);
  res.json(rows);
});

app.post('/api/memory', async (req, res) => {
  const body = req.body || {};
  if (!body.topic || !body.normalizedTopic || !body.category) return res.status(400).json({ error: 'topic_normalizedTopic_category_required' });
  const { rows } = await query(
    `insert into comoasi.editorial_memory
      (topic, normalized_topic, category, protagonist, event_key, angle, subtopic, period_label, narrative_question, status, performance)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) returning *`,
    [body.topic, body.normalizedTopic, body.category, body.protagonist || null, body.eventKey || null, body.angle || null, body.subtopic || null, body.periodLabel || null, body.narrativeQuestion || null, body.status || 'generated', JSON.stringify(body.performance || {})]
  );
  res.status(201).json(rows[0]);
});

app.get('/api/radar/latest', async (_req, res) => {
  const { rows } = await query('select * from comoasi.metric_snapshots order by snapshot_date desc, created_at desc limit 1');
  res.json(rows[0] || null);
});

app.post('/api/radar/snapshots', async (req, res) => {
  const b = req.body || {};
  const date = b.snapshotDate || new Date().toISOString().slice(0, 10);
  const { rows } = await query(
    `insert into comoasi.metric_snapshots(snapshot_date, source, strategy, category_scores, signals, top_posts, raw_data)
     values($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb)
     on conflict(snapshot_date, source) do update set
       strategy=excluded.strategy, category_scores=excluded.category_scores, signals=excluded.signals,
       top_posts=excluded.top_posts, raw_data=excluded.raw_data
     returning *`,
    [date, b.source || 'metricool', JSON.stringify(b.strategy || {}), JSON.stringify(b.categoryScores || {}), JSON.stringify(b.signals || {}), JSON.stringify(b.topPosts || []), JSON.stringify(b.rawData || {})]
  );
  res.status(201).json(rows[0]);
});

app.get('/api/learning', async (_req, res) => {
  const { rows } = await query('select * from comoasi.viral_learning order by category, score desc');
  res.json(rows);
});

app.post('/api/jobs', async (req, res) => {
  const job = await createJob({ reelId: req.body?.reelId || null, payload: req.body?.payload || {} });
  res.status(202).json(job);
});

app.post('/api/generate', async (req, res) => {
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const job = await createJob({ payload });
  startJob(job.id);
  res.status(202).json({ jobId: job.id, status: job.status, stage: job.stage, progress: job.progress });
});

app.get('/api/jobs/:id', async (req, res) => {
  const { rows } = await query(`select j.*, r.title as reel_title, r.topic as reel_topic, r.status as reel_status, r.video_object_key from comoasi.reel_jobs j left join comoasi.reels r on r.id=j.reel_id where j.id=$1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});

app.post('/api/jobs/:id/retry', async (req, res) => {
  const { rows } = await query(`update comoasi.reel_jobs set status='queued', stage='queued', progress=0, error=null, completed_at=null, updated_at=now() where id=$1 and status='failed' returning *`, [req.params.id]);
  if (!rows[0]) return res.status(409).json({ error: 'job_not_failed_or_not_found' });
  startJob(req.params.id);
  res.status(202).json(rows[0]);
});

app.post('/api/jobs/:id/stage', async (req, res) => {
  const stage = String(req.body?.stage || '');
  if (!stage) return res.status(400).json({ error: 'stage_required' });
  const job = await setJobStage(req.params.id, stage, req.body?.result || {});
  if (!job) return res.status(404).json({ error: 'not_found' });
  res.json(job);
});

app.get('/api/plans/today', async (_req, res) => {
  const { rows } = await query("select * from comoasi.daily_plans where plan_date=(now() at time zone 'America/Argentina/Buenos_Aires')::date limit 1");
  res.json(rows[0] || null);
});

app.post('/api/plans', async (req, res) => {
  const b = req.body || {};
  const date = b.planDate || new Date().toISOString().slice(0, 10);
  const { rows } = await query(
    `insert into comoasi.daily_plans(plan_date, timezone, slots, strategy, status)
     values($1,$2,$3::jsonb,$4::jsonb,$5)
     on conflict(plan_date) do update set timezone=excluded.timezone, slots=excluded.slots, strategy=excluded.strategy, status=excluded.status
     returning *`,
    [date, b.timezone || 'America/Argentina/Buenos_Aires', JSON.stringify(b.slots || []), JSON.stringify(b.strategy || {}), b.status || 'planned']
  );
  res.status(201).json(rows[0]);
});

app.get('/api/publisher/queue', async (_req, res) => {
  const { rows } = await query('select * from comoasi.publishing_queue order by scheduled_at asc limit 100');
  res.json(rows);
});

app.post('/api/publisher/queue', async (req, res) => {
  const b = req.body || {};
  if (!b.reelId || !b.platform || !b.scheduledAt) return res.status(400).json({ error: 'reelId_platform_scheduledAt_required' });
  const { rows } = await query(
    `insert into comoasi.publishing_queue(reel_id, platform, account_key, scheduled_at, publish_payload)
     values($1,$2,$3,$4,$5::jsonb) returning *`,
    [b.reelId, b.platform, b.accountKey || null, b.scheduledAt, JSON.stringify(b.publishPayload || {})]
  );
  res.status(201).json(rows[0]);
});

app.get('/api/runtime-id', (_req, res) => {
  res.json({ project: projectKey, runtimeId: crypto.randomUUID(), time: new Date().toISOString() });
});

app.use((error, _req, res, _next) => {
  console.error('[como-asi] unhandled', error);
  res.status(500).json({ error: 'internal_error' });
});

app.listen(port, async () => {
  console.log(`[como-asi] independent worker listening on ${port}`);
  try {
    const recovered = await recoverJobs();
    if (recovered) console.log(`[como-asi] recovered ${recovered} queued/running job(s)`);
  } catch (error) {
    console.error('[como-asi] recovery scan failed', error);
  }
});
