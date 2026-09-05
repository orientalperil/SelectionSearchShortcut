#!/usr/bin/env bash
# Zips src/ into dist/*.zip for Chrome/Edge and Firefox.
#
# The manifest is shared between both targets (background declares both
# service_worker and scripts, so each browser just uses the key it
# understands), so both zips currently have identical contents. Kept as two
# separate outputs so store-specific divergence is cheap to add later.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/src"
DIST_DIR="$ROOT_DIR/dist"

VERSION="$(node -e "console.log(require('$SRC_DIR/manifest.json').version)")"
NAME="selection-search-shortcut"

mkdir -p "$DIST_DIR"
rm -f "$DIST_DIR/$NAME-chrome-$VERSION.zip" "$DIST_DIR/$NAME-firefox-$VERSION.zip"

cd "$SRC_DIR"
zip -r -q -X "$DIST_DIR/$NAME-chrome-$VERSION.zip" . -x '*.DS_Store'
zip -r -q -X "$DIST_DIR/$NAME-firefox-$VERSION.zip" . -x '*.DS_Store'
cd "$ROOT_DIR"

echo "Built:"
echo "  $DIST_DIR/$NAME-chrome-$VERSION.zip"
echo "  $DIST_DIR/$NAME-firefox-$VERSION.zip"
