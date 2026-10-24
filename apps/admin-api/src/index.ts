// @hermes-one/admin-api — app (edge plane). The LB4 REST admin surface (RestApplication +
// the platform sequence, admin API controllers). Slice 1: the bootable surface + public
// /v1/healthz; auth strategies and real admin controllers layer in next.
export const descriptor = {
  name: '@hermes-one/admin-api',
  role: 'app',
  plane: 'edge',
  published: false,
  governedBy: ['ADR-017', 'ADR-022'],
} as const;

export {AdminApiRoot} from './root.js';
export {PingController} from './ping.controller.js';
