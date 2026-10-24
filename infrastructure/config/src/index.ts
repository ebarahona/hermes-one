// @hermes-one/config — infrastructure (none plane).
// Centralized, Zod-validated, env-driven configuration.

export {HermesConfig, loadConfig} from './config.js';
export {EnvSecretProvider, envVarNameFor} from './env-secret-provider.js';

export const descriptor = {
  name: '@hermes-one/config',
  role: 'infrastructure',
  plane: 'none',
  published: false,
  governedBy: [],
} as const;
