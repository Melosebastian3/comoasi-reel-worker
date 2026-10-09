// Deletes specific Buffer posts by id (posts this project created and its owner asked to remove).
//   node publish/buffer-delete.js <request.json>   request: { "postIds": ["..."], "reason": "..." }
import fs from 'node:fs/promises';

async function bufferGraphql(query, variables = {}) {
  const key = String(process.env.BUFFER_API_KEY || '').trim();
  if (!key) throw new Error('buffer_api_key_missing');
  const response = await fetch('https://api.buffer.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(() => ({}));
  const errors = (payload.errors || []).map(item => item?.message).filter(Boolean);
  if (!response.ok || errors.length) throw new Error(`buffer_api_failed:${response.status}:${errors.join(' | ') || 'unknown_error'}`);
  return payload.data || {};
}

const request = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
console.log(`[buffer] deleting ${request.postIds.length} posts: ${request.reason || ''}`);
let failed = 0;
for (const id of request.postIds) {
  try {
    const data = await bufferGraphql('mutation ComoAsiDeletePost($input: DeletePostInput!) { deletePost(input: $input) { ... on DeletePostSuccess { id } ... on MutationError { message } } }', { input: { id } });
    const result = data.deletePost || {};
    if (result.id) console.log(`[buffer] deleted ${result.id}`);
    else { failed += 1; console.log(`[buffer] not deleted ${id}: ${result.message || 'unknown'}`); }
  } catch (error) {
    failed += 1;
    console.log(`[buffer] not deleted ${id}: ${error.message}`);
  }
}
if (failed) process.exitCode = 1;
