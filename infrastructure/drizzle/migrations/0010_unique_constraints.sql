-- One active deployment per tenant is a database invariant, not just an application check — the
-- "supersede then insert" publish transaction fails loudly on a race. Partial unique indexes are
-- hand-authored SQL (not expressible in the Drizzle table DSL). (compiled-plan-store.md, constraints.md)
CREATE UNIQUE INDEX deployments_tenant_active_uq ON substrate.deployments (tenant_id)
  WHERE status = 'active';
