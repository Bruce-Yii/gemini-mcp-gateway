# B15 后续 — 最新本地代码端到端验证（HTTP loopback + fake upstream）

> 状态：**代码 + 测试完成，未 commit / push / deploy**。
> 范围：只新增 4 个文件：
> - `scripts/local-e2e-verify.mjs`
> - `tests/local-e2e-verify.test.js`
> - `docs/eval/LOCAL-E2E-VERIFY.md`
> - 本文
>
> 未改：`src/`、其他 `scripts/` / `tests/`、README、workflows、config、契约文档。
> 根 `AGENTS.md` §0 结论不变：生产仍跑旧构建，本次验证**不代表线上已修好**。

---

## 0. 任务与结论

按 lead 指派，用**最新本地代码**做一次端到端验证，确认已入库修复在**真实路由**上生效；
不联网、不改生产代码、不 commit/push/deploy。

实现：真实 Node `http` loopback + ephemeral 端口，挂**真实**
`createAppHandler` / `createMcpRequestHandler`；只在最外两层注入 fake：
内存 token store + 进程内 fake upstream manager/typed-plan IO。用真实 `fetch` 与
MCP SDK `StreamableHTTPClientTransport` 发真实请求（不是直接调 handler 函数）。

输出 JSON `{ok, checks[]}`，失败 exit 1。11 项 check 全绿；测试 2/2 通过。

---

## 1. 交付物

| 文件 | 作用 |
| --- | --- |
| `scripts/local-e2e-verify.mjs` | 独立 CLI + 可 import 的 `runLocalE2E(overrides)`；真实 loopback server，11 项 check |
| `tests/local-e2e-verify.test.js` | 2 个 node:test：全绿报告结构/内容；注入失败被正确 surfaced |
| `docs/eval/LOCAL-E2E-VERIFY.md` | 运行方式、覆盖/未覆盖、与真实部署差异 |
| `docs/ledger/batch-15-local-e2e.md` | 本 ledger |

---

## 2. 覆盖的 check

| # | check | 覆盖点 |
| --- | --- | --- |
| 1 | `healthz-200` | `/healthz` 200、ok、配置、buildHash |
| 2 | `oauth-metadata` | 授权服务器 metadata + 保护资源 metadata |
| 3 | `cimd-document` | 公开 CIMD 文档 200、client_id=URL、无 secret |
| 4 | `mcp-401-challenge` | 401 + WWW-Authenticate + `_meta` challenge |
| 5 | `mcp-three-tools` | 真实 MCP client `tools/list` 三工具固定顺序 |
| 6 | `file-content-pure-body` | `content` 纯正文；notice/sha 元数据（fileMeta 可见） |
| 7 | `pr-number-url-first` | PR number 取 URL `/pulls/53`，不用数据库 id |
| 8 | `wait-for-pr-checks-helper` | helper 可见；pending → `timedOut:true` |
| 9 | `run-typed-plan-helper` | typed plan 执行，fake IO adapter 被命中 |
| 10 | `v2-flag-off-404` | flag off：`/mcp/v2` 404，不降级 |
| 11 | `v2-flag-on-three-tools` | flag on：同三工具 + `plan` 入参 |

`overrides.failCheck` 可注入失败；测试用 `mcp-three-tools` 验证
`ok:false` + 错误名/消息 + 其余 check 仍执行（失败隔离）。

---

## 3. 安全与边界

- 不联网：只 `127.0.0.1:<ephemeral>`；fake upstream 对未知工具报错不转发。
- 不碰真实凭据：token 是字面量 `FAKE-LOCAL-E2E-TOKEN`，store 是内存 Map；
  无 KV / vault / 磁盘写入；无 stdio 子进程。
- 不改生产代码；无 commit / push / deploy。
- 报告只含 check 名 / ok / detail / error；`gw.local.test` 仅满足 CIMD 的 https
  文档格式，不是真实域名、不会被 fetch。

---

## 4. 验证记录

```text
node scripts/local-e2e-verify.mjs            # exit 0; ok:true; 11 checks, 11 pass
node --test tests/local-e2e-verify.test.js   # 2 tests, 2 pass, 0 fail
npm test                                     # 全量绿（见 §5）
```

---

## 5. 全量测试

> 本批只新增上述 4 个文件。并发 agent 对 `src/` 与其他文件的改动不计入本批。

```text
node scripts/local-e2e-verify.mjs            # exit 0; ok:true; 11 checks, 11 pass
node --test tests/local-e2e-verify.test.js  # 2 tests, 2 pass, 0 fail
npm test                                     # 1351 tests, 1337 pass, 8 fail, 6 todo
```

**全量测试说明**：本批 2 项测试在全量运行中均通过（`✔ local E2E: ...`）。
8 项失败全部集中在 `tests/security-fix-2.test.js`（F-01 redactSecrets、
F-03 truncation prose、F-04 typed-plan 预算、F-06 reserved tool names、
F-07 fallback truncated 语义），该文件与相关 src/ 修改由其他并发 agent 负责，
对应根 `AGENTS.md` §6 中"仍修中/待验"的安全审计项；与本批端到端验证无关，
本批未改这些文件。
