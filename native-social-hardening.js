import fs from 'node:fs/promises';

const publisherPath = new URL('./social-publisher.js', import.meta.url);
const serverPath = new URL('./server.js', import.meta.url);
let source = await fs.readFile(publisherPath, 'utf8');

const oldTikTokAuthorize = `  if (network === 'tiktok') {
    const params = new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'user.info.basic,video.publish',
      state,
      code_challenge: codeChallenge || '',
      code_challenge_method: 'S256',
    });
    return \`https://www.tiktok.com/v2/auth/authorize/?\${params}\`;
  }`;
const newTikTokAuthorize = `  if (network === 'tiktok') {
    const params = new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'user.info.basic,video.publish',
      state,
    });
    return \`https://www.tiktok.com/v2/auth/authorize/?\${params}\`;
  }`;
if (source.includes(oldTikTokAuthorize)) source = source.replace(oldTikTokAuthorize, newTikTokAuthorize);

const oldTikTokTokenBody = `body: new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY, client_secret: process.env.TIKTOK_CLIENT_SECRET, code, grant_type: 'authorization_code', redirect_uri: redirectUri, code_verifier: codeVerifier || '' }),`;
const newTikTokTokenBody = `body: new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY, client_secret: process.env.TIKTOK_CLIENT_SECRET, code, grant_type: 'authorization_code', redirect_uri: redirectUri }),`;
if (source.includes(oldTikTokTokenBody)) source = source.replace(oldTikTokTokenBody, newTikTokTokenBody);

const oldReview = `review: network === 'tiktok' && process.env.TIKTOK_AUDITED !== 'true' ? 'audit_required_for_public_posts' : network === 'youtube' && process.env.YOUTUBE_API_AUDITED !== 'true' ? 'audit_required_for_public_posts' : null,`;
const newReview = `review: network === 'tiktok' ? (process.env.TIKTOK_AUDITED === 'true' ? 'explicit_consent_required_per_post' : 'audit_required_for_public_posts') : network === 'youtube' && process.env.YOUTUBE_API_AUDITED !== 'true' ? 'audit_required_for_public_posts' : null,`;
if (source.includes(oldReview)) source = source.replace(oldReview, newReview);

const publishTikTokPattern = /async function publishTikTok\(reel, videoUrl\) \{[\s\S]*?\n\}\n\nasync function publishYoutube/;
const hardenedTikTok = `async function publishTikTok(reel, videoUrl) {
  const account = await refreshedConnection('tiktok');
  const copy = publishingCopy(reel.publishing_kit, 'tiktok', reel.title || reel.topic);

  const creatorResponse = await fetch('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', {
    method: 'POST',
    headers: { Authorization: \`Bearer \${account.accessToken}\`, 'content-type': 'application/json; charset=UTF-8' },
    body: '{}',
    signal: AbortSignal.timeout(30000),
  });
  const creatorPayload = await jsonBody(creatorResponse);
  const creatorError = clean(creatorPayload?.error?.code);
  if (!creatorResponse.ok || (creatorError && creatorError !== 'ok')) {
    throw new Error(\`tiktok_creator_info_failed:\${clean(creatorPayload?.error?.message || creatorError)}\`);
  }
  const creator = creatorPayload?.data || {};
  const privacyOptions = Array.isArray(creator.privacy_level_options) ? creator.privacy_level_options : [];
  if (!privacyOptions.includes('PUBLIC_TO_EVERYONE')) {
    throw new Error('tiktok_public_post_unavailable:audit_or_account_privacy');
  }

  const media = await fetch(videoUrl, { signal: AbortSignal.timeout(90000) });
  if (!media.ok) throw new Error('tiktok_video_download_failed');
  const video = new Uint8Array(await media.arrayBuffer());
  const videoSize = video.byteLength;
  if (!videoSize) throw new Error('tiktok_video_empty');

  const maxChunk = 64_000_000;
  const chunkSize = Math.min(videoSize, maxChunk);
  const totalChunkCount = Math.max(1, Math.floor(videoSize / chunkSize));
  const initResponse = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
    method: 'POST',
    headers: { Authorization: \`Bearer \${account.accessToken}\`, 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      post_info: {
        title: copy.text.slice(0, 2200),
        privacy_level: 'PUBLIC_TO_EVERYONE',
        disable_duet: Boolean(creator.duet_disabled),
        disable_comment: Boolean(creator.comment_disabled),
        disable_stitch: Boolean(creator.stitch_disabled),
        video_cover_timestamp_ms: 1000,
        brand_content_toggle: false,
        brand_organic_toggle: false,
        is_aigc: true,
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: videoSize,
        chunk_size: chunkSize,
        total_chunk_count: totalChunkCount,
      },
    }),
    signal: AbortSignal.timeout(30000),
  });
  const init = await jsonBody(initResponse);
  const initError = clean(init?.error?.code);
  if (!initResponse.ok || (initError && initError !== 'ok') || !clean(init?.data?.publish_id) || !clean(init?.data?.upload_url)) {
    throw new Error(\`tiktok_publish_init_failed:\${clean(init?.error?.message || initError || 'invalid_response')}\`);
  }

  const publishId = clean(init.data.publish_id);
  const uploadUrl = clean(init.data.upload_url);
  let offset = 0;
  for (let index = 0; index < totalChunkCount; index += 1) {
    const finalChunk = index === totalChunkCount - 1;
    const endExclusive = finalChunk ? videoSize : Math.min(videoSize, offset + chunkSize);
    const chunk = video.slice(offset, endExclusive);
    const endInclusive = endExclusive - 1;
    const upload = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'content-type': 'video/mp4',
        'content-length': String(chunk.byteLength),
        'content-range': \`bytes \${offset}-\${endInclusive}/\${videoSize}\`,
      },
      body: chunk,
      signal: AbortSignal.timeout(120000),
    });
    if (!upload.ok) throw new Error(\`tiktok_file_upload_failed:\${upload.status}\`);
    offset = endExclusive;
  }

  for (let attempt = 0; attempt < 24; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const statusResponse = await fetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
      method: 'POST',
      headers: { Authorization: \`Bearer \${account.accessToken}\`, 'content-type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ publish_id: publishId }),
      signal: AbortSignal.timeout(30000),
    });
    const statusPayload = await jsonBody(statusResponse);
    const statusError = clean(statusPayload?.error?.code);
    if (!statusResponse.ok || (statusError && statusError !== 'ok')) {
      throw new Error(\`tiktok_status_failed:\${clean(statusPayload?.error?.message || statusError)}\`);
    }
    const status = clean(statusPayload?.data?.status);
    if (status === 'FAILED') throw new Error(\`tiktok_publish_failed:\${clean(statusPayload?.data?.fail_reason || 'unknown')}\`);
    if (status === 'PUBLISH_COMPLETE') {
      const postIds = Array.isArray(statusPayload?.data?.publicaly_available_post_id) ? statusPayload.data.publicaly_available_post_id : [];
      return clean(postIds[0]) || publishId;
    }
  }
  throw new Error(\`tiktok_publish_processing_timeout:\${publishId}\`);
}

async function publishYoutube`;
if (!publishTikTokPattern.test(source)) throw new Error('native_tiktok_publish_target_not_found');
source = source.replace(publishTikTokPattern, hardenedTikTok);

const oldQueueSignature = `export async function queuePublishAll({ reelId, selectedNetworks, scheduledAt }) {`;
const newQueueSignature = `export async function queuePublishAll({ reelId, selectedNetworks, scheduledAt, explicitConsent = false }) {`;
if (source.includes(oldQueueSignature)) source = source.replace(oldQueueSignature, newQueueSignature);

const consentAnchor = `  if (!reelId || !requested.length) throw new Error('reel_and_networks_required');\n  const status = await socialStatus();`;
const consentBlock = `  if (!reelId || !requested.length) throw new Error('reel_and_networks_required');\n  if (requested.includes('tiktok') && explicitConsent !== true) {\n    const consentError = new Error('tiktok_explicit_consent_required');\n    consentError.blocked = [{ network: 'tiktok', reason: 'explicit_consent_required_per_post' }];\n    throw consentError;\n  }\n  const status = await socialStatus();`;
if (source.includes(consentAnchor)) source = source.replace(consentAnchor, consentBlock);

await fs.writeFile(publisherPath, source, 'utf8');

let server = await fs.readFile(serverPath, 'utf8');
const oldServerCall = `      selectedNetworks: req.body?.networks,\n      scheduledAt: req.body?.scheduledAt,`;
const newServerCall = `      selectedNetworks: req.body?.networks,\n      scheduledAt: req.body?.scheduledAt,\n      explicitConsent: req.body?.explicitConsent === true,`;
if (server.includes(oldServerCall)) server = server.replace(oldServerCall, newServerCall);
await fs.writeFile(serverPath, server, 'utf8');

console.log('[como-asi] native social hardening applied (TikTok web OAuth + creator info + FILE_UPLOAD + explicit consent)');
