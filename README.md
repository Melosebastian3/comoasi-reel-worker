# ¿Cómo Así? Reel Worker

Independent worker for the ¿Cómo Así? project.

## Isolation contract

This repository must never import, call, read, write or fall back to HISTYRA infrastructure. In particular it must not contain credentials, URLs, database IDs, Supabase refs, storage buckets, queues or runtime dependencies from HISTYRA.

## Stack

- Node.js 20+
- Express
- PostgreSQL 17 on the dedicated Neon project `como-asi`
- Schema: `comoasi`
- Railway deployment: dedicated ¿Cómo Así? service only
- Studio: dedicated AppDeploy app `como-asi-studio-jjokns`

## Core API

- `GET /health`
- `GET /isolation`
- `GET/POST /api/reels`
- `GET/POST /api/memory`
- `GET /api/radar/latest`
- `POST /api/radar/snapshots`
- `GET /api/learning`
- `POST/GET /api/jobs`
- `GET/POST /api/plans`
- `GET/POST /api/publisher/queue`

No HISTYRA fallback is permitted.

Deployment trigger: isolated Railway production service.
Deployment trigger 2: Railway GitHub access verified on 2026-09-11.
