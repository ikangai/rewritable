// Backend auth resolution for `rwa edit`. Extracted from bin/rwa.mjs so the
// precedence is unit-testable (the bin entrypoint runs on import and can't be
// imported cleanly).
//
// Only the openrouter backend needs a key — ollama and lmstudio run locally
// without auth. The key resolves in order: an explicit --api-key flag, then the
// project-specific RWA_OPENROUTER_KEY (env conventions match the docker-compose
// deploy in service/), then the CONVENTIONAL OPENROUTER_API_KEY that agents and
// users normally have exported. Empty strings count as absent.

/**
 * Resolve the API key for a backend.
 * @param {string} backendName — 'openrouter' | 'ollama' | 'lmstudio'
 * @param {string|undefined} flagValue — the --api-key flag value, if any
 * @param {Record<string,string|undefined>} [env] — environment (injectable for tests)
 * @returns {string|undefined} the key, or undefined when none applies
 */
export function resolveApiKey(backendName, flagValue, env = process.env) {
  if (flagValue) return flagValue;
  if (backendName === 'openrouter') {
    return env.RWA_OPENROUTER_KEY || env.OPENROUTER_API_KEY || undefined;
  }
  return undefined;
}
