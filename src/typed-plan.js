/**
 * Compatibility shim: the implementation lives in src/execution/typed-plan.js.
 * Import from the module path in new code; this file has no logic of its own.
 */
export * from './execution/typed-plan.js';
export { default } from './execution/typed-plan.js';
