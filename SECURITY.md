# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repo's **Security** tab and choose
**Report a vulnerability**. Don't open a public issue for a security report.

Include the affected component, what the impact is, and steps to reproduce. You'll get an
acknowledgment, and we'll coordinate the fix with you before anything is disclosed publicly.

## Supported versions

hermes-one is pre-1.0. Security fixes land on `main`. There are no maintained release branches yet.

## Security model

- Tenant isolation is enforced in PostgreSQL by row-level security on every tenant-scoped table.
  Every composition root that opens a PostgreSQL pool checks its RLS setup first (the LoopBack roots
  at boot, the agent worker before its first turn). If the role can bypass RLS, it refuses to run.
- Edge authentication fails closed. It supports signed webhooks (the timestamp is part of the signed
  material, and replay nonces are checked), API keys, and OIDC bearer tokens. See
  `docs/design/001-edge-authn-design.md`.
- Agent tool calls are limited to the capabilities the principal's scopes allow, and each one passes
  a policy pre-gate before it runs. Capabilities a workflow invokes directly are not scope-checked
  (see E7 below). Side effects carry idempotency keys.
- Tenant provider credentials are envelope-encrypted per tenant (ADR-026) and support rotation and
  revocation.
- Audit events are append-only and tamper-evident. Each one carries an integrity hash, and rewriting
  an existing event is refused.

## Deployment considerations

These are known limits of the current release. Each one is tracked in `docs/DEFERRED-AND-FLAGGED.md`
under the listed ID.

| Area                      | Current behavior                                                                                                                                                                                           | Guidance                                                                                                                                                          | Ledger |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Credential encryption     | `LocalAesGcmCipher` derives per-tenant subkeys from one master key (`HERMES_CREDENTIALS_MASTER_KEY`). Encryption goes through a cipher port, so you can plug in a cloud KMS adapter without other changes. | Keep the master key in a secret manager, and keep it out of source control. For per-tenant customer-managed keys, implement a KMS cipher adapter behind the port. | S1a    |
| Secret resolution         | `EnvSecretProvider` resolves `secret://env/...` references from environment variables.                                                                                                                     | Use it for local and single-host deployments. In production, implement a `SecretProvider` for your secret manager.                                                | S1a    |
| Tool-call confirmations   | agentback's `ConfirmationStore` contract is synchronous, so confirmations are held in process memory.                                                                                                      | Run the agent worker as a single instance if you use confirmation-gated tools.                                                                                    | S0a    |
| Vendor circuit breaker    | The outbound SMS provider's circuit breaker is per process.                                                                                                                                                | Expect each worker instance to trip on its own.                                                                                                                   | None   |
| Workflow capability scope | Capabilities a workflow invokes directly (capability nodes, agent reply delivery) are not checked against the principal's scopes. Agent tool calls are.                                                    | Treat pack authors as trusted, and review packs before you install them for a tenant. Agent reply text passes the post-gate before delivery.                      | E7     |
| SMS idempotency           | Twilio accepts an idempotency token but does not honor it.                                                                                                                                                 | Non-idempotent sends run with `maximumAttempts: 1`, and the workflow decides whether to retry.                                                                    | T4     |
