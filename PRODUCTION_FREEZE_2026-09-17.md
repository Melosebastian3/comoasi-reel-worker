# ¿Cómo Así? production freeze — 2026-09-17

Frozen after successful Metricool OAuth reauthorization and authoritative brand validation.

## Production identity
- Metricool brand: `comoasi.media`
- Metricool Brand ID: `6756817`
- Networks: Instagram, TikTok, YouTube
- Timezone: `America/Buenos_Aires`
- Schedule: `08:00`, `13:00`, `20:30`
- Provider order: `metricool -> buffer -> upload-post`

## Verified health
- `brandAccessOk=true`
- `brandAccessError=null`
- Authoritative worker check: `accessible=true`, `brandId=6756817`
- Railway production deployment: `771c5035-428b-4cdb-9fe4-ddf1cf4bb12a`
- Railway source commit: `54236b30e955ff28f19a77f8a18a9f9f2ebdd01d`
- Railway snapshot: `21f31532-0586-4b99-91cb-17958078dc89`
- AppDeploy app: `como-asi-studio-jjokns`
- AppDeploy frozen version: `v100` / `1789646954026`
- Neon production branch: `br-holy-mode-acipbdld`
- Neon freeze rollback branch: `br-lively-pond-ac7xj7vt`
- Neon freeze parent LSN: `0/5CD8FB8`

## Rollback
### Worker
Redeploy Railway deployment `771c5035-428b-4cdb-9fe4-ddf1cf4bb12a` or source commit `54236b30e955ff28f19a77f8a18a9f9f2ebdd01d`.

### AppDeploy
Apply AppDeploy version `1789646954026` (`v100`).

### Database
Use Neon branch `br-lively-pond-ac7xj7vt` (`freeze-2026-09-17-metricool-v100`) as the frozen data point. Do not replace production automatically; inspect/reconcile before any restore.

## Notes
Historical failed Metricool attempts against Blog ID `6987068` remain as audit history only. They are not active reservations. Current authoritative brand is `6756817`.

The 08:00 and 13:00 posts for 2026-09-17 were already routed through Buffer before reauthorization. They must not be recreated in Metricool because that would risk duplicates. The 20:30 slot remains on the normal autonomous path and will attempt Metricool first using the corrected brand.
