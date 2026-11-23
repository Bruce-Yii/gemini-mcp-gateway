/**
 * Compatibility shim: the implementation lives in src/client/oauth.js.
 * Import from the module path in new code; this file has no logic of its own.
 */
export * from './client/oauth.js';
export { default } from './client/oauth.js';
