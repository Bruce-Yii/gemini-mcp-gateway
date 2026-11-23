/**
 * Compatibility shim: the implementation lives in src/upstream/upstream-oauth.js.
 * Import from the module path in new code; this file has no logic of its own.
 */
export * from './upstream/upstream-oauth.js';
