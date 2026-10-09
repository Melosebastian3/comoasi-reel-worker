// Schedules a batch manifest on Buffer (Instagram Reels, TikTok, YouTube Shorts).
// Ported from the Studio backend (branch migration/studio-without-appdeploy, scheduleBufferReel).
//
//   node publish/buffer.js <manifest.json> --media-base <public url prefix> [--live]
//
// Without --live it only reads the account, checks the channels and the video URLs, and prints
// what it would create. --live also needs PUBLISH_ENABLED=true, so nothing is posted by accident.
// Auth: BUFFER_API_KEY (Buffer → Settings → API → Personal Access).
import fs from 'node:fs/promises';

const NETWORKS = ['instagram', 'tiktok', 'youtube'];
const TIMEZONE_OFFSET = '-03:00'; // America/Argentina/Buenos_Aires has no DST

const asObject = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const asArray = value => (Array.isArray(value) ? value : []);
const asString = (value, fallback = '') => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
const option = name => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
};

async function bufferGraphql(query, variables = {}) {
  const key = asString(process.env.BUFFER_API_KEY);
  if (!key) throw new Error('buffer_api_key_missing');
  const response = await fetch('https://api.buffer.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(() => ({}));
  const errors = asArray(payload.errors).map(item => asString(asObject(item).message)).filter(Boolean);
  if (!response.ok || errors.length) {
    const retryAfter = asString(response.headers.get('retry-after'));
    throw new Error(`buffer_api_failed:${response.status}:${errors.join(' | ') || 'unknown_error'}${retryAfter ? `:retryAfter=${retryAfter}` : ''}`);
  }
  return asObject(payload.data);
}

async function bufferChannels() {
  const account = await bufferGraphql('query ComoAsiBufferAccount { account { organizations { id name } } }');
  const organizations = asArray(asObject(account.account).organizations).map(asObject).filter(row => row.id);
  if (!organizations.length) throw new Error('buffer_organization_missing');
  const channels = [];
  for (const organization of organizations) {
    const data = await bufferGraphql('query ComoAsiBufferChannels($organizationId: OrganizationId!) { channels(input: { organizationId: $organizationId }) { id name service } }', { organizationId: organization.id });
    for (const row of asArray(data.channels).map(asObject)) {
      const service = asString(row.service).toLowerCase();
      if (row.id && service) channels.push({ id: row.id, name: asString(row.name, service), service, organizationId: organization.id });
    }
  }
  return channels;
}

function normalizedHashtags(platform) {
  const tags = asArray(asObject(platform).hashtags).map(tag => asString(tag).replace(/^#+/, '').replace(/\s+/g, '')).filter(Boolean);
  if (!tags.some(tag => tag.toLowerCase() === 'comoasi')) tags.push('ComoAsi');
  return [...new Set(tags.map(tag => `#${tag}`))].slice(0, 6);
}

function publicationText(kitValue, network) {
  const platform = asObject(asObject(kitValue)[network]);
  const caption = network === 'youtube'
    ? [asString(platform.title), asString(platform.description)].filter(Boolean).join('\n\n')
    : asString(platform.caption);
  const lower = caption.toLocaleLowerCase('es');
  const missing = normalizedHashtags(platform).filter(tag => !lower.includes(tag.toLocaleLowerCase('es')));
  return [caption, missing.join(' ')].filter(Boolean).join('\n\n').trim();
}

function bufferMetadata(network, reel) {
  if (network === 'instagram') return { instagram: { type: 'reel', shouldShareToFeed: true, isAiGenerated: true } };
  if (network === 'tiktok') return { tiktok: { isAiGenerated: true } };
  const youtube = asObject(asObject(reel.publishingKit).youtube);
  return { youtube: {
    title: asString(youtube.title, asString(reel.title, '¿Cómo Así?')).slice(0, 100),
    categoryId: '24',
    madeForKids: false,
    privacy: 'public',
    isAiGenerated: true,
    embeddable: true,
  } };
}

async function scheduledPosts(organizationId, channelIds, when) {
  const data = await bufferGraphql('query ComoAsiBufferScheduled($input: PostsInput!) { posts(first: 50, input: $input) { edges { node { id text status dueAt channelId } } } }', {
    input: {
      organizationId,
      filter: {
        status: ['scheduled'],
        channelIds,
        startDate: new Date(when.getTime() - 10 * 60000).toISOString(),
        endDate: new Date(when.getTime() + 10 * 60000).toISOString(),
      },
    },
  });
  return asArray(asObject(data.posts).edges).map(edge => asObject(asObject(edge).node));
}

async function main() {
  const [manifestPath] = process.argv.slice(2);
  const mediaBase = asString(option('media-base')).replace(/\/+$/, '');
  const live = process.argv.includes('--live');
  if (!manifestPath || !mediaBase) throw new Error('usage: buffer.js <manifest.json> --media-base <url> [--live]');
  if (live && process.env.PUBLISH_ENABLED !== 'true') throw new Error('publish_not_enabled: set PUBLISH_ENABLED=true to post');

  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const channels = await bufferChannels();
  console.log(`[buffer] channels: ${channels.map(channel => `${channel.service}:${channel.name}`).join(', ') || 'none'}`);
  const missing = NETWORKS.filter(network => !channels.some(channel => channel.service === network));
  if (missing.length) console.warn(`[buffer] not connected in Buffer: ${missing.join(', ')}`);

  const report = [];
  for (const reel of asArray(manifest.reels).map(asObject).filter(row => row.status === 'completed')) {
    const when = new Date(`${manifest.date}T${reel.time}:00${TIMEZONE_OFFSET}`);
    if (when.getTime() < Date.now() + 5 * 60000) {
      report.push({ slot: reel.slot, skipped: 'time_already_passed', when: when.toISOString() });
      continue;
    }
    const videoUrl = `${mediaBase}/${reel.slot}-${reel.reelId}.mp4`;
    const head = await fetch(videoUrl, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(20000) }).catch(error => ({ ok: false, status: String(error.message || error) }));
    if (!head.ok) {
      report.push({ slot: reel.slot, error: `video_not_public:${head.status}`, videoUrl });
      continue;
    }
    for (const channel of channels.filter(row => NETWORKS.includes(row.service))) {
      const text = publicationText(reel.publishingKit, channel.service);
      const existing = await scheduledPosts(channel.organizationId, [channel.id], when);
      const duplicate = existing.find(row => row.channelId === channel.id && Math.abs(new Date(row.dueAt).getTime() - when.getTime()) < 60000);
      if (duplicate) {
        report.push({ slot: reel.slot, network: channel.service, postId: duplicate.id, duplicatePrevented: true });
        continue;
      }
      const input = {
        text,
        channelId: channel.id,
        schedulingType: 'automatic',
        mode: 'customScheduled',
        dueAt: when.toISOString(),
        assets: [{ video: { url: videoUrl } }],
        metadata: bufferMetadata(channel.service, reel),
        aiAssisted: true,
        source: 'como-asi-autopilot',
      };
      if (!live) {
        report.push({ slot: reel.slot, network: channel.service, dryRun: true, dueAt: input.dueAt, text: text.slice(0, 80) });
        continue;
      }
      const data = await bufferGraphql('mutation ComoAsiCreateBufferPost($input: CreatePostInput!) { createPost(input: $input) { ... on PostActionSuccess { post { id status dueAt channelId } } ... on MutationError { message } } }', { input });
      const action = asObject(data.createPost);
      const postId = asString(asObject(action.post).id);
      report.push(postId
        ? { slot: reel.slot, network: channel.service, postId, dueAt: input.dueAt }
        : { slot: reel.slot, network: channel.service, error: `buffer_create_failed:${asString(action.message, 'unknown_error')}` });
    }
  }
  console.log(JSON.stringify({ provider: 'buffer', live, date: manifest.date, report }, null, 2));
  if (report.some(row => row.error)) process.exitCode = 1;
}

main().catch(error => {
  console.error('[buffer] failed', error.message || error);
  process.exit(1);
});
