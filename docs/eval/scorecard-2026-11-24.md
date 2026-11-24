# Capture Scorecard — 2026-11-24

| Metric | Value |
|---|---|
| Requests | 479 |
| MCP POST requests | 479 |
| Non-MCP routes | 0 |
| Errors (HTTP >= 400) | 18 |
| MCP errors | 18 |
| p50 latency | 40 ms |
| p95 latency | 10599 ms |
| Avg latency | 2390 ms |
| Response bytes | 3098005 |
| Truncated responses (gateway wire) | 4 |
| Overflow captures (capture limit) | 0 |
| Truncation rate | 0.0084 |
| Overflow rate | 0 |
| Model truncation suspects (silent) | 142 |
| Model truncation rate | 0.2965 |
| Overall error rate | 0.0376 |

## By client platform (batch 13)
> 每个平台的指标单独成行，绝不互相污染。`clientPlatform` 只接受显式且可识别的值；
> 缺失 / null / 非字符串 / 未知值一律进 `unknown`，不根据 UA / 工具名猜测。
> 旧 envelope（无字段）全部落在 `unknown`，不会被算进 Gemini。
> 平台之间**不做硬比**：baseline 与任务分母按平台独立（见 batch-13-platform-eval.md）。

| Platform | Requests | MCP requests | Errors | Tool calls | Trunc suspects | Sessions | Projects | RequestId samples |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| gemini | 239 | 239 | 3 | 103 | 75 | 55 | 6 | `0062db60-13a1-47c1-8f3a-bf5c3aab10a7`, `00681e06-efa5-4e53-b605-275d57364349`, `00c1d059-6d78-4c98-868f-a5d0fbaa5c82`, `01aa399e-1821-4ab7-b5ac-e4da908dcec3`, `029529fb-078d-4f44-8e7e-4de3249fb826` |
| chatgpt | 19 | 19 | 2 | 8 | 1 | 5 | 1 | `0178810f-e0ec-4296-b9c3-298c569dbbcb`, `0a3d1091-980e-4d98-ac55-abe8fa2f4003`, `133571d5-73ca-4d25-8a3e-639d841332f4`, `276da6ce-0392-40e5-b0b1-8b54f40ec848`, `3cf07cb5-0ce4-4b0a-91c2-8fccc491ef16` |
| unknown | 221 | 221 | 13 | 98 | 70 | 33 | 2 | `0271e7ca-d2dd-44d8-8902-ad38f2157743`, `04ea8e1f-65a1-42d6-922d-37dd8eb7044e`, `05623334-9d25-4299-ac8d-e52f1cd8c252`, `08d8bf5a-069e-4db5-ac53-32f975c809a3`, `0a820ad5-dd0f-44db-b91e-18b42c77ed46` |

## By protocol version (v1 / v2) — M4-A
> `protocolVersion` 只来自显式字段或请求路径（`/mcp/v2`=v2，`/mcp`=v1）；
> 旧 envelope / 非 MCP 路由一律 `unknown`，不猜。

| Protocol | Executor | Requests | MCP requests | Errors | Tool calls | Trunc suspects |
|---|---|---|---:|---:|---:|---:|
| v1 | codemode | 479 | 479 | 18 | 209 | 146 |

## By client profile — M4-A

| Profile | Requests | MCP requests | Errors | Tool calls | Trunc suspects |
|---|---|---:|---:|---:|---:|
| gemini-text-json | 460 | 460 | 16 | 201 | 145 |
| chatgpt-structured | 19 | 19 | 2 | 8 | 1 |

## Four-dimension ledger — platform × protocol × profile × build (M4-A)
> 每个桶独立统计；桶与桶之间不做硬比。`unknown` 是合法桶（旧 envelope / 缺字段）。

| Platform | Protocol | Executor | Profile | Build commit | Requests | MCP | Errors | Tool calls | Trunc | Eval modes | Servers[] | RequestId samples |
|---|---|---|---|---:|---:|---:|---:|---:|---|---|---|
| unknown | v1 | codemode | gemini-text-json | 5039ac69d4e514bc11cdcc4fb2ce19d7dd5e234a | 206 | 206 | 6 | 97 | 69 | unknown:206 | unknown | `0271e7ca-d2dd-44d8-8902-ad38f2157743`, `04ea8e1f-65a1-42d6-922d-37dd8eb7044e`, `05623334-9d25-4299-ac8d-e52f1cd8c252`, `08d8bf5a-069e-4db5-ac53-32f975c809a3`, `0a820ad5-dd0f-44db-b91e-18b42c77ed46` |
| gemini | v1 | codemode | gemini-text-json | 3dd206f7238491e93f15c3ce39bce37c0e4bceba | 95 | 95 | 1 | 34 | 24 | unknown:95 | github, vercel, unknown, notion, linear, figma | `00c1d059-6d78-4c98-868f-a5d0fbaa5c82`, `03a21275-f6ac-4704-91c0-9b97fcee54b4`, `03b09af2-3e0b-4148-80c4-320071112a29`, `0442a80c-85a2-4fc1-a0fa-d8697ed42650`, `06b36205-bbd6-4df3-a619-741ffda52db9` |
| gemini | v1 | codemode | gemini-text-json | 42caaf2b9b8d8ce2f894efb2124a4036bf58ce72 | 83 | 83 | 0 | 45 | 35 | unknown:83 | github, unknown, notion, linear, vercel, figma | `0062db60-13a1-47c1-8f3a-bf5c3aab10a7`, `01aa399e-1821-4ab7-b5ac-e4da908dcec3`, `03c69a7d-d18e-485f-b029-140717b8a581`, `061aa6cf-0c1a-400f-bfee-ba802636cc92`, `07180124-1e64-4dfb-b076-dcccc8b82e05` |
| gemini | v1 | codemode | gemini-text-json | f2002d9ca48e55292eb824faa10b85b39ea35440 | 59 | 59 | 2 | 24 | 16 | unknown:59 | unknown, github, notion, linear, vercel, figma | `00681e06-efa5-4e53-b605-275d57364349`, `029529fb-078d-4f44-8e7e-4de3249fb826`, `068de11b-c2e0-4e9d-9263-12fff614b558`, `082b9b4f-17a6-4559-bd54-09042822e203`, `0959012e-617f-4795-a7b1-00396a45b968` |
| chatgpt | v1 | codemode | chatgpt-structured | 9eb0c7aa3d10d777d3066f858a67be39cc8303dd | 10 | 10 | 2 | 0 | 0 | unknown:10 | github, notion, vercel, linear, figma, unknown | `133571d5-73ca-4d25-8a3e-639d841332f4`, `5905c741-b982-41b4-8f20-42396bd7c31c`, `7486ed97-f666-4e1b-8661-644f6b1d93e9`, `7fbb79d6-9c37-4961-bdd9-af77814b4b48`, `841e0078-e70b-4ec8-8c37-99db4975fcf9` |
| chatgpt | v1 | codemode | chatgpt-structured | 42caaf2b9b8d8ce2f894efb2124a4036bf58ce72 | 9 | 9 | 0 | 8 | 1 | unknown:9 | github, linear, notion, vercel, unknown | `0178810f-e0ec-4296-b9c3-298c569dbbcb`, `0a3d1091-980e-4d98-ac55-abe8fa2f4003`, `276da6ce-0392-40e5-b0b1-8b54f40ec848`, `3cf07cb5-0ce4-4b0a-91c2-8fccc491ef16`, `5327f5a2-d334-4eb6-9fdc-0924e9bce923` |
| unknown | v1 | codemode | gemini-text-json | 3dd206f7238491e93f15c3ce39bce37c0e4bceba | 8 | 8 | 0 | 1 | 1 | unknown:8 | unknown, github, notion, vercel, figma, linear | `2494f7c3-2dc2-495c-a695-172014a69daf`, `31f79007-5823-441e-b0e7-378689e1e1e1`, `7a538363-ced2-4d10-87bb-ec871a5806b1`, `8390fdc8-2d28-4ede-b2a7-cb2cdb2d480f`, `b783b5c0-d830-48ac-8cc6-d0d7c7cb346b` |
| unknown | v1 | codemode | gemini-text-json | 9eb0c7aa3d10d777d3066f858a67be39cc8303dd | 7 | 7 | 7 | 0 | 0 | unknown:7 | unknown | `0b8671d5-4ee9-46bd-a550-0f106748396d`, `0dbba1c9-7c11-4c64-8655-bbbb2cf0b1f1`, `55cf0735-8b44-4cab-8296-bf360968652e`, `b3f8452d-1e7f-4cf8-8c85-9fdb2a0aec26`, `dba86fa1-ca03-42a7-8408-b731aca9cf31` |
| gemini | v1 | codemode | gemini-text-json | 5039ac69d4e514bc11cdcc4fb2ce19d7dd5e234a | 2 | 2 | 0 | 0 | 0 | unknown:2 | unknown | `b3283f6d-9b26-4044-982f-7b2ea1f59a1a`, `ca34bf94-5250-4db9-b045-1ac167a4b49c` |

## By servers[] (cross-upstream) — M4-A
> 只读 capture 显式 `servers[]`；缺失记 `unknown`，不从工具名反推。
> 一次请求串多个上游时，每个 server 各计一次；`multiServerRequests`=25。

| Server | Requests | MCP requests | Errors | Tool calls | Trunc suspects |
|---|---|---:|---:|---:|---:|
| unknown | 359 | 359 | 15 | 107 | 69 |
| github | 117 | 117 | 3 | 99 | 76 |
| vercel | 25 | 25 | 1 | 7 | 5 |
| linear | 22 | 22 | 1 | 4 | 2 |
| notion | 21 | 21 | 1 | 3 | 3 |
| figma | 20 | 20 | 1 | 2 | 1 |

## By eval mode (active / passive) — M4-A
> `evalMode` 缺省/非法一律 `unknown`，绝不按时间或来源猜测。

| Eval mode | Requests | MCP requests | Errors | Tool calls | Trunc suspects |
|---|---|---:|---:|---:|---:|
| unknown | 479 | 479 | 18 | 209 | 146 |

## Tool calls (MCP method)
- tools/call: 209
- tools/list: 106
- initialize: 79
- notifications/initialized: 76
- server/discover: 2

## Top upstream tools (legacy tally)
| Tool | Calls |
|---|---|
| execute_read | 110 |
| execute | 92 |
| search | 7 |

## Per-upstream stats (MCP tools/call)
| Upstream | Calls | Errors | Error rate | p50 ms | p95 ms | Avg ms | Truncated | Overflow | ModelTrunc | Error classes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| unknown | 278 | 4 | 0.0144 | 15 | 954 | 138 | 0 | 0 | 0 | upstream_4xx:3,auth:1 |
| github | 191 | 7 | 0.0366 | 3271 | 19381 | 5784 | 4 | 0 | 141 | upstream_4xx:6,auth:1 |
| linear | 1 | 0 | 0 | 512 | 512 | 512 | 0 | 0 | 0 | — |
| notion | 1 | 0 | 0 | 409 | 409 | 409 | 0 | 0 | 1 | — |
| vercel | 1 | 0 | 0 | 1118 | 1118 | 1118 | 0 | 0 | 0 | — |

## Per-MCP-tool stats
| Tool | Calls | Errors | Error rate | p50 ms | p95 ms | Avg ms | Truncated | Overflow | ModelTrunc | Error classes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| execute_read | 110 | 4 | 0.0364 | 2198 | 7862 | 2875 | 4 | 0 | 69 | upstream_4xx:3,auth:1 |
| execute | 92 | 4 | 0.0435 | 5272 | 35006 | 8661 | 0 | 0 | 73 | upstream_4xx:4 |
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
| listTools | 1 | {"count":153} |
| services | 3 | {"services":5} |

## Truncation / overflow
> Three independent signals. "Model truncation suspects" is the silent case:
> the gateway wire was complete, but the model received a materially shorter,
> unmarked projection (e.g. model code calling slice(0, 150)). It is advisory-only.

| Signal | Count | Rate |
|---|---:|---:|
| Truncated responses (gateway wire) | 4 | 0.0084 |
| Overflow captures (capture limit) | 0 | 0 |
| Model truncation suspects (silent, advisory) | 142 | 0.2965 |

### Model truncation suspects by server
| Server | Suspects |
|---|---:|
| github | 141 |
| notion | 1 |

### Model truncation suspects by tool
| Tool | Suspects |
|---|---:|
| execute | 73 |
| execute_read | 69 |

### Model truncation suspects by session
| Session | Suspects |
|---|---:|
| 84fc53cf-c9c7-4207-96a8-e9c0dcd697b3 | 36 |
| 719e47ce-57af-46a8-810f-8429d5d6d2fd | 28 |
| 2300fd1b-3d55-460e-9484-ad6babc559ac | 22 |
| 19ce3089-a7bf-4efa-a091-4dea724af835 | 11 |
| 90093089-4744-4073-b6ac-fcf159c3b10c | 11 |
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
| github:Bruce-Yii/gemini-mcp-gateway | gemini, chatgpt, unknown | 118 | 118 | 5 | 118 | 91 | 2026-11-24T00:01:08.813Z | 2026-11-24T21:21:22.381Z | `19ce3089-a7bf-4efa-a091-4dea724af835`, `033ebd44-57ac-4766-bbdb-7decb45ee3fb`, `719e47ce-57af-46a8-810f-8429d5d6d2fd`, `84fc53cf-c9c7-4207-96a8-e9c0dcd697b3`, `49939f51-7233-4858-a42e-18030de9ec4d`, `99307365-3ce0-4769-8724-b0648281f5c2`, `ef3d080d-6fe0-40f0-b2d0-5bde5e32d994`, `92977021-89ce-4e6a-8796-c1047a1a30cb`, `866f24c7-7d84-4eea-a206-562db8a5f2e8`, `2f577e16-ca5d-4b28-991f-83fe48a8a654`, `99faf544-aef7-4bcf-8ab4-9404504c7cb7`, `b2e272cc-ca29-4245-99fb-7169e0ecbc65`, `2857ba2b-5cdb-4bd4-bd0e-9a456403fa34` | `0062db60-13a1-47c1-8f3a-bf5c3aab10a7`, `00c1d059-6d78-4c98-868f-a5d0fbaa5c82`, `0178810f-e0ec-4296-b9c3-298c569dbbcb`, `01aa399e-1821-4ab7-b5ac-e4da908dcec3`, `07180124-1e64-4dfb-b076-dcccc8b82e05` |
| github:Bruce-Yii/recruitment-agent | unknown, gemini | 73 | 73 | 3 | 73 | 48 | 2026-11-24T00:06:20.209Z | 2026-11-24T19:13:59.003Z | `2300fd1b-3d55-460e-9484-ad6babc559ac`, `0fc836c7-42a3-4384-81f9-96ffd8fddd6f`, `90093089-4744-4073-b6ac-fcf159c3b10c`, `79adf4b8-75c7-48af-a987-9f1e79a06fce`, `8f67986d-f5ef-4e8d-8f38-dcbaccd471fb`, `57db68fa-c66a-4fd7-acbf-57bf43ec6d8d` | `0271e7ca-d2dd-44d8-8902-ad38f2157743`, `03a21275-f6ac-4704-91c0-9b97fcee54b4`, `05623334-9d25-4299-ac8d-e52f1cd8c252`, `068de11b-c2e0-4e9d-9263-12fff614b558`, `0959012e-617f-4795-a7b1-00396a45b968` |
| github:SalesforceAIResearch/MCP-Universe | gemini | 4 | 4 | 0 | 4 | 4 | 2026-11-24T21:02:16.665Z | 2026-11-24T21:03:21.561Z | `719e47ce-57af-46a8-810f-8429d5d6d2fd` | `0d70ccae-1b54-4e69-86d2-1b97c725c60e`, `6af0c73c-a7ed-4bb4-8814-f763191986b7`, `977e55c4-c793-475b-815e-204f99f32917`, `e0f254be-26c5-45b4-bfd3-72a7f6454d1c` |
| github:eval-sys/mcpmark | gemini | 3 | 3 | 0 | 3 | 2 | 2026-11-24T20:50:57.349Z | 2026-11-24T20:51:49.939Z | `719e47ce-57af-46a8-810f-8429d5d6d2fd` | `29b6bb87-c3bb-41a3-8605-92d5f61e3047`, `aa16e96f-9557-4723-a70f-48e8ab1d5cfc`, `c7437501-98ea-4f4d-a46b-dea3a890aa80` |
| github:scaleapi/mcp-atlas | gemini | 3 | 3 | 0 | 3 | 3 | 2026-11-24T21:02:16.665Z | 2026-11-24T21:02:52.255Z | `719e47ce-57af-46a8-810f-8429d5d6d2fd` | `6af0c73c-a7ed-4bb4-8814-f763191986b7`, `977e55c4-c793-475b-815e-204f99f32917`, `e0f254be-26c5-45b4-bfd3-72a7f6454d1c` |
| github:Bruce-Yii/gateway-acceptance-test | gemini | 2 | 2 | 0 | 2 | 2 | 2026-11-24T20:50:57.349Z | 2026-11-24T20:51:14.271Z | `719e47ce-57af-46a8-810f-8429d5d6d2fd` | `29b6bb87-c3bb-41a3-8605-92d5f61e3047`, `c7437501-98ea-4f4d-a46b-dea3a890aa80` |

## Requests by day
| Day | Requests |
|---|---:|
| 2026-11-24 | 479 |

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
| 19:00 | 44 |
| 20:00 | 35 |
| 21:00 | 26 |

## Non-MCP routes (kept separate)
| Upstream | Calls | Errors | Error rate | p50 ms | p95 ms | Avg ms | Truncated | Overflow | ModelTrunc | Error classes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| POST /mcp | 479 | 0 | 0 | 40 | 10599 | 2390 | 4 | 0 | 142 | — |

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
| — | — | — | — | 0 | 0 | 0 | 0 | — | — | — | — | — |

## Project timelines (batch 11, cross-session handoff)

> One project key can appear in multiple independent sessions/windows. Rows are
> ordered by first timestamp so a handoff is visible. Project tags are derived
> labels; a shared key does NOT prove the same client or the same task.

| Project | SessionId | Primary requests | Requests | MCP requests | Errors | Tool calls | Trunc suspects | First ts | Last ts | RequestId samples |
|---|---|---:|---:|---:|---:|---:|---:|---|---|---|
| — | — | 0 | 0 | 0 | 0 | 0 | 0 | — | — | — |
