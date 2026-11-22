# Open-source export manifest

> Decision: the public project will live in a **new repository**, created from a
> clean export. The current private repo stays the development/eval source of
> truth; it is **not** made public in place.

## Why a new repo

- Current repo contains internal ledgers, eval artifacts, handoff notes, test
  data, and personal environment details that should not become public history.
- A fresh repo gives a clean commit history and a deliberate first release
  (no “private history cleanup” risk).
- Public issues/PRs should not inherit private development experiments.

## Delivery model

```text
private repo (source of truth)
  ├─ all ledgers / eval / capture / handoff / experiments
  └─ scripts/export-oss.mjs  ──►  clean staging tree  ──►  new public repo
```

- Export is **allowlist-based**, not “copy everything then delete”.
- The exported tree must pass `npm ci && npm test`, truncation audit, and config
  validation before it is pushed.
- Public repo receives release snapshots; day-to-day development continues in
  the private repo.
- No secrets are copied: exported configs only use `*Env` names and placeholders.

## Include (public)

```text
package.json
package-lock.json
README.md / README.zh-CN.md
LICENSE
CHANGELOG.md
CONTRIBUTING.md
SECURITY.md
CODE_OF_CONDUCT.md            # to add
DEPLOY.md
config.example.json
vercel.json
api/
src/
tests/
scripts/                      # only public-safe scripts; see denylist
harness/
bench/                        # if fixtures are neutral
examples/
templates/
docs/
  CLIENTS.md
  UPSTREAMS.md
  WHY.md
  CONTRACT*.md
  SANDBOX-SECURITY.md
  OBSERVABILITY-AND-EVAL.md   # curated
  eval/                        # curated summaries only
  OPEN-SOURCE/                 # public-facing plan/compat docs (curated)
.github/workflows/ci.yml       # offline CI only
```

## Exclude (private)

```text
AGENTS.md
project.json
docs/ledger/
docs/HANDOFF*
docs/PLAN-*.md
docs/OPEN-SOURCE/READINESS.md   # internal audit
docs/eval/scorecard-*.json      # unless explicitly curated
docs/eval/weekly-*.md           # unless explicitly curated
docs/GEMINI-PROBE.md
docs/BACKLOG-GEMINI-SUGGESTIONS.md
docs/superpowers/
explore/
  results/
  tasks*.json                   # contains personal handles; export neutralized copies if needed
data/                           # vendor datasets are large; decide per file
work/
outputs/
.vercel/
.vercelignore
.github/workflows/capture-daily.yml   # owner-only eval workflow; do not export
.github/workflows/l1-smoke.yml        # eval workflow; export opt-in later
coverage/
test-results/
*.log
*.capture.json
config.local.*
credentials / .env / secrets
```

If `explore/tasks*.json` or `bench` fixtures are needed for public tests, export
**neutralized copies** with `example-org/example-repo`, not the originals.

## Public repo first-release adjustments

1. Neutral metadata:
   - name `codemode-mcp-gateway`;
   - `repository`/`homepage`/`bugs` point to the new repo;
   - `files` field added before npm publish.
2. README rewritten for public:
   - lead with context/tool-call optimization, not “supports 5 upstreams”;
   - tested matrix: Gemini (tested), Claude (target), ChatGPT (documented, plan-gated);
   - quickstart without tokens;
   - scope/non-goals: single-owner/self-hosted, no multi-tenant.
3. Real deployment artifacts:
   - Dockerfile + docker-compose + healthcheck;
   - local `--host` for Docker;
   - templates local/docker/vercel; Cloudflare design-only.
4. CI:
   - offline `npm ci && npm test` on Node 20/22/24;
   - truncation audit;
   - no capture secrets, no scheduled commit/push.
5. History:
   - fresh `git init` in staging, one initial commit / release commit;
   - no private commit messages or author metadata beyond the public owner.

## Validation gate for the exported tree

Run in the staging directory, not in the private repo:

```bash
npm ci
npm test
node scripts/audit-truncation.mjs --ci
node scripts/check-config.mjs
node scripts/measure-context.mjs
# grep for real hostnames, personal paths, Bruce-Yii defaults, vault paths
```

Publication checklist:

- [ ] Export manifest allowlist only; no excluded files present.
- [ ] No real domains, personal paths, credentials, capture data, ledgers.
- [ ] `npm test` green from clean clone.
- [ ] Docker compose reachable; local quickstart works without tokens.
- [ ] README/client matrix/scope honest.
- [ ] New repo has fresh history and public metadata.
- [ ] Old private repo stays private.
