# Capture Scorecard — 2026-11-24

| Metric | Value |
|---|---|
| Requests | 401 |
| MCP POST requests | 401 |
| Non-MCP routes | 0 |
| Errors (HTTP >= 400) | 18 |
| MCP errors | 18 |
| p50 latency | 26 ms |
| p95 latency | 8455 ms |
| Avg latency | 2007 ms |
| Response bytes | 2739744 |
| Truncated responses (gateway wire) | 3 |
| Overflow captures (capture limit) | 0 |
| Truncation rate | 0.0075 |
| Overflow rate | 0 |
| Model truncation suspects (silent) | 110 |
| Model truncation rate | 0.2743 |
| Overall error rate | 0.0449 |

## By client platform (batch 13)
> 每个平台的指标单独成行，绝不互相污染。`clientPlatform` 只接受显式且可识别的值；
> 缺失 / null / 非字符串 / 未知值一律进 `unknown`，不根据 UA / 工具名猜测。
> 旧 envelope（无字段）全部落在 `unknown`，不会被算进 Gemini。
> 平台之间**不做硬比**：baseline 与任务分母按平台独立（见 batch-13-platform-eval.md）。

| Platform | Requests | MCP requests | Errors | Tool calls | Trunc suspects | Sessions | Projects | RequestId samples |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| gemini | 161 | 161 | 3 | 60 | 42 | 42 | 2 | `00681e06-efa5-4e53-b605-275d57364349`, `00c1d059-6d78-4c98-868f-a5d0fbaa5c82`, `029529fb-078d-4f44-8e7e-4de3249fb826`, `03a21275-f6ac-4704-91c0-9b97fcee54b4`, `03b09af2-3e0b-4148-80c4-320071112a29` |
| chatgpt | 19 | 19 | 2 | 8 | 1 | 5 | 1 | `0178810f-e0ec-4296-b9c3-298c569dbbcb`, `0a3d1091-980e-4d98-ac55-abe8fa2f4003`, `133571d5-73ca-4d25-8a3e-639d841332f4`, `276da6ce-0392-40e5-b0b1-8b54f40ec848`, `3cf07cb5-0ce4-4b0a-91c2-8fccc491ef16` |
| unknown | 221 | 221 | 13 | 98 | 70 | 33 | 2 | `0271e7ca-d2dd-44d8-8902-ad38f2157743`, `04ea8e1f-65a1-42d6-922d-37dd8eb7044e`, `05623334-9d25-4299-ac8d-e52f1cd8c252`, `08d8bf5a-069e-4db5-ac53-32f975c809a3`, `0a820ad5-dd0f-44db-b91e-18b42c77ed46` |

## By protocol version (v1 / v2) — M4-A
> `protocolVersion` 只来自显式字段或请求路径（`/mcp/v2`=v2，`/mcp`=v1）；
> 旧 envelope / 非 MCP 路由一律 `unknown`，不猜。

| Protocol | Executor | Requests | MCP requests | Errors | Tool calls | Trunc suspects |
|---|---|---|---:|---:|---:|---:|
| v1 | codemode | 401 | 401 | 18 | 166 | 113 |

## By client profile — M4-A

| Profile | Requests | MCP requests | Errors | Tool calls | Trunc suspects |
|---|---|---:|---:|---:|---:|
| gemini-text-json | 382 | 382 | 16 | 158 | 112 |
| chatgpt-structured | 19 | 19 | 2 | 8 | 1 |

## Four-dimension ledger — platform × protocol × profile × build (M4-A)
> 每个桶独立统计；桶与桶之间不做硬比。`unknown` 是合法桶（旧 envelope / 缺字段）。

| Platform | Protocol | Executor | Profile | Build commit | Requests | MCP | Errors | Tool calls | Trunc | Eval modes | Servers[] | RequestId samples |
|---|---|---|---|---:|---:|---:|---:|---:|---|---|---|
| unknown | v1 | codemode | gemini-text-json | 5039ac69d4e514bc11cdcc4fb2ce19d7dd5e234a | 206 | 206 | 6 | 97 | 69 | unknown:206 | unknown | `0271e7ca-d2dd-44d8-8902-ad38f2157743`, `04ea8e1f-65a1-42d6-922d-37dd8eb7044e`, `05623334-9d25-4299-ac8d-e52f1cd8c252`, `08d8bf5a-069e-4db5-ac53-32f975c809a3`, `0a820ad5-dd0f-44db-b91e-18b42c77ed46` |
| gemini | v1 | codemode | gemini-text-json | 3dd206f7238491e93f15c3ce39bce37c0e4bceba | 95 | 95 | 1 | 34 | 24 | unknown:95 | github, vercel, unknown, notion, linear, figma | `00c1d059-6d78-4c98-868f-a5d0fbaa5c82`, `03a21275-f6ac-4704-91c0-9b97fcee54b4`, `03b09af2-3e0b-4148-80c4-320071112a29`, `0442a80c-85a2-4fc1-a0fa-d8697ed42650`, `06b36205-bbd6-4df3-a619-741ffda52db9` |
| gemini | v1 | codemode | gemini-text-json | f2002d9ca48e55292eb824faa10b85b39ea35440 | 59 | 59 | 2 | 24 | 16 | unknown:59 | unknown, github, notion, linear, vercel, figma | `00681e06-efa5-4e53-b605-275d57364349`, `029529fb-078d-4f44-8e7e-4de3249fb826`, `068de11b-c2e0-4e9d-9263-12fff614b558`, `082b9b4f-17a6-4559-bd54-09042822e203`, `0959012e-617f-4795-a7b1-00396a45b968` |
| chatgpt | v1 | codemode | chatgpt-structured | 9eb0c7aa3d10d777d3066f858a67be39cc8303dd | 10 | 10 | 2 | 0 | 0 | unknown:10 | github, notion, vercel, linear, figma, unknown | `133571d5-73ca-4d25-8a3e-639d841332f4`, `5905c741-b982-41b4-8f20-42396bd7c31c`, `7486ed97-f666-4e1b-8661-644f6b1d93e9`, `7fbb79d6-9c37-4961-bdd9-af77814b4b48`, `841e0078-e70b-4ec8-8c37-99db4975fcf9` |
| chatgpt | v1 | codemode | chatgpt-structured | 42caaf2b9b8d8ce2f894efb2124a4036bf58ce72 | 9 | 9 | 0 | 8 | 1 | unknown:9 | github, linear, notion, vercel, unknown | `0178810f-e0ec-4296-b9c3-298c569dbbcb`, `0a3d1091-980e-4d98-ac55-abe8fa2f4003`, `276da6ce-0392-40e5-b0b1-8b54f40ec848`, `3cf07cb5-0ce4-4b0a-91c2-8fccc491ef16`, `5327f5a2-d334-4eb6-9fdc-0924e9bce923` |
| unknown | v1 | codemode | gemini-text-json | 3dd206f7238491e93f15c3ce39bce37c0e4bceba | 8 | 8 | 0 | 1 | 1 | unknown:8 | unknown, github, notion, vercel, figma, linear | `2494f7c3-2dc2-495c-a695-172014a69daf`, `31f79007-5823-441e-b0e7-378689e1e1e1`, `7a538363-ced2-4d10-87bb-ec871a5806b1`, `8390fdc8-2d28-4ede-b2a7-cb2cdb2d480f`, `b783b5c0-d830-48ac-8cc6-d0d7c7cb346b` |
| unknown | v1 | codemode | gemini-text-json | 9eb0c7aa3d10d777d3066f858a67be39cc8303dd | 7 | 7 | 7 | 0 | 0 | unknown:7 | unknown | `0b8671d5-4ee9-46bd-a550-0f106748396d`, `0dbba1c9-7c11-4c64-8655-bbbb2cf0b1f1`, `55cf0735-8b44-4cab-8296-bf360968652e`, `b3f8452d-1e7f-4cf8-8c85-9fdb2a0aec26`, `dba86fa1-ca03-42a7-8408-b731aca9cf31` |
| gemini | v1 | codemode | gemini-text-json | 42caaf2b9b8d8ce2f894efb2124a4036bf58ce72 | 5 | 5 | 0 | 2 | 2 | unknown:5 | github, notion, unknown, linear, vercel, figma | `36ba515f-01d2-4163-a8eb-63c277314411`, `436b85df-f75c-4770-83d4-b73a2eaa0433`, `4f6d4089-a5f0-454d-882a-918c4b6e9dba`, `622e83d5-b9ad-4109-a529-62184a1a9e7d`, `77171d13-71f1-49b3-b213-2a618fb077b5` |
| gemini | v1 | codemode | gemini-text-json | 5039ac69d4e514bc11cdcc4fb2ce19d7dd5e234a | 2 | 2 | 0 | 0 | 0 | unknown:2 | unknown | `b3283f6d-9b26-4044-982f-7b2ea1f59a1a`, `ca34bf94-5250-4db9-b045-1ac167a4b49c` |

## By servers[] (cross-upstream) — M4-A
> 只读 capture 显式 `servers[]`；缺失记 `unknown`，不从工具名反推。
> 一次请求串多个上游时，每个 server 各计一次；`multiServerRequests`=21。

| Server | Requests | MCP requests | Errors | Tool calls | Trunc suspects |
|---|---|---:|---:|---:|---:|
| unknown | 328 | 328 | 15 | 107 | 69 |
| github | 70 | 70 | 3 | 56 | 43 |
| vercel | 21 | 21 | 1 | 7 | 5 |
| linear | 18 | 18 | 1 | 4 | 2 |
| notion | 17 | 17 | 1 | 3 | 3 |
| figma | 16 | 16 | 1 | 2 | 1 |

## By eval mode (active / passive) — M4-A
> `evalMode` 缺省/非法一律 `unknown`，绝不按时间或来源猜测。

| Eval mode | Requests | MCP requests | Errors | Tool calls | Trunc suspects |
|---|---|---:|---:|---:|---:|
| unknown | 401 | 401 | 18 | 166 | 113 |

## Tool calls (MCP method)
- tools/call: 166
- tools/list: 97
- initialize: 66
- notifications/initialized: 63
- server/discover: 2

## Top upstream tools (legacy tally)
| Tool | Calls |
|---|---|
| execute_read | 89 |
| execute | 70 |
| search | 7 |

## Per-upstream stats (MCP tools/call)
| Upstream | Calls | Errors | Error rate | p50 ms | p95 ms | Avg ms | Truncated | Overflow | ModelTrunc | Error classes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| unknown | 243 | 4 | 0.0165 | 15 | 918 | 137 | 0 | 0 | 0 | upstream_4xx:3,auth:1 |
| github | 148 | 7 | 0.0473 | 3012 | 24994 | 5199 | 3 | 0 | 109 | upstream_4xx:6,auth:1 |
| linear | 1 | 0 | 0 | 512 | 512 | 512 | 0 | 0 | 0 | — |
| notion | 1 | 0 | 0 | 409 | 409 | 409 | 0 | 0 | 1 | — |
| vercel | 1 | 0 | 0 | 1118 | 1118 | 1118 | 0 | 0 | 0 | — |

## Per-MCP-tool stats
| Tool | Calls | Errors | Error rate | p50 ms | p95 ms | Avg ms | Truncated | Overflow | ModelTrunc | Error classes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| execute_read | 89 | 4 | 0.0449 | 1845 | 5656 | 2316 | 3 | 0 | 56 | upstream_4xx:3,auth:1 |
| execute | 70 | 4 | 0.0571 | 3840 | 35539 | 8165 | 0 | 0 | 54 | upstream_4xx:4 |
| search | 7 | 0 | 0 | 17 | 50 | 20 | 0 | 0 | 0 | — |

## Upstream connect failures (eval closure)
> 来自结构化 capture 事件 `upstream_connect{ok:false}`，不读模型/正文；用于被动侧看见
> “哪个上游连不上/需要重新授权”，而不是只看成功的 tools/call。

| Server | Failures | Error classes | RequestId samples |
|---|---:|---|---|
| linear | 22 | auth:21, connect:1 | `074fd58c-c9be-41a2-9249-0d9fb619e83c`, `0a820ad5-dd0f-44db-b91e-18b42c77ed46`, `133571d5-73ca-4d25-8a3e-639d841332f4`, `3555e6a6-3f5f-49e2-90e0-58c6c605451a`, `3fc0a201-aaab-4b25-93f4-abe6a303641f` |
| notion | 22 | connect:22 | `074fd58c-c9be-41a2-9249-0d9fb619e83c`, `0a820ad5-dd0f-44db-b91e-18b42c77ed46`, `133571d5-73ca-4d25-8a3e-639d841332f4`, `3555e6a6-3f5f-49e2-90e0-58c6c605451a`, `3fc0a201-aaab-4b25-93f4-abe6a303641f` |

## Service state snapshots (codemode.services())
> 来自 `gateway_helper{helper:"services"}` 的冷启动快照（name/toolCount/status/online/needsReauth）；
> 它不是 live 健康检查。`latest` 是该服务在本窗口的最后一次观察，历史 counts 只作证据。

| Service | Snapshots | Tool count | Status counts | Latest | RequestId samples |
|---|---:|---:|---|---|---|
| figma | 3 | 47 | observed:3 | observed | `36ba515f-01d2-4163-a8eb-63c277314411`, `54816eec-e672-4480-9176-332d90fc7ec2`, `b9b2fd35-0700-43ae-b504-a5939504ee3a` |
| github | 3 | 42 | observed:3 | observed | `36ba515f-01d2-4163-a8eb-63c277314411`, `54816eec-e672-4480-9176-332d90fc7ec2`, `b9b2fd35-0700-43ae-b504-a5939504ee3a` |
| linear | 3 | 27 | observed:3 | observed | `36ba515f-01d2-4163-a8eb-63c277314411`, `54816eec-e672-4480-9176-332d90fc7ec2`, `b9b2fd35-0700-43ae-b504-a5939504ee3a` |
| notion | 3 | 53 | observed:2, offline:1 | observed | `36ba515f-01d2-4163-a8eb-63c277314411`, `54816eec-e672-4480-9176-332d90fc7ec2`, `b9b2fd35-0700-43ae-b504-a5939504ee3a` |
| vercel | 3 | 73 | observed:3 | observed | `36ba515f-01d2-4163-a8eb-63c277314411`, `54816eec-e672-4480-9176-332d90fc7ec2`, `b9b2fd35-0700-43ae-b504-a5939504ee3a` |

## Gateway helper calls (eval closure)
> 来自 `gateway_helper` 的全部 helper 调用（services / listTools / remainingCalls）。

| Helper | Calls | Last payload |
|---|---:|---|
| services | 3 | {"services":5} |

## Truncation / overflow
> Three independent signals. "Model truncation suspects" is the silent case:
> the gateway wire was complete, but the model received a materially shorter,
> unmarked projection (e.g. model code calling slice(0, 150)). It is advisory-only.

| Signal | Count | Rate |
|---|---:|---:|
| Truncated responses (gateway wire) | 3 | 0.0075 |
| Overflow captures (capture limit) | 0 | 0 |
| Model truncation suspects (silent, advisory) | 110 | 0.2743 |

### Model truncation suspects by server
| Server | Suspects |
|---|---:|
| github | 109 |
| notion | 1 |

### Model truncation suspects by tool
| Tool | Suspects |
|---|---:|
| execute_read | 56 |
| execute | 54 |

### Model truncation suspects by session
| Session | Suspects |
|---|---:|
| 84fc53cf-c9c7-4207-96a8-e9c0dcd697b3 | 36 |
| 2300fd1b-3d55-460e-9484-ad6babc559ac | 22 |
| 90093089-4744-4073-b6ac-fcf159c3b10c | 11 |
| 19ce3089-a7bf-4efa-a091-4dea724af835 | 7 |
| 49939f51-7233-4858-a42e-18030de9ec4d | 7 |
| 0fc836c7-42a3-4384-81f9-96ffd8fddd6f | 6 |
| 8f67986d-f5ef-4e8d-8f38-dcbaccd471fb | 5 |
| 033ebd44-57ac-4766-bbdb-7decb45ee3fb | 4 |
| 99307365-3ce0-4769-8724-b0648281f5c2 | 4 |
| 2857ba2b-5cdb-4bd4-bd0e-9a456403fa34 | 1 |
| 2f577e16-ca5d-4b28-991f-83fe48a8a654 | 1 |
| 57db68fa-c66a-4fd7-acbf-57bf43ec6d8d | 1 |
| 79adf4b8-75c7-48af-a987-9f1e79a06fce | 1 |
| 866f24c7-7d84-4eea-a206-562db8a5f2e8 | 1 |
| 92977021-89ce-4e6a-8796-c1047a1a30cb | 1 |
| b2e272cc-ca29-4245-99fb-7169e0ecbc65 | 1 |
| ef3d080d-6fe0-40f0-b2d0-5bde5e32d994 | 1 |

## Projects (derived labels, batch 11)
> `projects[]` / `primaryProject` are deterministic tags derived at capture time
> from explicit owner/repo pairs, never client-declared identities. One request
> may carry several tags; each tag is counted independently. Projects are
> ORTHOGONAL to sessions — see `projectTimelines` in the JSON scorecard for
> the same project spanning multiple sessions (handoff).

| Project | Platforms | Requests | MCP requests | Errors | Tool calls | Trunc suspects | First ts | Last ts | SessionIds | RequestId samples |
|---|---|---:|---:|---:|---:|---:|---|---|---|---|
| github:Bruce-Yii/gemini-mcp-gateway | gemini, chatgpt, unknown | 82 | 82 | 5 | 82 | 64 | 2026-11-24T00:01:08.813Z | 2026-11-24T19:24:29.609Z | `033ebd44-57ac-4766-bbdb-7decb45ee3fb`, `84fc53cf-c9c7-4207-96a8-e9c0dcd697b3`, `49939f51-7233-4858-a42e-18030de9ec4d`, `99307365-3ce0-4769-8724-b0648281f5c2`, `ef3d080d-6fe0-40f0-b2d0-5bde5e32d994`, `19ce3089-a7bf-4efa-a091-4dea724af835`, `92977021-89ce-4e6a-8796-c1047a1a30cb`, `866f24c7-7d84-4eea-a206-562db8a5f2e8`, `2f577e16-ca5d-4b28-991f-83fe48a8a654`, `99faf544-aef7-4bcf-8ab4-9404504c7cb7`, `b2e272cc-ca29-4245-99fb-7169e0ecbc65`, `2857ba2b-5cdb-4bd4-bd0e-9a456403fa34` | `00c1d059-6d78-4c98-868f-a5d0fbaa5c82`, `0178810f-e0ec-4296-b9c3-298c569dbbcb`, `08d8bf5a-069e-4db5-ac53-32f975c809a3`, `0a8bd8ef-c934-4054-a1ef-87f0e7d15c97`, `0d0fc47b-347c-43b7-a627-63e1f30b76d8` |
| github:Bruce-Yii/recruitment-agent | unknown, gemini | 73 | 73 | 3 | 73 | 48 | 2026-11-24T00:06:20.209Z | 2026-11-24T19:13:59.003Z | `2300fd1b-3d55-460e-9484-ad6babc559ac`, `0fc836c7-42a3-4384-81f9-96ffd8fddd6f`, `90093089-4744-4073-b6ac-fcf159c3b10c`, `79adf4b8-75c7-48af-a987-9f1e79a06fce`, `8f67986d-f5ef-4e8d-8f38-dcbaccd471fb`, `57db68fa-c66a-4fd7-acbf-57bf43ec6d8d` | `0271e7ca-d2dd-44d8-8902-ad38f2157743`, `03a21275-f6ac-4704-91c0-9b97fcee54b4`, `05623334-9d25-4299-ac8d-e52f1cd8c252`, `068de11b-c2e0-4e9d-9263-12fff614b558`, `0959012e-617f-4795-a7b1-00396a45b968` |

## Requests by day
| Day | Requests |
|---|---:|
| 2026-11-24 | 401 |

## Requests by hour (UTC)
| Hour | Requests |
|---|---:|
| 00:00 | 42 |
| 01:00 | 41 |
| 02:00 | 62 |
| 03:00 | 10 |
| 04:00 | 45 |
| 05:00 | 16 |
| 06:00 | 27 |
| 12:00 | 9 |
| 13:00 | 28 |
| 14:00 | 17 |
| 15:00 | 14 |
| 16:00 | 17 |
| 18:00 | 46 |
| 19:00 | 27 |

## Non-MCP routes (kept separate)
| Upstream | Calls | Errors | Error rate | p50 ms | p95 ms | Avg ms | Truncated | Overflow | ModelTrunc | Error classes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| POST /mcp | 401 | 0 | 0 | 26 | 8455 | 2007 | 3 | 0 | 110 | — |

## Error classes (MCP only)
| Class | Count |
|---|---|
| auth | 9 |
| upstream_4xx | 9 |

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
| session:8c0d61df-9626-4fa7-99fc-45850ceba802 | sessionId | 8c0d61df-9626-4fa7-99fc-45850ceba802 | unknown | 4 | 0 | 0 | 0 | 2026-11-24T00:00:04.281Z | 2026-11-24T01:33:42.689Z | — | {"ip":"192.178.10.74"} | `8a1d5292-4773-43e9-967f-9d2741199dad`, `d9b4ad3a-c062-4b9c-adb4-7c2bd32165cb`, `04ea8e1f-65a1-42d6-922d-37dd8eb7044e`, `b1cd0751-a567-44fe-9192-c313d1291015` |
| session:99307365-3ce0-4769-8724-b0648281f5c2 | sessionId | 99307365-3ce0-4769-8724-b0648281f5c2 | unknown | 12 | 0 | 12 | 4 | 2026-11-24T00:00:11.709Z | 2026-11-24T01:21:40.853Z | `github:Bruce-Yii/gemini-mcp-gateway` | {"ip":"108.177.68.131"} | `cd98c610-1dd3-4792-820b-a2ecbfe5f397`, `fad7392a-190a-491c-91e6-db10a5488325`, `0d0fc47b-347c-43b7-a627-63e1f30b76d8`, `1902a8ef-0bbd-4ab7-814f-2f55e1121f29`, `48977585-ce3a-4356-8522-12d2499646f6` |
| session:3ae56079-12b5-4911-9713-b336f4aabd32 | sessionId | 3ae56079-12b5-4911-9713-b336f4aabd32 | unknown | 10 | 0 | 0 | 0 | 2026-11-24T00:00:16.421Z | 2026-11-24T01:53:14.586Z | — | {"ip":"66.249.83.37"} | `d6c4af52-8b02-422c-9922-e6e45fd063f1`, `da852bec-b154-45d3-ab97-1132dc2f6030`, `6d4f90e7-054e-4435-8f01-0abc3ecdd9b2`, `0ccce2ce-f2f6-4cee-ac85-ee83d7432477`, `b828418e-d6c7-4ed1-815c-3f63aa01f48f` |
| session:2300fd1b-3d55-460e-9484-ad6babc559ac | sessionId | 2300fd1b-3d55-460e-9484-ad6babc559ac | unknown | 36 | 1 | 36 | 23 | 2026-11-24T00:06:20.209Z | 2026-11-24T01:37:04.437Z | `github:Bruce-Yii/recruitment-agent` | {"ip":"192.178.23.33"} | `91fbd978-b40b-4158-8feb-d9dcbe8c8cde`, `05623334-9d25-4299-ac8d-e52f1cd8c252`, `690ed74b-3ced-4145-a264-5fed6e605347`, `f6ef11cc-9749-4c09-90f8-71d9d448382e`, `84e2ab9a-0a82-43dc-aee5-7edf59eccf6b` |
| session:65950bad-422c-4a72-859a-0630a809accb | sessionId | 65950bad-422c-4a72-859a-0630a809accb | unknown | 2 | 0 | 0 | 0 | 2026-11-24T00:07:19.559Z | 2026-11-24T01:15:57.315Z | — | {"ip":"192.178.10.74"} | `4abd519a-2ce8-4f73-b67d-170861433754`, `4419bc2e-2b72-4998-b383-8f6d3006c4fe` |
| window:001 | initialize | — | unknown | 1 | 1 | 0 | 0 | 2026-11-24T00:08:10.136Z | 2026-11-24T00:08:10.136Z | — | {"ip":"128.242.114.87"} | `b287b6b0-2e0b-454b-8f67-8736039d1677` |
| session:a65d036c-bc30-4a74-9c88-d2064ec3759c | sessionId | a65d036c-bc30-4a74-9c88-d2064ec3759c | unknown | 2 | 0 | 0 | 0 | 2026-11-24T00:20:37.635Z | 2026-11-24T02:04:23.916Z | — | {"ip":"192.178.10.77"} | `682e201a-81f5-4b0f-a0a5-b25dbe811eb3`, `30d74401-c975-40c4-8e9d-f2a2e6eda34a` |
| session:a078abd9-7de2-48ee-b7d9-89285dea2130 | sessionId | a078abd9-7de2-48ee-b7d9-89285dea2130 | unknown | 5 | 0 | 0 | 0 | 2026-11-24T00:57:06.443Z | 2026-11-24T01:58:09.065Z | — | {"ip":"192.178.10.73"} | `cc2f8f46-6efe-4fdc-b8aa-45d44a032101`, `471dcdad-166d-4669-8281-d50484ef697a`, `c465e11c-b334-49a8-b080-f9e280d59a9b`, `0da73587-8601-481a-87f3-f0224db297e4`, `20e5bf15-10cc-404d-a845-1a529208eac4` |
| session:4046c198-c08a-4bfd-96e4-2090e410060e | sessionId | 4046c198-c08a-4bfd-96e4-2090e410060e | unknown | 5 | 0 | 0 | 0 | 2026-11-24T01:14:10.885Z | 2026-11-24T02:09:48.838Z | — | {"ip":"192.178.10.72"} | `ae618c8c-48df-4301-8ddc-cda20087793f`, `4570d548-2e9d-4061-837e-786b1caccd34`, `bd0ac684-7ea6-4bea-9227-3b2088a72390`, `955b6f0b-f834-499a-a3ba-c0a40ad8b32a`, `5035fd73-31a2-4149-9872-d56def6a2899` |
| session:3783f14d-9c3f-421b-bd28-538500e8cdd2 | sessionId | 3783f14d-9c3f-421b-bd28-538500e8cdd2 | unknown | 2 | 0 | 0 | 0 | 2026-11-24T01:20:35.479Z | 2026-11-24T02:11:14.192Z | — | {"ip":"192.178.10.64"} | `6bd550bf-9cb3-4a7d-a6b4-30660704e99a`, `2377ad64-b185-45c2-902f-c7ab34d7dcee` |
| session:5ffc600f-cabe-4b5b-82f3-83be76af3ea8 | sessionId | 5ffc600f-cabe-4b5b-82f3-83be76af3ea8 | unknown | 3 | 0 | 0 | 0 | 2026-11-24T01:24:05.518Z | 2026-11-24T01:53:02.558Z | — | {"name":"mcp","version":"0.1.0"} | `b80187c5-4a65-4ea8-a0a5-8aa557afb10b`, `9d1875f1-f9a3-4c21-9339-989d6ca3dadc`, `6e5d695f-ffab-4122-89ad-2e2fc6d5fb28` |
| session:9acd273c-49b9-4a4d-8090-db92753faf72 | sessionId | 9acd273c-49b9-4a4d-8090-db92753faf72 | unknown | 2 | 0 | 0 | 0 | 2026-11-24T01:24:06.268Z | 2026-11-24T01:27:26.840Z | — | {"ip":"192.178.10.69"} | `2e818e34-182b-4628-a4b3-aeab17b4a6db`, `830dd14a-1a63-4280-b2ed-70bd6b0711b2` |
| session:bcaf8ce3-474b-4c80-be2d-4e0b64a4b82c | sessionId | bcaf8ce3-474b-4c80-be2d-4e0b64a4b82c | unknown | 4 | 0 | 0 | 0 | 2026-11-24T01:46:55.118Z | 2026-11-24T02:16:08.430Z | — | {"name":"mcp","version":"0.1.0"} | `72acbf59-d99b-43f6-9214-f70c755c4a9a`, `690dab85-16b7-41d3-aa62-845096c2e0fe`, `c40054d9-7103-4e70-af29-cdfc363d580b`, `e034158f-0c38-4dac-a655-358a46ba500e` |
| session:848f1c58-d557-49c2-a0e9-9d68a5c3caad | sessionId | 848f1c58-d557-49c2-a0e9-9d68a5c3caad | unknown | 18 | 0 | 0 | 0 | 2026-11-24T02:05:18.382Z | 2026-11-24T05:49:50.265Z | — | {"name":"mcp","version":"0.1.0"} | `d9cb38dd-b915-40b3-8aa5-2215460c69be`, `656362ef-8150-44aa-a728-0bc2a8e3a3a3`, `7717d4fb-64af-4869-a44e-04c0b60f28b0`, `c2876dcf-8b29-4837-85f1-b1c2f7b0c758`, `ed7a8b30-6541-46a3-aa05-1c6b4850a9b0` |
| session:84fc53cf-c9c7-4207-96a8-e9c0dcd697b3 | sessionId | 84fc53cf-c9c7-4207-96a8-e9c0dcd697b3 | gemini, unknown | 44 | 4 | 42 | 36 | 2026-11-24T02:07:29.557Z | 2026-11-24T05:50:29.018Z | `github:Bruce-Yii/gemini-mcp-gateway` | {"name":"Gemini","version":"1.0.0"} | `ca34bf94-5250-4db9-b045-1ac167a4b49c`, `aab18f49-cef8-4fe4-ab6f-388da79db8a3`, `dab2fb8b-eb5a-4641-bbcb-cc86d969b468`, `6ba07b4b-1453-4ef0-b7f7-77dbf46abf4e`, `78337679-55d1-4af6-9b0e-2913f18812fb` |
| session:57db68fa-c66a-4fd7-acbf-57bf43ec6d8d | sessionId | 57db68fa-c66a-4fd7-acbf-57bf43ec6d8d | unknown | 2 | 0 | 1 | 1 | 2026-11-24T02:08:14.581Z | 2026-11-24T02:08:15.163Z | `github:Bruce-Yii/recruitment-agent` | {"ip":"108.177.68.35"} | `22de3e4e-4731-48b4-ad95-e1f4c048d351`, `7874fa78-93b5-462d-a54a-74d50fca58d1` |
| session:96612174-3e1d-4a87-ac18-bbe1ced3c177 | sessionId | 96612174-3e1d-4a87-ac18-bbe1ced3c177 | unknown | 4 | 0 | 0 | 0 | 2026-11-24T02:40:00.115Z | 2026-11-24T02:42:11.420Z | — | {"name":"mcp","version":"0.1.0"} | `0a820ad5-dd0f-44db-b91e-18b42c77ed46`, `2b865287-39b8-4d70-adc4-2df1e7b8bbdd`, `50e4bd23-56f8-4c6a-a4b3-c765fb74f629`, `d6bd68f2-4d54-43cb-a1ce-1ca88466fe5f` |
| session:0e76fdd0-b84a-43c6-ab4a-f6accec445f6 | sessionId | 0e76fdd0-b84a-43c6-ab4a-f6accec445f6 | unknown | 6 | 0 | 0 | 0 | 2026-11-24T02:43:14.200Z | 2026-11-24T04:42:35.166Z | — | {"name":"mcp","version":"0.1.0"} | `8ccfa50d-9b87-4a42-8e67-771760c0120e`, `5ce9b728-cb43-4010-8947-966a02f2a535`, `1da520f5-6efb-45dc-9ebd-f80e92143975`, `4a302061-6e40-4067-ae07-fa7decc46c48`, `86569ae9-23af-4a68-9365-51f8be8a141f` |
| session:fbee14af-c6c4-49a1-bd16-ccdf8f6b1782 | sessionId | fbee14af-c6c4-49a1-bd16-ccdf8f6b1782 | unknown | 4 | 0 | 0 | 0 | 2026-11-24T02:43:15.005Z | 2026-11-24T04:07:10.876Z | — | {"name":"mcp","version":"0.1.0"} | `d371cc1a-4c2e-4b13-9ed2-9370ecddfc5f`, `d7e62a52-f839-4331-9934-e5dc6ad3c712`, `a029f82f-fc84-4999-b9cf-63fdaa0d810d`, `460728d7-df91-45ad-9a2b-56c52b5a64a0` |
| session:36c86ad6-83f0-47f2-9386-fee07d569313 | sessionId | 36c86ad6-83f0-47f2-9386-fee07d569313 | unknown | 3 | 0 | 0 | 0 | 2026-11-24T02:50:21.953Z | 2026-11-24T02:53:37.234Z | — | {"name":"mcp","version":"0.1.0"} | `e78cedab-2ebe-4bd5-adf1-aaaa27cb1040`, `29a1527f-b400-4377-9d17-62edc16af289`, `82543a07-49e5-461d-a91e-010ccef79794` |
| session:68b0625e-dd75-4c32-9944-733e9bae2160 | sessionId | 68b0625e-dd75-4c32-9944-733e9bae2160 | unknown | 2 | 0 | 0 | 0 | 2026-11-24T02:50:22.711Z | 2026-11-24T02:50:22.790Z | — | {"name":"mcp","version":"0.1.0"} | `394e5ef8-a219-46d9-b979-9635f0c918b5`, `45c1116a-8cbd-42d8-ba48-52b5ed3e53c2` |
| session:ba016a7d-30e1-49c5-8f65-5f990c1f4a7b | sessionId | ba016a7d-30e1-49c5-8f65-5f990c1f4a7b | unknown | 4 | 0 | 0 | 0 | 2026-11-24T02:53:08.306Z | 2026-11-24T04:46:33.650Z | — | {"name":"mcp","version":"0.1.0"} | `b58448aa-29e2-4e02-aa4a-c17782f1a50a`, `2bbe949a-c566-4c09-ad98-63a20a623ff1`, `99cc45dd-410e-4f09-9d8b-fe82498c0aea`, `a8046759-c8c1-4e54-b3cb-b9ff9d29f210` |
| session:f43c6605-dbc9-4fc9-8f36-4a49e051dce8 | sessionId | f43c6605-dbc9-4fc9-8f36-4a49e051dce8 | unknown | 2 | 0 | 0 | 0 | 2026-11-24T02:53:36.490Z | 2026-11-24T02:53:36.655Z | — | {"name":"mcp","version":"0.1.0"} | `25165795-09d7-4d94-b19f-a07898e3a80e`, `1a56c344-6f89-47f2-9c1f-6e3929b3abf6` |
| session:6cb5f17e-8e43-4c22-bcdf-e38cf9a190e6 | sessionId | 6cb5f17e-8e43-4c22-bcdf-e38cf9a190e6 | unknown | 3 | 0 | 0 | 0 | 2026-11-24T03:07:45.070Z | 2026-11-24T03:07:45.702Z | — | {"name":"mcp","version":"0.1.0"} | `d69c1c8c-d697-47e2-af6d-1e2ff3c8000a`, `27c33298-dc82-4516-a8fb-70baa17685ec`, `a1f0047e-cf1e-4702-9262-e353566b62e2` |
| session:7b4d5527-4fb9-4aba-a5c3-4e6074030a44 | sessionId | 7b4d5527-4fb9-4aba-a5c3-4e6074030a44 | unknown | 3 | 0 | 0 | 0 | 2026-11-24T04:07:09.300Z | 2026-11-24T04:33:48.695Z | — | {"name":"mcp","version":"0.1.0"} | `5cfebb04-29ad-4969-9207-312f023595bb`, `6dfa4b76-e907-4f78-87e5-61d19e9f6fb5`, `e2f03ea8-e42b-4882-ab0a-cf926a937d62` |
| session:60849da6-8e6f-4f82-bedb-dd91d8339ec3 | sessionId | 60849da6-8e6f-4f82-bedb-dd91d8339ec3 | unknown, gemini | 4 | 0 | 0 | 0 | 2026-11-24T04:07:34.349Z | 2026-11-24T06:10:52.728Z | — | {"name":"mcp","version":"0.1.0"} | `1920e2c6-f3e9-499f-9cc5-53ba17804446`, `3a677c64-3f35-4e62-a8b4-265a80fd7a36`, `3fc0a201-aaab-4b25-93f4-abe6a303641f`, `d0c1be27-4c0c-4a6a-a78a-0a39d4038ead` |
| session:8f67986d-f5ef-4e8d-8f38-dcbaccd471fb | sessionId | 8f67986d-f5ef-4e8d-8f38-dcbaccd471fb | gemini, unknown | 9 | 0 | 7 | 6 | 2026-11-24T04:08:44.239Z | 2026-11-24T04:12:04.875Z | `github:Bruce-Yii/recruitment-agent` | {"name":"Gemini","version":"1.0.0"} | `b3283f6d-9b26-4044-982f-7b2ea1f59a1a`, `3af3a739-cffa-439e-9afa-9eeae1563348`, `f0277e7b-ae29-4d88-bd40-5bc06ffe6f87`, `e5cd5f03-4bac-40ae-87f3-df4bcfabcfdb`, `484ab881-9a96-469c-882f-0a06401041b6` |
| session:3b3d49c4-60c7-4ef5-86c9-10b5ef93c9e3 | sessionId | 3b3d49c4-60c7-4ef5-86c9-10b5ef93c9e3 | unknown | 4 | 0 | 0 | 0 | 2026-11-24T04:19:30.200Z | 2026-11-24T05:11:24.476Z | — | {"name":"mcp","version":"0.1.0"} | `ae21150c-91da-443b-a211-03a65f19d6a8`, `4959658c-a64f-4309-be17-b7421f210044`, `6cb5e58e-963a-4648-baac-9b4debcbcea0`, `7064829d-2096-4855-82a2-3d55f3176dfa` |
| session:9b91bbbf-e5d7-4b42-97e1-66ce05194632 | sessionId | 9b91bbbf-e5d7-4b42-97e1-66ce05194632 | unknown | 3 | 0 | 0 | 0 | 2026-11-24T04:21:07.363Z | 2026-11-24T05:54:07.514Z | — | {"name":"mcp","version":"0.1.0"} | `9e010bbd-f109-46cc-ab0f-fd6317bcdf40`, `f5d19adc-e6e6-40d6-aa53-5b26b8c191e8`, `8390fdc8-2d28-4ede-b2a7-cb2cdb2d480f` |
| session:89fd8e62-7144-4e9c-b0a5-68062e31eaff | sessionId | 89fd8e62-7144-4e9c-b0a5-68062e31eaff | unknown | 3 | 0 | 0 | 0 | 2026-11-24T04:21:08.366Z | 2026-11-24T04:21:09.041Z | — | {"name":"mcp","version":"0.1.0"} | `3a06a467-8e84-4ef3-a10e-3c1ff0ec50b4`, `2d6c4f42-4706-46d7-a5c0-6d5a96c1bdaf`, `1ed6a7e2-6b8a-4241-a4ff-ae8a55b2ca36` |
| session:76f7f704-997b-4d43-935c-921aafd396ee | sessionId | 76f7f704-997b-4d43-935c-921aafd396ee | unknown | 4 | 0 | 0 | 0 | 2026-11-24T04:32:31.849Z | 2026-11-24T05:01:26.759Z | — | {"name":"mcp","version":"0.1.0"} | `0d3f197c-ae64-49cd-b7f7-a17017acdd1c`, `cf9691d5-ae11-4293-aa42-b69005d4e4ca`, `4c6f159d-adc5-4a0f-891f-d3c04c877d0b`, `9f875233-32eb-4a4e-a5de-4e4c60626360` |
| session:fd43f584-6eb1-4c93-b414-3f3ed763a48a | sessionId | fd43f584-6eb1-4c93-b414-3f3ed763a48a | unknown | 2 | 0 | 0 | 0 | 2026-11-24T04:42:34.460Z | 2026-11-24T04:42:34.584Z | — | {"name":"mcp","version":"0.1.0"} | `37b0217e-8e19-456f-8172-116a30ab589b`, `9c21b5ef-5b8a-4b34-8f09-2d6673803684` |
| session:85f30751-9069-4ca2-93f2-93b7a07aefd6 | sessionId | 85f30751-9069-4ca2-93f2-93b7a07aefd6 | unknown, gemini | 4 | 0 | 0 | 0 | 2026-11-24T05:49:39.944Z | 2026-11-24T06:10:39.703Z | — | {"name":"mcp","version":"0.1.0"} | `b783b5c0-d830-48ac-8cc6-d0d7c7cb346b`, `7a538363-ced2-4d10-87bb-ec871a5806b1`, `d93deb1c-dd5e-4b11-93e4-81e4d764eb88`, `aa0c8069-2f72-489d-82c9-8ebaf24e0b00` |
| session:49556553-b299-457e-a827-b33f5e845a16 | sessionId | 49556553-b299-457e-a827-b33f5e845a16 | unknown | 2 | 0 | 0 | 0 | 2026-11-24T05:54:06.678Z | 2026-11-24T05:54:06.863Z | — | {"name":"mcp","version":"0.1.0"} | `31f79007-5823-441e-b0e7-378689e1e1e1`, `df5c614a-23f5-4a6d-9153-87fa430a8a82` |
| session:954ed69f-3f87-4b60-a507-b30525837622 | sessionId | 954ed69f-3f87-4b60-a507-b30525837622 | gemini | 2 | 0 | 0 | 0 | 2026-11-24T06:10:37.642Z | 2026-11-24T06:10:38.805Z | — | {"name":"mcp","version":"0.1.0"} | `f0ecf1e6-8fd6-4bb2-ba08-53f7e607afc6`, `2c9f556d-9138-48a8-86c6-abb4f615127f` |
| session:73d9b270-c9b2-4f95-b8c9-7388e3f8fdf1 | sessionId | 73d9b270-c9b2-4f95-b8c9-7388e3f8fdf1 | gemini | 2 | 0 | 0 | 0 | 2026-11-24T06:10:52.007Z | 2026-11-24T06:10:52.107Z | — | {"name":"mcp","version":"0.1.0"} | `fa1fad28-1d5e-4efa-9138-a86c4aa3e663`, `0442a80c-85a2-4fc1-a0fa-d8697ed42650` |
| session:2857ba2b-5cdb-4bd4-bd0e-9a456403fa34 | sessionId | 2857ba2b-5cdb-4bd4-bd0e-9a456403fa34 | gemini | 3 | 0 | 1 | 1 | 2026-11-24T06:10:58.006Z | 2026-11-24T06:10:58.639Z | `github:Bruce-Yii/gemini-mcp-gateway` | {"name":"Gemini","version":"1.0.0"} | `06b36205-bbd6-4df3-a619-741ffda52db9`, `2c0f834e-f1cd-4440-ac63-4ba14d8c3c87`, `e1754d59-18fe-4434-9f9d-d82fbcae5e40` |
| session:866f24c7-7d84-4eea-a206-562db8a5f2e8 | sessionId | 866f24c7-7d84-4eea-a206-562db8a5f2e8 | gemini | 3 | 0 | 1 | 1 | 2026-11-24T06:11:05.029Z | 2026-11-24T06:11:05.581Z | `github:Bruce-Yii/gemini-mcp-gateway` | {"name":"Gemini","version":"1.0.0"} | `5a475198-e1a7-4731-aab1-15947f1fc0c1`, `f5a4a100-502e-4b97-908d-4b3d47b7a60f`, `4ae66103-34ca-407e-9ca5-91624b48e35a` |
| session:ef3d080d-6fe0-40f0-b2d0-5bde5e32d994 | sessionId | ef3d080d-6fe0-40f0-b2d0-5bde5e32d994 | gemini | 3 | 0 | 1 | 1 | 2026-11-24T06:11:32.890Z | 2026-11-24T06:11:33.552Z | `github:Bruce-Yii/gemini-mcp-gateway` | {"name":"Gemini","version":"1.0.0"} | `5110f9a9-fb60-4dbf-90cd-06b0cfda0622`, `266f1a49-343b-4419-9959-b0cc69c774d7`, `0ec61a1a-1827-40fd-8f5d-4da717d78c69` |
| session:92977021-89ce-4e6a-8796-c1047a1a30cb | sessionId | 92977021-89ce-4e6a-8796-c1047a1a30cb | gemini | 3 | 0 | 1 | 1 | 2026-11-24T06:11:39.472Z | 2026-11-24T06:11:40.042Z | `github:Bruce-Yii/gemini-mcp-gateway` | {"name":"Gemini","version":"1.0.0"} | `cc3157e3-bd5d-42a1-93f1-37aa198fd81b`, `3ce5cdc2-384e-4374-a620-f79a023aed36`, `3f359350-75d1-4bcd-8640-82906609ea1a` |
| session:99faf544-aef7-4bcf-8ab4-9404504c7cb7 | sessionId | 99faf544-aef7-4bcf-8ab4-9404504c7cb7 | gemini | 3 | 0 | 1 | 0 | 2026-11-24T06:12:39.148Z | 2026-11-24T06:12:39.847Z | `github:Bruce-Yii/gemini-mcp-gateway` | {"name":"Gemini","version":"1.0.0"} | `e1580575-159a-44ee-8407-503a5c5ace0c`, `ea43e2a1-e85b-41c2-9b8f-00749b57a4ed`, `77fbd01d-e9f1-42e6-887e-3ad3da0ca5d7` |
| session:b2e272cc-ca29-4245-99fb-7169e0ecbc65 | sessionId | b2e272cc-ca29-4245-99fb-7169e0ecbc65 | gemini | 3 | 0 | 1 | 1 | 2026-11-24T06:14:27.782Z | 2026-11-24T06:14:28.441Z | `github:Bruce-Yii/gemini-mcp-gateway` | {"name":"Gemini","version":"1.0.0"} | `516aca32-0713-4761-af42-5e02c9ae0e2a`, `878cd0c9-98c6-4fe8-ab80-c8d297b21792`, `dee97ebd-5df2-43cc-bf91-e2b7d56197a4` |
| session:2f577e16-ca5d-4b28-991f-83fe48a8a654 | sessionId | 2f577e16-ca5d-4b28-991f-83fe48a8a654 | gemini | 3 | 0 | 1 | 1 | 2026-11-24T06:14:36.866Z | 2026-11-24T06:14:37.463Z | `github:Bruce-Yii/gemini-mcp-gateway` | {"name":"Gemini","version":"1.0.0"} | `6c9f8d3d-54c0-47f1-bc1d-a2a0e7280226`, `6e96378e-4744-46ff-b168-64becc5ed144`, `50394a1d-0c04-485e-9649-b5f489edd73a` |
| session:f8164caf-1073-40a8-8c36-828918850894 | sessionId | f8164caf-1073-40a8-8c36-828918850894 | gemini | 2 | 0 | 0 | 0 | 2026-11-24T12:56:57.369Z | 2026-11-24T12:56:58.754Z | — | {"name":"mcp","version":"0.1.0"} | `cb534c7a-4455-4f72-82d6-cfc913e9f411`, `fb14a356-99f3-4f19-a338-0c344a7145e2` |
| session:30f09474-d542-4c4f-8d91-bd4fe9f4acdc | sessionId | 30f09474-d542-4c4f-8d91-bd4fe9f4acdc | gemini | 4 | 0 | 0 | 0 | 2026-11-24T12:56:59.306Z | 2026-11-24T14:28:40.752Z | — | {"name":"mcp","version":"0.1.0"} | `b23fe024-4c66-4929-ad3d-e3f1407d2ee2`, `92590b1e-0049-445c-923b-8f61c3a47147`, `c3728af9-6973-4f62-903a-691784487f70`, `38b972c7-6892-4ae1-bbc0-356dfdf7f67b` |
| session:033ebd44-57ac-4766-bbdb-7decb45ee3fb | sessionId | 033ebd44-57ac-4766-bbdb-7decb45ee3fb | gemini | 7 | 0 | 5 | 4 | 2026-11-24T12:57:27.040Z | 2026-11-24T13:32:47.607Z | `github:Bruce-Yii/gemini-mcp-gateway` | {"name":"Gemini","version":"1.0.0"} | `5720b295-b199-4ccb-ad11-338d7a965317`, `8bf2d79d-aa1c-4078-854b-964f897da4c3`, `1188c924-320a-47da-b866-07405561a5c1`, `00c1d059-6d78-4c98-868f-a5d0fbaa5c82`, `598fceff-da8a-4123-8f26-bf68f3713ea8` |
| session:9106530e-da8b-417a-a4b4-5ee156c861b7 | sessionId | 9106530e-da8b-417a-a4b4-5ee156c861b7 | gemini | 2 | 0 | 0 | 0 | 2026-11-24T13:29:45.310Z | 2026-11-24T13:29:46.361Z | — | {"name":"mcp","version":"0.1.0"} | `3555e6a6-3f5f-49e2-90e0-58c6c605451a`, `23ef9c5c-4638-447b-9fd1-d59c01616817` |
| session:44eb287d-0b29-4e38-8a66-fe006d21ed00 | sessionId | 44eb287d-0b29-4e38-8a66-fe006d21ed00 | gemini | 3 | 0 | 0 | 0 | 2026-11-24T13:29:46.997Z | 2026-11-24T13:29:47.618Z | — | {"name":"mcp","version":"0.1.0"} | `c82318b5-221c-42ad-a355-a142631ffb79`, `93d981b6-9b30-4fc8-8455-00913aca8773`, `b06bf4a4-5687-43e1-a04b-551a6e024f20` |
| session:f59a15a1-6338-444c-bcd6-483e5f0ff38f | sessionId | f59a15a1-6338-444c-bcd6-483e5f0ff38f | gemini | 3 | 0 | 0 | 0 | 2026-11-24T13:30:57.604Z | 2026-11-24T13:30:58.232Z | — | {"name":"mcp","version":"0.1.0"} | `2544b5e3-92e1-4362-9b0e-dbba693008b9`, `8a6d57af-1d20-4bcd-9d42-905b84a807bc`, `e03ccbc4-d5c1-4a3b-82e3-6fd394759b2e` |
| session:0fc836c7-42a3-4384-81f9-96ffd8fddd6f | sessionId | 0fc836c7-42a3-4384-81f9-96ffd8fddd6f | gemini | 10 | 0 | 8 | 6 | 2026-11-24T13:31:00.903Z | 2026-11-24T13:58:11.135Z | `github:Bruce-Yii/recruitment-agent` | {"name":"Gemini","version":"1.0.0"} | `2976dbf4-2f4b-4474-bedb-8348b5f00f80`, `c875fa7a-8f23-4550-a135-2deda646da49`, `17503da0-2341-4c92-bfce-8dde8fc90184`, `03a21275-f6ac-4704-91c0-9b97fcee54b4`, `f062cabf-aacf-4b5f-966e-eb7e9948d450` |
| session:0a3ed876-2f0c-489e-b36d-43c99970e00f | sessionId | 0a3ed876-2f0c-489e-b36d-43c99970e00f | gemini | 3 | 0 | 0 | 0 | 2026-11-24T13:31:58.085Z | 2026-11-24T13:31:58.864Z | — | {"name":"mcp","version":"0.1.0"} | `53e9e583-3a13-46ed-ad25-ecdfcdaa98e4`, `1cdf9439-8ac6-47e2-86b6-335f02c4d28d`, `6f7755a0-221a-4c97-ae70-08217cc658ac` |
| session:96b1cd8a-64ea-45ef-9828-0a5b1ffd8ff5 | sessionId | 96b1cd8a-64ea-45ef-9828-0a5b1ffd8ff5 | gemini | 2 | 0 | 0 | 0 | 2026-11-24T13:55:17.503Z | 2026-11-24T13:55:18.740Z | — | {"name":"mcp","version":"0.1.0"} | `7c3361fe-e7f4-4372-b585-5699729f3083`, `42b0bb77-9706-4105-9cd8-f0d89e9b2b82` |
| session:73ea6fb7-d680-4b09-96f4-14894887182a | sessionId | 73ea6fb7-d680-4b09-96f4-14894887182a | gemini | 3 | 0 | 0 | 0 | 2026-11-24T13:55:19.650Z | 2026-11-24T13:55:20.946Z | — | {"name":"mcp","version":"0.1.0"} | `4c143eaa-eea6-43d2-983f-d63564ca73ff`, `074fd58c-c9be-41a2-9249-0d9fb619e83c`, `03b09af2-3e0b-4148-80c4-320071112a29` |
| session:49568b86-7344-427b-9908-e6d7308b0fc2 | sessionId | 49568b86-7344-427b-9908-e6d7308b0fc2 | gemini | 2 | 0 | 0 | 0 | 2026-11-24T14:14:33.415Z | 2026-11-24T14:14:34.560Z | — | {"name":"mcp","version":"0.1.0"} | `9c10b422-3607-431e-9ac6-1b3dd9be7284`, `9d73912c-4018-48be-8191-0aaa83b971be` |
| session:79adf4b8-75c7-48af-a987-9f1e79a06fce | sessionId | 79adf4b8-75c7-48af-a987-9f1e79a06fce | gemini | 6 | 0 | 4 | 1 | 2026-11-24T14:14:58.607Z | 2026-11-24T14:29:19.612Z | `github:Bruce-Yii/recruitment-agent` | {"name":"Gemini","version":"1.0.0"} | `ed078f88-0e2f-420c-8ce1-10875fd62cec`, `5710f5d8-2e24-4f94-8ca5-4783eedfec46`, `1473964f-6f23-48e1-b877-b9e93ab88568`, `1a59ecc7-0d2c-4db8-adaa-d616d2cf503e`, `b4bb5487-0c72-4366-803d-e992d9af8a7c` |
| session:380f1ba5-913e-4156-a4d8-74e58de3a32c | sessionId | 380f1ba5-913e-4156-a4d8-74e58de3a32c | gemini | 3 | 0 | 0 | 0 | 2026-11-24T14:28:38.986Z | 2026-11-24T14:29:29.685Z | — | {"name":"mcp","version":"0.1.0"} | `f6a2bd0e-a13a-4a96-b0b9-6e8615fa9992`, `796f07ae-9c3f-4833-b6e7-d56bcc8ac4ac`, `f8ae77a3-425f-451b-9e57-d40f40e44e82` |
| session:49939f51-7233-4858-a42e-18030de9ec4d | sessionId | 49939f51-7233-4858-a42e-18030de9ec4d | gemini | 12 | 1 | 10 | 7 | 2026-11-24T14:29:57.630Z | 2026-11-24T15:50:13.183Z | `github:Bruce-Yii/gemini-mcp-gateway` | {"name":"Gemini","version":"1.0.0"} | `3d1aa30d-b850-44ba-9734-325c136a8f14`, `4f075f65-5518-492f-8a2f-aeb1b57228d2`, `4f513d7d-8d0b-486e-855e-166d9105f2f6`, `57769d49-504d-4a97-804b-20ba81ae18ca`, `8bac3e2a-7081-4b0c-9993-41c0f5533e4b` |
| session:bb8eb767-2116-4bc5-80f2-d3cc647f1c4d | sessionId | bb8eb767-2116-4bc5-80f2-d3cc647f1c4d | gemini | 3 | 0 | 0 | 0 | 2026-11-24T15:02:24.355Z | 2026-11-24T15:02:26.084Z | — | {"name":"mcp","version":"0.1.0"} | `9118b82a-968b-4682-b4d1-f0b165d55545`, `f78877ff-ba44-49e7-8e34-b7b5665c41fe`, `d51f6f0c-0056-4c09-890d-131040504bdf` |
| session:b8acdf13-fa82-4077-8ebf-737d779fd814 | sessionId | b8acdf13-fa82-4077-8ebf-737d779fd814 | gemini | 3 | 0 | 0 | 0 | 2026-11-24T15:49:40.600Z | 2026-11-24T15:49:42.761Z | — | {"name":"mcp","version":"0.1.0"} | `9cd851cc-9520-4c1b-87b5-bb52c346ee74`, `7d360131-dae9-4cae-821c-70322b91e2d9`, `43966331-b302-439b-bb84-4981e8a84ae1` |
| window:002 | idle-gap | — | unknown, chatgpt | 9 | 9 | 0 | 0 | 2026-11-24T16:19:17.781Z | 2026-11-24T16:30:35.251Z | — | {"ip":"9.129.50.15"} | `0b8671d5-4ee9-46bd-a550-0f106748396d`, `b3f8452d-1e7f-4cf8-8c85-9fdb2a0aec26`, `0dbba1c9-7c11-4c64-8655-bbbb2cf0b1f1`, `eca77a1a-70a6-4684-ab32-fc49d9b3a3b1`, `55cf0735-8b44-4cab-8296-bf360968652e` |
| session:cc3bb33e-c9ca-4005-993b-874a5f7e3aef | sessionId | cc3bb33e-c9ca-4005-993b-874a5f7e3aef | chatgpt | 1 | 0 | 0 | 0 | 2026-11-24T16:30:00.377Z | 2026-11-24T16:30:00.377Z | — | {"name":"openai-mcp","version":"1.0.0"} | `133571d5-73ca-4d25-8a3e-639d841332f4` |
| session:b7287346-72fd-4fb7-a872-5247345f8970 | sessionId | b7287346-72fd-4fb7-a872-5247345f8970 | chatgpt | 3 | 0 | 0 | 0 | 2026-11-24T16:30:01.242Z | 2026-11-24T16:30:01.664Z | — | {"name":"openai-mcp","version":"1.0.0"} | `b198ce3c-a694-4d8c-97d3-2a19f102a3ba`, `841e0078-e70b-4ec8-8c37-99db4975fcf9`, `7fbb79d6-9c37-4961-bdd9-af77814b4b48` |
| session:3f351671-0b35-4916-b876-22d14521b047 | sessionId | 3f351671-0b35-4916-b876-22d14521b047 | chatgpt | 1 | 0 | 0 | 0 | 2026-11-24T16:30:35.394Z | 2026-11-24T16:30:35.394Z | — | {"name":"openai-mcp","version":"1.0.0"} | `7486ed97-f666-4e1b-8661-644f6b1d93e9` |
| session:c0ca46fb-dfb3-4dcf-9385-88127aa249cf | sessionId | c0ca46fb-dfb3-4dcf-9385-88127aa249cf | chatgpt | 3 | 0 | 0 | 0 | 2026-11-24T16:30:35.596Z | 2026-11-24T16:30:35.961Z | — | {"name":"openai-mcp","version":"1.0.0"} | `ddf36858-9be8-40c0-b61c-8a2d35e1c326`, `b476728b-3218-435f-b324-6ebd570670e4`, `5905c741-b982-41b4-8f20-42396bd7c31c` |
| session:eafcceb9-c434-4d59-8250-866d608c5a27 | sessionId | eafcceb9-c434-4d59-8250-866d608c5a27 | gemini | 2 | 0 | 0 | 0 | 2026-11-24T18:03:12.562Z | 2026-11-24T18:03:13.974Z | — | {"name":"mcp","version":"0.1.0"} | `636aa5f3-6253-477a-997f-29a66204b7d0`, `71e08fec-273c-4f38-bfcd-a126c36d8003` |
| session:ab75bc50-63b6-471a-84e6-e200c7b680a7 | sessionId | ab75bc50-63b6-471a-84e6-e200c7b680a7 | gemini | 3 | 0 | 0 | 0 | 2026-11-24T18:03:14.958Z | 2026-11-24T18:16:47.164Z | — | {"name":"mcp","version":"0.1.0"} | `f50bc57e-34f7-485d-a11c-8281bed7c4e7`, `6d8c94dd-489c-434f-8d03-76caa645aaf4`, `f599de02-d718-430d-9d7e-0c8c05447849` |
| session:90093089-4744-4073-b6ac-fcf159c3b10c | sessionId | 90093089-4744-4073-b6ac-fcf159c3b10c | gemini | 19 | 2 | 17 | 11 | 2026-11-24T18:03:29.553Z | 2026-11-24T19:13:59.003Z | `github:Bruce-Yii/recruitment-agent` | {"name":"Gemini","version":"1.0.0"} | `dbcb9de2-b428-4954-8919-ba1f250aa372`, `0c9b2930-2bea-4f52-b176-725f7885a7b3`, `c44c5374-d468-4828-a4de-6a58e99d6db5`, `d221a0a4-e522-43b7-8a9e-1c286b167edc`, `f0dd1e23-b859-4d86-bc7a-5c1d054cba69` |
| session:dd74ef77-05a0-44e7-a9c2-13ac358701ed | sessionId | dd74ef77-05a0-44e7-a9c2-13ac358701ed | gemini | 2 | 0 | 0 | 0 | 2026-11-24T18:07:16.009Z | 2026-11-24T18:07:16.190Z | — | {"name":"mcp","version":"0.1.0"} | `60e3eb03-a9da-4dc6-bd40-f7e41809c228`, `029529fb-078d-4f44-8e7e-4de3249fb826` |
| session:4170b4a3-9963-4816-b2d5-ea6db9e65a46 | sessionId | 4170b4a3-9963-4816-b2d5-ea6db9e65a46 | gemini | 3 | 0 | 0 | 0 | 2026-11-24T18:07:16.699Z | 2026-11-24T18:07:17.391Z | — | {"name":"mcp","version":"0.1.0"} | `301bc74c-1326-4e79-a2ca-319e066a8184`, `59cb24de-8772-4b18-aae4-de8a663876c0`, `0deb1b96-419f-4ee2-a226-d97b8c0dee41` |
| session:b4bb7fdd-d28a-4894-840f-bd4293fcac56 | sessionId | b4bb7fdd-d28a-4894-840f-bd4293fcac56 | gemini | 3 | 0 | 0 | 0 | 2026-11-24T18:12:42.083Z | 2026-11-24T18:12:42.963Z | — | {"name":"mcp","version":"0.1.0"} | `a2c9e051-0b73-493f-a312-1e7c850e277a`, `10e1c288-08f5-45af-9060-7a17b33d19f4`, `fdc60d05-1140-4334-aeea-43debcd1965f` |
| session:19ce3089-a7bf-4efa-a091-4dea724af835 | sessionId | 19ce3089-a7bf-4efa-a091-4dea724af835 | gemini | 11 | 0 | 9 | 7 | 2026-11-24T18:17:48.368Z | 2026-11-24T19:16:38.171Z | `github:Bruce-Yii/gemini-mcp-gateway` | {"name":"Gemini","version":"1.0.0"} | `32dbba1a-88d6-4fa4-b736-125a627615da`, `623ce3ab-2c34-4c95-89ea-4b4fa59a028a`, `54816eec-e672-4480-9176-332d90fc7ec2`, `e04abc31-edce-4f54-a7cd-53387dcfbdd1`, `3dfbc425-95ac-40b6-a822-c9fc2edb4371` |
| session:ee28090e-c7b8-450a-ad85-8c74fc0dd169 | sessionId | ee28090e-c7b8-450a-ad85-8c74fc0dd169 | gemini | 4 | 0 | 0 | 0 | 2026-11-24T18:19:47.825Z | 2026-11-24T19:08:10.293Z | — | {"name":"mcp","version":"0.1.0"} | `93b8d682-e4ba-4f1c-9584-a9cefb613674`, `ab032896-141c-43fc-b181-b7ba35375992`, `5e4dfd1b-f0fb-445b-ad0f-635c3027e993`, `709fe2b7-41c4-4879-be7e-1573d0631ee0` |
| session:1c378005-057f-416a-9a55-a1c3b0170759 | sessionId | 1c378005-057f-416a-9a55-a1c3b0170759 | gemini | 5 | 0 | 0 | 0 | 2026-11-24T18:23:26.988Z | 2026-11-24T18:39:05.296Z | — | {"name":"mcp","version":"0.1.0"} | `4d9c3def-2eab-432a-a284-78b9dd232642`, `6034bd87-ee64-4d48-9d77-0ccdb6b2dd8b`, `71f15f1c-f467-4354-863f-bc95a0cddf1b`, `5b6b200c-0b47-4404-8b94-1160f83025d5`, `81294245-faa6-4664-bfbe-6326a061b911` |
| session:7ab72a97-9e13-445f-8e4e-94fbfab0582a | sessionId | 7ab72a97-9e13-445f-8e4e-94fbfab0582a | gemini | 4 | 0 | 0 | 0 | 2026-11-24T18:23:38.668Z | 2026-11-24T19:16:03.073Z | — | {"name":"mcp","version":"0.1.0"} | `169fafa2-9a98-4d57-af10-f659d3a95b3a`, `082b9b4f-17a6-4559-bd54-09042822e203`, `00681e06-efa5-4e53-b605-275d57364349`, `622e83d5-b9ad-4109-a529-62184a1a9e7d` |
| session:ef559d8e-0cb2-418b-b8af-2130dd483667 | sessionId | ef559d8e-0cb2-418b-b8af-2130dd483667 | gemini | 2 | 0 | 0 | 0 | 2026-11-24T18:26:11.704Z | 2026-11-24T18:26:11.881Z | — | {"name":"mcp","version":"0.1.0"} | `df381f79-ff06-4fab-ae1a-421e102968c5`, `5b802caf-af92-459c-bb90-adb66173a672` |
| session:bff9e299-21b5-4a16-a7cf-6d07ec72cbed | sessionId | bff9e299-21b5-4a16-a7cf-6d07ec72cbed | gemini | 4 | 0 | 0 | 0 | 2026-11-24T18:34:50.715Z | 2026-11-24T19:12:51.474Z | — | {"name":"mcp","version":"0.1.0"} | `cef6ad37-f733-41de-bd3e-cf27b8d00065`, `726d91fc-4331-4b29-8f7a-53cef21c9ec7`, `b764349a-7f07-45f2-a39d-bf728c8762c2`, `e8a82603-70e8-4705-8992-8fcc13161d3a` |
| session:8caea874-1bd7-4e0d-9451-ccbb30806e49 | sessionId | 8caea874-1bd7-4e0d-9451-ccbb30806e49 | gemini | 2 | 0 | 0 | 0 | 2026-11-24T19:15:56.933Z | 2026-11-24T19:16:02.156Z | — | {"name":"mcp","version":"0.1.0"} | `77171d13-71f1-49b3-b213-2a618fb077b5`, `4f6d4089-a5f0-454d-882a-918c4b6e9dba` |
| session:d71c2683-bf2a-446a-91e9-b3d888212dee | sessionId | d71c2683-bf2a-446a-91e9-b3d888212dee | chatgpt | 1 | 0 | 0 | 0 | 2026-11-24T19:23:31.497Z | 2026-11-24T19:23:31.497Z | — | {"name":"openai-mcp","version":"1.0.0"} | `5327f5a2-d334-4eb6-9fdc-0924e9bce923` |
| window:003 | idle-gap | — | chatgpt | 8 | 0 | 8 | 1 | 2026-11-24T19:23:31.755Z | 2026-11-24T19:25:10.737Z | `github:Bruce-Yii/gemini-mcp-gateway` | {"ip":"9.129.50.4"} | `8896ea64-e533-4b5d-9efd-023803bc1331`, `0a3d1091-980e-4d98-ac55-abe8fa2f4003`, `776d37a5-9d10-4085-ab82-5ceadfcb618f`, `276da6ce-0392-40e5-b0b1-8b54f40ec848`, `b9b2fd35-0700-43ae-b504-a5939504ee3a` |

## Project timelines (batch 11, cross-session handoff)

> One project key can appear in multiple independent sessions/windows. Rows are
> ordered by first timestamp so a handoff is visible. Project tags are derived
> labels; a shared key does NOT prove the same client or the same task.

| Project | SessionId | Primary requests | Requests | MCP requests | Errors | Tool calls | Trunc suspects | First ts | Last ts | RequestId samples |
|---|---|---:|---:|---:|---:|---:|---:|---|---|---|
| github:Bruce-Yii/gemini-mcp-gateway | 033ebd44-57ac-4766-bbdb-7decb45ee3fb | 5 | 5 | 5 | 0 | 5 | 4 | 2026-11-24T12:57:27.664Z | 2026-11-24T13:32:47.607Z | `00c1d059-6d78-4c98-868f-a5d0fbaa5c82`, `1188c924-320a-47da-b866-07405561a5c1`, `5748cc52-d634-497f-b12d-7df1a94e7d08`, `598fceff-da8a-4123-8f26-bf68f3713ea8`, `d0443f7a-1721-4e2d-ba7f-18a3933bd359` |
| github:Bruce-Yii/gemini-mcp-gateway | — | 2 | 2 | 2 | 0 | 2 | 1 | 2026-11-24T19:23:47.390Z | 2026-11-24T19:24:29.609Z | `0178810f-e0ec-4296-b9c3-298c569dbbcb`, `b9b2fd35-0700-43ae-b504-a5939504ee3a` |
| github:Bruce-Yii/recruitment-agent | 2300fd1b-3d55-460e-9484-ad6babc559ac | 36 | 36 | 36 | 1 | 36 | 23 | 2026-11-24T00:06:20.209Z | 2026-11-24T01:37:04.437Z | `0271e7ca-d2dd-44d8-8902-ad38f2157743`, `05623334-9d25-4299-ac8d-e52f1cd8c252`, `118148d9-d0f0-4139-af13-c4ae2f2116fc`, `147bc3f0-87c9-445e-8806-8be7463126c7`, `1f124492-79fa-4b33-a9e4-3db257f78791` |
| github:Bruce-Yii/recruitment-agent | 0fc836c7-42a3-4384-81f9-96ffd8fddd6f | 8 | 8 | 8 | 0 | 8 | 6 | 2026-11-24T13:31:01.783Z | 2026-11-24T13:58:11.135Z | `03a21275-f6ac-4704-91c0-9b97fcee54b4`, `132e35eb-5e4e-445d-9b8a-cbe6f2077429`, `17503da0-2341-4c92-bfce-8dde8fc90184`, `26c00056-24ab-471b-853f-a000fe5189db`, `421d123b-c186-4b8e-87cb-413c97512af0` |
| github:Bruce-Yii/recruitment-agent | 90093089-4744-4073-b6ac-fcf159c3b10c | 17 | 17 | 17 | 2 | 17 | 11 | 2026-11-24T18:03:30.114Z | 2026-11-24T19:13:59.003Z | `068de11b-c2e0-4e9d-9263-12fff614b558`, `0959012e-617f-4795-a7b1-00396a45b968`, `16a098d6-0c12-4513-b2bf-3c156ff35be8`, `302592ed-46f5-42db-b9a3-cab512c90694`, `34914a0c-0cd3-41cb-9e54-2ac2740c761f` |
| github:Bruce-Yii/gemini-mcp-gateway | 84fc53cf-c9c7-4207-96a8-e9c0dcd697b3 | 42 | 42 | 42 | 4 | 42 | 36 | 2026-11-24T02:07:30.122Z | 2026-11-24T05:50:29.018Z | `08d8bf5a-069e-4db5-ac53-32f975c809a3`, `0f000d24-c8e6-4e71-945b-b870c44e3b7e`, `12979d99-30a0-4aaf-94b0-e7ae1a8a52cd`, `18ce67bc-e6f0-4926-ac9a-71a07d821740`, `1e12f926-a72c-4cd9-a3bd-b8ba94fe8032` |
| github:Bruce-Yii/gemini-mcp-gateway | 49939f51-7233-4858-a42e-18030de9ec4d | 8 | 8 | 8 | 1 | 8 | 7 | 2026-11-24T14:29:58.465Z | 2026-11-24T15:40:22.133Z | `0a8bd8ef-c934-4054-a1ef-87f0e7d15c97`, `4f513d7d-8d0b-486e-855e-166d9105f2f6`, `57769d49-504d-4a97-804b-20ba81ae18ca`, `8bac3e2a-7081-4b0c-9993-41c0f5533e4b`, `de5161f0-6c51-4b13-b618-724a412d4a1d` |
| github:Bruce-Yii/gemini-mcp-gateway | 99307365-3ce0-4769-8724-b0648281f5c2 | 11 | 11 | 11 | 0 | 11 | 4 | 2026-11-24T00:01:08.813Z | 2026-11-24T01:21:40.853Z | `0d0fc47b-347c-43b7-a627-63e1f30b76d8`, `1902a8ef-0bbd-4ab7-814f-2f55e1121f29`, `3580a707-a452-48ea-8a0c-26b8ca11315c`, `48977585-ce3a-4356-8522-12d2499646f6`, `5fc8ede2-decc-4868-b325-3409e83df248` |
| github:Bruce-Yii/gemini-mcp-gateway | ef3d080d-6fe0-40f0-b2d0-5bde5e32d994 | 1 | 1 | 1 | 0 | 1 | 1 | 2026-11-24T06:11:33.552Z | 2026-11-24T06:11:33.552Z | `0ec61a1a-1827-40fd-8f5d-4da717d78c69` |
| github:Bruce-Yii/recruitment-agent | 79adf4b8-75c7-48af-a987-9f1e79a06fce | 4 | 4 | 4 | 0 | 4 | 1 | 2026-11-24T14:14:59.178Z | 2026-11-24T14:29:19.612Z | `1473964f-6f23-48e1-b877-b9e93ab88568`, `1a59ecc7-0d2c-4db8-adaa-d616d2cf503e`, `b4bb5487-0c72-4366-803d-e992d9af8a7c`, `cf337d84-4da7-439f-a7e8-367d323c8924` |
| github:Bruce-Yii/gemini-mcp-gateway | 19ce3089-a7bf-4efa-a091-4dea724af835 | 7 | 7 | 7 | 0 | 7 | 6 | 2026-11-24T18:17:48.939Z | 2026-11-24T19:16:22.722Z | `36ba515f-01d2-4163-a8eb-63c277314411`, `3dfbc425-95ac-40b6-a822-c9fc2edb4371`, `4be1cd26-307f-4440-9dfc-855a63f9cd71`, `54816eec-e672-4480-9176-332d90fc7ec2`, `79ce6160-9cb6-4fde-bd92-e7e87038531c` |
| github:Bruce-Yii/gemini-mcp-gateway | 92977021-89ce-4e6a-8796-c1047a1a30cb | 1 | 1 | 1 | 0 | 1 | 1 | 2026-11-24T06:11:40.042Z | 2026-11-24T06:11:40.042Z | `3f359350-75d1-4bcd-8640-82906609ea1a` |
| github:Bruce-Yii/recruitment-agent | 8f67986d-f5ef-4e8d-8f38-dcbaccd471fb | 7 | 7 | 7 | 0 | 7 | 6 | 2026-11-24T04:08:44.794Z | 2026-11-24T04:12:04.875Z | `484ab881-9a96-469c-882f-0a06401041b6`, `52ddb460-9058-4366-89e5-3259c5f8654c`, `6b2de5d9-b80e-4b86-bf0e-dddd7debc8ab`, `7bd3ccca-e7cd-4d75-beed-651a51c2570a`, `ca4dc8a2-b3a9-44b1-90eb-23633ae4cc78` |
| github:Bruce-Yii/gemini-mcp-gateway | 866f24c7-7d84-4eea-a206-562db8a5f2e8 | 1 | 1 | 1 | 0 | 1 | 1 | 2026-11-24T06:11:05.581Z | 2026-11-24T06:11:05.581Z | `4ae66103-34ca-407e-9ca5-91624b48e35a` |
| github:Bruce-Yii/gemini-mcp-gateway | 2f577e16-ca5d-4b28-991f-83fe48a8a654 | 1 | 1 | 1 | 0 | 1 | 1 | 2026-11-24T06:14:37.463Z | 2026-11-24T06:14:37.463Z | `50394a1d-0c04-485e-9649-b5f489edd73a` |
| github:Bruce-Yii/gemini-mcp-gateway | 99faf544-aef7-4bcf-8ab4-9404504c7cb7 | 1 | 1 | 1 | 0 | 1 | 0 | 2026-11-24T06:12:39.847Z | 2026-11-24T06:12:39.847Z | `77fbd01d-e9f1-42e6-887e-3ad3da0ca5d7` |
| github:Bruce-Yii/recruitment-agent | 57db68fa-c66a-4fd7-acbf-57bf43ec6d8d | 1 | 1 | 1 | 0 | 1 | 1 | 2026-11-24T02:08:15.163Z | 2026-11-24T02:08:15.163Z | `7874fa78-93b5-462d-a54a-74d50fca58d1` |
| github:Bruce-Yii/gemini-mcp-gateway | b2e272cc-ca29-4245-99fb-7169e0ecbc65 | 1 | 1 | 1 | 0 | 1 | 1 | 2026-11-24T06:14:28.441Z | 2026-11-24T06:14:28.441Z | `dee97ebd-5df2-43cc-bf91-e2b7d56197a4` |
| github:Bruce-Yii/gemini-mcp-gateway | 2857ba2b-5cdb-4bd4-bd0e-9a456403fa34 | 1 | 1 | 1 | 0 | 1 | 1 | 2026-11-24T06:10:58.639Z | 2026-11-24T06:10:58.639Z | `e1754d59-18fe-4434-9f9d-d82fbcae5e40` |
