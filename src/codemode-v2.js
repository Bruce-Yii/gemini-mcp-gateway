/**
 * Compatibility shim: the implementation lives in src/execution/codemode-v2.js.
 * Import from the module path in new code; this file has no logic of its own.
 */
export * from './execution/codemode-v2.js';
export { default } from './execution/codemode-v2.js';
