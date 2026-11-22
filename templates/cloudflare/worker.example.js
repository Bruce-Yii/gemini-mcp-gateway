/**
 * SKETCH ONLY — NOT A WORKING WORKER (需开发).
 *
 * The current repository has no Cloudflare entrypoint. Today's code uses
 * Node http/fs/crypto, a Node-worker-thread QuickJS sandbox (`run`), and a
 * Vercel-specific `waitUntil` import; none of that runs in a Worker isolate.
 *
 * Target shape after adapters are developed:
 *   - runtime/waitUntil abstraction (ctx.waitUntil on Workers)
 *   - WebCrypto TokenStore or D1TokenStore with GETDEL/CAS parity
 *   - QuickJS WASM sandbox with the same host bridge as src/codemode.js
 *   - Request/Response router for OAuth metadata, /oauth/*, /mcp
 *
 * This file deliberately returns 501 so nobody mistakes it for a deployment.
 */
export default {
  async fetch(request, env, ctx) {
    void request;
    void env;
    void ctx;
    return new Response('Cloudflare Workers adapter is not implemented (需开发).', {
      status: 501,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
