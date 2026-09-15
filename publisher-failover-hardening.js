import fs from 'node:fs/promises';

const path = new URL('./buffer-automation.js', import.meta.url);
let source = await fs.readFile(path, 'utf8');

const oldImport = "import { scheduleBufferIdempotent } from './buffer-idempotency.js';";
const newImport = `${oldImport}\nimport { bufferRetryAtFromError, isBufferRateLimitError, scheduleUploadPostFallback, uploadPostFallbackReady } from './upload-post-fallback.js';`;
if (!source.includes("./upload-post-fallback.js")) {
  if (!source.includes(oldImport)) throw new Error('publisher_failover_import_target_not_found');
  source = source.replace(oldImport, newImport);
}

const oldEarlyReturn = "  if (next.status === 'scheduled' || next.status === 'missed') return next;";
const newEarlyReturn = `  if (next.status === 'scheduled' || next.status === 'missed') return next;\n  if (next.status === 'degraded' && next.bufferRetryAt && now < new Date(next.bufferRetryAt).getTime()) return next;`;
if (!source.includes("next.status === 'degraded' && next.bufferRetryAt")) {
  if (!source.includes(oldEarlyReturn)) throw new Error('publisher_failover_early_return_target_not_found');
  source = source.replace(oldEarlyReturn, newEarlyReturn);
}

const oldBlock = `  next.reelId = job.reel_id;\n  const scheduledAt = new Date(Math.max(publishMs, now + 15 * 60 * 1000)).toISOString();\n  const scheduled = asObject(await scheduleBuffer({\n    reelId: job.reel_id,\n    scheduledAt,\n    timezone: config.timezone,\n    networks: config.networks,\n  }));\n\n  next.status = 'scheduled';\n  next.scheduledAt = scheduledAt;\n  next.error = null;\n  next.provider = 'buffer';\n  next.buffer = {\n    duplicatePrevented: Boolean(scheduled.duplicatePrevented),\n    scheduled: Array.isArray(scheduled.scheduled) ? scheduled.scheduled : [],\n    idempotency: clean(scheduled.idempotency) || null,\n  };\n  return next;`;

const newBlock = `  next.reelId = job.reel_id;\n  const scheduledAt = new Date(Math.max(publishMs, now + 15 * 60 * 1000)).toISOString();\n  const targetNetworks = Array.isArray(next.pendingNetworks) && next.pendingNetworks.length\n    ? next.pendingNetworks\n    : config.networks;\n\n  try {\n    const scheduled = asObject(await scheduleBuffer({\n      reelId: job.reel_id,\n      scheduledAt,\n      timezone: config.timezone,\n      networks: targetNetworks,\n    }));\n\n    next.status = 'scheduled';\n    next.scheduledAt = scheduledAt;\n    next.error = null;\n    next.provider = next.uploadPost ? 'hybrid' : 'buffer';\n    next.pendingNetworks = [];\n    next.bufferRetryAt = null;\n    next.buffer = {\n      duplicatePrevented: Boolean(scheduled.duplicatePrevented),\n      scheduled: Array.isArray(scheduled.scheduled) ? scheduled.scheduled : [],\n      idempotency: clean(scheduled.idempotency) || null,\n    };\n    return next;\n  } catch (error) {\n    if (!isBufferRateLimitError(error)) throw error;\n\n    const retryAt = bufferRetryAtFromError(error, now);\n    const fallbackCandidates = targetNetworks.filter(network => ['instagram', 'youtube'].includes(network));\n    let fallback = null;\n    let fallbackNetworks = [];\n    if (uploadPostFallbackReady() && fallbackCandidates.length) {\n      try {\n        fallback = asObject(await scheduleUploadPostFallback({\n          reelId: job.reel_id,\n          scheduledAt,\n          networks: fallbackCandidates,\n        }));\n        fallbackNetworks = Array.isArray(fallback.networks) ? fallback.networks : fallbackCandidates;\n      } catch (fallbackError) {\n        console.error('[como-asi] Upload-Post fallback failed', job.reel_id, clean(fallbackError?.message || fallbackError));\n      }\n    }\n\n    const pendingNetworks = targetNetworks.filter(network => !fallbackNetworks.includes(network));\n    next.scheduledAt = scheduledAt;\n    next.error = null;\n    next.bufferRetryAt = retryAt;\n    next.pendingNetworks = pendingNetworks;\n    if (fallback) {\n      next.uploadPost = {\n        provider: 'upload-post',\n        scheduled: Array.isArray(fallback.scheduled) ? fallback.scheduled : [],\n        jobId: clean(fallback.jobId) || null,\n        idempotencyKey: clean(fallback.idempotencyKey) || null,\n      };\n    }\n\n    if (!pendingNetworks.length && fallback) {\n      next.status = 'scheduled';\n      next.provider = 'upload-post';\n      return next;\n    }\n\n    next.status = 'degraded';\n    next.provider = fallback ? 'hybrid' : 'buffer';\n    console.warn('[como-asi] Buffer rate-limited; slot held for retry', next.key, retryAt, pendingNetworks.join(','));\n    return next;\n  }`;

if (!source.includes("Buffer rate-limited; slot held for retry")) {
  if (!source.includes(oldBlock)) throw new Error('publisher_failover_schedule_target_not_found');
  source = source.replace(oldBlock, newBlock);
}

await fs.writeFile(path, source, 'utf8');
console.log('[como-asi] publisher failover hardening applied');
