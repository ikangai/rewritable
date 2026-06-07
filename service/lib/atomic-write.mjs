// Crash-safe atomic file write for `rwa edit`. Write the new bytes to a sibling
// temp file, fsync (datasync) its contents, then rename(2) over the target —
// atomic on the same filesystem, so a reader sees either the old file or the new
// one, never a half-written stream. (datasync, not sync: a power loss between
// rename and the kernel flushing dirty pages could otherwise land a renamed file
// with stale/zero bytes; we don't depend on the temp's metadata being durable.)
//
// On ANY failure the temp file is removed. Previously a writeFile/datasync
// failure left a `.rwa-tmp-<pid>` behind — only the rename-failure path cleaned
// up. `deps` is injectable so the cleanup-on-failure is unit-testable without an
// actual disk failure.

import { open, rename, unlink } from 'node:fs/promises';

/**
 * @param {string} filePath — destination path (overwritten atomically)
 * @param {string} content — UTF-8 bytes to write
 * @param {{open:Function, rename:Function, unlink:Function}} [deps] — injectable fs ops
 */
export async function atomicWrite(filePath, content, deps = { open, rename, unlink }) {
  const tmp = `${filePath}.rwa-tmp-${process.pid}`;
  let handle;
  try {
    handle = await deps.open(tmp, 'w');
    await handle.writeFile(content, 'utf8');
    await handle.datasync();
    await handle.close();
    handle = null;
    await deps.rename(tmp, filePath);
  } catch (e) {
    // Close a still-open handle, then remove the temp so a failed write never
    // leaks a .rwa-tmp-<pid>. Cleanup errors are swallowed — the original
    // failure `e` is what the caller needs.
    if (handle) { try { await handle.close(); } catch { /* already failing */ } }
    await deps.unlink(tmp).catch(() => {});
    throw e;
  }
}
