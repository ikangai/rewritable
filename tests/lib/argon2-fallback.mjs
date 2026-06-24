// jsdom has no Worker, so the seed's _argon2idHash cannot offload Argon2id to a blob:
// Worker. Since I9 makes new vaults default to kdf_version 1 (Argon2id), a fresh-vault
// unlock in jsdom needs the sync fallback `globalThis._argon2id`. This extracts the EXACT
// vendored bytes the seed ships (the `// rwa:argon2:begin/end ARGON2_SRC` region) and runs
// them synchronously, so jsdom vault tests exercise real Argon2id. The blob: Worker path
// itself is browser-verified separately (tests/skill-exec-probe.mjs). Input is the repo's
// own seed file (trusted) — the `new Function` calls evaluate vendored, not external, code.
export function extractArgon2(seedText) {
  const b = seedText.indexOf('// rwa:argon2:begin ARGON2_SRC');
  const e = seedText.indexOf('// rwa:argon2:end ARGON2_SRC');
  if (b < 0 || e < 0) throw new Error('ARGON2_SRC markers not found in seed');
  const region = seedText.slice(b, e).replace(/^\/\/ rwa:argon2:(begin|end).*$/gm, '');
  const ARGON2_SRC = new Function(region + '\n return ARGON2_SRC;')();
  const g = {}; new Function('globalThis', ARGON2_SRC)(g);
  const argon2id = g._argon2id;
  // realm-safe: the seed passes page-realm Uint8Arrays; copy them into this realm before
  // noble's byte checks (and copy any key/ad if a caller passes them).
  const forPage = (pw, salt, o) => argon2id(Uint8Array.from(pw), Uint8Array.from(salt),
    o && (o.key || o.ad) ? { ...o, key: o.key && Uint8Array.from(o.key), ad: o.ad && Uint8Array.from(o.ad) } : o);
  return { ARGON2_SRC, argon2id, forPage };
}
