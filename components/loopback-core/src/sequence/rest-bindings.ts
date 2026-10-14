// REST-surface-local binding keys (grammar `platform.<area>.<name>`).
// Kept out of the global PlatformBindings until they graduate past the admin-api slice.
import {BindingKey} from '@loopback/core';

/** Path prefixes that bypass the fail-closed authentication slot (default: health only). App-scoped. */
export const REST_PUBLIC_PATHS = BindingKey.create<readonly string[]>('platform.rest.public-paths');
