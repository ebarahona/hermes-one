# hermes-one local infrastructure

All the backing services run in one isolated Docker stack under the
`hermes-one` Docker project. It shows up as one group in Docker Desktop and
won't collide with your other projects. The host ports are non-default on
purpose.

## Bring it up

```bash
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps      # all should be healthy
docker compose -f infra/docker-compose.yml down     # stop (add -v to wipe volumes)
```

## Services and ports

| Service             | Host port                          | Notes                                           |
| ------------------- | ---------------------------------- | ----------------------------------------------- |
| Temporal (gRPC)     | `127.0.0.1:7233`                   | durable orchestration (ADR-014)                 |
| Temporal UI         | http://localhost:8233              | workflow history / debugging                    |
| Postgres (platform) | `127.0.0.1:5433`                   | authoritative store (ADR-022) · `hermes/hermes` |
| Redis               | `127.0.0.1:6380`                   | ephemeral lanes (cache/idempotency/locks)       |
| Qdrant              | http://localhost:6333 (+6334 gRPC) | reserved for planned knowledge retrieval        |
| OTel collector      | `4317` (OTLP gRPC) · `4318` (HTTP) | telemetry pipeline (`otel-collector`)           |
| Temporal's Postgres | internal only                      | not exposed to the host                         |

Ports 5433/6380/8233 were picked so they can run next to a default
5432/6379/8080 you may already have running.

## Verify Temporal end-to-end

This runs the deterministic missed-call workflow on your local Temporal:

```bash
pnpm -r build
node apps/workflow-worker/dist/e2e.js
# ✅ PASS lines for the eligible, out-of-area, and answered cases
```

You can also run the worker on its own (`node apps/workflow-worker/dist/worker.js`)
and submit workflows from your own client against `127.0.0.1:7233`, namespace
`default`, task queue `hermes-workflow`.
