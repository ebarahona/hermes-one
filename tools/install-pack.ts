// install-pack: install a vertical pack (verticals/*/pack.json) for a tenant through the admin API,
// then publish it as the tenant's active deployment. The same steps the admin pack itests take:
// author each definition with PUT /v1/definitions/{id}, pin the workflow's sibling refs by content
// hash, author the workflow last, then POST the manifest to /v1/deployments.
//
//   pnpm install-pack verticals/support/pack.json
//
// Env: HERMES_ADMIN_URL (default http://127.0.0.1:3001), HERMES_ADMIN_KEY and HERMES_TENANT (default
// the compose quickstart key and tenant, infra/quickstart.env).
import {readFileSync} from 'node:fs';

interface PackDef {
  definitionId: string;
  kind: string;
  name: string;
  schemaRef: string;
  version: string;
  body: unknown;
}
interface Pack {
  manifest: {packId: string; operatorRegistryVersion: string};
  definitions: {
    workflow: PackDef;
    agentEngine: PackDef;
    policy: PackDef;
    rules: PackDef[];
    capabilities: PackDef[];
  };
}
interface Authored {
  kind: string;
  definitionId: string;
  planId: string | null;
  version: string;
  contentHash: string;
}

const base = process.env.HERMES_ADMIN_URL ?? 'http://127.0.0.1:3001';
const key = process.env.HERMES_ADMIN_KEY ?? 'hermes-quickstart-admin-key';
const tenantId = process.env.HERMES_TENANT ?? 'tnt_quickstart';
const headers = {'x-api-key': key, 'content-type': 'application/json'};

async function call(method: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<Record<string, unknown>>;
}

async function author(d: PackDef): Promise<Authored> {
  const r = await call('PUT', `/v1/definitions/${d.definitionId}`, {
    tenantId,
    kind: d.kind,
    name: d.name,
    schemaRef: d.schemaRef,
    version: d.version,
    body: d.body,
  });
  console.log(`  ${d.kind.padEnd(14)} ${d.definitionId}@${d.version}`);
  return {
    kind: d.kind,
    definitionId: r.definitionId as string,
    planId: (r.planId as string | null) ?? null,
    version: r.version as string,
    contentHash: r.contentHash as string,
  };
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('usage: pnpm install-pack <path/to/pack.json>');
  const pack = JSON.parse(readFileSync(file, 'utf8')) as Pack;
  const d = pack.definitions;
  console.log(`Installing ${pack.manifest.packId} for ${tenantId} at ${base}`);

  // Siblings first: the workflow pins them by content hash.
  const agentEngine = await author(d.agentEngine);
  const policy = await author(d.policy);
  const rules: Authored[] = [];
  for (const r of d.rules) rules.push(await author(r));
  const capabilities: Authored[] = [];
  for (const c of d.capabilities) capabilities.push(await author(c));

  const hashOf = new Map(
    [agentEngine, policy, ...rules, ...capabilities].map(a => [
      a.definitionId,
      a.contentHash,
    ]),
  );
  const wf = structuredClone(d.workflow);
  const nodes = (wf.body as {nodes: Record<string, Record<string, unknown>>})
    .nodes;
  for (const node of Object.values(nodes)) {
    for (const field of ['rule', 'agentEngine', 'capability', 'workflow']) {
      const ref = node[field] as
        {definitionId?: string; contentHash?: string} | undefined;
      const hash = ref?.definitionId && hashOf.get(ref.definitionId);
      if (ref && hash) ref.contentHash = hash;
    }
  }
  const workflow = await author(wf);

  const dep = await call('POST', '/v1/deployments', {
    tenantId,
    workflow,
    agentEngine,
    policy,
    rules,
    capabilities,
    operatorRegistryVersion: pack.manifest.operatorRegistryVersion,
    notes: `${pack.manifest.packId} install`,
  });
  console.log(`Published deployment ${String(dep.deploymentId)} (active)`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
