import { ai, router, json, error, storage, secrets, requireAuth, withScopes } from '@appdeploy/sdk';

type Body = Record<string, unknown>;
type WorkerResult = { ok: boolean; status: number; data: unknown };

const workerBase = 'https://comoasi-reel-worker-production-4de5.up.railway.app';

function asBody(value: unknown): Body {
  return value && typeof value === 'object' ? (value as Body) : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseJsonText(text: string): unknown {
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(cleaned);
}

async function generateStructured(system: string, prompt: string, schema: Record<string, unknown>, maxTokens = 5000) {
  const result = await ai.generate({ system, prompt, schema, maxTokens, temperature: 0.45, thinkingMode: 'DEEP' });
  try {
    return parseJsonText(result.text);
  } catch {
    throw new Error('structured_generation_invalid_json');
  }
}

async function workerRequest(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<WorkerResult> {
  try {
    const response = await fetch(`${workerBase}${path}`, {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/json', 'x-como-asi-project': 'como-asi' } : { 'x-como-asi-project': 'como-asi' },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(12000),
    });
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { ok: response.ok, status: response.status, data };
  } catch (requestError) {
    return {
      ok: false,
      status: 503,
      data: { error: 'worker_unavailable', detail: requestError instanceof Error ? requestError.message : String(requestError) },
    };
  }
}

function workerResponse(result: WorkerResult) {
  if (!result.ok) return error(result.status === 404 ? 'not_found' : 'worker_unavailable', result.status || 503);
  return json(result.data);
}


const metricoolSecretNames = ['METRICOOL_API_TOKEN', 'METRICOOL_USER_ID', 'METRICOOL_BLOG_ID', 'METRICOOL_ALLOWED_EMAIL'];

async function metricoolConfig() {
  const configuredNames = await secrets.listSecretNames();
  const missing = metricoolSecretNames.filter(name => !configuredNames.includes(name));
  if (missing.length) return { configured: false as const, missing };
  return {
    configured: true as const,
    token: await secrets.readSecret('METRICOOL_API_TOKEN'),
    userId: await secrets.readSecret('METRICOOL_USER_ID'),
    blogId: await secrets.readSecret('METRICOOL_BLOG_ID'),
    allowedEmail: (await secrets.readSecret('METRICOOL_ALLOWED_EMAIL')).trim().toLowerCase(),
  };
}

type BufferChannel = { id: string; name: string; service: string; organizationId: string; organizationName: string };

async function bufferApiKey(): Promise<string> {
  const names = await secrets.listSecretNames();
  if (!names.includes('BUFFER_API_KEY')) throw new Error('buffer_api_key_missing');
  const key = (await secrets.readSecret('BUFFER_API_KEY')).trim();
  if (!key) throw new Error('buffer_api_key_missing');
  return key;
}

async function bufferGraphql(queryText: string, variables: Body = {}): Promise<Body> {
  const key = await bufferApiKey();
  const response = await fetch('https://api.buffer.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: queryText, variables }),
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(() => ({})) as Body;
  const rawErrors = asArray(payload.errors).map(asBody);
  const errors = rawErrors.map(item => asString(item.message)).filter(Boolean);
  if (!response.ok || errors.length) {
    const retryAfter = asString(response.headers.get('retry-after'));
    const window = rawErrors.map(item => asString(asBody(item.extensions).window)).find(Boolean) || '';
    throw new Error(`buffer_api_failed:${response.status}:${errors.join(' | ') || 'unknown_error'}${window ? `:window=${window}` : ''}${retryAfter ? `:retryAfter=${retryAfter}` : ''}`);
  }
  return asBody(payload.data);
}

async function bufferChannels(): Promise<{ channels: BufferChannel[]; organizations: { id: string; name: string }[] }> {
  const accountData = await bufferGraphql('query ComoAsiBufferAccount { account { organizations { id name } } }');
  const organizations = asArray(asBody(accountData.account).organizations).map(item => {
    const row = asBody(item);
    return { id: asString(row.id), name: asString(row.name) };
  }).filter(item => item.id);
  if (!organizations.length) throw new Error('buffer_organization_missing');
  const channels: BufferChannel[] = [];
  for (const organization of organizations) {
    const data = await bufferGraphql('query ComoAsiBufferChannels($organizationId: OrganizationId!) { channels(input: { organizationId: $organizationId }) { id name service } }', { organizationId: organization.id });
    for (const item of asArray(data.channels)) {
      const row = asBody(item);
      const id = asString(row.id);
      const service = asString(row.service).toLowerCase();
      if (id && service) channels.push({ id, name: asString(row.name, service), service, organizationId: organization.id, organizationName: organization.name });
    }
  }
  return { channels, organizations };
}

function bufferMetadata(network: string, reel: Body): Body {
  if (network === 'instagram') return { instagram: { type: 'reel', shouldShareToFeed: true, isAiGenerated: true } };
  if (network === 'tiktok') return { tiktok: { isAiGenerated: true } };
  const kit = asBody(reel.publishing_kit);
  const youtube = asBody(kit.youtube);
  return { youtube: {
    title: asString(youtube.title, asString(reel.title, asString(reel.topic, '¿Cómo Así?'))).slice(0, 100),
    categoryId: '24',
    madeForKids: false,
    privacy: 'public',
    isAiGenerated: true,
    embeddable: true,
  } };
}

async function scheduleBufferReel(body: Body) {
  const reelId = asString(body.reelId);
  const when = new Date(asString(body.scheduledAt));
  const allowed = new Set(['instagram', 'tiktok', 'youtube']);
  const networks = [...new Set(asArray(body.networks).map(value => asString(value).toLowerCase()).filter(value => allowed.has(value)))];
  if (!reelId || !Number.isFinite(when.getTime()) || when.getTime() < Date.now() + 60000 || !networks.length) return error('invalid_schedule_request', 400);

  const source = await workerRequest('/api/reels/' + encodeURIComponent(reelId));
  if (!source.ok || !source.data || typeof source.data !== 'object') return error('reel_not_found', 404);
  const reel = source.data as Body;
  if (asString(reel.status) !== 'ready' || !asString(reel.video_object_key)) return error('reel_not_ready', 409);

  const context = await bufferChannels();
  const selected = networks.map(network => context.channels.find(channel => channel.service === network)).filter((value): value is BufferChannel => Boolean(value));
  const missing = networks.filter(network => !selected.some(channel => channel.service === network));
  if (missing.length) return json({ error: 'buffer_channels_missing', missing }, 409);

  const existing: Body[] = [];
  const groups = new Map<string, BufferChannel[]>();
  for (const channel of selected) groups.set(channel.organizationId, [...(groups.get(channel.organizationId) || []), channel]);
  for (const [organizationId, channels] of groups) {
    const data = await bufferGraphql('query ComoAsiBufferScheduled($input: PostsInput!) { posts(first: 50, input: $input) { edges { node { id text status dueAt channelId } } } }', {
      input: {
        organizationId,
        filter: {
          status: ['scheduled'],
          channelIds: channels.map(channel => channel.id),
          startDate: new Date(when.getTime() - 10 * 60000).toISOString(),
          endDate: new Date(when.getTime() + 10 * 60000).toISOString(),
        },
      },
    });
    for (const edge of asArray(asBody(data.posts).edges)) existing.push(asBody(asBody(edge).node));
  }

  const videoUrl = `${workerBase}/media/${encodeURIComponent(reelId)}.mp4`;
  const results: Body[] = [];
  for (const channel of selected) {
    const text = publicationText(reel.publishing_kit, [channel.service]);
    if (!text) return json({ error: 'publishing_copy_unavailable', network: channel.service }, 409);
    const duplicate = existing.find(row => {
      const dueAt = new Date(asString(row.dueAt)).getTime();
      return asString(row.channelId) === channel.id && asString(row.text) === text && Number.isFinite(dueAt) && Math.abs(dueAt - when.getTime()) < 60000;
    });
    if (duplicate) {
      results.push({ network: channel.service, channelId: channel.id, postId: asString(duplicate.id), duplicatePrevented: true });
      continue;
    }
    const data = await bufferGraphql('mutation ComoAsiCreateBufferPost($input: CreatePostInput!) { createPost(input: $input) { ... on PostActionSuccess { post { id text status dueAt channelId } } ... on MutationError { message } } }', {
      input: {
        text,
        channelId: channel.id,
        schedulingType: 'automatic',
        mode: 'customScheduled',
        dueAt: when.toISOString(),
        assets: [{ video: { url: videoUrl } }],
        metadata: bufferMetadata(channel.service, reel),        aiAssisted: true,
        source: 'como-asi-autopilot',
      },
    });
    const action = asBody(data.createPost);
    const post = asBody(action.post);
    const postId = asString(post.id);
    if (!postId) throw new Error(`buffer_create_failed:${channel.service}:${asString(action.message, 'unknown_error')}`);
    results.push({ network: channel.service, channelId: channel.id, postId, duplicatePrevented: false, dueAt: asString(post.dueAt) });
  }
  return json({ ok: true, provider: 'buffer', scheduledAt: when.toISOString(), videoUrl, results });
}

const publicationNetworks = ['instagram', 'tiktok', 'youtube'];

function publicationSnapshot(queueValue: unknown, reelId: string) {
  const rows = asArray(queueValue)
    .map(asBody)
    .filter(row => asString(row.reel_id) === reelId && publicationNetworks.includes(asString(row.platform)));
  const nowMs = Date.now();
  const networks = publicationNetworks.map(network => {
    const candidates = rows
      .filter(row => asString(row.platform) === network)
      .sort((a, b) => new Date(asString(b.updated_at)).getTime() - new Date(asString(a.updated_at)).getTime());
    const selected = candidates.find(row => asString(row.status) === 'published' || Boolean(asString(row.published_at)))
      || candidates.find(row => ['scheduled', 'publishing'].includes(asString(row.status)))
      || candidates.find(row => ['failed', 'overdue'].includes(asString(row.status)))
      || candidates[0];
    const scheduledAt = selected ? asString(selected.scheduled_at) || null : null;
    const scheduledMs = scheduledAt ? new Date(scheduledAt).getTime() : NaN;
    let status = !selected
      ? 'missing'
      : asString(selected.status) === 'published' || Boolean(asString(selected.published_at))
        ? 'published'
        : asString(selected.status, 'scheduled');
    if (status === 'publishing' && Number.isFinite(scheduledMs)) {
      if (scheduledMs - nowMs > 2 * 60 * 1000) status = 'scheduled';
      else if (nowMs - scheduledMs > 10 * 60 * 1000) status = 'overdue';
    }
    if (status === 'scheduled' && Number.isFinite(scheduledMs) && nowMs - scheduledMs > 10 * 60 * 1000) status = 'overdue';
    return {
      network,
      status,
      provider: selected ? asString(selected.account_key) || null : null,
      scheduledAt,
      publishedAt: selected ? asString(selected.published_at) || null : null,
      error: selected ? asString(asBody(selected.publish_payload).contingencyLastError) || asString(selected.error) || null : null,
    };
  });
  const statuses = networks.map(item => item.status);
  const activeCount = statuses.filter(item => item === 'scheduled' || item === 'publishing').length;
  const inactiveCount = statuses.filter(item => item === 'cancelled' || item === 'missing').length;
  let status = 'generated';
  if (statuses.every(item => item === 'published')) status = 'published';
  else if (statuses.some(item => item === 'published')) status = 'partial';
  else if (statuses.some(item => item === 'failed' || item === 'overdue')) status = statuses.some(item => item === 'overdue') ? 'overdue' : 'failed';
  else if (activeCount > 0 && inactiveCount > 0) status = 'scheduled_partial';
  else if (statuses.some(item => item === 'publishing')) status = 'publishing';
  else if (statuses.some(item => item === 'scheduled')) status = 'scheduled';
  const scheduledValues = networks.map(item => item.scheduledAt).filter(Boolean).map(value => new Date(String(value)).getTime()).filter(Number.isFinite);
  const publishedValues = networks.map(item => item.publishedAt).filter(Boolean).map(value => new Date(String(value)).getTime()).filter(Number.isFinite);
  const scheduledAt = scheduledValues.length ? new Date(Math.min(...scheduledValues)).toISOString() : null;
  const publishedAt = publishedValues.length ? new Date(Math.max(...publishedValues)).toISOString() : null;
  return { status, scheduledAt, publishedAt, networks, hasRecords: rows.length > 0 };
}

async function publishBufferNow(body: Body) {
  const reelId = asString(body.reelId);
  const requested = asArray(body.networks).map(value => asString(value).toLowerCase());
  const networks = [...new Set((requested.length ? requested : publicationNetworks).filter(value => publicationNetworks.includes(value)))];
  if (!reelId || !networks.length) throw new Error('manual_publish_invalid_request');

  const source = await workerRequest('/api/reels/' + encodeURIComponent(reelId));
  if (!source.ok || !source.data || typeof source.data !== 'object') throw new Error('reel_not_found');
  const reel = source.data as Body;
  if (asString(reel.status) !== 'ready' || !asString(reel.video_object_key)) throw new Error('reel_not_ready');

  const queueResult = await workerRequest('/api/publisher/queue');
  const queueRows = queueResult.ok ? asArray(queueResult.data).map(asBody) : [];
  const videoUrl = `${workerBase}/media/${encodeURIComponent(reelId)}.mp4`;
  const dueAt = new Date(Date.now() + 90 * 1000).toISOString();
  let channels: BufferChannel[] | null = null;
  const results: Body[] = [];

  for (const network of networks) {
    const existing = queueRows
      .filter(row => asString(row.reel_id) === reelId && asString(row.platform) === network && asString(row.account_key) === 'buffer' && asString(row.external_post_id) && asString(row.status) !== 'cancelled')
      .sort((a, b) => new Date(asString(b.updated_at)).getTime() - new Date(asString(a.updated_at)).getTime())[0];

    if (existing) {
      const postId = asString(existing.external_post_id);
      const data = await bufferGraphql('query ComoAsiManualPublishPost($input: PostInput!) { post(input: $input) { id status dueAt channelId channelService sentAt externalLink error { message rawError supportUrl } } }', { input: { id: postId } });
      const post = asBody(data.post);
      const remoteId = asString(post.id);
      if (!remoteId) throw new Error(`buffer_post_not_found:${network}`);
      const remoteStatus = asString(post.status).toLowerCase();
      if (remoteStatus === 'sent' || remoteStatus === 'sending') {
        results.push({ network, postId: remoteId, status: remoteStatus, dueAt: asString(post.dueAt), sentAt: asString(post.sentAt), externalLink: asString(post.externalLink) });
        continue;
      }
      const edited = await bufferGraphql('mutation ComoAsiManualPublishNow($input: EditPostInput!) { editPost(input: $input) { ... on PostActionSuccess { post { id status dueAt channelId channelService sentAt externalLink error { message rawError supportUrl } } } ... on MutationError { message } } }', {
        input: {
          id: remoteId,
          assets: [{ video: { url: videoUrl } }],
          metadata: bufferMetadata(network, reel),
          schedulingType: 'automatic',
          mode: 'customScheduled',
          dueAt,
          aiAssisted: true,
          source: 'como-asi-manual-now',
        },
      });
      const action = asBody(edited.editPost);
      const updated = asBody(action.post);
      const updatedId = asString(updated.id);
      if (!updatedId) throw new Error(`buffer_manual_publish_failed:${network}:${asString(action.message, 'unknown_error')}`);
      results.push({ network, postId: updatedId, status: asString(updated.status, 'scheduled'), dueAt: asString(updated.dueAt, dueAt), sentAt: asString(updated.sentAt), externalLink: asString(updated.externalLink) });
      continue;
    }

    if (!channels) channels = (await bufferChannels()).channels;
    const channel = channels.find(item => item.service === network);
    if (!channel) throw new Error(`buffer_channel_missing:${network}`);
    const text = publicationText(reel.publishing_kit, [network]);
    if (!text) throw new Error(`publishing_copy_unavailable:${network}`);
    const created = await bufferGraphql('mutation ComoAsiManualCreateNow($input: CreatePostInput!) { createPost(input: $input) { ... on PostActionSuccess { post { id status dueAt channelId channelService sentAt externalLink error { message rawError supportUrl } } } ... on MutationError { message } } }', {
      input: {
        text,
        channelId: channel.id,
        schedulingType: 'automatic',
        mode: 'customScheduled',
        dueAt,
        assets: [{ video: { url: videoUrl } }],
        metadata: bufferMetadata(network, reel),
        aiAssisted: true,
        source: 'como-asi-manual-now',
      },
    });
    const action = asBody(created.createPost);
    const post = asBody(action.post);
    const postId = asString(post.id);
    if (!postId) throw new Error(`buffer_manual_create_failed:${network}:${asString(action.message, 'unknown_error')}`);
    results.push({ network, postId, status: asString(post.status, 'scheduled'), dueAt: asString(post.dueAt, dueAt), sentAt: asString(post.sentAt), externalLink: asString(post.externalLink), channelId: channel.id });
  }

  return json({ ok: true, reelId, dueAt, results });
}

function normalizedHashtags(platformValue: unknown): string[] {
  const platform = asBody(platformValue);
  const tags = asArray(platform.hashtags)
    .map(tag => asString(tag).replace(/^#+/, '').replace(/\s+/g, ''))
    .filter(Boolean);
  if (!tags.some(tag => tag.toLowerCase() === 'comoasi')) tags.push('ComoAsi');
  return [...new Set(tags.map(tag => `#${tag}`))].slice(0, 6);
}

function appendMissingHashtags(textValue: unknown, platformValue: unknown): string {
  const text = asString(textValue).trim();
  const lower = text.toLocaleLowerCase('es');
  const missing = normalizedHashtags(platformValue).filter(tag => !lower.includes(tag.toLocaleLowerCase('es')));
  return [text, missing.join(' ')].filter(Boolean).join('\n\n').trim();
}

function publishingKitWithHashtags(value: unknown): Body {
  const kit = asBody(value);
  const instagram = asBody(kit.instagram);
  const tiktok = asBody(kit.tiktok);
  const youtube = asBody(kit.youtube);
  return {
    ...kit,
    instagram: { ...instagram, hashtags: normalizedHashtags(instagram).map(tag => tag.slice(1)), caption: appendMissingHashtags(instagram.caption, instagram) },
    tiktok: { ...tiktok, hashtags: normalizedHashtags(tiktok).map(tag => tag.slice(1)), caption: appendMissingHashtags(tiktok.caption, tiktok) },
    youtube: { ...youtube, hashtags: normalizedHashtags(youtube).map(tag => tag.slice(1)), description: appendMissingHashtags(youtube.description, youtube) },
  };
}

function publicationText(kitValue: unknown, networks: string[]): string {
  const kit = asBody(kitValue);
  const preferred = networks.length === 1 ? networks[0] : 'instagram';
  const platform = asBody(kit[preferred]);
  const caption = preferred === 'youtube'
    ? [asString(platform.title), asString(platform.description)].filter(Boolean).join('\n\n')
    : asString(platform.caption);
  return appendMissingHashtags(caption, platform);
}

function metricoolLocalDateTime(isoDate: string, timezone: string): string {
  const date = new Date(isoDate);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || '';  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}:${value('second')}`;
}


const metricoolClientId = 'client_1b74aa2c07594a30bbf20f5d1a1efb1a';
const metricoolMcpUrl = 'https://ai.metricool.com/mcp';
function parseMcp(text: string, id?: number): Record<string, unknown> {
  if (!text.trim()) return {};
  try { return JSON.parse(text) as Record<string, unknown>; } catch {
    const rows = text.split(/\r?\n/).filter(line => line.startsWith('data:')).flatMap(line => { try { return [JSON.parse(line.slice(5).trim()) as Record<string, unknown>]; } catch { return []; } });
    return rows.find(row => id == null || row.id === id) || rows.at(-1) || {};
  }
}
async function mcpPost(token: string, payload: Record<string, unknown>, session = '') {
  const headers: Record<string, string> = { authorization: 'Bearer ' + token, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18' };
  if (session) headers['mcp-session-id'] = session;
  const response = await fetch(metricoolMcpUrl, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
  const value = parseMcp(await response.text(), typeof payload.id === 'number' ? payload.id : undefined);
  if (!response.ok || value.error) throw new Error('metricool_mcp_' + response.status);
  return { value, session: response.headers.get('mcp-session-id') || session };
}
function mcpValue(envelope: Record<string, unknown>): unknown {
  const result = asBody(envelope.result); if (result.structuredContent) return result.structuredContent;
  for (const item of asArray(result.content)) { const text = asString(asBody(item).text); if (!text) continue; try { return JSON.parse(text); } catch { return text; } }
  return result;
}
async function metricoolTool(token: string, match: string, args: Record<string, unknown>) {
  const init = await mcpPost(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'como-asi-studio', version: '1' } } });
  await mcpPost(token, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.session);
  const list = await mcpPost(token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init.session);
  const wanted = match.toLowerCase().replace(/[^a-z0-9]/g, '');
  const availableTools = asArray(asBody(list.value.result).tools).map(asBody); const normalizedToolName = (row: Body) => asString(row.name).toLowerCase().replace(/[^a-z0-9]/g, ''); const tool = availableTools.find(row => normalizedToolName(row) === wanted) || availableTools.find(row => normalizedToolName(row).includes(wanted));
  const name = asString(tool?.name); if (!name) throw new Error('metricool_tool_unavailable');
  const call = await mcpPost(token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }, init.session);
  if (asBody(call.value.result).isError) { const detail = asArray(asBody(call.value.result).content).map(item => asString(asBody(item).text)).filter(Boolean).join(' · '); throw new Error(detail || 'Metricool rechazó la publicación'); }
  return mcpValue(call.value);
}
function scheduledPostRows(value: unknown): Body[] {
  const rows: Body[] = [];
  const visited = new Set<object>();
  const visit = (node: unknown, depth = 0) => {
    if (depth > 8 || node == null) return;
    if (typeof node === 'string') {
      const text = node.trim();
      if ((text.startsWith('{') || text.startsWith('[')) && text.length < 500000) {
        try { visit(JSON.parse(text), depth + 1); } catch {}
      }
      return;
    }
    if (typeof node !== 'object') return;
    if (visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      node.forEach(item => visit(item, depth + 1));
      return;
    }
    const row = node as Body;
    const publicationDate = asBody(row.publicationDate);
    const dateValue = asString(publicationDate.dateTime) || asString(row.date) || asString(row.scheduledAt) || asString(row.publication_date);
    if (dateValue && (row.id != null || row.uuid != null || row.providers != null)) rows.push(row);
    Object.values(row).forEach(item => visit(item, depth + 1));
  };
  visit(value);
  return rows;
}
function sameScheduledPost(row: Body, targetLocalDateTime: string, targetIso: string, targetText: string): boolean {
  const publicationDate = asBody(row.publicationDate);
  const dateValues = [asString(publicationDate.dateTime), asString(row.date), asString(row.scheduledAt), asString(row.publication_date)].filter(Boolean);
  const targetMinute = targetLocalDateTime.slice(0, 16);
  const targetMs = new Date(targetIso).getTime();
  const dateMatches = dateValues.some(value => {
    if (value.slice(0, 16) === targetMinute) return true;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) && Math.abs(parsed - targetMs) < 60000;
  });
  if (!dateMatches) return false;
  const rowText = asString(row.text);
  return !rowText || rowText === targetText;
}

function metricoolAnalyticsRows(value: unknown, metrics: string[]): Body[] {
  const tables: unknown[][] = [];
  const visited = new Set<object>();
  const visit = (node: unknown, depth = 0) => {
    if (depth > 8 || node == null) return;
    if (typeof node === 'string') {
      const text = node.trim();
      if ((text.startsWith('{') || text.startsWith('[')) && text.length < 500000) {
        try { visit(JSON.parse(text), depth + 1); } catch {}
      }
      return;
    }
    if (typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) { node.forEach(item => visit(item, depth + 1)); return; }
    const row = node as Body;
    if (Array.isArray(row.rows)) tables.push(row.rows as unknown[]);
    else Object.values(row).forEach(item => visit(item, depth + 1));
  };
  visit(value);
  return tables.flat().flatMap(raw => {
    if (Array.isArray(raw)) {
      const row: Body = {};
      metrics.forEach((metric, index) => { row[metric] = raw[index]; });
      return [row];
    }
    return raw && typeof raw === 'object' ? [raw as Body] : [];
  });
}

function metricoolComparable(value: unknown): string {
  return asString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/#/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function metricoolContentMatches(actualValue: unknown, expectedValue: unknown): boolean {
  const actual = metricoolComparable(actualValue);
  const expected = metricoolComparable(expectedValue);
  if (!actual || !expected) return false;
  if (actual === expected) return true;
  const prefixLength = Math.min(actual.length, expected.length, 120);
  return prefixLength >= 40 && actual.slice(0, prefixLength) === expected.slice(0, prefixLength);
}

function metricoolLocalStampValue(value: unknown): number {
  const digits = asString(value).replace(/\D/g, '').slice(0, 14);
  if (digits.length < 12) return Number.NaN;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const hour = Number(digits.slice(8, 10));
  const minute = Number(digits.slice(10, 12));
  const second = Number(digits.slice(12, 14) || '0');
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function metricoolLocalStampToIso(value: unknown, timezone: string): string {
  const localValue = metricoolLocalStampValue(value);
  if (!Number.isFinite(localValue)) return '';
  let guess = localValue;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(guess));
    const part = (type: string) => Number(parts.find(item => item.type === type)?.value || 0);
    const represented = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
    guess += localValue - represented;
  }
  return new Date(guess).toISOString();
}

function exactScheduledDuplicate(row: Body, targetLocalDateTime: string, targetText: string): boolean {
  const publicationDate = asBody(row.publicationDate);
  const dateValue = asString(publicationDate.dateTime) || asString(row.date) || asString(row.scheduledAt) || asString(row.publication_date);
  return Boolean(dateValue && dateValue.slice(0, 16) === targetLocalDateTime.slice(0, 16) && asString(row.text) === targetText);
}

async function metricoolToolCatalog(token: string) {
  const init = await mcpPost(token, { jsonrpc: '2.0', id: 41, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'como-asi-cleanup', version: '1' } } });
  await mcpPost(token, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.session);
  const list = await mcpPost(token, { jsonrpc: '2.0', id: 42, method: 'tools/list', params: {} }, init.session);
  return { session: init.session, tools: asArray(asBody(list.value.result).tools).map(asBody) };
}

async function metricoolNamedCall(token: string, session: string, name: string, args: Body, id: number) {
  const call = await mcpPost(token, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, session);
  if (asBody(call.value.result).isError) {
    const detail = asArray(asBody(call.value.result).content).map(item => asString(asBody(item).text)).filter(Boolean).join(' · ');
    throw new Error(detail || `metricool_tool_failed:${name}`);
  }
  return mcpValue(call.value);
}

function normalizedMetricoolToolName(tool: Body): string {
  return asString(tool.name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function deleteToolArgs(tool: Body, row: Body, brandId: string): Body | null {
  const properties = asBody(asBody(tool.inputSchema).properties);
  const keys = Object.keys(properties);
  const id = asString(row.id) || asString(row.uuid);
  const uuid = asString(row.uuid) || asString(row.id);
  if (!id && !uuid) return null;
  const args: Body = {};
  const sourceKeys = keys.length ? keys : ['blogId', 'id', 'uuid'];
  for (const key of sourceKeys) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const schema = asBody(properties[key]);
    const isArray = asString(schema.type) === 'array';
    let value: unknown;
    if (normalized.includes('blog') || normalized.includes('brand')) value = brandId;    else if (normalized.includes('uuid')) value = uuid;
    else if (normalized === 'id' || normalized.includes('postid') || normalized.includes('scheduleid')) value = id;
    if (value != null) args[key] = isArray ? [value] : value;
  }
  return Object.keys(args).length ? args : null;
}

async function neutralizeMetricoolDuplicates(token: string, brandId: string, rows: Body[], catalogInput?: { session: string; tools: Body[] }) {
  if (!rows.length) return { deleted: 0, drafted: 0 };
  const catalog = catalogInput || await metricoolToolCatalog(token);
  const candidates = catalog.tools.filter(tool => {
    const name = normalizedMetricoolToolName(tool);
    return /(delete|remove)/.test(name) && /post/.test(name);
  }).sort((a, b) => {
    const score = (tool: Body) => /scheduled|schedule/.test(normalizedMetricoolToolName(tool)) ? 10 : 0;
    return score(b) - score(a);
  });
  let deleteTool: Body | null = null;
  if (candidates.length) {
    for (const candidate of candidates) {
      const args = deleteToolArgs(candidate, rows[0], brandId);
      if (!args) continue;
      try {
        await metricoolNamedCall(token, catalog.session, asString(candidate.name), args, 50);
        deleteTool = candidate;
        break;
      } catch {
        deleteTool = null;
      }
    }
  }
  if (deleteTool) {
    let deleted = 1;
    for (let offset = 1; offset < rows.length; offset += 10) {
      const batch = rows.slice(offset, offset + 10);
      await Promise.all(batch.map((row, index) => {
        const args = deleteToolArgs(deleteTool as Body, row, brandId);
        if (!args) throw new Error('metricool_delete_arguments_unavailable');
        return metricoolNamedCall(token, catalog.session, asString((deleteTool as Body).name), args, 1000 + offset + index);
      }));
      deleted += batch.length;
    }
    return { deleted, drafted: 0 };
  }
  const updateTool = catalog.tools.find(tool => normalizedMetricoolToolName(tool).includes('updatescheduledpost'))
    || catalog.tools.find(tool => /update/.test(normalizedMetricoolToolName(tool)) && /post/.test(normalizedMetricoolToolName(tool)));
  if (!updateTool) throw new Error('metricool_duplicate_cleanup_tool_unavailable');
  let drafted = 0;
  for (let offset = 0; offset < rows.length; offset += 8) {
    const batch = rows.slice(offset, offset + 8);
    await Promise.all(batch.map((row, index) => {
      const id = asString(row.id);
      const uuid = asString(row.uuid);
      if (!id || !uuid) throw new Error('metricool_duplicate_missing_identifier');
      const info = { ...row, draft: true, autoPublish: false };
      return metricoolNamedCall(token, catalog.session, asString(updateTool.name), { id, uuid, blogId: brandId, info: JSON.stringify(info) }, 2000 + offset + index);
    }));
    drafted += batch.length;
  }
  return { deleted: 0, drafted };
}

function scheduledToolArgs(tool: Body, brandId: string, target: Date, timezone: string, limit: number): { args: Body; paginated: boolean } {
  const properties = asBody(asBody(tool.inputSchema).properties);
  const keys = Object.keys(properties);
  const args: Body = {};
  const lowerKey = (wanted: string[]) => keys.find(key => wanted.includes(key.toLowerCase().replace(/[^a-z0-9]/g, '')));
  const brandKey = lowerKey(['brandid', 'blogid']);
  const fromKey = lowerKey(['fromdate', 'startdate', 'datefrom', 'from']);
  const toKey = lowerKey(['todate', 'enddate', 'dateto', 'to']);
  const timezoneKey = lowerKey(['timezone', 'tz']);
  const extendedKey = lowerKey(['extendedrange']);
  const limitKey = lowerKey(['limit', 'maxresults', 'pagesize', 'perpage', 'size', 'take', 'count']);
  if (brandKey) args[brandKey] = brandId;
  if (fromKey) args[fromKey] = new Date(target.getTime() - 60000).toISOString();
  if (toKey) args[toKey] = new Date(target.getTime() + 60000).toISOString();
  if (timezoneKey) args[timezoneKey] = timezone;
  if (extendedKey) args[extendedKey] = false;
  if (limitKey) args[limitKey] = limit;
  const pageKey = lowerKey(['page', 'pagenumber']);
  const offsetKey = lowerKey(['offset', 'skip']);
  if (pageKey) args[pageKey] = 1;
  if (offsetKey) args[offsetKey] = 0;
  return { args, paginated: Boolean(limitKey) };
}

function metricoolUserId(value: unknown, brandId: string): string {
  let matched = '';
  const candidates = new Set<string>();
  const seen = new Set<object>();
  const visit = (node: unknown) => {
    if (typeof node === 'string') {
      const text = node.trim();
      if ((text.startsWith('{') || text.startsWith('[')) && text.length < 500000) {
        try { visit(JSON.parse(text)); } catch {}
      }
      return;
    }
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const row = node as Body;
    const scalarId = (input: unknown) => typeof input === 'number' ? String(input) : asString(input);
    const userId = scalarId(row.userId ?? row.user_id);
    const ownerUserId = scalarId(row.ownerUserId ?? row.owner_user_id);
    if (userId) candidates.add(userId);
    if (ownerUserId) candidates.add(ownerUserId);
    const id = scalarId(row.blogId ?? row.brandId ?? row.id);
    if (id === brandId && (userId || ownerUserId)) matched = userId || ownerUserId;
    Object.values(row).forEach(visit);
  };
  visit(value);
  return matched || [...candidates][0] || '';
}

function metricoolTokenUserId(token: string): string {
  const pieces = token.split('.');
  if (pieces.length !== 3) return '';
  try {
    const payload = JSON.parse(Buffer.from(pieces[1], 'base64url').toString('utf8')) as Body;
    const value = asString(payload.userId ?? payload.user_id ?? payload.uid ?? payload.sub);
    return /^\d+$/.test(value) ? value : '';
  } catch { return ''; }
}

function metricoolIdSummary(value: unknown): string {
  const found = new Set<string>();
  const seen = new Set<object>();
  const visit = (node: unknown, path = 'root') => {
    if (typeof node === 'string') {
      const text = node.trim();
      if ((text.startsWith('{') || text.startsWith('[')) && text.length < 500000) {
        try { visit(JSON.parse(text), `${path}.json`); } catch {}
      }
      return;
    }
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach((item, index) => visit(item, `${path}[${index}]`)); return; }
    for (const [key, item] of Object.entries(node as Body)) {
      const scalar = typeof item === 'number' || typeof item === 'string' ? String(item).trim() : '';
      if (/id/i.test(key) && /^\d+$/.test(scalar)) found.add(`${path}.${key}=${scalar}`);
      visit(item, `${path}.${key}`);
    }
  };
  visit(value);
  return [...found].slice(0, 30).join(',');
}

async function metricoolRestScheduledPosts(token: string, brandId: string, target: Date, timezone: string): Promise<Body[]> {
  const dedicatedUserIds: Record<string, string> = { '6756817': '5198733' };
  let userId = dedicatedUserIds[brandId] || metricoolTokenUserId(token);
  if (!userId) {
    const settings = await metricoolTool(token, 'getbrandsettings', {});
    userId = metricoolUserId(settings, brandId);
    if (!userId) throw new Error(`metricool_rest_user_id_unavailable:${metricoolIdSummary(settings) || 'no_numeric_ids'}`);
  }
  const from = new Date(target.getTime() - 12 * 60 * 60 * 1000).toISOString();
  const to = new Date(target.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const url = new URL('https://app.metricool.com/api/v2/scheduler/posts');
  url.searchParams.set('blogId', brandId);
  url.searchParams.set('userId', userId);
  url.searchParams.set('fromDate', from);
  url.searchParams.set('toDate', to);
  url.searchParams.set('start', from);
  url.searchParams.set('end', to);
  url.searchParams.set('timezone', timezone);
  url.searchParams.set('extendedRange', 'false');
  const attempts: Array<Record<string, string>> = [
    { authorization: `Bearer ${token}`, accept: 'application/json' },
    { 'X-Mc-Auth': token, accept: 'application/json' },
  ];
  const statuses: number[] = [];
  for (const headers of attempts) {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    statuses.push(response.status);
    const text = await response.text();
    if (!response.ok) continue;
    let data: unknown;
    try { data = text ? JSON.parse(text) : []; } catch { throw new Error('metricool_rest_scheduler_invalid_json'); }
    return scheduledPostRows(data);
  }
  throw new Error(`metricool_rest_scheduler_auth_failed:${statuses.join(',')}`);
}

async function deleteMetricoolRestDuplicates(token: string, brandId: string, rows: Body[]): Promise<number> {
  if (!rows.length) return 0;
  const settings = await metricoolTool(token, 'getbrandsettings', {});
  const userId = metricoolUserId(settings, brandId) || metricoolTokenUserId(token);
  if (!userId) throw new Error('metricool_rest_delete_user_id_unavailable');
  const authAttempts = [
    (value: string) => ({ authorization: `Bearer ${value}`, accept: 'application/json' }),
    (value: string) => ({ 'X-Mc-Auth': value, accept: 'application/json' }),
  ];
  let deleted = 0;
  for (let offset = 0; offset < rows.length; offset += 8) {
    const batch = rows.slice(offset, offset + 8);
    await Promise.all(batch.map(async row => {
      const id = typeof row.id === 'number' ? String(row.id) : asString(row.id);
      if (!id) throw new Error('metricool_rest_delete_missing_id');      const url = new URL(`https://app.metricool.com/api/v2/scheduler/posts/${encodeURIComponent(id)}`);
      url.searchParams.set('blogId', brandId);
      url.searchParams.set('userId', userId);
      const statuses: number[] = [];
      for (const auth of authAttempts) {
        const response = await fetch(url, { method: 'DELETE', headers: auth(token), signal: AbortSignal.timeout(30000) });
        statuses.push(response.status);
        if (response.ok || response.status === 404) return;
      }
      throw new Error(`metricool_rest_delete_failed:${id}:${statuses.join(',')}`);
    }));
    deleted += batch.length;
  }
  return deleted;
}

function metricoolDuplicateGroupKey(row: Body): string {
  const publicationDate = asBody(row.publicationDate);
  const dateValue = asString(publicationDate.dateTime) || asString(row.date) || asString(row.scheduledAt) || asString(row.publication_date);
  const providers = asArray(row.providers).map(item => asString(asBody(item).network ?? asBody(item).provider ?? item).toLowerCase()).filter(Boolean).sort();
  const media = asArray(row.media).map(item => typeof item === 'string' ? item : asString(asBody(item).url)).filter(Boolean).sort();
  return JSON.stringify([dateValue.slice(0, 16), asString(row.text), providers, media]);
}

async function cleanupMetricoolRestWindow(token: string, brandId: string, target: Date, timezone: string) {
  const rows = await metricoolRestScheduledPosts(token, brandId, target, timezone);
  const groups = new Map<string, Body[]>();
  for (const row of rows) {
    const key = metricoolDuplicateGroupKey(row);
    if (!key) continue;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  const extras: Body[] = [];
  for (const group of groups.values()) {
    if (group.length > 1) extras.push(...group.slice(1));
  }
  const deleted = await deleteMetricoolRestDuplicates(token, brandId, extras);
  return { inspected: rows.length, duplicates: extras.length, deleted, drafted: 0, mode: 'rest-window' };
}

async function cleanupPendingAutopilotDuplicates(token: string, brandId: string, timezone: string, networks: string[]) {
  const statusResult = await workerRequest('/api/automation/status');
  if (!statusResult.ok) throw new Error('automation_status_unavailable_for_cleanup');
  const status = asBody(statusResult.data);
  const plan = asBody(status.todayPlan);
  const slots = asArray(plan.slots).map(asBody);
  const firstTarget = slots.map(slot => asString(slot.publishAt)).find(Boolean);
  if (brandId === '6756817' && firstTarget) {
    const target = new Date(firstTarget);
    if (Number.isFinite(target.getTime())) return cleanupMetricoolRestWindow(token, brandId, target, timezone);
  }
  const catalog = await metricoolToolCatalog(token);
  const scheduledTool = catalog.tools.find(tool => normalizedMetricoolToolName(tool) === 'getscheduledposts')
    || catalog.tools.find(tool => normalizedMetricoolToolName(tool).includes('scheduledposts'));
  if (!scheduledTool) throw new Error(`metricool_scheduled_tool_unavailable:${catalog.tools.map(tool => asString(tool.name)).filter(name => /post|schedul/i.test(name)).slice(0, 30).join(',')}`);
  scheduledTool.__catalogTools = catalog.tools;
  let inspected = 0;
  let duplicates = 0;
  let deleted = 0;
  let drafted = 0;
  for (const slot of slots) {
    if (asString(slot.status) === 'missed') continue;
    const jobId = asString(slot.jobId);
    const publishAt = asString(slot.publishAt);
    if (!jobId || !publishAt) continue;
    const jobResult = await workerRequest(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (!jobResult.ok) continue;
    const job = asBody(jobResult.data);
    const reelId = asString(job.reel_id);
    if (!reelId || asString(job.reel_status) !== 'ready') continue;
    const reelResult = await workerRequest(`/api/reels/${encodeURIComponent(reelId)}`);
    if (!reelResult.ok) continue;
    const reel = asBody(reelResult.data);
    const text = publicationText(reel.publishing_kit, networks);
    if (!text) continue;
    const target = new Date(publishAt);
    if (!Number.isFinite(target.getTime())) continue;
    inspected += 1;
    const localDateTime = metricoolLocalDateTime(target.toISOString(), timezone);
    const firstRequest = scheduledToolArgs(scheduledTool, brandId, target, timezone, 25);
    if (!firstRequest.paginated) {
      const rows = await metricoolRestScheduledPosts(token, brandId, target, timezone);
      const matches = rows.filter(row => asString(row.text) === text).sort((left, right) => {
        const leftDate = asString(asBody(left.publicationDate).dateTime) || asString(left.date) || asString(left.scheduledAt);
        const rightDate = asString(asBody(right.publicationDate).dateTime) || asString(right.date) || asString(right.scheduledAt);
        return new Date(leftDate).getTime() - new Date(rightDate).getTime();
      });
      if (matches.length > 1) {
        const extras = matches.slice(1);
        duplicates += extras.length;
        deleted += await deleteMetricoolRestDuplicates(token, brandId, extras);
      }
      continue;
    }
    for (let round = 0; round < 20; round += 1) {
      const request = scheduledToolArgs(scheduledTool, brandId, target, timezone, 25);
      const scheduled = await metricoolNamedCall(token, catalog.session, asString(scheduledTool.name), request.args, 3000 + round);
      const matches = scheduledPostRows(scheduled).filter(row => exactScheduledDuplicate(row, localDateTime, text));
      if (matches.length <= 1) break;
      const extras = matches.slice(1);
      duplicates += extras.length;
      const result = await neutralizeMetricoolDuplicates(token, brandId, extras, catalog);
      deleted += result.deleted;
      drafted += result.drafted;
    }
  }
  return { inspected, duplicates, deleted, drafted };
}
function normalizeBrands(value: unknown) {
  type BrandCandidate = { id: string; label: string; timezone: string; networks: string[] };
  const found: BrandCandidate[] = []; const visited = new Set<object>(); const scalar = (item: unknown) => typeof item === 'string' ? item.trim() : typeof item === 'number' ? String(item) : '';
  const knownNetworks = new Set(['instagram', 'facebook', 'tiktok', 'youtube', 'twitter', 'x', 'linkedin', 'pinterest', 'threads', 'bluesky', 'twitch']);
  const visit: (node: unknown, path?: string, depth?: number) => void = (node, path = 'root', depth = 0) => {
    if (depth > 9 || node == null) return;
    if (typeof node === 'string') { const text = node.trim(); if ((text.startsWith('{') || text.startsWith('[')) && text.length < 200000) { try { visit(JSON.parse(text), path + '.json', depth + 1); } catch {} } return; }
    if (typeof node !== 'object') return;
    if (visited.has(node)) return; visited.add(node);
    if (Array.isArray(node)) { node.forEach((item, index) => visit(item, path + '[' + index + ']', depth + 1)); return; }
    const row = node as Body; const tail = path.split('.').at(-1) || ''; const explicitId = scalar(row.blogId ?? row.brandId ?? row.blog_id ?? row.brand_id); const simpleId = scalar(row.id); const label = scalar(row.label ?? row.name ?? row.brandName ?? row.blogName ?? row.brand_name ?? row.blog_name ?? row.title); const timezone = scalar(row.timezone ?? row.timeZone ?? row.time_zone ?? row.tz) || 'UTC'; const mappedId = /^\d+$/.test(tail) ? tail : ''; const pathLooksLikeBrand = /brand|blog/i.test(path); const networkData = asBody(row.networksData ?? row.networks_data ?? row.connections ?? row.connectedAccounts); const hasNetworkData = Object.keys(networkData).length > 0; const id = explicitId || ((pathLooksLikeBrand || Boolean(label) || hasNetworkData) ? simpleId : '') || mappedId;
    if (id && (explicitId || pathLooksLikeBrand || Boolean(label) || hasNetworkData)) {
      const networks = new Set<string>(); const addNetwork = (item: unknown) => { const direct = scalar(item).toLowerCase(); if (knownNetworks.has(direct)) networks.add(direct); const object = asBody(item); const nested = scalar(object.network ?? object.provider ?? object.name ?? object.type).toLowerCase(); if (knownNetworks.has(nested)) networks.add(nested); };
      [row.networks, row.providers, row.socialNetworks, row.connectedNetworks].forEach(group => asArray(group).forEach(addNetwork));
      const scanNetworkFields = (source: Body) => Object.entries(source).forEach(([key, item]) => { const normalized = key.replace(/Data$/i, '').replace(/_data$/i, '').toLowerCase(); if (knownNetworks.has(normalized) && item != null && item !== false && scalar(item) !== '') networks.add(normalized); });
      scanNetworkFields(row); scanNetworkFields(networkData);
      found.push({ id, label: label || 'Marca ' + id, timezone, networks: [...networks] });
    }
    Object.entries(row).forEach(([key, item]) => visit(item, path + '.' + key, depth + 1));
  };
  visit(value);
  return [...new Map(found.map(brand => [brand.id, brand])).values()];
}
type TrendSignal = {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  provider: 'GDELT' | 'Google News' | 'Entertainment RSS';
};

function parseTrendSignals(value: unknown): TrendSignal[] {
  return asArray(value).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const title = asString(row.title);
    const url = asString(row.url);
    const source = asString(row.source, 'Fuente web');
    const publishedAt = asString(row.publishedAt);
    const providerValue = asString(row.provider);
    const validProviders: TrendSignal['provider'][] = ['GDELT', 'Google News', 'Entertainment RSS'];
    if (!title || !url || !validProviders.includes(providerValue as TrendSignal['provider'])) return [];
    const provider = providerValue as TrendSignal['provider'];
    return [{ title, url, source, publishedAt, provider }];
  });
}

function mergeTrendSignals(...groups: TrendSignal[][]): TrendSignal[] {
  const seen = new Set<string>();
  const merged: TrendSignal[] = [];
  for (const signal of groups.flat()) {
    const key = `${signal.url}|${signal.title.toLowerCase().replace(/[^a-z0-9áéíóúñü]+/gi, ' ').trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(signal);
  }
  return merged.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
}

const categoryQueries: Record<string, string[]> = {
  chisme_polemica: ['pelea pública famosos escándalo', 'celebrity feud public scandal', 'famosos traición polémica confirmada', 'celebrity public controversy feud'],
  famosos: ['famosos romance ruptura confirmada', 'celebrity relationship breakup confirmed', 'pareja famosa drama público', 'celebrity couple public drama'],
  bizarro_wtf: ['famoso papelón momento absurdo', 'celebrity bizarre public moment', 'famoso campaña polémica marketing', 'celebrity embarrassing public stunt'],
  cultura_pop_actualidad: ['famoso ego regreso polémica', 'celebrity comeback public feud', 'premios cultura pop escándalo famosos', 'celebrity awards public controversy'],
  viral_internet: ['influencer masivo cancelación pública', 'globally famous creator public controversy', 'celebrity viral public scandal'],
  humor_negro: ['celebrity downfall public irony', 'famoso contradicción pública absurda', 'celebrity ego scandal'],
};

const sourceHeaders = {
  'user-agent': 'Mozilla/5.0 (compatible; ComoAsiRadar/1.0; +https://como-asi-studio-jjokns.v2.appdeploy.ai/)',
  accept: 'application/json, application/rss+xml, application/xml, text/xml, text/plain;q=0.8, */*;q=0.5',
};

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function parseGdeltDate(value: string): string {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return '';
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
}
async function fetchGdelt(query: string): Promise<TrendSignal[]> {
  const languages = ['spanish', 'english'];
  const batches = await Promise.allSettled(languages.map(async language => {
    const q = `${query} sourcelang:${language}`;
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=ArtList&maxrecords=15&format=json&sort=DateDesc`;
    const response = await fetch(url, { headers: sourceHeaders, signal: AbortSignal.timeout(9000) });
    if (!response.ok) return [] as TrendSignal[];
    const payload = await response.json() as { articles?: unknown[] };
    return (Array.isArray(payload.articles) ? payload.articles : []).flatMap(article => {
      if (!article || typeof article !== 'object') return [];
      const row = article as Record<string, unknown>;
      const title = asString(row.title);
      const articleUrl = asString(row.url);
      if (!title || !articleUrl) return [];
      return [{
        title,
        url: articleUrl,
        source: asString(row.domain, 'Fuente web'),
        publishedAt: parseGdeltDate(asString(row.seendate)),
        provider: 'GDELT' as const,
      }];
    });
  }));
  return batches.flatMap(batch => batch.status === 'fulfilled' ? batch.value : []);
}

function rssTag(item: string, tag: string): string {
  const match = item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

async function fetchGoogleNews(query: string): Promise<TrendSignal[]> {
  const locales = [
    { hl: 'es-419', gl: 'AR', ceid: 'AR:es-419' },
    { hl: 'en-US', gl: 'US', ceid: 'US:en' },
  ];
  const batches = await Promise.allSettled(locales.map(async locale => {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:2d`)}&hl=${locale.hl}&gl=${locale.gl}&ceid=${locale.ceid}`;
    const response = await fetch(url, { headers: sourceHeaders, signal: AbortSignal.timeout(9000) });
    if (!response.ok) return [] as TrendSignal[];
    const xml = await response.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
    return items.slice(0, 15).flatMap(item => {
      const title = rssTag(item, 'title');
      const articleUrl = rssTag(item, 'link');
      const published = rssTag(item, 'pubDate');
      const source = rssTag(item, 'source') || title.split(' - ').at(-1) || 'Google News';
      if (!title || !articleUrl) return [];
      const parsedDate = new Date(published);
      return [{
        title,
        url: articleUrl,
        source,
        publishedAt: Number.isNaN(parsedDate.getTime()) ? '' : parsedDate.toISOString(),
        provider: 'Google News' as const,
      }];
    });
  }));
  return batches.flatMap(batch => batch.status === 'fulfilled' ? batch.value : []);
}

const entertainmentFeeds = [
  { source: 'Paparazzi', url: 'https://www.paparazzi.com.ar/feed/' },
  { source: 'Infobae Teleshow', url: 'https://www.infobae.com/arc/outboundfeeds/rss/category/teleshow/?outputType=xml' },
  { source: 'Variety', url: 'https://variety.com/feed/' },
  { source: 'Deadline', url: 'https://deadline.com/feed/' },
  { source: 'TMZ', url: 'https://www.tmz.com/rss.xml' },
];

const entertainmentDomains = [
  // Argentina
  'paparazzi.com.ar',
  'ciudad.com.ar',
  'pronto.com.ar',
  'caras.perfil.com',
  'clarin.com/fama',
  'lanacion.com.ar/espectaculos',
  'infobae.com/teleshow',
  // Colombia
  'revistavea.com.co',
  'caracoltv.com/famosos',
  'canalrcn.com/super-like',
  'pulzo.com/entretenimiento',
  // México
  'tvynovelas.com',
  'quien.com',
  'lasestrellas.tv/famosos',
  'milenio.com/espectaculos/famosos',
  // Chile, Perú y otros mercados latinoamericanos
  'lacuarta.com/espectaculos',
  'pagina7.cl',
  'meganoticias.cl/tendencias',
  'trome.com/espectaculos',
  'elcomercio.pe/tvmas',
  'americatv.com.pe/espectaculos',
  'metroecuador.com.ec/entretenimiento',
  'elnuevodia.com/entretenimiento/farandula',
  // Cobertura panlatina e internacional de celebridades
  'peopleenespanol.com',
  'hola.com',
  'univision.com/famosos',
  'telemundo.com/entretenimiento',
  'eonline.com',
  'billboard.com',
  'variety.com',
  'deadline.com',
  'tmz.com',
];

async function fetchEntertainmentFeed(feed: { source: string; url: string }): Promise<TrendSignal[]> {
  try {
    const response = await fetch(feed.url, { headers: sourceHeaders, signal: AbortSignal.timeout(9000) });
    if (!response.ok) return [];
    const xml = await response.text();
    const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
    return items.slice(0, 18).flatMap(item => {
      const title = rssTag(item, 'title');
      const articleUrl = rssTag(item, 'link') || rssTag(item, 'guid');
      const published = rssTag(item, 'pubDate') || rssTag(item, 'published') || rssTag(item, 'updated');
      if (!title || !articleUrl) return [];
      const parsedDate = new Date(published);
      return [{
        title,
        url: articleUrl,
        source: feed.source,
        publishedAt: Number.isNaN(parsedDate.getTime()) ? '' : parsedDate.toISOString(),
        provider: 'Entertainment RSS' as const,
      }];
    });
  } catch {
    return [];
  }
}

async function fetchEntertainmentFeeds(market = 'random'): Promise<TrendSignal[]> {
  const selectedFeeds = market === 'argentina' ? entertainmentFeeds.filter(feed => ['Paparazzi', 'Infobae Teleshow'].includes(feed.source)) : entertainmentFeeds;
  const batches = await Promise.allSettled(selectedFeeds.map(fetchEntertainmentFeed));
  return batches.flatMap(batch => batch.status === 'fulfilled' ? batch.value : []);
}

async function fetchCurrentSignals(category: string, topic = '', market = 'random'): Promise<TrendSignal[]> {
  const compactTopic = topic.split(/\s+/).filter(word => word.length > 2).slice(0, 7).join(' ');
  const argentinaFocused = market === 'argentina';
  const specificQueries = topic
    ? [compactTopic || topic, `${compactTopic || topic} escándalo famosos`]
    : argentinaFocused
      ? (categoryQueries[category] || categoryQueries.chisme_polemica).map(query => `${query} Argentina famosos argentinos`)
      : (categoryQueries[category] || categoryQueries.chisme_polemica);
  const priorityQueries: string[] = [];
  const priorityDomains = argentinaFocused ? entertainmentDomains.slice(0, 7) : entertainmentDomains;
  for (let index = 0; index < priorityDomains.length; index += 3) {
    const sites = priorityDomains.slice(index, index + 3).map(domain => `site:${domain}`).join(' OR ');
    priorityQueries.push(topic
      ? `(${sites}) ${compactTopic || topic}`
      : `(${sites}) ${argentinaFocused ? 'famosos argentinos farándula argentina polémica romance' : 'famosos escándalo romance pelea'}`);
  }
  const collect = async (queries: string[]) => {
    const batches = await Promise.allSettled(queries.flatMap(query => [fetchGdelt(query), fetchGoogleNews(query)]));
    return batches.flatMap(batch => batch.status === 'fulfilled' ? batch.value : []);
  };
  const collectPriority = async (queries: string[]) => {
    const batches = await Promise.allSettled(queries.map(fetchGoogleNews));
    return batches.flatMap(batch => batch.status === 'fulfilled' ? batch.value : []);
  };
  const normalize = (signals: TrendSignal[], maxAgeDays: number) => {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const seen = new Set<string>();
    return signals
      .filter(signal => {
        const normalized = signal.title.toLowerCase().replace(/[^a-z0-9áéíóúñü]+/gi, ' ').trim();
        if (!normalized || seen.has(normalized)) return false;
        const date = signal.publishedAt ? new Date(signal.publishedAt).getTime() : Date.now();
        if (!Number.isNaN(date) && date < cutoff) return false;
        seen.add(normalized);
        return true;
      })
      .sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''))
      .slice(0, 40);
  };

  const [generalSignals, prioritySignals, directFeedSignals] = await Promise.all([
    collect(specificQueries),
    collectPriority(priorityQueries),
    fetchEntertainmentFeeds(argentinaFocused ? 'argentina' : 'random'),
  ]);
  let normalized = normalize([...directFeedSignals, ...prioritySignals, ...generalSignals], 5);
  if (!topic && normalized.length < 8) {
    const fallbackSignals = await collect(argentinaFocused
      ? ['famosos argentinos actualidad', 'farandula argentina famosos', 'television argentina celebridades', 'musica argentina famosos']
      : ['celebrity gossip', 'famosos chisme', 'celebrity scandal', 'famosos pareja']);
    normalized = normalize([...normalized, ...fallbackSignals], 7);
  }
  return normalized;
}

async function scrapeTrendSources(signals: TrendSignal[]): Promise<Array<TrendSignal & { text: string }>> {
  const selected = signals.slice(0, 6);
  const scraped = await Promise.allSettled(selected.map(async signal => {
    const page = await ai.scrape({ url: signal.url });    return { ...signal, text: page.status < 400 ? page.text.slice(0, 4500) : '' };
  }));
  return scraped.flatMap(item => item.status === 'fulfilled' ? [item.value] : []);
}

const editorialSystem = `Eres el motor editorial exclusivo de ¿Cómo Así?, un show vertical de sátira y humor negro sobre celebridades reconocibles. Trabaja únicamente con las fuentes recientes, la memoria y los recursos suministrados por este proyecto.

IDENTIDAD EDITORIAL: el presentador es MALA FAMA, un diablo animado masculino, elegante y cruel con el ego del poderoso. No es una amiga contando un chisme, no conversa con la celebridad y no habla como panelista de farándula. Dicta el caso como maestro de ceremonias del inframundo: seguro, teatral, oscuro, preciso y con una sonrisa de verdugo. Convierte un conflicto público real en una ejecución cómica con premisa, escalada, giro, callback y sentencia final. Cero documental, noticiero, conversación entre amigos o artículo leído.

ESPAÑOL LATINO NEUTRO: usa vocabulario comprensible en toda Latinoamérica y conjugación neutral. Prohibidos el voseo y los regionalismos argentinos, colombianos, mexicanos, españoles, chilenos o de cualquier país. No uses “quilombo”, “che”, “boludo”, “pibe”, “mina”, “parce”, “vaina”, “güey”, “coño”, “cachai”, “acá”, “sos”, “tenés”, “podés”, “mirá” ni equivalentes regionales. El picante debe venir de la precisión: “qué mierda”, “carajo”, “qué desastre”, “circo”, “caradura”, “se pasó de listo”.

NICHO: solo microdramas públicos de celebridades que la audiencia latinoamericana reconozca por nombre y rostro: peleas y escándalos; romances y rupturas; papelones y momentos WTF; ego, lujo e hipocresía de cultura pop. Nada de política, economía, noticias duras, tragedias, delitos, menores o víctimas vulnerables. Si hay que explicar quién es el protagonista, se descarta.

HUMOR NEGRO: el hecho real es la premisa y el ego es el blanco. Incluye remates específicos nacidos de la contradicción comprobada; nunca chistes intercambiables. Puede ser despiadado con la pose, el privilegio, el oportunismo, la mentira pública y las decisiones absurdas. Nunca ataques raza, nacionalidad, orientación sexual, discapacidad, cuerpo, religión ni víctimas. No inventes delitos, citas, relaciones, intimidad ni intenciones.

RITMO: abre con nombre + conflicto + consecuencia en 1-2 segundos. Alterna dato verificable y remate; no encadenes dos bloques explicativos. Cada 7-10 segundos debe aparecer una revelación, inversión de estatus o golpe cómico. Mala Fama no usa muletillas de amiga como “mi amor”, “escúchame”, “te cuento”, “amiga”, “reina” o “bebé”. Tampoco dice “sí, leíste bien”. Habla con frases cortas, pausas de amenaza, falsa solemnidad y sentencias citables. El cierre paga el gancho y termina con punto final.

RIGOR: Paparazzi y otros medios de espectáculo sirven para detectar conversaciones, no para convertir rumores en hechos. Conserva atribución cuando una afirmación provenga de una sola fuente. Para afirmaciones sensibles exige corroboración independiente o decláralas como versión/rumor. Usa solo las señales y fuentes recientes proporcionadas por el sistema; no fabriques información para mejorar un chiste.`

export const handler = router({
  'GET /api/_healthcheck': [async () => json({ message: 'Success', project: 'como-asi' })],
  'POST /api/engine/ping': [async () => json({ ok: true, project: 'como-asi', engine: 'studio', fallback: false })],

  'GET /api/isolation-status': [async () => json({
    projectKey: 'como-asi',
    isolated: true,
    databaseProvider: 'Neon',
    databaseProject: 'como-asi',
    databaseConnected: true,
    railwayProject: 'como-asi-production',
    railwayConnected: true,
    githubRepo: 'Melosebastian3/comoasi-reel-worker',
    githubConnected: true,
    storageProvider: 'AppDeploy Storage',
    storageConnected: true,
    generatorConnected: true,
  })],

  'GET /api/worker/health': [async () => {
    const result = await workerRequest('/health');
    if (!result.ok) return json({ online: false, project: 'como-asi', fallback: false });
    return json({ online: true, project: 'como-asi', fallback: false, worker: result.data });
  }],

  'GET /api/radar/live': [async ({ query }) => {
    const category = asString(query.category, 'viral_internet');
    const signals = await fetchCurrentSignals(category);
    return json({
      ok: signals.length > 0,
      category,
      capturedAt: new Date().toISOString(),
      providers: ['Paparazzi', 'Entertainment RSS', 'Google News', 'GDELT'],
      signals: signals.slice(0, 12),
    });
  }],

  'POST /api/generate': [async ({ body }) => workerResponse(await workerRequest('/api/generate', 'POST', asBody(body)))],
  'GET /api/jobs/:id': [async ({ params }) => workerResponse(await workerRequest(`/api/jobs/${encodeURIComponent(params.id)}`))],
  'POST /api/jobs/:id/retry': [async ({ params }) => workerResponse(await workerRequest(`/api/jobs/${encodeURIComponent(params.id)}/retry`, 'POST', {}))],
  'GET /api/library': [async () => {
    const [result, queueResult] = await Promise.all([
      workerRequest('/api/reels?limit=100'),
      workerRequest('/api/publisher/queue'),
    ]);
    if (!result.ok) return workerResponse(result);
    const reels = Array.isArray(result.data) ? result.data : [];
    const queue = queueResult.ok ? queueResult.data : [];
    return json(reels.map(value => {
      const reel = asBody(value);
      const id = asString(reel.id);
      return {
        id,
        category: asString(reel.category),
        topic: asString(reel.topic),
        title: asString(reel.title),
        status: asString(reel.status),
        viral_score: reel.viral_score ?? null,
        video_object_key: asString(reel.video_object_key) || null,
        publishing_kit: reel.publishing_kit && typeof reel.publishing_kit === 'object' ? reel.publishing_kit : null,
        created_at: asString(reel.created_at),
        publication: publicationSnapshot(queue, id),
      };
    }));
  }],
  'GET /api/radar/latest': [async () => workerResponse(await workerRequest('/api/radar/latest'))],
  'GET /api/learning': [async () => workerResponse(await workerRequest('/api/learning'))],
  'GET /api/publisher/queue': [async () => workerResponse(await workerRequest('/api/publisher/queue'))],
  'POST /api/publisher/queue': [async ({ body }) => workerResponse(await workerRequest('/api/publisher/queue', 'POST', asBody(body)))],
  'POST /api/publisher/publish-now': [async ({ body }) => {
    const result = await workerRequest('/api/publisher/publish-now', 'POST', asBody(body));
    return result.ok ? json(result.data) : json(result.data, result.status || 502);
  }],
  'GET /api/social/status': [async () => workerResponse(await workerRequest('/api/social/status'))],
  'GET /api/metricool/contingency/status': [async () => workerResponse(await workerRequest('/api/metricool/contingency/status'))],
  'POST /api/social/connect': [async ({ body }) => workerResponse(await workerRequest('/api/social/connect', 'POST', asBody(body)))],
  'POST /api/social/callback': [async ({ body }) => workerResponse(await workerRequest('/api/social/callback', 'POST', asBody(body)))],
  'POST /api/social/disconnect': [async ({ body }) => workerResponse(await workerRequest('/api/social/disconnect', 'POST', asBody(body)))],
  'GET /api/automation/status': [async () => {
    const [statusResult, queueResult] = await Promise.all([
      workerRequest('/api/automation/status'),
      workerRequest('/api/publisher/queue'),
    ]);
    if (!statusResult.ok) return workerResponse(statusResult);
    const status = asBody(statusResult.data);
    const todayPlan = asBody(status.todayPlan);
    if (!Object.keys(todayPlan).length) return json(status);
    const queue = queueResult.ok ? queueResult.data : [];
    const slots = asArray(todayPlan.slots).map(value => {
      const slot = asBody(value);
      const reelId = asString(slot.reelId);
      if (!reelId) return slot;
      const publication = publicationSnapshot(queue, reelId);
      return {
        ...slot,
        status: publication.hasRecords ? publication.status : asString(slot.status, 'planned'),
        publication,
      };
    });
    return json({ ...status, todayPlan: { ...todayPlan, slots } });
  }],
  'POST /api/automation/enabled': [async ({ body }) => workerResponse(await workerRequest('/api/automation/enabled', 'POST', asBody(body)))],
  'POST /api/metricool/oauth/cleanup': [async ({ body }) => {
    const b = asBody(body);
    const accessToken = asString(b.accessToken);
    const brandId = asString(b.brandId);
    const timezone = asString(b.timezone, 'America/Argentina/Buenos_Aires');
    const networks = asArray(b.networks).map(value => asString(value).toLowerCase()).filter(Boolean);
    if (!accessToken || !brandId) return error('metricool_cleanup_parameters_required', 400);
    try {
      const cleanup = await cleanupPendingAutopilotDuplicates(accessToken, brandId, timezone, networks.length ? networks : ['instagram', 'tiktok', 'youtube']);
      return json({ ok: true, cleanup });
    } catch (cleanupError) {
      const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.error('[como-asi] Metricool cleanup endpoint failed', detail);
      return json({ error: 'metricool_duplicate_cleanup_failed', detail }, 409);
    }
  }],
  'POST /api/metricool/oauth/automation': [async ({ body }) => {
    const b = asBody(body);
    const accessToken = asString(b.accessToken);
    const refreshToken = asString(b.refreshToken);
    const expiresIn = Math.max(60, Number(b.expiresIn || 3600));
    const brandId = asString(b.brandId);
    const timezone = asString(b.timezone, 'America/Argentina/Buenos_Aires');
    const networks = asArray(b.networks).map(value => asString(value).toLowerCase()).filter(Boolean);
    if (!accessToken || !brandId) return error('metricool_primary_parameters_required', 400);
    try {
      const brands = normalizeBrands(await metricoolTool(accessToken, 'getbrandsettings', {}));
      const selected = brands.find(item => asString(item.id) === brandId);
      if (!selected) return json({ error: 'metricool_brand_not_available', brandId, availableBrands: brands.map(item => ({ id: item.id, label: item.label })) }, 409);
      await metricoolTool(accessToken, 'getscheduledposts', {
        brandId,
        fromDate: new Date(Date.now() - 3600000).toISOString(),
        toDate: new Date(Date.now() + 3600000).toISOString(),
        timezone: asString(selected.timezone, timezone),
        extendedRange: false,
      });
      const persisted = await workerRequest('/api/metricool/connect', 'POST', { accessToken, refreshToken, expiresIn });
      if (!persisted.ok) return json({ error: 'metricool_persistence_failed' }, 503);
      const activated = await workerRequest('/api/metricool/brand', 'POST', {
        brandId,
        brandLabel: asString(b.brandLabel) || asString(selected.label),
        timezone: asString(selected.timezone, timezone),
        networks: networks.length ? networks : ['instagram', 'tiktok', 'youtube'],
      });
      if (!activated.ok) return workerResponse(activated);
      return json({ ...asBody(activated.data), primary: true, providerOrder: ['metricool', 'buffer', 'upload-post'] });
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      console.error('[como-asi] Metricool selected brand validation failed', detail);
      return json({ error: 'metricool_brand_validation_failed', detail }, 409);
    }
  }],


  'POST /api/metricool/oauth/token': [async ({ body }) => {
    const b = asBody(body); const code = asString(b.code); const verifier = asString(b.verifier); const redirectUri = asString(b.redirectUri);
    if (!code || !verifier || !redirectUri) return error('oauth_parameters_required', 400);
    const response = await fetch('https://app.metricool.com/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: metricoolClientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: metricoolMcpUrl }), signal: AbortSignal.timeout(20000) });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    const accessToken = asString(data.access_token);
    const expiresIn = Number(data.expires_in || 3600);
    if (!response.ok || !accessToken) return json({ error: 'metricool_oauth_failed' }, 502);
    return json({ accessToken, refreshToken: asString(data.refresh_token), expiresIn, pendingBrandSelection: true });
  }],
  'POST /api/metricool/oauth/brands': [async ({ body }) => {
    const token = asString(asBody(body).accessToken); if (!token) return error('metricool_access_required', 401);
    try { return json({ brands: normalizeBrands(await metricoolTool(token, 'getbrandsettings', {})) }); } catch (reason) { console.error('[como-asi] Metricool brands failed', reason instanceof Error ? reason.message : reason); return json({ error: 'metricool_connection_failed' }, 502); }
  }],
  'GET /api/buffer/status': [async () => {
    const wanted = ['instagram', 'tiktok', 'youtube'];
    try {
      await bufferApiKey();
      const queueResult = await workerRequest('/api/publisher/queue');
      if (!queueResult.ok) return json({ configured: true, ready: false, channels: [], missingNetworks: wanted, recentPosts: [], error: 'No pude leer el estado persistente del publisher.' }, 503);

      const ledgerRows = asArray(queueResult.data)
        .map(asBody)
        .filter(row => asString(row.account_key) === 'buffer' && asString(row.external_post_id))
        .sort((a, b) => new Date(asString(b.updated_at)).getTime() - new Date(asString(a.updated_at)).getTime());
      const channels: BufferChannel[] = [];
      for (const network of wanted) {
        const row = ledgerRows.find(item => asString(item.platform) === network && asString(asBody(item.publish_payload).channelId));
        if (!row) continue;
        const payload = asBody(row.publish_payload);
        channels.push({ id: asString(payload.channelId), name: network, service: network, organizationId: 'buffer', organizationName: 'Buffer' });
      }

      let missingNetworks = wanted.filter(network => !channels.some(channel => channel.service === network));
      let rateLimited = false;
      if (missingNetworks.length) {
        try {
          const live = await bufferChannels();
          for (const channel of live.channels.filter(channel => wanted.includes(channel.service))) {
            if (!channels.some(existing => existing.service === channel.service)) channels.push(channel);
          }
          missingNetworks = wanted.filter(network => !channels.some(channel => channel.service === network));
        } catch (reason) {
          const detail = reason instanceof Error ? reason.message : String(reason);
          rateLimited = detail.includes('429') || detail.includes('Too many requests');
          if (!rateLimited) console.warn('[como-asi] Buffer live channel verification unavailable', detail);
        }
      }

      const recentPosts: Body[] = ledgerRows.slice(0, 20).map(row => {
        const payload = asBody(row.publish_payload);
        const dbStatus = asString(row.status);
        const status = asString(payload.deliveryStatus) || (dbStatus === 'published' ? 'sent' : dbStatus === 'publishing' ? 'sending' : dbStatus === 'failed' ? 'error' : 'scheduled');
        return {
          id: asString(row.external_post_id),
          status,
          dueAt: asString(row.scheduled_at),
          channelId: asString(payload.channelId),
          channelService: asString(row.platform),
          sentAt: asString(row.published_at),
          externalLink: asString(payload.externalLink),
          error: status === 'error' && asString(row.error) ? { message: asString(row.error) } : null,
        };
      });

      return json({ configured: true, ready: missingNetworks.length === 0, channels: channels.map(channel => ({ id: channel.id, name: channel.name, service: channel.service, organizationName: channel.organizationName })), missingNetworks, recentPosts, source: 'ledger', rateLimited });
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      console.error('[como-asi] Buffer status failed', detail);
      return json({ configured: false, ready: false, channels: [], missingNetworks: wanted, recentPosts: [], error: detail }, 503);
    }
  }],
  'GET /api/buffer/diagnostics': [async ({ query }) => {
    try {
      const context = await bufferChannels();
      const start = asString(query.start) || new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      const end = asString(query.end) || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const posts: Body[] = [];
      for (const organization of context.organizations) {
        const data = await bufferGraphql('query ComoAsiBufferDiagnostics($input: PostsInput!) { posts(first: 100, input: $input) { edges { node { id text status dueAt channelId channelService sentAt externalLink error { message rawError supportUrl } } } } }', {
          input: { organizationId: organization.id, filter: { status: ['error','scheduled','sending','sent'], startDate: start, endDate: end } },
        });
        for (const edge of asArray(asBody(data.posts).edges)) posts.push(asBody(asBody(edge).node));
      }
      return json({ ok: true, start, end, posts });
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      console.error('[como-asi] Buffer diagnostics failed', detail);
      return json({ error: 'buffer_diagnostics_failed', detail }, 502);
    }
  }],
  'POST /api/buffer/publish-now': [async ({ body }) => {
    try {
      return await publishBufferNow(asBody(body));
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      const rateLimited = detail.includes('429') || detail.includes('Too many requests') || detail.includes('window=24h');
      const status = rateLimited ? 429 : detail === 'reel_not_found' ? 404 : detail === 'reel_not_ready' ? 409 : detail === 'manual_publish_invalid_request' ? 400 : 502;
      console.error('[como-asi] Buffer publish-now failed', detail);
      return json({ error: rateLimited ? 'buffer_rate_limited' : 'buffer_publish_now_failed', detail, duplicateSafe: true }, status);
    }
  }],
  'POST /api/buffer/recover': [async ({ body }) => {
    try {
      const b = asBody(body);
      const reelId = asString(b.reelId);
      if (!reelId) return error('reel_id_required', 400);
      const allowed = new Set(['instagram', 'tiktok', 'youtube']);
      const requested = asArray(b.networks).map(value => asString(value).toLowerCase()).filter(value => allowed.has(value));
      const queueResult = await workerRequest('/api/publisher/queue');
      if (!queueResult.ok) return error('publisher_queue_unavailable', 503);
      const rows = asArray(queueResult.data).map(asBody).filter(row => asString(row.reel_id) === reelId && asString(row.account_key) === 'buffer' && asString(row.external_post_id) && (!requested.length || requested.includes(asString(row.platform))));
      const source = await workerRequest('/api/reels/' + encodeURIComponent(reelId));
      if (!source.ok || !source.data || typeof source.data !== 'object') return error('reel_not_found', 404);
      const reel = asBody(source.data);
      const retryAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const videoUrl = `${workerBase}/media/${encodeURIComponent(reelId)}.mp4`;
      const results: Body[] = [];
      for (const row of rows) {
        const postId = asString(row.external_post_id);
        const network = asString(row.platform);
        const data = await bufferGraphql('query ComoAsiRecoverPost($input: PostInput!) { post(input: $input) { id status dueAt channelId channelService sentAt externalLink allowedActions error { message rawError supportUrl } } }', { input: { id: postId } });
        const post = asBody(data.post);
        const status = asString(post.status);
        if (status !== 'error') {
          results.push({ network, postId, status, dueAt: asString(post.dueAt), sentAt: asString(post.sentAt), externalLink: asString(post.externalLink), recovered: false, error: post.error || null });
          continue;
        }
        const edited = await bufferGraphql('mutation ComoAsiRecoverFailedPost($input: EditPostInput!) { editPost(input: $input) { ... on PostActionSuccess { post { id status dueAt channelId channelService sentAt externalLink error { message rawError supportUrl } } } ... on MutationError { message } } }', {
          input: {
            id: postId,
            assets: [{ video: { url: videoUrl } }],
            metadata: bufferMetadata(network, reel),
            schedulingType: 'automatic',
            mode: 'customScheduled',
            dueAt: retryAt,
            aiAssisted: true,
            source: 'como-asi-delivery-recovery',
          },
        });
        const action = asBody(edited.editPost);
        const recoveredPost = asBody(action.post);
        if (!asString(recoveredPost.id)) {
          results.push({ network, postId, status: 'error', recovered: false, error: { message: asString(action.message, 'buffer_edit_recovery_failed'), original: post.error || null } });
          continue;
        }
        results.push({ network, postId: asString(recoveredPost.id), status: asString(recoveredPost.status), dueAt: asString(recoveredPost.dueAt), recovered: true, error: recoveredPost.error || null });
      }
      return json({ ok: true, reelId, retryAt, results });
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      console.error('[como-asi] Buffer recovery failed', detail);
      return json({ error: 'buffer_recovery_failed', detail }, 502);
    }
  }],
  'POST /api/buffer/create': [async ({ body }) => {
    try { return await scheduleBufferReel(asBody(body)); }
    catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      console.error('[como-asi] Buffer create failed', detail);
      return json({ error: 'buffer_create_failed', detail }, 502);
    }
  }],
  'POST /api/buffer/schedule': [async ({ body }) => workerResponse(await workerRequest('/api/metricool/schedule-saved', 'POST', asBody(body)))],
  'POST /api/metricool/oauth/schedule-saved': [async ({ body }) => workerResponse(await workerRequest('/api/metricool/schedule-saved', 'POST', asBody(body)))],
  'POST /api/metricool/oauth/schedule': [async ({ body }) => {
    const b = asBody(body); const token = asString(b.accessToken); const brandId = asString(b.brandId); const reelId = asString(b.reelId); const when = new Date(asString(b.scheduledAt)); const timezone = asString(b.timezone, 'UTC');
    const allowed = new Set(['instagram', 'tiktok', 'youtube']); const networks = [...new Set(asArray(b.networks).map(value => asString(value).toLowerCase()).filter(value => allowed.has(value)))];
    if (!token || !brandId) return error('metricool_connection_required', 401);
    if (!reelId || !Number.isFinite(when.getTime()) || when.getTime() < Date.now() + 60000 || !networks.length) return error('invalid_schedule_request', 400);
    const source = await workerRequest('/api/reels/' + encodeURIComponent(reelId)); if (!source.ok || !source.data || typeof source.data !== 'object') return error('reel_not_found', 404);
    const reel = source.data as Record<string, unknown>; const video = asString(reel.video_object_key); if (asString(reel.status) !== 'ready' || !video) return error('reel_not_ready', 409);
    const text = publicationText(reel.publishing_kit, networks); if (!text) return error('publishing_copy_unavailable', 409); const [signed] = await storage.url([video]);
    const youtube = asBody(asBody(reel.publishing_kit).youtube);
    const socialTitle = asString(reel.title, asString(reel.topic, '¿Cómo Así?')).slice(0, 150);
    const localDateTime = metricoolLocalDateTime(when.toISOString(), timezone);
    const info: Record<string, unknown> = {
      publicationDate: { dateTime: localDateTime, timezone },
      text,
      firstCommentText: '',
      providers: networks.map(network => ({ network })),
      media: [signed.url],
      autoPublish: true,
      draft: false,
      shortener: false,
      hasNotReadNotes: false,
      smartLinkData: { ids: [] },
    };
    if (networks.includes('instagram')) info.instagramData = { type: 'REEL', showReelOnFeed: true, isAiGenerated: true };
    if (networks.includes('tiktok')) info.tiktokData = { title: socialTitle, privacyOption: 'PUBLIC_TO_EVERYONE', disableComment: false, disableDuet: false, disableStitch: false, commercialContentThirdParty: false, commercialContentOwnBrand: false, autoAddMusic: false, photoCoverIndex: 0, isAigc: true };
    if (networks.includes('youtube')) info.youtubeData = { title: asString(youtube.title, asString(reel.title, asString(reel.topic))).slice(0, 100), type: 'short', privacy: 'public', madeForKids: false, isAiGeneratedContent: true };
    try {
      let existingPost: Body | null = null;
      try {
        const scheduled = await metricoolTool(token, 'getscheduledposts', {
          brandId,
          fromDate: new Date(when.getTime() - 86400000).toISOString(),
          toDate: new Date(when.getTime() + 86400000).toISOString(),
          timezone,
          extendedRange: true,
        });
        existingPost = scheduledPostRows(scheduled).find(row => sameScheduledPost(row, localDateTime, when.toISOString(), text)) || null;
      } catch (duplicateCheckError) {
        const detail = duplicateCheckError instanceof Error ? duplicateCheckError.message : String(duplicateCheckError);
        console.warn('[como-asi] Metricool pre-create duplicate check unavailable; create blocked', detail);
        return json({ error: 'metricool_duplicate_check_unavailable', detail, createAttempted: false }, 503);
      }
      if (existingPost) {
        const plannerUrl = asString(existingPost.plannerUrl);
        console.info('[como-asi] Metricool duplicate prevented before create', reelId, localDateTime);
        return json({ ok: true, plannerUrl, duplicatePrevented: true, duplicateSource: 'metricool-precheck' });
      }

      let response: Body;
      try {
        response = asBody(await metricoolTool(token, 'createscheduledpost', { blogId: brandId, date: when.toISOString(), info: JSON.stringify(info) }));
      } catch (createError) {
        const createDetail = createError instanceof Error ? createError.message : String(createError);
        if (/limit of 200 posts scheduled for the month/i.test(createDetail)) throw createError;
        try {
          const verification = await metricoolTool(token, 'getscheduledposts', {
            brandId,
            fromDate: new Date(when.getTime() - 86400000).toISOString(),
            toDate: new Date(when.getTime() + 86400000).toISOString(),            timezone,
            extendedRange: true,
          });
          const recovered = scheduledPostRows(verification).find(row => sameScheduledPost(row, localDateTime, when.toISOString(), text)) || null;
          if (recovered) {
            const plannerUrl = asString(recovered.plannerUrl);
            console.warn('[como-asi] Metricool create response failed but remote post exists; retry suppressed', reelId, localDateTime);
            return json({ ok: true, plannerUrl, duplicatePrevented: true, recoveredAfterCreateError: true });
          }
          console.warn('[como-asi] Metricool create failed; immediate verification found no post, but fallback remains blocked to avoid eventual-consistency duplicates', reelId, createDetail);
          return json({ error: 'metricool_schedule_uncertain', detail: createDetail, verifiedAbsentImmediately: true, fallbackBlocked: true }, 503);
        } catch (verificationError) {
          const verificationDetail = verificationError instanceof Error ? verificationError.message : String(verificationError);
          console.error('[como-asi] Metricool create outcome uncertain; retries and fallbacks must remain blocked', reelId, createDetail, verificationDetail);
          return json({ error: 'metricool_schedule_uncertain', detail: createDetail, verificationError: verificationDetail }, 503);
        }
      }

      const plannerUrl = asString(response.plannerUrl) || asArray(response.data).map(asBody).map(row => asString(row.plannerUrl)).find(Boolean) || '';
      return json({ ok: true, plannerUrl, duplicatePrevented: false, createAttempts: 1 });
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      if (/limit of 200 posts scheduled for the month/i.test(detail)) {
        try {
          const scheduled = await metricoolTool(token, 'getscheduledposts', {
            brandId,
            fromDate: new Date(when.getTime() - 20 * 86400000).toISOString(),
            toDate: new Date(when.getTime() + 20 * 86400000).toISOString(),
            timezone,
            extendedRange: true,
          });
          const rows = scheduledPostRows(scheduled);
          const summary = rows.slice(0, 220).map(row => ({
            id: asString(row.id),
            uuid: asString(row.uuid),
            dateTime: asString(asBody(row.publicationDate).dateTime) || asString(row.date) || asString(row.scheduledAt) || asString(row.publication_date),
            text: asString(row.text).slice(0, 180),
            providers: asArray(row.providers).map(provider => asString(asBody(provider).network)).filter(Boolean),
          }));
          const matching = summary.filter(row => row.text === text.slice(0, 180) || row.dateTime.slice(0, 16) === localDateTime.slice(0, 16));
          console.error('[como-asi] Metricool monthly quota diagnostic', JSON.stringify({ total: rows.length, matching: matching.length, sample: matching.slice(0, 12) }));
          return json({ error: 'metricool_schedule_limit_reached', detail, diagnostic: { total: rows.length, matching: matching.length, sample: matching.slice(0, 12) } }, 502);
        } catch (diagnosticError) {
          const diagnosticDetail = diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError);
          console.error('[como-asi] Metricool quota diagnostic failed', diagnosticDetail);
          return json({ error: 'metricool_schedule_limit_reached', detail, diagnosticError: diagnosticDetail }, 502);
        }
      }
      console.error('[como-asi] Metricool schedule failed', detail);
      return json({ error: 'metricool_schedule_failed', detail }, 502);
    }
  }],

  'POST /api/metricool/oauth/brand-health': [async ({ body }) => {
    const b = asBody(body);
    const token = asString(b.accessToken);
    const brandId = asString(b.brandId);
    const timezone = asString(b.timezone, 'America/Argentina/Buenos_Aires');
    if (!token || !brandId) return error('metricool_connection_required', 401);
    try {
      const brands = normalizeBrands(await metricoolTool(token, 'getbrandsettings', {}));
      const brand = brands.find(item => asString(item.id) === brandId) || null;
      if (!brand) return json({ ok: true, accessible: false, brandId, reason: 'brand_not_in_oauth_account', availableBrands: brands.map(item => ({ id: item.id, label: item.label, networks: item.networks })) });
      const now = Date.now();
      try {
        await metricoolTool(token, 'getscheduledposts', { brandId, fromDate: new Date(now - 3600000).toISOString(), toDate: new Date(now + 3600000).toISOString(), timezone, extendedRange: false });
      } catch (reason) {
        return json({ ok: true, accessible: false, brandId, brand, reason: reason instanceof Error ? reason.message : String(reason) });
      }
      return json({ ok: true, accessible: true, brandId, brand, checkedAt: new Date().toISOString() });
    } catch (reason) {
      return json({ ok: false, accessible: false, brandId, reason: reason instanceof Error ? reason.message : String(reason) }, 502);
    }
  }],

  'POST /api/metricool/oauth/performance': [async ({ body }) => {
    const b = asBody(body);
    const token = asString(b.accessToken);
    const brandId = asString(b.brandId);
    const from = asString(b.from);
    const to = asString(b.to);
    if (!token || !brandId) return error('metricool_connection_required', 401);
    if (!Number.isFinite(new Date(from).getTime()) || !Number.isFinite(new Date(to).getTime())) return error('metricool_performance_range_required', 400);
    const specs: Record<string, string[]> = {
      instagram: ['IGRE02','IGRE03','IGRE04','IGRE06','IGRE07','IGRE08','IGRE09','IGRE10','IGRE11','IGRE12','IGRE21','IGRE23','IGRE24','IGRE25','IGRE27','IGRE28','IGRE29'],
      tiktok: ['TKPO02','TKPO03','TKPO05','TKPO06','TKPO07','TKPO08','TKPO09','TKPO10','TKPO11','TKPO13','TKPO14','TKPO15','TKPO9999'],
      youtube: ['YTVP02','YTVP04','YTVP05','YTVP06','YTVP07','YTVP08','YTVP09','YTVP11','YTVP12','YTVP17'],
    };
    const networks: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    for (const [network, metrics] of Object.entries(specs)) {
      try {
        const value = await metricoolTool(token, 'getanalyticsdatabymetrics', { brandId, metrics, from, to });
        networks[network] = metricoolAnalyticsRows(value, metrics);
      } catch (reason) {
        networks[network] = [];
        errors[network] = (reason instanceof Error ? reason.message : String(reason)).slice(0, 500);
      }
    }
    return json({ ok: true, brandId, from, to, networks, errors, checkedAt: new Date().toISOString() });
  }],

  'POST /api/metricool/oauth/reconcile': [async ({ body }) => {
    const b = asBody(body);
    const token = asString(b.accessToken);
    const brandId = asString(b.brandId);
    const timezone = asString(b.timezone, 'America/Argentina/Buenos_Aires');
    const allowed = new Set(['instagram', 'tiktok', 'youtube']);
    const items = asArray(b.items).map(asBody).slice(0, 30).flatMap(item => {
      const reelId = asString(item.reelId);
      const network = asString(item.network).toLowerCase();
      const scheduledAt = asString(item.scheduledAt);
      const groupNetworks = [...new Set(asArray(item.groupNetworks).map(value => asString(value).toLowerCase()).filter(value => allowed.has(value)))];
      return reelId && allowed.has(network) && Number.isFinite(new Date(scheduledAt).getTime())
        ? [{ reelId, network, scheduledAt, groupNetworks: groupNetworks.length ? groupNetworks : [network] }]
        : [];
    });
    if (!token || !brandId) return error('metricool_connection_required', 401);
    if (!items.length) return json({ ok: true, results: [] });

    const reelCache = new Map<string, Body>();
    const reelFor = async (reelId: string) => {
      if (reelCache.has(reelId)) return reelCache.get(reelId) as Body;
      const source = await workerRequest('/api/reels/' + encodeURIComponent(reelId));
      const reel = source.ok && source.data && typeof source.data === 'object' ? source.data as Body : {};
      reelCache.set(reelId, reel);
      return reel;
    };
    const earliest = Math.min(...items.map(item => new Date(item.scheduledAt).getTime()));
    const latest = Math.max(...items.map(item => new Date(item.scheduledAt).getTime()));
    const from = new Date(earliest - 6 * 60 * 60 * 1000).toISOString();
    const to = new Date(latest + 18 * 60 * 60 * 1000).toISOString();
    let remoteScheduled: Body[] = [];
    try {
      remoteScheduled = scheduledPostRows(await metricoolTool(token, 'getscheduledposts', { brandId, fromDate: from, toDate: to, timezone, extendedRange: true }));
    } catch (reason) {
      console.warn('[como-asi] Metricool reconcile scheduled-state lookup unavailable', reason instanceof Error ? reason.message : String(reason));
    }

    const specs: Record<string, { metrics: string[]; time: string; text: string; id?: string; url: string }> = {
      instagram: { metrics: ['IGRE02', 'IGRE03', 'IGRE04', 'IGRE06'], time: 'IGRE02', text: 'IGRE03', id: 'IGRE04', url: 'IGRE06' },
      youtube: { metrics: ['YTVV02', 'YTVV04', 'YTVV05', 'YTVV17'], time: 'YTVV02', text: 'YTVV17', id: 'YTVV04', url: 'YTVV05' },
      tiktok: { metrics: ['TKPO02', 'TKPO03', 'TKPO05'], time: 'TKPO02', text: 'TKPO05', url: 'TKPO03' },
    };
    const analytics = new Map<string, Body[]>();
    const analyticsErrors = new Map<string, string>();
    for (const network of [...new Set(items.map(item => item.network))]) {
      const spec = specs[network];
      try {
        const value = await metricoolTool(token, 'getanalyticsdatabymetrics', { brandId, metrics: spec.metrics, from, to });
        analytics.set(network, metricoolAnalyticsRows(value, spec.metrics));
      } catch (reason) {
        const detail = reason instanceof Error ? reason.message : String(reason);
        analyticsErrors.set(network, detail.slice(0, 300));
        analytics.set(network, []);
      }
    }

    const results = [];
    for (const item of items) {
      const reel = await reelFor(item.reelId);
      const kit = asBody(reel.publishing_kit);
      const youtube = asBody(kit.youtube);
      const expectedText = item.network === 'youtube'
        ? asString(youtube.title, asString(reel.title, asString(reel.topic)))
        : publicationText(kit, item.groupNetworks);
      const targetLocal = metricoolLocalDateTime(item.scheduledAt, timezone);
      const targetValue = metricoolLocalStampValue(targetLocal);
      const spec = specs[item.network];
      const matches = (analytics.get(item.network) || []).flatMap(row => {
        const publishedLocalValue = metricoolLocalStampValue(row[spec.time]);
        const delta = Math.abs(publishedLocalValue - targetValue);
        return Number.isFinite(delta) && delta <= 3 * 60 * 60 * 1000 && metricoolContentMatches(row[spec.text], expectedText)
          ? [{ row, delta }]
          : [];
      }).sort((left, right) => left.delta - right.delta);
      const match = matches[0]?.row;
      if (match) {
        const externalUrl = asString(match[spec.url]);
        const externalId = spec.id ? asString(match[spec.id]) : (externalUrl.match(/\/video\/(\d+)/)?.[1] || '');
        results.push({
          reelId: item.reelId,
          network: item.network,
          scheduledAt: item.scheduledAt,
          state: 'published',
          publishedAt: metricoolLocalStampToIso(match[spec.time], timezone),
          publishedAtLocal: asString(match[spec.time]),
          externalId,
          externalUrl,
          source: 'metricool-analytics',
        });
        continue;
      }
      const remote = remoteScheduled.find(row => sameScheduledPost(row, targetLocal, item.scheduledAt, publicationText(kit, item.groupNetworks)));
      const remoteProviders = remote ? asArray(remote.providers).map(asBody).map(provider => {
        const rawId = asString(provider.externalId ?? provider.external_id ?? provider.postId ?? provider.post_id ?? provider.id);
        const publicUrl = asString(provider.publicUrl ?? provider.public_url ?? provider.externalUrl ?? provider.external_url ?? provider.externalLink ?? provider.external_link ?? provider.url)
          || (/^https?:\/\//i.test(rawId) ? rawId : '');
        const derivedId = /^https?:\/\//i.test(rawId)
          ? (publicUrl.match(/\/(?:reel|p|shorts)\/([^/?]+)/i)?.[1] || '')          : rawId;
        return {
          network: asString(provider.network ?? provider.provider ?? provider.name).toLowerCase(),
          status: asString(provider.status ?? provider.state ?? provider.publicationStatus ?? provider.publication_status),
          publishedAt: asString(provider.publishedAt ?? provider.published_at ?? provider.sentAt ?? provider.sent_at),
          externalId: derivedId,
          externalUrl: publicUrl,
          detailedStatus: asString(provider.detailedStatus ?? provider.detailed_status),
          error: asString(provider.error ?? provider.errorMessage ?? provider.error_message),
          keys: Object.keys(provider).slice(0, 30),
        };
      }) : [];
      const remoteProvider = remoteProviders.find(provider => provider.network === item.network);
      if (remoteProvider && /^(published|posted|success|succeeded)$/i.test(remoteProvider.status)) {
        const externalUrl = remoteProvider.externalUrl
          || (item.network === 'youtube' && remoteProvider.externalId ? `https://www.youtube.com/watch?v=${remoteProvider.externalId}` : '');
        results.push({
          reelId: item.reelId,
          network: item.network,
          scheduledAt: item.scheduledAt,
          state: 'published',
          publishedAt: remoteProvider.publishedAt || '',
          publishedAtExact: Boolean(remoteProvider.publishedAt),
          externalId: remoteProvider.externalId,
          externalUrl,
          source: 'metricool-planner-provider-status',
          confirmedAt: new Date().toISOString(),
        });
        continue;
      }
      const remoteSummary = remote ? {
        id: asString(remote.id),
        uuid: asString(remote.uuid),
        status: asString(remote.status ?? remote.state ?? remote.publicationStatus ?? remote.publication_status),
        publishedAt: asString(remote.publishedAt ?? remote.published_at ?? remote.sentAt ?? remote.sent_at),
        externalUrl: asString(remote.externalUrl ?? remote.external_url ?? remote.externalLink ?? remote.external_link ?? remote.url),
        providers: remoteProviders,
        keys: Object.keys(remote).slice(0, 40),
      } : null;
      results.push({
        reelId: item.reelId,
        network: item.network,
        scheduledAt: item.scheduledAt,
        state: remote ? 'scheduled' : 'pending',
        plannerUrl: remote ? asString(remote.plannerUrl) : '',
        source: remote ? 'metricool-planner' : 'metricool-analytics-pending',
        error: analyticsErrors.get(item.network) || null,
        diagnostic: {
          analyticsRows: (analytics.get(item.network) || []).length,
          expectedPrefix: metricoolComparable(expectedText).slice(0, 120),
          remoteSummary,
        },
      });
    }
    return json({ ok: true, brandId, timezone, checkedAt: new Date().toISOString(), results });
  }],

  'GET /api/metricool/status': [async () => {
    const config = await metricoolConfig();
    return json({
      configured: config.configured,
      missing: config.configured ? [] : config.missing,
      networks: ['instagram', 'tiktok', 'youtube'],
    });
  }],

  'POST /api/metricool/schedule': [
    requireAuth(),
    withScopes('email'),
    async ({ body, user }) => {
      const config = await metricoolConfig();
      if (!config.configured) return json({ error: 'metricool_not_configured', missing: config.missing }, 503);
      if (!user?.email || user.email.trim().toLowerCase() !== config.allowedEmail) return error('publisher_not_authorized', 403);

      const b = asBody(body);
      const reelId = asString(b.reelId);
      const scheduledAt = asString(b.scheduledAt);
      const timezone = asString(b.timezone, 'America/Argentina/Buenos_Aires');
      const allowedNetworks = new Set(['instagram', 'tiktok', 'youtube']);
      const networks = [...new Set(asArray(b.networks).map(value => asString(value).toLowerCase()).filter(value => allowedNetworks.has(value)))];
      const scheduledDate = new Date(scheduledAt);
      if (!reelId || networks.length === 0 || Number.isNaN(scheduledDate.getTime())) return error('reel_networks_and_date_required', 400);
      if (scheduledDate.getTime() < Date.now() + 120000) return error('publication_date_must_be_in_future', 400);

      const reelResult = await workerRequest(`/api/reels/${encodeURIComponent(reelId)}`);
      if (!reelResult.ok || !reelResult.data || typeof reelResult.data !== 'object') return error('reel_not_found', 404);
      const reel = reelResult.data as Record<string, unknown>;
      const videoPath = asString(reel.video_object_key);
      if (asString(reel.status) !== 'ready' || !videoPath) return error('reel_not_ready', 409);
      const text = publicationText(reel.publishing_kit, networks);
      if (!text) return error('publishing_copy_unavailable', 409);

      const [signed] = await storage.url([videoPath]);
      const metricoolUrl = `https://app.metricool.com/api/v2/scheduler/posts?blogId=${encodeURIComponent(config.blogId)}&userId=${encodeURIComponent(config.userId)}`;
      const response = await fetch(metricoolUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mc-auth': config.token,
        },
        body: JSON.stringify({
          publicationDate: {
            dateTime: metricoolLocalDateTime(scheduledDate.toISOString(), timezone),
            timezone,
          },
          text,
          providers: networks.map(network => ({ network })),
          media: [signed.url],
          autoPublish: true,
          draft: false,
          shortener: false,
          saveExternalMediaFiles: true,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const responseText = await response.text();
      let metricoolData: unknown = responseText;
      try {
        metricoolData = responseText ? JSON.parse(responseText) : null;
      } catch {
        // Keep Metricool's text response for diagnostics without exposing credentials.
      }
      if (!response.ok) {
        console.error('[como-asi] Metricool scheduling failed', response.status, metricoolData);
        return json({ error: 'metricool_schedule_failed', status: response.status, detail: metricoolData }, 502);
      }

      await Promise.all(networks.map(network => workerRequest('/api/publisher/queue', 'POST', {
        reelId,
        platform: network,
        accountKey: 'metricool',
        scheduledAt: scheduledDate.toISOString(),
        publishPayload: { provider: 'metricool', autoPublish: true, timezone },
      })));

      return json({
        ok: true,
        reelId,
        networks,
        scheduledAt: scheduledDate.toISOString(),
        provider: 'metricool',
        metricool: metricoolData,
      }, 201);
    },
  ],

  'POST /api/engine/topic': [async ({ body }) => {
    const b = asBody(body);
    const rawCategory = asString(b.category, 'viral_internet');
    const marketCategoryMatch = rawCategory.match(/^(argentina|random):(.*)$/i);
    const category = asString(marketCategoryMatch?.[2], rawCategory);
    const explicitMarket = asString(b.market).toLowerCase();
    const prefixedMarket = asString(marketCategoryMatch?.[1]).toLowerCase();
    const market = explicitMarket === 'argentina' || explicitMarket === 'random'
      ? explicitMarket
      : prefixedMarket === 'argentina' ? 'argentina' : 'random';
    const memory = asArray(b.memory).slice(0, 60);
    const learning = asArray(b.learning).slice(0, 40);
    const liveSignals = await fetchCurrentSignals(category, '', market);
    if (liveSignals.length === 0) return error('current_sources_unavailable', 503);
    const currentDate = new Date().toISOString();
    const marketInstruction = market === 'argentina'
      ? 'MERCADO ARGENTINA OBLIGATORIO: el tema debe involucrar a una celebridad de reconocimiento transversal para público general argentino o un evento de entretenimiento/cultura pop con vínculo directo, actual y verificable con Argentina. Priorizá señales de medios argentinos. No alcanza con que una noticia internacional haya sido republicada en Argentina. Política y noticias duras siguen prohibidas. Buscá primero protagonistas de nivel masivo; el piso operativo de recognitionScore es 88, pero la preferencia editorial es 92 o más.'
      : 'MERCADO RANDOM/GLOBAL: elegí el mejor tema actual sin restricción geográfica, priorizando reconocimiento masivo latinoamericano o global. recognitionScore mínimo 90 y preferencia editorial 93 o más.';
    const viralCalibration = 'CALIBRACIÓN VIRAL: el patrón de alto rendimiento que queremos repetir NO es repetir a Wanda Nara ni un tema concreto; es repetir la mecánica que funcionó: famoso que se reconoce al instante + conflicto que se entiende en una sola frase + tensión de romance, ego, papelón o contradicción pública + una consecuencia concreta + imágenes fáciles de exagerar. Si dos candidatos están parejos, gana el que necesita menos contexto, genera una reacción emocional más rápida y permite un título que cualquiera entiende en menos de dos segundos. Penalizá fuerte historias de nicho, conflictos burocráticos, contexto largo, protagonistas secundarios y temas que solo son interesantes para fans. La memoria editorial sigue mandando: no repitas protagonista, evento ni ángulo reciente cuando exista una alternativa fuerte.';
    const availableSignals = liveSignals.slice(0, 28);
    const prompt = `Fecha/hora actual UTC: ${currentDate}. Categoría solicitada: ${category}. Mercado editorial: ${market}. ${marketInstruction} ${viralCalibration}\nSEÑALES RECIENTES REALES (índice → titular/fuente/fecha): ${JSON.stringify(availableSignals.map((signal, index) => ({ index, ...signal })))}\nMemoria editorial exclusiva de ¿Cómo Así? (evitar repeticiones): ${JSON.stringify(memory)}\nAprendizaje viral exclusivo de ¿Cómo Así?: ${JSON.stringify(learning)}\nGenerá internamente al menos 18 candidatos DERIVADOS de estas señales y elegí solamente uno que tenga una PERSONA FAMOSA REAL como protagonista central. El nombre y el rostro deben ser reconocibles de inmediato para audiencia masiva de Latinoamérica o global: cantante, actor, deportista, celebridad, figura televisiva, streamer o influencer verdaderamente masivo. Aplicá la prueba de una frase: famoso + conflicto o contradicción pública + consecuencia; si el drama no se entiende sin antecedentes, descartalo. No alcanza con que sea conocido dentro de un nicho, aparezca una vez en prensa o sea familiar de otro famoso. Priorizá nombre propio + rostro reconocible + conflicto público fácil de entender. Elegí exclusivamente uno de estos pilares: escándalo o pelea pública; romance o ruptura respaldada; papelón o momento WTF; ego o conflicto de cultura pop. DESCARTÁ protagonistas desconocidos, figuras de nicho, noticias duras, política, economía, delitos, accidentes, tragedias, menores, víctimas vulnerables y hechos sin conflicto de personalidad. No inventes el tema, el conflicto ni la fama. recognitionScore mide de 0 a 100 si el público general reconoce el NOMBRE Y EL ROSTRO del protagonista sin necesitar conocer su obra; priorizá 92 o más en Argentina y 93 o más en random/global, con piso operativo 88 para Argentina y 90 para random/global, y explicá por qué en recognitionReason. viralScore debe medir específicamente qué tan rápido se entiende y comparte el conflicto: reconocimiento instantáneo, tensión emocional, consecuencia concreta y potencial visual; 90+ significa candidato excepcional. Una figura de culto, director conocido por una sola película, familiar de un famoso o personalidad de nicho nunca supera 79. El title debe incluir literalmente el nombre completo del protagonista para que el gancho sea inmediato. No repitas evento+ángulo ni protagonista reciente si existen alternativas. sourceIndexes debe contener de 1 a 3 índices válidos que respalden el tema. Puntualo de 0 a 100.`;
    const schema = {
      type: 'object',
      properties: {
        category: { type: 'string' }, topic: { type: 'string' }, normalizedTopic: { type: 'string' }, protagonist: { type: 'string' },
        eventKey: { type: 'string' }, angle: { type: 'string' }, subtopic: { type: 'string' }, periodLabel: { type: 'string' }, narrativeQuestion: { type: 'string' },
        hook: { type: 'string' }, title: { type: 'string' }, viralScore: { type: 'number' }, visualScore: { type: 'number' }, rationale: { type: 'string' },
        trendReason: { type: 'string' }, recognitionScore: { type: 'number' }, recognitionReason: { type: 'string' }, sourceIndexes: { type: 'array', items: { type: 'number' } }
      },
      required: ['category','topic','normalizedTopic','protagonist','angle','narrativeQuestion','hook','title','viralScore','visualScore','rationale','trendReason','recognitionScore','recognitionReason','sourceIndexes']
    };
    let selected = await generateStructured(editorialSystem, prompt, schema, 3800) as Record<string, unknown>;
    const minimumRecognition = market === 'argentina' ? 88 : 90;
    const recognitionIsWeak = (candidate: Record<string, unknown>) => Number(candidate.recognitionScore || 0) < minimumRecognition || !asString(candidate.protagonist) || /(figura de culto|de culto|conocid[oa] por su obra|aunque no|dentro de su nicho|nicho|usuarios de internet|quienes conocen)/i.test(asString(candidate.recognitionReason));
    const viralFitIsWeak = (candidate: Record<string, unknown>) => Number(candidate.viralScore || 0) < 88 || Number(candidate.visualScore || 0) < 80;
    if (recognitionIsWeak(selected) || viralFitIsWeak(selected)) {
      selected = await generateStructured(editorialSystem, `${prompt}\nREINTENTO OBLIGATORIO: la primera elección no alcanzó el estándar de fama/viralidad. Elegí una celebridad cuyo nombre y rostro reconozca el público general del mercado objetivo sin explicación; recognitionScore mínimo ${minimumRecognition}. Además, el conflicto debe entenderse en una frase, tener consecuencia concreta y viralScore mínimo 88. Prohibidas figuras de culto o nicho. No repitas un protagonista reciente solo porque ya funcionó antes.`, schema, 3800) as Record<string, unknown>;
    }
    if (recognitionIsWeak(selected)) return error('recognizable_protagonist_unavailable', 503);
    const protagonist = asString(selected.protagonist);
    const selectedTitle = asString(selected.title);
    if (!selectedTitle.toLocaleLowerCase('es').includes(protagonist.toLocaleLowerCase('es'))) selected.title = `${protagonist}: ${selectedTitle || asString(selected.topic)}`;
    const indexes = asArray(selected.sourceIndexes).map(value => Math.trunc(Number(value))).filter(value => Number.isFinite(value) && value >= 0 && value < availableSignals.length).slice(0, 3);
    if (indexes.length === 0) return error('topic_without_current_source', 503);
    return json({ ...selected, market, sources: indexes.map(index => availableSignals[index]), currentCapturedAt: currentDate });
  }],

  'POST /api/engine/research': [async ({ body }) => {
    const b = asBody(body);
    const topic = asString(b.topic);
    const angle = asString(b.angle);
    const protagonist = asString(b.protagonist);
    const eventKey = asString(b.eventKey);
    const narrativeQuestion = asString(b.narrativeQuestion);    if (!topic) return error('topic_required', 400);

    const inheritedSources = parseTrendSignals(b.sources);
    const searchSeed = [protagonist, eventKey].filter(Boolean).join(' ') || topic;
    const discoveredSignals = await fetchCurrentSignals('viral_internet', searchSeed);
    const liveSignals = mergeTrendSignals(inheritedSources, discoveredSignals).slice(0, 12);
    if (liveSignals.length === 0) return error('current_sources_unavailable', 503);

    const scrapedSources = await scrapeTrendSources(liveSignals);
    const scrapedByUrl = new Map(scrapedSources.map(source => [source.url, source.text]));
    const sourcePackets = liveSignals.slice(0, 8).map(signal => ({
      ...signal,
      text: scrapedByUrl.get(signal.url) || '',
      origin: inheritedSources.some(source => source.url === signal.url) ? 'selector' : 'supplemental_search',
    }));
    const prompt = `Fecha/hora actual UTC: ${new Date().toISOString()}. Investigá de forma conservadora este tema para un microdrama de celebridades (no un noticiero): ${topic}. Ángulo: ${angle}. Protagonista: ${protagonist}. Evento clave: ${eventKey}. Pregunta narrativa: ${narrativeQuestion}. FUENTES DISPONIBLES: ${JSON.stringify(sourcePackets)}. Las fuentes marcadas como selector ya justificaron la elección del tema y deben conservarse como evidencia primaria; la búsqueda suplementaria solo amplía cobertura. Producí un brief factual usando únicamente información respaldada por estos paquetes y sus titulares. Separá hechos de contexto incierto. No inventes citas, fechas, delitos, relaciones personales ni intenciones. Si un dato no aparece con respaldo suficiente, excluilo o marcálo como incierto. No confundas rumor con hecho. Incluí afirmaciones seguras, riesgos de precisión, qué fuente respalda el ángulo y qué afirmaciones todavía requieren verificación adicional antes de publicar.`;
    const schema = {
      type: 'object',
      properties: {
        summary: { type: 'string' }, verifiedFacts: { type: 'array', items: { type: 'string' } }, uncertainClaims: { type: 'array', items: { type: 'string' } },
        verificationQueries: { type: 'array', items: { type: 'string' } }, visualEvidence: { type: 'array', items: { type: 'string' } }, safeAngle: { type: 'string' }, sourceCoverage: { type: 'string' }
      },
      required: ['summary','verifiedFacts','uncertainClaims','verificationQueries','visualEvidence','safeAngle','sourceCoverage']
    };
    const research = await generateStructured(editorialSystem, prompt, schema, 4400) as Record<string, unknown>;
    return json({
      ...research,
      sources: liveSignals.slice(0, 8),
      inheritedSourceCount: inheritedSources.length,
      discoveredSourceCount: discoveredSignals.length,
      researchedAt: new Date().toISOString(),
    });
  }],

  'POST /api/engine/story': [async ({ body }) => {
    const b = asBody(body);
    const topic = asString(b.topic);
    if (!topic) return error('topic_required', 400);
    const research = b.research || {};
    const title = asString(b.title);
    const hook = asString(b.hook);
    const protagonist = asString(b.protagonist);
    const strictSpanish = Boolean(b.strictSpanish);
    const languageRepair = strictSpanish ? 'REPARACIÓN DE IDIOMA: el intento anterior fue rechazado. Reescribe desde cero toda narración, título, gancho, remates y propósito de escena en español latino neutro. No uses regionalismos, voseo, palabras ni construcciones inglesas salvo nombres propios inevitables. Los visualPrompt sí pueden estar en inglés. ' : '';
    const prompt = `${languageRepair}Tema: ${topic}. Protagonista público reconocido: ${protagonist}. Título sugerido: ${title}. Hook sugerido: ${hook}. Brief factual: ${JSON.stringify(research)}.\nIDENTIDAD OBLIGATORIA: MALA FAMA es un presentador masculino, un diablo animado adulto y elegante; nunca una mujer, una amiga chismosa ni una conversación entre personas. IDIOMA OBLIGATORIO: devuelve title, coverDeck, hook, closingLine y las 16 narraciones exclusivamente en español latino neutro. Traduce cualquier frase que haya quedado en inglés. Los visualPrompt pueden escribirse en inglés si mejora el resultado visual. Escribe un Reel de 55-70 segundos y EXACTAMENTE 16 escenas para retención máxima. La duración la decide la historia: puede superar un minuto cuando el drama necesita respirar, pero termina apenas pagues el gancho y nunca agregues relleno. NIVEL DE DRAMA: 10/10. NIVEL DE CHISME: 10/10. La voz pertenece a Mala Fama: presentador masculino de registro grave, oscuro y dominante. Habla como fiscal del inframundo y maestro de ceremonias, no como amiga chismosa. No saluda, no coquetea y no conversa con nadie: abre el expediente, exhibe la contradicción y dicta sentencia. Usa silencios tensos, falsa solemnidad, desprecio divertido y remates secos. Prohibidas las muletillas “mi amor”, “amiga”, “reina”, “bebé”, “escúchame”, “te cuento” y cualquier frase que suene a dos amigas hablando. No aceleres ni atropelles las palabras. No uses tono de documental, noticiero, resumen ni artículo leído. ESTRUCTURA DE MICRODRAMA: abre con una acusación factual o contradicción imposible de ignorar; crea una deuda de curiosidad antes del segundo 4; entrega una revelación concreta cada 7-10 segundos; reserva el dato que cambia la lectura para el último tercio; cierra con un remate que haga volver mentalmente al gancho. Objetivo total: 125-150 palabras para una locución masculina lenta, oscura, expresiva y con silencios. Cada escena debe tener normalmente 3-7 palabras habladas; divide cualquier frase que supere 10 palabras. El title debe incluir al famoso y no superar 42 caracteres; coverDeck debe tener 2-5 palabras. ESCENA 1: gancho autosuficiente de 7-12 palabras con nombre del famoso + conflicto concreto + consecuencia incómoda; debe entenderse aunque el espectador llegue sin contexto. Sin saludo, fecha, introducción, preguntas vagas ni frases como “no vas a creer”. ESCENAS 2-3: entrega inmediatamente el primer hecho verificable y explica qué está en juego; no desperdicies una escena prometiendo que luego contarás algo. ESCENAS 4-6: revela quién gana, quién pierde o qué está realmente en juego, solo si el brief lo respalda. ESCENAS 7-11: intensifica el detalle más incómodo, absurdo o hipócrita; alterna dato verificado + reacción filosa + dato nuevo. ESCENAS 12-14: introduce el giro, contraataque o consecuencia que cambie cómo se entiende todo. ESCENAS 15-16: la escena 15 entrega el último hecho o consecuencia que faltaba; la escena 16 dicta un veredicto breve, contundente y gracioso que paga el gancho. Está prohibido terminar con pregunta, suspenso abierto, “¿qué opinas?”, moraleja o información inconclusa. closingLine debe ser exactamente la narración de la escena 16 y tener entre 6 y 12 palabras. No bajes la tensión durante dos escenas consecutivas. Cada línea debe soltar un dato fuerte, juzgar una contradicción, aumentar lo que está en juego o rematar con veneno. Si una línea solo explica contexto como documental, reescríbela. La narradora toma partido editorial contra la hipocresía, el ego o la decisión absurda, sin inventar acusaciones. Usa lenguaje hablado latino neutro, cambios de intención y frases que una persona realmente diría. Puedes usar con moderación “sí, escuchaste bien”, “pero espera”, “porque claro”, “giro total” o “hasta aquí todo normal”, sin repetir fórmulas. Nunca uses “sí, leíste bien” porque la audiencia está escuchando. PROHIBIDO: regionalismos, voseo, “la historia comienza”, “para entender esto”, “en este contexto”, “cabe destacar”, “posteriormente”, “sin embargo”, moralejas, resumen escolar, tono solemne o párrafos largos. Incluye 5-7 micro-remates o contrastes, siempre pegados a un dato nuevo; elimina reacciones vacías que no hagan avanzar la historia. Añade 4-6 golpes de lenguaje picante, neutral y variado cuando el tema lo permita; la palabrota debe caer como remate, no como muletilla. Evita frases tibias como “esto generó debate”, “las opiniones están divididas” o “solo el tiempo dirá”: reemplázalas por la contradicción concreta demostrada por el brief. Asigna a cada escena un delivery entre golpe, veneno, suspenso, incredula o remate. Usa solamente verifiedFacts como afirmaciones; uncertainClaims solo pueden aparecer como duda explícita. DIRECCIÓN VISUAL “FLASH CUT”: cada escena debe parecer una página arrancada de una revista de chismes de lujo intervenida por un artista editorial: retrato ilustrado 2D de técnica mixta, recortes de papel, tinta expresiva, tramas halftone, grano de fotocopia, sombras duras y destellos de paparazzi. Paleta de marca limitada: negro tinta, marfil, verde ácido, magenta eléctrico y azul cobalto. Es adulta, filosa, imperfecta y editorial; nunca animación familiar, muñeco 3D, chibi, rostro plástico ni póster genérico. El Reel alterna tres capas visuales exactas: MALA FAMA aparece en las escenas 1, 5, 9, 13 y 16; el protagonista famoso aparece en las escenas 2, 4, 7, 10, 12 y 15; las escenas 3, 6, 8, 11 y 14 son cortes simbólicos sin rostros. Cada visualPrompt del presentador debe comenzar literalmente con “HOST_SCENE:” para activar su identidad fija. Cada HOST_SCENE representa siempre al mismo diablo animado masculino adulto: rostro anguloso color borgoña oscuro, dos cuernos negros pulidos curvados hacia atrás, ojos verde ácido, cabello negro peinado hacia atrás con una mecha blanca, barba puntiaguda corta, traje negro entallado, camisa magenta, guantes negros, pañuelo verde ácido, cola fina terminada en punta y micrófono de metal ennegrecido. Sonrisa lateral de verdugo, ceja levantada y presencia dominante. Estética de animación editorial adulta 2D, nunca demonio terrorífico realista, personaje infantil, mujer, humano corriente, muñeco 3D ni copia de una franquicia. No cambies rostro, cuernos, ojos, cabello, vestuario, accesorios ni colores entre escenas. Antes de escribir los visualPrompt, define internamente un ANCLA DE CONTINUIDAD con tres rasgos públicos estables del famoso —estructura facial, peinado/color de cabello y estilo característico— y repite literalmente esa misma descripción en cada escena donde aparezca. No cambies edad aparente, cabello, facciones ni identidad entre escenas salvo que el hecho verificado lo exija. Alterna primerísimo primer plano recortado, ángulo holandés, plano medio asimétrico, plano amplio teatral, cenital de objetos, silueta a contraluz y macro simbólico. Nunca uses dos rostros centrados ni el mismo encuadre consecutivamente. Las escenas 1, 4, 8, 12 y 16 son interrupciones visuales radicales con cambio de escala, composición o color. Cuando aparezca el famoso, repite su nombre exacto y el ancla de continuidad; debe ser reconocible, ilustrado y nunca fotorealista. Si interviene una persona real, nunca pidas desnudez, lencería, ropa interior, pose sexualizada ni una situación íntima o comprometedora; usa objetos, sets publicitarios, cámaras, telas o metáforas visuales. Se permite collage físico/editorial dentro de una única composición, pero nunca cuadrícula, split screen, captura de red social, texto legible, letras, logos, marcas, carteles, captions ni UI. El campo narration debe ser exactamente la concatenación, en orden, de las 16 narraciones de escena. No inventes nada fuera del brief.`;
    const sceneSchema = {
      type: 'object',
      properties: {
        index: { type: 'number' }, narration: { type: 'string' }, visualPrompt: { type: 'string' }, purpose: { type: 'string' }, durationSeconds: { type: 'number' },
        delivery: { type: 'string', enum: ['golpe','veneno','suspenso','incredula','remate'] }
      },
      required: ['index','narration','visualPrompt','purpose','durationSeconds','delivery']
    };
    const schema = {
      type: 'object',
      properties: {
        title: { type: 'string' }, coverDeck: { type: 'string' }, hook: { type: 'string' }, narration: { type: 'string' },
        scenes: { type: 'array', minItems: 16, maxItems: 16, items: sceneSchema },
        closingLine: { type: 'string' }
      },
      required: ['title','coverDeck','hook','narration','scenes','closingLine']
    };
    let data = await generateStructured(editorialSystem, prompt, schema, 7600) as { scenes?: unknown[]; narration?: string; title?: string; coverDeck?: string; hook?: string; closingLine?: string };
    const audioWording = (value: unknown) => asString(value).replace(/\bsí\s*,?\s*leíste bien\b/giu, 'sí, escuchaste bien');
    data.title = audioWording(data.title);
    data.coverDeck = audioWording(data.coverDeck);
    data.hook = audioWording(data.hook);
    data.closingLine = audioWording(data.closingLine);
    if (Array.isArray(data.scenes)) {
      data.scenes = data.scenes.map(scene => {
        if (!scene || typeof scene !== 'object') return scene;
        const item = scene as Record<string, unknown>;
        return { ...item, narration: audioWording(item.narration) };
      });
    }
    const regionalismPattern = /\b(quilombo|che|bolud[oa]s?|pelotud[oa]s?|pibes?|minas?|laburo|guita|bancar|copad[oa]s?|posta|acá|parce|vaina|chimba|berrac[oa]s?|güey|wey|órale|cachai|we[oó]n|sos|tenés|podés|querés|mirá|esperá|decí|hacé|meté|pagá)\b/iu;
    const spokenDraft = [data.title, data.coverDeck, data.hook, data.closingLine, ...(Array.isArray(data.scenes) ? data.scenes.map(scene => scene && typeof scene === 'object' ? asString((scene as Record<string, unknown>).narration) : '') : [])].filter(Boolean).join(' ');
    if (regionalismPattern.test(spokenDraft)) {
      data = await generateStructured(editorialSystem, `${prompt}\nREPARACIÓN OBLIGATORIA: el borrador anterior contenía regionalismos. Reescribe todo el texto hablado en español latino neutro, conserva los hechos y el picante, y elimina voseo y vocabulario local.`, schema, 7600) as typeof data;
    }
    if (!Array.isArray(data.scenes) || data.scenes.length !== 16) throw new Error('story_requires_exactly_16_scenes');
    const finalClosingLine = audioWording(data.closingLine).replace(/[?¿]+/g, '').trim();
    if (finalClosingLine) {
      const lastScene = data.scenes[15];
      if (lastScene && typeof lastScene === 'object') {
        data.scenes[15] = { ...lastScene, narration: finalClosingLine, delivery: 'remate' };
        data.closingLine = finalClosingLine;
      }
    }
    const narration = data.scenes
      .map(scene => scene && typeof scene === 'object' ? asString((scene as Record<string, unknown>).narration) : '')
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return json({ ...data, narration });
  }],

  'POST /api/engine/image': [async ({ body }) => {
    const b = asBody(body);
    const visualPrompt = asString(b.visualPrompt);
    const topic = asString(b.topic);
    const protagonist = asString(b.protagonist);
    const forceSafeFallback = Boolean(b.safeFallback);
    if (!visualPrompt) return error('visualPrompt_required', 400);

    const sensitiveTerms = /(lingerie|underwear|nude|nudity|racy|provocative|bra\b|panties|sexual|seductive|bikini|desnudad?|lencer[ií]a|ropa interior|sost[eé]n|corpi[nñ]o|pose sensual)/i;
    const sensitiveVisual = forceSafeFallback || sensitiveTerms.test(visualPrompt);
    const hostScene = /\bHOST_SCENE\b/i.test(visualPrompt);
    const scenePrompt = visualPrompt.replace(/\bHOST_SCENE\b:?/gi, '').trim();
    const safeVisualConcept = scenePrompt
      .replace(/(lingerie|underwear|nude|nudity|racy|provocative|bra\b|panties|sexual|seductive|bikini|desnudad?|lencer[ií]a|ropa interior|sost[eé]n|corpi[nñ]o|pose sensual)/gi, 'campaña de moda')
      .replace(/\b[\p{Lu}][\p{L}'-]+(?:\s+[\p{Lu}][\p{L}'-]+)+\b/gu, 'una celebridad ficticia')
      .slice(0, 500);
    const regularPrompt = `Vertical 9:16, RECREACIÓN EDITORIAL “FLASH CUT” para ¿Cómo Así?. Tema: ${topic}. Protagonista público reconocido: ${protagonist}. Escena: ${scenePrompt}. Crear una ilustración adulta de técnica mixta 2D: retrato editorial dibujado y recortado en papel, tinta expresiva, bordes rasgados, tramas halftone, grano de fotocopia, sombras duras, destello de paparazzi y un único objeto simbólico enorme. Mantener la estructura facial, peinado, expresión y estilo público que hacen reconocible inmediatamente a ${protagonist}, sin copiar ninguna fotografía. Parecido real, exageración inteligente y emoción teatral; nunca rostro genérico. Mantener constantes edad aparente, estructura facial, color y forma del cabello y rasgos distintivos descritos en la escena; no embellecer hasta borrar la identidad. Composición asimétrica, recorte audaz, capas con profundidad y abundante espacio negativo. Paleta limitada de negro tinta, marfil, verde ácido, magenta eléctrico y azul cobalto; cambiar el color dominante según la emoción indicada. Debe sentirse como moda editorial irreverente y revista de chismes de lujo intervenida a mano, no como póster. PROHIBIDO: animación infantil, Disney/Pixar, muñeco 3D, chibi, plástico brillante, cabeza gigante, ojos de juguete, sonrisa permanente, pose frontal repetida o estética de videojuego. Vestuario completamente cubierto y situación pública no íntima. Una sola composición vertical de lectura instantánea, sin texto legible, letras, logos, marcas de agua, carteles, captions, cuadrícula, split screen ni UI.`;
    const hostPrompt = `Vertical 9:16, HOST SCENE de MALA FAMA, presentador masculino recurrente de ¿Cómo Así? y diablo animado editorial adulto. Escena y emoción: ${scenePrompt}. Mostrar siempre exactamente el mismo personaje: rostro masculino anguloso color borgoña oscuro, dos cuernos negros pulidos curvados hacia atrás, ojos verde ácido, cabello negro hacia atrás con una mecha blanca, barba puntiaguda corta, traje negro entallado, camisa magenta, guantes negros, pañuelo verde ácido, cola fina terminada en punta y micrófono de metal ennegrecido. Sonrisa lateral de verdugo, ceja levantada, postura dominante; jamás gesto amistoso ni conversación de amigas. Animación editorial adulta 2D con papel rasgado, tinta, halftone, grano de fotocopia, sombras duras y flash de paparazzi. Paleta negro tinta, borgoña, marfil, verde ácido, magenta y azul cobalto. Mantener idénticos rostro, cuernos, ojos, cabello, barba, vestuario, accesorios y colores en cada aparición. Nunca mujer, humano corriente, demonio terrorífico realista, personaje infantil, Disney/Pixar, muñeco 3D, chibi, plástico brillante ni copia de una franquicia. Una sola composición vertical, sin texto legible, letras, logos, marcas, carteles, captions, cuadrícula, split screen ni UI.`;
    const symbolicPrompt = `Vertical 9:16, RECREACIÓN EDITORIAL “FLASH CUT” claramente ficticia. Concepto visual: ${safeVisualConcept}. Contar el conflicto mediante un único objeto simbólico enorme dentro de un collage físico de papel rasgado, tinta, halftone, grano de fotocopia, sombras duras y flashes de paparazzi. Paleta limitada: negro tinta, marfil, verde ácido, magenta eléctrico y azul cobalto. Composición adulta, asimétrica, sofisticada y agresiva, con profundidad real entre capas y espacio negativo; nunca caricatura 3D ni animación infantil. No mostrar, imitar ni sugerir el cuerpo o rostro de ninguna persona real. Si aparecen personas, deben ser adultos ficticios completamente vestidos y en poses neutrales. Sin desnudez, lencería, ropa interior, sexualización, texto legible, logos, marcas, carteles, cuadrícula, split screen ni UI.`;
    const selectedPrompt = hostScene ? hostPrompt : sensitiveVisual ? symbolicPrompt : regularPrompt;

    try {
      const result = await ai.imageGen({ prompt: selectedPrompt, maxOutputBytes: 950000 });
      return json({ data: result.image.data, mimeType: result.image.mimeType, bytes: result.image.bytes, safeFallback: sensitiveVisual });
    } catch (generationError) {
      if (sensitiveVisual) throw generationError;
      console.warn('[como-asi] primary image generation failed; using symbolic fallback', generationError);
      const result = await ai.imageGen({ prompt: symbolicPrompt, maxOutputBytes: 950000 });
      return json({ data: result.image.data, mimeType: result.image.mimeType, bytes: result.image.bytes, safeFallback: true });
    }
  }],

  'POST /api/engine/cover': [async ({ body }) => {
    const b = asBody(body);
    const topic = asString(b.topic);
    const title = asString(b.title);
    const protagonist = asString(b.protagonist);
    if (!topic) return error('topic_required', 400);

    const sensitiveCover = /(lingerie|underwear|nude|nudity|racy|provocative|bra\b|panties|sexual|seductive|bikini|desnudad?|lencer[ií]a|ropa interior|sost[eé]n|corpi[nñ]o|pose sensual)/i.test(`${topic} ${title}`);
    const regularPrompt = `Vertical 9:16 PORTADA-RECREACIÓN “FLASH CUT” para ¿Cómo Así?. Tema: ${topic}. Protagonista público reconocido: ${protagonist}. Ancla narrativa: ${title}. Crear un retrato editorial adulto de técnica mixta 2D, inmediatamente reconocible como ${protagonist}: estructura facial, peinado, expresión y estilo público conservados, sin copiar una fotografía. Rostro recortado de forma audaz ocupando 45-60% del cuadro, gesto intenso y nada de sonrisa genérica. Capas de papel rasgado, tinta expresiva, halftone, grano de fotocopia, sombra dura y flash de paparazzi; un solo objeto simbólico gigante relacionado con el chisme. Paleta negro tinta, marfil, verde ácido, magenta eléctrico y azul cobalto. Composición asimétrica de revista de moda irreverente, con una zona oscura y limpia para la tipografía del render. Nunca animación infantil, Disney/Pixar, muñeco 3D, chibi, plástico brillante, cabeza gigante, ojos de juguete ni póster genérico. Vestuario completamente cubierto y situación pública. Solo arte: ningún texto legible, letras, palabras, logos, marcas de agua, carteles, captions, cuadrícula, split screen ni UI.`;
    const safePrompt = 'Vertical 9:16 PORTADA-RECREACIÓN “FLASH CUT” claramente ficticia sobre una celebridad y una campaña pública controvertida. Mostrar un único objeto simbólico enorme dentro de un collage físico adulto de papel rasgado, tinta, halftone, grano de fotocopia, sombras duras y flashes de paparazzi. Paleta negro tinta, marfil, verde ácido, magenta eléctrico y azul cobalto. Composición asimétrica, sofisticada y agresiva, con una zona oscura limpia para la tipografía del render. No mostrar, imitar ni sugerir el cuerpo o rostro de ninguna persona real. Si aparece una figura humana, debe ser adulta, ficticia, completamente vestida y neutral. Nunca animación infantil, muñeco 3D, chibi ni plástico brillante. Sin desnudez, ropa interior, sexualización, texto, logos, marcas, carteles, cuadrícula, split screen ni UI.';
    const selectedPrompt = sensitiveCover ? safePrompt : regularPrompt;

    try {
      const result = await ai.imageGen({ prompt: selectedPrompt, maxOutputBytes: 950000 });
      return json({ data: result.image.data, mimeType: result.image.mimeType, bytes: result.image.bytes, safeFallback: sensitiveCover });
    } catch (generationError) {
      if (sensitiveCover) throw generationError;
      console.warn('[como-asi] primary cover generation failed; using symbolic fallback', generationError);
      const result = await ai.imageGen({ prompt: safePrompt, maxOutputBytes: 950000 });
      return json({ data: result.image.data, mimeType: result.image.mimeType, bytes: result.image.bytes, safeFallback: true });
    }
  }],

  'POST /api/engine/publishing-kit': [async ({ body }) => {
    const b = asBody(body);
    const topic = asString(b.topic);
    const title = asString(b.title);
    const narration = asString(b.narration);
    const prompt = `Prepará kit de publicación para un Reel de ¿Cómo Así?. Tema: ${topic}. Título: ${title}. Narración: ${narration}. El canal es CHISME + ACTUALIDAD VIRAL + FAMOSOS + BIZARRO/WTF + HUMOR NEGRO + CULTURA POP. Debe sonar filoso, irreverente, calle/pop, divertido y compartible. Nada de copy corporativo ni CTA mendigante. Abrí con reacción, chisme o contradicción; después el hecho central. El comentario fijado debe provocar conversación con picardía. Títulos provocadores pero factuales, nunca “todo internet habla” si no está respaldado. Podés usar una puteada leve si suma. HASHTAGS OBLIGATORIOS: generá hashtags específicos y buscables para cada red, mezclando protagonista/tema + intención de búsqueda + nicho; evitá relleno genérico. Incluí ComoAsi como hashtag de marca. Apuntá a 4-6 hashtags útiles en Instagram, 4-6 en TikTok y 3-5 en YouTube. No inventes datos nuevos ni conviertas rumor o broma en afirmación factual.`;
    const schema = {
      type: 'object',
      properties: {
        instagram: { type: 'object', properties: { caption: { type: 'string' }, hashtags: { type: 'array', items: { type: 'string' } }, pinnedComment: { type: 'string' } }, required: ['caption','hashtags','pinnedComment'] },
        tiktok: { type: 'object', properties: { caption: { type: 'string' }, hashtags: { type: 'array', items: { type: 'string' } }, pinnedComment: { type: 'string' } }, required: ['caption','hashtags','pinnedComment'] },
        youtube: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, hashtags: { type: 'array', items: { type: 'string' } } }, required: ['title','description','hashtags'] }
      },
      required: ['instagram','tiktok','youtube']
    };
    const generated = await generateStructured(editorialSystem, prompt, schema, 3000);
    return json(publishingKitWithHashtags(generated));
  }],

  'POST /api/assets/write': [async ({ body }) => {
    const b = asBody(body);
    const path = asString(b.path);
    const content = asString(b.content);
    const contentType = asString(b.contentType, 'application/octet-stream');
    if (!path || !content) return error('path_and_content_required', 400);
    if (!path.startsWith('reels/') && !path.startsWith('covers/') && !path.startsWith('audio/')) return error('invalid_asset_path', 400);
    const [ok] = await storage.write([{ path, content, contentType }]);
    if (!ok) return error('storage_write_failed', 500);
    const [signed] = await storage.url([path]);
    return json({ ok: true, path, url: signed.url });
  }],

  'POST /api/assets/chunk': [async ({ body }) => {
    const b = asBody(body);
    const uploadId = asString(b.uploadId);
    const index = Number(b.index);
    const content = asString(b.content);
    if (!/^[a-z0-9-]{8,80}$/i.test(uploadId) || !Number.isInteger(index) || index < 0 || index > 511 || !content) return error('invalid_chunk', 400);
    const chunkPath = `uploads/${uploadId}/${String(index).padStart(3, '0')}.part`;
    const [ok] = await storage.write([{ path: chunkPath, content, contentType: 'application/octet-stream' }]);
    if (!ok) return error('chunk_write_failed', 500);
    return json({ ok: true, index });
  }],

  'POST /api/assets/commit': [async ({ body }) => {
    const b = asBody(body);
    const uploadId = asString(b.uploadId);    const chunkCount = Number(b.chunkCount);
    const path = asString(b.path);
    const contentType = asString(b.contentType, 'application/octet-stream');
    if (!/^[a-z0-9-]{8,80}$/i.test(uploadId) || !Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > 512) return error('invalid_upload_manifest', 400);
    if (!path.startsWith('reels/') && !path.startsWith('covers/') && !path.startsWith('audio/')) return error('invalid_asset_path', 400);
    const chunkPaths = Array.from({ length: chunkCount }, (_, index) => `uploads/${uploadId}/${String(index).padStart(3, '0')}.part`);
    const chunks = await storage.read(chunkPaths);
    if (chunks.some(chunk => !chunk.content)) return error('upload_chunk_missing', 409);
    const content = chunks.map(chunk => chunk.content || '').join('');
    const [ok] = await storage.write([{ path, content, contentType }]);
    if (!ok) return error('storage_write_failed', 500);
    await storage.delete(chunkPaths);
    const [signed] = await storage.url([path]);
    return json({ ok: true, path, url: signed.url, chunks: chunkCount });
  }],

  'POST /api/assets/delete-reels': [async ({ body }) => {
    const ids = [...new Set(asArray(asBody(body).reelIds).map(value => asString(value)).filter(value => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)))].slice(0, 50);
    if (!ids.length) return error('reel_ids_required', 400);
    const deleted: string[] = [];
    for (const id of ids) {
      for (const prefix of [`reels/${id}/`, `covers/${id}/`, `audio/${id}/`]) {
        let nextToken: string | undefined;
        do {
          const page = await storage.list({ prefix, limit: 100, ...(nextToken ? { nextToken } : {}) });
          if (page.paths.length) {
            const results = await storage.delete(page.paths);
            page.paths.forEach((path, index) => { if (results[index]) deleted.push(path); });
          }
          nextToken = page.nextToken;
        } while (nextToken);
      }
    }
    return json({ ok: true, reelIds: ids, deletedCount: deleted.length, deleted });
  }],

  'POST /api/assets/url': [async ({ body }) => {
    const b = asBody(body);
    const path = asString(b.path);
    if (!path) return error('path_required', 400);
    const [signed] = await storage.url([path]);
    return json({ path, url: signed.url });
  }],
});
