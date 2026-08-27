// The CDP driver moved to `cli/src/cdp.mjs` (#38) when `rwa render` needed it:
// the CLI cannot import from `tests/` after `npm publish`, and vendoring a fifth
// byte-identical copy would have added drift surface for no benefit. One
// implementation, re-exported here so this lane's imports are unchanged.
export { launch, findChrome } from '../../cli/src/cdp.mjs';
