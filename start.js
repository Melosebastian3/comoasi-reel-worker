await import('./media-proxy-hardening.js');
await import('./render-output-hardening.js');
await import('./publisher-failover-hardening.js');
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
      recovery.startBufferDeliveryRecovery(900000);
      const configuredDelay = Number(process.env.BUFFER_FIRST_RECOVERY_DELAY_MS || 300000);
      const firstRecoveryDelayMs = Number.isFinite(configuredDelay) && configuredDelay >= 1000 ? configuredDelay : 300000;
      const firstRecovery = setTimeout(() => {
        void recovery.reconcileBufferDeliveries().catch(error => console.error('[como-asi] delayed Buffer delivery recovery failed', error?.message || error));
      }, firstRecoveryDelayMs);
      firstRecovery.unref?.();
      console.info(`[como-asi] first Buffer delivery recovery scheduled after ${firstRecoveryDelayMs}ms cooldown`);
    } catch (error) {
      console.error('[como-asi] Buffer delivery recovery bootstrap failed', error?.message || error);
    }
  })();
}, 3000);
timer.unref?.();
