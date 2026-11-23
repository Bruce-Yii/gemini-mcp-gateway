/**
 * Compatibility shim: the implementation lives in src/shared/store.js.
 * Import from the module path in new code; this file has no logic of its own.
 */
export * from './shared/store.js';
export { default } from './shared/store.js';
