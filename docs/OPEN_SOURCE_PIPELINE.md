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

`.github/workflows/produce-daily.yml` corre solo a mano (`workflow_dispatch`), sin horario
y sin publicar. Necesita el secreto `DATABASE_URL`. El horario y la publicación se activan
recién cuando el dueño autorice el autopiloto.
