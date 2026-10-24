// WhoamiController — a minimal AUTHENTICATED diagnostic route (`GET /v1/whoami`). NOT on the public
// allowlist, so the sequence's authentication slot must establish a principal first; it echoes the
// bound `platform.request.principal`. This proves the api-key strategy end-to-end and is a
// genuinely useful ops/debug endpoint (a "who am I" for a credential). The real admin controllers
// (tenant/role/definition/deployment) land later.
//
// Flagged: the admin API contract does not define a /whoami route; it's authored here as the smallest
// authenticated surface to exercise AUTH-3.
import {inject} from '@loopback/core';
import {get} from '@loopback/rest';
import {PlatformBindings} from '@hermes-one/loopback-core';
import type {Principal} from '@hermes-one/contracts';

export class WhoamiController {
  constructor(
    @inject(PlatformBindings.REQUEST_PRINCIPAL)
    private readonly principal: Principal,
  ) {}

  @get('/v1/whoami')
  whoami(): {
    principalId: string;
    tenantId: string;
    kind: string;
    scopes: string[];
  } {
    return {
      principalId: this.principal.id,
      tenantId: this.principal.tenantId,
      kind: this.principal.kind,
      scopes: this.principal.scopes,
    };
  }
}
