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
import { resolveApiKey } from '../src/backend.mjs';

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

test('local backends (ollama/lmstudio) need no key → undefined regardless of env', () => {
  const env = { RWA_OPENROUTER_KEY: 'rwa-key', OPENROUTER_API_KEY: 'std-key' };
  assert.equal(resolveApiKey('ollama', undefined, env), undefined);
  assert.equal(resolveApiKey('lmstudio', undefined, env), undefined);
});
