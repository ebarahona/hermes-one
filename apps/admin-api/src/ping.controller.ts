// PingController — the public liveness route. `/v1/healthz` is on the sequence's public allowlist
// (DEFAULT_PUBLIC_PATHS), so the fail-closed authentication slot lets it through with no principal.
// It proves the REST surface boots and the middleware chain runs end-to-end (Slice 1). Real admin
// controllers (tenant/role/definition/deployment) land in later slices.
import {get} from '@loopback/rest';

export class PingController {
  @get('/v1/healthz')
  healthz(): {status: 'ok'} {
    return {status: 'ok'};
  }
}
