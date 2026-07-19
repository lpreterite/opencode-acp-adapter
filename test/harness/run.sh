#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=== Building ==="
cd "$PROJECT_DIR"
npm run build --silent

echo "=== Starting mock server ==="
MARKER_FILE=$(mktemp)
export MOCK_MARKER_FILE="$MARKER_FILE"
npx tsx "$SCRIPT_DIR/mock-server.ts" 2>/dev/null &
MOCK_PID=$!

# Wait for mock server to write marker file
for i in $(seq 1 10); do
  MOCK_URL=$(cat "$MARKER_FILE" 2>/dev/null)
  if [ -n "$MOCK_URL" ]; then
    break
  fi
  sleep 0.5
done

if [ -z "$MOCK_URL" ]; then
  echo "Failed to start mock server"
  kill $MOCK_PID 2>/dev/null
  rm -f "$MARKER_FILE"
  exit 1
fi
echo "Mock server: $MOCK_URL (PID $MOCK_PID)"

echo ""
echo "=== Running harness client ==="
OPENCODE_URL="$MOCK_URL" npx tsx "$SCRIPT_DIR/harness-client.ts" 2>&1
HARNESS_EXIT=$?

echo ""
echo "=== Cleaning up ==="
kill $MOCK_PID 2>/dev/null
wait $MOCK_PID 2>/dev/null || true
rm -f "$MARKER_FILE"

echo "=== Acpx integration test ==="
echo ""
bash "$SCRIPT_DIR/acpx-harness.sh"
ACPX_EXIT=$?
echo ""
echo "acpx test exit code: $ACPX_EXIT"

echo ""
echo "=== Overall ==="
if [ "$HARNESS_EXIT" -eq 0 ] && [ "$ACPX_EXIT" -eq 0 ]; then
  echo "All harness tests passed"
  exit 0
else
  echo "Some harness tests failed"
  [ "$HARNESS_EXIT" -ne 0 ] && echo "  - SDK harness failed"
  [ "$ACPX_EXIT" -ne 0 ] && echo "  - acpx harness failed"
  exit 1
fi