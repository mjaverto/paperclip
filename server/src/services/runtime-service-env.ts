import { SERVER_DATABASE_CREDENTIAL_ENV_KEYS } from "@paperclipai/adapter-utils/server-utils";

/**
 * Copy of `baseEnv` without the server's own database connection strings (any
 * key case) and nothing else, for commands that still need the other
 * PAPERCLIP_* workspace/runtime variables. Env a caller layers on afterwards
 * can set these keys again.
 */
export function omitServerDatabaseCredentialEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (SERVER_DATABASE_CREDENTIAL_ENV_KEYS.includes(key.toUpperCase())) delete env[key];
  }
  return env;
}

export function sanitizeRuntimeServiceBaseEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PAPERCLIP_")) {
      delete env[key];
    }
  }
  delete env.BETTER_AUTH_URL;
  delete env.BETTER_AUTH_BASE_URL;
  delete env.DATABASE_URL;
  delete env.DATABASE_MIGRATION_URL;
  delete env.npm_config_tailscale_auth;
  delete env.npm_config_authenticated_private;
  return env;
}
