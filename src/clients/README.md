# `src/clients/` — physical client adaptation (M1)

One MCP client platform = one physical directory. The goal is that a change for
one client cannot silently change another client's Code Mode face.

```text
src/clients/
├── index.js            # ONLY router: signals -> platform adapter (unknown -> gemini)
├── _base/index.js      # shared contract + assembler + defaults (NO platform branch)
├── gemini/
│   ├── index.js        # adapter: textJson, full descriptions, 20000-char budget
│   └── prompts.js      # Gemini-only tool-description wording
├── chatgpt/
│   ├── index.js        # adapter: structuredContent + textJson
│   └── prompts.js      # ChatGPT-only tool-description wording
└── claude/
    ├── index.js        # adapter: text + annotations (no structuredContent)
    └── prompts.js      # Claude-only tool-description wording
```

## Contract

An adapter may influence ONLY:

- tool-description wording (from its own `prompts.js`);
- tool `annotations` (informational hints, never permissions);
- result encoding (`textJson` or `structuredContent` + `textJson`);
- the execute/execute_read output budget (characters);
- search/retrieval policy (default result limit, list-mode description compaction).

It may NEVER influence tool names, order, input schemas, handlers, sandbox
semantics, the read-only/write boundary, upstream auth, or any permission
decision. Those are objective and assembled by `src/execution/codemode.js` +
`src/clients/_base/index.js`.

The objective upstream/sandbox guidance text (result shapes, helper list,
truncation rules, boundary line) stays in `src/execution/codemode.js` and is
injected into every adapter as `context.guidance.*`; platform `prompts.js` files
only own the client-facing phrasing and its ordering.

## Dispatch

`src/clients/index.js#resolveClientAdapter` reuses the existing resolvers:

- `src/client/client-profile.js#resolveClientProfile` — explicit profile header,
  `clientInfo.name`, exact `CLIENT_PLATFORM_OAUTH_MAP` OAuth client-id match,
  explicit UA product token, explicit env opt-ins;
- `src/client/client-platform.js#detectClientPlatform` — the observability label
  (gemini | chatgpt | claude | unknown) exposed on the resolution record.

Unknown/ambiguous input falls back to `gemini`, the historical default.

## Boundary rules (CI)

`node scripts/check-module-boundaries.mjs` enforces, with a non-zero exit code:

- **Rule A** — `src/clients/<platformA>/**` must not import
  `src/clients/<platformB>/**` (A ≠ B); `src/clients/_base/**` must not import a
  concrete platform.
- **Rule B** — `src/execution/**`, `src/upstream/**`, `src/evidence/**` must not
  import `src/clients/{gemini,chatgpt,claude}/**`; they may import
  `src/clients/index.js` or `src/clients/_base/**`.

Legacy module rules and their report format are unchanged; the client rules are
reported in a separate `[client-boundaries]` section with distinct rule ids.

## Tests

- `tests/client-physical-isolation.test.js` — router dispatch, per-platform
  encoding, and byte-level regression against the pre-refactor baseline in
  `tests/fixtures/m1-client-baseline.json`.
- `tests/client-isolation-boundaries.test.js` — negative tests proving both
  boundary rules are detected (function level + CLI exit codes).
