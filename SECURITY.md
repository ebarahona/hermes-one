# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and
choose **Report a vulnerability**. Do not open a public issue for a security report.

Include the affected component, a description of the impact, and steps to reproduce. You will
receive an acknowledgment, and fixes are coordinated with the reporter before public disclosure.

## Supported versions

hermes-one is pre-1.0. Security fixes land on `main`; there are no maintained release branches yet.

## Security model

- **Tenant isolation** is enforced in PostgreSQL by row-level security on every tenant-scoped
  table. Every composition root runs an RLS posture check at boot and refuses to start under a
  role that can bypass RLS.
- **Edge authentication** fails closed: signed webhooks (timestamp in the signed material, replay
  nonces), API keys, and OIDC bearer tokens. See `docs/design/001-edge-authn-design.md`.
- **Tool calls** pass a policy gate before execution; side effects carry idempotency keys.
- **Tenant provider credentials** are envelope-encrypted per tenant (ADR-026) and support rotation
  and revocation.
- **Audit events** are append-only and tamper-evident.

## Deployment considerations

These are known boundaries of the current release. Each is tracked in
`docs/DEFERRED-AND-FLAGGED.md` under the listed ID.

| Area                    | Current behavior                                                                                                                                                                                    | Guidance                                                                                                                                                | Ledger |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Credential encryption   | `LocalAesGcmCipher` derives per-tenant subkeys from one master key (`HERMES_CREDENTIALS_MASTER_KEY`). Encryption goes through a cipher port, so a cloud KMS adapter plugs in without other changes. | Keep the master key in a secret manager, never in source control. For per-tenant customer-managed keys, implement a KMS cipher adapter behind the port. | S1a    |
| Secret resolution       | `EnvSecretProvider` resolves `secret://env/...` references from environment variables.                                                                                                              | Use it for local and single-host deployments; implement a `SecretProvider` for your secret manager in production.                                       | S1a    |
| Tool-call confirmations | agentback's `ConfirmationStore` contract is synchronous, so confirmations are held in process memory.                                                                                               | Run the agent worker as a single instance when using confirmation-gated tools.                                                                          | S0a    |
| Vendor circuit breaker  | The outbound SMS provider's circuit breaker is per process.                                                                                                                                         | Expect each worker instance to trip independently.                                                                                                      | —      |
| SMS idempotency         | Twilio accepts but does not honor an idempotency token.                                                                                                                                             | Non-idempotent sends run with `maximumAttempts: 1`; the workflow decides any retry.                                                                     | T4     |
