# Changelog

## [0.2.1](https://github.com/ebarahona/hermes-one/compare/v0.2.0...v0.2.1) (2026-10-26)


### Bug Fixes

* **deps:** patch vulnerable transitive dependencies ([d0d9796](https://github.com/ebarahona/hermes-one/commit/d0d9796fcfa856a4c9fbf44e15aad136f35e914c))

## [0.2.0](https://github.com/ebarahona/hermes-one/compare/v0.1.2...v0.2.0) (2026-10-26)


### Features

* run the full platform with docker compose ([34726c8](https://github.com/ebarahona/hermes-one/commit/34726c893b7a5dd8242ad88685d3699be3cd7666))

## [0.1.2](https://github.com/ebarahona/hermes-one/compare/v0.1.1...v0.1.2) (2026-10-26)


### Dependencies

* **deps-dev:** bump @types/node ([#39](https://github.com/ebarahona/hermes-one/issues/39)) ([24919f5](https://github.com/ebarahona/hermes-one/commit/24919f5c3165854aeccefa10198a49176d4aad20))
* upgrade typescript to 6.0 ([35cb434](https://github.com/ebarahona/hermes-one/commit/35cb434f78b44d38343de78cbead73e04b549d7a))

## [0.1.1](https://github.com/ebarahona/hermes-one/compare/v0.1.0...v0.1.1) (2026-10-26)


### Dependencies

* **deps-dev:** bump prettier from 3.9.5 to 3.9.10 ([#28](https://github.com/ebarahona/hermes-one/issues/28)) ([d80752f](https://github.com/ebarahona/hermes-one/commit/d80752f8d34272c78a79a5f60b50ae957f1b389f))
* **deps:** bump drizzle-orm from 0.45.2 to 0.45.4 ([#23](https://github.com/ebarahona/hermes-one/issues/23)) ([84b148d](https://github.com/ebarahona/hermes-one/commit/84b148d62c9d9c9053a963aafbb90178387af265))
* **deps:** bump ioredis from 5.11.1 to 6.0.0 ([#29](https://github.com/ebarahona/hermes-one/issues/29)) ([ed3570b](https://github.com/ebarahona/hermes-one/commit/ed3570b33538dff7bfcc5dd211fc23d82c54f18f))
* **deps:** bump openai from 4.104.0 to 7.43.0 ([#25](https://github.com/ebarahona/hermes-one/issues/25)) ([43165f8](https://github.com/ebarahona/hermes-one/commit/43165f88eccdb243bce6905781a505db7a078fc3))
* **deps:** bump zod from 4.4.3 to 4.6.7 ([#27](https://github.com/ebarahona/hermes-one/issues/27)) ([75d23f2](https://github.com/ebarahona/hermes-one/commit/75d23f24ae6bf2a68fa51c162d21f628eb653bcd))
* upgrade agentback to 0.13 ([9e269aa](https://github.com/ebarahona/hermes-one/commit/9e269aa73dd311f08bd2c12a7c705e67bc653b15))

## 0.1.0 (2026-10-24)


### Features

* admin-api LB4 REST surface — bootable RestApplication + platform sequence (Slice 1) ([a2bcb0a](https://github.com/ebarahona/hermes-one/commit/a2bcb0a8ac52b6bd1e687079d49de278192918f1))
* **agent-worker:** use the pinned engine's model for its turns ([a02e242](https://github.com/ebarahona/hermes-one/commit/a02e242af2fad1e22c5907ee63945eb5a08e40af))
* atomic substrate writer — publish events ride the domain transaction (AU4, Phase 2b) ([20d04b0](https://github.com/ebarahona/hermes-one/commit/20d04b02ae6a4b2527b0b72f92589d9d987d04d9))
* AUTH-1 webhook hardening (timestamp, skew window, replay guard, SecretRef seam) ([9775c27](https://github.com/ebarahona/hermes-one/commit/9775c27b8779bf2d08e960cf2a0d070e19e56a10))
* AUTH-2 role→scope resolution + principal minted at the ingest edge ([05bd44a](https://github.com/ebarahona/hermes-one/commit/05bd44adc0130b138c2306fd6b0149fa9c8a419f))
* AUTH-3 api-key authentication wired into the REST sequence (Slice 2) ([a7f97a7](https://github.com/ebarahona/hermes-one/commit/a7f97a79be2bf06b47807bbbefe4395951062753))
* AUTH-3 oidc bearer-JWT authentication (Slice 4) ([9747d84](https://github.com/ebarahona/hermes-one/commit/9747d84264c063d5209408074851e8c4aa87f869))
* billing event fan-out — usage.record.recorded rides the atomic persist ([90f0c14](https://github.com/ebarahona/hermes-one/commit/90f0c140207a288ed7c4c6c589cf57f1e9f8bb8c))
* bounded post-gate repair + provider handoff routing (A2, PE6) — the turn acts on decisions it made ([b231d12](https://github.com/ebarahona/hermes-one/commit/b231d12667510a42ea7b2088c5f5a483effe778f))
* **contracts:** accept pack-declared changed domains ([d951c13](https://github.com/ebarahona/hermes-one/commit/d951c13b8863e5e159f14756bc5e0f71a142c7ec))
* definition authoring — PUT /v1/definitions/{id} + DefinitionRegistry binding (Slice 8) ([dedafd1](https://github.com/ebarahona/hermes-one/commit/dedafd1ddf57cc1a726e62a711caca15dbb9911e))
* deployment read controller + SubstrateComponent (Slice 6) ([46b7fd9](https://github.com/ebarahona/hermes-one/commit/46b7fd943e84bcbe7b70e4797d4b998429e9be7d))
* deployment writes — preview/publish/rollback (Slice 9) ([37c2c00](https://github.com/ebarahona/hermes-one/commit/37c2c0014852a6c3571e94b10b95e9f5e52c9b69))
* first datasource-backed admin route — GET /v1/tenants/{id}/roles (Slice 3) ([0a3da85](https://github.com/ebarahona/hermes-one/commit/0a3da859e17bbc0f2af8c6fbe3bcd130d055e63c))
* free the ProviderCredentialStore from the edge plane; credentials flow on both planes (S7, PE7, ADR-026/027/028) ([4769cf9](https://github.com/ebarahona/hermes-one/commit/4769cf9842f7cf2cb2db18e1e05b219162ba99c6))
* **gateway:** select the host workflow from the deployment and pass a channel-neutral input ([b767c81](https://github.com/ebarahona/hermes-one/commit/b767c816902cc1348aa56dc0a98e7f15c0971a6b))
* LB4 composition layer Phase 1 + activity-worker migration (resolves tension T1) ([2d3f4c6](https://github.com/ebarahona/hermes-one/commit/2d3f4c6eb8447cf6f8420bf44f8d35d99a607f04))
* LB4 Phase 2a — api-gateway + workflow-worker roots on the container; ChannelComponent ([7cadb42](https://github.com/ebarahona/hermes-one/commit/7cadb42b280ece381e5ed47025d5ef6ffc3734fa))
* OB6 — the real regression gate composed into publish; AUTH-4 blocked-upstream finding ([bc466ae](https://github.com/ebarahona/hermes-one/commit/bc466ae54befd14ef82944e8dab1877a462c2cd4))
* OTel distributed tracing (Tier 3.8 / OB5 — last telemetry pillar) ([bbc23b4](https://github.com/ebarahona/hermes-one/commit/bbc23b49a0e9c5859a95d86894ca055eaa51445c))
* Pack E — the electrician vertical installs from data (ADR-013) ([5c27f9a](https://github.com/ebarahona/hermes-one/commit/5c27f9af9be284b6b8b330fe0651ca3f40e5f74a))
* Pack E live turn — the electrician vertical runs end-to-end from data (Slice 2) ([3c270b2](https://github.com/ebarahona/hermes-one/commit/3c270b25e720ba620feec55ca44cd6abd1a65cfc))
* per-tenant envelope-encrypted provider credentials (ADR-026) — S1 closed, Phase 1 complete ([124142f](https://github.com/ebarahona/hermes-one/commit/124142fdf4795929f2221bdf15f1fa787ad81394))
* replay-stable turn time + audit tamper-reject (AU2, Phase 2a) ([e6f8c3f](https://github.com/ebarahona/hermes-one/commit/e6f8c3fb49b78e19604706ffa7944e9360744c4b))
* role create endpoint — POST /v1/tenants/{id}/roles (Slice 5) ([5e8a83b](https://github.com/ebarahona/hermes-one/commit/5e8a83b5d69f4ee955f5e8ea4b7097db4591fd18))
* tenant ids are text brands everywhere (CT1 resolved, migration 0028) ([2203cb9](https://github.com/ebarahona/hermes-one/commit/2203cb936b2b01ea7e865658a7ec91d59188dfbb))
* tenant provider-mapping overrides live on both planes; pack installs recorded; replay gate in CI (CT3, CT2, T6/ADR-029) ([32c58fd](https://github.com/ebarahona/hermes-one/commit/32c58fd30cfcd9cfef4072b64b0e12505e5ed862))
* tenant self-service controller — GET/PATCH /v1/tenants/{id} (Slice 7) ([2e15a3f](https://github.com/ebarahona/hermes-one/commit/2e15a3f2b218829e92791cdad246f93a17d79721))
* tenant.config.changed rides the tenant PATCH transaction (AU4 closed, Phase 2 complete) ([a88eea4](https://github.com/ebarahona/hermes-one/commit/a88eea405b498ff48f694b75f25ed1940046035c))
* tool-backed agent turns — project pinned capabilities onto the real provider plane (Pack E Slice 3) ([653d2b6](https://github.com/ebarahona/hermes-one/commit/653d2b63eb336ae5d8464b0fc8efee6c78e4238d))
* **tools:** add a mock LLM and run every e2e in CI ([68f1df3](https://github.com/ebarahona/hermes-one/commit/68f1df3a91d5a9bd58ad3e1c11858fd6586180e3))
* transactional-outbox publisher + RLS boot self-check at composition roots ([99839f6](https://github.com/ebarahona/hermes-one/commit/99839f6da1bba6dc60f01db6c8b6a0bdd6ad0553))
* user provisioning — POST/GET /v1/tenants/{id}/users (Slice 10) ([f96c4e2](https://github.com/ebarahona/hermes-one/commit/f96c4e2a7e51c49e11f4ffca1fd53b1e8c00d1e7))
* **verticals:** add support-ticket triage pack ([f2ecdb3](https://github.com/ebarahona/hermes-one/commit/f2ecdb341356c38b637615fe09912bec21db96ec))
* **workflow:** deliver agent replies on the customer's channel ([393194b](https://github.com/ebarahona/hermes-one/commit/393194b9becf4e18343615c98ad330c3301a5c57))


### Bug Fixes

* clear the cosmetic ledger tier — OB4 real fix + 6 by-design closes; remaining 6 relabeled as forward-references ([703ddfa](https://github.com/ebarahona/hermes-one/commit/703ddfa90b21d7f0acf9d246667090c4c8ea1395))
* close review findings in the capability tool projection ([5ca7233](https://github.com/ebarahona/hermes-one/commit/5ca7233dbc333b752320ce1d63921ea5fa4f2df8))
* **contracts:** reject unknown $agent bindings at compile time ([acc9bb7](https://github.com/ebarahona/hermes-one/commit/acc9bb7f89f3c5df0ea8b9f6dab51edd65bcd4ff))
* **electrician:** classify triage from the inbound message text ([596b240](https://github.com/ebarahona/hermes-one/commit/596b240e523d03c83cfa751b202b78b016e35ae7))
* enforce contract-schema validation and compile-time operator checks (D5, D6) ([06095a7](https://github.com/ebarahona/hermes-one/commit/06095a7df3003f15a561f8f785d3eab1a8a6d3ed))
* revert tool-output evidence stamping; real electrician triage; generalize the vertical installer ([fdd949a](https://github.com/ebarahona/hermes-one/commit/fdd949a6d10c5d138e052d7978b047b61e6d8606))
* scope tool idempotency keys to the turn, and record the serving provider ([f1b85b8](https://github.com/ebarahona/hermes-one/commit/f1b85b868259fe2336d6fe0ed67bdc91cf230e38))
* turn-scoped durable identity, handoff persistence, budgets, revocation, edge guards (A7, A4, A8, S8-S10, OB8, E4) ([b00c170](https://github.com/ebarahona/hermes-one/commit/b00c170314c3139e4e8d6ac34022fc660321b3c0))


### Dependencies

* **deps-dev:** bump the eslint group across 1 directory with 3 updates ([ebe9492](https://github.com/ebarahona/hermes-one/commit/ebe9492692799b0f38c4705a6783c9d16256fe06))
* **deps-dev:** bump tsx from 4.23.0 to 4.23.15 ([d859773](https://github.com/ebarahona/hermes-one/commit/d859773f48c0271bf7982916b21f3ca179846a26))
* **deps-dev:** bump vitest ([7c01659](https://github.com/ebarahona/hermes-one/commit/7c0165954f5bf3d8ae5c10b4ee9163ff532619d2))
* **deps:** bump jose from 6.2.3 to 6.2.13 ([fab64b9](https://github.com/ebarahona/hermes-one/commit/fab64b9defa0b6c67f62424f2fcf14195f09be74))
* **deps:** bump pg and @types/pg ([77a35a8](https://github.com/ebarahona/hermes-one/commit/77a35a81eac6813f1c4686520f35052147ae6ecc))
* **deps:** bump the loopback group across 1 directory with 3 updates ([f1576b1](https://github.com/ebarahona/hermes-one/commit/f1576b187fe344ac0c3f1cb262195ce2520839bb))
* **deps:** bump the opentelemetry group across 1 directory with 6 updates ([5a43565](https://github.com/ebarahona/hermes-one/commit/5a435654429255d6ed94b8d68cf6e34f6f819770))
* **deps:** bump the temporal group across 1 directory with 5 updates ([9216244](https://github.com/ebarahona/hermes-one/commit/92162442d5cd936935d1bf66818f4a84412db3cc))


### Documentation

* add AGENTS.md and code of conduct ([0230138](https://github.com/ebarahona/hermes-one/commit/0230138ed5c4602a22b75d990b1183518b7779c6))
* add security policy, contributing guide, and LLM configuration ([d39360c](https://github.com/ebarahona/hermes-one/commit/d39360c6d34bcec81d83ee440c785ef7633e2e32))
* architecture rationale + scope-ledger register pass ([0bdf1ee](https://github.com/ebarahona/hermes-one/commit/0bdf1eed1a25d768ebf479f5d5721dcbd68d0ae8))
* AU2 — audit integrityHash is not replay-stable (tamper-reject blocked on it) ([56e3cda](https://github.com/ebarahona/hermes-one/commit/56e3cdab87dc81e058480c8ab77e1f093b06c741))
* audience-focused register, 2026-07-22 hardening ledger, audit corrections ([5365807](https://github.com/ebarahona/hermes-one/commit/53658070a5675314ab73f3a3ecb8816f7485d826))
* BUILD-PLAN (5 phases from root causes) + ADRs 025-028 ratifying the four blockers ([e8f663b](https://github.com/ebarahona/hermes-one/commit/e8f663bfe555c91c2c7c11d114cf136dc28df222))
* BUILD-PLAN reflects zero-red state; CI header names the replay gate ([15c0c41](https://github.com/ebarahona/hermes-one/commit/15c0c411c776f7a81b8d13776b6a18d07be24152))
* checkpoint Pack E Slice 3 — tool-backed vertical, and the verification lesson ([d8f27bb](https://github.com/ebarahona/hermes-one/commit/d8f27bb4f9320e776d02959fd432a88a4caae555))
* checkpoint Phase 0+1 — README residuals, spec-doc supersession banners live via project docs ([39165ef](https://github.com/ebarahona/hermes-one/commit/39165efeb5f58e53bb461fd68981c0b5e3844945))
* client-ready framing — substrate validation report + a README that states what runs ([c962dfe](https://github.com/ebarahona/hermes-one/commit/c962dfe104bf51b450118324e5947adb91bdf5f5))
* edge authentication design (F1 / triage Audit 2) ([22c6d11](https://github.com/ebarahona/hermes-one/commit/22c6d11540a46c91ed96a153cb6ff809112e6465))
* fix broken table rows in authn design and ledger ([e443658](https://github.com/ebarahona/hermes-one/commit/e4436587e686e4dd5a122acc17f4f6ccaf587baf))
* **ledger:** record the vertical-agnostic inbound ingest (E6) ([698d8e7](https://github.com/ebarahona/hermes-one/commit/698d8e768741c19d4eea9f09e3b7a6cf0ab6d32f))
* make every document match the code ([74f4d93](https://github.com/ebarahona/hermes-one/commit/74f4d93d4ea2fa9d34ca7bc88fd15ae93dbd2406))
* mark minimal CI resolved in deferral ledger (I0) ([192457f](https://github.com/ebarahona/hermes-one/commit/192457f2dc9d20164ec7312c3f58b372f08d3c6f))
* prepare docs and comments for public readers ([d6a1d0d](https://github.com/ebarahona/hermes-one/commit/d6a1d0d0c066c81ca91dac1025f8de770b18d1d7))
* README section titles — Capabilities, Architecture ([6450aae](https://github.com/ebarahona/hermes-one/commit/6450aae875aa1bfa8ded24bad785b0c55d5aa347))
* record admin-api REST Slice 1 flags (L3/L3a/L3b/L3c) ([21b1461](https://github.com/ebarahona/hermes-one/commit/21b1461feee8305a96208611752d0326c3a3f001))
* record admin-api roles-route Slice 3 flags (L3d) ([0a85c65](https://github.com/ebarahona/hermes-one/commit/0a85c6567b454dee9b5734f9f3592b8e26c6db80))
* record AUTH-3 api-key Slice 2 flags (S3/S3a) ([e03e951](https://github.com/ebarahona/hermes-one/commit/e03e95164da35852ca8951b53b11160c7024e854))
* record AUTH-3 oidc bearer Slice 4 flags (S4) ([cc8f155](https://github.com/ebarahona/hermes-one/commit/cc8f155d8587690430606a1a46fc739c773e290d))
* record definition-authoring Slice 8 flags (L1/L1b) ([789d412](https://github.com/ebarahona/hermes-one/commit/789d4120805bf44a0ee3aa15e301100cc37f134e))
* record deployment-reads Slice 6 flags (L1 partial, L1a) ([2044e6c](https://github.com/ebarahona/hermes-one/commit/2044e6c245d91b12aa618250f1040e7a458f7a32))
* record deployment-writes Slice 9 flags (L1a resolved, L1b, L1c) ([67eb06b](https://github.com/ebarahona/hermes-one/commit/67eb06b3230de38e5a3ea693275636195e0a5719))
* record Pack E electrician-vertical Slice 1 (PE1) ([6513bff](https://github.com/ebarahona/hermes-one/commit/6513bffe47f022d6c86286c3789070e71c80a628))
* record Pack E live-turn Slice 2 (PE1) ([164cd41](https://github.com/ebarahona/hermes-one/commit/164cd41d0b4e9423dea3b70614749f7517041a68))
* record Pack E Slice 3 flags (PE2-PE5, V1 resolved) ([dc7da65](https://github.com/ebarahona/hermes-one/commit/dc7da65acdca1df4d9e871984fb551150b71ff00))
* record repo creation in deferral ledger (I0: CI still missing) ([d0fccb1](https://github.com/ebarahona/hermes-one/commit/d0fccb12bdebee6dee4f28736bfadc9144a3b571))
* record role-create Slice 5 flags (L3e) ([2bbebe2](https://github.com/ebarahona/hermes-one/commit/2bbebe2ddb2e2261a446af002d625c6465c7aba7))
* record tenant-controller Slice 7 flags (L1b) ([10fe2fc](https://github.com/ebarahona/hermes-one/commit/10fe2fc0ac6f0cb9545fef10e87da7495e82ae04))
* record user-provisioning Slice 10 flags (L1b) ([7cbd6fd](https://github.com/ebarahona/hermes-one/commit/7cbd6fde7b48ce1da31fb1f42523802fe8c04f7d))
* record workflow capability scope and failed reply delivery ([8b6f839](https://github.com/ebarahona/hermes-one/commit/8b6f8392c125f42cfdc0e2b9adb011ed3a1cbcbd))
* remove citations to documents not in the repository ([164844a](https://github.com/ebarahona/hermes-one/commit/164844acbcdb1785eefcebb2b3609fcdd0aa87c2))
* restore the original docs ([05826f5](https://github.com/ebarahona/hermes-one/commit/05826f5d5538d671274b1cbb799ac7bc2731ddb6))
* rewrite docs in a plain voice ([64bf8c1](https://github.com/ebarahona/hermes-one/commit/64bf8c1d7ae6dc27bc5b2215885188aaa005c2c2))
* S5/S6/S7 — the secrets seam is not buildable as specified ([74fd2eb](https://github.com/ebarahona/hermes-one/commit/74fd2eb50b410f32f1440bec008246096f41f007))
* update readme docs ([02bff30](https://github.com/ebarahona/hermes-one/commit/02bff3024b63eaad4acf240b2d44950a9b509d98))
* use American spelling in comments and test titles ([814c3b9](https://github.com/ebarahona/hermes-one/commit/814c3b99663b2f84fb85a457874977de03546828))
