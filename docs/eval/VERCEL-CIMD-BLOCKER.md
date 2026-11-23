# Vercel CIMD external acceptance — BLOCKED

Date: 2026-11-23 (Asia/Singapore)

## What was attempted

1. Local gateway CIMD at `https://samples-formula-insulation-sara.trycloudflare.com/.well-known/mcp-client.json` → 200 JSON.
2. Alias at `/oauth/client-metadata.json` → 200 JSON.
3. A public GitHub gist CIMD (HTTPS, public, JSON) with minimal required fields.
4. A known-good public CIMD from Notion (`https://www.notion.so/oauth/mcp-client-metadata.json`) as a control.

## Result

- Notion control reaches a different error: Vercel parses the CIMD and rejects the test `code_challenge` (too short), meaning **Vercel CIMD acceptance itself works**.
- Our gateway CIMD (local, alias, public gist) consistently gets:
  `App configuration error / Invalid client_id / The app ID is invalid`.
- Fields tried: `client_id`, `client_name`, `client_uri`, `redirect_uris`, `grant_types`, `response_types`, `token_endpoint_auth_method`, `token_endpoint_auth_methods_supported`, `code_challenge_methods_supported`, scope.
- Minimal variant (only client_id/client_name/client_uri/redirect_uris) also rejected.

## Conclusion

Not proven to be a gateway OAuth bug. Vercel CIMD validation rejects our metadata/identity independent of:
- local tunnel vs public gist,
- `.well-known` vs `/oauth/` path,
- full vs minimal metadata fields,
- refresh scope vs openid.

The current honest status is **Vercel upstream authorization BLOCKED** pending one of:
1. a Vercel-approved pre-registered client, or
2. a CIMD validator/requirement we have not reproduced, or
3. production-domain CIMD hosting (not testable while Vercel deploy quota is exhausted).

Do not tell the user Vercel auth is ready.
