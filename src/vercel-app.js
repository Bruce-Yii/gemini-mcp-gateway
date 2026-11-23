/**
 * Compatibility shim: the implementation lives in src/runtime/vercel-app.js.
 * Import from the module path in new code; this file has no logic of its own.
 */
export * from './runtime/vercel-app.js';
export { default } from './runtime/vercel-app.js';
