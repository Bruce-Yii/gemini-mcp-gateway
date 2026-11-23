# Batch 16 · G-04 — callTool 复核 allow/deny

> 日期：2026-11-24（Asia/Singapore）。范围：全仓库审计 `FULL-REPO-FINDINGS.md` §2 / `15-src.md` §1.5 的 G-04。
> 状态：本地工作树已修 + 确定性测试。**未 commit / push / deploy。** 生产仍旧构建（AGENTS.md §0）。
> 写作用域严格限定：`src/upstreams.js`、`tests/fix-g04.test.js`（新增）、本文档。

---

## 0. 边界与不变量

- **不联网**：全部测试用 fake MCP client + fake 上游调用记录，无真实 URL / 凭据。
- **不改工具面**：三工具 `search` / `execute_read` / `execute` 的名称、顺序、schema、annotations 未变；v1/v2 路由未动。
- **不破坏现有 connect 过滤**：`connect()` 里的 `isAllowed(config, entry)` 过滤原样保留；本次只是**增加**一层调用时复核。
- **capture 双投影边界不变**：新增错误是稳定、无 secret 的本地错误，不改写 raw `Error.message`，不触碰 capture 脱敏策略。

---

## 1. 根因

- `src/upstreams.js` 原 `callTool(server, tool, args)`：
  - L472 仅用 `this._clients.get(server)` 确认 server 已连接；
  - L480 用 `this.entries.find(...)` 查条目**只为了拿 inputSchema 做参数归一化**；
  - L498 直接 `record.client.callTool({ name: tool, ... })`，工具名来自调用方，**从不经过 `isAllowed()` 复核**。
- allow/deny 只在 `connect()` 灌入 `this.entries` 时应用一次（L435）。`getWhitelist()` 再过滤一次也只影响 catalog。
- `src/server.js` 的 `gateway_call`（`CALL_TOOL.handler`，L282）把入参 `server` / `tool` 原样传给 `callTool`；Code Mode 的 `codemode.<tool>` 桥同样汇聚于此。因此模型/guest 只要知道 server 上存在某工具名，就能绕过 connect 时的目录过滤：
  - 被 `denyTools` 拒绝的工具仍可调；
  - 不在 `allowTools` 白名单里的工具仍可调；
  - 甚至上游未暴露的任意工具名也会直接打到 SDK。
- 审计定位：`FULL-REPO-FINDINGS.md` G-04（`upstreams.js:480-498`）；`15-src.md` L206 / L344。

---

## 2. 修复

全部改动在 `src/upstreams.js`：

### 2.1 保存完整工具清单

- `connect()` 里把 `this._clients.set(name, { client, transport, config })` 改为同时保存 `tools`（原始 `client.listTools()` 结果）。
- 这是复核的权威数据源：`entries` 已被 connect 过滤，不能用来判断“被 deny 的工具是否存在”；必须用完整清单判断工具存在性 + 构造策略评估 entry。

### 2.2 callTool 里在发上游请求前复核

按顺序、在任何上游动作之前：

1. server 未连接 → 原错误不变（`未连接或未配置的上游`）。
2. **工具存在性**：若已存完整清单且请求的工具名不在其中 → 抛 `UNKNOWN_UPSTREAM_TOOL`（稳定错误），不发请求。
3. **allow/deny 复核**：用 `{ server, tool, name: server__tool, inputSchema, ... }` 调 `isAllowed(record.config, policyEntry)`；不通过 → 抛 `TOOL_POLICY_DENIED`（稳定错误），不发请求。
   - `isAllowed` 沿用 `src/catalog.js` 的既有语义：deny 优先 → allow 白名单 → 空数组等同默认放行。本次不复制/改写策略逻辑，直接复用唯一真源。
4. 之后才做参数归一化、Figma guard/cache、`record.client.callTool(...)`。

### 2.3 稳定错误

- `policyDeniedError(server, tool)`：`code='TOOL_POLICY_DENIED'`，message=`[upstream:<server>/<tool>] 工具被 allow/deny 策略拒绝调用`。
- `unknownToolError(server, tool)`：`code='UNKNOWN_UPSTREAM_TOOL'`，message=`[upstream:<server>/<tool>] 上游未暴露该工具`。
- 两者均为普通 `Error` + 字符串 code，无 secret；模型可见路径 `server.js:errorMessage()` 的脱敏包装天然兼容。

### 2.4 向后兼容

- 手工注入 `_clients` 且没有 `tools` 的调用方（如 `figma-guard.test.js`、`normalization.test.js`）：不触发“未知工具”拒绝，策略评估退化为按名字构造的最小 entry；配置无 allow/deny 时行为与修前一致。
- 归一化优先用 `entries` 里的 catalog 条目，缺失时用复核用的 `policyEntry`（含原始 inputSchema），不影响 camelCase 别名归一化。

---

## 3. 证据

### 3.1 确定性测试

新增 `tests/fix-g04.test.js`，17 项全过，离线（fake server / fake manager，无网络）：

| 覆盖 | 断言 |
|---|---|
| connect 过滤未破坏 | deny 工具不在 entries/whitelist |
| default allow | 无规则时工具可达上游 |
| allowTools 白名单 | 命中可达；未命中 `TOOL_POLICY_DENIED` 且上游 0 调用 |
| allowTools 通配符 | `svc/*` 命中可达 |
| denyTools 黑名单 | deny 命中 `TOOL_POLICY_DENIED` 且上游 0 调用；未命中可达 |
| denyTools 通配符 | `svc/*` 全阻断 |
| deny 优先 | `allow:'*'` + deny 命中仍拒绝；同时在 allow/deny 仍拒绝；allow+deny 下非 deny 工具可达 |
| 空数组语义 | `[]/[]` = 默认放行；`allowTools:[]` + 非空 deny 仅按 deny |
| 未知工具 | `UNKNOWN_UPSTREAM_TOOL` 且上游 0 调用；未知 server 保留原错误 |
| 重复/并发绕过 | 连续 3 次 deny 全阻断；并发 allowed+denied 只放行 allowed |

单文件实跑：`node --test tests/fix-g04.test.js` → 17 tests / 17 pass / 0 fail。

### 3.2 全量测试

本次会话实跑 `npm test`：`1453 tests / 1445 pass / 2 fail / 6 todo`。

- 2 个失败均在 `tests/fix-g13.test.js`（G-13 capture-queue 去重窗口的 timing/容量断言），与 G-04 无关：
  - 独立重跑该文件失败项会变化（一次是 `LRU touch keeps the shield`，一次是 `long burst ...`），确认为 flaky / 并行改动未收敛；
  - `src/capture-queue.js`、`tests/fix-g13.test.js` 属其它 agent 的写作用域，本次未碰。
- G-04 相关回归单独实跑：`node --test tests/fix-g04.test.js tests/upstreams.test.js tests/figma-guard.test.js tests/normalization.test.js tests/reconnect-server.test.js` → 58 tests / 58 pass / 0 fail。
- 最终基线数字以 lead 合并各并行修复后的最近一次全量结果为准。

---

## 4. 未验证项 / 已知边界

- **未部署**：生产仍旧构建；部署后须重跑 healthz / tools/list / 在线复验（AGENTS.md §0）。
- **未做真实客户端验证**：无真实 Gemini / guest 会话，本修复只证明本地 callTool 边界；端到端绕过复现需在真实客户端再跑一次。
- **未授权**：AUTH-READY 仍 NOT READY；本修复不涉及授权门禁。
- **`isAllowed` 策略语义未改**：只复用 `src/catalog.js` 现有实现；pattern 通配符的边界（大小写不敏感、candidate 集合）不在本次范围。
- **手工注入 `_clients` 的无 tools 路径**：为兼容既有测试保留宽松行为；生产路径始终经 `connect()`，必有完整 tools。
- **不做 commit**：按要求仅本地工作树修改。
