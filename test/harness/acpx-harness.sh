#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=== Building ==="
cd "$PROJECT_DIR"
npm run build --silent

echo "=== Starting mock OpenCode server ==="
MARKER_FILE=$(mktemp)
export MOCK_MARKER_FILE="$MARKER_FILE"
npx tsx "$SCRIPT_DIR/mock-server.ts" > /dev/null 2>&1 &
MOCK_PID=$!

MOCK_URL=""
for i in $(seq 1 10); do
  MOCK_URL=$(cat "$MARKER_FILE" 2>/dev/null)
  if [ -n "$MOCK_URL" ]; then
    break
  fi
  sleep 0.3
done

if [ -z "$MOCK_URL" ]; then
  echo "FAILED: Mock server did not start"
  kill $MOCK_PID 2>/dev/null
  rm -f "$MOCK_OUTPUT"
  exit 1
fi
echo "Mock server: $MOCK_URL (PID $MOCK_PID)"

echo ""
echo "=== Running acpx integration test ==="
ACPX_OUTPUT=$(mktemp)
ACPX_EXIT=0
OPENCODE_URL="$MOCK_URL" OPENCODE=1 \
  acpx --agent 'node dist/index.js' --format json --approve-all --no-terminal exec "hello" \
  > "$ACPX_OUTPUT" 2>/dev/null || ACPX_EXIT=$?

echo ""
echo "=== acpx output ==="
cat "$ACPX_OUTPUT"

echo ""
echo "=== Validating output ==="

PASSED=0
TOTAL=0
ERRORS=""

check_line() {
  local linenum=$1
  local desc=$2
  local condition=$3
  TOTAL=$((TOTAL + 1))
  local line
  line=$(sed -n "${linenum}p" "$ACPX_OUTPUT" 2>/dev/null)
  if echo "$line" | jq -e "$condition" >/dev/null 2>&1; then
    echo "  ✓ $desc"
    PASSED=$((PASSED + 1))
  else
    echo "  ✗ $desc"
    ERRORS="${ERRORS}Line ${linenum}: ${desc} failed (expected jq: ${condition})\n"
  fi
}

# Line 1: initialize request
check_line 1 "initialize request" \
  'select(.method == "initialize") | .id == 0'

# Line 2: initialize response
check_line 2 "initialize response" \
  'select(.result.protocolVersion == 1) | .id == 0'

# Line 3: session/new request
check_line 3 "session/new request (with mcpServers)" \
  'select(.method == "session/new") | .params.mcpServers | length == 0'

# Line 4: session/new response (has sessionId)
check_line 4 "session/new response (has sessionId)" \
  'select(.result.sessionId) | .result.sessionId | length > 0'

# Line 5: session/prompt request
check_line 5 "session/prompt request" \
  'select(.method == "session/prompt") | .params.prompt | length > 0'

# Line 6: session/prompt response (end_turn)
check_line 6 "session/prompt response (end_turn)" \
  'select(.result.stopReason == "end_turn")'

echo ""
echo "=== Summary ==="
echo "  ${PASSED}/${TOTAL} passed"

if [ -n "$ERRORS" ]; then
  echo ""
  echo "Errors:"
  echo -e "$ERRORS"
fi

echo ""
echo "=== Cleaning up ==="
kill $MOCK_PID 2>/dev/null
wait $MOCK_PID 2>/dev/null || true
rm -f "$MARKER_FILE" "$ACPX_OUTPUT"

if [ "$PASSED" -ne "$TOTAL" ]; then
  exit 1
fi
exit 0