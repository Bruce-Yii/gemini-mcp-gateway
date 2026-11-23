# Batch 11 · GitHub 真实使用反馈修复（3 条）

范围：只改 `src/github-helpers.js`、`src/result-normalize.js`、`src/codemode.js`，新增 `tests/gh-feedback-fixes.test.js` 与本文件。
未改 `src/capture.js`、`src/server.js`、`src/upstreams.js`、`scripts/`、其他 tests、README、CHANGELOG、workflows；未 commit / push / deploy。

## 反馈 1 · 分支名参数别名不一致

**证据**：真实调用 `createBranchIfMissing` 传 `branch: '...'`，报 `ensureBranch: name is required`（capture `d6f59a7e...`）。原因是 host helper 与 sandbox helper 都只认 `name`，而 GitHub 工具实际用 `branch`。

**修复**：
- `ensureBranch` / `createBranchIfMissing`（host，`src/github-helpers.js`）与 sandbox 中的 `codemode.ensureBranch` / `codemode.createBranchIfMissing`（`src/codemode.js`）统一接受 `name` / `branch` / `branchName` 三个别名，先归一化为一个规范名再做查找/创建。
- 创建回调参数保持 `{name, fromSha}`（host）与 `{branch, from_branch}`（sandbox，GitHub 工具参数）不变。
- 无任何别名时仍报错，文案升级为 `ensureBranch: branch name is required (pass name, branch or branchName)`，比旧的 `name is required` 更可操作。
- `ifExists:'reset'` 必须显式传删除工具的行为不变。

**测试**：host 三个别名各建一次、通过别名命中已有分支、报错文案、Code Mode 内两个入口传 `branch` 均成功并产生正确的 `create_branch` 调用。

## 反馈 2 · PR `number` 被数据库 `id` 污染

**证据**：真实 `create_pull_request` 返回 `{id:5444514334, url:.../pull/53}`，旧 `normalizePrResult` 把 `number` 回退到 `id`，得到 5444514334，随后 merge 调用 404。

**修复**：
- `normalizePrResult`（`src/result-normalize.js`）：`number` 只从 URL（`/pull/N` 与 `/pulls/N`）与 `number` / `prNumber` / `pr_number` 取；**URL 优先**；`id` 仅保留为 `id` 字符串字段，绝不作为 `number`。
- `normalizeIssueResult` 同步应用同一规则（issue 的 `id` 也不是 issue number）。
- `canonicalResult`（merge / write helper，`src/github-helpers.js`）：URL 优先于显式字段，`id` 从 number 候选列表中移除。
- sandbox 侧 `codemode.prResult`、`codemode.normalizeMerge`、`codemode.canonicalize`、`codemode.upsertPr` 同步（`src/codemode.js`）。
- `upsertPr`（host 与 sandbox）更新已有 PR 时不再用 `existing.id` 当 `pullNumber`。

**测试**：真实形状返回 53；单独 `id` → `number:null`；URL 与 number 冲突时 URL 胜出；`prNumber`/`pr_number` 别名；dispatch/canonical/merge 一致；issue 相同规则；sandbox 三个入口一致。

## 反馈 3 · GitHub Actions 失败日志（高频只读能力）

**背景**：现有白名单/上游工具集没有 Actions 工具。为满足"读失败日志"的高频需求，新增**网关侧 GitHub REST helper**，通过 Code Mode 暴露，**不是新的上游 MCP 工具**，对外工具数保持 3 个（`search` / `execute_read` / `execute`）。

**API**（均在 `codemode` 对象上，`execute_read` 与 `execute` 都可用）：
- `codemode.github_actions_list_workflow_runs({owner,repo,workflow_id?,status?,branch?,per_page?})` → `GET /repos/{owner}/{repo}/actions/runs`
- `codemode.github_actions_list_workflow_jobs({owner,repo,run_id})` → `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs`
- `codemode.github_actions_get_job_logs({owner,repo,job_id})` → `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs`，返回 text

**实现要点**：
- 纯 host 模块 `src/github-helpers.js` 实现，fetch 通过 `runInSandbox({fetch, env})` 注入（生产走宿主 `fetch`，测试注入 fake）；`env.GITHUB_TOKEN` 提供 token。
- 无 token 返回结构化 `{ok:false,status:0,data/text:null,truncated:false,error:'GITHUB_TOKEN is not configured...'}`，不发网络请求。
- 稳定返回形状：`{ok,status,data|text,truncated}`；错误时附 `error`。日志 302 到签名 URL 时跟随重定向，**不把 token 带到重定向目标**。
- 超时默认 15s、日志默认上限 2 MiB（可通过 `timeoutMs` / `maxBytes` 调），截断置 `truncated:true`。
- 不打印 token；错误信息不包含响应体，避免泄露签名 URL。
- sandbox prelude 增加三个 `__dshHide` 的薄封装，host bridge 增加三个 registry 项；不消耗上游 tool-call 预算，不改变白名单/schema。
- `execute` 描述追加 `ACTIONS_GUIDANCE`，说明这是网关侧 REST helper 且需 `GITHUB_TOKEN`。

**测试**：正确 URL/query、runId/jobId 别名、成功 text、302 跟随且不转发 token、无 token、404 结构化错误、超大日志截断、sandbox 注入 fetch 可达、仍恰好 3 个 MCP tool。

## 验证

- `node --test tests/gh-feedback-fixes.test.js`：21/21 通过。
- 全量 `npm test`：761/761 通过，0 失败，0 跳过（包含所有既有 tests，无需改任何旧测试）。

### 关于旧测试兼容性

`tests/result-normalize.test.js` 中两条名为"id 兜底为 number"的旧断言其实同时提供了形如 `https://example/pull/99` / `https://example/issues/8` 的 URL。因为新实现是"URL 优先"，它们仍从 URL 得到相同编号，所以全量测试保持绿色；本代理未修改任何既有测试。真正仅给裸 `id`、无 URL 的场景已在新测试中验证为 `number:null`。
