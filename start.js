await import('./media-proxy-hardening.js');
await import('./render-output-hardening.js');
await import('./server.js');

const timer = setTimeout(() => {
  void import('./optimize-buffer-assets.js')
    .then(module => module.optimizeScheduledBufferAssets())
    .then(results => console.info('[como-asi] background Buffer asset optimization complete', JSON.stringify(results)))
    .catch(error => console.error('[como-asi] background Buffer asset optimization failed', error?.message || error));
}, 3000);
timer.unref?.();
