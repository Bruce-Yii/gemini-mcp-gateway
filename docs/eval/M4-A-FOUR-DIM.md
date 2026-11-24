# M4-A — 四维分账与平台 / evalMode 过滤（2026-11-24）

> 对应 Issue #12（M4-A）。本文件只补必要说明：维度定义、命令、样例输出、环境核验结论、未验证项。
> 不改变 3 工具 schema，不部署生产，不打印任何 token/secret。
> 代码落位：`scripts/capture-digest.mjs`、`scripts/analyze-captures.mjs`；
> 测试：`tests/capture-digest.test.js`、`tests/capture-analyzer.test.js`。

## 1. 四维定义

| 维度 | 取值 | 来源（显式-only） | 缺失时 |
|---|---|---|---|
| `clientPlatform` | `gemini` / `chatgpt` / `claude` | 已在 capture 落地的显式字段（profile header / clientInfo / OAuth map / UA） | `unknown` |
| `protocolVersion` | `v1`（`/mcp`，codemode）/ `v2`（`/mcp/v2`，typed-plan） | 显式 `protocolVersion` 字段（未来采集）或请求路径 | `unknown` |
| `clientProfile` | `gemini-text-json` / `chatgpt-structured` / `claude-text` | capture 显式字段 | `unknown` |
| `buildCommit` | 提交 hash | `deployment.commit` | `unknown` |

规则：

- **不猜**：缺失 / null / 非字符串 / 未识别值一律进 `unknown`，不根据 UA、工具名、clientInfo 文本反推；
- `protocolVersion` 是**路由事实**：`/mcp` 的历史 envelope 记为 `v1`（不是猜测），无法从路径识别的才记 `unknown`；
- 桶与桶之间**不做硬比**（平台、协议、profile、build 各自独立分母），跨构建硬比仍然禁止。

## 2. capture-digest 新增分账

`node scripts/capture-digest.mjs --dir <fixture>` 的 scorecard 新增 5 节：

- `## By protocol version (v1 / v2) — M4-A`（含 executor：codemode / typed-plan）；
- `## By client profile — M4-A`；
- `## Four-dimension ledger — platform × protocol × profile × build (M4-A)`；
- `## By servers[] (cross-upstream) — M4-A`（含 `multiServerRequests`）；
- `## By eval mode (active / passive) — M4-A`。

JSON 侧新增字段（全部 additive，旧字段保持不变）：
`byProtocolVersion`、`byClientProfile`、`byBuildCommit`、`byEvalMode`、`byServerTag`、
`multiServerRequests`、`byFourDimension`、`fourDimensionSummary`。

样例（本地 10 条 fixture 实跑，非真实 R2 数据）：

```
| Platform | Protocol | Executor | Profile | Build commit | Requests | MCP | Errors | Tool calls | Trunc | Eval modes | Servers[] |
| gemini | v1 | codemode | gemini-text-json | 5039ac6abc | 3 | 3 | 1 | 3 | 0 | active:2, unknown:1 | github, vercel, unknown |
| gemini | v2 | typed-plan | gemini-text-json | 5039ac6abc | 2 | 2 | 0 | 1 | 0 | passive:1, active:1 | notion, github |
| chatgpt | v1 | codemode | chatgpt-structured | 5039ac6abc | 1 | 1 | 0 | 1 | 0 | active:1 | github |
| chatgpt | v2 | typed-plan | chatgpt-structured | 5039ac6abc | 1 | 1 | 0 | 1 | 0 | passive:1 | github, linear |
| claude | v1 | codemode | claude-text | 5039ac6abc | 1 | 1 | 0 | 1 | 0 | passive:1 | vercel |
| unknown | v1 | codemode | unknown | 5039ac6abc | 1 | 1 | 0 | 1 | 0 | unknown:1 | unknown |
```

## 3. analyze-captures 新增过滤

```bash
node scripts/analyze-captures.mjs \
  --dir <fixture> \
  --platform gemini --eval-mode active \
  --last-minutes 60 --commit 5039ac6 \
  --dry-run
```

- 可组合：`--platform` / `--eval-mode` / `--last-minutes` / `--commit`（以及既有 `--dir/--date/--since/--days`）；
- **非法参数直接报错并退出 1**，不静默忽略：
  - `--platform bogus` → `[analyze] invalid --platform "bogus": expected gemini|chatgpt|claude`
  - `--eval-mode bogus` → `[analyze] invalid --eval-mode "bogus": expected active|passive`
  - 缺值 / `--last-minutes 0` / 空 `--commit` 同样报错；
- 过滤后 analyzer input 新增：
  - `filters`（本次生效的过滤条件）；
  - `dimensions`（`byClientPlatform` / `byProtocolVersion` / `byClientProfile` / `byBuildCommit` / `byEvalMode` / `byServerTag` / `byFourDimension` / `multiServerRequests`）；
  - 每个 `samples[]` 增加 `clientPlatform` / `clientProfile` / `protocolVersion` / `executor` / `evalMode` / `buildCommit` / `servers`；
- 提示词新增一条约束：四维桶相互独立，禁止跨桶、跨构建硬比。

本地实跑（fixture）：

```text
$ node scripts/analyze-captures.mjs --dir work/m4-a-fixture --platform gemini --eval-mode active --last-minutes 60 --dry-run
[analyze] dry-run: 1 clusters, 3 requests, 1 days, filters=platform=gemini, evalMode=active, lastMinutes=60
```

生成的 input 中 `dimensions.byProtocolVersion` 为 v1=2 / v2=1，`byFourDimension` 2 行；
证明过滤与四维分账在同一管线生效。

## 4. 环境核验：`CLIENT_PLATFORM_OAUTH_MAP`

只读检查 Vercel 项目 env（不打印任何值）：

```text
结果：UNKNOWN
原因：本机 Vercel CLI token 被 API 拒绝（forbidden / invalidToken），无法读取 production/preview env。
未读取、未打印、未提交任何环境变量值；没有用猜测填充结论。
```

若人工在 Vercel 配置了该变量，按 `src/client/client-platform.js` 的约定：
`CLIENT_PLATFORM_OAUTH_MAP` 是 `{ "<oauth client id>": "gemini|chatgpt|claude" }` 的 JSON 字符串；
未配置 / 解析失败时映射不生效（回落 `unknown`），不会猜平台。

## 5. 未验证项 / 边界

- 没有真实 R2 凭据，**没有跑真实线上 capture**；本文所有样例均来自本地 fixture（`work/m4-a-fixture`，gitignored）；
- `clientPlatform` 的真实分账效果仍取决于 `CLIENT_PLATFORM_OAUTH_MAP` 是否配置（本任务未能核验）；
- `protocolVersion` 目前由路径推导；capture 侧尚未写显式 `protocolVersion` 字段（本任务写作用域不含 `src/evidence/capture.js`）；
- 历史 envelope 没有新字段：平台/profile/build/servers/evalMode 记 `unknown`，协议按路径记 v1/v2；
- 四维分账不改变任何基线/验收结论，不能拿它反推“网关质量提升”。
