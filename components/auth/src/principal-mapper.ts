// DefaultPrincipalMapper — the SINGLE writer of `platform.request.principal`.
// Strategies return
// values; only the mapper touches the request Context. Request-scoped so `bindPrincipal` binds into
// the live request context (injected via @inject.context()). Only the interface is specified; this
// impl is authored directly against it.
import {inject, injectable, BindingScope, type Context} from '@loopback/core';
import {
  type AuthenticatedIdentity,
  Principal,
  type PrincipalKind,
  type PrincipalId,
  type PrincipalMapper,
  type Scope,
  type TenantId,
} from '@hermes-one/contracts';
import {PlatformBindings} from '@hermes-one/loopback-core';

@injectable({scope: BindingScope.REQUEST})
export class DefaultPrincipalMapper implements PrincipalMapper {
  constructor(@inject.context() private readonly ctx: Context) {}

  bindPrincipal(id: AuthenticatedIdentity): Principal {
    const principal = id.principal;
    this.ctx.bind(PlatformBindings.REQUEST_PRINCIPAL.key).to(principal);
    return principal;
  }

  fromClaims(input: {
    subject: PrincipalId;
    tenantId: TenantId;
    kind: PrincipalKind;
    roles: string[];
    scopes: Scope[];
    attributes?: Record<string, string | number | boolean | null>;
  }): Principal {
    return Principal.parse({
      id: input.subject,
      tenantId: input.tenantId,
      kind: input.kind,
      roles: input.roles,
      scopes: input.scopes,
      attributes: input.attributes ?? {},
    });
  }
}
