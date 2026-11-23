/**
 * Compatibility shim: the implementation lives in src/evidence/capture-queue.js.
 * Import from the module path in new code; this file has no logic of its own.
 */
export * from './evidence/capture-queue.js';
export { default } from './evidence/capture-queue.js';
