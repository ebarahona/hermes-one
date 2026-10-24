# hermes-one local infrastructure

One isolated Docker stack for all backing services, grouped under the
**`hermes-one`** Docker project (so it's one tidy group in Docker Desktop and
never collides with your other projects). Host ports are deliberately
non-default.

## Bring it up

```bash
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps      # all should be healthy
docker compose -f infra/docker-compose.yml down     # stop (add -v to wipe volumes)
```

## Services & ports

| Service             | Host port                          | Notes                                           |
| ------------------- | ---------------------------------- | ----------------------------------------------- |
| Temporal (gRPC)     | `127.0.0.1:7233`                   | durable orchestration (ADR-014)                 |
| Temporal UI         | http://localhost:8233              | workflow history / debugging                    |
| Postgres (platform) | `127.0.0.1:5433`                   | authoritative store (ADR-022) · `hermes/hermes` |
| Redis               | `127.0.0.1:6380`                   | ephemeral lanes (cache/idempotency/locks)       |
| Qdrant              | http://localhost:6333 (+6334 gRPC) | reserved for planned knowledge retrieval        |
| OTel collector      | `4317` (OTLP gRPC) · `4318` (HTTP) | telemetry pipeline (`otel-collector`)           |
| Temporal's Postgres | internal only                      | not exposed to the host                         |

Ports 5433/6380/8233 are chosen to sit beside a default 5432/6379/8080 you may
already run elsewhere.

## Verify Temporal end-to-end

Runs the deterministic missed-call workflow on the real local Temporal:

```bash
pnpm -r build
node apps/workflow-worker/dist/e2e.js
# ✅ PASS lines for the eligible, out-of-area, and answered cases
```

Or run the worker standalone (`node apps/workflow-worker/dist/worker.js`) and
submit workflows from your own client against `127.0.0.1:7233`, namespace
`default`, task queue `hermes-workflow`.
