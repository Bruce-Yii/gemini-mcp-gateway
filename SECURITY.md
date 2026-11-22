# Security Policy

## Supported versions

This project is pre-1.0. Security fixes are applied to the latest commit on
`main`; there is no backport policy for older commits yet.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Use GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability**. If that is unavailable, open a minimal
issue asking for a private channel and do not include exploit details.

Include: affected file/version, reproduction steps, impact, and any suggested
fix. Reports are triaged on a best-effort basis.

## Threat model (read before deploying)

This gateway holds **real upstream credentials** (e.g. GitHub, Notion, Linear,
Vercel) and executes model-written JavaScript. Treat a deployment as a
**single-user service**:

- **The deployment is you.** Anyone who can obtain a gateway access token can
  act as you on every connected upstream, including write operations. Do not
  share one deployment between users.
- **Lock the OAuth client.** Set `ALLOWED_CLIENT_ID` (and ideally
  `ALLOWED_CLIENT_SECRET`) in production. Without it, dynamic client
  registration is open to the internet; the redirect allowlist limits abuse but
  does not make a public deployment safe.
- **Never commit secrets.** Upstream tokens and KV credentials are read from
  environment variables only; `.env` files are git-ignored; logs must not print
  token values.
- **The sandbox is isolation, not authorization.** Model code runs in a QuickJS
  worker with no host `require`/`fetch`/`process`, but every callable tool uses
  the credentials the gateway was given. Write tools are only as safe as the
  upstream token's permissions. Use least-privilege upstream tokens.
- **Tool output is untrusted input.** A GitHub issue, Notion page or upstream
  error can contain prompt-injection text. Keep `execute_read`/`execute`
  separated and review write tools before granting them.

This project is not audited. Run it at your own risk.
