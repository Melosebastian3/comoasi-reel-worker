// Test-only preload (node --import ./test/offline-fetch.js): replaces internet news sources
// with a fictional RSS feed so the batch can run in a sandbox without outbound access.
const realFetch = globalThis.fetch;
const now = new Date().toUTCString();
const rss = `<?xml version="1.0"?><rss><channel>
<item><title>Lucho Brillo cancela otra vez su gira de regreso - Diario Ficticio</title><link>https://example.com/lucho-gira</link><pubDate>${now}</pubDate><source>Diario Ficticio</source></item>
<item><title>Fans de Lucho Brillo piden reembolso por la gira fantasma - Revista Inventada</title><link>https://example.org/lucho-reembolso</link><pubDate>${now}</pubDate><source>Revista Inventada</source></item>
</channel></rss>`;

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (['127.0.0.1', 'localhost'].includes(url.hostname)) return realFetch(input, init);
  if (url.hostname === 'news.google.com') return new Response(rss, { status: 200 });
  if (url.hostname.startsWith('example.')) return new Response('<p>Nota ficticia de prueba sobre Lucho Brillo y su gira cancelada.</p>', { status: 200 });
  return new Response('offline test', { status: 404 });
};
