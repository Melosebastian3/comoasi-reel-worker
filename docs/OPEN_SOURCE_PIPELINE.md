# Producción open source (sin AppDeploy)

`ENGINE_MODE=local` corre el motor editorial original de ¿Cómo Así? dentro del worker,
con los mismos prompts del Studio (`local/engine-local.js`, extraído de la rama
`migration/studio-without-appdeploy`). Solo cambia quién responde:

| Antes (AppDeploy)   | Ahora (open source, gratis)                                   |
|---------------------|---------------------------------------------------------------|
| `ai.generate`       | Cualquier servidor compatible OpenAI: Ollama / llama.cpp (Qwen2.5 7B) |
| `ai.imageGen`       | `scripts/imagegen.py` con LCM Dreamshaper v7 en CPU           |
| `ai.scrape`         | `fetch` + limpieza de HTML                                    |
| Storage de assets   | Disco (`LOCAL_ASSET_DIR`), URL pública opcional `PUBLIC_ASSET_BASE` |

## Variables

- `ENGINE_MODE=local`, `DATABASE_URL`
- `LLM_BASE_URL`, `LLM_MODEL`, `LLM_JSON_MODE` (`llamacpp` | `openai` | `prompt`), `LLM_API_KEY` opcional
- `IMAGE_BACKEND` (`diffusers` | `mock`), `IMAGE_MODEL`, `IMAGE_STEPS`, `IMAGE_WIDTH`, `IMAGE_HEIGHT`
- `TTS_BACKEND=espeak` solo para pruebas sin internet (producción usa edge-tts con es-MX-JorgeNeural)

## Lote diario

`node batch.js --date AAAA-MM-DD --count 3` crea un job por franja (08:00, 13:00, 20:30),
con la misma rotación de categorías de `metricool-automation.js`. Es idempotente por
fecha y franja: si se vuelve a correr, retoma el job o lo saltea si ya terminó.
No publica nada.

## Prueba local sin internet

```
psql "$DATABASE_URL" -f db/schema.sql   # solo para bases vacías
PORT=8089 node test/mock-llm.js &
ENGINE_MODE=local LLM_BASE_URL=http://127.0.0.1:8089/v1 IMAGE_BACKEND=mock TTS_BACKEND=espeak \
  node --import ./test/offline-fetch.js batch.js --count 1
```

## GitHub Actions

`.github/workflows/produce-daily.yml` corre todas las noches a las 00:30 de Buenos Aires
(autorizado por Sebastian el 2026-10-09): genera los 3 videos del día, los aloja como release
`media-<fecha>` y los programa en Buffer para 08:00, 13:00 y 20:30. A mano (`workflow_dispatch`)
no publica salvo que la variable del repo `PUBLISH_ENABLED` sea `true`. Necesita los secretos
`DATABASE_URL`, `KAGGLE_API_TOKEN`, `HF_TOKEN` y `BUFFER_API_KEY`.

## Generación en Kaggle (placa de video gratis)

El workflow ya no corre los modelos en GitHub. Hace esto:

1. `local/sync.js export-context` saca la memoria editorial de la base real (rama de prueba).
2. `kaggle/driver.py` sube el código y ese contexto como dataset privado de Kaggle y lanza
   `kaggle/kernel.py` en una GPU gratis.
3. El kernel levanta un Postgres descartable, Ollama (`qwen2.5:14b-instruct`) y
   `scripts/imagegen_server.py` (FLUX.1-schnell en 4 bits, con SDXL-Lightning de respaldo),
   corre `batch.js` y deja videos, portadas y `results.json`.
4. Actions descarga todo e importa las filas con `local/sync.js import-results`.

La clave de la base nunca sale de GitHub. Secretos: `DATABASE_URL`, `KAGGLE_API_TOKEN`
(o `KAGGLE_USERNAME` + `KAGGLE_KEY`). `KAGGLE_ACCELERATOR` es opcional.
