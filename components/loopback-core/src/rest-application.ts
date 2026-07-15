// PlatformRestApplication — the edge-plane LB4 REST host (loopback/application-bootstrap.md
// "Per-app bootstrap matrix": api-gateway/admin-api = `PlatformApplication (REST)`; and
// sequence-implementation.md, which mounts the platform middleware/interceptor chain on the
// RestApplication root).
//
// Spec deltas (flagged, not improvised):
// - The bootstrap doc keeps ONE class name `PlatformApplication` for both REST-listening and
//   non-listening edge apps ("Reuse one composition-root base; override serve()"). This repo
//   instead introduces a SEPARATE `PlatformRestApplication extends RestApplication` and leaves the
//   existing `PlatformApplication extends Application` untouched. Rationale: api-gateway (node:http
//   ingress, L3) and the Temporal workers already depend on the Application-based class and must NOT
//   drag @loopback/rest's RestComponent/http server. Convergence onto one class happens when
//   api-gateway migrates off node:http onto the LB4 REST surface. Recorded in Open Questions.
// - RestApplication already composes RestComponent + the middleware/interceptor registries the
//   sequence needs; no other mixin (Repository/Authentication/Authorization) is mounted — authn/authz
//   are platform REST middleware in the custom sequence (sequence-implementation.md §Architecture),
//   not the @loopback/authentication component.
import {type ApplicationConfig} from '@loopback/core';
import {RestApplication} from '@loopback/rest';

export class PlatformRestApplication extends RestApplication {
  constructor(options: ApplicationConfig = {}) {
    super(options);
  }
}
