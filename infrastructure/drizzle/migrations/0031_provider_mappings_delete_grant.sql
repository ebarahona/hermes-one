-- DELETE was omitted from 0023's grant, but the override API's DELETE /v1/tenants/{tenantId}/
-- capabilities/{name}/provider-mapping route (capability-and-provider-api.md ProviderMappingController)
-- reverts a tenant to the contract default by deleting the override row.
GRANT DELETE ON capability.provider_mappings TO platform_app;
