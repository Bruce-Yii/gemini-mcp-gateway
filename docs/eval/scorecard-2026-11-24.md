# Capture Scorecard — 2026-11-24

| Metric | Value |
|---|---|
| Requests | 20 |
| MCP POST requests | 20 |
| Non-MCP routes | 0 |
| Errors (HTTP >= 400) | 1 |
| MCP errors | 1 |
| p50 latency | 774 ms |
| p95 latency | 9469 ms |
| Avg latency | 3087 ms |
| Response bytes | 122041 |
| Truncated responses (gateway wire) | 4 |
| Overflow captures (capture limit) | 0 |
| Truncation rate | 0.2 |
| Overflow rate | 0 |
| Model truncation suspects (silent) | 8 |
| Model truncation rate | 0.4 |
| Overall error rate | 0.05 |

## By client platform (batch 13)
> 每个平台的指标单独成行，绝不互相污染。`clientPlatform` 只接受显式且可识别的值；
> 缺失 / null / 非字符串 / 未知值一律进 `unknown`，不根据 UA / 工具名猜测。
> 旧 envelope（无字段）全部落在 `unknown`，不会被算进 Gemini。
> 平台之间**不做硬比**：baseline 与任务分母按平台独立（见 batch-13-platform-eval.md）。

| Platform | Requests | MCP requests | Errors | Tool calls | Trunc suspects | Sessions | Projects | RequestId samples |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| gemini | 3 | 3 | 0 | 1 | 1 | 3 | 1 | `0442a80c-85a2-4fc1-a0fa-d8697ed42650`, `06b36205-bbd6-4df3-a619-741ffda52db9`, `0ec61a1a-1827-40fd-8f5d-4da717d78c69` |
| unknown | 17 | 17 | 1 | 10 | 11 | 10 | 2 | `0271e7ca-d2dd-44d8-8902-ad38f2157743`, `04ea8e1f-65a1-42d6-922d-37dd8eb7044e`, `05623334-9d25-4299-ac8d-e52f1cd8c252`, `08d8bf5a-069e-4db5-ac53-32f975c809a3`, `0a820ad5-dd0f-44db-b91e-18b42c77ed46` |

## By protocol version (v1 / v2) — M4-A
> `protocolVersion` 只来自显式字段或请求路径（`/mcp/v2`=v2，`/mcp`=v1）；
> 旧 envelope / 非 MCP 路由一律 `unknown`，不猜。

| Protocol | Executor | Requests | MCP requests | Errors | Tool calls | Trunc suspects |
|---|---|---|---:|---:|---:|---:|
| v1 | codemode | 20 | 20 | 1 | 11 | 12 |

## By client profile — M4-A

| Profile | Requests | MCP requests | Errors | Tool calls | Trunc suspects |
|---|---|---:|---:|---:|---:|
| gemini-text-json | 20 | 20 | 1 | 11 | 12 |

## Four-dimension ledger — platform × protocol × profile × build (M4-A)
> 每个桶独立统计；桶与桶之间不做硬比。`unknown` 是合法桶（旧 envelope / 缺字段）。

| Platform | Protocol | Executor | Profile | Build commit | Requests | MCP | Errors | Tool calls | Trunc | Eval modes | Servers[] | RequestId samples |
|---|---|---|---|---:|---:|---:|---:|---:|---|---|---|
| unknown | v1 | codemode | gemini-text-json | 5039ac69d4e514bc11cdcc4fb2ce19d7dd5e234a | 17 | 17 | 1 | 10 | 11 | unknown:17 | unknown | `0271e7ca-d2dd-44d8-8902-ad38f2157743`, `04ea8e1f-65a1-42d6-922d-37dd8eb7044e`, `05623334-9d25-4299-ac8d-e52f1cd8c252`, `08d8bf5a-069e-4db5-ac53-32f975c809a3`, `0a820ad5-dd0f-44db-b91e-18b42c77ed46` |
| gemini | v1 | codemode | gemini-text-json | 3dd206f7238491e93f15c3ce39bce37c0e4bceba | 3 | 3 | 0 | 1 | 1 | unknown:3 | unknown, github | `0442a80c-85a2-4fc1-a0fa-d8697ed42650`, `06b36205-bbd6-4df3-a619-741ffda52db9`, `0ec61a1a-1827-40fd-8f5d-4da717d78c69` |

## By servers[] (cross-upstream) — M4-A
> 只读 capture 显式 `servers[]`；缺失记 `unknown`，不从工具名反推。
> 一次请求串多个上游时，每个 server 各计一次；`multiServerRequests`=0。

| Server | Requests | MCP requests | Errors | Tool calls | Trunc suspects |
|---|---|---:|---:|---:|---:|
| unknown | 19 | 19 | 1 | 10 | 11 |
| github | 1 | 1 | 0 | 1 | 1 |

## By eval mode (active / passive) — M4-A
> `evalMode` 缺省/非法一律 `unknown`，绝不按时间或来源猜测。

| Eval mode | Requests | MCP requests | Errors | Tool calls | Trunc suspects |
|---|---|---:|---:|---:|---:|
| unknown | 20 | 20 | 1 | 11 | 12 |

## Tool calls (MCP method)
- tools/call: 11
- tools/list: 4
- initialize: 4
- notifications/initialized: 1

## Top upstream tools (legacy tally)
| Tool | Calls |
|---|---|
| execute_read | 7 |
| execute | 4 |

## Per-upstream stats (MCP tools/call)
| Upstream | Calls | Errors | Error rate | p50 ms | p95 ms | Avg ms | Truncated | Overflow | ModelTrunc | Error classes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| github | 10 | 1 | 0.1 | 2578 | 28777 | 5995 | 0 | 0 | 8 | upstream_4xx:1 |
| unknown | 10 | 0 | 0 | 17 | 904 | 179 | 4 | 0 | 0 | — |

## Per-MCP-tool stats
| Tool | Calls | Errors | Error rate | p50 ms | p95 ms | Avg ms | Truncated | Overflow | ModelTrunc | Error classes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| execute_read | 7 | 1 | 0.1429 | 2198 | 4545 | 2130 | 0 | 0 | 5 | upstream_4xx:1 |
| execute | 4 | 0 | 0 | 5825 | 28777 | 11454 | 0 | 0 | 3 | — |

## Truncation / overflow
> Three independent signals. "Model truncation suspects" is the silent case:
> the gateway wire was complete, but the model received a materially shorter,
> unmarked projection (e.g. model code calling slice(0, 150)). It is advisory-only.

| Signal | Count | Rate |
|---|---:|---:|
| Truncated responses (gateway wire) | 4 | 0.2 |
| Overflow captures (capture limit) | 0 | 0 |
| Model truncation suspects (silent, advisory) | 8 | 0.4 |

### Model truncation suspects by server
| Server | Suspects |
|---|---:|
| github | 8 |

### Model truncation suspects by tool
| Tool | Suspects |
|---|---:|
| execute_read | 5 |
| execute | 3 |

### Model truncation suspects by session
| Session | Suspects |
|---|---:|
| 84fc53cf-c9c7-4207-96a8-e9c0dcd697b3 | 4 |
| 2300fd1b-3d55-460e-9484-ad6babc559ac | 3 |
| ef3d080d-6fe0-40f0-b2d0-5bde5e32d994 | 1 |

## Projects (derived labels, batch 11)
> `projects[]` / `primaryProject` are deterministic tags derived at capture time
> from explicit owner/repo pairs, never client-declared identities. One request
> may carry several tags; each tag is counted independently. Projects are
> ORTHOGONAL to sessions — see `projectTimelines` in the JSON scorecard for
> the same project spanning multiple sessions (handoff).

| Project | Platforms | Requests | MCP requests | Errors | Tool calls | Trunc suspects | First ts | Last ts | SessionIds | RequestId samples |
|---|---|---:|---:|---:|---:|---:|---|---|---|---|
| github:Bruce-Yii/gemini-mcp-gateway | unknown, gemini | 7 | 7 | 0 | 7 | 5 | 2026-11-24T00:02:01.572Z | 2026-11-24T06:11:33.552Z | `84fc53cf-c9c7-4207-96a8-e9c0dcd697b3`, `99307365-3ce0-4769-8724-b0648281f5c2`, `ef3d080d-6fe0-40f0-b2d0-5bde5e32d994` | `08d8bf5a-069e-4db5-ac53-32f975c809a3`, `0d0fc47b-347c-43b7-a627-63e1f30b76d8`, `0ec61a1a-1827-40fd-8f5d-4da717d78c69`, `0f000d24-c8e6-4e71-945b-b870c44e3b7e`, `12979d99-30a0-4aaf-94b0-e7ae1a8a52cd` |
| github:Bruce-Yii/recruitment-agent | unknown | 4 | 4 | 1 | 4 | 3 | 2026-11-24T00:07:42.356Z | 2026-11-24T01:23:06.097Z | `2300fd1b-3d55-460e-9484-ad6babc559ac` | `0271e7ca-d2dd-44d8-8902-ad38f2157743`, `05623334-9d25-4299-ac8d-e52f1cd8c252`, `118148d9-d0f0-4139-af13-c4ae2f2116fc`, `147bc3f0-87c9-445e-8806-8be7463126c7` |

## Requests by day
| Day | Requests |
|---|---:|
| 2026-11-24 | 20 |

## Requests by hour (UTC)
| Hour | Requests |
|---|---:|
| 00:00 | 7 |
| 01:00 | 2 |
| 02:00 | 5 |
| 03:00 | 1 |
| 04:00 | 2 |
| 06:00 | 3 |

## Non-MCP routes (kept separate)
| Upstream | Calls | Errors | Error rate | p50 ms | p95 ms | Avg ms | Truncated | Overflow | ModelTrunc | Error classes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| POST /mcp | 20 | 0 | 0 | 774 | 9469 | 3087 | 4 | 0 | 8 | — |

## Error classes (MCP only)
| Class | Count |
|---|---|
| upstream_4xx | 1 |

## Route errors (non-MCP)
| Class | Count |
|---|---|
| — | 0 |

> Generated by `scripts/capture-digest.mjs`. Raw payloads remain in R2.

## Sessions / windows (batch 11)

> Analysis-only grouping of online capture envelopes. `windowId` is synthetic
> when no `sessionId` exists; original `requestId`/`sessionId` are untouched.
> Truncation suspects include gateway wire truncation and advisory model-side
> silent truncation; neither is a verdict. `projects` are derived labels and
> are ORTHOGONAL to these windows: one window may touch several projects, and
> one project may span several windows.

| Window | Strategy | SessionId | Platforms | Requests | MCP errors | Tool calls | Trunc suspects | First ts | Last ts | Projects | Client info | RequestId samples |
|---|---|---|---|---:|---:|---:|---:|---|---|---|---|---|
| session:99307365-3ce0-4769-8724-b0648281f5c2 | sessionId | 99307365-3ce0-4769-8724-b0648281f5c2 | unknown | 2 | 0 | 2 | 0 | 2026-11-24T00:02:01.572Z | 2026-11-24T00:02:19.664Z | `github:Bruce-Yii/gemini-mcp-gateway` | {"ip":"192.178.23.34"} | `0d0fc47b-347c-43b7-a627-63e1f30b76d8`, `1902a8ef-0bbd-4ab7-814f-2f55e1121f29` |
| session:2300fd1b-3d55-460e-9484-ad6babc559ac | sessionId | 2300fd1b-3d55-460e-9484-ad6babc559ac | unknown | 4 | 1 | 4 | 3 | 2026-11-24T00:07:42.356Z | 2026-11-24T01:23:06.097Z | `github:Bruce-Yii/recruitment-agent` | {"ip":"192.178.23.34"} | `05623334-9d25-4299-ac8d-e52f1cd8c252`, `147bc3f0-87c9-445e-8806-8be7463126c7`, `118148d9-d0f0-4139-af13-c4ae2f2116fc`, `0271e7ca-d2dd-44d8-8902-ad38f2157743` |
| session:3ae56079-12b5-4911-9713-b336f4aabd32 | sessionId | 3ae56079-12b5-4911-9713-b336f4aabd32 | unknown | 1 | 0 | 0 | 1 | 2026-11-24T00:57:24.088Z | 2026-11-24T00:57:24.088Z | — | {"ip":"66.249.83.225"} | `0ccce2ce-f2f6-4cee-ac85-ee83d7432477` |
| session:8c0d61df-9626-4fa7-99fc-45850ceba802 | sessionId | 8c0d61df-9626-4fa7-99fc-45850ceba802 | unknown | 1 | 0 | 0 | 1 | 2026-11-24T00:58:34.272Z | 2026-11-24T00:58:34.272Z | — | {"ip":"192.178.10.75"} | `04ea8e1f-65a1-42d6-922d-37dd8eb7044e` |
| session:a078abd9-7de2-48ee-b7d9-89285dea2130 | sessionId | a078abd9-7de2-48ee-b7d9-89285dea2130 | unknown | 1 | 0 | 0 | 1 | 2026-11-24T01:54:47.650Z | 2026-11-24T01:54:47.650Z | — | {"ip":"192.178.10.69"} | `0da73587-8601-481a-87f3-f0224db297e4` |
| session:84fc53cf-c9c7-4207-96a8-e9c0dcd697b3 | sessionId | 84fc53cf-c9c7-4207-96a8-e9c0dcd697b3 | unknown | 4 | 0 | 4 | 4 | 2026-11-24T02:17:57.286Z | 2026-11-24T03:10:10.854Z | `github:Bruce-Yii/gemini-mcp-gateway` | {"ip":"108.177.68.198"} | `0f000d24-c8e6-4e71-945b-b870c44e3b7e`, `18ce67bc-e6f0-4926-ac9a-71a07d821740`, `12979d99-30a0-4aaf-94b0-e7ae1a8a52cd`, `08d8bf5a-069e-4db5-ac53-32f975c809a3` |
| session:96612174-3e1d-4a87-ac18-bbe1ced3c177 | sessionId | 96612174-3e1d-4a87-ac18-bbe1ced3c177 | unknown | 1 | 0 | 0 | 0 | 2026-11-24T02:40:00.115Z | 2026-11-24T02:40:00.115Z | — | {"name":"mcp","version":"0.1.0"} | `0a820ad5-dd0f-44db-b91e-18b42c77ed46` |
| session:848f1c58-d557-49c2-a0e9-9d68a5c3caad | sessionId | 848f1c58-d557-49c2-a0e9-9d68a5c3caad | unknown | 1 | 0 | 0 | 1 | 2026-11-24T02:41:22.589Z | 2026-11-24T02:41:22.589Z | — | {"ip":"66.249.83.110"} | `0b19b65f-9631-41e3-90e9-db5c992efbb5` |
| session:60849da6-8e6f-4f82-bedb-dd91d8339ec3 | sessionId | 60849da6-8e6f-4f82-bedb-dd91d8339ec3 | unknown | 1 | 0 | 0 | 0 | 2026-11-24T04:07:34.349Z | 2026-11-24T04:07:34.349Z | — | {"name":"mcp","version":"0.1.0"} | `1920e2c6-f3e9-499f-9cc5-53ba17804446` |
| session:76f7f704-997b-4d43-935c-921aafd396ee | sessionId | 76f7f704-997b-4d43-935c-921aafd396ee | unknown | 1 | 0 | 0 | 0 | 2026-11-24T04:32:31.849Z | 2026-11-24T04:32:31.849Z | — | {"name":"mcp","version":"0.1.0"} | `0d3f197c-ae64-49cd-b7f7-a17017acdd1c` |
| session:73d9b270-c9b2-4f95-b8c9-7388e3f8fdf1 | sessionId | 73d9b270-c9b2-4f95-b8c9-7388e3f8fdf1 | gemini | 1 | 0 | 0 | 0 | 2026-11-24T06:10:52.107Z | 2026-11-24T06:10:52.107Z | — | {"ip":"192.178.10.70"} | `0442a80c-85a2-4fc1-a0fa-d8697ed42650` |
| session:2857ba2b-5cdb-4bd4-bd0e-9a456403fa34 | sessionId | 2857ba2b-5cdb-4bd4-bd0e-9a456403fa34 | gemini | 1 | 0 | 0 | 0 | 2026-11-24T06:10:58.006Z | 2026-11-24T06:10:58.006Z | — | {"name":"Gemini","version":"1.0.0"} | `06b36205-bbd6-4df3-a619-741ffda52db9` |
| session:ef3d080d-6fe0-40f0-b2d0-5bde5e32d994 | sessionId | ef3d080d-6fe0-40f0-b2d0-5bde5e32d994 | gemini | 1 | 0 | 1 | 1 | 2026-11-24T06:11:33.552Z | 2026-11-24T06:11:33.552Z | `github:Bruce-Yii/gemini-mcp-gateway` | {"ip":"108.177.68.36"} | `0ec61a1a-1827-40fd-8f5d-4da717d78c69` |

## Project timelines (batch 11, cross-session handoff)

> One project key can appear in multiple independent sessions/windows. Rows are
> ordered by first timestamp so a handoff is visible. Project tags are derived
> labels; a shared key does NOT prove the same client or the same task.

| Project | SessionId | Primary requests | Requests | MCP requests | Errors | Tool calls | Trunc suspects | First ts | Last ts | RequestId samples |
|---|---|---:|---:|---:|---:|---:|---:|---|---|---|
| github:Bruce-Yii/recruitment-agent | 2300fd1b-3d55-460e-9484-ad6babc559ac | 4 | 4 | 4 | 1 | 4 | 3 | 2026-11-24T00:07:42.356Z | 2026-11-24T01:23:06.097Z | `0271e7ca-d2dd-44d8-8902-ad38f2157743`, `05623334-9d25-4299-ac8d-e52f1cd8c252`, `118148d9-d0f0-4139-af13-c4ae2f2116fc`, `147bc3f0-87c9-445e-8806-8be7463126c7` |
| github:Bruce-Yii/gemini-mcp-gateway | 84fc53cf-c9c7-4207-96a8-e9c0dcd697b3 | 4 | 4 | 4 | 0 | 4 | 4 | 2026-11-24T02:17:57.286Z | 2026-11-24T03:10:10.854Z | `08d8bf5a-069e-4db5-ac53-32f975c809a3`, `0f000d24-c8e6-4e71-945b-b870c44e3b7e`, `12979d99-30a0-4aaf-94b0-e7ae1a8a52cd`, `18ce67bc-e6f0-4926-ac9a-71a07d821740` |
| github:Bruce-Yii/gemini-mcp-gateway | 99307365-3ce0-4769-8724-b0648281f5c2 | 2 | 2 | 2 | 0 | 2 | 0 | 2026-11-24T00:02:01.572Z | 2026-11-24T00:02:19.664Z | `0d0fc47b-347c-43b7-a627-63e1f30b76d8`, `1902a8ef-0bbd-4ab7-814f-2f55e1121f29` |
| github:Bruce-Yii/gemini-mcp-gateway | ef3d080d-6fe0-40f0-b2d0-5bde5e32d994 | 1 | 1 | 1 | 0 | 1 | 1 | 2026-11-24T06:11:33.552Z | 2026-11-24T06:11:33.552Z | `0ec61a1a-1827-40fd-8f5d-4da717d78c69` |
