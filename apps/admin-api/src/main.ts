// admin-api process entrypoint. Identical shape to every other main.ts: hand the shared bootstrap()
// this process's CompositionRoot. reflect-metadata is imported first by bootstrap's module.
import {bootstrap} from '@platform-internal/loopback-core';
import {AdminApiRoot} from './root.js';

void bootstrap(cfg => new AdminApiRoot(cfg));
