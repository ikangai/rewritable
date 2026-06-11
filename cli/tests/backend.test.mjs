// Tests for backend auth resolution (cli/src/backend.mjs).
//
// `rwa edit` (openrouter backend) needs an API key. The key resolves from, in
// order: an explicit --api-key flag, then env. Historically only the
// project-specific RWA_OPENROUTER_KEY was honored; agents and users usually have
// the CONVENTIONAL OPENROUTER_API_KEY exported, so `rwa edit` failed with
// no_api_key even when a perfectly good key was in the environment. These tests
// pin the resolution order — flag > RWA_OPENROUTER_KEY > OPENROUTER_API_KEY — so
// the standard env var "just works" without clobbering the explicit precedence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiKey, envBaseUrl, backendMaxTokens } from '../src/backend.mjs';

test('explicit --api-key flag wins over everything', () => {
  assert.equal(
    resolveApiKey('openrouter', 'flag-key', { RWA_OPENROUTER_KEY: 'rwa-key', OPENROUTER_API_KEY: 'std-key' }),
    'flag-key',
  );
});

test('RWA_OPENROUTER_KEY is preferred over OPENROUTER_API_KEY', () => {
  // The project-specific var stays authoritative when both are set (a deploy may
  // export both; the rwa-scoped one is the intentional choice).
  assert.equal(
    resolveApiKey('openrouter', undefined, { RWA_OPENROUTER_KEY: 'rwa-key', OPENROUTER_API_KEY: 'std-key' }),
    'rwa-key',
  );
});

test('OPENROUTER_API_KEY is the fallback when RWA_OPENROUTER_KEY is unset', () => {
  // The whole point: the conventional env var makes `rwa edit` just work.
  assert.equal(
    resolveApiKey('openrouter', undefined, { OPENROUTER_API_KEY: 'std-key' }),
    'std-key',
  );
});

test('no key anywhere → undefined (so the caller can emit no_api_key)', () => {
  assert.equal(resolveApiKey('openrouter', undefined, {}), undefined);
});

test('empty-string env vars are treated as absent (not a usable key)', () => {
  assert.equal(resolveApiKey('openrouter', undefined, { RWA_OPENROUTER_KEY: '', OPENROUTER_API_KEY: '' }), undefined);
});

test('local backends (ollama/lmstudio/atomic) need no key → undefined regardless of env', () => {
  const env = { RWA_OPENROUTER_KEY: 'rwa-key', OPENROUTER_API_KEY: 'std-key' };
  assert.equal(resolveApiKey('ollama', undefined, env), undefined);
  assert.equal(resolveApiKey('lmstudio', undefined, env), undefined);
  assert.equal(resolveApiKey('atomic', undefined, env), undefined);
});

test('backendMaxTokens: 8192 for atomic (hard KV cap, server 400s past it), 32000 otherwise, RWA_MAX_TOKENS overrides', () => {
  assert.equal(backendMaxTokens('atomic', {}), 8192);
  assert.equal(backendMaxTokens('openrouter', {}), 32000);
  assert.equal(backendMaxTokens('ollama', {}), 32000);
  assert.equal(backendMaxTokens('atomic', { RWA_MAX_TOKENS: '4096' }), 4096);
  assert.equal(backendMaxTokens('atomic', { RWA_MAX_TOKENS: 'garbage' }), 8192, 'non-numeric override is ignored');
});

test('envBaseUrl: atomic defaults to 127.0.0.1:1337/v1, RWA_ATOMIC_URL overrides', () => {
  // Wrong/missing routing here would silently send `rwa edit --backend atomic`
  // to openrouter (the seed's resolveBackendConfig has the same trap) — the
  // base URL IS the privacy boundary for a deliberately-local backend.
  assert.equal(envBaseUrl('atomic', {}), 'http://127.0.0.1:1337/v1');
  assert.equal(envBaseUrl('atomic', { RWA_ATOMIC_URL: 'http://10.0.0.5:1337/v1' }), 'http://10.0.0.5:1337/v1');
});
