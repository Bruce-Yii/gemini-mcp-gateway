# Deployment log

> 部署机制（2026-11-24 起）：GitHub push **不再**自动发布 production。
> `vercel.json` 已加 `git.deploymentEnabled.main = false`（commit `05f607c`）。
> 生产部署只能手动触发（`vercel --prod` / dashboard promote），且必须过
> [DEPLOY-POLICY.md](DEPLOY-POLICY.md) 并在此登记。

| 时间 (Asia/Singapore) | Commit | 方式 | 目的 | 结果 | 证据 |
|---|---|---|---|---|---|
| 2026-11-24 00:50 | `87d91af` | CLI（手动） | 验收门 A：部署最新代码并核对 healthz | READY | `commit=87d91af0caf84f1bc2f5ed1fff3ba20bbe234472`，`buildHash=02c96881...`；`/mcp` 401；未做真实客户端/授权验收 |
| 2026-11-24 01:51 | `9ab0e57` | git push 自动（最后一次） | 修复自动部署说明的 docs 提交，被自动上线 | READY | `deploymentId=dpl_8vioi2zsZdF41zGqJTbh61Bg3bts`；healthz `commit=9ab0e57d7c3b1a7ebda548d1319887c1b70a64da` / `buildHash=02c96881...` / `builtAt=2026-11-23T17:51:36.429Z` |
| 2026-11-24 01:59 | `05f607c` | git push | 关掉 main 的自动 production 部署（`vercel.json`） | **未部署** | Vercel deployments API：该 commit 无任何 deployment 记录（含 preview） |
| 2026-11-24 02:02 | `c5a0a06` | git push | 记录部署控制与验收仓库 | **未部署** | 同上 |
| 2026-11-24 02:05 | `36e4c76` | git push | 更新 handoff | **未部署** | 同上 |
| 2026-11-24 02:08 | `34c406d` | git push | handoff 状态更新 | **未部署** | 同上 |
| 2026-11-24 02:16 | `9ab0e57`（复核） | 只读复核 | 确认自动部署已停、生产未漂移 | **PASS** | ① healthz：`commit=9ab0e57…`、`buildHash=02c96881…`、`env=production`、`mode=codemode`；② Vercel `GET /v6/deployments?projectId=…&limit=15`：最新 production 部署仍是 `9ab0e57`（01:51:21），其后 `05f607c/c5a0a06/36e4c76/34c406d` 全部 `deployed=false`；③ 无 preview 部署产生 |

| 2026-11-24 02:57 | `d1f36ba` | CLI（手动） | 合并 #6/#7 后部署：owner 标记 + 入站 origin 一致 | READY | `deploymentId=dpl_7qGruKcZ8ffE7rri6erS6ZaiqiNS`；healthz `commit=d1f36ba…` / `buildHash=a1002d86…`；两域名的 issuer/resource/CIMD/401 各自与请求 host 一致 |

| 2026-11-24 06:40 | `1481408` | P0 fixes deployment (v2 plan IO, capture options, allow/deny, commitSha, queue LRU) | READY | healthz commit=1481408… buildHash=c604c31a…; `/mcp` 401 |

| 2026-11-24 07:45 | `5039ac6` | CLI（手动） | PR80-101 feedback 修复：GitHub/API、写前预检、结构化截断、feedback eval profile | READY | healthz `commit=5039ac69d4e514bc11cdcc4fb2ce19d7dd5e234a` / `buildHash=c060691d006e5f3d6c590740e560ae5e76ab3a42`；`deploymentId=dpl_Ao5R8WoDpZZfXQbjxEeLVFFMntZ3`；`/mcp` 401 |

| 2026-11-24 13:43 | `3dd206f` | CLI（手动，`vercel --prod`） | 合并 Issue #15 优先修复：`issue_write` 成功后 URL 兜底补齐顶层 `number` + `fileResult` 对完整 ~40KB 文件的 `truncated:true` 假阳性（tail-only 判定） | READY | `deploymentId=dpl_8J71rsV3hFbmAdVXWUAqvGZsqrdU`；healthz `commit=3dd206f7238491e93f15c3ce39bce37c0e4bceba` / `buildHash=25a35e6e250342fb25c22de01527dccc99765f9c` / `builtAt=2026-11-24T05:43:43.432Z`；`env=production`、`configLoaded=true`、`mode=codemode`；部署前全量 `npm test` 最终 1537/1531/0/6（前两次各现一例时间敏感抖动，定向复跑通过） |

| 2026-11-24 14:02 | `3dd206f` | CLI（手动，同 commit redeploy） | 配置 production `CLIENT_PLATFORM_OAUTH_MAP`（`ALLOWED_CLIENT_ID` → `gemini`，1 key JSON；不打印值）后重新部署使 env 生效 | READY | `deploymentId=dpl_6MdJAy2eVD9Re4ZcqduXyh9jvQvD`；healthz `commit=3dd206f…` / `buildHash=25a35e6e…`（与上一行一致，docs/env-only 变更未改 buildHash） |

| 2026-11-25 00:00 | `9eb0c7a` | CLI（手动，`vercel --prod`，带 `--build-env VERCEL_GIT_COMMIT_SHA`） | 部署 main `9eb0c7a`（PR #23 评测闭环工具层 + #24 双窗口证据 + #25 子代理编排 + #26 OAuth owner 审批口令保护）；production 新增 `OAUTH_APPROVE_PASSPHRASE`（Secret，值不记录），`ALLOW_DCR_FOR_CHATGPT` 已存在按跳过 | READY | `deploymentId=dpl_FHYvwXwtEmp1BP47noMUnAQkRB8U`；healthz `commit=9eb0c7aa3d10d777d3066f858a67be39cc8303dd` / `buildHash=7b594db7ce6cd9d1f8f7fad52464b1f8c8e7bd34` / `builtAt=2026-11-24T16:00:25.012Z`；`env=production`、`configLoaded=true`；部署前干净 worktree `npm test` 1560/1546/0/6 |

> 注：同 commit 的前两次 CLI 部署因本地 worktree/clone 缺少 GitHub 远端元数据，healthz 落为 `commit=unknown`；已由本行带 `VERCEL_GIT_COMMIT_SHA` 的部署覆盖，生产只以 `dpl_FHYvwXwtEmp1BP47noMUnAQkRB8U` 为准。

## 规则

- 每次部署前过 [DEPLOY-POLICY.md](DEPLOY-POLICY.md) 检查；
- 记录 commit、方式、目的、healthz 证据、对应 acceptance gate；
- 生产部署必须手动发起，并登记 deploymentId；
- docs/tests-only 不部署；
- 自动部署关闭后，push 到 main 不再改变生产；若发现 healthz commit 变化而本表无记录，按事故处理。

## Preview（非生产）部署 — 2026-11-24 02:26 / 02:32

`main` 关闭自动部署后，**branch push 仍会生成 preview 部署**（保留 preview 是有意选择）：

| 时间 | 分支 / commit | 类型 | 说明 |
|---|---|---|---|
| 02:26 | `fix/auth-owner-marking` / `2f79eaf` | preview | PR #6；target 非 production，生产仍 `9ab0e57` |
| 02:32 | `fix/oauth-origin-consistency` / `6c5d910` | preview | PR #7；同上 |

另：`1cd94ab`、`cad0dd2` 两个 main docs 提交均**无** deployment（已复核）。
若要连 preview 也不生成，需要把 `git.deploymentEnabled` 扩成 `{"*": false}` 并手动部署一次。

## 未登记的部署历史（2026-11-24 01:12 复核）

2026-11-23 07:31 — 2026-11-24 01:12 期间共 **40 次**自动 production 部署（Vercel API 实查），
本表此前只登记了 `87d91af` 一次。历史不可追溯部分按 `INDEPENDENT-REVIEW-2026-11-24.md`
记为 A 门 PARTIAL 的原因之一；不补造记录。
