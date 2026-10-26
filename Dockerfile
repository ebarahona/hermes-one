# One image for every Hermes process. The compose `app` profile (infra/docker-compose.yml) runs it
# once per process with a different command:
#
#   node apps/admin-api/dist/migrate.js         one-shot schema migration
#   node apps/admin-api/dist/main.js            admin control-plane API
#   node apps/api-gateway/dist/main.js          inbound webhook ingress
#   node apps/workflow-worker/dist/worker.js    Temporal workflow worker
#   node apps/activity-worker/dist/worker.js    Temporal activity worker
#   node apps/agent-worker/dist/worker.js       Temporal agent-turn worker
#
# The full workspace is kept in the image: the workflow worker bundles workflow code at startup.
FROM node:22-bookworm-slim

ENV CI=true PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm -r build

USER node
CMD ["node", "apps/admin-api/dist/main.js"]
