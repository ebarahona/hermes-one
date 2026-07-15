// WhoamiController — a minimal AUTHENTICATED diagnostic route (`GET /v1/whoami`). NOT on the public
// allowlist, so the sequence's authentication slot must establish a principal first; it echoes the
// bound `platform.request.principal`. This proves the api-key strategy end-to-end (Slice 2) and is a
// genuinely useful ops/debug endpoint (a "who am I" for a credential). The real admin controllers
// (tenant/role/definition/deployment, api/admin-api.md) land in Slice 3+.
//
// JIT (flagged): admin-api.md does not define a /whoami route; it's authored here as the smallest
// authenticated surface to exercise AUTH-3.
import {inject} from '@loopback/core';
import {get} from '@loopback/rest';
import {PlatformBindings} from '@platform-internal/loopback-core';
import type {Principal} from '@platform/contracts';

export class WhoamiController {
  constructor(
    @inject(PlatformBindings.REQUEST_PRINCIPAL) private readonly principal: Principal,
  ) {}

  @get('/v1/whoami')
  whoami(): {principalId: string; tenantId: string; kind: string; scopes: string[]} {
    return {
      principalId: this.principal.id,
      tenantId: this.principal.tenantId,
      kind: this.principal.kind,
      scopes: this.principal.scopes,
    };
  }
}
