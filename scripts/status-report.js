// Writes one status snapshot for the phone panel: what each slot produced, what Buffer did with it,
// and how the last nightly runs ended. Read-only towards Buffer and GitHub; the only write is the
// single row comoasi.status_snapshot (id 'latest') in the actions-test database.
//
//   DATABASE_URL=... BUFFER_API_KEY=... GH_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/status-report.js
import { pool, query } from '../db.js';

const DAYS_BACK = 7;
const DAYS_AHEAD = 1;
const SLOTS = [
  { key: 'manana', time: '08:00' },
  { key: 'mediodia', time: '13:00' },
  { key: 'noche', time: '20:30' },
];

const asArray = value => (Array.isArray(value) ? value : []);
const asObject = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const dayInBuenosAires = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(date);

function dateKeys() {
  const keys = [];
  for (let offset = DAYS_AHEAD; offset >= -DAYS_BACK; offset -= 1) keys.push(dayInBuenosAires(new Date(Date.now() + offset * 86400000)));
  return keys;
}

async function bufferGraphql(queryText, variables = {}) {
  const response = await fetch('https://api.buffer.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.BUFFER_API_KEY}` },
    body: JSON.stringify({ query: queryText, variables }),
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(() => ({}));
  const errors = asArray(payload.errors).map(item => asObject(item).message).filter(Boolean);
  if (!response.ok || errors.length) throw new Error(`buffer ${response.status}: ${errors.join(' | ') || 'unknown error'}`);
  return asObject(payload.data);
}

async function bufferPosts(keys) {
  if (!process.env.BUFFER_API_KEY) return { error: 'BUFFER_API_KEY not set', posts: [] };
  const account = await bufferGraphql('query { account { organizations { id } } }');
  const posts = [];
  for (const { id: organizationId } of asArray(asObject(account.account).organizations)) {
    const channelData = await bufferGraphql('query ($organizationId: OrganizationId!) { channels(input: { organizationId: $organizationId }) { id service } }', { organizationId });
    const services = Object.fromEntries(asArray(channelData.channels).map(row => [row.id, String(row.service).toLowerCase()]));
    const data = await bufferGraphql('query ($input: PostsInput!) { posts(first: 100, input: $input) { edges { node { id status dueAt sentAt channelId text } } } }', {
      input: {
        organizationId,
        filter: {
          status: ['scheduled', 'sending', 'sent', 'error'],
          channelIds: Object.keys(services),
          startDate: new Date(`${keys.at(-1)}T00:00:00-03:00`).toISOString(),
          endDate: new Date(`${keys[0]}T23:59:59-03:00`).toISOString(),
        },
      },
    });
    for (const edge of asArray(asObject(data.posts).edges)) {
      const node = asObject(asObject(edge).node);
      posts.push({ id: node.id, network: services[node.channelId] || 'otro', status: node.status, dueAt: node.dueAt, sentAt: node.sentAt || null, text: String(node.text || '').slice(0, 140) });
    }
  }
  return { posts };
}

async function github(pathname) {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${pathname}`, {
    headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`github ${response.status} ${pathname}`);
  return response.json();
}

async function nightlyRuns() {
  const data = await github('/actions/workflows/produce-daily.yml/runs?per_page=10');
  return asArray(data.workflow_runs).map(run => ({
    id: run.id, event: run.event, status: run.status, conclusion: run.conclusion,
    startedAt: run.run_started_at, updatedAt: run.updated_at, url: run.html_url,
  }));
}

async function producedReels(keys) {
  const { rows } = await query(
    `select distinct on (j.payload->>'runKey')
        j.payload->>'date' as date, j.payload->>'slot' as slot, j.status, j.stage, j.error, j.updated_at,
        r.id as reel_id, r.title,
        coalesce(j.result->'topicData'->>'protagonist', j.result->'topicData'->>'title') as topic
       from comoasi.reel_jobs j left join comoasi.reels r on r.id = j.reel_id
      where j.payload->>'date' = any($1::text[]) and j.payload->>'runKey' like 'batch:%'
      order by j.payload->>'runKey', j.created_at desc`,
    [keys],
  );
  return rows;
}

async function main() {
  const keys = dateKeys();
  const problems = [];
  const safely = async (label, task, fallback) => {
    try { return await task(); } catch (error) { problems.push(`${label}: ${error.message || error}`); return fallback; }
  };
  const [reels, buffer, runs] = await Promise.all([
    safely('database', () => producedReels(keys), []),
    safely('buffer', () => bufferPosts(keys), { posts: [] }),
    safely('github', nightlyRuns, []),
  ]);
  if (buffer.error) problems.push(`buffer: ${buffer.error}`);

  const days = keys.map(date => ({
    date,
    slots: SLOTS.map(slot => {
      const due = new Date(`${date}T${slot.time}:00-03:00`).getTime();
      const reel = reels.find(row => row.date === date && row.slot === slot.key) || null;
      const posts = buffer.posts.filter(post => Math.abs(new Date(post.dueAt).getTime() - due) < 60000);
      return {
        slot: slot.key, time: slot.time,
        job: reel && { status: reel.status, stage: reel.stage, error: reel.error ? String(reel.error).slice(0, 300) : null, title: reel.title, topic: reel.topic, reelId: reel.reel_id, updatedAt: reel.updated_at },
        posts,
      };
    }),
  }));

  const snapshot = { generatedAt: new Date().toISOString(), days, runs, problems };
  await query(
    `insert into comoasi.status_snapshot (id, data, updated_at) values ('latest', $1, now())
     on conflict (id) do update set data = excluded.data, updated_at = now()`,
    [JSON.stringify(snapshot)],
  );
  const posted = buffer.posts.filter(post => post.status === 'sent').length;
  console.log(`[status] ${days.length} days, ${reels.length} jobs, ${buffer.posts.length} Buffer posts (${posted} sent), ${runs.length} runs, problems: ${problems.join('; ') || 'none'}`);
}

main().catch(error => {
  console.error('[status] failed', error.message || error);
  process.exitCode = 1;
}).finally(() => pool.end());
