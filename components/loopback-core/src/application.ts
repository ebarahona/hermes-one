// PlatformApplication — the edge-plane LB4 application class.
//
// Design notes (flagged, not improvised):
// - The component-registry design auto-registers all 12 edge components in the constructor, but
//   the bootstrap design's per-app matrix loads a DIFFERENT SUBSET per process (activity-worker
//   loads 6, api-gateway 4, …). The matrix is the operative wiring — so this class registers nothing
//   and each CompositionRoot registers its subset (registerComponents phase), exactly like the
//   bootstrap sequence prescribes.
// - Extends @loopback/core `Application`, not `RestApplication`: the REST surface
//   is the api-gateway/admin-api migration — no
//   process listens over LB4 REST yet. Swap the base class when that lands.
import {Application, type ApplicationConfig} from '@loopback/core';

export class PlatformApplication extends Application {
  constructor(options: ApplicationConfig = {}) {
    super(options);
  }
}
