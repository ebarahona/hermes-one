// @platform-internal/config — infrastructure (none plane).
// Centralized, Zod-validated, env-driven configuration.

export {HermesConfig, loadConfig} from './config.js';
export {EnvSecretProvider, envVarNameFor} from './env-secret-provider.js';

export const descriptor = {
  name: '@platform-internal/config',
  role: 'infrastructure',
  plane: 'none',
  published: false,
  sourceDocs: ['17-deployment/179'],
  governedBy: [],
} as const;
