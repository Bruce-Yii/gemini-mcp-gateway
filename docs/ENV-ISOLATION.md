# Preview / production 环境隔离 — 检查结果与修复要求

> 检查日期：2026-11-24 02:35 SGT（只读，只查变量名/target/是否同值，未打印任何值）。
> 工具：`scripts/check-env-isolation.mjs`（新增，只读 Vercel API）。
> 当前结论：**NOT ISOLATED** —— 4 个 P0 共享项。这是 AUTH-READY 1.4-2
> "不存在跨环境共用 KV" 不成立的直接证据。

## 1. 实测结果

```text
$ node scripts/check-env-isolation.mjs --json
{
  "ok": false,
  "violations": [
    { "key": "PUBLIC_BASE_URL",             "kind": "shared-record", "target": ["development","preview","production"], "severity": "P0" },
    { "key": "UPSTASH_REDIS_REST_TOKEN",    "kind": "shared-record", "target": ["preview","production"],              "severity": "P0" },
    { "key": "UPSTASH_REDIS_REST_URL",      "kind": "shared-record", "target": ["preview","production"],              "severity": "P0" },
    { "key": "REDIS_URL",                   "kind": "shared-record", "target": ["preview","production"],              "severity": "P0" }
  ],
  "checkedKeys": ["PUBLIC_BASE_URL","REDIS_URL","UPSTASH_REDIS_REST_TOKEN","UPSTASH_REDIS_REST_URL"]
}
exit=1
```

含义：production 与 preview 使用**同一条** KV 记录（同一 Upstash 数据库 + 同一 token）。
代码里的 `gmcgw:v2:grant:<env>:<owner>:<server>` 只是 key 前缀隔离；一旦任何代码/配置
把 environment 判错，preview 就能读写 production grant。这不是理论风险：
`resolveEnvironment()` 依赖 `VERCEL_ENV`，而 preview 部署同样会跑 refresh/seeding 逻辑。

## 2. 代码侧已做的修复（本次 PR）

- `src/oauth.js` `resolveBaseUrl()`：**请求 host 优先**，`PUBLIC_BASE_URL` 仅在无 host 时兜底。
  这样 `issuer` / protected-resource `resource` / 401 `resource_metadata` / CIMD `client_id`
  永远描述客户端实际连接的 origin，不再把 `PUBLIC_BASE_URL` 里的另一个域名泄漏进文档。
  host 值做严格 `host[:port]` 校验，拒绝路径/凭据注入。
- 回归：`tests/oauth-origin.test.js`（6 项）。
- 该修复不影响 KV 隔离本身——KV 凭据分离必须在 Vercel 项目里做。

## 3. 必须由 operator 在 Vercel 完成（本次未做，不能代做）

1. **preview 独立 KV**：给 preview 建独立 Upstash 数据库（或至少独立 token），
   把 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` / `REDIS_URL`
   从 `production,preview` 拆成两条，各自 target 单一环境；
2. **PUBLIC_BASE_URL 按环境**：production → 文档域名；preview → preview 域名；
   development 不要再指向生产域名（`resolveBaseUrl` 已改为请求 host 优先，
   但公共配置仍不应把生产 origin 塞进 preview）；
3. 改完后重跑：
   ```bash
   node scripts/check-env-isolation.mjs --json   # 期望 ok:true
   ```
   并把 JSON 结果贴回本文件或 AUTH-READY 证据区；
4. 变更 env 后需要一次手动部署才生效（当前自动 production 部署已关闭）。

## 4. 边界

- 本检查只覆盖 Vercel 项目 env 的 target/同值关系；**不**验证 Upstash 数据库 ACL、
  KV 内容、生产 grant 是否已存在；
- 不打印、不落盘任何 secret 值；
- 未修改 Vercel 项目设置、未部署、未触碰生产 token。
