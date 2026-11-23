# Batch 11 · 发版/重启后旧会话工具消失：缓解方案调研（只读，2026-11-23）

> 范围：**只读调研 + 写本台账**。未改 `src/`、`scripts/`、`tests/`、`README`、其他 `docs/`、workflows；未 commit / push / deploy。
> 对应派发：B12 `reconnect-research`（`docs/ledger/batch-12-active.md:17`）。
> 证据标记：**[官方]** = 官方规范/厂商文档逐字可查；**[代码]** = 本仓库当前源码可查；**[事实]** = 用户提供的线上事实；**[未验证]** = 推断或仅二手材料，不可当结论。

## 一、问题界定（先说边界）

**[事实]** 2026-11-22 Batch 11 部署后，Gemini 旧会话的工具消失，调用返回 `unknown_tool` / `not-found`；用户在对话里手动 `@Gemini Mcp Gateway` 后恢复。

**[代码]** 网关现状（`src/server.js:399–511`）：

- `/mcp` 只有 `POST` 是真实 MCP 入口；`GET` → 405（`Allow: POST, DELETE`），`DELETE` → 204；
- **stateless**：每个 POST 新建 `McpServer` + `StreamableHTTPServerTransport`，`sessionIdGenerator: undefined`，请求结束即关闭，没有任何服务端 session 状态；
- `initialize` 时生成 `Mcp-Session-Id` **只是 capture/eval 的相关性标记**，不是服务端状态（`:455–464`）；`Mcp-Session-Id` 头有/无都按同一路径处理（`:453–454`）；
- `GET /healthz` 暴露 `commit` / `buildHash` / `builtAt` / `deploymentId` / `env`（`src/vercel-app.js:169–196`，`src/build-info.js`）。
- `listChanged` 未声明/未发（`docs/ledger/mcp-2026-07-compat.md:64,100`）。

**核心边界（不要写虚假承诺）**：Gemini Web / Connected Apps 的 MCP 客户端由 Google 控制，**网关无法主动让它重连，也无法把新工具快照推进已经建立的会话**。具体说：

1. 网关不能调用任何"客户端重连 API"——MCP 没有这样的标准方法；服务端主动消息只能走 notifications/订阅流，而我们的 GET 是 405，没有常驻通道；
2. 即使发了 `notifications/tools/list_changed`，**[事实]** 本项目已确认 Gemini 不消费它（`AGENTS.md`、`docs/WHY.md:61`、`docs/ledger/mcp-2026-07-compat.md:70`），且 [官方] Google Connected Apps 文档明确"工具列表在注册/摄入时抓取"（见 [Google: server optimization](https://developers.google.com/connected-apps/mcp/server-optimization) 的 *Resource ingestion at registration time*，同类语义为 tool ingestion）；
3. 网关**没有**办法让 Google 代理重新执行 `tools/list` 或重建已经缓存的工具描述；唯一已知的恢复动作就是用户手动重挂载（`@Gemini Mcp Gateway`）。

> **[未验证]** 旧会话报 `unknown_tool`/`not-found` 的具体内部机制（Google 侧缓存失效 / 工具名变更 / deployment 漂移）没有抓到 Google 客户端的 wire 证据；本台账只列"可用的缓解"，不对 Google 内部行为下结论。参见 `docs/ledger/batch-11-recent.md:73–77` 已记录的实测：新窗口会 `initialize` 并回传 session 头，**旧窗口不一定重新 initialize**。

---

## 二、Vercel 能力核查：能否让旧连接命中旧 deployment / 平滑切换？

### 2.1 Skew Protection —— 对本场景**无效**

**[官方]** [Vercel Skew Protection](https://vercel.com/docs/skew-protection)：

- 机制是**版本锁定**：框架在客户端请求上带部署 ID，Vercel 把请求路由回"最初服务页面的那个 deployment"。携带方式只有三种：`?dpl=` 查询参数、`x-deployment-id` 头、`__vdpl` cookie；
- 支持框架是 Next.js / SvelteKit / Qwik / Astro / Nuxt / React Router；其他框架需**自己**在客户端请求上追加这些标记（读 `VERCEL_SKEW_PROTECTION_ENABLED` / `VERCEL_DEPLOYMENT_ID`）；
- **文档导航（top-level document request）不被 pin**，一律打到最新 production deployment；
- 跨源请求默认忽略部署 ID，除非配置 "Allowed Domains for Cross-Site Fetch"（最多 12 条）；
- 默认最大年龄 Pro 12 小时 / Enterprise 1 天，可提高到不超过 Deployment Retention；被删除的 deployment 不可访问；
- **计划限制**：仅 **Pro / Enterprise** 可用；Hobby 不可用（[官方](https://vercel.com/docs/skew-protection) 页面首段）；设置需 owner/admin/member 角色 + 开启 System Environment Variables 访问权 + 重新部署。

**判断（DEC）**：**不采用**。理由不是计划 cost，而是机制根本不匹配：

- 我们的"客户端"是 Google 的服务器侧代理，不是浏览器里的 Next.js/Astro 应用；它不会携带 `?dpl=` / `x-deployment-id` / `__vdpl`；我们**不能修改 Google 客户端去加这些头**；
- 即使我们给自己的响应加 `Set-Cookie: __vdpl`，Gemini 的 MCP 请求不经过我们的浏览器，cookie 不起作用；
- 即使命中旧 deployment，也只是"继续用旧工具面"——解决的是"版本漂移导致的 payload 不兼容"，**不是"客户端缓存快照已失效"**；本次故障是工具消失，旧 deployment 上工具也仍在，但客户端缓存已经不认它。
- **[未验证]** 若某天我们自建 Web 客户端（浏览器里点"使用 Gemini"），Skew Protection 才可能有用；本仓库无此客户端。

### 2.2 稳定 alias / 域名 + 手动 promote / rollback —— **有条件可用**

**[官方]** [Promoting Deployments](https://vercel.com/docs/deployments/promoting-a-deployment) 与 [`vercel alias` CLI](https://vercel.com/docs/cli/alias)：

- 生产分支合入默认自动把自定义域名指向新 deployment；
- 可以关掉 "Auto-assign Custom Production Domains"，改为 staged build 后手动 `vercel promote <deployment>` 提升；提升是**重新指向已有 deployment，不重新构建**，即时生效；
- `vercel rollback [deployment-id]` 把域名指回旧 deployment；同样不重建，但**不重建环境变量**；
- 每个项目同时只跑一个 promote/rollback 后台任务（3 分钟未完成视为 stale）；
- `vercel alias set` 仍可用，但官方推荐优先用 `vercel --prod --skip-domain` / `vercel promote` / `vercel rollback`；
- 域名冲突要查 alias 归属（`vercel alias list --scope ... --limit 100`，默认 20/最大 100）。

**判断（DEC）**：**alias 本身已经存在且必须保持**——[事实] 线上有稳定域名 `<your-domain>`（`AGENTS.md`、`docs/OPEN-SOURCE/DEPLOYMENT-TEMPLATES.md`）。这对"域名不变、OAuth metadata/OAuth 注册不失效"是必要条件，但**不能缓解旧会话工具消失**：因为别名切换的是"新请求打到哪个 deployment"，而旧会话的问题是"客户端缓存的工具快照"，换 deployment 不触发快照刷新。可用的只是**回滚止血**：若某次发版确实引入了工具名/schema 变化，立刻 `vercel rollback` 指回旧 deployment，让新会话正常，再引导用户重挂载（见第五节发布窗口）。

### 2.3 滚动发布 / "让旧连接留在旧 deployment" —— **不适用**

**[官方]** Vercel 的 promote/rollback 是**域名级别的原子重指向**，不是按连接粒度的流量切分；官方没有提供"已有 MCP 会话粘在旧 deployment、新会话打新 deployment"的能力（Skew Protection 是按请求标记路由，见 2.1；本场景客户端不会携带标记）。**[未验证]** Canary / 流量百分比类能力即使存在，也无法按"会话"维度工作，且其配置不在本任务调研范围；不写入建议。

### 2.4 计划限制小结

| 能力 | 计划要求 | 本项目取舍 |
|---|---|---|
| Skew Protection | **Pro / Enterprise only**；默认 12h(Pro)/1d(Enterprise)，受 Retention 上限约束 | 不做（机制不匹配） |
| Instant rollback / promote | Vercel 标准部署能力（[官方](https://vercel.com/docs/deployments/promoting-a-deployment) 页面未列 Pro 门槛） | 作为**止血手段**保留 |
| 自定义域名 / alias | 标准能力 | 已使用，保持不换 |
| GET SSE 常驻通知流 | 平台支持但 `maxDuration: 60`（`docs/OPEN-SOURCE/DEPLOYMENT-TEMPLATES.md:290`） | 不做（见 3.5） |

---

## 三、MCP 协议里有没有"重启 / 工具列表变化"的标准通知？

### 3.1 `notifications/tools/list_changed` —— [官方] 有，但需客户端消费且需通道

**[官方]** [MCP 2025-11-25 规范 · Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools.md)：

- 支持 tools 的 server **MUST** 声明 `tools` capability，其中 `listChanged` 表示"工具列表变化时是否发通知"；
- server  declaring `listChanged` 后，工具列表变化时 **SHOULD** 发 `notifications/tools/list_changed`；
- 客户端收到后应重新发 `tools/list`。

**[事实]** 本项目 `listChanged` 未开启（`docs/ledger/mcp-2026-07-compat.md:64`），且 Gemini 不消费该通知（`AGENTS.md` 硬规则）。**因此发它不会让旧会话工具回来。**

**[未验证]** 其他客户端消费情况（仅二手材料，不构成结论）：Gemini **CLI**（不是 Gemini Web Connected Apps）曾有 `tools/list_changed` 支持 bug，2026-03 有修复 PR（[gemini-cli #21050](https://github.com/google-gemini/gemini-cli/pull/21050)），2026-11 仍有相关超时修复（[gemini-cli #30401](https://github.com/google-gemini/gemini-cli/pull/30401)）；TS SDK 的 `sendToolListChanged()` 会让"客户端收到后重新 `listTools()`"（[TS SDK 文档](https://ts.sdk.modelcontextprotocol.io/v2/servers/notifications)）。这些都**不能外推到 Gemini Web**。

**[官方]** 2026-07-28 规范进一步改变了通知模型： GET 端点被 `subscriptions/listen`（POST 长流）替代，list 结果新增 `ttlMs`/`cacheScope`，并要求 `tools/list` 返回确定性顺序（[官方 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog.md) 主要变更 4、次要变更 3/5）。但 [官方] Google Connected Apps 只支持到 `2025-11-25`（[Google server optimization](https://developers.google.com/connected-apps/mcp/server-optimization)），我们已经审计决定不迁移（`docs/ledger/mcp-2026-07-compat.md`）。**继续不做。**

### 3.2 `404 Session not found` + 客户端重新 initialize —— [官方] 有，但只有"合规客户端"会用

**[官方]** [MCP 2025-11-25 · Streamable HTTP / Session Management](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports.md)：

1. server **MAY** 在 initialize 响应里给 `MCP-Session-Id`；
2. 给了之后客户端 **MUST** 在后续每个请求带上；
3. server **MAY** 随时终止 session，终止后对带该 ID 的请求 **MUST** 回 `404 Not Found`；
4. 客户端收到 404 后 **MUST** 发起新的 `InitializeRequest`（不带 session ID）重建会话。

这是协议内最接近"server 重启通知"的标准机制。但：

- **[代码]** 我们是 stateless，不维护 session 状态，也**不会回 404 Session not found**（非法路径回 404 text/plain，合法 `/mcp` 只要 body 合法就处理）；不能人为制造 404 来"提示客户端重连"——那会破坏所有正常客户端；
- **[未验证]** 即使我们改成 stateful 并在重启后回 404，也无法证明 Gemini Web 会遵循第 4 条重新 initialize 并重新 `tools/list`；AGENTS.md 的硬规则和线上现象（`unknown_tool` 要手动 @ 才恢复）恰恰提示它**没有**自动做这件事；
- **[官方]** 2026-07-28 已移除 protocol-level session 和 `Mcp-Session-Id`（changelog 主要变更 1/2），押注在 404 机制上会与技术方向背离。

**判断（DEC）**：不引入 stateful session、不发 404 重连信号。

### 3.3 server `instructions` —— [官方] 是"模型提示"，不是重连信号

**[官方]** [Google Connected Apps: Server instructions](https://developers.google.com/connected-apps/mcp/server-optimization#write-server)：instructions 被当作"加入 system prompt 的 model hint"，用于说明 server 的用途/范围；不是会话控制信道，也不会触发工具重新摄入。Google 的规范还要求 instructions 不要重复列举工具名。

**[未验证]** 在 instructions 里写"若工具列表异常请提示用户 @Gemini Mcp Gateway"是否真的会被模型照做——可以在不破坏现有契约的前提下做（instructions 文本变化不需要重连，见 `docs/HANDOFF.md:36`），但**不承诺效果**；可作为低成本提示项（见 4.6）。

### 3.4 `Retry-After` —— [官方] 无 MCP 标准语义

**[未验证]** `Retry-After` 是 HTTP 语义（RFC 9110），不是 MCP 定义的"重启/工具变更"信号；MCP 规范里没有把它定义为重连提示。Google Connected Apps 文档给出的错误码体系（`-32300`~`-32502`，[官方](https://developers.google.com/connected-apps/mcp/server-optimization#mcp-error-handling)）也没有"请重新初始化"的代码。**不能靠它让客户端重挂。**

### 3.5 keepalive / SSE 取舍 —— 不选

**[官方]** Streamable HTTP 允许 GET 开 SSE，也允许 server 回 405（[MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports.md)）；[官方] Google Connected Apps 明确"stateless / request-response 服务器返回 405 被客户端代理干净处理"。

**[代码]** 我们已选 405（`src/server.js:484–491`）。若改为 GET SSE 常驻流：

- 需要 session 状态或订阅状态（与 stateless 设计冲突）；
- Vercel `maxDuration: 60`，长连接会被掐断，需要 SSE 重连/`Last-Event-ID` 恢复；且 2026-07-28 已移除 SSE resumability；
- 最关键：**Google Web 客户端是否消费 list-changed 流未经证实**，成本/收益不成立。

**判断（DEC）**：**不开 SSE**，保持 405。

---

## 四、网关侧可做的缓解（按成本/收益排序）

> 前提：以下都是"降低发生概率 / 缩短恢复时间 / 提高可观测性"的缓解，**没有一项能保证旧会话自动重连**。

| # | 缓解 | 成本 | 收益 | 结论 |
|---|---|---|---|---|
| 1 | **保持工具名 + 参数 schema 跨版本稳定；变更只走版本化路径 `/mcp/v1`、`/mcp/v2`** | 极低（已是现状） | **最高**：消除"缓存快照与新工具面不一致"的根因；Google 官方明确推荐路径版本化 | **做（维持）** |
| 2 | **[事实] 稳定 alias 不换域名；不随发布轮换 OAuth metadata / issuer / client 注册信息** | 极低（已是现状） | 高：避免 OAuth 重新授权与注册漂移叠加在工具消失上 | **做（维持）** |
| 3 | **发布窗口 + staged promote/rollback runbook**：避开用户高频时段；先 staged（`--prod --skip-domain`）验证 `/healthz` 的 `buildHash`/`deploymentId` 和 `tools/list`，再 `vercel promote`；出问题立即 `vercel rollback` | 低（文档 + 流程，无代码） | 中高：把"用户撞上发布瞬间"的概率和 MTTR 降下来 | **做（新增 runbook）** |
| 4 | **发版前 `tools/list` 契约守门**：CI / 部署前脚本比对新旧工具名与 schema 的 digest；有差异就强制走版本路径 | 低-中（需写脚本，本任务不改代码） | 中高：把第 1 条从"纪律"变成"机制" | **建议做（另行排期，不在本批次写代码）** |
| 5 | **强化错误信息**：当 `tools/call` 命中未知工具名时，返回可执行的 model-visible 提示（如"工具面已更新，请在 Gemini 里重新 @Gemini Mcp Gateway 复挂载后重试"），用 Google 规定的 error message 透传（`-32601 METHOD_NOT_FOUND` 或工具结果 `isError:true`） | 低（仅错误文案） | 中：不修复自动重连，但把"静默失败"变成"用户知道该做什么" | **建议做（独立小改动，需 lead 批准）** |
| 6 | **`/healthz` 已具备部署身份；增加发版事件记录**（把 `buildHash`/`deploymentId` 与事故时间段写入台账） | 低 | 中：便于事后确认"旧会话撞上哪次部署"，支撑 2.2 的回滚判定 | **做（流程，不改代码）** |
| 7 | README / 用户文档加一句"发版后若工具暂时不可用，手动 @一次即可恢复" | 极低 | 低-中：只改善体验，不是修复 | **可做（需 lead 决定，本任务不改 README）** |
| 8 | instructions 提示模型在工具异常时引导用户重挂载 | 低（文本变化，不需重连） | **[未验证]** 低：模型是否照做未知 | **不做**（收益未证实，且 Google 要求 instructions 不写成行为指令） |
| 9 | 开启 Skew Protection | 中（Pro/Enterprise + 配置） | **≈0**：客户端不携带标记，机制不匹配 | **不做** |
| 10 | 改 stateful session / 404 触发重新 initialize | 高（架构改造 + OAuth 影响） | **[未验证]** 低：无法证明 Gemini Web 会重连 | **不做** |
| 11 | 开 GET SSE 常驻流 + `list_changed` | 高（Vercel 60s、resumability、客户端未证实） | 低 | **不做** |
| 12 | 版本化 endpoint 双栈长期并行（`/mcp/v1` + `/mcp/v2`） | 中（运维双份） | 中：给"用户重挂载"一个明确的新 URL，避免新旧工具面混淆 | **条件做**：仅当确实要变更工具名/schema 时启用；当前工具面稳定，暂不引入 |

### 与"发布窗口"配套的最小 runbook（不写代码）

1. 发布前：`node scripts/write-build-info.mjs --print`（本地）对比 `GET /healthz` 的 `buildHash`，确认当前线上版本；
2. 变更若涉及工具名/schema → **禁止原地发**，先开 `/mcp/v2` 并保留 `/mcp/v1`；
3. 用 `vercel --prod --skip-domain` 做 staged build；验证 `/healthz` + `tools/list` 工具名集合；
4. 低峰时段 `vercel promote <deployment>` 切流；观察 capture/digest 里 `unknown_tool`/`not-found` 与 `mcpErrors`；
5. 异常立即 `vercel rollback <deployment>`（注意：不重建环境变量）；
6. 公告/文档提示用户手动 `@Gemini Mcp Gateway` 重挂载——**这是唯一已验证有效的恢复动作**，不要描述成"自动恢复"。

---

## 五、结论：建议做 / 不做

**建议做（最小改动）**：

1. **不改代码**，只做流程与文档约束：把"工具名/schema 跨版本稳定、变更走 `/mcp/v1|v2`"写进发版检查单；保持稳定 alias 与 OAuth metadata 不变；
2. **新增一份发布/回滚 runbook**（可放在本台账或单独 docs，由 lead 决定），包含 staged promote → 验证 `/healthz` 与 `tools/list` → 低峰 promote → 异常 rollback → 提示用户重挂载；
3. **错误信息可读性**作为独立小改动候选：在 unknown-tool 路径返回明确的"请手动重挂载"提示；**需 lead 确认后再排期**，本批次不写。

**建议不做**：

- 不做 Skew Protection（Pro/Enterprise 限制是次要原因，主因是 Google 客户端不携带部署标记）；
- 不做 stateful session / 404 重连 / SSE 常驻 / `list_changed` 推送（对 Gemini Web 无证据有效，且 Vercel 60s 与 2026-07-28 方向都不支持）；
- 不承诺"自动重连"——**网关没有这个能力**；任何文档/回复都应写"手动 `@Gemini Mcp Gateway` 可恢复"。

**最小改动定义**：**只新增本台账（已完成）**；代码零改动。若要再进一步，唯一值得的后续改动是第 5 项错误文案（改 `src/` 需另开任务并跑全量测试）。

## 六、证据来源（全部外部链接为只读调研所得）

- Vercel: [Skew Protection](https://vercel.com/docs/skew-protection)、[Promoting Deployments](https://vercel.com/docs/deployments/promoting-a-deployment)、[vercel alias](https://vercel.com/docs/cli/alias)
- MCP 规范: [2025-11-25 Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools.md)、[2025-11-25 Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports.md)、[2026-07-28 Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog.md)
- Google: [Connected Apps MCP server optimization](https://developers.google.com/connected-apps/mcp/server-optimization)（版本上限 2025-11-25、405 语义、路径版本化、instructions、错误码）
- 客户端生态（**[未验证]**，仅作旁证）：[gemini-cli #21050](https://github.com/google-gemini/gemini-cli/pull/21050)、[gemini-cli #30401](https://github.com/google-gemini/gemini-cli/pull/30401)、[TS SDK notifications](https://ts.sdk.modelcontextprotocol.io/v2/servers/notifications)
- 仓库内：`AGENTS.md`、`docs/HANDOFF.md:35–37`、`docs/ledger/mcp-2026-07-compat.md:64,70,100`、`docs/ledger/batch-11-recent.md:73–77`、`docs/OPEN-SOURCE/WEB-CLIENTS.md:31`、`docs/OPEN-SOURCE/DEPLOYMENT-TEMPLATES.md:108,290`、`src/server.js:399–511`、`src/vercel-app.js:169–196`、`src/build-info.js`
