-- Substrate reconciliation views — plain SELECTs over RLS-protected base tables.
-- security_invoker=true (PG15+) is MANDATORY: without it a view runs as its
-- owner and BYPASSES the base tables' RLS (cross-tenant leak). With it, RLS applies transparently as the
-- querying role (platform_app) + its app.tenant_id GUC — exactly as the catalog intends.
CREATE VIEW substrate.workflow_definitions WITH (security_invoker = true) AS
  SELECT * FROM substrate.definitions WHERE kind = 'workflow';

CREATE VIEW substrate.rule_definitions WITH (security_invoker = true) AS
  SELECT * FROM substrate.definitions WHERE kind = 'rule';

CREATE VIEW substrate.rule_versions WITH (security_invoker = true) AS
  SELECT dv.*
  FROM substrate.definition_versions dv
  JOIN substrate.definitions d ON d.definition_id = dv.definition_id
  WHERE d.kind = 'rule';

CREATE VIEW substrate.compiled_rule_plans WITH (security_invoker = true) AS
  SELECT * FROM substrate.compiled_plans WHERE kind = 'rule';

CREATE VIEW substrate.workflow_deployments WITH (security_invoker = true) AS
  SELECT dm.*, dep.tenant_id, dep.version AS deployment_version, dep.status AS deployment_status
  FROM substrate.deployment_members dm
  JOIN substrate.deployments dep ON dep.deployment_id = dm.deployment_id
  WHERE dm.kind = 'workflow';

CREATE VIEW substrate.rule_deployments WITH (security_invoker = true) AS
  SELECT dm.*, dep.tenant_id, dep.version AS deployment_version, dep.status AS deployment_status
  FROM substrate.deployment_members dm
  JOIN substrate.deployments dep ON dep.deployment_id = dm.deployment_id
  WHERE dm.kind = 'rule';

CREATE VIEW substrate.agent_engines WITH (security_invoker = true) AS
  SELECT d.definition_id, d.tenant_id, d.name, d.current_version, vc.content_hash,
         vc.contract_body -> 'body' ->> 'persona'            AS persona,
         vc.contract_body -> 'body' -> 'objectives'          AS objectives,
         vc.contract_body -> 'body' -> 'allowedCapabilities'  AS allowed_capabilities,
         vc.contract_body -> 'body' -> 'model'                AS model,
         vc.contract_body                                     AS contract_body,
         d.status, d.updated_at
  FROM substrate.definitions d
  JOIN substrate.definition_versions dv
    ON dv.definition_id = d.definition_id AND dv.version = d.current_version
  JOIN substrate.validated_contracts vc ON vc.content_hash = dv.content_hash
  WHERE d.kind = 'agent-engine';

CREATE VIEW substrate.capability_registrations WITH (security_invoker = true) AS
  SELECT d.definition_id, d.tenant_id, d.name AS capability_name, d.current_version, vc.content_hash,
         vc.contract_body ->> 'sideEffect'                    AS side_effect,
         (vc.contract_body ->> 'confirm')::boolean             AS confirm,
         vc.contract_body ->> 'requiredScope'                  AS required_scope,
         vc.contract_body -> 'changedDomains'                  AS changed_domains,
         vc.contract_body                                      AS contract_body,
         d.status, d.updated_at
  FROM substrate.definitions d
  JOIN substrate.definition_versions dv
    ON dv.definition_id = d.definition_id AND dv.version = d.current_version
  JOIN substrate.validated_contracts vc ON vc.content_hash = dv.content_hash
  WHERE d.kind = 'capability';

GRANT SELECT ON substrate.workflow_definitions TO platform_app;
GRANT SELECT ON substrate.rule_definitions TO platform_app;
GRANT SELECT ON substrate.rule_versions TO platform_app;
GRANT SELECT ON substrate.compiled_rule_plans TO platform_app;
GRANT SELECT ON substrate.workflow_deployments TO platform_app;
GRANT SELECT ON substrate.rule_deployments TO platform_app;
GRANT SELECT ON substrate.agent_engines TO platform_app;
GRANT SELECT ON substrate.capability_registrations TO platform_app;
