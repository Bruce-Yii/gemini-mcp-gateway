# B13 — 平台隔离 / 多客户端并行

> 状态：执行中。目标不是多租户，而是 **single-owner 下 Gemini / ChatGPT / Claude 的认证、编码、评测分账**。
> 所有 agent 禁止 commit/push/deploy；lead 集成。

## 隔离模型

| 层 | 隔离内容 | 不隔离 |
|---|---|---|
| OAuth | 每平台独立 client / redirect / token；Gemini locked client 不被覆盖 | 同一 owner 的上游 token 可共享 |
| 运行时 | clientProfile：Gemini text-JSON、ChatGPT structured+text、Claude text+annotations | 3 tools 名称/数量/schema 不变 |
| Capture | `clientPlatform` / `clientProfile` / `oauthClientId` | 原始 requestId/body 不变 |
| Digest | `byClientPlatform` / platform summary | project/session 仍可交叉分析 |
| Eval | 每平台独立 baseline；不跨平台硬比 | 同一套 L0/L1 任务可复用 |
| 写路径 | **不隔离也不依赖平台标签** | 幂等/权限/写算法保持平台无关 |

## 当前并行 agent

| Agent | 范围 | 验收 |
|---|---|---|
| `platform-capture` | `src/client-platform.js`、`src/capture.js`、tests、`batch-13-platform-isolation.md` | Gemini/ChatGPT/Claude/unknown 可识别；旧字段不变 |
| `platform-eval` | `scripts/capture-digest.mjs`、`scripts/platform-conformance.mjs`、tests、`batch-13-platform-eval.md` | byClientPlatform；三工具 schema/encoding conformance |
| `platform-registry` | `templates/client-profiles/*.json`、`docs/OPEN-SOURCE/CLIENT-PROFILES.md` | 三平台配置示例；明确未生效 |
| `chatgpt-oauth` | OAuth 多 client / ChatGPT redirect / iss / 401 metadata | Gemini locked 不回归；ChatGPT 独立 client |
| `oss-test-curation` | 公开导出测试裁剪 | staging `npm test` 0 fail，允许显式 skip |
| `l1-failed-server` | L1 failed-server 基线/分母 | 2/4 连通不误判为搜索回归 |

## 当前事实

- 生产 `ALLOWED_CLIENT_ID` + `ALLOWED_CLIENT_SECRET` 已设置 → DCR 锁定给 Gemini；
- ChatGPT 需要独立 client/允许路径，不能复用 Gemini client；
- `src/client-profile.js` 已有 Gemini/Claude/ChatGPT 编码；
- capture 尚未加 `clientPlatform`；
- L1 目前没有平台 lane，需要后续接入。

## 明确不做

- 多租户 / 多用户凭据隔离；
- 用平台标签做写路径/幂等/权限；
- 在 `tools/list` 中按平台改变工具名/数量；
- 跨平台共用 baseline。

## 集成顺序

1. platform-capture + platform-eval + platform-registry；
2. chatgpt-oauth（Gemini 回归优先）；
3. oss-test-curation / l1-failed-server；
4. 全量测试、CI；
5. 部署最新 commit 后用 ChatGPT connector 手动验收；
6. 更新 B13 结果与本页。
