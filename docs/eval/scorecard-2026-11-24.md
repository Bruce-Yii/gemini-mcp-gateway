# Capture Scorecard — 2026-11-24

| Metric | Value |
|---|---|
| Requests | 20 |
| MCP POST requests | 20 |
| Non-MCP routes | 0 |
| Errors (HTTP >= 400) | 2 |
| MCP errors | 2 |
| p50 latency | 25 ms |
| p95 latency | 3662 ms |
| Avg latency | 1369 ms |
| Response bytes | 139846 |
| Truncated responses (gateway wire) | 5 |
| Overflow captures (capture limit) | 0 |
| Truncation rate | 0.25 |
| Overflow rate | 0 |
| Model truncation suspects (silent) | 6 |
| Model truncation rate | 0.3 |
| Overall error rate | 0.1 |

## By client platform (batch 13)
> 每个平台的指标单独成行，绝不互相污染。`clientPlatform` 只接受显式且可识别的值；
> 缺失 / null / 非字符串 / 未知值一律进 `unknown`，不根据 UA / 工具名猜测。
> 旧 envelope（无字段）全部落在 `unknown`，不会被算进 Gemini。
> 平台之间**不做硬比**：baseline 与任务分母按平台独立（见 batch-13-platform-eval.md）。

| Platform | Requests | MCP requests | Errors | Tool calls | Trunc suspects | Sessions | Projects | RequestId samples |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| gemini | 8 | 8 | 0 | 4 | 5 | 7 | 2 | `00c1d059-6d78-4c98-868f-a5d0fbaa5c82`, `03a21275-f6ac-4704-91c0-9b97fcee54b4`, `03b09af2-3e0b-4148-80c4-320071112a29`, `0442a80c-85a2-4fc1-a0fa-d8697ed42650`, `06b36205-bbd6-4df3-a619-741ffda52db9` |
| unknown | 12 | 12 | 2 | 4 | 6 | 9 | 2 | `0271e7ca-d2dd-44d8-8902-ad38f2157743`, `04ea8e1f-65a1-42d6-922d-37dd8eb7044e`, `05623334-9d25-4299-ac8d-e52f1cd8c252`, `08d8bf5a-069e-4db5-ac53-32f975c809a3`, `0a820ad5-dd0f-44db-b91e-18b42c77ed46` |

## By protocol version (v1 / v2) — M4-A
> `protocolVersion` 只来自显式字段或请求路径（`/mcp/v2`=v2，`/mcp`=v1）；
> 旧 envelope / 非 MCP 路由一律 `unknown`，不猜。

| Protocol | Executor | Requests | MCP requests | Errors | Tool calls | Trunc suspects |
|---|---|---|---:|---:|---:|---:|
| v1 | codemode | 20 | 20 | 2 | 8 | 11 |

## By client profile — M4-A

| Profile | Requests | MCP requests | Errors | Tool calls | Trunc suspects |
|---|---|---:|---:|---:|---:|
| gemini-text-json | 20 | 20 | 2 | 8 | 11 |

## Four-dimension ledger — platform × protocol × profile × build (M4-A)
> 每个桶独立统计；桶与桶之间不做硬比。`unknown` 是合法桶（旧 envelope / 缺字段）。

| Platform | Protocol | Executor | Profile | Build commit | Requests | MCP | Errors | Tool calls | Trunc | Eval modes | Servers[] | RequestId samples |
|---|---|---|---|---:|---:|---:|---:|---:|---|---|---|
| unknown | v1 | codemode | gemini-text-json | 5039ac69d4e514bc11cdcc4fb2ce19d7dd5e234a | 10 | 10 | 0 | 4 | 6 | unknown:10 | unknown | `0271e7ca-d2dd-44d8-8902-ad38f2157743`, `04ea8e1f-65a1-42d6-922d-37dd8eb7044e`, `05623334-9d25-4299-ac8d-e52f1cd8c252`, `08d8bf5a-069e-4db5-ac53-32f975c809a3`, `0a820ad5-dd0f-44db-b91e-18b42c77ed46` |
| gemini | v1 | codemode | gemini-text-json | 3dd206f7238491e93f15c3ce39bce37c0e4bceba | 8 | 8 | 0 | 4 | 5 | unknown:8 | github, vercel, unknown, notion, linear, figma | `00c1d059-6d78-4c98-868f-a5d0fbaa5c82`, `03a21275-f6ac-4704-91c0-9b97fcee54b4`, `03b09af2-3e0b-4148-80c4-320071112a29`, `0442a80c-85a2-4fc1-a0fa-d8697ed42650`, `06b36205-bbd6-4df3-a619-741ffda52db9` |
| unknown | v1 | codemode | gemini-text-json | 9eb0c7aa3d10d777d3066f858a67be39cc8303dd | 2 | 2 | 2 | 0 | 0 | unknown:2 | unknown | `0b8671d5-4ee9-46bd-a550-0f106748396d`, `0dbba1c9-7c11-4c64-8655-bbbb2cf0b1f1` |

## By servers[] (cross-upstream) — M4-A
> 只读 capture 显式 `servers[]`；缺失记 `unknown`，不从工具名反推。
> 一次请求串多个上游时，每个 server 各计一次；`multiServerRequests`=2。

| Server | Requests | MCP requests | Errors | Tool calls | Trunc suspects |
|---|---|---:|---:|---:|---:|
| unknown | 15 | 15 | 2 | 4 | 7 |
| github | 5 | 5 | 0 | 4 | 4 |
| vercel | 2 | 2 | 0 | 1 | 1 |
| figma | 1 | 1 | 0 | 0 | 0 |
| linear | 1 | 1 | 0 | 0 | 0 |
| notion | 1 | 1 | 0 | 0 | 0 |

## By eval mode (active / passive) — M4-A
> `evalMode` 缺省/非法一律 `unknown`，绝不按时间或来源猜测。

| Eval mode | Requests | MCP requests | Errors | Tool calls | Trunc suspects |
|---|---|---:|---:|---:|---:|
| unknown | 20 | 20 | 2 | 8 | 11 |

## Tool calls (MCP method)
- tools/call: 8
- tools/list: 5
- initialize: 3
- notifications/initialized: 2

## Top upstream tools (legacy tally)
| Tool | Calls |
|---|---|
| execute_read | 5 |
| execute | 3 |

## Per-upstream stats (MCP tools/call)
| Upstream | Calls | Errors | Error rate | p50 ms | p95 ms | Avg ms | Truncated | Overflow | ModelTrunc | Error classes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| unknown | 10 | 0 | 0 | 17 | 904 | 161 | 5 | 0 | 0 | — |
| github | 8 | 0 | 0 | 2578 | 9469 | 3220 | 0 | 0 | 6 | — |

## Per-MCP-tool stats
| Tool | Calls | Errors | Error rate | p50 ms | p95 ms | Avg ms | Truncated | Overflow | ModelTrunc | Error classes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| execute_read | 5 | 0 | 0 | 2578 | 3662 | 2340 | 0 | 0 | 4 | — |
| execute | 3 | 0 | 0 | 2849 | 9469 | 4687 | 0 | 0 | 2 | — |

## Upstream connect failures (eval closure)
> 来自结构化 capture 事件 `upstream_connect{ok:false}`，不读模型/正文；用于被动侧看见
> “哪个上游连不上/需要重新授权”，而不是只看成功的 tools/call。

| Server | Failures | Error classes | RequestId samples |
|---|---:|---|---|
| linear | 2 | auth:2 | `074fd58c-c9be-41a2-9249-0d9fb619e83c`, `0a820ad5-dd0f-44db-b91e-18b42c77ed46` |
| notion | 2 | connect:2 | `074fd58c-c9be-41a2-9249-0d9fb619e83c`, `0a820ad5-dd0f-44db-b91e-18b42c77ed46` |

## Service state snapshots (codemode.services())
> 来自 `gateway_helper{helper:"services"}` 的冷启动快照（name/toolCount/status/online/needsReauth）；
> 它不是 live 健康检查。`latest` 是该服务在本窗口的最后一次观察，历史 counts 只作证据。

| Service | Snapshots | Tool count | Status counts | Latest | RequestId samples |
|---|---:|---:|---|---|---|
| — | 0 | 0 | — | — | — |

## Gateway helper calls (eval closure)
> 来自 `gateway_helper` 的全部 helper 调用（services / listTools / remainingCalls）。

| Helper | Calls | Last payload |
|---|---:|---|
| — | 0 | — |

## Truncation / overflow
> Three independent signals. "Model truncation suspects" is the silent case:
> the gateway wire was complete, but the model received a materially shorter,
> unmarked projection (e.g. model code calling slice(0, 150)). It is advisory-only.

| Signal | Count | Rate |
|---|---:|---:|
| Truncated responses (gateway wire) | 5 | 0.25 |
| Overflow captures (capture limit) | 0 | 0 |
| Model truncation suspects (silent, advisory) | 6 | 0.3 |

### Model truncation suspects by server
| Server | Suspects |
|---|---:|
| github | 6 |

### Model truncation suspects by tool
| Tool | Suspects |
|---|---:|
| execute_read | 4 |
| execute | 2 |

### Model truncation suspects by session
| Session | Suspects |
|---|---:|
| 033ebd44-57ac-4766-bbdb-7decb45ee3fb | 1 |
| 0fc836c7-42a3-4384-81f9-96ffd8fddd6f | 1 |
| 2300fd1b-3d55-460e-9484-ad6babc559ac | 1 |
| 49939f51-7233-4858-a42e-18030de9ec4d | 1 |
| 84fc53cf-c9c7-4207-96a8-e9c0dcd697b3 | 1 |
| ef3d080d-6fe0-40f0-b2d0-5bde5e32d994 | 1 |

## Projects (derived labels, batch 11)
> `projects[]` / `primaryProject` are deterministic tags derived at capture time
> from explicit owner/repo pairs, never client-declared identities. One request
> may carry several tags; each tag is counted independently. Projects are
> ORTHOGONAL to sessions — see `projectTimelines` in the JSON scorecard for
> the same project spanning multiple sessions (handoff).

| Project | Platforms | Requests | MCP requests | Errors | Tool calls | Trunc suspects | First ts | Last ts | SessionIds | RequestId samples |
|---|---|---:|---:|---:|---:|---:|---|---|---|---|
| github:Bruce-Yii/gemini-mcp-gateway | gemini, unknown | 5 | 5 | 0 | 5 | 4 | 2026-11-24T00:02:01.572Z | 2026-11-24T15:40:22.133Z | `033ebd44-57ac-4766-bbdb-7decb45ee3fb`, `84fc53cf-c9c7-4207-96a8-e9c0dcd697b3`, `49939f51-7233-4858-a42e-18030de9ec4d`, `99307365-3ce0-4769-8724-b0648281f5c2`, `ef3d080d-6fe0-40f0-b2d0-5bde5e32d994` | `00c1d059-6d78-4c98-868f-a5d0fbaa5c82`, `08d8bf5a-069e-4db5-ac53-32f975c809a3`, `0a8bd8ef-c934-4054-a1ef-87f0e7d15c97`, `0d0fc47b-347c-43b7-a627-63e1f30b76d8`, `0ec61a1a-1827-40fd-8f5d-4da717d78c69` |
| github:Bruce-Yii/recruitment-agent | unknown, gemini | 3 | 3 | 0 | 3 | 2 | 2026-11-24T00:07:42.356Z | 2026-11-24T13:31:16.312Z | `2300fd1b-3d55-460e-9484-ad6babc559ac`, `0fc836c7-42a3-4384-81f9-96ffd8fddd6f` | `0271e7ca-d2dd-44d8-8902-ad38f2157743`, `03a21275-f6ac-4704-91c0-9b97fcee54b4`, `05623334-9d25-4299-ac8d-e52f1cd8c252` |

## Requests by day
| Day | Requests |
|---|---:|
| 2026-11-24 | 20 |

## Requests by hour (UTC)
| Hour | Requests |
|---|---:|
| 00:00 | 4 |
| 01:00 | 2 |
| 02:00 | 2 |
| 03:00 | 1 |
| 04:00 | 1 |
| 06:00 | 3 |
| 12:00 | 1 |
| 13:00 | 3 |
| 15:00 | 1 |
| 16:00 | 2 |

## Non-MCP routes (kept separate)
| Upstream | Calls | Errors | Error rate | p50 ms | p95 ms | Avg ms | Truncated | Overflow | ModelTrunc | Error classes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| POST /mcp | 20 | 0 | 0 | 25 | 3662 | 1369 | 5 | 0 | 6 | — |

## Error classes (MCP only)
| Class | Count |
|---|---|
| auth | 2 |

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
| session:99307365-3ce0-4769-8724-b0648281f5c2 | sessionId | 99307365-3ce0-4769-8724-b0648281f5c2 | unknown | 1 | 0 | 1 | 0 | 2026-11-24T00:02:01.572Z | 2026-11-24T00:02:01.572Z | `github:Bruce-Yii/gemini-mcp-gateway` | {"ip":"192.178.23.34"} | `0d0fc47b-347c-43b7-a627-63e1f30b76d8` |
| session:2300fd1b-3d55-460e-9484-ad6babc559ac | sessionId | 2300fd1b-3d55-460e-9484-ad6babc559ac | unknown | 2 | 0 | 2 | 1 | 2026-11-24T00:07:42.356Z | 2026-11-24T01:23:06.097Z | `github:Bruce-Yii/recruitment-agent` | {"ip":"192.178.23.34"} | `05623334-9d25-4299-ac8d-e52f1cd8c252`, `0271e7ca-d2dd-44d8-8902-ad38f2157743` |
| session:3ae56079-12b5-4911-9713-b336f4aabd32 | sessionId | 3ae56079-12b5-4911-9713-b336f4aabd32 | unknown | 1 | 0 | 0 | 1 | 2026-11-24T00:57:24.088Z | 2026-11-24T00:57:24.088Z | — | {"ip":"66.249.83.225"} | `0ccce2ce-f2f6-4cee-ac85-ee83d7432477` |
| session:8c0d61df-9626-4fa7-99fc-45850ceba802 | sessionId | 8c0d61df-9626-4fa7-99fc-45850ceba802 | unknown | 1 | 0 | 0 | 1 | 2026-11-24T00:58:34.272Z | 2026-11-24T00:58:34.272Z | — | {"ip":"192.178.10.75"} | `04ea8e1f-65a1-42d6-922d-37dd8eb7044e` |
| session:a078abd9-7de2-48ee-b7d9-89285dea2130 | sessionId | a078abd9-7de2-48ee-b7d9-89285dea2130 | unknown | 1 | 0 | 0 | 1 | 2026-11-24T01:54:47.650Z | 2026-11-24T01:54:47.650Z | — | {"ip":"192.178.10.69"} | `0da73587-8601-481a-87f3-f0224db297e4` |
| session:96612174-3e1d-4a87-ac18-bbe1ced3c177 | sessionId | 96612174-3e1d-4a87-ac18-bbe1ced3c177 | unknown | 1 | 0 | 0 | 0 | 2026-11-24T02:40:00.115Z | 2026-11-24T02:40:00.115Z | — | {"name":"mcp","version":"0.1.0"} | `0a820ad5-dd0f-44db-b91e-18b42c77ed46` |
| session:848f1c58-d557-49c2-a0e9-9d68a5c3caad | sessionId | 848f1c58-d557-49c2-a0e9-9d68a5c3caad | unknown | 1 | 0 | 0 | 1 | 2026-11-24T02:41:22.589Z | 2026-11-24T02:41:22.589Z | — | {"ip":"66.249.83.110"} | `0b19b65f-9631-41e3-90e9-db5c992efbb5` |
| session:84fc53cf-c9c7-4207-96a8-e9c0dcd697b3 | sessionId | 84fc53cf-c9c7-4207-96a8-e9c0dcd697b3 | unknown | 1 | 0 | 1 | 1 | 2026-11-24T03:10:10.854Z | 2026-11-24T03:10:10.854Z | `github:Bruce-Yii/gemini-mcp-gateway` | {"ip":"108.177.68.101"} | `08d8bf5a-069e-4db5-ac53-32f975c809a3` |
| session:76f7f704-997b-4d43-935c-921aafd396ee | sessionId | 76f7f704-997b-4d43-935c-921aafd396ee | unknown | 1 | 0 | 0 | 0 | 2026-11-24T04:32:31.849Z | 2026-11-24T04:32:31.849Z | — | {"name":"mcp","version":"0.1.0"} | `0d3f197c-ae64-49cd-b7f7-a17017acdd1c` |
| session:73d9b270-c9b2-4f95-b8c9-7388e3f8fdf1 | sessionId | 73d9b270-c9b2-4f95-b8c9-7388e3f8fdf1 | gemini | 1 | 0 | 0 | 0 | 2026-11-24T06:10:52.107Z | 2026-11-24T06:10:52.107Z | — | {"ip":"192.178.10.70"} | `0442a80c-85a2-4fc1-a0fa-d8697ed42650` |
| session:2857ba2b-5cdb-4bd4-bd0e-9a456403fa34 | sessionId | 2857ba2b-5cdb-4bd4-bd0e-9a456403fa34 | gemini | 1 | 0 | 0 | 0 | 2026-11-24T06:10:58.006Z | 2026-11-24T06:10:58.006Z | — | {"name":"Gemini","version":"1.0.0"} | `06b36205-bbd6-4df3-a619-741ffda52db9` |
| session:ef3d080d-6fe0-40f0-b2d0-5bde5e32d994 | sessionId | ef3d080d-6fe0-40f0-b2d0-5bde5e32d994 | gemini | 1 | 0 | 1 | 1 | 2026-11-24T06:11:33.552Z | 2026-11-24T06:11:33.552Z | `github:Bruce-Yii/gemini-mcp-gateway` | {"ip":"108.177.68.36"} | `0ec61a1a-1827-40fd-8f5d-4da717d78c69` |
| session:033ebd44-57ac-4766-bbdb-7decb45ee3fb | sessionId | 033ebd44-57ac-4766-bbdb-7decb45ee3fb | gemini | 1 | 0 | 1 | 1 | 2026-11-24T12:57:27.829Z | 2026-11-24T12:57:27.829Z | `github:Bruce-Yii/gemini-mcp-gateway` | {"ip":"192.178.23.37"} | `00c1d059-6d78-4c98-868f-a5d0fbaa5c82` |
| session:0fc836c7-42a3-4384-81f9-96ffd8fddd6f | sessionId | 0fc836c7-42a3-4384-81f9-96ffd8fddd6f | gemini | 1 | 0 | 1 | 1 | 2026-11-24T13:31:16.312Z | 2026-11-24T13:31:16.312Z | `github:Bruce-Yii/recruitment-agent` | {"ip":"192.178.23.38"} | `03a21275-f6ac-4704-91c0-9b97fcee54b4` |
| session:73ea6fb7-d680-4b09-96f4-14894887182a | sessionId | 73ea6fb7-d680-4b09-96f4-14894887182a | gemini | 2 | 0 | 0 | 1 | 2026-11-24T13:55:19.751Z | 2026-11-24T13:55:20.946Z | — | {"ip":"192.178.10.68"} | `074fd58c-c9be-41a2-9249-0d9fb619e83c`, `03b09af2-3e0b-4148-80c4-320071112a29` |
| session:49939f51-7233-4858-a42e-18030de9ec4d | sessionId | 49939f51-7233-4858-a42e-18030de9ec4d | gemini | 1 | 0 | 1 | 1 | 2026-11-24T15:40:22.133Z | 2026-11-24T15:40:22.133Z | `github:Bruce-Yii/gemini-mcp-gateway` | {"ip":"192.178.23.32"} | `0a8bd8ef-c934-4054-a1ef-87f0e7d15c97` |
| window:001 | first-request | — | unknown | 2 | 2 | 0 | 0 | 2026-11-24T16:19:17.781Z | 2026-11-24T16:29:20.793Z | — | {"ip":"9.129.50.15"} | `0b8671d5-4ee9-46bd-a550-0f106748396d`, `0dbba1c9-7c11-4c64-8655-bbbb2cf0b1f1` |

## Project timelines (batch 11, cross-session handoff)

> One project key can appear in multiple independent sessions/windows. Rows are
> ordered by first timestamp so a handoff is visible. Project tags are derived
> labels; a shared key does NOT prove the same client or the same task.

| Project | SessionId | Primary requests | Requests | MCP requests | Errors | Tool calls | Trunc suspects | First ts | Last ts | RequestId samples |
|---|---|---:|---:|---:|---:|---:|---:|---|---|---|
| github:Bruce-Yii/gemini-mcp-gateway | 033ebd44-57ac-4766-bbdb-7decb45ee3fb | 1 | 1 | 1 | 0 | 1 | 1 | 2026-11-24T12:57:27.829Z | 2026-11-24T12:57:27.829Z | `00c1d059-6d78-4c98-868f-a5d0fbaa5c82` |
| github:Bruce-Yii/recruitment-agent | 2300fd1b-3d55-460e-9484-ad6babc559ac | 2 | 2 | 2 | 0 | 2 | 1 | 2026-11-24T00:07:42.356Z | 2026-11-24T01:23:06.097Z | `0271e7ca-d2dd-44d8-8902-ad38f2157743`, `05623334-9d25-4299-ac8d-e52f1cd8c252` |
| github:Bruce-Yii/recruitment-agent | 0fc836c7-42a3-4384-81f9-96ffd8fddd6f | 1 | 1 | 1 | 0 | 1 | 1 | 2026-11-24T13:31:16.312Z | 2026-11-24T13:31:16.312Z | `03a21275-f6ac-4704-91c0-9b97fcee54b4` |
| github:Bruce-Yii/gemini-mcp-gateway | 84fc53cf-c9c7-4207-96a8-e9c0dcd697b3 | 1 | 1 | 1 | 0 | 1 | 1 | 2026-11-24T03:10:10.854Z | 2026-11-24T03:10:10.854Z | `08d8bf5a-069e-4db5-ac53-32f975c809a3` |
| github:Bruce-Yii/gemini-mcp-gateway | 49939f51-7233-4858-a42e-18030de9ec4d | 1 | 1 | 1 | 0 | 1 | 1 | 2026-11-24T15:40:22.133Z | 2026-11-24T15:40:22.133Z | `0a8bd8ef-c934-4054-a1ef-87f0e7d15c97` |
| github:Bruce-Yii/gemini-mcp-gateway | 99307365-3ce0-4769-8724-b0648281f5c2 | 1 | 1 | 1 | 0 | 1 | 0 | 2026-11-24T00:02:01.572Z | 2026-11-24T00:02:01.572Z | `0d0fc47b-347c-43b7-a627-63e1f30b76d8` |
| github:Bruce-Yii/gemini-mcp-gateway | ef3d080d-6fe0-40f0-b2d0-5bde5e32d994 | 1 | 1 | 1 | 0 | 1 | 1 | 2026-11-24T06:11:33.552Z | 2026-11-24T06:11:33.552Z | `0ec61a1a-1827-40fd-8f5d-4da717d78c69` |
