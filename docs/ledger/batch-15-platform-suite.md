# B15 平台 conformance 离线测试套件落地台账

> 归属：`platform-suite` agent（lead 派发）。
>
> 范围（严格三文件）：
> - 新增 `tests/platform-conformance-suite.test.js`
> - `docs/eval/PLATFORM-CONFORMANCE-MATRIX.md`：只更新顶部署名状态与新增
>   §9「测试落地状态」，§1–§8 矩阵行状态未改
> - 新增本台账
>
> 不改 `src/`、`scripts/`、其他 `tests/`、`README`、workflows。不 commit / push / deploy。
> 不联网；不碰真实凭据。

## 一、输入事实（只读）

- `src/client-profile.js`：`resolveClientProfile` / `encodeToolResult` /
  `encodeModelOutput` / `applyProfileToTools` / `CLIENT_PROFILES`（frozen）。
  Gemini 默认 text JSON 且不带 `structuredContent`；ChatGPT 双编码；Claude text + annotations。
- `src/client-platform.js`：`detectClientPlatform`；unknown → `unknown` +
  `gemini-text-json`，仅显式信号才识别非 unknown。
- `src/sanitize.js`：`sanitizeTool` / `sanitizeInputSchema`（array 必有 items、
  多类型折叠、oneOf/anyOf ≤ 8、annotations 显式布尔）。
- `src/codemode.js`：`createCodeModeTools` / `toModelOutput` / `validateToolArgs`；
  三工具 `search` / `execute_read` / `execute`，schema 只有 `code`，**无 `plan`**。
- `src/oauth.js::isAllowedRedirectUri`：Claude 回调
  `https://claude.ai/api/mcp/auth_callback` **已实现**（严格 host/path，拒 query/port/fragment），
  Google / ChatGPT allowlist 不变。注意：矩阵 §2.3/§4.1 A2 中「Claude callback 未实现/fail」
  是旧快照，本台账不改矩阵行状态，只按当前 src 事实测试「已实现」。
- `src/server.js:324-343`：tools/list 携带 `_meta.securitySchemes`（profile 无关、
  additive）；annotations 显式布尔；`listChanged:false`。
- `scripts/platform-conformance.mjs`：只读离线检查器 `runConformance` /
  `EXPECTED_TOOLS` / `isDualEncoded` 等，未知即 `unknown` 不作 pass。

## 二、落地内容（21 个串行、纯函数测试）

| 组 | 覆盖 | 测试要点 |
|---|---|---|
| A 三平台 | A1/A2/A2b Gemini | 去 `structuredContent`、text JSON 保留、输入不变；schema/annotations 经 sanitize 且幂等；脏 schema 被修 |
| | A3/A3b/A4 ChatGPT | 双编码同源 payload；code-mode model 投影只在 chatgpt 加 SC；`_meta.securitySchemes` 仅 tools/list，不污染 Gemini 工具面或结果 |
| | A5/A6 Claude | text + annotations、无 SC；回调 allowlist 严格匹配 + 近似拒绝；其他平台 allowlist 不变 |
| B 硬不变量 | B1–B4 | 工具名恰好 `['search','execute_read','execute']` 且顺序稳定；改名/多一个工具即 FAIL；annotations 存在但不改权限语义（profile 应用前后一致）；fixture schema 全量 Gemini-safe |
| C typed-plan 缺口 | C1/C2/C3 | 当前 `execute`/`execute_read` schema 只有 `code`、无 `plan`；`{plan:[...]}` 调用被 `validateToolArgs` 以 `requires fields: code` 拒绝；候选 schema 可 sanitize 但未注册。**状态明确写「未支持 / 等 v2」，不假通过** |
| D 隔离 | D1–D6 | 同一结果三平台三种编码；显式声明生效、unknown/含糊 UA 回落 Gemini；未知 profile id 字节等同 Gemini；ChatGPT 形状结果放在 Gemini envelope 上必须 FAIL 而非 pass；各平台检查不借证据；frozen 默认值不可跨边界改写 |

构造方式：全部 fixture 由 `src/` 导出函数现场生成（`createCodeModeTools` +
`sanitizeTool` + `encodeToolResult` + `toModelOutput` + `isAllowedRedirectUri`），
再包成 `platform-conformance.mjs` 接受的 capture envelope；无手写线上快照、无网络、无 fs 写。

## 三、验证

- `node --test tests/platform-conformance-suite.test.js`：**21/21 pass，0 fail**，
  用时约 0.5s。
- `npm test`：全量绿 —— 1087 tests / 1081 pass / 0 fail / 6 todo（含本套件
  A1–D6 共 21 项）。本 agent 只报告自己新增套件的 21/21；并发下其他 agent 新增
  或修改的测试不属于本任务，不修改、不归因。

## 四、边界与后续

- 本套件只覆盖**离线服务端编码 / 工具面 / schema**；ChatGPT Business 与 Claude
  真实客户端的 `pass` 仍需真机运行，维持矩阵 `unknown`。
- typed-plan `plan` 字段未支持是事实断言，不是失败测试；v2 落地后应更新 C1/C2/C3
  与矩阵 §3.1 C1、§4.3 T1 状态。
- 未改任何生产代码；未 commit / push / deploy。
