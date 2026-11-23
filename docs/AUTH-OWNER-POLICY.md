# Auth owner policy — 显式归属，未标记永不 refresh

> 落地日期：2026-11-24。依据：`AGENTS.md` §2 + 用户 2026-11-24 的 owner 决策。
> 本文只描述**机制与操作步骤**；是否“授权就绪”仍以 [AUTH-READY.md](AUTH-READY.md) 为准
> （当前 **NOT READY**，不要据此向用户发起授权）。

## 0. 一句话

**只有显式 `owner=gateway` 的 grant 才允许自动 refresh；未标记一律 `shared`，只读不刷新。**
DSH 导出的 rotating grant 必须显式标 `dsh`，只读、永不 refresh。

## 1. Owner 决策（已定，不再询问）

| 上游 | 凭证类型 | owner | 是否 refresh |
|---|---|---|---|
| GitHub | 长期 token（Copilot MCP） | dsh（env seed，静态使用） | 否 |
| Linear | PAT（`authMode: static_bearer`） | manual | 否（过期即轮换 token） |
| Notion | Business/Enterprise static MCP token，或网关自己 DCR | manual 或 gateway | static 否；gateway 是（DSH grant 必须被替换） |
| Vercel | 网关自己 OAuth + `offline_access` | gateway | 是 |
| Figma | 网关自己 OAuth；做不到暂不启用 | gateway（启用时） | 是 |
| 现有 DSH token（env 里的 `*_REFRESH_TOKEN`） | DSH 导出 grant | **dsh** | **永不允许** |

## 2. 代码如何强制（本次落地）

- `src/config.js`：`grantOwner` / `grantOwnerEnv` / `grantSource` / `grantSourceEnv`
  成为合法 server key；`grantOwner` 只接受 `gateway|dsh|manual`。
  带 `refreshEnv` 却没有 owner 标记 → 显式 warning：该 grant 永远不会自动 refresh。
- `src/upstream-auth.js`：
  - 未标记 → `_grantOwner()` 返回 `shared`，`_mayRefresh()` 为 false；
  - **删除了 legacy v1 的 `gateway` 例外**：v1 未标记记录同样是 `shared`，只读；
  - 只有显式 `owner=gateway` / `source=gateway-*` 才进入 refresh 路径。
- `config.example.json`：`notion` / `linear` / `figma` 的 env-seeded grant 显式标
  `"grantOwner": "dsh"`。
- `scripts/auth-migrate-owners.mjs`：把 **v1 legacy 未标记记录**复制到 v2 的
  `dsh` 命名空间（默认 plan 只读，`--apply` 才写）；永不改 refresh token、
  永不写/删 legacy key、永不联网调用 provider。默认拒绝迁移到 `gateway`
  （需要 `--allow-gateway` 显式承担 refresh 风险）。
- 回归：`tests/owner-marking.test.js`（14 项）+ 更新的 `tests/auth-arch-fix.test.js`。

## 3. 迁移操作（需要有 KV 读权限的 operator 执行）

```bash
# 1) 计划（只读，默认 environment=local）
node scripts/auth-migrate-owners.mjs --environment production
# 2) 复核输出：copy-legacy / tag-v2 / report / skip 计数，确认没有 report
# 3) 应用（把未标记 legacy 记录复制为 owner=dsh；不删除任何旧记录）
node scripts/auth-migrate-owners.mjs --environment production --owner dsh --apply --json
# 4) 验证：同一脚本再跑一次，copy-legacy 应为 0
```

注意：
- `--owner gateway` 需要 `--allow-gateway`，且只应在“该 grant 确属网关自己”时使用；
- 迁移不会让 `dsh` grant 变成可 refresh —— 这是故意的；
- 生产 KV 迁移必须由有权限的 operator 执行并留证据，**本次未执行**（未接触生产 KV）。

## 4. 真实 tools/list（2026-11-24 02:20 SGT，只读探测）

探测方式：MCP SDK `initialize + tools/list`，token 从本地 vault / CC Switch 读取，
**未经网关 refresh 路径、未打印 token、未写 KV**。证据脚本：
`work/acceptance-2026-11-24/tools-list-probe.mjs`（gitignored，本地可复跑）。

| 上游 | 结果 | 工具数 | 证据 |
|---|---|---|---|
| GitHub | **OK** | 28 | `https://api.githubcopilot.com/mcp/readonly` |
| Linear | **OK** | 60 | `https://mcp.linear.app/mcp`；本地 token 仍有效 |
| Figma | **OK** | 51 | `https://mcp.figma.com/mcp`；90 天 token 未过期 |
| Notion | **FAIL** | 0 | HTTP 401 `invalid_token`（本地 access token 已于 ~23h 前过期；refresh 属 DSH，禁止） |
| Vercel | **FAIL** | 0 | HTTP 401 `invalid_token`（本地 token 已过期；需网关自己 OAuth） |

结论：**3/5 真实可用（read-only 凭证）**；Notion / Vercel 需要各自的新授权
（static token 或 gateway OAuth），不是代码 bug。未验证：生产网关进程内
`getAuthStatus()` 的逐上游状态（需要生产 KV/管理端点；本次未触碰生产 token）。

## 5. 状态语义（避免误判）

`getAuthStatus()` 对**任何非 gateway** grant 都会返回 `REAUTH_REQUIRED` +
`SHARED_GRANT_REFRESH_FORBIDDEN` / `STATIC_TOKEN_NO_REFRESH`。这表示
**网关不能自动恢复它**，不等于 access token 当下已失效（只要未过期仍可用）。
判断“现在能不能用”要以真实 `tools/list` / 工具调用为准。

## 6. 未完成（阻塞在外部动作）

1. Linear PAT 尚未创建并放入 vault → `manual` 记录未落 KV；
2. Notion static MCP token 或 DCR 授权未做；
3. Vercel `offline_access` 真实授权未做；
4. Figma 是否启用未定；
5. 生产 KV 的 owner 迁移未执行（需 operator + KV 凭据）；
6. 以上全部完成后，才能更新 AUTH-READY 并考虑是否发起一次授权请求。
