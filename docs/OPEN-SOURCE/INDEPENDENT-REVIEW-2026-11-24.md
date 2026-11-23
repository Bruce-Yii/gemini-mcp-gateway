# Independent review — 2026-11-24

> 来源：接手窗口只读审查（HEAD `758a232`，2026-11-24 01:20–01:35 SGT）。
> 本文件不是 lead 自述；它推翻/修正了上一轮若干结论。
> 结论：**V0 仍 0/7；A 从 PASS 退回 PARTIAL；生产是 `758a232`，不是 `87d91af`。**

## 1. 被证伪的旧结论

| 旧说法 | 实际 |
|---|---|
| 生产是 `87d91af` | **错**；healthz 是 `758a232b0f5f466835b8e31868284b81484daa73`，`deploymentId=dpl_43d9tWe...` |
| 最新修复未部署 | **错**；`4a77fc0` / `7a82c1d` 已自动上生产 |
| Vercel 额度用尽、等部署窗口 | **错**；11-24 00:49–01:12 已成功部署 10 次 |
| 部署由 lead 手动控制 | **错**；每次 push `main` 自动 production；今晚 8 个纯 docs 提交全部自动上线 |
| `87d91af` 验收 A PASS | **失效**；验收 commit 已不在生产，A 应为 PARTIAL |
| Vercel CIMD BLOCKED | **不能作为已证事实**；probe 的 Notion 控制组拿到 403，`controlOk:false`，结论应 UNKNOWN |

## 2. 独立审查确认的正面结论

- `npm test`：1381 / 1375 pass / 0 fail / 6 todo / skipped 0（实跑）；
- `audit-truncation --ci`：P0=0（P1=28 未清零，只是不 fail）；
- `local-e2e-verify`：11/11（但明确 fake token store + upstream）；
- 生产运行时源码与本地 HEAD 一致（healthz commit + `write-build-info --print`）；
- R-01/F-08/F-09/R-02 安全修复确实在代码与测试中落地；
- README 的 3,564 tokens / -98.5% 与 `measure-context` 实测一致；
- 真实 GitHub MCP 只读端到端（真 token）通过；
- OSS local repo 无 remote/tag。

## 3. 五个高优先级风险

### R1（P0，运营）push 即上线，部署与验收证据同时失效

- Vercel 40 条部署，`source=git` / `target=production`；
- 8 个纯 docs commit 自动上线；
- A 门记录失效，E 门（旧/新构建）无法控制。

### R2（P0/P1，授权）上游 refresh token owner 未落地

- 生产 env 有 `NOTION_REFRESH_TOKEN` / `LINEAR_REFRESH_TOKEN` / `FIGMA_REFRESH_TOKEN`；
- 没有 `grantOwner`/`grantSource` 变量，也没有 `LINEAR_PAT_STATIC`；
- `upstream-auth` 对未标记 grant 判 `shared` 并禁止刷新；
- `/healthz` 不连上游，永远 `ok:true`，上游过期会静默降级；
- 若误标 `gateway`，网关会去花 DSH 的 rotating token。

### R3（P1，客户端）入站 OAuth origin 三处不一致

- `https://gemini-mcp-gateway.vercel.app/mcp` 401 的 `resource_metadata` 指向
  `https://gemini-mcp-gateway-yu-ac3a.vercel.app/...`；
- AS metadata `issuer`、protected-resource `resource`、CIMD `client_id`
  都是 `yu-ac3a` 域名；
- 严格 RFC 9728 客户端会拒绝；真实客户端从未在文档域名上验证。

### R4（P1，隔离）preview 与 production 共用 KV / PUBLIC_BASE_URL

- `UPSTASH_REDIS_REST_URL/TOKEN`、`REDIS_URL` target = production,preview；
- `PUBLIC_BASE_URL` 同时 target 三环境；
- AUTH-READY 1.4-2「不存在跨环境共用 KV」不成立。

### R5（P1，评测）证据链仍是“叙述”，不是可回放

- F1–F6 `requestId: unknown`、`captureVerified:false`；
- 唯一真实 requestId 窗口（11-22）`execute` 零调用；
- replay/e2e 是 fixture + fake store/upstream；
- 被埋掉的 real-L1：completion 76%、toolHit 51.3%、gatewayAnomaly 21。

## 4. V0 A–G 真实状态（独立审查）

| 门 | 状态 | 说明 |
|---|---|---|
| A 构建可追溯 | **PARTIAL** | healthz 可核，但验收 commit 失效、自动部署、部署记录 1/40 |
| B 真实客户端 | **FAIL** | 无受控 10 任务；origin 不一致 |
| C 真实写回环 | **FAIL** | 有 ad-hoc PR，但无测试仓库、无字节级写后验证、capture 无 execute |
| D 授权生命周期 | **FAIL** | 无 gateway-owned grant、无 `--apply`、无重启/72h；KV 共用 |
| E 同任务对照 | **FAIL** | baseline=none；自动部署让旧构建瞬间消失 |
| F 真实安全结果 | **PARTIAL** | 代码/离线测试成立；真实 401 未测；npm audit 404；Docker 未运行 |
| G 独立评测 | **FAIL** | 无 independent evaluator 结果 |

## 5. 独立审查建议的三步

1. **止血**：停掉 push→production 自动部署；补记 `758a232`；A 判据改为
   `healthz.commit == 部署 commit` + `buildHash == 本地 --print` + `deploymentId` + 时间戳。
2. **授权显式化**：每个 env token 标 `manual`/`dsh`，绝不让未标记 grant 自动 refresh；
   真实 tools/list 验证 5 个上游。
3. **一次受控真实客户端 + 真实写回环**：浏览器 + 一次性测试仓库；
   记录 exact tool call/args/actual/requestId，写后字节对账。

## 6. 审查实跑清单

```text
npm test                          → 1381 / 1375 / 0 fail / 6 todo / skipped 0
audit-truncation --ci             → P0=0 P1=28 P2=255
local-e2e-verify                  → ok:true 11 checks（fake store/upstream）
curl /healthz                     → commit=758a232… buildHash=02c96881… production
curl /.well-known/mcp-client.json → client_id=…yu-ac3a.vercel.app/…
curl POST /mcp (no auth)          → 401 resource_metadata=…yu-ac3a…
write-build-info --print          → 本地 commit/hash 与线上一致
Vercel Deployments API            → 40 条 source=git target=production
Vercel Env API (names only)       → 41 vars；无 LINEAR_PAT_STATIC；KV production+preview
vercel-cimd-probe                 → controlOk:false → UNKNOWN
verify-real-github                → 真实 token 只读通过
npm audit --omit=dev              → 404 NOT_IMPLEMENTED
docker version                    → daemon 未运行
```

## 7. 不可由只读审查完成的三项

- 真实客户端（需要浏览器/账号）；
- 真实写（需要一次性测试仓库）；
- 真实授权（需要一次 user consent + KV 写入）。
