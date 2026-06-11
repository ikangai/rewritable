// Backend auth resolution for `rwa edit`. Extracted from bin/rwa.mjs so the
// precedence is unit-testable (the bin entrypoint runs on import and can't be
// imported cleanly).
//
// Only the openrouter backend needs a key — ollama, lmstudio, and atomic run
// locally without auth. The key resolves in order: an explicit --api-key flag, then the
// project-specific RWA_OPENROUTER_KEY (env conventions match the docker-compose
// deploy in service/), then the CONVENTIONAL OPENROUTER_API_KEY that agents and
// users normally have exported. Empty strings count as absent.

/**
 * Resolve the API key for a backend.
 * @param {string} backendName — 'openrouter' | 'ollama' | 'lmstudio' | 'atomic'
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

/**
 * Default OpenAI-compatible base URL for a backend — mirrors the inline
 * `envBaseUrl` in bin/rwa.mjs (and seeds/rewritable.html resolveBackendConfig).
 * ollama, lmstudio, and atomic honor RWA_*_URL overrides (remote host / non-standard
 * port); openrouter is fixed (the URL has never drifted in the seed). Shared by `rwa edit`
 * and `rwa create` so the default never diverges between the two.
 * @param {string} name — 'openrouter' | 'ollama' | 'lmstudio' | 'atomic'
 * @param {Record<string,string|undefined>} [env] — environment (injectable for tests)
 * @returns {string|undefined}
 */
export function envBaseUrl(name, env = process.env) {
  switch (name) {
    case 'openrouter': return 'https://openrouter.ai/api/v1';
    case 'ollama':     return env.RWA_OLLAMA_URL || 'http://localhost:11434/v1';
    case 'lmstudio':   return env.RWA_LMSTUDIO_URL || 'http://localhost:1234/v1';
    case 'atomic':     return env.RWA_ATOMIC_URL || 'http://127.0.0.1:1337/v1';
    default:           return undefined;
  }
}

/**
 * Per-backend max_tokens for the agent loop. The historical 32000 stands for
 * hosted/clamping backends, but atomic.chat REJECTS (400) any request whose
 * prompt + max generation exceeds its MAX_KV_SIZE (16384 by default) rather
 * than clamping — so it gets 8192, leaving the other half of the window for
 * the system prompt + document. RWA_MAX_TOKENS overrides for unusual servers.
 * Mirrors the seed's resolveBackendConfig() maxTokens.
 * @param {string} name — backend name
 * @param {Record<string,string|undefined>} [env]
 * @returns {number}
 */
export function backendMaxTokens(name, env = process.env) {
  const override = Number(env.RWA_MAX_TOKENS);
  if (Number.isFinite(override) && override > 0) return override;
  return name === 'atomic' ? 8192 : 32000;
}
