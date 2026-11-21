/**
 * Build identity exposed by GET /healthz.
 *
 * A plain checkout reports the "dev" defaults below. The Vercel build runs
 * `scripts/write-build-info.mjs`, which rewrites this file with the real commit
 * and a hash of the runtime source files, so a deployed instance can be
 * compared with a local checkout by buildHash — no Vercel API token needed.
 */
export const BUILD = {
  commit: 'dev',
  buildHash: 'dev',
  pathHash: 'dev',
  files: [],
  builtAt: null,
};
