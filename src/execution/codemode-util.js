/**
 * Thin stable wrapper around Cloudflare's @cloudflare/codemode utilities (MIT).
 *
 * We import the built ESM utility chunk by absolute path, not the package main
 * entry: the main entry pulls in `cloudflare:workers`, which fails under Node.
 * The utility chunk has no Cloudflare runtime dependency. Exports there are
 * minified to single letters; this mapping comes from the package's own
 * dist/index.js import list and is pinned to @cloudflare/codemode@0.5.6.
 * On SDK upgrade, re-check dist/index.js first lines to confirm the mapping.
 */
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
// Resolve main entry (exported), then walk up to the package root's dist dir.
const mainEntry = require.resolve('@cloudflare/codemode');
const pkgRoot = dirname(dirname(mainEntry)); // node_modules/@cloudflare/codemode/dist/index.js -> package root
const utilChunk = new URL('./dist/json-schema-types-D_m9tVnI.js', pathToFileURL(pkgRoot + '/')).href;
const m = await import(utilChunk);

// minified export map (0.5.6): s=normalizeCode, a=sanitizeToolName, t=generateTypesFromJsonSchema
export const normalizeCode = (code) => m.s(String(code ?? ''));
export const sanitizeToolName = (name) => m.a(String(name ?? ''));
export const generateTypesFromJsonSchema = (tools) => m.t(tools);
