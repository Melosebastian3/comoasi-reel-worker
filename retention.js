import { pool, query } from './db.js';
import { studioCall } from './engine.js';

const RETENTION_LIMIT = 3;
let enforcing = false;

const uuidArray = values => values.map(value => String(value));

export async function retentionStatus() {
  const { rows } = await query(`
    select
      count(*) filter (where r.status='ready')::int as ready_count,
      count(*) filter (where exists (
        select 1 from comoasi.reel_jobs j
        where j.reel_id=r.id and j.status in ('queued','running')
      ))::int as active_count,
      count(*)::int as total_count
    from comoasi.reels r
  `);
  return { limit: RETENTION_LIMIT, ...rows[0] };
}

async function staleReels(limit = RETENTION_LIMIT) {
  const { rows } = await query(`
    with keep_ready as (
      select id
      from comoasi.reels
      where status='ready'
      order by created_at desc
      limit $1
    )
    select r.id, r.title, r.video_object_key
    from comoasi.reels r
    where not exists (select 1 from keep_ready k where k.id=r.id)
      and not exists (
        select 1 from comoasi.reel_jobs j
        where j.reel_id=r.id and j.status in ('queued','running')
      )
    order by r.created_at asc
    limit 50
  `, [limit]);
  return rows;
}

async function deleteDatabaseRows(ids) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const outgoing = await client.query(`
      select kcu.column_name
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on tc.constraint_schema=kcu.constraint_schema and tc.constraint_name=kcu.constraint_name
      join information_schema.constraint_column_usage ccu
        on tc.constraint_schema=ccu.constraint_schema and tc.constraint_name=ccu.constraint_name
      where tc.constraint_type='FOREIGN KEY'
        and tc.table_schema='comoasi'
        and tc.table_name='reels'
        and ccu.table_schema='comoasi'
        and ccu.table_name='reel_jobs'
    `);
    for (const row of outgoing.rows) {
      if (/^[a-z_][a-z0-9_]*$/i.test(row.column_name)) {
        await client.query(`update comoasi.reels set "${row.column_name}"=null where id=any($1::uuid[])`, [ids]);
      }
    }

    const incoming = await client.query(`
      select tc.table_name, kcu.column_name
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on tc.constraint_schema=kcu.constraint_schema and tc.constraint_name=kcu.constraint_name
      join information_schema.constraint_column_usage ccu
        on tc.constraint_schema=ccu.constraint_schema and tc.constraint_name=ccu.constraint_name
      where tc.constraint_type='FOREIGN KEY'
        and tc.table_schema='comoasi'
        and ccu.table_schema='comoasi'
        and ccu.table_name='reels'
        and ccu.column_name='id'
    `);
    for (const row of incoming.rows) {
      if (/^[a-z_][a-z0-9_]*$/i.test(row.table_name) && /^[a-z_][a-z0-9_]*$/i.test(row.column_name)) {
        await client.query(`delete from comoasi."${row.table_name}" where "${row.column_name}"=any($1::uuid[])`, [ids]);
      }
    }
    await client.query('delete from comoasi.reels where id=any($1::uuid[])', [ids]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function enforceReelRetention(limit = RETENTION_LIMIT) {
  if (enforcing) return retentionStatus();
  enforcing = true;
  try {
    let removed = 0;
    while (true) {
      const stale = await staleReels(limit);
      if (!stale.length) break;
      const ids = uuidArray(stale.map(row => row.id));
      const assetResult = await studioCall('/api/assets/delete-reels', { reelIds: ids }, { timeoutMs: 300000, attempts: 2 });
      if (!assetResult?.ok) throw new Error('asset_retention_failed');
      await deleteDatabaseRows(ids);
      removed += ids.length;
      console.info(`[como-asi] retention removed ${ids.length} old reel(s) and ${Number(assetResult.deletedCount || 0)} asset(s)`);
      if (stale.length < 50) break;
    }
    return { ...(await retentionStatus()), removed };
  } finally {
    enforcing = false;
  }
}

export function startRetentionDispatcher(intervalMs = 10 * 60 * 1000) {
  const initial = setTimeout(() => {
    void enforceReelRetention().catch(error => console.error('[como-asi] retention startup failed', error));
  }, 15000);
  initial.unref?.();
  const timer = setInterval(() => {
    void enforceReelRetention().catch(error => console.error('[como-asi] retention tick failed', error));
  }, intervalMs);
  timer.unref?.();
  console.log(`[como-asi] retention active: latest ${RETENTION_LIMIT} ready reels`);
}
