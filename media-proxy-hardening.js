import fs from 'node:fs/promises';

const path = new URL('./server.js', import.meta.url);
let source = await fs.readFile(path, 'utf8');

const originalImport = "import { Readable } from 'node:stream';";
const hardenedImport = "import { Readable } from 'node:stream';\nimport { pipeline } from 'node:stream/promises';";
if (source.includes(originalImport) && !source.includes("node:stream/promises")) {
  source = source.replace(originalImport, hardenedImport);
}

const timedFetch = `    const upstream = await fetch(url, {
      headers: requestHeaders,
      signal: AbortSignal.timeout(120000),
    });`;
const durableFetch = `    // Social networks may keep video downloads open for several minutes.\n    // Do not abort a valid media stream with a fixed request timeout.\n    const upstream = await fetch(url, {\n      headers: requestHeaders,\n    });`;
if (source.includes(timedFetch)) {
  source = source.replace(timedFetch, durableFetch);
}

const unsafePipe = '    Readable.fromWeb(upstream.body).pipe(res);';
const safePipe = `    // pipeline propagates upstream/client stream errors into this function's try/catch\n    // instead of emitting an unhandled stream error that terminates the worker.\n    await pipeline(Readable.fromWeb(upstream.body), res);`;
if (source.includes(unsafePipe)) {
  source = source.replace(unsafePipe, safePipe);
}

if (!source.includes("await pipeline(Readable.fromWeb(upstream.body), res);")) {
  throw new Error('media_proxy_hardening_target_not_found');
}

await fs.writeFile(path, source, 'utf8');
console.log('[como-asi] media proxy hardening applied');
