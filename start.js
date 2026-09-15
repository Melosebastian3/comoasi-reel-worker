await import('./media-proxy-hardening.js');
await import('./render-output-hardening.js');
await import('./server.js');

const timer = setTimeout(() => {
  void (async () => {
    try {
      const optimizer = await import('./optimize-buffer-assets.js');
      const optimized = await optimizer.optimizeScheduledBufferAssets();
      console.info('[como-asi] background Buffer asset optimization complete', JSON.stringify(optimized));
    } catch (error) {
      console.error('[como-asi] background Buffer asset optimization failed', error?.message || error);
    }

    try {
      const recovery = await import('./buffer-delivery-recovery.js');
      await recovery.reconcileBufferDeliveries();
      recovery.startBufferDeliveryRecovery(900000);
    } catch (error) {
      console.error('[como-asi] Buffer delivery recovery bootstrap failed', error?.message || error);
    }
  })();
}, 3000);
timer.unref?.();
