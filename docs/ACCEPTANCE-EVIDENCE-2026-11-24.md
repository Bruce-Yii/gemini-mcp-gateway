# V0 验收证据 — 2026-11-24

> 本文件只记**已实际执行**的证据，不写“通过/修好”。V0 仍是 **NOT ACCEPTED**。
> 证据 JSON 在 `docs/eval/acceptance-2026-11-24/`；代码改动走 PR，未合并、未部署。
> 生产仍为 `9ab0e57`（`/healthz` 实查）；自动 production 部署已关闭并复核。

## 0. 当前判定

| 门 | 状态 | 依据 |
|---|---|---|
| A 构建可追溯 | **PARTIAL** | healthz `9ab0e57…` / `buildHash=02c96881…`；`05f607c` 起 push 不再部署（4 个提交 + 本次 `1cd94ab` 均无 deployment）；但验收 commit 已过期、历史 40 次部署未登记 |
| B 真实客户端 | **FAIL（未跑；需用户操作）** | 见 [ACCEPTANCE-CLIENT-RUNBOOK.md](ACCEPTANCE-CLIENT-RUNBOOK.md) |
| C 真实写回环 | **PARTIAL** | 写回环全流程真实跑通（见 §1）；**CI 因 GitHub 账户 billing 未启动**，不是网关失败 |
| D 授权生命周期 | **FAIL / 部分机制落地** | owner 标记代码 + 迁移脚本在 PR #6；真实 tools/list 3/5 通过，2 个 token 过期；KV 仍跨环境共用（§3） |
| E 同任务对照 | **FAIL** | baseline 仍 none；origin 修复未部署，旧/新构建对照不可执行 |
| F 真实安全结果 | **PARTIAL** | 真实上游 401 已观测（Notion/Vercel），但**不是**经网关模型可见投影的 401；Docker/npm audit 仍不可用 |
| G 独立评测 | **FAIL** | 无独立 evaluator 结果 |

## 1. Gate C：真实写回环（gateway 代码 + 真实 GitHub MCP + 私有验收仓库）

```text
gate: C
commit/build: 本地 main 树（HEAD 1cd94ab + 未合并改动），未部署
client: local MCP SDK client → src/upstreams.js UpstreamManager → src/file-write.js applyFilePatch
task: read → dryRun patch → real commit → byte verify → failure case → PR → CI read
exact tool call:
  github__get_file_contents { owner, repo, path: "src/sample.txt", ref: "main"|"<branch>" }
  github__create_branch { owner, repo, branch, from_branch: "main" }
  github__create_or_update_file { owner, repo, path, branch, content, message, sha }
  github__create_pull_request { owner, repo, base: "main", head: "<branch>", title, body }
actual:
  read: 真实上游返回 text notice + resource 正文；normalizeFileResult 输出纯正文 19 bytes，
        notice/SHA 仅进元数据（hasNoticeInContent=false）
  dryRun: patch 匹配，远端文件未变
  write: commitSha=14c4c3c3f70e2cded89f5b62243a4735ea1f2eed
  verify: 远端 52 bytes == dryRun 预览 52 bytes；首行 line1；末行 acceptance-patch: 20261123183811；无 notice
  failure: 错上下文 patch → ok=false；分支 head 未变；远端内容未变；无半写
  PR: https://github.com/Bruce-Yii/gateway-acceptance-test/pull/1（number 从 URL 取=1）
  repo: main head 仍是 b8dd7b1；分支=main+acceptance/*；open PR=1
expected: 上述全部为 true
requestId: unknown（本地 harness，无网关 capture）
pass/fail: **PARTIAL** —— 写回环 PASS；CI check 存在但 **conclusion=failure 且 annotation 为 GitHub Billing**：
  "The job was not started because recent account payments have failed or your spending limit needs to be increased"
evidence path: docs/eval/acceptance-2026-11-24/write-loop-report.json、
  docs/eval/acceptance-2026-11-24/write-loop-verify.json
```

**需要用户操作**：修复 GitHub 账户 billing / Actions 额度后，重跑同一 PR 的 check 或重新推一个提交，
把 check 真正跑绿；在此之前 C 不能判 PASS。

## 2. Gate D 的真实 tools/list（只读，2026-11-24 02:20 SGT）

```text
gate: D（部分证据）
commit/build: 本地 vault/CC Switch 凭证；未部署
client: local MCP SDK (initialize + tools/list)
task: 每个上游真实 tools/list
exact tool call: tools/list
actual:
  github  200, 28 tools   https://api.githubcopilot.com/mcp/readonly
  linear  200, 60 tools   https://mcp.linear.app/mcp
  figma   200, 51 tools   https://mcp.figma.com/mcp
  notion  401 invalid_token（本地 access token 已过期；refresh 属 DSH，禁止）
  vercel  401 invalid_token（本地 token 已过期；需网关自己 OAuth + offline_access）
expected: 5/5
requestId: unknown（不经过网关 capture）
pass/fail: **PARTIAL 3/5**
evidence path: docs/eval/acceptance-2026-11-24/tools-list-results.json
```

owner 落地：PR #6（`fix/auth-owner-marking`）——显式 `grantOwner`、未标记→shared 永不 refresh、
legacy v1 例外删除、迁移脚本 `scripts/auth-migrate-owners.mjs`、14 项测试。
**未合并、未部署、未对生产 KV 执行迁移**。

## 3. Preview/production KV 隔离（只读实测）

```text
gate: D（AUTH-READY 1.4-2）
client: scripts/check-env-isolation.mjs（Vercel API 只读）
actual: ok=false；P0 shared-record:
  PUBLIC_BASE_URL / UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN / REDIS_URL
  均 target production+preview
expected: 每个环境独立 KV 凭据
pass/fail: **FAIL**
evidence path: docs/eval/acceptance-2026-11-24/env-isolation-result.json、docs/ENV-ISOLATION.md
```

**需要用户操作**：在 Vercel 项目里给 preview 配独立 KV（见 `docs/ENV-ISOLATION.md` §3），
然后重跑 `node scripts/check-env-isolation.mjs --json` 期望 `ok:true`。

## 4. 入站 OAuth origin（代码修复，未部署）

PR #7（`fix/oauth-origin-consistency`）：`resolveBaseUrl()` 改为请求 host 优先，
`issuer` / protected-resource `resource` / 401 `resource_metadata` / CIMD `client_id` 同一 origin；
6 项测试 + 恶意 host 不反射。**未合并、未部署**，所以线上 401 仍指向 `…yu-ac3a…`。

## 5. 本次未做 / 不能做

- 真实 Gemini/ChatGPT 客户端任务（需要用户浏览器，见 runbook）；
- GitHub Actions 绿灯（账户 billing 阻塞）；
- 生产 KV owner 迁移（需要 operator 凭据；禁止用生产 token）；
- Linear PAT / Notion static token / Vercel OAuth（需要 owner 授权；
  按 AUTH-READY 门禁，当前仍不应向用户发起）；
- 任何 deploy。
