#!/usr/bin/env bash
# Capture golden replay fixtures (ADR-029).
# Runs the missed-call e2e, then exports each case's history via the Temporal CLI — the CLI's JSON is
# the proto3 form `historyFromJSON` accepts (the SDK's in-process historyToJSON chokes on some event
# fields in 1.20.2; the CLI export is the canonical interchange format). Commit the fixtures: the
# replay gate replays them against every candidate interpreter build in CI.
#
#   pnpm -r build && bash apps/workflow-worker/scripts/capture-replay-fixtures.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."

DIR="apps/workflow-worker/test/replay-fixtures/golden"
BUILD_ID="${TEMPORAL_WORKER_BUILD_ID:-workflow-worker@dev}"
STAMP=$(date +%s)
mkdir -p "$DIR"

echo "[capture] running the missed-call e2e..."
HERMES_OTEL_TRACES=off node apps/workflow-worker/dist/e2e.js >/dev/null

for CASE in eligible out-of-area answered; do
  WF_ID=$(docker exec hermes-one-temporal temporal workflow list --address temporal:7233 --namespace default \
    --query "WorkflowId STARTS_WITH 'missed-call-${CASE}-'" --limit 1 -o json \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['execution']['workflowId'])")
  docker exec hermes-one-temporal temporal workflow show --address temporal:7233 --namespace default \
    --workflow-id "$WF_ID" -o json \
    | python3 -c "
import json, sys
history = json.load(sys.stdin)
json.dump({
  'fixtureId': 'missed-call-${CASE}',
  'workflowType': 'runCompiledWorkflow',
  'capturedFromBuildId': '${BUILD_ID}',
  'tags': ['missed-call', '${CASE}', 'captured-${STAMP}'],
  'history': history,
}, open('${DIR}/missed-call-${CASE}.history.json', 'w'), indent=1)
"
  echo "[capture] ${DIR}/missed-call-${CASE}.history.json  (from ${WF_ID})"
done
echo "[capture] done — commit the fixtures; the replay gate enforces them in CI."
