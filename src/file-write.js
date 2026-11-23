/**
 * Compatibility shim: the implementation lives in src/execution/file-write.js.
 * Import from the module path in new code; this file has no logic of its own.
 */
export * from './execution/file-write.js';
export { default } from './execution/file-write.js';
