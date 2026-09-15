import crypto from 'node:crypto';
import { query } from './db.js';
import { studioCall } from './engine.js';

const accountKey = 'buffer';
const leaseMs = 15 * 60 * 1000;

const clean = value => String(value || '').trim();
const asObject = value => value && typeof value === 'object' ? value : {};

function idempotencyKey(reelId, network) {
  return `buffer:${reelId}:${network}`;
}

async function reserveNetwork({ reelId, network, scheduledAt }) {
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
  const key = idempotencyKey(reelId, network);
  const payload = {
    provider: 'buffer',
    idempotencyKey: key,
    leaseToken,
    leaseExpiresAt,
  };

  const acquired = await query(
    `insert into comoasi.publishing_queue as q
      (reel_id, platform, account_key, scheduled_at, status, publish_payload, error)
     values($1,$2,$3,$4,'publishing',$5::jsonb,null)
     on conflict (reel_id, platform, account_key) where account_key='buffer'
     do update set
       scheduled_at=excluded.scheduled_at,
       status='publishing',
       publish_payload=(q.publish_payload - 'leaseToken' - 'leaseExpiresAt') || excluded.publish_payload,
       error=null,
       updated_at=now()
     where q.status not in ('scheduled','published')
       and coalesce(nullif(q.publish_payload->>'leaseExpiresAt','')::timestamptz, to_timestamp(0)) <= now()
     returning q.*`,
    [reelId, network, accountKey, scheduledAt, JSON.stringify(payload)]
  );

  if (acquired.rows[0] && clean(acquired.rows[0].publish_payload?.leaseToken) === leaseToken) {
    return { acquired: true, leaseToken, idempotencyKey: key, row: acquired.rows[0] };
  }

  const existing = await query(
    `select * from comoasi.publishing_queue
      where reel_id=$1 and platform=$2 and account_key=$3
      limit 1`,
    [reelId, network, accountKey]
  );
  return { acquired: false, leaseToken: null, idempotencyKey: key, row: existing.rows[0] || null };
}

async function completeNetwork({ reelId, network, scheduledAt, leaseToken, result }) {
  const postId = clean(result.postId);
  if (!postId) throw new Error(`buffer_post_id_missing:${network}`);
  const payload = {
    provider: 'buffer',
    idempotencyKey: idempotencyKey(reelId, network),
    postId,
    channelId: clean(result.channelId) || null,
    duplicatePrevented: Boolean(result.duplicatePrevented),
    confirmedAt: new Date().toISOString(),
  };
  const updated = await query(
    `update comoasi.publishing_queue
        set status='scheduled',
            scheduled_at=$4,
            external_post_id=$5,
            publish_payload=(publish_payload - 'leaseToken' - 'leaseExpiresAt') || $6::jsonb,
            error=null,
            updated_at=now()
      where reel_id=$1 and platform=$2 and account_key=$3
        and publish_payload->>'leaseToken'=$7
      returning *`,
    [reelId, network, accountKey, scheduledAt, postId, JSON.stringify(payload), leaseToken]
  );
  if (updated.rows[0]) return updated.rows[0];

  const existing = await query(
    `select * from comoasi.publishing_queue
      where reel_id=$1 and platform=$2 and account_key=$3
      limit 1`,
    [reelId, network, accountKey]
  );
  const row = existing.rows[0];
  if (row?.external_post_id && ['scheduled', 'published'].includes(row.status)) return row;
  throw new Error(`buffer_idempotency_completion_failed:${network}`);
}

function existingResult(network, reservation) {
  const row = reservation.row || {};
  const payload = asObject(row.publish_payload);
  return {
    network,
    channelId: clean(payload.channelId) || null,
    postId: clean(row.external_post_id) || clean(payload.postId) || null,
    duplicatePrevented: true,
    idempotencyKey: reservation.idempotencyKey,
    idempotencySource: 'persistent-ledger',
  };
}

export async function scheduleBufferIdempotent({ reelId, scheduledAt, timezone, networks }) {
  const reservations = [];
  for (const network of networks) {
    reservations.push({ network, ...(await reserveNetwork({ reelId, network, scheduledAt })) });
  }

  const results = [];
  const acquired = [];
  for (const reservation of reservations) {
    const row = reservation.row || {};
    const final = ['scheduled', 'published'].includes(row.status) && clean(row.external_post_id);
    if (final) {
      results.push(existingResult(reservation.network, reservation));
      continue;
    }
    if (!reservation.acquired) {
      throw new Error(`buffer_schedule_in_progress:${reservation.network}`);
    }
    acquired.push(reservation);
  }

  if (acquired.length) {
    const scheduled = asObject(await studioCall('/api/buffer/create', {
      reelId,
      scheduledAt,
      timezone,
      networks: acquired.map(item => item.network),
    }, { timeoutMs: 120000, attempts: 4 }));

    const remoteResults = Array.isArray(scheduled.results) ? scheduled.results.map(asObject) : [];
    for (const reservation of acquired) {
      const remote = remoteResults.find(item => clean(item.network) === reservation.network);
      if (!remote) throw new Error(`buffer_result_missing:${reservation.network}`);
      await completeNetwork({
        reelId,
        network: reservation.network,
        scheduledAt,
        leaseToken: reservation.leaseToken,
        result: remote,
      });
      results.push({
        ...remote,
        idempotencyKey: reservation.idempotencyKey,
        idempotencySource: 'persistent-ledger',
      });
    }
  }

  const ordered = networks.map(network => results.find(item => clean(item.network) === network)).filter(Boolean);
  console.info('[como-asi] Buffer idempotency confirmed', reelId, ordered.map(item => `${item.network}:${item.postId || 'pending'}`).join(','));
  return {
    ok: true,
    provider: 'buffer',
    scheduledAt,
    results: ordered,
    scheduled: ordered,
    duplicatePrevented: ordered.length > 0 && ordered.every(item => Boolean(item.duplicatePrevented)),
    idempotency: 'reel-network-persistent-v1',
  };
}
