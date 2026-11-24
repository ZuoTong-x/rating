#!/usr/bin/env bash
#
# macOS / Linux replacement for scripts/package-release.ps1.
#
# Builds the same release whitelist into a timestamped zip:
#   release/image-rating-platform-release-<yyyyMMdd-HHmmss>.zip
#
# Usage:
#   scripts/package-release.sh [output-directory]
#
# The output directory is resolved relative to the project root unless it is
# absolute, and must stay inside the project root (same guard as the PowerShell
# version). The zip contains the release items at its root (no extra folder).

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
PROJECT_ROOT=$(cd "$SCRIPT_DIR/.." && pwd -P)

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  cat <<'EOF'
Usage: scripts/package-release.sh [output-directory]

Builds the release whitelist into:
  <output-directory>/image-rating-platform-release-<yyyyMMdd-HHmmss>.zip

The output directory defaults to "release" under the project root and must
stay inside the project root. The zip contains the release items at its root,
with no extra top-level folder.
EOF
  exit 0
fi

OUTPUT_DIR=${1:-release}

case "$OUTPUT_DIR" in
  /*) RELEASE_ROOT=$OUTPUT_DIR ;;
  *)  RELEASE_ROOT=$PROJECT_ROOT/$OUTPUT_DIR ;;
esac

# Create first, then resolve so that ".." and symlinks cannot escape the check.
mkdir -p "$RELEASE_ROOT"
RELEASE_ROOT=$(cd "$RELEASE_ROOT" && pwd -P)

if [ "$RELEASE_ROOT" != "$PROJECT_ROOT" ]; then
  case "$RELEASE_ROOT/" in
    "$PROJECT_ROOT"/*) ;;
    *)
      echo "Refusing to operate outside the project directory: $RELEASE_ROOT" >&2
      exit 1
      ;;
  esac
fi

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
STAGING_ROOT="$RELEASE_ROOT/.staging-$TIMESTAMP"
ZIP_PATH="$RELEASE_ROOT/image-rating-platform-release-$TIMESTAMP.zip"

cleanup() {
  rm -rf "$STAGING_ROOT"
}
trap cleanup EXIT

rm -rf "$STAGING_ROOT"
mkdir -p "$STAGING_ROOT"

# Keep this list in sync with $releaseItems in scripts/package-release.ps1.
RELEASE_ITEMS=(
  '.env'
  '.dockerignore'
  'README.md'
  'DEPLOY.md'
  'docker-compose.yml'
  'deploy'
  'package.json'
  'docs'
  'server/Dockerfile'
  'server/package.json'
  'server/package-lock.json'
  'server/tsconfig.json'
  'server/src'
  'client/Dockerfile'
  'client/nginx.conf'
  'client/index.html'
  'client/package.json'
  'client/package-lock.json'
  'client/vite.config.ts'
  'client/tsconfig.json'
  'client/src'
)

for relative_path in "${RELEASE_ITEMS[@]}"; do
  source_path="$PROJECT_ROOT/$relative_path"
  target_path="$STAGING_ROOT/$relative_path"

  if [ ! -e "$source_path" ]; then
    echo "Required release item is missing: $relative_path" >&2
    exit 1
  fi

  if [ -d "$source_path" ]; then
    mkdir -p "$target_path"
    # "$source"/. also copies dotfiles, matching Copy-Item -Force -Recurse.
    cp -R "$source_path"/. "$target_path"/
  else
    mkdir -p "$(dirname "$target_path")"
    cp -p "$source_path" "$target_path"
  fi
done

if [ -z "$(ls -A "$STAGING_ROOT")" ]; then
  echo "No release files were collected" >&2
  exit 1
fi

rm -f "$ZIP_PATH"
# Zip the staging contents so the archive root is .env / deploy / server / ...
# dotglob makes the top-level glob include hidden entries explicitly, rather
# than relying on zip's handling of ".". Both work with Apple's zip, but this
# keeps the intent obvious and lets us assert the hidden entries are present.
(
  cd "$STAGING_ROOT"
  shopt -s dotglob nullglob
  archive_entries=(*)
  if [ "${#archive_entries[@]}" -eq 0 ]; then
    echo "No release files were collected" >&2
    exit 1
  fi
  zip -q -r -9 "$ZIP_PATH" "${archive_entries[@]}"
)

if [ ! -f "$ZIP_PATH" ]; then
  echo "Failed to create the release archive: $ZIP_PATH" >&2
  exit 1
fi

# Hidden entries such as .env are easy to lose (or to overlook in Finder).
archive_list=$(unzip -Z1 "$ZIP_PATH")
for hidden_entry in '.env' '.dockerignore'; do
  if ! grep -qxE "(\./)?${hidden_entry//./\\.}" <<< "$archive_list"; then
    echo "The release archive is missing hidden entry: $hidden_entry" >&2
    exit 1
  fi
done

BYTES=$(wc -c < "$ZIP_PATH" | tr -d ' ')
MEGABYTES=$(awk -v bytes="$BYTES" 'BEGIN { printf "%.2f", bytes / 1048576 }')

echo
echo "Release package created:"
echo "  $ZIP_PATH"
echo "  Size: $MEGABYTES MB"
