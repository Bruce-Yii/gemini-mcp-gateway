# Model-in-loop benchmark harness

`bench/run.mjs` measures the full path **model → gateway → upstream → model**
instead of offline word matching:

- connects to the gateway over real Streamable HTTP,
- gives an OpenAI-compatible chat model the three gateway tools,
- runs `bench/tasks.json`, executes the returned tool calls through the gateway,
- scores each task with deterministic checks,
- reports pass rate, turns, gateway tool calls, model tokens and wall time.

The bundled task file uses the **deterministic fake upstream**
(`bench/config.fake.json` → `harness/fake-upstream.mjs`), so it is a harness
sanity check, not a quality score for real upstreams. Point it at a real
deployment and your own tasks to measure real usage.

## Dry run (no model calls)

```bash
node bench/run.mjs --dry-run
```

Starts the local gateway with the fake upstream, verifies it exposes exactly
three tools, loads the task file, and exits. CI runs this.

## Model run

Any OpenAI-compatible chat endpoint works (OpenAI, OpenRouter, vLLM, local
gateways, ...):

```bash
BENCH_MODEL_BASE=https://api.openai.com/v1 \
BENCH_MODEL=gpt-... \
BENCH_MODEL_KEY=sk-... \
node bench/run.mjs
```

Environment options:

| Variable | Meaning |
|---|---|
| BENCH_MODEL_BASE | OpenAI-compatible base URL ending in /v1 |
| BENCH_MODEL / BENCH_MODEL_KEY | Model name and bearer key |
| BENCH_MAX_TOKENS | Max output tokens per turn (default 2000) |
| BENCH_MODEL_HEADERS | Extra request headers as a JSON object (e.g. provider quirks) |
| BENCH_GATEWAY_TOKEN | Static bearer when using --gateway |

For OpenCode Go endpoints (opencode.ai) the harness automatically sends an x-opencode-session header because that endpoint requires it.

Options:

| Flag | Meaning |
|---|---|
| `--tasks <file>` | Task file (default `bench/tasks.json`) |
| `--max-turns <n>` | Max model turns per task (default 6) |
| `--gateway <url>` | Use an already-running gateway instead of starting the fake one |
| `--token <bearer>` | Static bearer for `--gateway` (or `BENCH_GATEWAY_TOKEN`) |
| `--dry-run` | Gateway/task checks only, no model calls |

Against a real deployment (if it is locked to a manual OAuth client you need a
bearer token from the normal OAuth flow):

```bash
node bench/run.mjs --gateway https://<your-domain>/mcp --token "$TOKEN" --tasks my-tasks.json
```

## Task file

```json
{
  "name": "my tasks",
  "tasks": [
    {
      "id": "list-issues",
      "prompt": "How many open issues are in acme/demo? Answer with just the number.",
      "checks": [
        { "contains": "2" },
        { "notContains": "error" },
        { "regex": "^\\s*2\\s*$" }
      ]
    }
  ]
}
```

Every check in `checks` must pass. `contains` / `notContains` accept a string or
a list; `regex` is case-insensitive. Keep tasks deterministic and small — the
point is measuring the harness and tool surface, not grading creative writing.

## Results

`bench/results.json` (git-ignored) contains per-task answers, counts and a
bounded trace of gateway tool calls. Token counts come from the model API's
`usage` field; they are not a substitute for client-side context accounting.

## Caveats

- The fake upstream returns predictable JSON for a handful of tools, so a weak
  model can pass. Use real tasks against a real gateway for quality decisions.
- Results depend on the model, temperature (fixed to 0) and max turns.
- The gateway's `execute` tool runs arbitrary JS; only point this harness at a
  gateway you control.
