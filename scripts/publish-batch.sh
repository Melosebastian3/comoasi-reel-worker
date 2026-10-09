#!/usr/bin/env bash
# Hosts a batch's videos as GitHub release assets (public repo = free public URLs Buffer can fetch)
# and hands the manifest to the Buffer publisher.
#   scripts/publish-batch.sh <out dir with manifest-DATE.json and reels/> <DATE>
# Dry run unless PUBLISH_ENABLED=true. Needs GH_TOKEN (contents: write) and BUFFER_API_KEY.
set -euo pipefail
OUT="$1"
DATE="$2"
REPO="${GITHUB_REPOSITORY:?}"
MANIFEST="$OUT/manifest-$DATE.json"
[ -f "$MANIFEST" ] || { echo "no manifest $MANIFEST"; exit 0; }
TAG="media-$DATE"

gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 || \
  gh release create "$TAG" --repo "$REPO" --title "Videos $DATE" --notes "Videos de ¿Cómo Así? para el $DATE (hosting para publicar)." --latest=false
node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const r of m.reels) if (r.status === "completed") console.log(`${r.slot} ${r.reelId}`);
' "$MANIFEST" | while read -r SLOT REEL; do
  SRC="$OUT/reels/$REEL/final.mp4"
  [ -f "$SRC" ] || { echo "missing $SRC"; continue; }
  cp "$SRC" "/tmp/$SLOT-$REEL.mp4"
  gh release upload "$TAG" "/tmp/$SLOT-$REEL.mp4" --repo "$REPO" --clobber
done

if [ -z "${BUFFER_API_KEY:-}" ]; then echo "BUFFER_API_KEY not set; videos hosted, nothing scheduled"; exit 0; fi
MODE=""
[ "${PUBLISH_ENABLED:-}" = "true" ] && MODE="--live"
node publish/buffer.js "$MANIFEST" --media-base "https://github.com/$REPO/releases/download/$TAG" $MODE
