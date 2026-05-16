#!/usr/bin/env bash
# Launch the REAL camel setup wizard in demo mode:
#   - Stubs Telegram token validation (any string works)
#   - Stubs OpenRouter model fetch (returns a curated list of ~10)
#   - Skips real bot startup + real pairing wait
#   - Uses a throwaway HOME so your real config is untouched
#
# Type whatever fake data you want — the wizard will accept it and animate
# through every step exactly like the real one. Perfect for screen recording.
#
# Usage:  ./demos/setup-demo.sh

set -e

# Throwaway home so the wizard sees a fresh state every run
DEMO_HOME="${DEMO_HOME:-/tmp/camelagi-demo}"
rm -rf "$DEMO_HOME"
mkdir -p "$DEMO_HOME"

# Resolve repo root (this script lives in demos/)
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Build if dist is missing
if [ ! -f "$REPO_ROOT/dist/cli.js" ]; then
  echo "Building CamelAGI..."
  (cd "$REPO_ROOT" && npm run build >/dev/null)
fi

echo ""
echo "  Demo mode — HOME=$DEMO_HOME"
echo "  Type ANY fake API key / bot token. Validation is stubbed."
echo "  Ctrl-C to abort."
echo ""
sleep 1.5

HOME="$DEMO_HOME" \
CAMELAGI_DEMO=1 \
  node "$REPO_ROOT/dist/cli.js" setup
